"""Per-car model: BMW M5 (G90). Predicts whether the BMW wins a given matchup.
Run:  python per_car/train_bmw.py   (from the ml/ directory)
Outputs ml/metrics/roc_bmw.png and updates model_metrics.json."""

from common import run_for_car

if __name__ == "__main__":
    run_for_car("bmw-m5-g90", "BMW M5")
