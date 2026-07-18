/**
 * security.ts — proportionate hardening for the SimZoner Worker.
 *
 * This is a no-auth, no-user-data hobby API. There is nothing secret to steal and
 * no session to hijack. The realistic threats are therefore small and specific:
 *   1. Budget drain  — /predict, /rag/ingest and /search each spend Workers AI
 *      "neurons" and/or Vectorize queries. An open loop (or a bored bot) hammering
 *      them burns the free-tier allowance. -> per-IP rate limiting.
 *   2. Cross-origin abuse — a wide-open `access-control-allow-origin: *` lets any
 *      site drive this backend from a victim's browser. -> CORS allowlist.
 *   3. Malformed / oversized input crashing handlers. -> light input validation.
 *   4. Basic response hygiene so the JSON API isn't framed/sniffed. -> headers.
 *
 * Deliberately NOT here: auth, WAF, bot fingerprinting, signed requests. That would
 * be enterprise theater for a hobby sim. Keep it simple, correct, and cheap.
 */

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

// The frontend runs on Vite at :5199 in local dev. Both host spellings are allowed
// because browsers treat localhost and 127.0.0.1 as distinct origins.
const STATIC_ALLOWED_ORIGINS = [
  "http://localhost:5199",
  "http://127.0.0.1:5199",
];

/**
 * Optional production origin, supplied as NON-secret config (wrangler `vars` /
 * `.dev.vars`), e.g. PROD_ORIGIN="https://simzoner.pages.dev". It is read via a
 * cast because it is not part of the generated Env binding types — absent is fine.
 */
function prodOrigin(env: Env): string | undefined {
  const v = (env as unknown as { PROD_ORIGIN?: string }).PROD_ORIGIN;
  return v && v.trim() ? v.trim() : undefined;
}

function isAllowedOrigin(origin: string | null, env: Env): origin is string {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
  const prod = prodOrigin(env);
  return prod !== undefined && origin === prod;
}

/**
 * CORS headers for a given request. The Origin is REFLECTED only when it is on the
 * allowlist; otherwise Access-Control-Allow-Origin is omitted entirely (the browser
 * then blocks the cross-origin read). `Vary: Origin` keeps caches from serving one
 * origin's ACAO to another.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (isAllowedOrigin(origin, env)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/**
 * Handle a CORS preflight. Returns a 204 response when the request is an OPTIONS
 * preflight, otherwise null so the caller continues normal routing.
 */
export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== "OPTIONS") return null;
  return withSecurityHeaders(new Response(null, { status: 204 }), request, env);
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

// Minimal headers appropriate for a JSON API (this Worker never serves HTML/JS).
// The CSP is intentionally strict: `default-src 'none'` because a JSON payload
// needs to load nothing; `frame-ancestors 'none'` + X-Frame-Options stop framing.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Return a copy of `res` with CORS + security headers applied. Central choke point
 * so every response leaving the Worker is hardened identically.
 */
export function withSecurityHeaders(res: Response, request: Request, env: Env): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) h.set(k, v);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

// Reject bodies larger than this before we bother parsing them. A legitimate
// /predict or /specs body is well under a kilobyte; 64 KiB is generous headroom.
const MAX_BODY_BYTES = 64 * 1024;
// Sane per-field caps so an id can't be a megabyte of junk fed into an embedding.
const MAX_ID_LEN = 128;

/** Methods this API actually serves. Anything else gets 405. */
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);

export function isMethodAllowed(request: Request): boolean {
  return ALLOWED_METHODS.has(request.method);
}

/** True when Content-Length declares a body over the cap. */
export function isBodyTooLarge(request: Request): boolean {
  const len = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(len) && len > MAX_BODY_BYTES;
}

export interface PredictInput {
  vehicleId: string;
  corridorId: string;
}

/**
 * Validate a /predict body WITHOUT consuming the caller's request stream — reads a
 * clone so the downstream handler can still call request.json(). Returns the parsed
 * fields on success, or an error string on failure.
 */
export async function validatePredictBody(
  request: Request
): Promise<{ ok: true; value: PredictInput } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { ok: false, error: "body must be valid JSON" };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { vehicleId, corridorId } = body as Record<string, unknown>;
  if (typeof vehicleId !== "string" || typeof corridorId !== "string") {
    return { ok: false, error: "body requires string { vehicleId, corridorId }" };
  }
  if (!vehicleId.trim() || !corridorId.trim()) {
    return { ok: false, error: "vehicleId and corridorId must be non-empty" };
  }
  if (vehicleId.length > MAX_ID_LEN || corridorId.length > MAX_ID_LEN) {
    return { ok: false, error: `ids must be <= ${MAX_ID_LEN} characters` };
  }
  return { ok: true, value: { vehicleId, corridorId } };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Per-endpoint per-minute caps. These protect the neuron/Vectorize budget, not
 * correctness, so they are generous enough for real interactive use but low enough
 * that a runaway loop can't drain the free tier:
 *   /predict     — embeds a query + LLM generation (most expensive)         -> 20/min
 *   /rag/ingest  — re-embeds the WHOLE corpus; only ever needed rarely       ->  5/min
 *   /search      — one embedding + one Vectorize query                       -> 30/min
 */
export const RATE_LIMITS: Record<string, number> = {
  "/predict": 20,
  "/rag/ingest": 5,
  "/search": 30,
};

const WINDOW_SECONDS = 60;
// KV keys self-expire so the namespace never fills with stale counters. Must be
// >= the window; KV enforces a 60s minimum TTL, so give it a small margin.
const KEY_TTL_SECONDS = WINDOW_SECONDS + 60;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

function clientIp(request: Request): string {
  // Cloudflare sets cf-connecting-ip; fall back to a shared bucket if it's absent
  // (e.g. local `wrangler dev`) so the limiter still functions, just coarsely.
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Fixed-window per-IP limiter backed by the CONFIG KV namespace.
 *
 * TRADE-OFF (honest note): this writes to KV on each protected request, and the
 * free tier allows ~1k KV writes/day. That is acceptable here because these are
 * the LOW-traffic, high-cost endpoints — the hot per-tick path deliberately does
 * NOT use KV (see wrangler.jsonc). A fixed window can allow up to ~2x the cap at a
 * window boundary; that's fine for budget protection (we don't need token-bucket
 * precision). Reads/writes are best-effort and NOT atomic — good enough here.
 *
 * FAILS OPEN: any KV error logs and allows the request, so a KV hiccup never takes
 * the API down. Availability > perfect rate limiting for a hobby sim.
 */
export async function rateLimit(
  env: Env,
  request: Request,
  pathname: string,
  limit: number
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const ip = clientIp(request);
  const key = `rl:${pathname}:${ip}:${windowStart}`;

  try {
    const current = Number((await env.CONFIG.get(key)) ?? "0");
    if (current >= limit) {
      // Seconds until this window rolls over.
      const nowSec = Date.now() / 1000;
      const retryAfter = Math.max(1, Math.ceil((windowStart + 1) * WINDOW_SECONDS - nowSec));
      return { allowed: false, limit, remaining: 0, retryAfterSeconds: retryAfter };
    }
    await env.CONFIG.put(key, String(current + 1), { expirationTtl: KEY_TTL_SECONDS });
    return { allowed: true, limit, remaining: Math.max(0, limit - current - 1), retryAfterSeconds: 0 };
  } catch (err) {
    // ASCII-only log; fail open.
    console.error(`[ratelimit] KV error, failing open for ${pathname}: ${(err as Error).message}`);
    return { allowed: true, limit, remaining: limit, retryAfterSeconds: 0 };
  }
}

/** Build the 429 response for an over-limit request. */
export function tooManyRequests(result: RateLimitResult, request: Request, env: Env): Response {
  const res = new Response(
    JSON.stringify({ error: "rate limit exceeded", retryAfterSeconds: result.retryAfterSeconds }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfterSeconds),
      },
    }
  );
  return withSecurityHeaders(res, request, env);
}
