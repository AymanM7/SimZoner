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
│ 1 DO per race       │
└─────────────────────┘
```

| Component | Role | Why it's here |
|---|---|---|
| **Pages** | UI, replay viewer | Free, unlimited bandwidth |
| **Worker** | API, orchestration | Entry point; 10ms CPU means it delegates, never computes |
| **Durable Object** | Race state + physics | Authoritative single-threaded state; SQLite-backed DOs are free-tier eligible |
| **Workers AI** | Driver agents, embeddings | Inference only — see §5 |
| **Vectorize** | Spec + highway retrieval | Semantic lookup at race *setup*, never in the loop |
| **D1** | Catalog, results, leaderboards | Relational, exact-match data |
| **R2** *(optional)* | Replay blobs | 10 GB free; only if replays outgrow DO storage |

---

## 3. Verified free-tier limits

| Service | Limit | Headroom for us |
|---|---|---|
| Workers | 100k req/day · **10ms CPU** · 3 MB gzip | CPU is a real constraint |
| Workers AI | **10,000 neurons/day** | **The binding constraint** |
| Vectorize | 5M stored dims · 30M queried/mo · 1,536 max dims | Ample |
| D1 | 500 MB/db · 5M rows read/day · 100k written/day · **50 queries per invocation** | Ample if we batch |
| Durable Objects | SQLite-backed only · 100k req/day · 13,000 GB-s/day · 5 GB | Free tier confirmed |
| Pages | 500 builds/mo · unlimited bandwidth | Ample |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) ·
[Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) ·
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

**Only two of these matter: neurons and CPU.** Everything else is far beyond hobby scale.
Don't spend effort optimizing storage or request counts.

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
   key. Driver situations repeat heavily within a race.
6. **AI Gateway** in front — free on all plans, dedupes identical prompts.

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

*Pending — the data availability audit is still in progress. This section will record what
real vehicle and highway data actually exists, what's licensed for use, and what that means
for any ML component. See `docs/CONTEXT.md` once written.*

The working assumption, to be confirmed or refuted: **vehicle specifications are real and
published** (curb weight, drag coefficient, power, EPA consumption) and feed the physics engine
directly. **Real-world race telemetry for these vehicles on these highways likely does not
exist publicly** — which is what rules out supervised training on race outcomes, independent of
any platform limitation.
