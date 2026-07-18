/**
 * RAG store wrapper for SimZoner (docs/ARCHITECTURE.md section 7).
 *
 * Wraps LangChain's binding-native Cloudflare classes over the existing
 * Vectorize index `simzoner-specs` (384-dim, bge-small):
 *   - CloudflareWorkersAIEmbeddings({ binding: env.AI, model }) does the embedding.
 *   - CloudflareVectorizeStore(embeddings, { index: env.VECTORIZE }) is the store.
 *
 * Ingest is idempotent: docs carry stable IDs (vehicle:<id>, seg:<route>:<seq>),
 * and those IDs are passed through to Vectorize's upsert so a re-ingest OVERWRITES
 * the same vectors rather than piling up duplicates (free-tier friendly).
 *
 * NOTE: Vectorize + Workers AI have no local emulation. `wrangler dev` (default,
 * local) cannot exercise these calls; a real run needs `wrangler dev --remote`.
 */

import { CloudflareVectorizeStore } from "@langchain/cloudflare";
import { CloudflareWorkersAIEmbeddings } from "@langchain/cloudflare";
import type { Document } from "@langchain/core/documents";
import { buildCorpus } from "./corpus";

// 384-dim, matches the dimensions of the `simzoner-specs` Vectorize index.
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

function getEmbeddings(env: Env): CloudflareWorkersAIEmbeddings {
  return new CloudflareWorkersAIEmbeddings({
    binding: env.AI,
    model: EMBEDDING_MODEL,
  });
}

/** Construct a store bound to the live VECTORIZE index and Workers AI embeddings. */
export function getVectorStore(env: Env): CloudflareVectorizeStore {
  return new CloudflareVectorizeStore(getEmbeddings(env), {
    index: env.VECTORIZE,
  });
}

export interface IngestResult {
  ingested: number;
  vehicles: number;
  segments: number;
  ids: string[];
}

/**
 * Build the corpus from D1 and upsert it into Vectorize via the LangChain store.
 * Stable doc IDs are passed explicitly to addDocuments so the upsert is keyed by
 * them (the store reads IDs from `options`, not from Document.id) - re-ingesting
 * overwrites in place.
 */
export async function ingestCorpus(env: Env): Promise<IngestResult> {
  const docs: Document[] = await buildCorpus(env);
  const ids = docs.map((d, i) => d.id ?? `doc:${i}`);

  const store = getVectorStore(env);
  await store.addDocuments(docs, { ids });

  const vehicles = ids.filter((id) => id.startsWith("vehicle:")).length;
  const segments = ids.filter((id) => id.startsWith("seg:")).length;
  return { ingested: docs.length, vehicles, segments, ids };
}

/**
 * Similarity search over the spec/route corpus. Returns the joined page text of
 * the top matches as a single plain string, ready to drop into a driver-agent
 * prompt as retrieved context.
 */
export async function retrieveSpecContext(
  env: Env,
  query: string,
  topK = 3
): Promise<string> {
  const store = getVectorStore(env);
  const matches = await store.similaritySearch(query, topK);
  return matches.map((doc) => doc.pageContent).join("\n\n");
}

/**
 * Handler for a future POST /rag/ingest route (wired by the main-loop owner in
 * src/index.ts). Rebuilds and upserts the corpus, returning a JSON count.
 */
export async function ragIngestHandler(_request: Request, env: Env): Promise<Response> {
  try {
    const result = await ingestCorpus(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }, null, 2),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
