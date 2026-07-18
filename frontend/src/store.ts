import { create } from "zustand";
import type { CorridorId, PredictResponse, VehicleState } from "./lib/types";
import { CORRIDORS } from "./lib/corridors";
import { vehicleById, VEHICLES } from "./lib/vehicles";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787";

interface State {
  corridorId: CorridorId;
  selectedVehicleId: string;
  running: boolean;
  raceNonce: number; // bump to restart the sim (cars back to the start line)
  incidentAt: number | null; // fractional position 0..1 of an injected incident
  mapTheme: "light" | "dark"; // OpenStreetMap light vs dark basemap
  prediction: PredictResponse | null;
  predictLoading: boolean;

  setCorridor: (id: CorridorId) => void;
  selectVehicle: (id: string) => void;
  toggleRunning: () => void;
  triggerIncident: (at: number) => void;
  clearIncident: () => void;
  toggleMapTheme: () => void;
  runPrediction: (vehicleId: string, cars: Record<string, VehicleState>) => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  corridorId: "i45-houston-galveston",
  selectedVehicleId: "waymo-ipace",
  running: false, // cars wait at the start line until Predict is clicked
  raceNonce: 0,
  incidentAt: null,
  mapTheme: "light",
  prediction: null,
  predictLoading: false,

  setCorridor: (id) => set({ corridorId: id, incidentAt: null, prediction: null }),
  selectVehicle: (id) => {
    set({ selectedVehicleId: id });
  },
  toggleRunning: () => set((s) => ({ running: !s.running })),
  triggerIncident: (at) => set({ incidentAt: at }),
  clearIncident: () => set({ incidentAt: null }),
  toggleMapTheme: () => set((s) => ({ mapTheme: s.mapTheme === "light" ? "dark" : "light" })),

  runPrediction: async (vehicleId, cars) => {
    // Clicking Predict launches the race: reset cars to the start line and run.
    set((s) => ({ predictLoading: true, running: true, raceNonce: s.raceNonce + 1 }));
    const corridorId = get().corridorId;
    const leaderboard = VEHICLES.map((v) => ({ vehicleId: v.id, etaSec: cars[v.id]?.etaSec ?? Infinity }))
      .sort((a, b) => a.etaSec - b.etaSec)
      .map((x, i) => ({ ...x, rank: i + 1 }));

    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vehicleId, corridorId }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const data = (await res.json()) as PredictResponse;
      set({ prediction: { ...data, leaderboard }, predictLoading: false });
    } catch {
      // Backend unreachable -> local fallback. Vectorize NOT used; say so honestly.
      set({ prediction: localPrediction(vehicleId, corridorId, leaderboard), predictLoading: false });
    }
  },
}));

// Deterministic local fallback so the UI works without the backend. It is explicit
// that Vectorize was not consulted (usedVectorize: false) rather than faking it.
function localPrediction(
  vehicleId: string,
  corridorId: CorridorId,
  leaderboard: PredictResponse["leaderboard"]
): PredictResponse {
  const v = vehicleById(vehicleId);
  const c = CORRIDORS[corridorId];
  const hovSection = c.sections.find((s) => s.hovLanes > 0);
  const hovEligible = v.risk >= 0.75 || v.defaultMode === "FSD";
  const rec =
    hovSection && hovEligible
      ? `Take the HOV/express lane through ${hovSection.name.split("(")[0].trim()}, then general lanes after it ends.`
      : `Hold general-purpose lanes; no HOV advantage available on ${c.displayName}.`;
  return {
    vehicleId,
    recommendedSegment: rec,
    rationale: `${v.short}: ${v.behavior} On this corridor, capped speed makes lane access and congestion the deciding factors, not top speed.`,
    usedVectorize: false,
    retrievedDocs: [],
    leaderboard,
  };
}
