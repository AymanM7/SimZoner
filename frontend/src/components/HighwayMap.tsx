"use client";

// Leaflet + OpenStreetMap raster tiles. Chosen over MapLibre because Leaflet renders
// with plain <img> tiles (NO WebGL), so it works even where WebGL is disabled/blocked
// and is far more ad-blocker tolerant. tile.openstreetmap.org is the canonical, rarely
// blocked tile source. Coordinates in our data are GeoJSON [lng,lat]; Leaflet wants
// [lat,lng], so everything is swapped via ll().

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useStore } from "../store";
import { CORRIDORS } from "../lib/corridors";
import { lineCoords, waypointsFor, routeGeom } from "../lib/geo";
import { VEHICLES } from "../lib/vehicles";
import type { CorridorId, VehicleState } from "../lib/types";

const TILES = {
  light: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors",
    maxZoom: 19,
  },
  dark: {
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap (c) CARTO",
    maxZoom: 20,
  },
};

// [lng,lat] (GeoJSON) -> [lat,lng] (Leaflet)
const ll = (c: number[]): [number, number] => [c[1], c[0]];

function shortName(id: CorridorId): string {
  return CORRIDORS[id].displayName.trim().split(/\s+/)[0];
}

function carIcon(color: string, label: string): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: `<div style="display:flex;align-items:center;gap:6px;">
      <span style="width:18px;height:18px;border-radius:50%;background:${color};
        box-shadow:0 0 0 3px ${color}55,0 0 16px 3px ${color}cc;border:2px solid #0009;flex:0 0 auto;"></span>
      <span style="font:700 11px ui-monospace,monospace;color:#fff;background:${color}dd;
        padding:1px 6px;border-radius:6px;white-space:nowrap;text-shadow:0 1px 2px #000;">${label}</span>
    </div>`,
  });
}

function hovSubLine(id: CorridorId): number[][] | null {
  const wp = waypointsFor(id).find((w) => /hov ends/i.test(w.properties.name));
  if (!wp) return null;
  const coords = lineCoords(id);
  const target = wp.geometry.coordinates;
  let best = 0;
  let bestD = Infinity;
  coords.forEach((c, i) => {
    const d = (c[0] - target[0]) ** 2 + (c[1] - target[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return coords.slice(0, best + 1);
}

function drawCorridor(
  map: L.Map,
  group: L.LayerGroup,
  markers: Record<string, L.Marker>,
  id: CorridorId,
  carsRef: React.RefObject<Record<string, VehicleState>>
) {
  group.clearLayers();
  const coords = lineCoords(id).map(ll);

  L.polyline(coords, { color: "#0b1220", weight: 9, opacity: 0.85 }).addTo(group);
  L.polyline(coords, { color: "#12d6c4", weight: 5, opacity: 0.95 }).addTo(group);

  const hov = hovSubLine(id);
  if (hov) L.polyline(hov.map(ll), { color: "#f0b23c", weight: 4, opacity: 0.95 }).addTo(group);

  // route label at the midpoint
  const mid = coords[Math.floor(coords.length / 2)];
  L.marker(mid, {
    interactive: false,
    icon: L.divIcon({
      className: "",
      iconSize: [0, 0],
      html: `<span style="font:800 13px ui-monospace,monospace;color:#eafffb;background:#04201dcc;
        padding:2px 8px;border-radius:6px;white-space:nowrap;">${shortName(id)}</span>`,
    }),
  }).addTo(group);

  for (const w of waypointsFor(id)) {
    L.circleMarker(ll(w.geometry.coordinates), {
      radius: 4,
      color: "#12d6c4",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    })
      .addTo(group)
      .bindTooltip(w.properties.name, { direction: "top" });
  }

  for (const v of VEHICLES) {
    if (markers[v.id]) markers[v.id].remove();
    const start = carsRef.current?.[v.id]?.lngLat ?? routeGeom(id).coords[0];
    markers[v.id] = L.marker(ll(start), { icon: carIcon(v.color, v.short), interactive: false }).addTo(map);
  }

  map.fitBounds(L.latLngBounds(coords), { padding: [50, 50] });
}

export function HighwayMap({ carsRef }: { carsRef: React.RefObject<Record<string, VehicleState>> }) {
  const corridorId = useStore((s) => s.corridorId);
  const mapTheme = useStore((s) => s.mapTheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const groupRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // init once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;
    let map: L.Map;
    try {
      const c = CORRIDORS[corridorId];
      map = L.map(container, { center: [c.center[1], c.center[0]], zoom: c.zoom });
    } catch (e) {
      setErr(`Map init failed: ${(e as Error).message}`);
      return;
    }
    mapRef.current = map;

    const t = TILES[useStore.getState().mapTheme];
    const tile = L.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom }).addTo(map);
    tile.on("tileerror", () =>
      setErr("Tiles are being blocked (ad-blocker or network). Leaflet loaded fine, but the tile images can't be fetched.")
    );
    tileRef.current = tile;

    const group = L.layerGroup().addTo(map);
    groupRef.current = group;

    setReady(true);
    drawCorridor(map, group, markersRef.current, useStore.getState().corridorId, carsRef);
    setTimeout(() => map.invalidateSize(), 0); // ensure canvas matches container

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(container);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme -> swap tile layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) tileRef.current.remove();
    const t = TILES[mapTheme];
    tileRef.current = L.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom }).addTo(map);
  }, [mapTheme]);

  // corridor change -> redraw
  useEffect(() => {
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group) return;
    drawCorridor(map, group, markersRef.current, corridorId, carsRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corridorId]);

  // move markers each frame from the live cars ref
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const cars = carsRef.current;
      if (cars) {
        for (const v of VEHICLES) {
          const m = markersRef.current[v.id];
          const c = cars[v.id];
          if (m && c) m.setLatLng(ll(c.lngLat));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [carsRef]);

  return (
    <div className="relative w-full h-full min-h-[480px]">
      <div ref={containerRef} className="absolute inset-0" style={{ background: "#0b1016" }} />
      {!ready && !err && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-[var(--color-muted)]">
          Loading OpenStreetMap…
        </div>
      )}
      {err && (
        <div className="absolute inset-x-3 top-3 z-[1000] rounded-lg border border-[var(--color-bad)]/50 bg-[var(--color-bad)]/15 p-3 text-[12px] text-[var(--color-bad)]">
          <b>Map issue.</b> {err}
        </div>
      )}
    </div>
  );
}
