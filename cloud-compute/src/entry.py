"""
SimZoner — Cloud Compute plane. FastAPI on a Cloudflare Python Worker (beta).

Role (docs/SYSTEM_DESIGN.md §1-§2): the MODEL-SERVING API surface. Training happens
offline in ../ml (local/CI, sklearn); that pipeline exports JSON weights, and THIS
worker serves predictions from them. Serving a logistic model is a dot product + a
sigmoid — cheap enough for the Workers 10ms CPU budget. Training is not, which is why
it is not here.

Local run (from cloud-compute/):
    npx wrangler dev
Requires the `python_workers` compatibility flag (set in wrangler.jsonc) and pywrangler
to vendor deps. numpy and FastAPI are both supported on Python Workers.
"""

import json

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="SimZoner Cloud Compute", version="0.0.1")

# Exported model weights. Real weights come from ../ml (sklearn → JSON). The bundled
# file is a PLACEHOLDER baseline (all-zero weights → 0.5) until the ML pipeline runs,
# so /predict is honest about being untrained rather than faking a number.
with open("model/weights.json") as f:
    MODEL = json.load(f)


class Features(BaseModel):
    # Pairwise, car-A-minus-car-B differences (see ../ml for the feature contract).
    mass_diff_kg: float = 0.0
    cda_diff_m2: float = 0.0
    power_diff_kw: float = 0.0
    hov_eligible_diff: float = 0.0
    start_pos_diff: float = 0.0


@app.get("/")
async def health():
    return {
        "service": "simzoner-cloud-compute",
        "status": "ok",
        "role": "model-serving API surface (FastAPI Python Worker)",
        "model": {
            "name": MODEL.get("name"),
            "trained": MODEL.get("trained", False),
            "note": MODEL.get("note"),
        },
    }


@app.get("/model")
async def model_info():
    return MODEL


@app.post("/predict")
async def predict(features: Features):
    """P(car A beats car B). Logistic: sigmoid(w·x + b) over the exported weights."""
    order = MODEL["features"]
    x = np.array([getattr(features, name) for name in order], dtype=float)
    w = np.array(MODEL["weights"], dtype=float)
    b = float(MODEL["bias"])
    z = float(np.dot(w, x) + b)
    p = 1.0 / (1.0 + np.exp(-z))
    return {
        "p_a_beats_b": round(p, 4),
        "trained": MODEL.get("trained", False),
        "disclaimer": (
            "Synthetic benchmark. Placeholder model until ../ml exports trained weights."
            if not MODEL.get("trained")
            else "Synthetic benchmark — measures agreement with SimZoner physics, not reality."
        ),
    }


async def on_fetch(request, env):
    # ASGI bridge: hand the Worker request to FastAPI. Provided by the Python runtime.
    import asgi

    return await asgi.fetch(app, request, env)
