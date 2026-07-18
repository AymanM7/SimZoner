// Physics-lite advancement along a real corridor. Deterministic given inputs; the
// LLM/ML never runs in this loop. Speed is hard-capped at limit + 10 mph, cut by
// modeled traffic (from real bottleneck severity) and helped by HOV access.

import { posAt, routeGeom } from "./geo";
import { vehicleById } from "./vehicles";
import type { Corridor, VehicleState } from "./types";

const MPH = 0.44704;
export const TIME_SCALE = 40; // 1 real sec ~= 40 sim sec

// Which section a fraction-of-route falls in, and its local traffic level.
function sectionAt(corridor: Corridor, t: number) {
  const n = corridor.sections.length;
  const idx = Math.min(n - 1, Math.floor(t * n));
  return corridor.sections[idx];
}

function bottleneckLoad(corridor: Corridor, t: number) {
  // Nearest bottleneck by fractional position (bottlenecks are ordered along the route).
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
  incidentAt: number | null
): void {
  const geom = routeGeom(corridor.id);
  const dt = dtReal * TIME_SCALE;

  for (const id of Object.keys(cars)) {
    const c = cars[id];
    if (c.finished) continue;
    const v = vehicleById(id);
    const sec = sectionAt(corridor, c.progress);
    const bl = bottleneckLoad(corridor, c.progress);

    const nearIncident = incidentAt !== null && Math.abs(c.progress - incidentAt) < 0.08;
    const traffic = Math.min(1, 0.25 + bl * 0.6 + (nearIncident ? 0.6 : 0));

    const hasHov = sec.hovLanes > 0 && (v.risk >= 0.75 || v.defaultMode === "FSD");
    const congestion = hasHov ? traffic * 0.4 : traffic;
    const capMph = sec.speedLimitMph + 10;
    const targetMph = capMph * (1 - 0.5 * congestion) * (0.9 + 0.1 * v.risk);

    c.speedMph += (targetMph - c.speedMph) * Math.min(1, dt * 0.4);
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

export function freshCars(corridor: Corridor): Record<string, VehicleState> {
  const geom = routeGeom(corridor.id);
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
    };
  }
  return cars;
}
