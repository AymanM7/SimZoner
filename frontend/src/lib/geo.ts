import routesGeo from "../data/routes.json";
import type { CorridorId } from "./types";

type Pos = [number, number]; // [lng, lat]

interface LineFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: Pos[] };
  properties: { id: string; displayName: string; lengthKm: number; note?: string };
}
interface PointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: Pos };
  properties: { corridorId: string; name: string; kind: string };
}

const fc = routesGeo as unknown as { features: (LineFeature | PointFeature)[] };

function lineFor(id: CorridorId): LineFeature {
  const f = fc.features.find(
    (x) => x.geometry.type === "LineString" && (x.properties as { id?: string }).id === id
  ) as LineFeature | undefined;
  if (!f) throw new Error(`no geometry for corridor ${id}`);
  return f;
}

export function waypointsFor(id: CorridorId) {
  return fc.features.filter(
    (x) => x.geometry.type === "Point" && (x.properties as { corridorId?: string }).corridorId === id
  ) as PointFeature[];
}

function haversine(a: Pos, b: Pos): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Precomputed per-corridor geometry with cumulative distances for interpolation.
export interface RouteGeom {
  coords: Pos[];
  cum: number[]; // cumulative meters at each vertex
  totalM: number;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
}

const cache = new Map<CorridorId, RouteGeom>();

export function routeGeom(id: CorridorId): RouteGeom {
  const hit = cache.get(id);
  if (hit) return hit;
  const coords = lineFor(id).geometry.coordinates;
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const geom: RouteGeom = {
    coords,
    cum,
    totalM: cum[cum.length - 1],
    bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
  };
  cache.set(id, geom);
  return geom;
}

// Interpolate a lng/lat at fraction t (0..1) along the real polyline.
export function posAt(geom: RouteGeom, t: number): Pos {
  const target = Math.max(0, Math.min(1, t)) * geom.totalM;
  let i = 1;
  while (i < geom.cum.length && geom.cum[i] < target) i++;
  if (i >= geom.coords.length) return geom.coords[geom.coords.length - 1];
  const segLen = geom.cum[i] - geom.cum[i - 1] || 1;
  const f = (target - geom.cum[i - 1]) / segLen;
  const a = geom.coords[i - 1];
  const b = geom.coords[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

export const lineCoords = (id: CorridorId) => routeGeom(id).coords;
