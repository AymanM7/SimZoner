# SimZoner - Novelty Features for the Next Deploy

Research + recommendation. Author: product/frontend review. Date: 2026-07-18.
Scope: two genuinely novel, high-impact, BUILDABLE features to add before the next
deploy, chosen from a shortlist, grounded in the code and infra that already exist.

ASCII-only by request.

---

## What already exists (grounding)

Read before proposing anything, so the ideas fit the machine that is actually built.

Frontend (Next.js 15 static export, React 19, Zustand, Leaflet + OSM):

- `frontend/src/lib/engine.ts` - deterministic, LLM-free physics. `advance()` runs each
  animation frame. It ALREADY computes, per car: `speedMph`, `progress`, `etaSec`, and an
  uncertainty band `etaLo`/`etaHi` (band widens with congestion). No RNG on the client -
  a race is fully determined by corridor + `incidentAt`.
- `frontend/src/lib/useSimLoop.ts` - owns a mutable `carsRef` advanced every frame and a
  throttled React `snapshot` pushed every ~200 ms. Each car keeps a rolling `history[]` of
  the last 40 speed samples. This is the natural hook point for event detection and for any
  per-snapshot derived metric.
- `frontend/src/store.ts` - Zustand store: `corridorId`, `selectedVehicleId`, `running`,
  `raceNonce` (bump to restart), `incidentAt`, `mapTheme`, `prediction`, `predictLoading`,
  plus `runPrediction()` which POSTs `/predict` and falls back locally.
- `frontend/src/components/MLPredictor.tsx` - the right-hand panel: vehicle selector, live
  telemetry, the RAG/LLM recommendation card, a live leaderboard (already draws per-car
  bars + sparklines + ETA gaps), and the trained-model metrics block.
- `frontend/src/components/HighwayMap.tsx` - Leaflet map, polyline + HOV subline + waypoint
  markers, car markers moved each frame from `carsRef`.

Backend (TypeScript Cloudflare Worker; bindings `env.AI`, `env.VECTORIZE`, `env.DB` (D1),
`env.CONFIG` (KV)):

- `backend/src/index.ts` - routes `/`, `/specs`, `/search`, `/race`, `/leaderboard`,
  `/rag/ingest`, `/predict`. New routes are added here.
- `backend/src/predict.ts` - RAG (Vectorize) retrieve -> `env.AI` generate; model
  `@cf/meta/llama-3.2-3b-instruct`, `max_tokens: 160`.
- `backend/src/agents/driver.ts` - a full per-vehicle DRIVER AGENT: `decide()` returns a
  structured `{action, mode, risk, reason}` via native JSON-schema output, with a
  deterministic persona fallback. It also exports `agentDecideHandler` for a
  `POST /agent-decide` route. IMPORTANT: this handler is written but NOT yet wired into
  `index.ts`. Free reuse.
- `backend/src/agents/persona.ts` - three driver personas (Waymo cautious, BMW aggressive,
  Cybertruck bold-but-heavy) with terse system prompts and risk profiles.
- `backend/src/security.ts` - CORS allowlist, per-IP fixed-window rate limiter in KV, and a
  `RATE_LIMITS` table (`/predict` 20/min, `/rag/ingest` 5/min, `/search` 30/min). Any new
  budget-spending endpoint should be added here.

The three hard free-tier constraints (from `docs/ARCHITECTURE.md`, verified 2026-07-16):

- Workers AI: 10,000 neurons/day. THE binding constraint.
- Worker CPU: 10 ms per invocation (an `env.AI.run` await is I/O, not CPU, so a single AI
  call per request is fine).
- KV writes: 1,000/day (reads 100k/day). Anything write-heavy must NOT live in KV.

Reference neuron costs (from ARCHITECTURE section 4): a ~800-in/120-out driver decision is
~4.2 neurons on Llama 3.2 1B, ~29.5 on Llama 3.1 8B. Output tokens cost ~3x input, so
capping `max_tokens` is the biggest per-call lever.

---

## Shortlist (6)

| # | Feature | AI/ML reuse | Neuron cost | Visual impact | Effort | Verdict |
|---|---------|-------------|-------------|---------------|--------|---------|
| 1 | Live win-probability / odds bars from the ETA model | ML/ETA bands (client) | ZERO | High | S | RECOMMEND |
| 2 | LLM live race commentary (play-by-play) via Workers AI | env.AI + personas | Low (event-gated) | Very high | M | RECOMMEND |
| 3 | Driver-personality chat ("why did you do that?") RAG + AI | reuses agentDecideHandler + RAG | Low-med (per Q) | Medium | S-M | Strong runner-up |
| 4 | Dynamic weather (rain/wind) changing physics + predictions | feeds predict prompt only | Low | High | M | Good, second wave |
| 5 | Ghost replay + shareable seed permalink | none | ZERO | Medium | S | Nice, low-wow |
| 6 | Elevation / grade profile strip | none | ZERO (but DEM dep) | Medium | M-L | AVOID - see note |

Note on #6 (elevation): `docs/ARCHITECTURE.md` section 10 is explicit that OSM has NO
elevation, and that DEM sources disagree by ~14-18 m on the same point while real Interstate
grades are only 1-4% - so DEM noise swamps the actual grade. It also needs an external DEM
API (OpenTopoData 1k/day etc.), i.e. a NEW dependency the rest of the stack avoids. This
directly contradicts the project's own grounding doc. Do not ship it as a novelty feature;
if grade is ever wanted, pre-bake a hand-verified profile per corridor offline instead of
sampling a DEM live.

---

## RECOMMENDATION 1 - Live win-probability / odds bars

One-line rationale: the single most "broadcast TV" moment available, it costs zero neurons,
and the raw material (per-car ETA + `etaLo`/`etaHi` uncertainty band) is ALREADY computed
every frame - so it is pure upside on the free tier.

### What it is

A live win-probability read for each car, updating as the race unfolds: a percentage and a
horizontal bar per car in the leaderboard (e.g. "Cybertruck 61%, BMW 27%, Waymo 12%"),
optionally rendered as decimal/American betting odds for flavor, plus a pre-race "opening
line" shown before the green flag. The bars swing in real time as gaps open and close and as
a car hits a bottleneck - that swing is the emotional hook.

### Why it is compelling

- It turns a leaderboard of ETAs into a live market. Watching a 55/45 flip to 80/20 when the
  BMW clears the Buda stretch is genuinely exciting in a way that a raw ETA is not.
- It makes the existing ML story pay off visibly. Today the panel shows static model metrics
  (accuracy/AUC per car). Odds are the interactive expression of that model: "the model is
  not just a number, it is calling the race live."
- Zero marginal cost. No neurons, no Vectorize queries, no KV writes, no new backend route.
  It cannot break the budget.

### How it uses existing infra

- The engine already emits, per car, `etaSec` plus a real uncertainty band `etaLo`/`etaHi`
  (`engine.ts` lines ~76-81). That band IS a probability distribution over finish time -
  exactly what an odds calculation needs. No new physics.
- The trained ML model (per-car AUC in `data/model_metrics.json`) can optionally set the
  band width or a prior, so the odds are "model-informed" and the metrics block gains a live
  companion. Even without touching the model, the ETA band is enough.

### Implementation sketch

Client-only. No backend changes.

- New pure module `frontend/src/lib/odds.ts`:
  - `winProbabilities(cars: Record<string, VehicleState>): Record<string, number>`.
  - Model each car's remaining finish time as a distribution centered on `etaSec` with spread
    from `(etaHi - etaLo)`. Use a light Monte Carlo (N ~= 500 samples: sample a finish time
    per car, the min wins, tally) OR a closed-form pairwise approximation. 500 draws x 3 cars
    is trivial CPU in the browser and runs on the client, so the 10 ms Worker limit is
    irrelevant.
  - Finished cars are pinned (a car already across the line has locked its order).
  - Export `toDecimalOdds(p)` / `toAmericanOdds(p)` for the flavor display.
- Wire it in `useSimLoop.ts`: compute odds on each ~200 ms snapshot and add to the pushed
  snapshot (or expose a parallel `oddsRef`). This keeps it in lockstep with the leaderboard.
- Store (`store.ts`): add `preRaceOdds` captured once at green flag (in `runPrediction`,
  where `running` is set true) so you can show the "opening line" and, post-race, "closed at".
- UI (`MLPredictor.tsx`): the leaderboard already renders a per-car row with a bar - add a
  win-% pill and a second, distinctly-colored probability bar (or recolor the existing gap
  bar to encode probability). Add a compact "Odds" header toggle for %/decimal/American. A
  subtle count-up animation on the number sells the live-market feel.
- Optional map flourish: a small floating "ODDS" chip over each car marker in `HighwayMap.tsx`.

State added: `preRaceOdds` (and optional `oddsHistory` for a sparkline of the favorite's
probability). Endpoints added: none.

### Effort

Small. ~0.5-1 day. The hardest part is choosing a defensible distribution model; a normal or
triangular over `etaLo..etaHi` with a Monte Carlo min is more than good enough and is ~30
lines. Everything else is presentation inside components that already exist.

### Free-tier cost

None. Entirely client-side: zero neurons, zero Vectorize, zero KV, zero D1. It cannot
threaten any budget. This is the safe half of the pair.

---

## RECOMMENDATION 2 - LLM live race commentary (play-by-play)

One-line rationale: the most experientially striking feature on the table - it turns a map
animation into a live broadcast using the `env.AI` binding and personas already wired, and it
stays cheap by firing on race EVENTS, never per tick.

### What it is

A live commentary ticker that narrates the race: "Green flag on I-45. Cybertruck jumps to an
early lead... BMW is reeling it in through the Gulf Freeway merge... Waymo plays it safe and
lets them fight." Lines appear on notable events - lead change, an overtake, hitting a
bottleneck/incident, entering the HOV lane, a car finishing - in the voice of a race
commentator (optionally colored by each car's persona from `persona.ts`).

### Why it is compelling

- It is the difference between "a dot moving on a map" and "a race you are watching." Paired
  with Recommendation 1, you get odds + commentary = a genuine broadcast overlay. That
  pairing is the pitch: two features that reinforce each other into one "race day" experience.
- It is the marquee use of Workers AI in the product's front window - the AI binding stops
  being a backend detail (`/predict`) and becomes the thing users watch.
- It reuses the persona system already written for the driver agents, so the commentary can
  reference each car's character consistently (Waymo cautious, BMW aggressive, Cybertruck
  bold-but-heavy) without new content design.

### How it uses existing infra

- `env.AI` is already bound and already called from `predict.ts` and `driver.ts` - one more
  handler, same pattern (`env.AI.run(model, { messages, max_tokens })`).
- `persona.ts` supplies the character voices; a small commentator system prompt plus the
  persona blurbs is all the prompt engineering needed.
- `security.ts` already has the rate-limit table and KV limiter - add `/commentary` to
  `RATE_LIMITS`.
- Optionally RAG (Vectorize) for one flavorful, spec-grounded line ("the 6,600 lb Cybertruck
  is muscling past") - but keep RAG OFF the hot commentary path; only use it for the pre-race
  intro line to avoid per-event Vectorize queries.

### Implementation sketch

- Event detection (client, no cost): in `useSimLoop.ts`, diff the previous snapshot against
  the new one every ~200 ms to emit discrete events: `lead_change`, `overtake`,
  `enters_bottleneck` (progress crosses a known bottleneck fraction), `incident` (already in
  store as `incidentAt`), `hov_entry`, `finish`, `green_flag`. Debounce so you emit at most
  one commentary request every few seconds.
- New store slice (`store.ts`): `commentary: {id, text, ts}[]` (cap ~20), plus
  `requestCommentary(event, standings)` that POSTs to the backend and unshifts the result.
- New backend route `POST /commentary` in `index.ts`, handler in a new
  `backend/src/agents/commentator.ts`:
  - Body: `{ corridorId, event, standings: [{vehicleId, rank, gapSec}] }`.
  - System prompt: a terse motorsport commentator; user message: the event + standings.
  - Model: `@cf/meta/llama-3.2-1b-instruct` (routine) or reuse the existing 3B; `max_tokens`
    ~= 48 (one or two sentences). Output tokens dominate cost, so cap hard.
  - Cache: quantize the event into a key (event type + rank order + coarse gap bucket) and
    cache the line. A race replays similar situations, so a modest hit rate cuts calls. Put
    the cache in KV ONLY if writes stay well under budget (see below); otherwise skip caching
    - the per-race call count is already low - or cache in memory per race.
  - Add `/commentary` to `RATE_LIMITS` (e.g. 30/min) to protect the neuron budget.
- UI: a commentary ticker component (scrolling list) either under the map or as a translucent
  overlay strip across the top of `HighwayMap.tsx`. New lines fade in. Optional TTS via the
  browser `speechSynthesis` API (free, client-side) for an audio call - high wow, zero cost.

State added: `commentary[]`. Endpoints added: `POST /commentary`.

### Effort

Medium. ~1.5-2.5 days. Event detection and debouncing is the fiddly part (getting clean,
non-spammy events out of the snapshot diff). The Worker handler is a near-copy of
`predict.ts`. The ticker UI is straightforward.

### Free-tier cost (be honest)

This is the feature that touches the neuron budget, so size it carefully.

- Per-event call: input ~200-300 tokens, output capped ~40-48 tokens. That is smaller than
  the driver-decision benchmark (~800 in / 120 out = ~4.2 neurons on 1B), so estimate
  ~2-3 neurons/call on Llama 3.2 1B, or ~8-12 neurons/call on the 3B model.
- Events per race: gate to the notable ones and debounce -> ~8-12 commentary lines/race.
- Per race: ~20-35 neurons on 1B, or ~80-140 neurons on 3B.
- Daily budget 10,000 neurons -> ~300+ races/day on 1B, ~70-100 races/day on 3B, BEFORE any
  caching. That is comfortably within the free tier for a hobby deploy.

Keeping it cheap (in priority order):
1. Event-gated, never per tick, with a hard debounce (>= a few seconds between calls). This
   is what makes the feature possible at all - the same lesson as the driver agents.
2. `max_tokens` ~= 48. Output is ~3x the price of input; short calls dominate the savings.
3. Prefer Llama 3.2 1B for routine lines; only escalate to 3B for the pre-race intro / finish.
4. Optional quantized cache. WATCH THE KV WRITE LIMIT: 1,000 writes/day. At ~10 cache-miss
   writes/race that is ~100 races/day before KV (not neurons) becomes the ceiling. Given how
   cheap the calls already are, an in-memory per-race cache (or no cache) is the safer choice
   than burning the scarce KV write budget - consistent with ARCHITECTURE section 4.1's
   warning that the decision cache does NOT belong in KV.
5. Keep RAG/Vectorize off the per-event path; use it at most once per race for the intro.

---

## Why these two, together

They are the deliberate pairing of one zero-cost, high-certainty win (odds) with one
higher-wow, budget-aware feature (commentary), and together they form a single coherent
"race broadcast" experience rather than two unrelated toggles:

- Recommendation 1 is guaranteed-safe: no neurons, no new endpoint, reuses the ETA band that
  is already computed. It ships even if the AI budget were zero.
- Recommendation 2 is the showcase for the Workers AI + persona infra already in the repo,
  and the honest neuron math shows it fits the free tier with wide margin when event-gated.

Runner-up worth noting: driver-personality chat (#3) is the cheapest way to surface the
ALREADY-WRITTEN `agentDecideHandler` (`POST /agent-decide` is coded but unwired in
`index.ts`). If a third feature is wanted with minimal new code, wire that route and add a
"ask the driver" popover on each car marker - it reuses `decide()`, the personas, and RAG
verbatim. It ranks third only because it is user-initiated (less passively striking) than a
live commentary ticker.

---

## Suggested build order for the next deploy

1. Recommendation 1 (odds) first - small, self-contained, zero risk, immediately lifts the
   existing leaderboard.
2. Recommendation 2 (commentary) second - lands on top of the odds work and shares the same
   snapshot/event plumbing in `useSimLoop.ts`.
3. If time remains: wire `POST /agent-decide` and add the driver-chat popover (#3).
