"""
Evaluation plots for the SimZoner race-outcome classifier.

Reads metrics/eval_test.csv (held-out test set of a logistic regression
predicting "car A beats car B" in a synthetic race sim) and produces:
  - metrics/confusion_matrix.png   (counts + row-normalized heatmap)
  - metrics/confusion_per_route.png (per-route accuracy bar chart)
  - metrics/classification.json    (precision/recall/F1/support, accuracies, CM)

This is a SYNTHETIC BENCHMARK: it measures agreement with the sim's own
physics, not real-world vehicles. ASCII-only stdout for cp1252 consoles.
"""

import json
import os

import matplotlib
matplotlib.use("Agg")  # headless

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_recall_fscore_support,
)

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "eval_test.csv")
CM_PNG = os.path.join(HERE, "confusion_matrix.png")
ROUTE_PNG = os.path.join(HERE, "confusion_per_route.png")
JSON_PATH = os.path.join(HERE, "classification.json")

CLASS_NAMES = ["B wins", "A wins"]  # index 0, 1

# ---------------------------------------------------------------- load
df = pd.read_csv(CSV_PATH)
y_true = df["y_true"].to_numpy()
y_pred = df["y_pred"].to_numpy()
n_rows = len(df)

# ---------------------------------------------------------------- metrics
overall_acc = float(accuracy_score(y_true, y_pred))
cm = confusion_matrix(y_true, y_pred, labels=[0, 1])  # rows=actual, cols=pred
prec, rec, f1, support = precision_recall_fscore_support(
    y_true, y_pred, labels=[0, 1], zero_division=0
)

# row-normalized CM (percent of each actual class)
cm_row_sums = cm.sum(axis=1, keepdims=True)
cm_norm = cm / np.clip(cm_row_sums, 1, None)

# per-route accuracy
route_stats = []
for route_id, g in df.groupby("route_id"):
    acc = float(accuracy_score(g["y_true"], g["y_pred"]))
    route_stats.append({"route_id": route_id, "accuracy": acc, "n": int(len(g))})
route_stats.sort(key=lambda r: r["accuracy"])  # ascending for the sorted bar chart

# ---------------------------------------------------------------- plot 1: confusion matrix
fig, ax = plt.subplots(figsize=(6.4, 5.6))
im = ax.imshow(cm_norm, cmap="Blues", vmin=0.0, vmax=1.0)

ax.set_xticks([0, 1])
ax.set_yticks([0, 1])
ax.set_xticklabels(CLASS_NAMES)
ax.set_yticklabels(CLASS_NAMES)
ax.set_xlabel("Predicted", fontsize=12, labelpad=8)
ax.set_ylabel("Actual", fontsize=12, labelpad=8)

# annotate each cell with count + row-normalized percent
thresh = 0.5
for i in range(2):
    for j in range(2):
        pct = cm_norm[i, j] * 100.0
        txt = "{:,}\n{:.1f}%".format(cm[i, j], pct)
        color = "white" if cm_norm[i, j] > thresh else "#1b2530"
        ax.text(j, i, txt, ha="center", va="center",
                fontsize=13, fontweight="bold", color=color)

cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
cbar.set_label("Row-normalized fraction", fontsize=10)

fig.suptitle("SimZoner Race-Outcome Classifier -- Confusion Matrix",
             fontsize=13, fontweight="bold", y=0.99)
ax.set_title(
    "Overall test accuracy = {:.1%}  (n = {:,})\n"
    "synthetic benchmark: agreement with sim physics".format(overall_acc, n_rows),
    fontsize=10, color="#444444", pad=10,
)
fig.tight_layout()
fig.savefig(CM_PNG, dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------------------------------------------------------------- plot 2: per-route accuracy
labels = [r["route_id"] for r in route_stats]
accs = [r["accuracy"] for r in route_stats]
ns = [r["n"] for r in route_stats]

fig, ax = plt.subplots(figsize=(8.6, 5.2))
cmap = plt.get_cmap("cividis")
colors = [cmap(0.15 + 0.6 * (a - min(accs)) / max(max(accs) - min(accs), 1e-9))
          for a in accs]
x = np.arange(len(labels))
bars = ax.bar(x, accs, color=colors, edgecolor="#22303c", linewidth=0.8, width=0.62)

ax.axhline(overall_acc, color="#c44e52", linestyle="--", linewidth=1.4,
           label="Overall accuracy = {:.1%}".format(overall_acc))

for bar, a, n in zip(bars, accs, ns):
    ax.text(bar.get_x() + bar.get_width() / 2, a + 0.012,
            "{:.1%}\n(n={:,})".format(a, n),
            ha="center", va="bottom", fontsize=10, fontweight="bold")

ax.set_xticks(x)
ax.set_xticklabels(labels, rotation=18, ha="right", fontsize=10)
ax.set_ylabel("Accuracy", fontsize=12)
ax.set_ylim(0, 1.08)
ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: "{:.0%}".format(v)))
ax.set_title("Per-Route Accuracy (sorted)  --  SimZoner synthetic benchmark",
             fontsize=13, fontweight="bold", pad=12)
ax.legend(loc="lower right", fontsize=10, framealpha=0.9)
ax.grid(axis="y", linestyle=":", alpha=0.5)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig(ROUTE_PNG, dpi=140, bbox_inches="tight")
plt.close(fig)

# ---------------------------------------------------------------- JSON
report = {
    "dataset": "held-out test set (synthetic race sim benchmark)",
    "n_rows": int(n_rows),
    "overall_accuracy": round(overall_acc, 4),
    "classes": {
        CLASS_NAMES[0]: {
            "label": 0,
            "precision": round(float(prec[0]), 4),
            "recall": round(float(rec[0]), 4),
            "f1": round(float(f1[0]), 4),
            "support": int(support[0]),
        },
        CLASS_NAMES[1]: {
            "label": 1,
            "precision": round(float(prec[1]), 4),
            "recall": round(float(rec[1]), 4),
            "f1": round(float(f1[1]), 4),
            "support": int(support[1]),
        },
    },
    "confusion_matrix": {
        "layout": "rows=actual [B wins, A wins], cols=predicted [B wins, A wins]",
        "counts": cm.astype(int).tolist(),
        "row_normalized": np.round(cm_norm, 4).tolist(),
    },
    "per_route_accuracy": [
        {"route_id": r["route_id"], "accuracy": round(r["accuracy"], 4), "n": r["n"]}
        for r in sorted(route_stats, key=lambda r: r["accuracy"], reverse=True)
    ],
}
with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2)

# ---------------------------------------------------------------- verify + report (ASCII only)
print("=== SimZoner classifier evaluation ===")
print("rows: {}".format(n_rows))
print("overall accuracy: {:.4f}".format(overall_acc))
print("")
print("per-class metrics:")
for idx, name in enumerate(CLASS_NAMES):
    print("  {:8s} (label {}): precision={:.4f} recall={:.4f} f1={:.4f} support={}".format(
        name, idx, prec[idx], rec[idx], f1[idx], support[idx]))
print("")
print("confusion matrix (rows=actual, cols=pred) [B wins, A wins]:")
print("  {}".format(cm.tolist()))
cm_sum = int(cm.sum())
print("  cell sum = {} (expected 2374): {}".format(
    cm_sum, "OK" if cm_sum == 2374 else "MISMATCH"))
print("")
print("per-route accuracy (sorted desc):")
for r in sorted(route_stats, key=lambda r: r["accuracy"], reverse=True):
    print("  {:28s} acc={:.4f}  n={}".format(r["route_id"], r["accuracy"], r["n"]))
print("")
print("outputs:")
for p in (CM_PNG, ROUTE_PNG, JSON_PATH):
    exists = os.path.exists(p)
    size = os.path.getsize(p) if exists else 0
    print("  [{}] {} ({} bytes)".format("OK" if exists else "MISSING", p, size))
