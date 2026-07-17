# SimZoner — Architecture

Race simulation between Cybertrucks, BMWs, and racecars across US highways, starting with
Texas routes (I-35 south of Austin, I-45 Houston→Galveston). Runs entirely on Cloudflare's
free tier.

Every platform limit in this document was verified against Cloudflare's live docs on
2026-07-16. Links are included so they can be re-checked — these numbers change.

---

## 1. The two ideas that shape everything

### Physics is deterministic. Language is not.

A race between a 6,600 lb Cybertruck and a 3,900 lb BMW M3 down I-45 is decided by mass,
drag, power, gearing, and traffic. That's arithmetic, and arithmetic has exactly one right
answer. A language model asked to compute it would be guessing — slower, more expensive, and
wrong in ways no test can catch.

So the race engine is plain TypeScript. Given the same seed and the same inputs, it produces
the same result every time. That property is what makes the sim debuggable, testable, and
replayable.

### The LLM sets policy. The engine executes it.

The AI is not removed — it's put where it's actually good. Each car gets a **driver agent**
with a personality and a risk profile. It doesn't compute physics; it makes *judgment calls*:
when to commit to a pass, how hard to run the Buda stretch, whether to risk traffic near the
Galveston causeway.

The agent returns a **policy** — "aggressive until mile 12, then conserve" — and the physics
engine plays it out over thousands of ticks.

This is not a compromise. It is the only shape that fits the free tier, and it's better
design regardless. See §4 for the arithmetic that forces it.

---

## 2. Component map

```
┌─────────────────────────────────────────────────────────┐
│  Pages — static UI, race replay viewer                  │
│  unlimited bandwidth · 500 builds/month                 │
└───────────────────────┬─────────────────────────────────┘
                        │ fetch
┌───────────────────────▼─────────────────────────────────┐
│  Worker — API / orchestrator                            │
│  100k req/day · ⚠ 10ms CPU per invocation               │
└──┬──────────┬──────────┬──────────┬─────────────────────┘
   │          │          │          │
   │   ┌──────▼──────┐   │   ┌──────▼──────┐
   │   │ Vectorize   │   │   │     D1      │
   │   │ spec + road │   │   │ results,    │
   │   │ retrieval   │   │   │ catalog,    │
   │   │ (once/race) │   │   │ leaderboard │
   │   └─────────────┘   │   └─────────────┘
   │                     │
┌──▼──────────────────┐  │  ┌──────────────────────────┐
│ Durable Object      │  └──►  env.AI.run()            │
│ (SQLite-backed)     │     │  driver agents           │
│ race state +        │     │  ⚠ 10k neurons/day       │
│ physics loop        │     └──────────────────────────┘
│ + hot decision cache│
│ 1 DO per race       │     ┌──────────────┐  ┌────────────┐
└─────────────────────┘     │      KV      │  │     R2     │
                            │ warm config, │  │  replay    │
                            │ spec lookups │  │  blobs     │
                            │ ⚠ 1k writes/d│  │  10 GB     │
                            └──────────────┘  └────────────┘
```

| Component | Role | Why it's here |
|---|---|---|
| **Pages** | UI, replay viewer | Free, unlimited bandwidth |
| **Worker** | API, orchestration | Entry point; 10ms CPU means it delegates, never computes |
| **Durable Object** | Race state + physics + **hot cache** | Authoritative single-threaded state; SQLite-backed DOs are free-tier eligible. 100k SQL writes/day — see §4.1 |
| **Workers AI** | Driver agents, embeddings | Inference only — see §5 |
| **Vectorize** | Spec + highway retrieval | Semantic lookup at race *setup*, never in the loop |
| **D1** | Catalog, results, leaderboards | Relational, exact-match data |
| **KV** | Warm config, spec lookups, static reads | Read-optimized: 100k reads/day but **only 1k writes/day**. Read-mostly data only — see §4.1 |
| **R2** *(optional)* | Replay blobs | 10 GB free, egress free; only if replays outgrow DO storage |

---

## 3. Verified free-tier limits

| Service | Limit | Headroom for us |
|---|---|---|
| Workers | 100k req/day · **10ms CPU** · 3 MB gzip | CPU is a real constraint |
| Workers AI | **10,000 neurons/day** | **The binding constraint** |
| Vectorize | 5M stored dims · 30M queried/mo · 1,536 max dims | Ample |
| D1 | 500 MB/db · 5M rows read/day · 100k written/day · **50 queries per invocation** | Ample if we batch |
| **KV** | 100k reads/day · **1,000 writes/day** · 1 GB · 512 B key · 25 MiB value · **1 write/sec to same key** | **Writes are tight — see §4.1** |
| Durable Objects | SQLite-backed only · 100k req/day · 13,000 GB-s/day · 5M SQL reads/day · **100k SQL writes/day** · 5 GB | Free tier confirmed |
| R2 | 10 GB · 1M Class A ops/mo · 10M Class B ops/mo · **egress free** | Ample |
| Pages | 500 builds/mo · unlimited bandwidth | Ample |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) ·
[Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) ·
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) ·
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

**Three of these matter: neurons, CPU, and KV writes.** Storage, request counts, Vectorize, R2,
and Pages bandwidth are all far beyond hobby scale — don't spend effort optimizing them.

---

## 4. The neuron budget — the number that drives the design

Workers AI bills per *token*, not per request. A driver decision at ~800 input + ~120 output
tokens costs roughly:

| Model | Neurons/decision | Races/day (6 cars × 20 decisions) |
|---|---|---|
| Llama 3.2 1B | ~4.2 | **~20 races/day** |
| Llama 3.1 8B | ~29.5 | **~2.8 races/day** |
| Llama 3.3 70B | ~46 | ~1.8 races/day |

**~3 races/day on an 8B model is the honest headline.**

Now the arithmetic that kills the naive design: a 10-minute race at 10 Hz is 6,000 ticks. Six
cars = 36,000 LLM calls ≈ **1,000,000 neurons — 100× over the daily budget.** An LLM call per
tick is not "expensive," it's structurally impossible.

**Mitigations, highest leverage first:**

1. **Policy, not per-tick decisions.** One call returns a strategy; physics runs it for
   thousands of ticks. Orders of magnitude fewer calls, and the race stays deterministic.
2. **Decide at segment boundaries or on trigger events** (car within X meters, exit
   approaching) — ~20 decision points per race, not 6,000.
3. **Cap `max_tokens` at ~64–100** and demand terse JSON: `{"action":"pass","risk":0.7}`.
   Output tokens cost ~3× input, so this is the biggest per-call lever.
4. **Llama 3.2 1B for routine calls**, escalate to 8B only for high-stakes moments. ~7× more
   races/day.
5. **Cache quantized states.** Bucket (gap, closing speed, lane, risk profile) into a discrete
   key. Driver situations repeat heavily within a race. **Put this cache in DO SQLite, not KV —
   see §4.1.**
6. **AI Gateway** in front — free on all plans, dedupes identical prompts.

### 4.1 Where the cache lives — KV's write limit is a trap

KV's free tier is **100,000 reads/day but only 1,000 writes/day** — a 100:1 ratio. It is built
for read-mostly data, and a decision cache is write-heavy on every miss. Do the arithmetic
before assuming KV works:

| Scenario | Decisions/day | Cache misses @ 60% hit rate | vs KV's 1k writes/day |
|---|---|---|---|
| Llama 3.1 8B (~3 races/day) | ~120 | ~48 writes | Fine |
| **Llama 3.2 1B (~20 races/day)** | **~2,400** | **~960 writes** | **At the limit** |

**Note the trap:** switching to the 1B model is mitigation #4 — the very thing that buys ~7×
more races/day. But it multiplies cache writes by the same factor and lands you flush against
KV's ceiling. **The optimization that relieves the neuron budget is the one that breaks the KV
budget.** Add a cold-start day (0% hit rate) or a lower hit rate than assumed and you're over.

Also note **1 write/sec to the same key** — a hot key under concurrent races will throttle.

**Decision:**

| Data | Store | Why |
|---|---|---|
| Hot LLM decision cache | **DO SQLite** | 100k writes/day — 100× KV's headroom, and it's already the DO's own state |
| Vehicle specs, route config, static lookups | **KV** | Written once, read constantly — exactly KV's shape |
| Race results, leaderboards | **D1** | Relational, queryable |
| Replay blobs | **R2** | Large, immutable, free egress |

KV stays in the stack — pointed at read-mostly data where its 100k reads/day is genuinely
useful. It just isn't the decision cache.

---

## 5. Workers AI is inference-only

Verified against Cloudflare's docs. **There is no training on Cloudflare.**

- **LoRA fine-tuning is bring-your-own-adapter.** You train the adapter *elsewhere* and upload
  it to run fine-tuned *inference*. Cloudflare's own tutorial points to an external service for
  the training step. Limits: rank ≤ 8, <300 MB, ≤100 adapters/account, base model must not be
  quantized. Free during open beta — explicitly temporary, so don't architect a dependency on it.
  ([docs](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/))
- **AI Gateway does not change this.** It's observability and caching — analytics, logging,
  rate limiting, retries. No training capability.

**Consequence:** driver behavior comes from **prompting + persona + RAG over real specs**, not
from trained weights. This is what the Vectorize layer is for.

---

## 6. Where LangChain fits — narrowly, and deliberately

`@langchain/cloudflare` (v1.1.0, published 2026-06-17) is real and maintained. But its classes
are not equally useful here, and the split matters:

**Use it for retrieval:**
- `CloudflareVectorizeStore` — binding-native, takes the `VectorizeIndex` binding directly
- `CloudflareWorkersAIEmbeddings` — binding-native, takes the `Ai` binding

These are genuinely pleasant and give us clean document/retrieval abstractions for the spec corpus.

**Do not use it for the driver agents:**

`ChatCloudflareWorkersAI` has two disqualifying problems, read from the published type
definitions:

1. **It doesn't use the binding.** It calls the Cloudflare REST API over HTTP with an account ID
   and API token — meaning the Worker leaves Cloudflare and re-enters over the network. That's a
   subrequest, added latency, and a secret to manage. `env.AI` is an in-process call with none
   of that.
2. **It extends `SimpleChatModel`** — no `bindTools`, no `withStructuredOutput`, no tool-call
   support. For agents that must emit structured tactical decisions, we'd take the dependency
   and *still* hand-parse JSON out of raw text.

**So: `env.AI.run(model, { messages, response_format })` directly for generation.** One line,
zero bundle cost, no secrets, native JSON mode. On a 10ms CPU budget, every millisecond of
framework overhead is taken from physics.

**And note:** LangChain has no training capability whatsoever — no gradients, no weight updates.
It's a composition layer over inference APIs. Any "learning" it appears to do is retrieval or
prompt context, not parameter updates.

---

## 7. Embeddings

| Model | Dims | Vectors within 5M free stored-dims |
|---|---|---|
| **`@cf/baai/bge-small-en-v1.5`** ← recommended | 384 | ~13,020 |
| `@cf/baai/bge-base-en-v1.5` | 768 | ~6,510 |
| `@cf/baai/bge-large-en-v1.5` | 1,024 | ~4,882 |

No embedding model exceeds Vectorize's 1,536-dim cap, so dimensions are not a constraint —
budget is. **`bge-small` is 4× cheaper on every Vectorize axis and 10× cheaper in neurons** than
`bge-large`. Our corpus (vehicle specs, highway segments) is small and domain-specific;
retrieval quality won't be the bottleneck.

Indexing the *entire* corpus (~1,000 chunks × ~100 tokens) costs **~184 neurons — under 2% of
one day's budget.** Index once, reuse forever.

`wrangler vectorize create <name> --preset @cf/baai/bge-small-en-v1.5` sets dimensions automatically.

---

## 8. The 10ms CPU problem

A full race simulation **will not fit in 10ms of CPU** in a plain Worker. Three options, in
order of preference:

1. **Client-side replay (most attractive).** A deterministic engine replays identically from a
   seed. Ship the seed + decision log to the browser and replay there: zero server CPU, instant
   scrubbing, and the Worker only handles LLM decisions + persistence.
2. **Physics in the Durable Object,** driven by alarms. DOs appear to get a far higher CPU
   ceiling than plain Workers — but see the open question below.
3. **Chunk the simulation** across multiple invocations.

**Recommended: (1) + (2).** The DO holds authoritative state and computes the canonical result;
the browser replays it for viewing.

---

## 9. Open questions — verify before relying on

1. **DO CPU limit on the *free* plan.** The docs state 30s default CPU per request for DOs, and
   the 10ms Worker limit appears not to apply — but the page doesn't cleanly separate free from
   paid on this axis, and 30s on free would be surprising given Workers get 10ms. **This is
   load-bearing for §8 option 2. Verify empirically before committing.**
2. **Vectorize per-query dimension accounting.** Whether a query bills only the query vector or
   something scan-related isn't documented. Directionally fine, not exact.
3. **Bundle size against the 3 MB gzip cap.** Not measured — npm unpacked sizes aren't a proxy
   for tree-shaken reality. Measure once there's a real build.

**One known stale doc:** LangChain's Vectorize page lists a "Cloudflare paid plan" requirement.
This predates Vectorize's free tier — trust Cloudflare's pricing page.

---

## 10. Data grounding

Audited 2026-07-16. **The project runs on mock/synthetic data by decision** — the audit
confirms that's the only honest option, not a shortcut.

### There is no real race telemetry. This is settled.

No public dataset exists of Cybertrucks, BMWs, or Waymos running these routes. Waymo's public
releases are **perception sensor data from Phoenix and SF** — for training self-driving
perception, not vehicle dynamics — and Waymo does not race. **No labeled race outcomes exist,
so supervised training on real races is infeasible.** That conclusion is independent of any
Cloudflare limitation; the labels simply don't exist.

### Vehicle specs are real — but asymmetrically so

| | BMW | Cybertruck |
|---|---|---|
| Drag coefficient | **Published** | Secondary sources only |
| **Frontal area** | **Published** | **Not published — must estimate** |
| Curb weight | Published | Secondary sources only |
| Power / torque | Published | Secondary sources only |

BMW's **German** press sheets publish `Luftwiderstand cX x A` — drag coefficient *and*
reference area as a pair. Verified from the M5 (G90) media sheet: **Cd 0.32, frontal area
2.55 m²**, along with 2435 kg DIN kerb weight, 535 kW, 1000 Nm, 0–100 in 3.5 s.
([source](https://www.press.bmwgroup.com/deutschland/article/detail/T0443252DE/der-neue-bmw-m5))

This matters more than it looks: **frontal area is normally the biggest guess in the road-load
model**, usually approximated as `0.84 × track × height`. Having a cited figure replaces that
estimate with a real number. Note it's the *German* sheets — US releases publish Cd but omit
the area.

**Caveats to carry, not bury:**
- BMW's sheets state the figures are **preliminary** (*"vorläufige Werte"*).
- **Cybertruck frontal area is genuinely unpublished** and must be estimated. Its Cd and weight
  are secondary-sourced (tesla.com blocks automated fetches).
- **Therefore the Cybertruck side of any matchup carries materially more parameter uncertainty
  than the BMW side.** The sim must not present both vehicles as equally well characterized.
  Surface per-vehicle confidence in the UI.
- Unverified: whether M3/M4 sheets carry `cX x A`, and how consistently it appears across the
  non-M range.

### Highway geometry — and the elevation trap

**OpenStreetMap has no elevation data.** Not sparse — absent. The OSM data model has **no Z
coordinate**, and across ~1.36M `highway=motorway` ways planet-wide, the `ele` key does not
appear at all. `incline` covers ~0.17%.

⚠️ **Do not mistake `layer` (35.6% of motorways) or `bridge` (32.7%) for elevation.** They
encode topological stacking order — which road crosses over which — not height.

What OSM *does* give us, well-populated on motorways: `oneway` 99.7%, `ref` 97.1%, `lanes`
87.2%, `name` 77.2%, `surface` 66.3%, `maxspeed` 65.8% (string values like `"55 mph"` — needs
parsing).

**Grades therefore need a separate elevation source (DEM), and the choice is load-bearing:**

| Source | Resolution | Limits |
|---|---|---|
| **USGS EPQS** | 1 m | Accuracy choice; one point per call |
| **OpenTopoData `ned10m`** | ~10 m (US) | 100 pts/call, 1 call/s, 1k/day; self-hostable |
| Open-Elevation | unstated | 1k req/month; DEM source unverified |

**The trap:** DEM sources disagree by **~14–18 m on the same point** (reproduced independently
in Austin and Dallas), while **real Interstate grades are only 1–4%**. Pick carelessly and DEM
error swamps the actual grade. Use a US-native DEM, and sample at spacing wide enough that DEM
noise doesn't dominate. Pair `ned10m` for bulk profiling with EPQS to spot-check.

**Bulk extraction:** use Geofabrik regional `.osm.pbf` extracts, not the public Overpass API —
Overpass timed out on ~5 of 6 attempts under load. Overpass is fine for spot queries.

### Licensing

- **OSM is ODbL** — requires attribution ("© OpenStreetMap contributors") and share-alike.
  ODbL distinguishes a *Derived Database* from a *Produced Work*. Extracted highway geometry is
  a Derived Database and is encumbered; **whether simulation output counts as a Produced Work
  (and is therefore unencumbered) is unverified** — confirm before relying on it.
- **Vehicle trademarks:** see `docs/SIMULATION_RULES.md`. We hold no license from BMW, Tesla, or
  Waymo. Referring to a vehicle by name to describe it is ordinary descriptive use; using logos
  or implying endorsement is not. Not legal advice.
