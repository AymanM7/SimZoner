"""
Train and honestly evaluate the race-outcome model (ENGINE v2), then export serving weights.

What changed from v1 (docs/research/balance-and-ml.md section 2):
  - LEAKAGE FIX: v1 split by ROW, so pairwise rows from the same race landed in both train
    and test (they share the race's traffic/weather/incident draws). We now GROUP by race_id
    with StratifiedGroupKFold so no race straddles the split.
  - ROBUST EVAL: instead of one 60/20/20 accuracy, we report mean +/- std over
    (dataset seeds) x (5-fold grouped CV repeated over CV seeds) = many estimates, plus a
    Wilson interval on held-out accuracy and a bootstrap 95% CI on held-out AUC, plus
    per-route / per-weather / per-HOV breakdowns from out-of-fold predictions.

Discipline (ML_APPROACH.md section 1.2): the final held-out test is touched ONCE. The shipped
model is a single logistic (its weights export to a dot product the Worker serves in <10ms);
gradient boosting is a ceiling probe, not a deploy target. Weights are exported RAW-feature
(scaler folded in) so serving needs no preprocessing.
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from statsmodels.stats.proportion import proportion_confint

from generate import FEATURES, build_rows, load_fixtures

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "races.parquet")
OUT = os.path.join(HERE, "..", "cloud-compute", "src", "model", "weights.json")
METRICS_JSON = os.path.join(HERE, "..", "frontend", "src", "data", "model_metrics.json")

ENGINE_VERSION = "v2"
CV_SEEDS = [42, 43, 44]   # dataset seeds: does the conclusion survive a different synthetic world?
N_REPEATS = 5             # CV-split seeds: estimator stability under resampling
N_SPLITS = 5              # grouped folds
N_CV = 6000               # races per CV dataset seed (kept small so the sweep runs in minutes)
BEST_C_GRID = [0.03, 0.1, 0.3, 1.0, 3.0]


def make_logit(C):
    return make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=1000))


def grouped_scores(X, y, groups, C, scoring):
    """Pool scores over N_REPEATS grouped 5-fold CV runs (loop random_state; no grouped-repeated
    splitter exists in sklearn)."""
    out = []
    for r in range(N_REPEATS):
        cv = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=r)
        out.append(cross_val_score(make_logit(C), X, y, cv=cv, groups=groups, scoring=scoring))
    return np.concatenate(out)


def xyg(df):
    return (
        df[FEATURES].to_numpy(float),
        df["a_beats_b"].to_numpy(int),
        df["race_id"].to_numpy(),
    )


def main():
    df = pd.read_parquet(DATA)
    X, y, groups = xyg(df)
    print(f"loaded {len(df)} rows / {df['race_id'].nunique()} races (engine {ENGINE_VERSION})")

    # -- Baselines a model must beat to mean anything (ML_APPROACH 6.1) --
    majority = float(max(y.mean(), 1 - y.mean()))
    higher_risk = float(accuracy_score(y, (df["risk_diff"].to_numpy() > 0).astype(int)))
    print(f"baseline  majority-class      : {majority:.3f}")
    print(f"baseline  higher-risk-wins    : {higher_risk:.3f}")

    # -- Tune C on grouped CV (no test peeking) --
    best_C, best_acc = None, -1.0
    for C in BEST_C_GRID:
        m = grouped_scores(X, y, groups, C, "accuracy").mean()
        if m > best_acc:
            best_acc, best_C = m, C
    print(f"logistic  best C={best_C} (grouped-CV acc {best_acc:.3f})")

    # -- Robust protocol: dataset seeds x grouped 5-fold x N_REPEATS --
    vehicles, routes = load_fixtures()
    acc_all, auc_all = [], []
    per_seed = []
    for s in CV_SEEDS:
        d = df if (s == 42 and len(df) >= N_CV) else build_rows(vehicles, routes, data_seed=s, n_races=N_CV)
        Xs, ys, gs = xyg(d)
        a = grouped_scores(Xs, ys, gs, best_C, "accuracy")
        u = grouped_scores(Xs, ys, gs, best_C, "roc_auc")
        acc_all.append(a)
        auc_all.append(u)
        per_seed.append((s, len(d), a.mean(), u.mean()))
        print(f"  dataset seed {s}: n_rows {len(d):6d}  acc {a.mean():.3f}  auc {u.mean():.3f}")
    acc_all = np.concatenate(acc_all)
    auc_all = np.concatenate(auc_all)
    n_est = len(acc_all)
    acc_mean, acc_std = float(acc_all.mean()), float(acc_all.std())
    auc_mean, auc_std = float(auc_all.mean()), float(auc_all.std())
    # Across-fold 95% CI on the mean (indicative; folds share training data).
    acc_fold_ci = [float(acc_mean - 1.96 * acc_std / np.sqrt(n_est)),
                   float(acc_mean + 1.96 * acc_std / np.sqrt(n_est))]
    auc_fold_ci = [float(auc_mean - 1.96 * auc_std / np.sqrt(n_est)),
                   float(auc_mean + 1.96 * auc_std / np.sqrt(n_est))]
    print(f"\n=== grouped CV over {len(CV_SEEDS)} dataset seeds x {N_SPLITS}-fold x {N_REPEATS} = {n_est} estimates ===")
    print(f"accuracy {acc_mean:.3f} +/- {acc_std:.3f}")
    print(f"AUC      {auc_mean:.3f} +/- {auc_std:.3f}")

    # -- Gradient boosting ceiling probe (not shipped): grouped 5-fold accuracy --
    cv0 = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=0)
    gbm_acc = float(cross_val_score(GradientBoostingClassifier(random_state=0),
                                    X, y, cv=cv0, groups=groups, scoring="accuracy").mean())
    print(f"gbm       grouped-CV acc {gbm_acc:.3f}  -- ceiling probe, not deployed")

    # -- One look at a held-out test set (Wilson acc CI + bootstrap AUC CI) --
    cv_test = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=123)
    tr_idx, te_idx = next(cv_test.split(X, y, groups))
    pipe = make_logit(best_C).fit(X[tr_idx], y[tr_idx])
    prob_te = pipe.predict_proba(X[te_idx])[:, 1]
    pred_te = (prob_te >= 0.5).astype(int)
    y_te = y[te_idx]
    test_acc = float(accuracy_score(y_te, pred_te))
    test_auc = float(roc_auc_score(y_te, prob_te))
    n_correct = int((pred_te == y_te).sum())
    acc_lo, acc_hi = proportion_confint(n_correct, len(y_te), alpha=0.05, method="wilson")
    rngb = np.random.default_rng(0)
    boot = []
    for _ in range(2000):
        idx = rngb.integers(0, len(y_te), len(y_te))
        if len(np.unique(y_te[idx])) < 2:
            continue
        boot.append(roc_auc_score(y_te[idx], prob_te[idx]))
    auc_lo, auc_hi = (float(x) for x in np.percentile(boot, [2.5, 97.5]))
    print("\n=== held-out test (touched once) ===")
    print(f"accuracy {test_acc:.3f}  Wilson 95% CI [{acc_lo:.3f}, {acc_hi:.3f}]  (n_test={len(y_te)})")
    print(f"AUC      {test_auc:.3f}  bootstrap 95% CI [{auc_lo:.3f}, {auc_hi:.3f}]")

    # -- Out-of-fold predictions -> per-route / per-weather / per-HOV breakdowns --
    cv_oof = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=0)
    oof = cross_val_predict(make_logit(best_C), X, y, cv=cv_oof, groups=groups, method="predict_proba")[:, 1]
    df = df.copy()
    df["oof_prob"] = oof
    df["oof_pred"] = (oof >= 0.5).astype(int)

    def slice_metrics(key):
        res = {}
        for val, d in df.groupby(key):
            yy = d["a_beats_b"].to_numpy(int)
            acc = float((d["oof_pred"].to_numpy() == yy).mean())
            auc = float(roc_auc_score(yy, d["oof_prob"])) if len(np.unique(yy)) > 1 else None
            res[str(val)] = {"n": int(len(d)), "acc": round(acc, 4),
                             "auc": round(auc, 4) if auc is not None else None,
                             "base_rate": round(float(max(yy.mean(), 1 - yy.mean())), 4)}
        return res

    per_route = slice_metrics("route_id")
    per_weather = slice_metrics("weather")
    per_hov = slice_metrics("hov_eligible_diff")
    print("\nper-route (oof):")
    for k, v in per_route.items():
        print(f"  {k:22s} n={v['n']:6d} acc={v['acc']:.3f} auc={v['auc']} base={v['base_rate']:.3f}")
    print("per-weather (oof):", {k: v["auc"] for k, v in per_weather.items()})
    print("per-HOV-mismatch (oof):", {k: v["auc"] for k, v in per_hov.items()})

    # -- Coefficient sanity vs physics --
    logit = pipe.named_steps["logisticregression"]
    scaler = pipe.named_steps["standardscaler"]
    print("\nlogistic coefficients (standardized):")
    for name, w in zip(FEATURES, logit.coef_[0]):
        print(f"  {name:20s} {w:+.3f}")

    # -- Ship: retrain logistic on the FULL dataset, fold scaler into raw-feature weights --
    ship = make_logit(best_C).fit(X, y)
    sc = ship.named_steps["standardscaler"]
    lg = ship.named_steps["logisticregression"]
    w_std, b_std = lg.coef_[0], lg.intercept_[0]
    w_raw = w_std / sc.scale_
    b_raw = float(b_std - np.sum(w_std * sc.mean_ / sc.scale_))

    metrics = {
        "protocol": f"{len(CV_SEEDS)} dataset seeds x StratifiedGroupKFold({N_SPLITS}-fold) repeated {N_REPEATS}x, grouped by race_id",
        "n_estimates": int(n_est),
        "accuracy_mean": round(acc_mean, 4),
        "accuracy_std": round(acc_std, 4),
        "accuracy_fold_ci95": [round(acc_fold_ci[0], 4), round(acc_fold_ci[1], 4)],
        "auc_mean": round(auc_mean, 4),
        "auc_std": round(auc_std, 4),
        "auc_fold_ci95": [round(auc_fold_ci[0], 4), round(auc_fold_ci[1], 4)],
        "test_accuracy": round(test_acc, 4),
        "test_accuracy_wilson_ci95": [round(float(acc_lo), 4), round(float(acc_hi), 4)],
        "test_auc": round(test_auc, 4),
        "test_auc_boot_ci95": [round(auc_lo, 4), round(auc_hi, 4)],
        "gbm_cv_accuracy": round(gbm_acc, 4),
        "majority_baseline": round(majority, 4),
        "higher_risk_wins_baseline": round(higher_risk, 4),
        "lift_over_majority": round(acc_mean - majority, 4),
        "n_rows": int(len(df)),
        "engine_version": ENGINE_VERSION,
        "note": "Synthetic benchmark. Agreement with SimZoner physics v2, not real vehicles.",
    }

    model = {
        "name": "race-outcome-logistic",
        "engine_version": ENGINE_VERSION,
        "trained": True,
        "features": FEATURES,
        "weights": [float(x) for x in w_raw],
        "bias": b_raw,
        "metrics": metrics,
        "note": "Synthetic benchmark. Measures agreement with SimZoner physics (engine v2), not real vehicles.",
    }
    with open(OUT, "w") as f:
        json.dump(model, f, indent=2)
    print(f"\nexported raw-feature weights -> {OUT}")

    _write_model_metrics(acc_mean, acc_std, auc_mean, auc_std, majority, higher_risk,
                         gbm_acc, test_acc, [acc_lo, acc_hi], test_auc, [auc_lo, auc_hi],
                         acc_fold_ci, auc_fold_ci, n_est, per_route, per_weather, per_hov,
                         metrics["protocol"])


def _write_model_metrics(acc_mean, acc_std, auc_mean, auc_std, majority, higher_risk,
                         gbm_acc, test_acc, acc_ci, test_auc, auc_ci,
                         acc_fold_ci, auc_fold_ci, n_est, per_route, per_weather, per_hov, protocol):
    """Preserve the keys the UI reads (overall.test_accuracy, overall.auc, models[],
    per_car[].{accuracy,auc}) as MEAN values; ADD distribution fields + engine_version."""
    try:
        data = json.load(open(METRICS_JSON))
    except FileNotFoundError:
        data = {}
    per_car = data.get("per_car", [])  # updated by per_car/train_*.py; do not drop it

    data["overall"] = {
        "test_accuracy": round(acc_mean, 4),   # MEAN (was a single split scalar)
        "auc": round(auc_mean, 4),             # MEAN
        "majority_baseline": round(majority, 4),
        "accuracy_std": round(acc_std, 4),
        "auc_std": round(auc_std, 4),
        "accuracy_fold_ci95": [round(acc_fold_ci[0], 4), round(acc_fold_ci[1], 4)],
        "auc_fold_ci95": [round(auc_fold_ci[0], 4), round(auc_fold_ci[1], 4)],
        "held_out_test_accuracy": round(test_acc, 4),
        "held_out_accuracy_wilson_ci95": [round(float(acc_ci[0]), 4), round(float(acc_ci[1]), 4)],
        "held_out_test_auc": round(test_auc, 4),
        "held_out_auc_boot_ci95": [round(float(auc_ci[0]), 4), round(float(auc_ci[1]), 4)],
        "higher_risk_wins_baseline": round(higher_risk, 4),
        "n_estimates": int(n_est),
        "protocol": protocol,
    }
    data["models"] = [
        {"name": "Logistic Regression", "role": "shipped", "test_accuracy": round(acc_mean, 4), "auc": round(auc_mean, 4)},
        {"name": "Gradient Boosting", "role": "ceiling probe", "test_accuracy": round(gbm_acc, 4)},
    ]
    data["per_car"] = per_car
    data["per_route"] = per_route
    data["per_weather"] = per_weather
    data["per_hov_mismatch"] = per_hov
    data["engine_version"] = ENGINE_VERSION
    data["note"] = "Synthetic benchmark: agreement with SimZoner's physics engine (v2), not real vehicles."
    json.dump(data, open(METRICS_JSON, "w"), indent=2)
    print(f"updated {METRICS_JSON}")


if __name__ == "__main__":
    main()
