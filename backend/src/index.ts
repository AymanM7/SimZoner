/**
 * SimZoner backend Worker — the serving plane (docs/SYSTEM_DESIGN.md).
 *
 * Two capabilities so far:
 *   RAG   — embed spec/highway text with Workers AI (bge-small, 384-dim) into Vectorize.
 *   Race  — deterministic physics over real specs + routes from D1 (physics.ts, race.ts).
 * Generation (later) calls env.AI directly, not LangChain's REST chat class (ARCHITECTURE §6).
 *
 * Routes:
 *   GET  /                                  health
 *   POST /specs   {id, text, metadata?}     embed one document and upsert it
 *   GET  /search?q=...&topK=3               embed the query, return nearest specs
 *   POST /race    {route_id, seed?, entrants?}   run + persist a deterministic race
 *   GET  /leaderboard?route_id=             fastest finishes for a route
 */

import { runAndStore, type EntrantRequest } from "./race";
import { predictHandler } from "./predict";
import { ragIngestHandler } from "./rag/store";
import {
  handlePreflight,
  withSecurityHeaders,
  isMethodAllowed,
  isBodyTooLarge,
  validatePredictBody,
  rateLimit,
  tooManyRequests,
  RATE_LIMITS,
} from "./security";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

// Default field when a /race request omits entrants: the three headline cars.
const DEFAULT_ENTRANTS: EntrantRequest[] = [
  { vehicle_id: "bmw-m5-g90" },
  { vehicle_id: "cybertruck-cyberbeast" },
  { vehicle_id: "waymo-ipace" },
];

interface SpecPayload {
  id: string;
  text: string;
  metadata?: Record<string, string | number | boolean>;
}

// CORS + security headers are applied centrally in fetch() via withSecurityHeaders,
// so route responses only need to declare their content type.
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function embed(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] });
  // Workers AI returns { shape, data: number[][] } for embeddings.
  const vector = (result as { data: number[][] }).data?.[0];
  if (!vector) throw new Error("embedding model returned no vector");
  return vector;
}

export default {
  async fetch(request, env): Promise<Response> {
    // CORS preflight, answered before any routing.
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    // Every response leaves through this one choke point so CORS + security headers
    // are applied uniformly (including error responses).
    const res = await route(request, env);
    return withSecurityHeaders(res, request, env);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Reject methods this API never serves.
  if (!isMethodAllowed(request)) return json({ error: "method not allowed" }, 405);

  // Cheap oversized-body guard (checks Content-Length before we read anything).
  if (request.method === "POST" && isBodyTooLarge(request)) {
    return json({ error: "request body too large" }, 413);
  }

  // Rate-limit the budget-draining endpoints (Workers AI / Vectorize) per IP.
  const limit = RATE_LIMITS[url.pathname];
  if (limit !== undefined) {
    const rl = await rateLimit(env, request, url.pathname, limit);
    if (!rl.allowed) return tooManyRequests(rl, request, env);
  }

  // Validate /predict input up front (reads a clone; handler re-reads the body).
  if (request.method === "POST" && url.pathname === "/predict") {
    const check = await validatePredictBody(request);
    if (!check.ok) return json({ error: check.error }, 400);
  }

  try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          service: "simzoner",
          status: "ok",
          embedding_model: EMBEDDING_MODEL,
          dimensions: 384,
          note: "RAG slice — see docs/ARCHITECTURE.md §7",
        });
      }

      if (request.method === "POST" && url.pathname === "/specs") {
        const body = (await request.json()) as SpecPayload;
        if (!body?.id || !body?.text) {
          return json({ error: "body requires { id, text }" }, 400);
        }
        const values = await embed(env.AI, body.text);
        const mutation = await env.VECTORIZE.upsert([
          { id: body.id, values, metadata: { text: body.text, ...body.metadata } },
        ]);
        return json({ upserted: body.id, mutation });
      }

      if (request.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "missing ?q= query" }, 400);
        const topK = Number(url.searchParams.get("topK") ?? "3");
        const values = await embed(env.AI, q);
        const matches = await env.VECTORIZE.query(values, {
          topK,
          returnMetadata: "all",
        });
        return json({ query: q, matches });
      }

      if (request.method === "POST" && url.pathname === "/race") {
        const body = (await request.json().catch(() => ({}))) as {
          route_id?: string;
          seed?: number;
          entrants?: EntrantRequest[];
        };
        if (!body.route_id) return json({ error: "body requires { route_id }" }, 400);
        const result = await runAndStore(env.DB, {
          routeId: body.route_id,
          seed: body.seed ?? 1,
          entrants: body.entrants ?? DEFAULT_ENTRANTS,
          nowIso: new Date().toISOString(),
        });
        return json(result);
      }

      if (request.method === "GET" && url.pathname === "/leaderboard") {
        const routeId = url.searchParams.get("route_id");
        const stmt = routeId
          ? env.DB.prepare("SELECT * FROM leaderboard WHERE route_id = ?").bind(routeId)
          : env.DB.prepare("SELECT * FROM leaderboard");
        const { results } = await stmt.all();
        return json({ route_id: routeId, leaderboard: results });
      }

      // Populate Vectorize with the vehicle + segment corpus (idempotent).
      // (CORS/security headers are applied centrally by the caller in fetch().)
      if (request.method === "POST" && url.pathname === "/rag/ingest") {
        return await ragIngestHandler(request, env);
      }

      // The ML route recommender — retrieves from Vectorize, generates via Workers AI.
      if (request.method === "POST" && url.pathname === "/predict") {
        return await predictHandler(request, env);
      }

      return json({ error: "not found" }, 404);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}
