"""
Generate a synthetic race dataset from the physics engine (ml/physics.py), ENGINE v2.

Honest framing (docs/ML_APPROACH.md section 1.3): these races come from OUR simulator, so a
model trained here measures agreement with our physics, not real vehicles. The point of the
NOISE is to make the task non-trivial. Noise sources in v2:
  - per-car +/-3% segment jitter (seeded, inside physics.py)
  - per-race traffic multiplier (here)  -> congestion the features don't see
  - per-race WEATHER (physics.py)        -> rho/mu/density; features see it via interactions
  - per-segment INCIDENTS (physics.py)   -> KEPT OUT of the features on purpose: this is the
                                            irreducible term that caps accuracy below 1.0
  - risk-linked driver ERRORS (physics.py) -> aggression's cost; flows into the label

Output: one row per unordered car-pair per race, tagged with race_id so training can GROUP by
race and stop the cross-race leak (docs/research/balance-and-ml.md section 2.1). Features are
A-minus-B differences (antisymmetric, so per-car orientation flips cleanly). Weather enters as
two antisymmetric interactions (a shared scalar times a spec diff) so it survives the diff and
the label stays predictable. Feature contract matches cloud-compute/src/entry.py.
"""

import copy
import json
import itertools
import os

import numpy as np
import pandas as pd

PERSONA_RISK = {"cybertruck-cyberbeast": 0.9, "bmw-m5-g90": 0.8, "waymo-ipace": 0.4}

# Antisymmetric feature contract. Weather is folded into cda_rho_diff / mass_mu_diff:
#   cda_rho_diff = cda_diff  * (rho_mul - 1)   -> in denser (bad-weather) air the high-CdA car
#                                                 is penalized more; 0 in clear weather.
#   mass_mu_diff = mass_diff * (1 - mu_mul)    -> low grip hurts the heavier car's launch more;
#                                                 0 in clear weather.
# Both flip sign when A<->B swap, so per_car orientation-flip stays valid. Incidents are
# deliberately absent (irreducible noise -> accuracy ceiling below 1.0).
FEATURES = [
    "mass_diff_kg",
    "cda_diff_m2",
    "power_diff_kw",
    "hov_eligible_diff",
    "risk_diff",
    "cda_rho_diff",
    "mass_mu_diff",
]
N_RACES = 16000
DATA_SEED = 42

HERE = os.path.dirname(os.path.abspath(__file__))


def load_fixtures():
    with open(os.path.join(HERE, "data", "fixtures.json")) as f:
        fx = json.load(f)
    return {v["id"]: v for v in fx["vehicles"]}, fx["routes"]


def jitter_traffic(route, rng):
    """Per-race congestion noise the model cannot see - part of the irreducible term."""
    out = copy.deepcopy(route)
    for seg in out:
        f = float(np.clip(rng.normal(1.0, 0.25), 0.4, 1.6))
        seg["traffic_density"] = float(np.clip(seg["traffic_density"] * f, 0.0, 1.0))
    return out


def _hov_eligible(car_id, occupancy):
    # Waymo adopts SIMULATION_RULES AV_POLICY (B) "transit-equivalent": HOV-eligible whenever a
    # segment has HOV lanes, regardless of occupancy. Others need occupancy >= 2.
    if car_id == "waymo-ipace":
        return True
    return occupancy >= 2


def build_rows(vehicles, routes, data_seed=DATA_SEED, n_races=N_RACES):
    from physics import simulate_race

    rng = np.random.default_rng(data_seed)
    car_ids = list(vehicles.keys())
    route_ids = list(routes.keys())
    rows = []

    for race_i in range(n_races):
        route_id = route_ids[rng.integers(len(route_ids))]
        route = jitter_traffic(routes[route_id], rng)
        seed = int(rng.integers(1, 2**31))

        k = int(rng.integers(2, len(car_ids) + 1))  # 2 or 3 cars
        chosen = list(rng.choice(car_ids, size=k, replace=False))
        occ = {c: int(rng.integers(1, 4)) for c in chosen}  # 1..3 occupants (widened)
        hov = {c: _hov_eligible(c, occ[c]) for c in chosen}

        entrants = [
            {"vehicle": vehicles[c], "hov_eligible": hov[c], "risk": PERSONA_RISK[c]}
            for c in chosen
        ]
        result = simulate_race(entrants, route, seed)
        w = result["weather"]
        finish_time = {f["vehicle_id"]: f["time_s"] for f in result["finishes"]}

        for a, b in itertools.combinations(chosen, 2):
            # Randomize orientation so the label is balanced, not always "faster car = A".
            if rng.random() < 0.5:
                a, b = b, a
            va, vb = vehicles[a], vehicles[b]
            mass_diff = va["mass_kg"] - vb["mass_kg"]
            cda_diff = va["cda_m2"] - vb["cda_m2"]
            rows.append(
                {
                    "race_id": race_i,
                    "route_id": route_id,
                    "weather": w["code"],
                    "car_a": a,
                    "car_b": b,
                    "mass_diff_kg": mass_diff,
                    "cda_diff_m2": cda_diff,
                    "power_diff_kw": va["power_kw"] - vb["power_kw"],
                    "hov_eligible_diff": int(hov[a]) - int(hov[b]),
                    "risk_diff": PERSONA_RISK[a] - PERSONA_RISK[b],
                    "cda_rho_diff": cda_diff * (w["rho_mul"] - 1.0),
                    "mass_mu_diff": mass_diff * (1.0 - w["mu_mul"]),
                    "a_beats_b": int(finish_time[a] < finish_time[b]),
                }
            )
    return pd.DataFrame(rows)


if __name__ == "__main__":
    vehicles, routes = load_fixtures()
    df = build_rows(vehicles, routes)
    out_path = os.path.join(HERE, "data", "races.parquet")
    df.to_parquet(out_path, index=False)
    base_rate = df["a_beats_b"].mean()
    print(f"wrote {out_path}: {len(df)} rows from {N_RACES} races (engine v2, DATA_SEED={DATA_SEED})")
    print(f"label balance P(a_beats_b) = {base_rate:.3f}  (near 0.5 = well-oriented)")
    print(f"weather mix: {df['weather'].value_counts(normalize=True).round(3).to_dict()}")
    print("features:", FEATURES)
