"""
SimZoner physics — Python mirror of backend/src/physics.ts. ENGINE_VERSION "v1".

This MUST stay numerically identical to the TypeScript engine, or the model trains on
a simulator that the edge no longer runs (SYSTEM_DESIGN §6 pins engine_version). The
constants and formulas below are copied deliberately; test_parity() cross-checks one
race against the known TS output.
"""

import math

ENGINE_VERSION = "v1"

# ── Constants (SHARED with backend/src/physics.ts) ───────────────────────────────
RHO = 1.225
G = 9.81
CRR = 0.01
ETA = 0.9
MU = 0.9
DT = 0.5
MPH_TO_MS = 0.44704
SPEED_CAP_OVER_MPH = 10
V_MIN = 1.0


# ── Seeded PRNG with per-car substreams (mirror of xmur3 + mulberry32) ────────────
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
    # JS: t=(a+0x6D2B79F5)|0; t=Math.imul(t^t>>>15,1|t);
    #     t=(t+Math.imul(t^t>>>7,61|t))^t; return ((t^t>>>14)>>>0)/2**32
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
        # JS precedence: t = (t + Math.imul(t ^ t>>>7, 61|t)) ^ t  — the trailing ^ t matters.
        t = (((imul(t ^ (t >> 7), 61 | t) + t) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def _resistive(v, grade_pct, veh):
    theta = math.atan(grade_pct / 100)
    drag = 0.5 * RHO * veh["cda_m2"] * v * v
    roll = CRR * veh["mass_kg"] * G * math.cos(theta)
    grade = veh["mass_kg"] * G * math.sin(theta)
    return drag + roll + grade


def _tractive(v, veh):
    power_limited = (veh["power_kw"] * 1000 * ETA) / max(v, V_MIN)
    adhesion_limited = MU * veh["mass_kg"] * G
    return min(power_limited, adhesion_limited)


def _effective_cap(seg, hov_eligible, risk):
    hard = (seg["speed_limit_mph"] + SPEED_CAP_OVER_MPH) * MPH_TO_MS
    has_hov = hov_eligible and seg["hov_lanes"] > 0
    congestion = seg["traffic_density"] * (0.3 if has_hov else 1.0)
    traffic_cap = hard * (1 - 0.45 * congestion)
    return traffic_cap * (0.9 + 0.1 * risk)


def _simulate_segment(entry_v, seg, veh, hov_eligible, risk):
    cap = _effective_cap(seg, hov_eligible, risk)
    dist = seg["length_km"] * 1000
    v = min(entry_v, cap)
    x = 0.0
    t = 0.0
    guard = math.ceil((dist / max(v, V_MIN)) * 4) + 1000
    steps = 0
    while x < dist and steps < guard:
        steps += 1
        net = _tractive(v, veh) - _resistive(v, seg["grade_pct"], veh)
        a = net / veh["mass_kg"]
        if v >= cap:
            a = min(a, 0.0)
            v = cap
        v = max(V_MIN, min(cap, v + a * DT))
        x += v * DT
        t += DT
    return t, v


def simulate_race(entrants, route, seed):
    """entrants: list of dicts {vehicle, hov_eligible, risk}. Returns sorted finishes."""
    finishes = []
    for e in entrants:
        rng = _substream(seed, e["vehicle"]["id"])
        v = 0.0
        total = 0.0
        dist = 0.0
        for seg in route:
            jitter = 1 + (rng() - 0.5) * 0.06
            t, v = _simulate_segment(v, seg, e["vehicle"], e["hov_eligible"], e["risk"])
            total += t * jitter
            dist += seg["length_km"] * 1000
        finishes.append({"vehicle_id": e["vehicle"]["id"], "time_s": total, "avg_speed_ms": dist / total})
    finishes.sort(key=lambda f: f["time_s"])
    return {"engine_version": ENGINE_VERSION, "seed": seed, "finishes": finishes}
