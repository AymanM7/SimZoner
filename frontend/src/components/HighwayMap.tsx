"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useStore } from "../store";
import { CORRIDORS } from "../lib/corridors";
import { lineCoords, waypointsFor, routeGeom } from "../lib/geo";
import { VEHICLES } from "../lib/vehicles";
import type { CorridorId, VehicleState } from "../lib/types";

// Keyless, CORS-friendly, OSM-based raster basemaps where roads are clearly visible.
//  - light: CARTO Voyager (OSM data). Chosen over raw tile.openstreetmap.org because
//    OSM's public tile server enforces a usage policy and frequently returns HTTP
//    418/403 to browser clients (Referer/UA), producing a blank map. CARTO's CDN is
//    keyless and CORS-friendly, so tiles load reliably from the browser.
//  - dark:  CARTO dark_all (OSM data, keyless).
// Both raster sources + layers are added at init; the active one is toggled via
// setLayoutProperty visibility on theme change (no setStyle, so the route/markers
// and other overlay layers are never dropped).
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  // Keyless glyph server so the route + waypoint text labels actually render.
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    "osm-light": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "(c) OpenStreetMap contributors (c) CARTO",
    },
    "carto-dark": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "(c) OpenStreetMap (c) CARTO",
    },
  },
  layers: [
    // Both present from the start; visibility is switched by applyTheme().
    { id: "basemap-light", type: "raster", source: "osm-light", layout: { visibility: "visible" } },
    { id: "basemap-dark", type: "raster", source: "carto-dark", layout: { visibility: "none" } },
  ],
};

function applyTheme(map: maplibregl.Map, theme: "light" | "dark") {
  map.setLayoutProperty("basemap-light", "visibility", theme === "light" ? "visible" : "none");
  map.setLayoutProperty("basemap-dark", "visibility", theme === "dark" ? "visible" : "none");
}

// First whitespace token of displayName, e.g. "I-45" or "I-71/I-75".
function routeShortName(id: CorridorId): string {
  return CORRIDORS[id].displayName.trim().split(/\s+/)[0];
}

function hovSubLine(id: CorridorId): [number, number][] | null {
  const wp = waypointsFor(id).find((w) => /hov ends/i.test(w.properties.name));
  if (!wp) return null;
  const coords = lineCoords(id);
  // slice route up to the vertex nearest the "HOV ends" waypoint
  const target = wp.geometry.coordinates;
  let best = 0;
  let bestD = Infinity;
  coords.forEach((c, i) => {
    const d = (c[0] - target[0]) ** 2 + (c[1] - target[1]) ** 2;
    if (d < bestD) [bestD, best] = [d, i];
  });
  return coords.slice(0, best + 1) as [number, number][];
}

export function HighwayMap({ carsRef }: { carsRef: React.RefObject<Record<string, VehicleState>> }) {
  const corridorId = useStore((s) => s.corridorId);
  const mapTheme = useStore((s) => s.mapTheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const readyRef = useRef(false);

  // init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;
    const c = CORRIDORS[corridorId];
    const map = new maplibregl.Map({
      container,
      style: STYLE,
      center: c.center,
      zoom: c.zoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    // Keep the canvas matched to the container size (fixes "looks terrible" sizing).
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);

    map.on("load", () => {
      readyRef.current = true;
      applyTheme(map, useStore.getState().mapTheme);
      applyCorridor(map, useStore.getState().corridorId, markersRef.current, carsRef);
      map.resize();
    });
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
      markersRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme change -> toggle basemap visibility (never setStyle)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    applyTheme(map, mapTheme);
  }, [mapTheme]);

  // corridor change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    applyCorridor(map, corridorId, markersRef.current, carsRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corridorId]);

  // move markers every frame from the live cars ref
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const cars = carsRef.current;
      if (cars) {
        for (const v of VEHICLES) {
          const m = markersRef.current[v.id];
          const c = cars[v.id];
          if (m && c) m.setLngLat(c.lngLat);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [carsRef]);

  // Self-sufficient sizing: the root carries an explicit height (h-full with a
  // min-h floor) so the map never collapses to 0px when an ancestor lacks a
  // definite height. The canvas fills it via position:absolute; inset:0.
  return (
    <div className="relative w-full h-full min-h-[480px]">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}

function markerEl(color: string, label: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:7px;transform:translate(-50%,-50%);pointer-events:none;";
  el.innerHTML = `
    <span style="width:20px;height:20px;border-radius:50%;background:${color};
      box-shadow:0 0 0 4px ${color}55, 0 0 22px 4px ${color}dd;border:2px solid #0009;"></span>
    <span style="font:700 11px ui-monospace,monospace;color:#fff;text-shadow:0 1px 3px #000e;
      background:${color}cc;padding:1px 6px;border-radius:6px;white-space:nowrap;">${label}</span>`;
  return el;
}

function applyCorridor(
  map: maplibregl.Map,
  id: CorridorId,
  markers: Record<string, maplibregl.Marker>,
  carsRef: React.RefObject<Record<string, VehicleState>>
) {
  const coords = lineCoords(id);
  const short = routeShortName(id);

  // Route: thick high-contrast line with a darker casing underneath, plus a
  // line-following text label of the route's short name. All three layers share
  // the "route" source so a single setData updates the whole corridor.
  const routeData: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { short },
  };
  if (map.getSource("route")) {
    (map.getSource("route") as maplibregl.GeoJSONSource).setData(routeData);
  } else {
    map.addSource("route", { type: "geojson", data: routeData });
    // casing (drawn first -> underneath)
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0b1220", "line-width": 9, "line-opacity": 0.9 },
    });
    // bright corridor line
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#12d6c4", "line-width": 5.5, "line-opacity": 0.98 },
    });
    // line-following route label
    map.addLayer({
      id: "route-label",
      type: "symbol",
      source: "route",
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 260,
        "text-field": ["get", "short"],
        "text-font": ["Open Sans Bold"],
        "text-size": 14,
        "text-letter-spacing": 0.05,
      },
      paint: { "text-color": "#eafffb", "text-halo-color": "#04201d", "text-halo-width": 2.2 },
    });
  }

  const hov = hovSubLine(id);
  setGeoLayer(
    map,
    "hov",
    hov ? { type: "LineString", coordinates: hov } : { type: "LineString", coordinates: [] },
    { "line-color": "#f0b23c", "line-width": 4, "line-opacity": hov ? 0.95 : 0 }
  );

  // waypoint labels
  const wpFC = {
    type: "FeatureCollection" as const,
    features: waypointsFor(id).map((w) => ({
      type: "Feature" as const,
      geometry: w.geometry,
      properties: { name: w.properties.name },
    })),
  };
  if (map.getSource("waypoints")) (map.getSource("waypoints") as maplibregl.GeoJSONSource).setData(wpFC);
  else {
    map.addSource("waypoints", { type: "geojson", data: wpFC });
    map.addLayer({
      id: "waypoints-dot",
      type: "circle",
      source: "waypoints",
      paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#12d6c4", "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: "waypoints-label",
      type: "symbol",
      source: "waypoints",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-size": 10,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
      },
      paint: { "text-color": "#e7eefb", "text-halo-color": "#000", "text-halo-width": 1.6 },
    });
  }

  // vehicle markers (create once per corridor)
  for (const v of VEHICLES) {
    if (markers[v.id]) markers[v.id].remove();
    const start = carsRef.current?.[v.id]?.lngLat ?? routeGeom(id).coords[0];
    markers[v.id] = new maplibregl.Marker({ element: markerEl(v.color, v.short) }).setLngLat(start).addTo(map);
  }

  const b = routeGeom(id).bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 70, duration: 800 });
}

function setGeoLayer(
  map: maplibregl.Map,
  key: string,
  geom: GeoJSON.Geometry,
  paint: Record<string, unknown>
) {
  const data = { type: "Feature" as const, geometry: geom, properties: {} };
  if (map.getSource(key)) {
    (map.getSource(key) as maplibregl.GeoJSONSource).setData(data);
  } else {
    map.addSource(key, { type: "geojson", data });
    map.addLayer({ id: key, type: "line", source: key, layout: { "line-cap": "round", "line-join": "round" }, paint });
  }
}
