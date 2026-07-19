/**
 * Race orchestration: pull real vehicle specs + route from D1, run the deterministic
 * physics (physics.ts), and persist results. This is the serving-plane glue between
 * the Database part and the engine. See docs/SYSTEM_DESIGN.md §4.
 */

import { simulateRace, ENGINE_VERSION, type Entrant, type Segment, type Vehicle } from "./physics";

// Default driver personas (risk 0..1): how close to the speed cap each runs. A real
// per-car trait, baked in once — not re-derived per call (SYSTEM_DESIGN §2). The
// Waymo is deliberately conservative (rule-following AV).
const PERSONA_RISK: Record<string, number> = {
  "cybertruck-cyberbeast": 0.9,
  "bmw-m5-g90": 0.8,
  "waymo-ipace": 0.4,
};

export interface EntrantRequest {
  vehicle_id: string;
  occupancy?: number; // ≥2 → HOV-eligible (SIMULATION_RULES §1)
}

async function loadVehicle(db: D1Database, id: string): Promise<Vehicle | null> {
  const row = await db
    .prepare("SELECT id, mass_kg, cda_m2, power_kw FROM vehicles WHERE id = ?")
    .bind(id)
    .first<Vehicle>();
  return row ?? null;
}

async function loadRoute(db: D1Database, routeId: string): Promise<Segment[]> {
  const { results } = await db
    .prepare(
      `SELECT seq, length_km, hov_lanes, speed_limit_mph, grade_pct, traffic_density
       FROM route_segments WHERE route_id = ? ORDER BY seq`
    )
    .bind(routeId)
    .all<Segment>();
  return results ?? [];
}

export interface RunOptions {
  routeId: string;
  seed: number;
  entrants: EntrantRequest[];
  nowIso: string; // supplied by the handler (Workers have no wall clock at import)
}

export async function runAndStore(db: D1Database, opts: RunOptions) {
  const route = await loadRoute(db, opts.routeId);
  if (route.length === 0) throw new Error(`unknown route: ${opts.routeId}`);

  const entrants: Entrant[] = [];
  for (const req of opts.entrants) {
    const vehicle = await loadVehicle(db, req.vehicle_id);
    if (!vehicle) throw new Error(`unknown vehicle: ${req.vehicle_id}`);
    const occupancy = req.occupancy ?? 1;
    // Waymo adopts SIMULATION_RULES AV_POLICY (B) "transit-equivalent": HOV-eligible wherever a
    // segment has HOV lanes, regardless of occupancy. Others need occupancy >= 2. Kept in sync
    // with ml/generate.py so serving matches the engine the v2 model was trained against.
    const hov_eligible = vehicle.id === "waymo-ipace" ? true : occupancy >= 2;
    entrants.push({
      vehicle,
      hov_eligible,
      risk: PERSONA_RISK[vehicle.id] ?? 0.7,
    });
  }
  if (entrants.length < 2) throw new Error("a race needs at least 2 entrants");

  const result = simulateRace(entrants, route, opts.seed);

  // Persist race + entrants. Reproducible from (seed, engine_version); mock_data=1.
  const raceId = `${opts.routeId}:${opts.seed}`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR REPLACE INTO races (id, seed, route_id, engine_version, degraded, mock_data, created_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      )
      .bind(raceId, opts.seed, opts.routeId, ENGINE_VERSION, opts.nowIso),
  ];
  result.finishes.forEach((f, i) => {
    const req = opts.entrants.find((e) => e.vehicle_id === f.vehicle_id);
    const occupancy = req?.occupancy ?? 1;
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO race_entrants
           (race_id, vehicle_id, lane_start, occupancy, hov_eligible, finish_time_s, finish_position, dnf)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .bind(raceId, f.vehicle_id, i, occupancy, occupancy >= 2 ? 1 : 0, f.time_s, i + 1)
    );
  });
  await db.batch(stmts);

  return { race_id: raceId, ...result };
}
