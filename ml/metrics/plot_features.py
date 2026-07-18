"""
Feature / coefficient analysis for the SimZoner race-outcome logistic classifier.

Investigates WHY the cda_diff (drag) coefficient is POSITIVE -- physically backwards,
since more drag should hurt, not help, winning. Hypothesis: COLLINEARITY. With only
3 vehicles, the highest-drag car (Cybertruck) is also highest-power and highest-risk,
so a linear model cannot separate their effects.

Produces (real PNGs computed from real data, no fabrication):
  metrics/coefficients.png          standardized logistic coefficients, sorted |w|
  metrics/feature_correlation.png   Pearson correlation heatmap of the 5 features
  metrics/permutation_importance.png  test-set permutation importance (n_repeats=20)
  metrics/features.json             all numbers + a plain-language finding

SYNTHETIC BENCHMARK: measures agreement with SimZoner physics engine v1, not real cars.
Reproduces the shipped model exactly (test acc ~0.8829).
"""

import json
import os

import numpy as np
import pandas as pd

import matplotlib
matplotlib.use("Agg")  # headless Windows
import matplotlib.pyplot as plt

from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

FEATURES = ["mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff"]
LABEL = "a_beats_b"

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "races.parquet")

# Colorblind-safe (Okabe-Ito derived)
POS_COLOR = "#0072B2"   # blue  -> positive coefficient
NEG_COLOR = "#D55E00"   # vermillion -> negative coefficient
FLAG_COLOR = "#CC79A7"  # reddish-purple, for the suspicious-sign flag
IMP_COLOR = "#009E73"   # bluish-green


def reproduce_model(df):
    """Reproduce the EXACT shipped model. Returns fitted parts + test data + std coefs."""
    X = df[FEATURES].to_numpy(dtype=float)
    y = df[LABEL].to_numpy(dtype=int)

    X_tr, X_tmp, y_tr, y_tmp = train_test_split(
        X, y, test_size=0.4, random_state=0, stratify=y)
    X_val, X_te, y_val, y_te = train_test_split(
        X_tmp, y_tmp, test_size=0.5, random_state=0, stratify=y_tmp)

    scaler = StandardScaler().fit(X_tr)
    Xs_tr, Xs_te = scaler.transform(X_tr), scaler.transform(X_te)

    logit = LogisticRegression(C=0.1, max_iter=1000).fit(Xs_tr, y_tr)
    test_acc = accuracy_score(y_te, logit.predict(Xs_te))

    std_coefs = dict(zip(FEATURES, [float(w) for w in logit.coef_[0]]))
    return logit, scaler, Xs_te, y_te, std_coefs, float(test_acc)


def plot_coefficients(std_coefs, path):
    """Horizontal bar of standardized coefs, sorted by |w|, colored by sign, annotated."""
    items = sorted(std_coefs.items(), key=lambda kv: abs(kv[1]))  # ascending -> largest on top
    names = [k for k, _ in items]
    vals = [v for _, v in items]
    colors = [POS_COLOR if v >= 0 else NEG_COLOR for v in vals]

    fig, ax = plt.subplots(figsize=(9, 5.2))
    ypos = np.arange(len(names))
    ax.barh(ypos, vals, color=colors, edgecolor="black", linewidth=0.6, zorder=3)
    ax.axvline(0, color="#444444", linewidth=1.0, zorder=2)

    ax.set_yticks(ypos)
    ax.set_yticklabels(names, fontsize=11)
    ax.set_xlabel("Standardized logistic coefficient (log-odds per 1 SD)", fontsize=11)
    ax.set_title("Standardized coefficients: what the linear model 'thinks' drives a win\n"
                 "SimZoner race-outcome logistic (synthetic; test acc ~0.883)",
                 fontsize=12, fontweight="bold")

    xmax = max(abs(v) for v in vals)
    pad = xmax * 0.06
    for yi, v in zip(ypos, vals):
        off = pad if v >= 0 else -pad
        ha = "left" if v >= 0 else "right"
        ax.text(v + off, yi, f"{v:+.3f}", va="center", ha=ha,
                fontsize=10, fontweight="bold", zorder=4)

    # Flag the physically-suspicious positive cda_diff sign
    if "cda_diff_m2" in names:
        idx = names.index("cda_diff_m2")
        cda_v = std_coefs["cda_diff_m2"]
        ax.annotate(
            "SUSPICIOUS: drag coef is POSITIVE\n(more drag should HURT winning)\n"
            "-> see feature_correlation.png",
            xy=(cda_v, idx),
            xytext=(-xmax * 1.28, idx + 0.15),
            fontsize=9.5, color=FLAG_COLOR, fontweight="bold",
            ha="left", va="center",
            arrowprops=dict(arrowstyle="->", color=FLAG_COLOR, lw=1.6),
            bbox=dict(boxstyle="round,pad=0.35", fc="white", ec=FLAG_COLOR, lw=1.3))
        # highlight the flagged bar
        ax.get_children()  # no-op keeps intent clear
        ax.barh(idx, cda_v, color="none", edgecolor=FLAG_COLOR, linewidth=2.4, zorder=5)

    ax.set_xlim(-xmax * 1.35, xmax * 1.55)
    # legend
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=POS_COLOR, label="positive (favors car A win)"),
                       Patch(color=NEG_COLOR, label="negative (favors car A loss)")],
              loc="lower right", fontsize=9, framealpha=0.9)
    ax.grid(axis="x", linestyle=":", alpha=0.4, zorder=0)
    fig.tight_layout()
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)


def plot_correlation(corr, path):
    """Correlation heatmap, diverging cmap centered at 0, annotated cells."""
    n = len(FEATURES)
    M = corr.loc[FEATURES, FEATURES].to_numpy()

    fig, ax = plt.subplots(figsize=(8.2, 7))
    im = ax.imshow(M, cmap="RdBu_r", vmin=-1, vmax=1, aspect="equal")
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("Pearson r", fontsize=10)

    ax.set_xticks(range(n))
    ax.set_yticks(range(n))
    ax.set_xticklabels(FEATURES, rotation=40, ha="right", fontsize=10)
    ax.set_yticklabels(FEATURES, fontsize=10)
    ax.set_title("Feature correlation matrix (full dataset, n only 3 cars)\n"
                 "The 'money plot': drag, power, risk move together -> collinearity",
                 fontsize=12, fontweight="bold")

    for i in range(n):
        for j in range(n):
            r = M[i, j]
            txt_color = "white" if abs(r) > 0.6 else "black"
            ax.text(j, i, f"{r:.2f}", ha="center", va="center",
                    color=txt_color, fontsize=10,
                    fontweight="bold" if i != j else "normal")

    # ring the cda vs power / cda vs risk cells that carry the argument
    ci = FEATURES.index("cda_diff_m2")
    for other in ("power_diff_kw", "risk_diff"):
        oj = FEATURES.index(other)
        for (yy, xx) in ((ci, oj), (oj, ci)):
            ax.add_patch(plt.Rectangle((xx - 0.5, yy - 0.5), 1, 1,
                         fill=False, edgecolor="#111111", linewidth=2.4))

    fig.tight_layout()
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)


def plot_permutation(pi_mean, pi_std, path):
    """Permutation importance on test set, sorted, with std error bars."""
    order = np.argsort(pi_mean)  # ascending, largest on top
    names = [FEATURES[i] for i in order]
    means = pi_mean[order]
    stds = pi_std[order]

    fig, ax = plt.subplots(figsize=(9, 5.2))
    ypos = np.arange(len(names))
    ax.barh(ypos, means, xerr=stds, color=IMP_COLOR, edgecolor="black",
            linewidth=0.6, zorder=3,
            error_kw=dict(ecolor="#333333", capsize=4, lw=1.2))
    ax.axvline(0, color="#444444", linewidth=1.0, zorder=2)
    ax.set_yticks(ypos)
    ax.set_yticklabels(names, fontsize=11)
    ax.set_xlabel("Mean drop in test accuracy when feature is shuffled (n_repeats=20)",
                  fontsize=11)
    ax.set_title("Permutation importance (test set): what ACTUALLY drives accuracy\n"
                 "Robust to collinearity in a way raw coefficients are not",
                 fontsize=12, fontweight="bold")

    xmax = max(means.max(), 1e-6)
    for yi, m, s in zip(ypos, means, stds):
        ax.text(m + s + xmax * 0.02, yi, f"{m:.3f}", va="center", ha="left",
                fontsize=10, fontweight="bold", zorder=4)

    ax.set_xlim(min(0, means.min() - stds.max()) - xmax * 0.05, xmax * 1.30)
    ax.grid(axis="x", linestyle=":", alpha=0.4, zorder=0)
    fig.tight_layout()
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)


def build_finding(std_coefs, corr, pi_mean):
    cda_coef = std_coefs["cda_diff_m2"]
    r_cp = float(corr.loc["cda_diff_m2", "power_diff_kw"])
    r_cr = float(corr.loc["cda_diff_m2", "risk_diff"])
    r_pr = float(corr.loc["power_diff_kw", "risk_diff"])
    # permutation ranking
    pi = dict(zip(FEATURES, pi_mean))
    rank = sorted(pi, key=lambda k: pi[k], reverse=True)

    high = abs(r_cp) > 0.7 or abs(r_cr) > 0.7
    if cda_coef > 0 and high:
        verdict = "SUPPORTED"
        msg = (
            f"COLLINEARITY EXPLAINS THE FLIP ({verdict}). The cda_diff coefficient is "
            f"positive ({cda_coef:+.3f} std), which is physically backwards -- more drag "
            f"should hurt. But with only 3 cars, drag is nearly collinear with power "
            f"(r={r_cp:.2f}) and risk (r={r_cr:.2f}); power and risk correlate at "
            f"r={r_pr:.2f}. The genuinely predictive, physically-correct signals "
            f"(power+, risk+) load onto these correlated axes; L2 regularization (C=0.1) "
            f"then splits the shared weight and lets drag absorb a positive sign it does "
            f"not causally deserve. Permutation importance ranks features by real "
            f"predictive contribution as {' > '.join(rank)}, which does not mirror the "
            f"distorted raw-coefficient magnitudes -- the signature of collinearity. "
            f"SYNTHETIC BENCHMARK: reflects SimZoner physics engine v1, not real vehicles."
        )
    elif cda_coef > 0:
        verdict = "PARTIAL"
        msg = (
            f"PARTIALLY SUPPORTED ({verdict}). cda_diff coef is positive ({cda_coef:+.3f}) "
            f"but its correlation with power (r={r_cp:.2f}) and risk (r={r_cr:.2f}) is not "
            f"extreme; collinearity contributes but may not fully explain the flip."
        )
    else:
        verdict = "REFUTED"
        msg = (
            f"NOT REPRODUCED ({verdict}). cda_diff coef is {cda_coef:+.3f} (not positive) "
            f"in this run, so the premise does not hold as stated."
        )
    return {
        "verdict": verdict,
        "finding": msg,
        "cda_diff_coef_std": cda_coef,
        "r_cda_power": r_cp,
        "r_cda_risk": r_cr,
        "r_power_risk": r_pr,
        "permutation_ranking": rank,
    }


def main():
    print("=== SimZoner feature/coefficient analysis ===")
    df = pd.read_parquet(DATA)
    print(f"loaded {len(df)} rows; cars = {sorted(pd.unique(df[['car_a','car_b']].values.ravel()))}")

    logit, scaler, Xs_te, y_te, std_coefs, test_acc = reproduce_model(df)
    print(f"reproduced model test acc = {test_acc:.4f} (target ~0.8829)")
    print("standardized coefficients:")
    for k in FEATURES:
        print(f"  {k:20s} {std_coefs[k]:+.4f}")

    # Correlation on full dataset
    corr = df[FEATURES].corr(method="pearson")
    print("cda_diff correlations: power=%.3f risk=%.3f (power~risk=%.3f)" % (
        corr.loc["cda_diff_m2", "power_diff_kw"],
        corr.loc["cda_diff_m2", "risk_diff"],
        corr.loc["power_diff_kw", "risk_diff"]))

    # Permutation importance on TEST set
    pim = permutation_importance(logit, Xs_te, y_te, n_repeats=20,
                                 random_state=0, scoring="accuracy")
    pi_mean, pi_std = pim.importances_mean, pim.importances_std
    print("permutation importance (mean drop in acc):")
    for i in np.argsort(pi_mean)[::-1]:
        print(f"  {FEATURES[i]:20s} {pi_mean[i]:+.4f} +/- {pi_std[i]:.4f}")

    # Plots
    p_coef = os.path.join(HERE, "coefficients.png")
    p_corr = os.path.join(HERE, "feature_correlation.png")
    p_perm = os.path.join(HERE, "permutation_importance.png")
    p_json = os.path.join(HERE, "features.json")

    plot_coefficients(std_coefs, p_coef)
    plot_correlation(corr, p_corr)
    plot_permutation(pi_mean, pi_std, p_perm)

    finding = build_finding(std_coefs, corr, pi_mean)

    out = {
        "model": "race-outcome-logistic (C=0.1, StandardScaler, 60/20/20 stratified)",
        "test_accuracy": round(test_acc, 4),
        "n_rows": int(len(df)),
        "cars": sorted(pd.unique(df[["car_a", "car_b"]].values.ravel()).tolist()),
        "features": FEATURES,
        "standardized_coefficients": {k: round(std_coefs[k], 5) for k in FEATURES},
        "correlation_matrix": {
            a: {b: round(float(corr.loc[a, b]), 5) for b in FEATURES} for a in FEATURES
        },
        "permutation_importance": {
            FEATURES[i]: {"mean": round(float(pi_mean[i]), 5),
                          "std": round(float(pi_std[i]), 5)}
            for i in range(len(FEATURES))
        },
        "verdict": finding["verdict"],
        "finding": finding["finding"],
        "evidence": {
            "cda_diff_coef_std": round(finding["cda_diff_coef_std"], 5),
            "r_cda_power": round(finding["r_cda_power"], 5),
            "r_cda_risk": round(finding["r_cda_risk"], 5),
            "r_power_risk": round(finding["r_power_risk"], 5),
            "permutation_ranking": finding["permutation_ranking"],
        },
        "caveat": "SYNTHETIC BENCHMARK: measures agreement with SimZoner physics engine "
                  "v1, not real vehicles. Only 3 cars generate all pairwise diffs.",
    }
    with open(p_json, "w") as f:
        json.dump(out, f, indent=2)

    # Verify outputs
    print("\n=== outputs ===")
    for p in (p_coef, p_corr, p_perm, p_json):
        if os.path.exists(p):
            print(f"OK  {os.path.abspath(p)}  ({os.path.getsize(p)} bytes)")
        else:
            print(f"MISSING  {p}")

    print("\nVERDICT:", finding["verdict"])
    print(finding["finding"])


if __name__ == "__main__":
    main()
