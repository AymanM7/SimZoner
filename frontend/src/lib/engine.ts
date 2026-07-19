// Physics-lite advancement along a real corridor. Deterministic given the seed; the
// LLM/ML never runs in this loop and there is NO Math.random in the tick path -- every
// random draw is a pure hash of (seed, carId, kind, segment), so a race is fully
// reproducible from its seed. v2 rebalance: specs bite via stop-and-go re-acceleration
// (power-to-weight + mass), a grade penalty, per-race weather, risk-linked driver
// errors, per-segment incidents, and occupancy/AV-driven HOV. See
// docs/research/balance-and-ml.md sections 1.3 / 1.5.

import { posAt, routeGeom } from "./geo";
import { vehicleById } from "./vehicles";
import type { Corridor, VehicleState, WeatherKind } from "./types";

const MPH = 0.44704;
export const TIME_SCALE = 40; // 1 real sec ~= 40 sim sec

// --- Speed model tuning (aligned with the authoritative engine) --------------------
const OVER_CAP_MPH = 10; // drivers run up to 10 over the posted limit
const TRAFFIC_BASE = 0.05; // free-flow baseline load on open road
const BOTTLENECK_LOAD = 0.3; // how much bottleneck severity adds to traffic
const INCIDENT_LOAD = 0.6; // extra load when near an active injected incident
const CONGESTION_DRAG = 0.45; // fraction of speed removed at full congestion
const HOV_RELIEF = 0.3; // congestion multiplier for HOV-eligible vehicles

// --- v2 rebalance levers (validated by an 8000-race tuning sweep) ------------------
// Stop-and-go re-acceleration: heavy / low-power / high-drag cars lose time surging
// back to speed after congestion. Applied as a small speed deficit that scales with
// congestion, so it bites hardest in urban cores and on grades / in bad weather.
const STOPGO_K = 0.1; // overall strength of the stop-and-go deficit
const REACCEL_W = 0.15; // weight on power-to-weight (low P/W -> slower re-accel)
const GRADE_W = 8; // weight on mass x grade (heavy cars pay on climbs)
const DRAG_W = 14; // weight on Cd.A x (air-density-1) (drag bites in bad weather)
// Risk-linked driver error: aggression buys a sliver of cruise speed and pays it back
// in occasional time lost. p(error)/segment = ERR_BASE + ERR_SLOPE * risk.
const ERR_BASE = 0.02;
const ERR_SLOPE = 0.28;
const ERR_COST_MIN = 8,
  ERR_COST_SPAN = 24; // 8..32 s lost per error
// Per-segment incident: feature-invisible irreducible variance, same odds for all cars.
const INC_P = 0.06;
const INC_COST_MIN = 15,
  INC_COST_SPAN = 35; // 15..50 s lost per incident
const CRAWL_MPH = 6; // speed held while serving a stall (error/incident)
const OCC_MIN = 2; // occupancy needed for HOV when not an AV

// Per-race weather, drawn once from the seed. rho scales drag (Cd.A bites), mu cuts the
// adhesion-limited launch (slows re-accel, hits low-P/W Waymo hardest), dens worsens
// congestion (more/deeper stop-and-go).
export const WEATHER: Record<WeatherKind, { rhoMul: number; muMul: number; densAdd: number; label: string }> = {
  clear: { rhoMul: 1.0, muMul: 1.0, densAdd: 0.0, label: "Clear" },
  rain: { rhoMul: 1.02, muMul: 0.8, densAdd: 0.1, label: "Rain" },
  heavy: { rhoMul: 1.03, muMul: 0.65, densAdd: 0.2, label: "Heavy rain" },
};

// --- Deterministic hashing (seeded substreams, no Math.random) ---------------------
function h32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// A uniform [0,1) draw from an arbitrary key set -- a per-substream sample.
function unit(...parts: (string | number)[]): number {
  let h = h32(parts.join("|"));
  h = (h + 0x6d2b79f5) >>> 0;
  let t = h;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function drawWeather(seed: string | number): WeatherKind {
  const u = unit(seed, "weather");
  return u < 0.6 ? "clear" : u < 0.9 ? "rain" : "heavy";
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// Fleet-normalized spec factors (0..1). Ranges chosen to spread the three vehicles.
const pwNorm = (power: number, mass: number) => clamp((power / mass - 0.12) / (0.24 - 0.12), 0, 1);
const massNorm = (mass: number) => clamp((mass - 2000) / (3200 - 2000), 0, 1);
const cdaNorm = (cda: number) => clamp((cda - 0.6) / (1.05 - 0.6), 0, 1);

// Which section a fraction-of-route falls in.
function sectionAt(corridor: Corridor, t: number) {
  const n = corridor.sections.length;
  const idx = Math.min(n - 1, Math.floor(t * n));
  return { sec: corridor.sections[idx], idx };
}

function bottleneckLoad(corridor: Corridor, t: number) {
  const n = corridor.bottlenecks.length;
  if (!n) return 0;
  const idx = Math.min(n - 1, Math.floor(t * n));
  const b = corridor.bottlenecks[idx];
  return b ? b.severityIndex : 0;
}

export function advance(
  cars: Record<string, VehicleState>,
  corridor: Corridor,
  dtReal: number,
  incidentAt: number | null,
  seed: string | number = 0
): void {
  const geom = routeGeom(corridor.id);
  const dt = dtReal * TIME_SCALE; // sim seconds elapsed this frame (== commute seconds)

  for (const id of Object.keys(cars)) {
    const c = cars[id];
    if (c.finished) continue;
    const v = vehicleById(id);
    const W = WEATHER[c.weather];
    const { sec, idx: segIdx } = sectionAt(corridor, c.progress);
    const bl = bottleneckLoad(corridor, c.progress);
    const grade = sec.gradePct ?? 0;

    // Fire per-segment events once, on entry -- deterministic from the seeded substream.
    if (segIdx !== c.lastSeg) {
      c.lastSeg = segIdx;
      const pErr = ERR_BASE + ERR_SLOPE * v.risk;
      if (unit(seed, id, "err", segIdx) < pErr) {
        c.stallSec += ERR_COST_MIN + unit(seed, id, "errCost", segIdx) * ERR_COST_SPAN;
      }
      if (unit(seed, id, "inc", segIdx) < INC_P) {
        c.stallSec += INC_COST_MIN + unit(seed, id, "incCost", segIdx) * INC_COST_SPAN;
      }
    }

    const nearIncident = incidentAt !== null && Math.abs(c.progress - incidentAt) < 0.08;
    const traffic = Math.min(
      1,
      TRAFFIC_BASE + bl * BOTTLENECK_LOAD + W.densAdd + (nearIncident ? INCIDENT_LOAD : 0)
    );

    // Occupancy-driven HOV. Waymo (AV) is HOV-eligible whenever the segment has HOV
    // lanes (transit-equivalent policy); others need 2+ occupants (drawn per race).
    const occupancy = 1 + Math.floor(unit(seed, id, "occ") * 3); // 1..3
    const hovEligible = sec.hovLanes > 0 && (v.defaultMode === "FSD" || occupancy >= OCC_MIN);
    c.onHov = hovEligible;
    const congestion = hovEligible ? traffic * HOV_RELIEF : traffic;

    // Stop-and-go re-acceleration deficit: where mass / Cd.A / power actually bite.
    const pn = pwNorm(v.power, v.mass);
    const deficit = clamp(
      (STOPGO_K *
        congestion *
        ((1 - pn) * REACCEL_W + massNorm(v.mass) * grade * GRADE_W + cdaNorm(v.cda) * (W.rhoMul - 1) * DRAG_W)) /
        W.muMul,
      0,
      0.6
    );

    const riskMul = 0.97 + 0.03 * v.risk; // shrunk from 0.9+0.1*risk: risk is one lever
    const capMph = sec.speedLimitMph + OVER_CAP_MPH;
    let targetMph = capMph * (1 - CONGESTION_DRAG * congestion) * (1 - deficit) * riskMul;

    // Serving a driver-error / incident stall: crawl and burn down the time penalty.
    c.incident = c.stallSec > 0;
    if (c.stallSec > 0) {
      targetMph = CRAWL_MPH;
      c.stallSec = Math.max(0, c.stallSec - dt);
    }

    // Converge toward target. Re-accel is limited by power-to-weight and adhesion (mu);
    // braking is quick. This is where a low-P/W car recovers slowly after a stall.
    const gap = targetMph - c.speedMph;
    const rate = gap > 0 ? dt * 0.35 * (0.5 + pn) * W.muMul : dt * 0.8;
    c.speedMph += gap * Math.min(1, rate);

    const dM = c.speedMph * MPH * dt;
    c.progress = Math.min(1, c.progress + dM / geom.totalM);
    c.lngLat = posAt(geom, c.progress);
    c.batteryPct = Math.max(0, c.batteryPct - dM / 1600);
    c.mode = nearIncident && v.defaultMode === "FSD" ? "Autopilot" : v.defaultMode;

    const remainM = geom.totalM * (1 - c.progress);
    const avg = c.history.length ? c.history.reduce((a, b) => a + b, 0) / c.history.length : c.speedMph;
    const eta = remainM / Math.max(4, avg * MPH);
    c.etaSec = eta;
    const band = eta * (0.06 + congestion * 0.14);
    c.etaLo = Math.max(0, eta - band);
    c.etaHi = eta + band;

    if (c.progress >= 1) c.finished = true;
  }
}

export function freshCars(corridor: Corridor, seed: string | number = 0): Record<string, VehicleState> {
  const geom = routeGeom(corridor.id);
  const weather = drawWeather(seed);
  const cars: Record<string, VehicleState> = {};
  for (const v of ["cybertruck-cyberbeast", "bmw-m5-g90", "waymo-ipace"]) {
    cars[v] = {
      id: v,
      progress: 0,
      lngLat: posAt(geom, 0),
      speedMph: 0,
      mode: vehicleById(v).defaultMode,
      batteryPct: 100,
      etaSec: 0,
      etaLo: 0,
      etaHi: 0,
      history: [],
      finished: false,
      weather,
      onHov: false,
      incident: false,
      stallSec: 0,
      lastSeg: -1,
    };
  }
  return cars;
}
