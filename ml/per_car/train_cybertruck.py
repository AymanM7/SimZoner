"""Per-car model: Tesla Cybertruck (Cyberbeast). Predicts whether the Cybertruck wins.
Run:  python per_car/train_cybertruck.py   (from the ml/ directory)
Outputs ml/metrics/roc_cybertruck.png and updates model_metrics.json."""

from common import run_for_car

if __name__ == "__main__":
    run_for_car("cybertruck-cyberbeast", "Cybertruck")
