"""Threshold / probability-quality plots for the SimZoner race-outcome classifier.

Reads a frozen held-out test set (metrics/eval_test.csv) and produces:
  - metrics/roc_curve.png    ROC curve + AUC
  - metrics/pr_curve.png     Precision-Recall curve + Average Precision
  - metrics/calibration.png  Reliability diagram + Brier score
  - metrics/roc.json          summary stats + downsampled ROC points

No retraining. Everything is computed from eval_test.csv.
"""

import json
import os

import numpy as np
import pandas as pd

import matplotlib
matplotlib.use("Agg")  # headless / no display
import matplotlib.pyplot as plt

from sklearn.metrics import (
    roc_curve,
    roc_auc_score,
    precision_recall_curve,
    average_precision_score,
    brier_score_loss,
    accuracy_score,
)
from sklearn.calibration import calibration_curve

# --- config ---------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "eval_test.csv")
ROC_PNG = os.path.join(HERE, "roc_curve.png")
PR_PNG = os.path.join(HERE, "pr_curve.png")
CAL_PNG = os.path.join(HERE, "calibration.png")
JSON_PATH = os.path.join(HERE, "roc.json")

DPI = 140
SUBTITLE = "SimZoner synthetic race-sim benchmark (held-out test set)"

# colorblind-safe (Wong / Okabe-Ito)
C_BLUE = "#0072B2"
C_ORANGE = "#E69F00"
C_GREEN = "#009E73"
C_GRAY = "#666666"

# --- load -----------------------------------------------------------------
df = pd.read_csv(CSV_PATH)
y_true = df["y_true"].to_numpy()
y_prob = df["y_prob"].to_numpy()
y_pred = df["y_pred"].to_numpy()
n = len(df)

# --- metrics --------------------------------------------------------------
auc = roc_auc_score(y_true, y_prob)
ap = average_precision_score(y_true, y_prob)
brier = brier_score_loss(y_true, y_prob)
base_rate = float(np.mean(y_true))
acc = accuracy_score(y_true, y_pred)

fpr, tpr, thr = roc_curve(y_true, y_prob)
prec, rec, _ = precision_recall_curve(y_true, y_prob)
cal_true, cal_pred = calibration_curve(y_true, y_prob, n_bins=10, strategy="uniform")

print("Loaded {} rows from {}".format(n, CSV_PATH))
print("AUC              : {:.4f}".format(auc))
print("Average Precision: {:.4f}".format(ap))
print("Brier score      : {:.4f}".format(brier))
print("Positive base rate: {:.4f}".format(base_rate))
print("Accuracy (y_pred): {:.4f}".format(acc))

# --- 1. ROC ---------------------------------------------------------------
fig, ax = plt.subplots(figsize=(6, 6))
ax.plot(fpr, tpr, color=C_BLUE, lw=2.2, label="ROC (AUC = {:.3f})".format(auc))
ax.plot([0, 1], [0, 1], color=C_GRAY, lw=1.4, ls="--", label="Chance")
ax.set_xlim(-0.01, 1.01)
ax.set_ylim(-0.01, 1.01)
ax.set_xlabel("False Positive Rate")
ax.set_ylabel("True Positive Rate")
ax.set_title("ROC Curve — car A beats car B")
ax.text(0.5, 1.06, SUBTITLE, transform=ax.transAxes, ha="center",
        va="bottom", fontsize=8, color=C_GRAY)
ax.legend(loc="lower right", frameon=True)
ax.grid(True, alpha=0.3)
ax.set_aspect("equal")
fig.savefig(ROC_PNG, dpi=DPI, bbox_inches="tight")
plt.close(fig)

# --- 2. Precision-Recall --------------------------------------------------
fig, ax = plt.subplots(figsize=(6, 6))
ax.plot(rec, prec, color=C_ORANGE, lw=2.2, label="PR (AP = {:.3f})".format(ap))
ax.axhline(base_rate, color=C_GRAY, lw=1.4, ls="--",
           label="No-skill baseline ({:.3f})".format(base_rate))
ax.set_xlim(-0.01, 1.01)
ax.set_ylim(-0.01, 1.01)
ax.set_xlabel("Recall")
ax.set_ylabel("Precision")
ax.set_title("Precision-Recall Curve — car A beats car B")
ax.text(0.5, 1.06, SUBTITLE, transform=ax.transAxes, ha="center",
        va="bottom", fontsize=8, color=C_GRAY)
ax.legend(loc="lower left", frameon=True)
ax.grid(True, alpha=0.3)
ax.set_aspect("equal")
fig.savefig(PR_PNG, dpi=DPI, bbox_inches="tight")
plt.close(fig)

# --- 3. Calibration / reliability ----------------------------------------
fig, ax = plt.subplots(figsize=(6, 6))
ax.plot([0, 1], [0, 1], color=C_GRAY, lw=1.4, ls="--",
        label="Perfectly calibrated")
ax.plot(cal_pred, cal_true, color=C_GREEN, lw=2.0, marker="o", ms=5,
        label="Model (10 bins)")
ax.set_xlim(-0.01, 1.01)
ax.set_ylim(-0.01, 1.01)
ax.set_xlabel("Mean predicted probability")
ax.set_ylabel("Observed frequency (fraction positive)")
ax.set_title("Reliability Diagram — Brier = {:.4f}".format(brier))
ax.text(0.5, 1.06, SUBTITLE, transform=ax.transAxes, ha="center",
        va="bottom", fontsize=8, color=C_GRAY)
ax.legend(loc="upper left", frameon=True)
ax.grid(True, alpha=0.3)
ax.set_aspect("equal")
fig.savefig(CAL_PNG, dpi=DPI, bbox_inches="tight")
plt.close(fig)

# --- 4. JSON (downsampled ROC ~50 pts) -----------------------------------
def downsample(arr, k):
    m = len(arr)
    if m <= k:
        return np.arange(m)
    return np.unique(np.linspace(0, m - 1, k).round().astype(int))

idx = downsample(fpr, 50)
# clean +/- inf that sklearn puts at thr[0]
thr_clean = np.where(np.isinf(thr), None, np.round(thr, 4))

roc_points = {
    "fpr": [round(float(fpr[i]), 4) for i in idx],
    "tpr": [round(float(tpr[i]), 4) for i in idx],
    "thresholds": [None if thr_clean[i] is None else float(thr_clean[i]) for i in idx],
}

summary = {
    "n_test": int(n),
    "auc": round(float(auc), 4),
    "average_precision": round(float(ap), 4),
    "brier_score": round(float(brier), 4),
    "positive_base_rate": round(base_rate, 4),
    "accuracy": round(float(acc), 4),
    "note": "SimZoner synthetic race-sim benchmark; held-out test set; no retraining.",
    "roc_curve": roc_points,
}

with open(JSON_PATH, "w") as f:
    json.dump(summary, f, indent=2)

# --- verify ---------------------------------------------------------------
assert 0.5 < auc < 1.0, "AUC out of expected range"
print("")
print("Wrote outputs:")
for p in (ROC_PNG, PR_PNG, CAL_PNG, JSON_PATH):
    ok = os.path.exists(p)
    size = os.path.getsize(p) if ok else 0
    print("  [{}] {} ({} bytes)".format("OK" if ok else "MISSING", p, size))
print("")
print("ROC JSON downsampled to {} points.".format(len(idx)))
print("Done.")
