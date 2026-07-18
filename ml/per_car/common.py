"""
Shared logic for the per-car outcome models.

Each car gets its OWN binary model answering "does THIS car win the matchup?", trained
from that car's spec-diff perspective. For a pairwise row (car_a minus car_b diffs,
label a_beats_b): when the target car is car_a the row is used as-is; when it's car_b
the diffs are negated and the label flipped, so every feature vector is oriented as
(this car MINUS opponent). Honest note: this is still a SYNTHETIC benchmark - it
measures agreement with SimZoner's physics engine, not real vehicles.
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
from sklearn.model_selection import train_test_split  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

FEATURES = ["mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff"]
HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data", "races.parquet")
METRICS_DIR = os.path.join(HERE, "..", "metrics")
MODEL_JSON = os.path.join(HERE, "..", "..", "frontend", "src", "data", "model_metrics.json")
COLORS = {"bmw-m5-g90": "#4f8bff", "cybertruck-cyberbeast": "#dfe6f0", "waymo-ipace": "#24d69a"}


def _oriented(df: pd.DataFrame, car_id: str):
    """Rows where car_id raced, features oriented as (car_id minus opponent), label = car_id won."""
    a = df[df["car_a"] == car_id].copy()
    Xa = a[FEATURES].to_numpy(float)
    ya = a["a_beats_b"].to_numpy(int)

    b = df[df["car_b"] == car_id].copy()
    Xb = -b[FEATURES].to_numpy(float)  # negate: opponent-minus-car -> car-minus-opponent
    yb = 1 - b["a_beats_b"].to_numpy(int)

    return np.vstack([Xa, Xb]), np.concatenate([ya, yb])


def run_for_car(car_id: str, car_name: str) -> dict:
    df = pd.read_parquet(DATA)
    X, y = _oriented(df, car_id)

    # 60/20/20; tune nothing fancy - a single logistic, same discipline as the main model.
    X_tr, X_tmp, y_tr, y_tmp = train_test_split(X, y, test_size=0.4, random_state=0, stratify=y)
    _, X_te, _, y_te = train_test_split(X_tmp, y_tmp, test_size=0.5, random_state=0, stratify=y_tmp)

    scaler = StandardScaler().fit(X_tr)
    model = LogisticRegression(C=0.1, max_iter=1000).fit(scaler.transform(X_tr), y_tr)

    prob = model.predict_proba(scaler.transform(X_te))[:, 1]
    pred = (prob >= 0.5).astype(int)
    acc = float(accuracy_score(y_te, pred))
    auc = float(roc_auc_score(y_te, prob))
    fpr, tpr, _ = roc_curve(y_te, prob)
    base = float(max(y_te.mean(), 1 - y_te.mean()))

    _plot_roc(car_id, car_name, fpr, tpr, auc, len(y_te))
    _update_json(car_id, car_name, acc, auc, int(len(y_te)))

    print(f"{car_name}: win-rate acc {acc:.4f} | AUC {auc:.4f} | n_test {len(y_te)} | majority {base:.3f}")
    return {"id": car_id, "name": car_name, "accuracy": round(acc, 4), "auc": round(auc, 4), "n": int(len(y_te))}


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
    ax.set_title(f"ROC - does {car_name} win?  (n_test = {n})", fontsize=11)
    ax.legend(loc="lower right", fontsize=9)
    ax.grid(alpha=0.2)
    fig.text(0.5, 0.01, "Synthetic benchmark: agreement with SimZoner physics, not real vehicles.",
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
