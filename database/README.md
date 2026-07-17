# Database — Cloudflare D1

The exact-data store: vehicle catalog with a **provenance ledger**, race results, and
routes/segments. Bound as `DB` in the backend Worker. Schema encodes the design in
[`../docs/VEHICLE_SPECS.md`](../docs/VEHICLE_SPECS.md) and
[`../docs/SIMULATION_RULES.md`](../docs/SIMULATION_RULES.md).

This is **not** the per-tick hot path (that's a Durable Object's SQLite) and **not** the ML
dataset store (that's the local training plane's parquet — [`../ml`](../ml)).

## Files

| File | Purpose |
|---|---|
| `schema.sql` | Tables, view, constraints |
| `seed.sql` | Real sourced specs + provenance + a sample route (I-45) |

## What the schema encodes (not generic tables)

- **`vehicles`** — physics-ready params. Mass is normalized to a **driverless** convention;
  the I-Pace's stored mass is a DIN-equivalent *estimate* from its only published figure (EU
  kerb). `cda_m2` (= Cd × A) is the value that enters the road-load equation.
- **`vehicle_params`** — the honesty layer: one row per (vehicle, parameter) with a tag
  (`VERIFIED`/`SECONDARY`/`ESTIMATED`/`UNPUBLISHED`) and a source. A `CHECK` allows a NULL value
  **only** when the tag is `UNPUBLISHED`.
- **`routes` / `route_segments`** — segmented corridors. `speed_limit_verified = 0` marks a limit
  we couldn't source (e.g. Galveston Causeway); `hov_lanes` drops to 0 where the real HOV facility
  ends (Webster on I-45).
- **`races` / `race_entrants`** — reproducible from `(seed, engine_version)`; `mock_data` is
  pinned to 1; `degraded` flags a race that fell back to a deterministic policy on budget
  exhaustion.

## Apply

```bash
# Local (default for testing)
npx wrangler d1 execute simzoner-db --local --file=database/schema.sql
npx wrangler d1 execute simzoner-db --local --file=database/seed.sql

# Remote (the real free-tier DB) — add --remote
npx wrangler d1 execute simzoner-db --remote --file=database/schema.sql
```
