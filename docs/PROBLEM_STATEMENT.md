# SimZoner — Problem Statement & Use Case

---

## 0. The honest version, first

**SimZoner is a portfolio and learning project. It is not a product, and it does not solve a
commercial problem.** Nobody is waiting for a Cybertruck-versus-BMW simulator, no market is
underserved by its absence, and no revenue depends on it existing.

That statement is here on purpose, at the top, because the alternative is worse. A problem
statement that invents a market — "the $47B automotive simulation sector," "fleet operators need
route-level performance modeling" — would be fiction, and anyone technical reading it would
recognize the fiction immediately and discount everything after it. The project is genuinely
interesting. It doesn't need a fake justification, and one would actively cost it credibility.

So this doc answers the real questions: **what is this actually for, who actually looks at it,
and what does it actually prove?**

---

## 1. What the project really is

A deterministic vehicle physics simulator, running on edge infrastructure, under hard free-tier
constraints, with LLM-driven tactical agents and a learned outcome model — all built with
explicit honesty about what the numbers mean.

The racing is the *subject matter*. It is not the point. The point is the engineering problem
underneath, and the subject matter was chosen well: it's concrete, it's physically grounded, it
produces a visible artifact, and it's genuinely fun to reason about. Those are good properties
for a learning project and they're why this one is likely to get finished.

---

## 2. Who this is for

| Audience | What they get | Real? |
|---|---|---|
| **The developer (primary)** | Hands-on work with edge distributed systems, constraint-driven design, LLM orchestration, and honest ML evaluation | **Yes — this is the actual user** |
| **Technical evaluators** (recruiters, collaborators, reviewers) | Evidence of engineering judgment, not just the ability to wire APIs together | **Yes** |
| **The curious** (car enthusiasts, students) | An intuition pump for EV-vs-ICE physics tradeoffs | Mildly — a real but small side benefit |
| **Fleet operators / automotive industry / researchers** | Nothing. The data is mock. | **No. Don't claim this.** |

**The primary user of a portfolio project is the person building it.** That's not a lesser
answer — it's the accurate one, and designing around it changes decisions. It means finishing
matters more than scaling. It means the docs are part of the deliverable, not overhead. It means
a bug that teaches something is worth more than a feature that doesn't.

---

## 3. The problems it actually solves

These are real problems. They're engineering problems, not market problems, and each one has a
concrete artifact attached.

### 3.1 Building something real inside hard resource limits

The free tier isn't a budget suggestion — it's a wall. **10,000 neurons/day. 10ms of CPU per
Worker invocation. 1,000 KV writes/day.** Every one of those forced a genuine design decision
(ARCHITECTURE §4, §4.1, §8), and the design is *better* for it:

- The neuron budget forced "LLM sets policy, physics executes" — which also preserved
  determinism, a property an LLM in the tick loop would have destroyed.
- The 10ms CPU limit forced physics into a Durable Object or a seed-replay in the browser —
  which also made races shareable as a seed instead of a video.
- The KV write limit exposed a trap where the fix for one constraint breaks another.

**Designing under real constraints is the skill.** Anything runs when resources are infinite.

### 3.2 Knowing where AI belongs — and where it doesn't

The instinct to put an LLM everywhere is common and expensive. This project draws the line
explicitly:

| Task | Tool | Why |
|---|---|---|
| Who wins the race | **Physics** | Arithmetic has one right answer. An LLM would guess. |
| When to commit to a pass | **LLM** | Judgment under ambiguity — genuinely what they're good at |
| What's the M5's drag coefficient | **RAG / Vectorize** | Retrieval of a known fact, not generation |
| Predicting outcomes from features | **Logistic regression** | A dot product that fits in 10ms |

**Choosing the boring tool where it's correct is a senior move**, and it's the thing most
LLM-era projects get wrong.

### 3.3 Being honest about what a number means

The learned model will report an accuracy. That number is a statement about our own TypeScript —
how well a regression recovered a formula we wrote, under noise we chose. It says nothing about
real Cybertrucks (ML_APPROACH §1.3).

The project ships that caveat in the UI rather than burying it. **The discipline of labeling your
own results honestly — especially when the unlabeled version looks more impressive — is rarer
than it should be**, and it's the thing that separates engineering from demo-making.

### 3.4 Working from verified facts instead of plausible ones

Every platform limit in these docs carries a source link. Every invented value is tagged
`[MOCK]`. Every unverified claim sits in an open-questions section instead of being smoothed over.

This caught real things:
- OSM has **no elevation data at all** — and `bridge`/`layer` tags look like elevation but encode
  stacking order. That misreading would have silently corrupted every grade calculation.
- Elevation sources disagree by **14–18m** while real Interstate grades are **1–4%** — pick
  carelessly and the error swamps the signal.
- LangChain's `ChatCloudflareWorkersAI` **can't do tool calling** — a week-2 discovery if
  unverified.
- **I-45's HOV lane ends at Webster**, not Galveston.

**Each of those was found by checking instead of assuming.** That's the habit the project is
really practicing.

---

## 4. The use case, concretely

A user opens the site and picks a matchup — Cybertruck vs BMW — and a route, say I-45 Houston to
Galveston. Each vehicle gets a driver personality. They hit start.

The Worker retrieves vehicle specs and route data from Vectorize, asks each driver agent for a
strategy, and hands that policy to the physics engine in a Durable Object. The race runs
deterministically. The browser replays it from a seed. The learned model shows a pre-race
prediction next to its confidence — labeled as a synthetic benchmark.

Partway down I-45, **the HOV lane ends at Webster.** Everyone re-merges. Strategy that depended
on it evaporates.

The result is saved with its seed. Anyone with that seed replays the identical race.

**What makes it interesting to watch:** speed is capped at limit+10, so on TX-130's 85 mph the cap
pins all three vehicles to exactly 95 — the M3's 60+ mph top-end advantage is worth precisely
zero. The race is decided by mass on grades, drag at speed, traffic navigation, and lane access.
**The cap is what creates the need for a simulation at all** — without it, the race is a
spec-sheet lookup.

---

## 5. What success looks like

**Success:** it's finished, deployed, and free-tier stable. The physics are defensible from
published specs. The model beats its naive baseline on a test set that was never touched, and its
number is labeled honestly. The docs let a stranger understand the decisions. It's a thing that
can be shown.

**Not success:** more highways nobody drives. A bigger model that doesn't fit the CPU budget. An
accuracy number tuned until it looked good. Real-data claims the mock data can't support.

---

## 6. What this project explicitly does not claim

- ❌ Not a prediction of real-world vehicle performance
- ❌ Not trained on real telemetry — **none exists publicly for these vehicles on these routes**
- ❌ Not affiliated with, endorsed by, or licensed from BMW, Tesla, or Waymo
- ❌ Not a driving safety tool, and not advice about how to drive
- ❌ Not a commercial product

**On the vehicle names:** naming a vehicle to describe it is ordinary descriptive use — the same
reason reviews and racing games say "BMW M3" freely. Logos and implied endorsement are a different
thing, and we use neither. This is a non-commercial project on mock data. *Not legal advice; if it
ever goes commercial, ask someone qualified.*

**On speed:** the sim caps at limit+10 and models legal driving. It is a physics toy, not an
argument about how anyone should drive on I-35.

---

## 7. Why the constraints are the feature

Every limit made the project better:

| Constraint | Forced | Made it better |
|---|---|---|
| 10k neurons/day | LLM sets policy, not per-tick calls | **Determinism preserved** |
| 10ms Worker CPU | Physics in DO / seed-replay in browser | **Races shareable as a seed** |
| 1k KV writes/day | Hot cache in DO SQLite | **Found a trap before it bit** |
| No real telemetry | Mock data, labeled | **Honest scope, no fake claims** |
| No training on Cloudflare | sklearn locally, export weights | **A simpler, portable model** |
| Speed capped at +10 | Strategy over top speed | **The reason the sim is interesting** |

An unconstrained version of this project — infinite compute, real telemetry, no speed cap — would
be a worse project *and* a more boring one. The last row is the clearest case: without the cap,
the fastest car wins and there's nothing to simulate.
