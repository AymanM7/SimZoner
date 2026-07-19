"""
Shared logic for the per-car outcome models (ENGINE v2).

Each car gets its OWN binary model answering "does THIS car win the matchup?", trained from
that car's spec-diff perspective. For a pairwise row (car_a minus car_b diffs, label a_beats_b):
when the target car is car_a the row is used as-is; when it's car_b the diffs are NEGATED and the
label flipped, so every feature vector is oriented as (this car MINUS opponent). The weather
features (cda_rho_diff, mass_mu_diff) are antisymmetric spec-diffs, so the same negation is valid.

v2 fixes the leak: evaluation is grouped by race_id with StratifiedGroupKFold and reported from
out-of-fold predictions (cross_val_predict), not a single leaky row-level split. Honest note:
still a SYNTHETIC benchmark - agreement with SimZoner's physics engine, not real vehicles.
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import accuracy_score, roc_auc_score, roc_curve  # noqa: E402
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

FEATURES = [
    "mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff",
    "cda_rho_diff", "mass_mu_diff",
]
HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data", "races.parquet")
METRICS_DIR = os.path.join(HERE, "..", "metrics")
MODEL_JSON = os.path.join(HERE, "..", "..", "frontend", "src", "data", "model_metrics.json")
COLORS = {"bmw-m5-g90": "#4f8bff", "cybertruck-cyberbeast": "#dfe6f0", "waymo-ipace": "#24d69a"}


def _oriented(df: pd.DataFrame, car_id: str):
    """Rows where car_id raced, oriented as (car_id minus opponent), label = car_id won, with the
    race_id groups carried along so CV can group by race and not leak."""
    a = df[df["car_a"] == car_id]
    Xa = a[FEATURES].to_numpy(float)
    ya = a["a_beats_b"].to_numpy(int)
    ga = a["race_id"].to_numpy()

    b = df[df["car_b"] == car_id]
    Xb = -b[FEATURES].to_numpy(float)  # negate: opponent-minus-car -> car-minus-opponent (all antisymmetric)
    yb = 1 - b["a_beats_b"].to_numpy(int)
    gb = b["race_id"].to_numpy()

    return np.vstack([Xa, Xb]), np.concatenate([ya, yb]), np.concatenate([ga, gb])


def run_for_car(car_id: str, car_name: str) -> dict:
    df = pd.read_parquet(DATA)
    X, y, groups = _oriented(df, car_id)

    # Grouped 5-fold; every row gets exactly one out-of-fold prediction (no leak, no wasted rows).
    pipe = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=1000))
    cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=0)
    prob = cross_val_predict(pipe, X, y, cv=cv, groups=groups, method="predict_proba")[:, 1]
    pred = (prob >= 0.5).astype(int)
    acc = float(accuracy_score(y, pred))
    auc = float(roc_auc_score(y, prob))
    fpr, tpr, _ = roc_curve(y, prob)
    base = float(max(y.mean(), 1 - y.mean()))

    _plot_roc(car_id, car_name, fpr, tpr, auc, len(y))
    _update_json(car_id, car_name, acc, auc, int(len(y)))

    print(f"{car_name}: win-rate acc {acc:.4f} | AUC {auc:.4f} | n_oof {len(y)} | majority {base:.3f}")
    return {"id": car_id, "name": car_name, "accuracy": round(acc, 4), "auc": round(auc, 4), "n": int(len(y))}


def _plot_roc(car_id: str, car_name: str, fpr, tpr, auc: float, n: int):
    os.makedirs(METRICS_DIR, exist_ok=True)
    color = COLORS.get(car_id, "#35e0d0")
    fig, ax = plt.subplots(figsize=(5, 5), dpi=140)
    ax.plot(fpr, tpr, color=color, lw=2.4, label=f"{car_name} (AUC = {auc:.3f})")
    ax.plot([0, 1], [0, 1], color="#8794a5", lw=1, ls="--", label="chance")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("False Positive Rate")
    ax.set_ylabel("True Positive Rate")
    ax.set_title(f"ROC - does {car_name} win?  (grouped OOF, n = {n})", fontsize=11)
    ax.legend(loc="lower right", fontsize=9)
    ax.grid(alpha=0.2)
    fig.text(0.5, 0.01, "Synthetic benchmark: agreement with SimZoner physics v2, not real vehicles.",
             ha="center", fontsize=7, color="#8794a5")
    slug = car_id.split("-")[0]
    out = os.path.join(METRICS_DIR, f"roc_{slug}.png")
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    print(f"  wrote {out}")


def _update_json(car_id: str, car_name: str, acc: float, auc: float, n: int):
    try:
        data = json.load(open(MODEL_JSON))
    except FileNotFoundError:
        data = {"per_car": []}
    per = {p["id"]: p for p in data.get("per_car", [])}
    per[car_id] = {"id": car_id, "name": car_name, "accuracy": round(acc, 4), "auc": round(auc, 4), "n": n}
    data["per_car"] = [per[k] for k in ["cybertruck-cyberbeast", "bmw-m5-g90", "waymo-ipace"] if k in per]
    json.dump(data, open(MODEL_JSON, "w"), indent=2)
