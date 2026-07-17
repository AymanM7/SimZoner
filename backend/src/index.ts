/**
 * SimZoner — embeddings + retrieval Worker (first vertical slice).
 *
 * This is the RAG layer from docs/ARCHITECTURE.md §6-§7: embed vehicle-spec and
 * highway text with Workers AI (bge-small, 384-dim), store/query it in Vectorize.
 * It deliberately does NOT run physics or LLM drivers yet — those land in later
 * stages (see docs/SYSTEM_DESIGN.md). Generation, when it comes, calls env.AI
 * directly rather than through LangChain's REST chat class (ARCHITECTURE §6).
 *
 * Routes:
 *   GET  /                      health + index info
 *   POST /specs   {id, text, metadata?}   embed one document and upsert it
 *   GET  /search?q=...&topK=3   embed the query and return nearest specs
 */

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

interface SpecPayload {
  id: string;
  text: string;
  metadata?: Record<string, string | number | boolean>;
}

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
    const url = new URL(request.url);

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

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
