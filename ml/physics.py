"""
SimZoner physics - Python mirror of backend/src/physics.ts. ENGINE_VERSION "v2".

This MUST stay numerically identical to the TypeScript engine, or the model trains on
a simulator that the edge no longer runs (SYSTEM_DESIGN section 6 pins engine_version).
The constants and formulas below are copied deliberately; a parity check cross-checks one
race against the TS output (finish times must agree to ~1e-6).

v2 rebalance (docs/research/balance-and-ml.md section 1.3). v1 let every car reach the
hard speed cap on every segment, so mass/CdA/power never mattered and risk decided the
race. v2 adds mechanics where the specs actually bite:
  - stop-and-go re-acceleration surges (mass + power-to-weight decide recovery)
  - risk-linked driver-error time penalties (aggression costs time)
  - per-segment incidents (irreducible noise, invisible to the ML features)
  - per-race weather (rho scales drag so CdA bites; mu cuts the launch; density worsens
    congestion)
  - risk speed multiplier shrunk from 0.9+0.1*risk to 0.97+0.03*risk (one lever, not the
    only one).

Determinism: same (seed, inputs) -> identical result. Weather is drawn from a seed-derived
substream; per-car incident/error draws come from each car's own substream. No wall clock,
no unseeded randomness. Draw order is identical to physics.ts.
"""

import math

ENGINE_VERSION = "v2"

# -- Constants (SHARED with backend/src/physics.ts) -------------------------------
RHO = 1.225
G = 9.81
CRR = 0.01
ETA = 0.9
MU = 0.9
DT = 0.5
MPH_TO_MS = 0.44704
SPEED_CAP_OVER_MPH = 10
V_MIN = 1.0

# -- v2 rebalance constants (SHARED with physics.ts) ------------------------------
STOPGO_PER_KM = 1.1   # slowdown events per km at density = 1.0
DECEL_DEPTH = 0.8     # each event drops speed to cap * (1 - DECEL_DEPTH * density)
ERR_BASE = 0.02       # p(driver error)/segment = ERR_BASE + ERR_SLOPE * risk
ERR_SLOPE = 0.20      # tuned up from the report's 0.13 base so the Cybertruck lands <55%
ERR_COST_MIN = 6.0    # driver-error time cost ~ uniform(6, 26) s
ERR_COST_MAX = 26.0
INC_P = 0.06          # p(incident)/segment (independent per car)
INC_COST_MIN = 15.0   # incident time cost ~ uniform(15, 50) s
INC_COST_MAX = 50.0


# -- Seeded PRNG with per-car substreams (mirror of xmur3 + mulberry32) -----------
def _xmur3(s: str):
    h = (1779033703 ^ len(s)) & 0xFFFFFFFF
    for ch in s:
        h = (h ^ ord(ch)) & 0xFFFFFFFF
        h = (h * 3432918353) & 0xFFFFFFFF
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF
    h = (h ^ (h >> 16)) & 0xFFFFFFFF
    h = (h * 2246822507) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 3266489909) & 0xFFFFFFFF
    h = (h ^ (h >> 16)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


def _substream(seed: int, car_id: str):
    # Exact JS mulberry32 reproduction over an xmur3-hashed (seed, car_id) seed.
    state = _xmur3(f"{seed}:{car_id}")

    def imul(a, b):
        a &= 0xFFFFFFFF
        b &= 0xFFFFFFFF
        return ((a * b) & 0xFFFFFFFF)

    def rng():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = imul(t ^ (t >> 15), 1 | t)
        t = (((imul(t ^ (t >> 7), 61 | t) + t) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


# -- Per-race weather (one draw per race, from a seed-derived substream) ----------
# clear 60% : rho_mul 1.00, mu_mul 1.00, density_add 0.00
# rain  30% : rho_mul 1.02, mu_mul 0.80, density_add 0.10
# heavy 10% : rho_mul 1.03, mu_mul 0.65, density_add 0.20
def _draw_weather(seed: int):
    r = _substream(seed, "__race__")()
    if r < 0.60:
        return {"code": "clear", "rho_mul": 1.00, "mu_mul": 1.00, "density_add": 0.00}
    if r < 0.90:
        return {"code": "rain", "rho_mul": 1.02, "mu_mul": 0.80, "density_add": 0.10}
    return {"code": "heavy", "rho_mul": 1.03, "mu_mul": 0.65, "density_add": 0.20}


def _effective_cap(seg, hov_eligible, risk):
    hard = (seg["speed_limit_mph"] + SPEED_CAP_OVER_MPH) * MPH_TO_MS
    has_hov = hov_eligible and seg["hov_lanes"] > 0
    congestion = seg["traffic_density"] * (0.3 if has_hov else 1.0)
    traffic_cap = hard * (1 - 0.45 * congestion)
    return traffic_cap * (0.97 + 0.03 * risk)


def _simulate_segment(entry_v, seg, veh, hov_eligible, risk, weather):
    cap = _effective_cap(seg, hov_eligible, risk)
    dist = seg["length_km"] * 1000

    # Per-segment constants (precomputed once; identical float grouping to per-step form).
    theta = math.atan(seg["grade_pct"] / 100)
    drag_coef = 0.5 * RHO * weather["rho_mul"] * veh["cda_m2"]
    roll_force = CRR * veh["mass_kg"] * G * math.cos(theta)
    grade_force = veh["mass_kg"] * G * math.sin(theta)
    power_num = veh["power_kw"] * 1000 * ETA
    adhesion = MU * weather["mu_mul"] * veh["mass_kg"] * G

    # Stop-and-go: n surges scale with congestion (traffic + weather) and segment length.
    density = min(1.0, max(0.0, seg["traffic_density"] + weather["density_add"]))
    n_surges = int(math.floor(STOPGO_PER_KM * density * seg["length_km"] + 0.5))
    v_low = cap * (1 - DECEL_DEPTH * density)
    surge_at = [dist * (i + 1) / (n_surges + 1) for i in range(n_surges)]

    v = min(entry_v, cap)
    x = 0.0
    t = 0.0
    next_surge = 0
    guard = math.ceil(dist / (V_MIN * DT)) + 1000
    steps = 0
    while x < dist and steps < guard:
        steps += 1
        # Trigger any stop-and-go slowdowns we have reached; the integrator re-accelerates.
        while next_surge < n_surges and x >= surge_at[next_surge]:
            v = min(v, v_low)
            next_surge += 1
        power_limited = power_num / max(v, V_MIN)
        tractive = min(power_limited, adhesion)
        resistive = drag_coef * v * v + roll_force + grade_force
        a = (tractive - resistive) / veh["mass_kg"]
        if v >= cap:
            a = min(a, 0.0)
            v = cap
        v = max(V_MIN, min(cap, v + a * DT))
        x += v * DT
        t += DT
    return t, v


def simulate_race(entrants, route, seed):
    """entrants: list of dicts {vehicle, hov_eligible, risk}. Returns sorted finishes."""
    weather = _draw_weather(seed)
    finishes = []
    for e in entrants:
        rng = _substream(seed, e["vehicle"]["id"])
        v = 0.0
        total = 0.0
        dist = 0.0
        for seg in route:
            jitter = 1 + (rng() - 0.5) * 0.06
            t, v = _simulate_segment(v, seg, e["vehicle"], e["hov_eligible"], e["risk"], weather)
            total += t * jitter
            # Per-segment incident (independent per car) - irreducible, invisible to features.
            p_inc = rng()
            cost_inc = INC_COST_MIN + rng() * (INC_COST_MAX - INC_COST_MIN)
            if p_inc < INC_P:
                total += cost_inc
            # Risk-linked driver error - aggression buys speed and pays it back in time.
            p_err = rng()
            cost_err = ERR_COST_MIN + rng() * (ERR_COST_MAX - ERR_COST_MIN)
            if p_err < ERR_BASE + ERR_SLOPE * e["risk"]:
                total += cost_err
            dist += seg["length_km"] * 1000
        finishes.append({"vehicle_id": e["vehicle"]["id"], "time_s": total, "avg_speed_ms": dist / total})
    finishes.sort(key=lambda f: f["time_s"])
    return {"engine_version": ENGINE_VERSION, "seed": seed, "weather": weather, "finishes": finishes}
