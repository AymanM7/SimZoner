"""
Train and honestly evaluate a race-outcome model, then export weights for serving.

Discipline (docs/ML_APPROACH.md §1.2): test split is touched ONCE, at the end. Model
choice and C are tuned on validation only. We report whatever the number is, and it is
only meaningful next to a baseline (§6). The shipped model is logistic regression
because its weights export to a dot product the Cloud Compute worker serves in <10ms;
gradient boosting is a ceiling probe, not a deploy target (§5).

Exports RAW-feature weights (scaler folded in) so serving needs no preprocessing.
"""

import json

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

FEATURES = ["mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff"]
OUT = "../cloud-compute/src/model/weights.json"


def main():
    df = pd.read_parquet("data/races.parquet")
    X = df[FEATURES].to_numpy(dtype=float)
    y = df["a_beats_b"].to_numpy(dtype=int)

    # 60/20/20 train/val/test, stratified. Test is set aside and not looked at until §9.
    X_tr, X_tmp, y_tr, y_tmp = train_test_split(X, y, test_size=0.4, random_state=0, stratify=y)
    X_val, X_te, y_val, y_te = train_test_split(X_tmp, y_tmp, test_size=0.5, random_state=0, stratify=y_tmp)

    scaler = StandardScaler().fit(X_tr)
    Xs_tr, Xs_val, Xs_te = scaler.transform(X_tr), scaler.transform(X_val), scaler.transform(X_te)

    # ── Baselines a model must beat to mean anything (ML_APPROACH §6.1) ──
    majority = max(y_tr.mean(), 1 - y_tr.mean())
    risk_col = X_val[:, FEATURES.index("risk_diff")]
    heuristic = accuracy_score(y_val, (risk_col > 0).astype(int))
    print(f"baseline  majority-class : {majority:.3f}")
    print(f"baseline  higher-risk-wins (val): {heuristic:.3f}")

    # ── Tune logistic C on VALIDATION only ──
    best_C, best_val = None, -1
    for C in [0.03, 0.1, 0.3, 1.0, 3.0]:
        m = LogisticRegression(C=C, max_iter=1000).fit(Xs_tr, y_tr)
        v = accuracy_score(y_val, m.predict(Xs_val))
        if v > best_val:
            best_val, best_C = v, C
    print(f"logistic  best C={best_C} (val acc {best_val:.3f})")

    logit = LogisticRegression(C=best_C, max_iter=1000).fit(Xs_tr, y_tr)

    # ── Ceiling probe (not shipped): does a nonlinear model do meaningfully better? ──
    gb = GradientBoostingClassifier(random_state=0).fit(X_tr, y_tr)
    gb_val = accuracy_score(y_val, gb.predict(X_val))
    print(f"gbm       (val acc {gb_val:.3f}) -- ceiling probe, not deployed")

    # ── THE ONE LOOK AT TEST ──
    logit_te = accuracy_score(y_te, logit.predict(Xs_te))
    gb_te = accuracy_score(y_te, gb.predict(X_te))
    cm = confusion_matrix(y_te, logit.predict(Xs_te))
    print("\n=== TEST (touched once) ===")
    print(f"logistic  test acc : {logit_te:.3f}")
    print(f"gbm       test acc : {gb_te:.3f}")
    print(f"vs majority baseline: {majority:.3f}  (lift {logit_te - majority:+.3f})")
    print(f"confusion matrix [ [TN FP] [FN TP] ]:\n{cm}")

    # ── Coefficient sanity vs physics (ML_APPROACH: signs must agree with the engine) ──
    print("\nlogistic coefficients (standardized):")
    for name, w in zip(FEATURES, logit.coef_[0]):
        print(f"  {name:20s} {w:+.3f}")

    # ── Fold scaler into RAW-feature weights so serving is a plain dot product ──
    w_std, b_std = logit.coef_[0], logit.intercept_[0]
    w_raw = w_std / scaler.scale_
    b_raw = float(b_std - np.sum(w_std * scaler.mean_ / scaler.scale_))

    model = {
        "name": "race-outcome-logistic",
        "engine_version": "v1",
        "trained": True,
        "features": FEATURES,
        "weights": [float(x) for x in w_raw],
        "bias": b_raw,
        "metrics": {
            "test_accuracy": round(float(logit_te), 4),
            "gbm_test_accuracy": round(float(gb_te), 4),
            "majority_baseline": round(float(majority), 4),
            "n_rows": int(len(df)),
        },
        "note": "Synthetic benchmark. Measures agreement with SimZoner physics (engine v1), not real vehicles.",
    }
    with open(OUT, "w") as f:
        json.dump(model, f, indent=2)
    print(f"\nexported raw-feature weights -> {OUT}")


if __name__ == "__main__":
    main()
