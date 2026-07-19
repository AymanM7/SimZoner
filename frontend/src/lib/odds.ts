// Live win-odds via a client-side Monte Carlo over each car's ETA uncertainty band.
// Zero backend / zero neurons: the engine already emits etaSec plus an etaLo/etaHi band
// every frame, which is a distribution over finish time. We sample a finish time per car
// from a triangular over [etaLo, etaHi] (mode at etaSec), the earliest arrival wins, and
// tally P(win). A fixed RNG seed keeps the numbers stable frame-to-frame (they move only
// when the ETAs move), so the bars swing with the race, not with sampling noise.

import type { VehicleState } from "./types";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inverse-CDF sample from Triangular(lo, mode, hi).
function triangular(u: number, lo: number, mode: number, hi: number): number {
  const span = hi - lo;
  if (span <= 0) return lo;
  const c = (mode - lo) / span;
  return u < c ? lo + Math.sqrt(u * span * (mode - lo)) : hi - Math.sqrt((1 - u) * span * (hi - mode));
}

export function winProbabilities(cars: Record<string, VehicleState>, samples = 1200): Record<string, number> {
  const ids = Object.keys(cars);
  const out: Record<string, number> = {};
  ids.forEach((id) => (out[id] = 0));
  if (ids.length === 0) return out;

  // Pre-race (nothing moving, no ETA yet): even opening line.
  const anyFinished = ids.some((id) => cars[id].finished);
  const anyLive = ids.some((id) => !cars[id].finished && cars[id].etaSec > 0);
  if (!anyFinished && !anyLive) {
    ids.forEach((id) => (out[id] = 1 / ids.length));
    return out;
  }

  // A finished car has locked its arrival (remaining time 0). Everyone else samples
  // from their ETA band. Clamp so mode stays within [lo, hi].
  const params = ids.map((id) => {
    const c = cars[id];
    if (c.finished) return { id, lo: 0, mode: 0, hi: 0 };
    const lo = Math.max(0, c.etaLo);
    const hi = Math.max(lo, c.etaHi);
    const mode = Math.min(hi, Math.max(lo, c.etaSec > 0 ? c.etaSec : hi));
    return { id, lo, mode, hi };
  });

  const rng = mulberry32(0x51ede5);
  const wins: Record<string, number> = {};
  ids.forEach((id) => (wins[id] = 0));
  for (let s = 0; s < samples; s++) {
    let best = Infinity;
    let bestId = params[0].id;
    for (const p of params) {
      const t = triangular(rng(), p.lo, p.mode, p.hi);
      if (t < best) {
        best = t;
        bestId = p.id;
      }
    }
    wins[bestId]++;
  }
  ids.forEach((id) => (out[id] = wins[id] / samples));
  return out;
}

// Flavor conversions for the odds readout.
export const toDecimalOdds = (p: number) => (p <= 0 ? Infinity : 1 / p);
export function toAmericanOdds(p: number): string {
  if (p <= 0) return "+9999";
  if (p >= 1) return "-9999";
  return p > 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`;
}
