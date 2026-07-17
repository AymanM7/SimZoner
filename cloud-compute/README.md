# Cloud Compute — FastAPI Python Worker (model serving)

The **model-serving API surface**. FastAPI running on a Cloudflare Python Worker (open beta).
Training happens in [`../ml`](../ml) (local/CI); it exports JSON weights, and this worker serves
predictions from them. See [`../docs/SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md) §1–§2.

## Why serving here but not training

Serving a logistic model is `sigmoid(w·x + b)` — a dot product, well within the Workers **10ms
CPU** budget. Training needs *minutes* of CPU and cannot run in any Worker (Python or TS, free or
paid). That's the whole reason ML is a separate, local part.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health + whether a trained model is loaded |
| GET | `/model` | Model metadata (features, weights, version) |
| POST | `/predict` | `P(car A beats car B)` from pairwise feature diffs |

`src/model/weights.json` is a **placeholder** (zero weights → P=0.5) until `../ml` produces real
ones. `/predict` says so in its response rather than faking a trained number.

## Run locally

```bash
cd cloud-compute
npx wrangler dev        # needs the python_workers flag (already in wrangler.jsonc)
```

First run vendors `fastapi` + `numpy` via pywrangler and may be slow to boot.

## Honest status (beta caveats)

- Python Workers are **open beta**. FastAPI and numpy are supported, but cold start for a
  FastAPI app sits near the 1s startup ceiling — a risk to measure locally, not yet confirmed.
- **Not deployed.** Local `wrangler dev` first, per project policy.
- scikit-learn is *not* confirmed available on Workers — but it's not needed here: this worker
  only does numpy inference on already-exported weights. Training (sklearn) stays in `../ml`.
