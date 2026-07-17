# Backend — TypeScript edge Worker (serving plane)

The latency-critical edge path. A TypeScript Cloudflare Worker that currently exposes the
**embeddings + retrieval (RAG)** slice, and will grow to host the race API and physics
(Durable Object) in later stages. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
[`../docs/SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md).

Generation calls `env.AI` **directly**, not LangChain's REST chat class (ARCHITECTURE §6).

## Bindings (free tier)

| Binding | Service | Role |
|---|---|---|
| `AI` | Workers AI | Embeddings (bge-small, 384-dim); later, driver agents |
| `VECTORIZE` | Vectorize `simzoner-specs` | Spec/highway retrieval, once per race setup |
| `DB` | D1 `simzoner-db` | Catalog, results, routes — see [`../database`](../database) |
| `CONFIG` | KV | Read-mostly config **only** (not the hot cache — ARCHITECTURE §4.1) |

## Endpoints (current slice)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health + index info |
| POST | `/specs` | Embed one doc and upsert to Vectorize |
| GET | `/search?q=` | Embed query, return nearest specs |

## Run locally

```bash
cd backend
npm install
npx wrangler dev --remote   # --remote: Workers AI + Vectorize need real bindings
```

`--remote` is required because Workers AI and Vectorize have no local emulation — the models run
on Cloudflare. D1 and KV do run locally (`--local`).

## Typecheck

```bash
npm run cf-typegen && npm run typecheck
```
