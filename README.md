# SimZoner

Race simulation between a **BMW M5**, a **Tesla Cybertruck**, and a **Waymo (Jaguar I-Pace)**
across US highways — starting with Texas routes (I-45 Houston→Galveston, I-35 south of Austin).
Deterministic physics, LLM driver agents, and a learned outcome model, all on Cloudflare's
**free tier**. Real published specs, synthetic races.

Design lives in [`docs/`](docs/). Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first, then
[`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md).

## The four parts

The repo is split into four clearly separated concerns so nothing gets confused:

| Part | Folder | What it is | Runs where |
|---|---|---|---|
| **Database** | [`database/`](database/) | D1 schema, seed, provenance ledger, routes | Cloudflare D1 (free) |
| **Backend** | [`backend/`](backend/) | TypeScript edge Worker — API + embeddings/RAG + (later) physics | Cloudflare Workers (free) |
| **Machine Learning** | [`ml/`](ml/) | Synthetic race generation, sklearn training, weight export | **Local / CI** (Python) |
| **Cloud Compute** | [`cloud-compute/`](cloud-compute/) | FastAPI **Python Worker** — model-serving API surface | Cloudflare Python Workers (free, beta) |

### Why the split is real, not cosmetic

- **Backend vs Cloud Compute** are two different runtimes: TypeScript for the latency-critical
  edge path, Python (FastAPI + numpy) for the model-serving surface. Both are Workers; both are
  free tier.
- **Machine Learning is deliberately NOT a Worker.** Training needs minutes of CPU; Workers give
  10ms. So training runs locally/CI and exports JSON weights, which Cloud Compute serves. This is
  the training-plane / serving-plane split — see [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) §1–§2.
- **Database is the exact-data store** (catalog, results, routes) — not the per-tick hot path and
  not the ML dataset store.

## Status

- ✅ Cloudflare resources provisioned (free tier): Vectorize `simzoner-specs`, D1 `simzoner-db`,
  KV `CONFIG`. Nothing deployed yet — **local testing first.**
- ⏳ R2 deferred (optional per design; needs a one-time dashboard enable).
- Account: `ayman30897@gmail.com`. See each part's README to run it locally.
