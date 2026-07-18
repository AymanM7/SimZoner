/**
 * RAG corpus assembly for SimZoner (docs/ARCHITECTURE.md section 7).
 *
 * Turns the exact-data D1 store (vehicles + provenance ledger, routes + segments)
 * into rich natural-language documents the driver agent can retrieve over. The
 * important twist: every vehicle document carries its provenance CONFIDENCE
 * (HIGH/MEDIUM/LOW) and per-parameter source tags, so the agent is told how much
 * to trust each spec rather than treating a secondary-sourced Cybertruck number
 * as if it were BMW's manufacturer-verified data (VEHICLE_SPECS.md section 7).
 *
 * Docs are built from D1 at runtime. Stable doc IDs make re-ingest idempotent:
 *   vehicle:<id>          e.g. vehicle:bmw-m5-g90
 *   seg:<route>:<seq>     e.g. seg:i45-houston-galveston:2
 */

import { Document } from "@langchain/core/documents";

// Driver personas (risk 0..1) mirror the values baked into race.ts. Kept local so
// this module does not import from the race engine (owned by another agent). The
// hint is what the RAG agent reads; the number is the physics knob it corresponds to.
const PERSONA_HINTS: Record<string, string> = {
  "cybertruck-cyberbeast":
    "Aggressive persona (risk 0.9): runs right at the speed cap and takes every gap.",
  "bmw-m5-g90":
    "Assertive persona (risk 0.8): quick but a touch more measured than the Cybertruck.",
  "waymo-ipace":
    "Conservative rule-following AV persona (risk 0.4): stays well under the cap and never speeds.",
};

interface VehicleRow {
  id: string;
  display_name: string;
  trim: string;
  powertrain: string;
  mass_kg: number;
  mass_convention: string;
  cd: number;
  frontal_area_m2: number;
  cda_m2: number;
  power_kw: number;
  torque_nm: number;
  drivetrain: string;
  confidence: string;
  notes: string | null;
}

interface ParamRow {
  vehicle_id: string;
  param: string;
  value: string | null;
  unit: string | null;
  tag: string;
  note: string | null;
}

interface SegmentRow {
  route_id: string;
  route_name: string;
  route_notes: string | null;
  seq: number;
  name: string;
  length_km: number;
  lanes: number;
  hov_lanes: number;
  speed_limit_mph: number;
  speed_limit_verified: number;
  grade_pct: number;
  traffic_density: number;
  notes: string | null;
}

export interface VehicleDocMetadata {
  kind: "vehicle";
  vehicle_id: string;
  display_name: string;
  confidence: string;
}

export interface SegmentDocMetadata {
  kind: "segment";
  route_id: string;
  route_name: string;
  seq: number;
  name: string;
  hov_lanes: number;
}

/** Compact one-line provenance summary, e.g. "cd=VERIFIED, mass_kg=ESTIMATED, crr=UNPUBLISHED". */
function summarizeProvenance(params: ParamRow[]): string {
  if (params.length === 0) return "no ledger entries";
  return params.map((p) => `${p.param}=${p.tag}`).join(", ");
}

/**
 * Build one retrieval document per vehicle: identity, physics-relevant specs
 * (mass with its convention, Cd, frontal area, the load-bearing Cd*A product,
 * power, torque, drivetrain), persona hint, and the provenance confidence plus
 * the per-parameter source tags from the ledger.
 */
export async function buildVehicleDocs(env: Env): Promise<Document<VehicleDocMetadata>[]> {
  const [{ results: vehicles }, { results: params }] = await Promise.all([
    env.DB.prepare(
      `SELECT id, display_name, trim, powertrain, mass_kg, mass_convention, cd,
              frontal_area_m2, cda_m2, power_kw, torque_nm, drivetrain, confidence, notes
       FROM vehicles ORDER BY id`
    ).all<VehicleRow>(),
    env.DB.prepare(
      `SELECT vehicle_id, param, value, unit, tag, note
       FROM vehicle_params ORDER BY vehicle_id, param`
    ).all<ParamRow>(),
  ]);

  const paramsByVehicle = new Map<string, ParamRow[]>();
  for (const p of params ?? []) {
    const list = paramsByVehicle.get(p.vehicle_id) ?? [];
    list.push(p);
    paramsByVehicle.set(p.vehicle_id, list);
  }

  return (vehicles ?? []).map((v) => {
    const provenance = summarizeProvenance(paramsByVehicle.get(v.id) ?? []);
    const persona = PERSONA_HINTS[v.id] ?? "Persona unspecified.";

    const pageContent = [
      `Vehicle: ${v.display_name} (${v.trim}), id ${v.id}.`,
      `Powertrain: ${v.powertrain}; drivetrain ${v.drivetrain}.`,
      `Mass: ${v.mass_kg} kg (${v.mass_convention} convention).`,
      `Aerodynamics: Cd ${v.cd}, frontal area ${v.frontal_area_m2} m^2, ` +
        `Cd*A ${v.cda_m2} m^2 (Cd*A is the quantity that enters the road-load drag term, not Cd alone).`,
      `Output: ${v.power_kw} kW, ${v.torque_nm} Nm.`,
      `Persona: ${persona}`,
      `Provenance confidence: ${v.confidence}. Per-parameter source tags: ${provenance}.`,
      `Trust note: ${v.confidence} confidence means specs range from manufacturer-VERIFIED to ` +
        `SECONDARY/ESTIMATED; weigh results accordingly and do not present LOW and HIGH vehicles with equal authority.`,
      v.notes ? `Notes: ${v.notes}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return new Document<VehicleDocMetadata>({
      id: `vehicle:${v.id}`,
      pageContent,
      metadata: {
        kind: "vehicle",
        vehicle_id: v.id,
        display_name: v.display_name,
        confidence: v.confidence,
      },
    });
  });
}

/**
 * Build one retrieval document per route segment: the corridor it belongs to,
 * segment name and order, lane counts including HOV lanes, speed limit (flagged
 * when unverified), grade, traffic density, and any notable feature (e.g. the
 * I-45 Webster HOV cliff where the HOV facility simply ends mid-route).
 */
export async function buildRouteDocs(env: Env): Promise<Document<SegmentDocMetadata>[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.route_id, r.display_name AS route_name, r.notes AS route_notes,
            s.seq, s.name, s.length_km, s.lanes, s.hov_lanes,
            s.speed_limit_mph, s.speed_limit_verified, s.grade_pct, s.traffic_density, s.notes
     FROM route_segments s
     JOIN routes r ON r.id = s.route_id
     ORDER BY s.route_id, s.seq`
  ).all<SegmentRow>();

  return (results ?? []).map((s) => {
    const hov =
      s.hov_lanes > 0
        ? `${s.hov_lanes} HOV lane(s) available`
        : "no HOV lanes on this segment";
    const speed = s.speed_limit_verified
      ? `${s.speed_limit_mph} mph`
      : `${s.speed_limit_mph} mph (UNVERIFIED speed limit - surfaced, not guessed)`;
    const grade =
      s.grade_pct === 0
        ? "flat (0% grade)"
        : `${s.grade_pct}% grade`;

    const pageContent = [
      `Route ${s.route_name} (id ${s.route_id}), segment ${s.seq}: ${s.name}.`,
      `Length ${s.length_km} km, ${s.lanes} general lane(s), ${hov}.`,
      `Speed limit ${speed}. Terrain ${grade}. Traffic density ${s.traffic_density} (0..1).`,
      s.notes ? `Notable: ${s.notes}.` : "",
      s.route_notes ? `Route context: ${s.route_notes}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return new Document<SegmentDocMetadata>({
      id: `seg:${s.route_id}:${s.seq}`,
      pageContent,
      metadata: {
        kind: "segment",
        route_id: s.route_id,
        route_name: s.route_name,
        seq: s.seq,
        name: s.name,
        hov_lanes: s.hov_lanes,
      },
    });
  });
}

/** Build the full corpus (vehicles + route segments) as one flat document array. */
export async function buildCorpus(env: Env): Promise<Document[]> {
  const [vehicleDocs, routeDocs] = await Promise.all([
    buildVehicleDocs(env),
    buildRouteDocs(env),
  ]);
  return [...vehicleDocs, ...routeDocs];
}
