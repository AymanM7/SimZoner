-- SimZoner D1 schema.
-- Encodes the design in docs/VEHICLE_SPECS.md, docs/SIMULATION_RULES.md,
-- and docs/SYSTEM_DESIGN.md §7. This is the exact-data / results store — NOT the
-- per-tick hot path (that is DO SQLite) and NOT the ML training store (that is the
-- local training plane's parquet, SYSTEM_DESIGN §6).

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────────
-- VEHICLES — physics-ready, normalized parameters.
-- Mass is normalized to a DRIVERLESS convention (VEHICLE_SPECS §6): DIN or US-curb.
-- The I-Pace's only published figure is EU kerb (incl. 75 kg driver), so its stored
-- mass is a DIN-equivalent ESTIMATE — the provenance is recorded per-param below.
-- `cda_m2` (= Cd x A) is the quantity that actually enters the road-load equation
-- (VEHICLE_SPECS §6); Cd alone is never enough.
-- `confidence` is the per-vehicle trust rating from VEHICLE_SPECS §7 — the three
-- vehicles are NOT equally well characterized, and results must not pretend they are.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE vehicles (
  id                TEXT PRIMARY KEY,          -- e.g. 'bmw-m5-g90'
  display_name      TEXT NOT NULL,
  trim              TEXT NOT NULL,
  powertrain        TEXT NOT NULL,             -- 'PHEV V8' | 'tri-motor EV' | 'twin-motor EV'
  mass_kg           REAL NOT NULL,
  mass_convention   TEXT NOT NULL,             -- 'DIN' | 'US-curb' | 'DIN-equiv (est)'
  cd                REAL NOT NULL,             -- drag coefficient
  frontal_area_m2   REAL NOT NULL,
  cda_m2            REAL NOT NULL,             -- cd * frontal_area_m2 (the load-bearing product)
  power_kw          REAL NOT NULL,
  torque_nm         REAL NOT NULL,
  drivetrain        TEXT NOT NULL,
  crr               REAL,                      -- rolling resistance; NULL = UNPUBLISHED for all three
  sensor_penalty    INTEGER NOT NULL DEFAULT 0,-- Waymo pod ΔCd/Δmass; unpublished → default 0 (VEHICLE_SPECS §5b)
  confidence        TEXT NOT NULL,             -- 'HIGH' | 'MEDIUM' | 'LOW'  (VEHICLE_SPECS §7)
  notes             TEXT
);

-- PROVENANCE LEDGER — one row per (vehicle, parameter). This is the honesty layer:
-- every physics number traces to a tag and a source. Tag ∈ VEHICLE_SPECS convention.
CREATE TABLE vehicle_params (
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  param       TEXT NOT NULL,                   -- 'cd' | 'frontal_area_m2' | 'mass_kg' | ...
  value       TEXT,                            -- NULL permitted ONLY for UNPUBLISHED (see CHECK)
  unit        TEXT,
  tag         TEXT NOT NULL CHECK (tag IN ('VERIFIED','SECONDARY','ESTIMATED','UNPUBLISHED')),
  source_url  TEXT,                            -- NULL only when tag = UNPUBLISHED
  note        TEXT,
  PRIMARY KEY (vehicle_id, param),
  -- An UNPUBLISHED parameter genuinely has no value; anything else must.
  CHECK (value IS NOT NULL OR tag = 'UNPUBLISHED')
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROUTES & SEGMENTS — segmented corridors (SIMULATION_RULES §3).
-- Segments are the LLM decision points (~20/race, SYSTEM_DESIGN §5).
-- `speed_limit_verified` = 0 marks a limit we could not source (e.g. Galveston
-- Causeway) — surfaced, not guessed. `hov_lanes` per SIMULATION_RULES §1; note the
-- I-45 HOV facility ends at Webster mid-route, so segments differ down one corridor.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE routes (
  id           TEXT PRIMARY KEY,               -- 'i45-houston-galveston'
  display_name TEXT NOT NULL,
  total_km     REAL NOT NULL,
  notes        TEXT
);

CREATE TABLE route_segments (
  route_id             TEXT NOT NULL REFERENCES routes(id),
  seq                  INTEGER NOT NULL,       -- 0-based order along the route
  name                 TEXT NOT NULL,
  length_km            REAL NOT NULL,
  lanes                INTEGER NOT NULL,
  hov_lanes            INTEGER NOT NULL DEFAULT 0,
  speed_limit_mph      INTEGER NOT NULL,
  speed_limit_verified INTEGER NOT NULL DEFAULT 0,  -- 0 = unsourced, marked not guessed
  grade_pct            REAL NOT NULL DEFAULT 0,     -- from a US-native DEM (ARCHITECTURE §10)
  traffic_density      REAL NOT NULL DEFAULT 0,     -- 0..1 mock baseline
  notes                TEXT,
  PRIMARY KEY (route_id, seq)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RACES & ENTRANTS — results store.
-- Every race is reproducible from (seed, engine_version): same inputs → identical
-- result (SYSTEM_DESIGN §4/§6). `mock_data` is always 1 — real inputs, synthetic
-- outcomes (VEHICLE_SPECS §0). `degraded` flags a race that fell back to the
-- deterministic default policy because the neuron budget was exhausted mid-race
-- (SYSTEM_DESIGN §9.1); such a race still finishes, but is labeled.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE races (
  id             TEXT PRIMARY KEY,
  seed           INTEGER NOT NULL,
  route_id       TEXT NOT NULL REFERENCES routes(id),
  engine_version TEXT NOT NULL,
  degraded       INTEGER NOT NULL DEFAULT 0,
  mock_data      INTEGER NOT NULL DEFAULT 1 CHECK (mock_data = 1),
  created_at     TEXT NOT NULL                 -- ISO 8601, supplied by caller (Workers have no wall clock at import)
);

CREATE TABLE race_entrants (
  race_id         TEXT NOT NULL REFERENCES races(id),
  vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
  lane_start      INTEGER NOT NULL,
  occupancy       INTEGER NOT NULL DEFAULT 1,  -- drives HOV eligibility (SIMULATION_RULES §1)
  hov_eligible    INTEGER NOT NULL DEFAULT 0,
  finish_time_s   REAL,                        -- NULL until finished
  finish_position INTEGER,
  dnf             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, vehicle_id)
);

CREATE INDEX idx_entrants_vehicle ON race_entrants(vehicle_id);
CREATE INDEX idx_races_route      ON races(route_id);

-- Leaderboard as a view over finished entrants — fastest normalized finishes.
CREATE VIEW leaderboard AS
  SELECT e.vehicle_id, v.display_name, r.route_id,
         e.finish_time_s, e.finish_position, r.id AS race_id, r.degraded
  FROM race_entrants e
  JOIN races r    ON r.id = e.race_id
  JOIN vehicles v ON v.id = e.vehicle_id
  WHERE e.finish_time_s IS NOT NULL AND e.dnf = 0
  ORDER BY r.route_id, e.finish_time_s ASC;
