"""Per-car model: Waymo (Jaguar I-Pace). Predicts whether the Waymo wins a matchup.
Run:  python per_car/train_waymo.py   (from the ml/ directory)
Outputs ml/metrics/roc_waymo.png and updates model_metrics.json."""

from common import run_for_car

if __name__ == "__main__":
    run_for_car("waymo-ipace", "Waymo")
