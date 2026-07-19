import corridorsData from "../data/corridors.json";
import { routeGeom } from "./geo";
import type { Corridor, CorridorId, CorridorSection, Bottleneck } from "./types";

interface RawSection {
  name: string;
  speedLimitMph: number;
  speedLimitVerified: boolean;
  lanes: number;
  hovLanes: number;
  notes?: string;
}
interface RawBottleneck {
  name: string;
  locationDesc: string;
  severityIndex: number;
  reason: string;
}
interface RawCorridor {
  displayName: string;
  lengthKm: number;
  sections: RawSection[];
  bottlenecks: RawBottleneck[];
  hovRule?: unknown;
  waymoReality?: string;
}

// Order = route-selector order: I-45, I-35 South, I-75 (Cincinnati), Chicago, New York.
const IDS: CorridorId[] = [
  "i45-houston-galveston",
  "i35-south-austin",
  "cincinnati-i71-75",
  "chicago-kennedy",
  "newyork-lie",
];
const raw = corridorsData as unknown as Record<string, RawCorridor>;

function build(id: CorridorId): Corridor {
  const r = raw[id];
  const g = routeGeom(id);
  const center: [number, number] = [(g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2];
  const spanKm = g.totalM / 1000;
  const zoom = spanKm > 50 ? 9.2 : spanKm > 20 ? 10.2 : 11.4;
  return {
    id,
    displayName: r.displayName,
    lengthKm: r.lengthKm,
    center,
    zoom,
    sections: r.sections as CorridorSection[],
    bottlenecks: r.bottlenecks as Bottleneck[],
  };
}

export const CORRIDORS = Object.fromEntries(IDS.map((id) => [id, build(id)])) as Record<CorridorId, Corridor>;

export const CORRIDOR_LIST = IDS.map((id) => CORRIDORS[id]);
