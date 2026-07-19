/**
 * SimZoner physics - deterministic road-load race model. ENGINE_VERSION "v2".
 *
 * Design (docs/VEHICLE_SPECS.md section 6, SIMULATION_RULES.md):
 *   F_resist(v,theta) = 0.5*rho*CdA*v^2  +  Crr*m*g*cos theta  +  m*g*sin theta
 *   Tractive force is power-limited (P*eta / v) and adhesion-limited (mu*m*g).
 *   Speed is HARD-capped at limit + 10 mph (SIMULATION_RULES section 2).
 *
 * v2 rebalance (docs/research/balance-and-ml.md section 1.3). v1 let every car reach the
 * hard cap on every segment, so mass/CdA/power never mattered and risk decided the race.
 * v2 adds the mechanics where the specs bite:
 *   - stop-and-go re-acceleration surges (mass + power-to-weight decide recovery)
 *   - risk-linked driver-error time penalties (aggression costs time)
 *   - per-segment incidents (irreducible noise, invisible to the ML features)
 *   - per-race weather (rho scales drag so CdA bites; mu cuts the launch; density worsens
 *     congestion)
 *   - risk speed multiplier shrunk from 0.9+0.1*risk to 0.97+0.03*risk.
 *
 * MUST stay numerically identical to ml/physics.py (same ENGINE_VERSION), or the learned
 * model describes a simulator that no longer exists. Constants are duplicated in both files
 * on purpose and cross-checked (finish times agree to ~1e-6). Determinism: same (seed,
 * inputs) -> identical result; the LLM is never in this loop (SYSTEM_DESIGN section 5).
 */

export const ENGINE_VERSION = "v2";

// -- Physical constants (SHARED with ml/physics.py - keep in lockstep) ------------
const RHO = 1.225; // air density kg/m^3 at sea level
const G = 9.81; // gravity m/s^2
const CRR = 0.01; // rolling resistance (a documented modeling choice)
const ETA = 0.9; // drivetrain efficiency
const MU = 0.9; // tyre adhesion coefficient for the low-speed tractive cap
const DT = 0.5; // integration time step (s)
const MPH_TO_MS = 0.44704;
const SPEED_CAP_OVER_MPH = 10; // SIMULATION_RULES section 2: max 10 mph over the limit
const V_MIN = 1.0; // floor for the P/v tractive term (avoids div-by-zero at launch)

// -- v2 rebalance constants (SHARED with ml/physics.py) ---------------------------
const STOPGO_PER_KM = 1.1; // slowdown events per km at density = 1.0
const DECEL_DEPTH = 0.8; // each event drops speed to cap * (1 - DECEL_DEPTH * density)
const ERR_BASE = 0.02; // p(driver error)/segment = ERR_BASE + ERR_SLOPE * risk
const ERR_SLOPE = 0.2; // tuned up from the report's 0.13 base so the Cybertruck lands <55%
const ERR_COST_MIN = 6.0; // driver-error time cost ~ uniform(6, 26) s
const ERR_COST_MAX = 26.0;
const INC_P = 0.06; // p(incident)/segment (independent per car)
const INC_COST_MIN = 15.0; // incident time cost ~ uniform(15, 50) s
const INC_COST_MAX = 50.0;

export interface Vehicle {
  id: string;
  mass_kg: number;
  cda_m2: number; // Cd x A - the value that enters drag (VEHICLE_SPECS section 6)
  power_kw: number;
}

export interface Segment {
  seq: number;
  length_km: number;
  hov_lanes: number;
  speed_limit_mph: number;
  grade_pct: number;
  traffic_density: number; // 0..1
}

export interface Entrant {
  vehicle: Vehicle;
  hov_eligible: boolean;
  risk: number; // persona 0..1: how close to the cap the driver runs
}

export interface Weather {
  code: string;
  rho_mul: number;
  mu_mul: number;
  density_add: number;
}

export interface RaceResult {
  engine_version: string;
  seed: number;
  weather: Weather;
  finishes: { vehicle_id: string; time_s: number; avg_speed_ms: number }[];
}

// -- Seeded PRNG with per-car substreams ------------------------------------------
// Each car derives an INDEPENDENT stream from hash(seed, id) so same-seed comparisons
// stay valid (SYSTEM_DESIGN section 2.4).
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function substream(seed: number, carId: string): () => number {
  const s = xmur3(`${seed}:${carId}`)();
  return mulberry32(s);
}

// -- Per-race weather (one draw per race, from a seed-derived substream) -----------
// clear 60% : rho_mul 1.00, mu_mul 1.00, density_add 0.00
// rain  30% : rho_mul 1.02, mu_mul 0.80, density_add 0.10
// heavy 10% : rho_mul 1.03, mu_mul 0.65, density_add 0.20
function drawWeather(seed: number): Weather {
  const r = substream(seed, "__race__")();
  if (r < 0.6) return { code: "clear", rho_mul: 1.0, mu_mul: 1.0, density_add: 0.0 };
  if (r < 0.9) return { code: "rain", rho_mul: 1.02, mu_mul: 0.8, density_add: 0.1 };
  return { code: "heavy", rho_mul: 1.03, mu_mul: 0.65, density_add: 0.2 };
}

// Effective speed cap for a segment: the +10 rule, cut by traffic. HOV-eligible cars on a
// segment that still has HOV lanes see less congestion. Persona risk sets how close to the
// resulting cap the driver runs (v2: a 3-point span, not 10 - one lever among several).
function effectiveCap(seg: Segment, e: Entrant): number {
  const hardCap = (seg.speed_limit_mph + SPEED_CAP_OVER_MPH) * MPH_TO_MS;
  const hasHovAccess = e.hov_eligible && seg.hov_lanes > 0;
  const congestion = hasHovAccess ? seg.traffic_density * 0.3 : seg.traffic_density;
  const trafficCap = hardCap * (1 - 0.45 * congestion);
  const risk = 0.97 + 0.03 * e.risk; // 0.970-1.000 of the attainable cap
  return trafficCap * risk;
}

// Integrate one segment with stop-and-go slowdowns: accelerate toward the cap, get knocked
// back to v_low at each surge, re-accelerate (where power/mass/CdA/weather decide). Weather
// scales drag (rho) and the adhesion-limited launch (mu). Returns time (s) and exit speed.
function simulateSegment(entry_v: number, seg: Segment, e: Entrant, w: Weather): { time: number; exit_v: number } {
  const cap = effectiveCap(seg, e);
  const dist = seg.length_km * 1000;

  // Per-segment constants (precomputed once; identical float grouping to per-step form).
  const theta = Math.atan(seg.grade_pct / 100);
  const dragCoef = 0.5 * RHO * w.rho_mul * e.vehicle.cda_m2;
  const rollForce = CRR * e.vehicle.mass_kg * G * Math.cos(theta);
  const gradeForce = e.vehicle.mass_kg * G * Math.sin(theta);
  const powerNum = e.vehicle.power_kw * 1000 * ETA;
  const adhesion = MU * w.mu_mul * e.vehicle.mass_kg * G;

  // Stop-and-go: n surges scale with congestion (traffic + weather) and segment length.
  const density = Math.min(1.0, Math.max(0.0, seg.traffic_density + w.density_add));
  const nSurges = Math.floor(STOPGO_PER_KM * density * seg.length_km + 0.5);
  const vLow = cap * (1 - DECEL_DEPTH * density);
  const surgeAt: number[] = [];
  for (let i = 0; i < nSurges; i++) surgeAt.push((dist * (i + 1)) / (nSurges + 1));

  let v = Math.min(entry_v, cap);
  let x = 0;
  let t = 0;
  let nextSurge = 0;
  const guard = Math.ceil(dist / (V_MIN * DT)) + 1000;
  let steps = 0;
  while (x < dist && steps++ < guard) {
    // Trigger any stop-and-go slowdowns we have reached; the integrator re-accelerates.
    while (nextSurge < nSurges && x >= surgeAt[nextSurge]) {
      v = Math.min(v, vLow);
      nextSurge++;
    }
    const powerLimited = powerNum / Math.max(v, V_MIN);
    const tractive = Math.min(powerLimited, adhesion);
    const resistive = dragCoef * v * v + rollForce + gradeForce;
    let a = (tractive - resistive) / e.vehicle.mass_kg;
    if (v >= cap) {
      a = Math.min(a, 0);
      v = cap;
    }
    v = Math.max(V_MIN, Math.min(cap, v + a * DT));
    x += v * DT;
    t += DT;
  }
  return { time: t, exit_v: v };
}

export function simulateRace(entrants: Entrant[], route: Segment[], seed: number): RaceResult {
  const weather = drawWeather(seed);
  const finishes = entrants.map((e) => {
    const rng = substream(seed, e.vehicle.id);
    let v = 0;
    let total = 0;
    let dist = 0;
    for (const seg of route) {
      // Small seeded per-car launch/traffic jitter (+/-3%), independent per car.
      const jitter = 1 + (rng() - 0.5) * 0.06;
      const r = simulateSegment(v, seg, e, weather);
      total += r.time * jitter;
      v = r.exit_v;
      // Per-segment incident (independent per car) - irreducible, invisible to features.
      const pInc = rng();
      const costInc = INC_COST_MIN + rng() * (INC_COST_MAX - INC_COST_MIN);
      if (pInc < INC_P) total += costInc;
      // Risk-linked driver error - aggression buys speed and pays it back in time.
      const pErr = rng();
      const costErr = ERR_COST_MIN + rng() * (ERR_COST_MAX - ERR_COST_MIN);
      if (pErr < ERR_BASE + ERR_SLOPE * e.risk) total += costErr;
      dist += seg.length_km * 1000;
    }
    return { vehicle_id: e.vehicle.id, time_s: total, avg_speed_ms: dist / total };
  });
  finishes.sort((a, b) => a.time_s - b.time_s);
  return { engine_version: ENGINE_VERSION, seed, weather, finishes };
}
