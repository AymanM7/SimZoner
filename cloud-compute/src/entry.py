"""
SimZoner Cloud Compute - model-serving Worker (pure Python, no numpy/FastAPI).

Serves the exported logistic model as sigmoid(w . x + b). Written in pure Python so it
runs under plain `wrangler dev` without the beta pywrangler package-vendoring toolchain
(numpy/FastAPI need vendoring and fail under plain dev). A 5-feature dot product does not
need numpy, and manual routing does not need FastAPI. Training still happens in ../ml.

Endpoints:
  GET  /         health + whether a trained model is loaded
  GET  /model    model metadata (features, weights, bias)
  POST /predict  P(car A beats car B) from pairwise feature diffs
"""

import json
import math
from urllib.parse import urlparse

from workers import Response

# Exported by ../ml (kept in sync with src/model/weights.json). Inlined so the worker
# never depends on a bundled-file read; we still try the file first if available.
MODEL = {
    "name": "race-outcome-logistic",
    "engine_version": "v2",
    "trained": True,
    "features": ["mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff", "cda_rho_diff", "mass_mu_diff"],
    "weights": [-0.00015233887864124376, 0.2710623385247246, 0.0014822020902678973, 2.3137719183265433, 1.117544896289772, 0.5245572884858044, -0.0004020237143283215],
    "bias": 0.0075829903057291655,
    "note": "Synthetic benchmark. Measures agreement with SimZoner physics (engine v2), not real vehicles.",
}
try:
    with open("model/weights.json") as _f:
        MODEL = json.load(_f)
except Exception:
    pass  # inlined weights above are the fallback

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Content-Type": "application/json",
}


def _json(data, status=200):
    return Response(json.dumps(data), status=status, headers=CORS)


def _sigmoid(z):
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def _predict(features):
    w = MODEL["weights"]
    z = float(MODEL["bias"])
    for i, name in enumerate(MODEL["features"]):
        try:
            z += w[i] * float(features.get(name, 0) or 0)
        except (TypeError, ValueError):
            pass
    return _sigmoid(z)


async def on_fetch(request, env):
    method = request.method
    path = urlparse(request.url).path

    if method == "OPTIONS":
        return Response("", status=204, headers=CORS)

    if method == "GET" and path == "/":
        return _json({
            "service": "simzoner-cloud-compute",
            "status": "ok",
            "role": "logistic model serving (pure-Python Worker)",
            "trained": MODEL.get("trained", False),
        })

    if method == "GET" and path == "/model":
        return _json(MODEL)

    if method == "POST" and path == "/predict":
        try:
            features = json.loads(await request.text())
        except Exception:
            return _json({"error": "invalid JSON body"}, status=400)
        p = _predict(features if isinstance(features, dict) else {})
        return _json({
            "p_a_beats_b": round(p, 4),
            "trained": MODEL.get("trained", False),
            "disclaimer": MODEL.get("note", ""),
        })

    return _json({"error": "not found"}, status=404)
