/**
 * SimZoner physics — deterministic road-load race model. ENGINE_VERSION "v1".
 *
 * Design (docs/VEHICLE_SPECS.md §6, SIMULATION_RULES.md):
 *   F_resist(v,θ) = 0.5·ρ·CdA·v²  +  Crr·m·g·cos θ  +  m·g·sin θ
 *   Tractive force is power-limited (P·η / v) and adhesion-limited (μ·m·g).
 *   Speed is HARD-capped at limit + 10 mph (SIMULATION_RULES §2) — so top speed is
 *   neutralized and the race is decided by: sustaining the cap against drag on grades,
 *   accelerating out of congestion (power/mass), and lane access (HOV).
 *
 * MUST stay numerically identical to ml/physics.py (same ENGINE_VERSION), or the
 * learned model describes a simulator that no longer exists. Constants are duplicated
 * in both files on purpose and cross-checked. Determinism: same (seed, inputs) →
 * identical result; the LLM is never in this loop (SYSTEM_DESIGN §5).
 */

export const ENGINE_VERSION = "v1";

// ── Physical constants (SHARED with ml/physics.py — keep in lockstep) ────────────
const RHO = 1.225; // air density kg/m³ at sea level (routes are low-elevation; ARCHITECTURE §10 notes ρ varies)
const G = 9.81; // gravity m/s²
const CRR = 0.01; // rolling resistance — UNPUBLISHED for all three; a documented modeling choice
const ETA = 0.9; // drivetrain efficiency (unpublished; standard assumption, VEHICLE_SPECS §8)
const MU = 0.9; // tyre adhesion coefficient for the low-speed tractive cap
const DT = 0.5; // integration time step (s)
const MPH_TO_MS = 0.44704;
const SPEED_CAP_OVER_MPH = 10; // SIMULATION_RULES §2: max 10 mph over the limit
const V_MIN = 1.0; // floor for the P/v tractive term (avoids div-by-zero at launch)

export interface Vehicle {
  id: string;
  mass_kg: number;
  cda_m2: number; // Cd × A — the value that enters drag (VEHICLE_SPECS §6)
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

export interface RaceResult {
  engine_version: string;
  seed: number;
  finishes: { vehicle_id: string; time_s: number; avg_speed_ms: number }[];
}

// ── Seeded PRNG with per-car substreams ──────────────────────────────────────────
// The trap (SYSTEM_DESIGN §2.4): one global PRNG makes car 3's noise depend on how
// many draws cars 1-2 made, silently coupling them. Each car derives an INDEPENDENT
// stream from hash(seed, id) so same-seed comparisons stay valid.
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

// ── Forces ───────────────────────────────────────────────────────────────────────
function resistiveForce(v: number, gradePct: number, veh: Vehicle): number {
  const theta = Math.atan(gradePct / 100);
  const drag = 0.5 * RHO * veh.cda_m2 * v * v;
  const roll = CRR * veh.mass_kg * G * Math.cos(theta);
  const grade = veh.mass_kg * G * Math.sin(theta);
  return drag + roll + grade;
}

function tractiveForce(v: number, veh: Vehicle): number {
  const powerLimited = (veh.power_kw * 1000 * ETA) / Math.max(v, V_MIN);
  const adhesionLimited = MU * veh.mass_kg * G;
  return Math.min(powerLimited, adhesionLimited);
}

// Effective speed cap for a segment: the +10 rule, cut by traffic. HOV-eligible cars
// on a segment that still has HOV lanes see less congestion. Persona risk sets how
// close to the resulting cap the driver actually runs.
function effectiveCap(seg: Segment, e: Entrant): number {
  const hardCap = (seg.speed_limit_mph + SPEED_CAP_OVER_MPH) * MPH_TO_MS;
  const hasHovAccess = e.hov_eligible && seg.hov_lanes > 0;
  const congestion = hasHovAccess ? seg.traffic_density * 0.3 : seg.traffic_density;
  const trafficCap = hardCap * (1 - 0.45 * congestion);
  const risk = 0.9 + 0.1 * e.risk; // 0.90–1.00 of the attainable cap
  return trafficCap * risk;
}

// Integrate one segment: accelerate toward the cap, then cruise. Returns time (s)
// and exit speed. If the car can't sustain the cap up a grade, it settles where
// tractive = resistive — that's where drag/power/mass actually decide the race.
function simulateSegment(entry_v: number, seg: Segment, e: Entrant): { time: number; exit_v: number } {
  const cap = effectiveCap(seg, e);
  const dist = seg.length_km * 1000;
  let v = Math.min(entry_v, cap);
  let x = 0;
  let t = 0;
  const guard = Math.ceil((dist / Math.max(v, V_MIN)) * 4) + 1000; // step ceiling
  let steps = 0;
  while (x < dist && steps++ < guard) {
    const net = tractiveForce(v, e.vehicle) - resistiveForce(v, seg.grade_pct, e.vehicle);
    let a = net / e.vehicle.mass_kg;
    // Approach the cap without overshooting it (the +10 rule is hard).
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
  const finishes = entrants.map((e) => {
    const rng = substream(seed, e.vehicle.id);
    let v = 0;
    let total = 0;
    let dist = 0;
    for (const seg of route) {
      // Small seeded per-car launch/traffic jitter (±3%), independent per car.
      const jitter = 1 + (rng() - 0.5) * 0.06;
      const r = simulateSegment(v, seg, e);
      total += r.time * jitter;
      v = r.exit_v;
      dist += seg.length_km * 1000;
    }
    return { vehicle_id: e.vehicle.id, time_s: total, avg_speed_ms: dist / total };
  });
  finishes.sort((a, b) => a.time_s - b.time_s);
  return { engine_version: ENGINE_VERSION, seed, finishes };
}
