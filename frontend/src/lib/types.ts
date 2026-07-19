// Shared contracts for the SimZoner frontend. Map, predictor, and store all build
// against these so the pieces compose without guesswork.

export type Mode = "Manual" | "Autopilot" | "FSD";
export type CorridorId =
  | "i45-houston-galveston"
  | "i35-south-austin"
  | "cincinnati-i71-75"
  | "chicago-kennedy"
  | "newyork-lie";

export interface Vehicle {
  id: string;
  name: string;
  short: string;
  color: string; // hex
  mass: number; // kg
  cda: number; // Cd x A
  power: number; // kW
  energy: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  defaultMode: Mode;
  risk: number; // persona 0..1
  behavior: string; // one-line behavioral summary
}

// Real corridor parameters (populated from data/highways/corridors.json).
export interface CorridorSection {
  name: string;
  speedLimitMph: number;
  speedLimitVerified: boolean;
  lanes: number;
  hovLanes: number;
  gradePct?: number; // sustained road grade fraction (e.g. 0.06 = 6%); bridges/causeways
  notes?: string;
}

// Per-race weather. Scales drag (rho), cuts adhesion for re-accel (mu), and worsens
// congestion (density). Drawn once per race from the seed.
export type WeatherKind = "clear" | "rain" | "heavy";
export interface Bottleneck {
  name: string;
  locationDesc: string;
  severityIndex: number; // 0..1
  reason: string;
}
export interface Corridor {
  id: CorridorId;
  displayName: string;
  lengthKm: number;
  center: [number, number]; // lng, lat
  zoom: number;
  sections: CorridorSection[];
  bottlenecks: Bottleneck[];
}

// A vehicle's live position along the route (0..1 of total distance) + telemetry.
export interface VehicleState {
  id: string;
  progress: number; // 0..1 along the corridor
  lngLat: [number, number]; // interpolated on the real geometry
  speedMph: number;
  mode: Mode;
  batteryPct: number;
  etaSec: number;
  etaLo: number;
  etaHi: number;
  history: number[];
  finished: boolean;
  // v2 rebalance additions (see engine.ts). weather is shared by all cars in a race.
  weather: WeatherKind;
  onHov: boolean; // currently in an HOV-eligible (congestion-relieved) segment
  incident: boolean; // currently losing time to a random driver-error / incident
  // internal per-race sim bookkeeping (persisted on carsRef between frames)
  stallSec: number; // remaining time-penalty seconds from an error/incident
  lastSeg: number; // last section index entered (to fire per-segment events once)
}

// Backend /predict payload — the ML Predictor result for a selected vehicle.
// The backend uses Vectorize (RAG over real specs + segment docs) + Workers AI.
export interface PredictResponse {
  vehicleId: string;
  recommendedSegment: string; // e.g. "I-45 HOV to Webster, then GP lanes"
  rationale: string; // LLM explanation grounded in retrieved specs
  usedVectorize: boolean;
  retrievedDocs: { id: string; score: number }[];
  leaderboard: { vehicleId: string; etaSec: number; rank: number }[];
}
