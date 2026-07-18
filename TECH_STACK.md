# SimZoner — Tech Stack

Current, as-built stack (not aspirational). Where something changed mid-project or is
planned-but-not-yet, it says so. Everything runs on Cloudflare's **free tier**.

## The four parts

| Part | Folder | Runtime | Port (dev) |
|---|---|---|---|
| Frontend | `frontend/` | Next.js on Node / Cloudflare Pages | 5199 |
| Backend | `backend/` | Cloudflare Workers (TypeScript) | 8787 |
| Cloud Compute | `cloud-compute/` | Cloudflare Python Workers | 8788 |
| Machine Learning | `ml/` | Python (local / CI, not a server) | — |
| Database | `database/` | Cloudflare D1 (via the backend) | — |

Start everything at once from the repo root: `npm run dev` (uses `concurrently`).

---

## Frontend (`frontend/`)

| Tech | Version | Role |
|---|---|---|
| Next.js | 15.x (App Router) | Framework |
| React | 19 | UI |
| TypeScript | 5.6 | Types |
| Tailwind CSS | v4 (`@tailwindcss/postcss`) | Styling (`@theme` tokens) |
| **Leaflet** | 1.9.4 | Map rendering |
| OpenStreetMap tiles | — | CARTO Voyager (light) / CARTO dark — both OSM data, keyless |
| Zustand | 5 | Client state (selected vehicle, corridor, map theme, race nonce) |
| `@cloudflare/next-on-pages` | 1.13 | Cloudflare Pages adapter |

**Note — MapLibre was replaced by Leaflet.** MapLibre is WebGL-based and rendered blank
where WebGL was unavailable/blocked; Leaflet uses plain `<img>` tiles (no WebGL) and is far
more ad-blocker tolerant. Same map, more robust.

The map draws real I-45 / I-35 / I-75 geometry with the cars as moving markers. Physics-lite
motion runs client-side in `src/lib/engine.ts` (deterministic, seeded); cars wait at the start
line until **Predict** launches the race.

---

## Backend (`backend/`) — the serving plane

| Tech | Role |
|---|---|
| Cloudflare Workers (TypeScript) | Edge API |
| Workers AI | `@cf/baai/bge-small-en-v1.5` (384-dim embeddings), `@cf/meta/llama-3.2-3b-instruct` (route rationale) |
| Vectorize | `simzoner-specs` index — RAG over vehicle + highway-segment docs |
| D1 | `simzoner-db` — vehicle catalog + provenance ledger, routes, race results |
| KV | `CONFIG` — read-mostly config + per-IP rate-limit counters |
| `@langchain/cloudflare` | 1.1.0 — `CloudflareVectorizeStore` + `CloudflareWorkersAIEmbeddings` for the RAG layer |
| wrangler | 4.x — local dev (`--remote` for live AI/Vectorize bindings) |

**Endpoints:** `/` health, `/specs`, `/search`, `/race`, `/leaderboard`, `/rag/ingest`, `/predict`.
Generation calls `env.AI` directly (LangChain's chat class is REST-only and can't do tool calling).

**Security (in `src/security.ts`):** CORS allowlist (not `*`), per-IP fixed-window rate limits on the
budget-sensitive AI/Vectorize endpoints, request-body validation, security headers.

**Planned, not yet built:** Durable Objects (SQLite-backed) for authoritative per-race physics
state; **R2** for replay blobs (deferred — needs a one-time dashboard enable).

---

## Cloud Compute (`cloud-compute/`)

| Tech | Role |
|---|---|
| Cloudflare Python Workers | Model-serving edge worker |
| Pure Python (stdlib + `workers` runtime) | `sigmoid(w·x + b)` over the exported logistic weights |

**Note — FastAPI + numpy were dropped in favor of pure Python.** FastAPI/numpy need the beta
`pywrangler` package-vendoring toolchain and fail under plain `wrangler dev`. A 5-feature dot
product and manual routing don't need them, so this worker runs with no external packages.
Endpoints: `/`, `/model`, `/predict`. Serves the exact same numbers as the sklearn model.

---

## Machine Learning (`ml/`) — the training plane (local / CI)

| Tech | Version | Role |
|---|---|---|
| Python | 3.12 | Runtime |
| scikit-learn | 1.8 | Logistic regression (shipped) + gradient boosting (ceiling probe) |
| numpy / pandas | 2.x / 2.x | Data + linear algebra |
| matplotlib | 3.10 | Confusion / ROC / calibration / per-car plots |

**Not a Worker by design** — training needs minutes of CPU; Workers give 10 ms. It runs locally
or in CI and exports JSON weights the serving side reads. Includes per-car models
(`per_car/train_bmw.py`, `train_cybertruck.py`, `train_waymo.py`). Honest framing: a **synthetic
benchmark** measuring agreement with the physics engine, not real vehicles.

---

## Data

- **Vehicle specs** — BMW M5 (G90), Tesla Cybertruck, Waymo (Jaguar I-Pace), each with a
  provenance ledger (VERIFIED / SECONDARY / ESTIMATED / UNPUBLISHED). See `docs/VEHICLE_SPECS.md`.
- **Highway geometry** — real I-45 (Houston→Galveston), I-35 (San Antonio→Austin), I-71/I-75
  (Cincinnati), as GeoJSON with real waypoints. See `data/highways/`.
- **OpenStreetMap** — map tiles via CARTO (OSM data), attributed.

---

## Cloud platform & account

- **Cloudflare** — Workers, Pages, Workers AI, Vectorize, D1, KV (+ R2/DO planned). Free tier only.
- Cloudflare account: `ayman30897@gmail.com`. Repo: GitHub **AymanM7/SimZoner** (private).
- **Post-quantum TLS** (X25519MLKEM768) is automatic at the Cloudflare edge for Workers/Pages.
  See `docs/SECURITY.md`.

---

## Security & CI/CD

| Tech | Role |
|---|---|
| GitHub Actions | `ci.yml` (build + typecheck), `security.yml` (gitleaks, CodeQL, `npm audit`) |
| Dependabot | Weekly npm + actions updates |
| SHA-pinned actions | Supply-chain hardening |
| Secrets | `wrangler secret put` (prod) / gitignored `.dev.vars` (local) — **none needed today** |

See `docs/SECURITY.md` and `docs/cicd-security.md`.

---

## Dev tooling

- **concurrently** — `npm run dev` starts frontend + backend + cloud-compute together.
- **wrangler** — Workers/D1/KV/Vectorize local dev and resource management.
- Running & ports: see `ports.md`.

---

## Notable decisions (and reversals)

| Decision | Why |
|---|---|
| Leaflet over MapLibre | No WebGL dependency; renders where MapLibre showed blank; ad-blocker tolerant |
| Pure-Python Cloud Compute over FastAPI/numpy | Runs under plain `wrangler dev`; a dot product needs neither |
| `env.AI` direct over LangChain chat | LangChain's `ChatCloudflareWorkersAI` is REST-only, no tool calling |
| LangChain kept for RAG only | Its Vectorize + embeddings classes are binding-native and genuinely good |
| Training local/CI, not on Cloudflare | Cloudflare is inference-only; Workers cap at 10 ms CPU |
| Logistic regression shipped | Weights port to a dot product that fits the 10 ms budget |
