import type { Vehicle } from "./types";

// Real published specs (docs/VEHICLE_SPECS.md). BMW M5 kept for verified data.
// `behavior` drives the Manual/Autopilot/FSD framing and the sim's persona risk.
export const VEHICLES: Vehicle[] = [
  {
    id: "cybertruck-cyberbeast",
    name: "Tesla Cybertruck",
    short: "Cybertruck",
    color: "#dfe6f0",
    mass: 3104,
    cda: 1.025,
    power: 622,
    energy: "123 kWh",
    confidence: "LOW",
    defaultMode: "Autopilot",
    risk: 0.9,
    behavior: "Human/FSD hybrid — aggressive lane switching, exploits gaps.",
  },
  {
    id: "bmw-m5-g90",
    name: "BMW M5 (G90)",
    short: "BMW M5",
    color: "#4f8bff",
    mass: 2435,
    cda: 0.816,
    power: 535,
    energy: "22 kWh + V8",
    confidence: "HIGH",
    defaultMode: "Manual",
    risk: 0.8,
    behavior: "Standard luxury commuter telemetry — assertive but lawful.",
  },
  {
    id: "waymo-ipace",
    name: "Waymo (Jaguar I-Pace)",
    short: "Waymo",
    color: "#24d69a",
    mass: 2133,
    cda: 0.6264,
    power: 294,
    energy: "90 kWh",
    confidence: "MEDIUM",
    defaultMode: "FSD",
    risk: 0.4,
    behavior: "Strict autonomous geofenced pathing — conservative, rule-bound.",
  },
];

export const vehicleById = (id: string) => VEHICLES.find((v) => v.id === id)!;
