# Running SimZoner — Ports & Local Setup

SimZoner runs as two local processes during development: the **backend** Worker and the
**frontend** Next.js app. This is the runbook for standing them up.

## Ports at a glance

| Port | Service | Command | What it is |
|---|---|---|---|
| **5199** | Frontend (Next.js) | `cd frontend && npm run dev -- -p 5199` | The dashboard you open in a browser |
| **8787** | Backend (Cloudflare Worker) | `cd backend && npx wrangler dev --remote --port 8787` | API: `/predict`, `/rag/ingest`, `/race`, `/search` |

Open the app at **http://localhost:5199**. The backend on **http://localhost:8787** is an
API — not a page to open — that the frontend calls in the background.

## Prerequisites

- **Node.js 18+** and npm.
- **A Cloudflare account** (free tier) and `wrangler` login, *only* if you want the live
  Vectorize/AI features:
  ```bash
  npx wrangler login
  ```
  The backend uses Workers AI + Vectorize, which have **no local emulation** — that's why the
  backend runs with `--remote` (real bindings against your account; tiny free-tier usage).
- Python 3.12 + `numpy scikit-learn pandas matplotlib` only if you want to re-run the ML
  pipeline in `ml/` (not needed to run the app).

## First-time setup

```bash
# from the repo root
cd frontend && npm install && cd ..
cd backend  && npm install && cd ..
```

## Run it

Open **two terminals**.

**Terminal 1 — backend:**
```bash
cd backend
npx wrangler dev --remote --port 8787
# wait for "Ready on http://127.0.0.1:8787"
# then, ONE time, load the Vectorize index with the vehicle + route corpus:
curl -X POST http://localhost:8787/rag/ingest
```

**Terminal 2 — frontend:**
```bash
cd frontend
npm run dev -- -p 5199
```

Then open **http://localhost:5199**.

## What "working" looks like

- The map shows OpenStreetMap tiles (CARTO Voyager light / CARTO dark) with the I-45, I-35,
  and I-75 routes drawn on real geography and the three cars moving as dots.
- The ML Predictor's **Predict** button shows a `VECTORIZE - N docs` badge when the backend is
  reachable and the corpus has been ingested. If the backend is down, it honestly falls back to
  `LOCAL FALLBACK` — the app still works.

## Configuration

- The frontend calls the backend at `http://localhost:8787` by default. To point elsewhere, set
  `NEXT_PUBLIC_API_BASE` in `frontend/.env.local`:
  ```
  NEXT_PUBLIC_API_BASE=http://localhost:8787
  ```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port already in use | An old dev server is still bound | Find and kill it: `netstat -ano \| findstr :5199` then `taskkill /PID <pid> /F` (Windows) |
| Frontend returns HTTP 500 after a build | `next build` corrupted the running dev server's `.next` cache | Stop the dev server, `rm -rf frontend/.next`, restart `npm run dev` |
| Predictor stuck on `LOCAL FALLBACK` | Backend not running, or corpus not ingested | Start the backend, then `curl -X POST http://localhost:8787/rag/ingest` |
| Backend `Ready` but requests time out (HTTP 000) | `wrangler dev --remote` preview wedged after rapid restarts | Fully stop wrangler (`taskkill /IM workerd.exe /F`) and start it once; avoid rapid restarts |
| Map is blank | Map container height collapsed, or tile server refused the request | Already mitigated (min-height floor + CARTO tiles). If it recurs, hard-refresh; check the browser console for tile 4xx |

## Ports reference

- **5199** — Next.js dev server (frontend). Configurable via `-p`.
- **8787** — Wrangler dev (backend). Wrangler's default; configurable via `--port`.
- Nothing is deployed by default — this is all local. See `docs/` for the architecture.
