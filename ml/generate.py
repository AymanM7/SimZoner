"""
Generate a synthetic race dataset from the physics engine (ml/physics.py).

Honest framing (docs/ML_APPROACH.md §1.3): these races come from OUR simulator, so a
model trained here measures agreement with our physics, not real vehicles. The point of
the NOISE is to make the task non-trivial — a noiseless sim is 100% predictable and
learning it is pointless. Two noise sources:
  - per-car ±3% segment jitter (seeded, inside physics.py) → close races become coin-flips
  - per-race traffic multiplier (here) → varies congestion the features don't see (irreducible)

Output: one row per unordered car-pair per race. Features are A-minus-B differences;
label = 1 if A finished ahead of B. Feature contract matches cloud-compute/src/entry.py.
"""

import copy
import json
import itertools

import numpy as np
import pandas as pd

PERSONA_RISK = {"cybertruck-cyberbeast": 0.9, "bmw-m5-g90": 0.8, "waymo-ipace": 0.4}
FEATURES = ["mass_diff_kg", "cda_diff_m2", "power_diff_kw", "hov_eligible_diff", "risk_diff"]
N_RACES = 6000
DATA_SEED = 42


def load_fixtures():
    fx = json.load(open("data/fixtures.json"))
    return {v["id"]: v for v in fx["vehicles"]}, fx["routes"]


def jitter_traffic(route, rng):
    """Per-race congestion noise the model cannot see — the irreducible term."""
    out = copy.deepcopy(route)
    for seg in out:
        f = float(np.clip(rng.normal(1.0, 0.25), 0.4, 1.6))
        seg["traffic_density"] = float(np.clip(seg["traffic_density"] * f, 0.0, 1.0))
    return out


def build_rows(vehicles, routes):
    from physics import simulate_race

    rng = np.random.default_rng(DATA_SEED)
    car_ids = list(vehicles.keys())
    route_ids = list(routes.keys())
    rows = []

    for race_i in range(N_RACES):
        route_id = route_ids[rng.integers(len(route_ids))]
        route = jitter_traffic(routes[route_id], rng)
        seed = int(rng.integers(1, 2**31))

        k = int(rng.integers(2, len(car_ids) + 1))  # 2 or 3 cars
        chosen = list(rng.choice(car_ids, size=k, replace=False))
        occ = {c: int(rng.integers(1, 3)) for c in chosen}  # 1 or 2 occupants

        entrants = [
            {"vehicle": vehicles[c], "hov_eligible": occ[c] >= 2, "risk": PERSONA_RISK[c]}
            for c in chosen
        ]
        result = simulate_race(entrants, route, seed)
        finish_time = {f["vehicle_id"]: f["time_s"] for f in result["finishes"]}

        for a, b in itertools.combinations(chosen, 2):
            # Randomize orientation so the label is balanced, not always "faster car = A".
            if rng.random() < 0.5:
                a, b = b, a
            va, vb = vehicles[a], vehicles[b]
            rows.append(
                {
                    "race_id": race_i,
                    "route_id": route_id,
                    "car_a": a,
                    "car_b": b,
                    "mass_diff_kg": va["mass_kg"] - vb["mass_kg"],
                    "cda_diff_m2": va["cda_m2"] - vb["cda_m2"],
                    "power_diff_kw": va["power_kw"] - vb["power_kw"],
                    "hov_eligible_diff": (occ[a] >= 2) - (occ[b] >= 2),
                    "risk_diff": PERSONA_RISK[a] - PERSONA_RISK[b],
                    "a_beats_b": int(finish_time[a] < finish_time[b]),
                }
            )
    return pd.DataFrame(rows)


if __name__ == "__main__":
    vehicles, routes = load_fixtures()
    df = build_rows(vehicles, routes)
    df.to_parquet("data/races.parquet", index=False)
    base_rate = df["a_beats_b"].mean()
    print(f"wrote data/races.parquet: {len(df)} rows from {N_RACES} races")
    print(f"label balance P(a_beats_b) = {base_rate:.3f}  (near 0.5 = well-oriented)")
    print("features:", FEATURES)
