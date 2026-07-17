# SimZoner — ML Approach

**Scope:** a learned outcome model for two cars. What it is, what it can honestly claim, and
how it ships inside a 10ms Worker.

**Companion docs:** `docs/ARCHITECTURE.md` (§5–§6 cover Workers AI and LangChain), `docs/CONTEXT.md`
(data grounding, pending).

The ask that started this was: *"use langchain for 2 cars of ur choice, train it with 70-75
percent accuracy."* The instinct behind it is right — two cars, learned behavior, a number that
proves it works. This doc is that project, built the way it actually works. Three things in the
original framing need to change, and each change makes the result stronger, not weaker.

---

## 1. Three corrections, up front

### 1.1 LangChain does not train models

LangChain is an orchestration and composition layer over inference APIs — chains, agents, RAG,
structured output, retrievers. There are no gradients and no weight updates anywhere in it. Any
"learning" it appears to do is retrieval or prompt context, not parameter updates. This is
settled fact, not a matter of configuration or version.

That's the whole correction. It doesn't mean LangChain is out of the project — it means it's in
a different part of the project.

**Where LangChain does belong here: the Vectorize RAG layer.**

| Class | Verdict | Why |
|---|---|---|
| `CloudflareVectorizeStore` | **Use** | Binding-native — takes the `VectorizeIndex` binding directly |
| `CloudflareWorkersAIEmbeddings` | **Use** | Binding-native — takes the `Ai` binding |
| `ChatCloudflareWorkersAI` | **Avoid** | REST-only (no binding), and extends `SimpleChatModel` — no `bindTools`, no `withStructuredOutput` |

The two retrieval classes are good code and give the spec corpus clean document/retriever
abstractions for free. `ChatCloudflareWorkersAI` is the one to skip: it leaves Cloudflare and
re-enters over HTTP with an account ID and API token (a subrequest, latency, and a secret to
manage) and it still can't emit structured output, so you'd take the dependency and hand-parse
JSON anyway. Use `env.AI.run(...)` directly for generation. See ARCHITECTURE §6.

**The training happens in Python, locally, with sklearn** — which you've already done before.
That's §5.

### 1.2 A pre-specified accuracy target is backwards

Accuracy is a *measurement*, not a *setting*. "Train it to 70-75%" reads like a knob, but there
is no knob — there's a dataset, a model, and whatever number falls out when you evaluate on data
the model has never seen. You don't choose it any more than you choose the reading on a
thermometer.

Inverting that has a specific, well-known failure mode. If you have a target number and you keep
adjusting — features, hyperparameters, noise level, the split — until the *test* score lands in
the window, you have **leaked the test set**. The test set stops being a held-out estimate of
generalization and becomes just another thing you fit to. The reported number goes up. The real
performance doesn't. This is the single most common way honest people ship models that don't
work.

The discipline that prevents it:

| Split | Size | Used for | Touched how often |
|---|---|---|---|
| **Train** | ~70% | Fitting weights | Constantly |
| **Validation** | ~15% | Model choice, hyperparameters, feature decisions, noise calibration | Freely — this is what it's for |
| **Test** | ~15% | The final reported number | **Once, at the end.** Then it's burned. |

Everything you'd want to tune against a target, tune against **validation**. Test gets looked at
when you're done, and whatever it says is what you report. If you look at test and then go change
something, you no longer have a test set — you have a second validation set, and you need a fresh
holdout before you can quote a number again.

**The honest alternative:** train, measure, report whatever it is.

- **Comes out 91%?** That's *information*, and it's not a victory — it almost certainly means the
  synthetic task is too easy. Not enough injected noise, or a feature that trivially encodes the
  answer. The fix is to make the world harder (§5.1), not to celebrate.
- **Comes out 55%?** Also information. Either the noise dominates the signal, or the features
  don't carry it, or logistic regression is too rigid for the boundary. Each of those is a
  diagnosis with a next step.
- **Comes out 74%?** Fine — but it's only meaningful next to a baseline (§6). 74% against a
  baseline that scores 73% is a model that has learned nothing.

The number is a readout on the experiment. Fixing it in advance means the experiment can't tell
you anything.

### 1.3 Accuracy on synthetic data measures a closed loop

This is the subtle one, and it's the one worth internalizing.

The data comes from our own deterministic physics engine. We write a formula, generate races from
it, label the winners, and train a model to predict those labels. When that model scores 78%, the
honest reading of that number is:

> *"A logistic regression recovered 78% of the decision structure of a formula we wrote ourselves,
> under noise we also chose ourselves."*

It is a statement about our TypeScript. It is **not** a statement about Cybertrucks, BMWs, or
I-45. No real vehicle's behavior was ever an input, so no real vehicle's behavior can be an
output. The model cannot know anything the simulator didn't already know — the loop is closed.
(ARCHITECTURE §10: real race telemetry for these vehicles on these highways almost certainly
doesn't exist publicly. That's the constraint, and it isn't going away.)

**And it's still worth doing.** Genuinely — not as a consolation prize:

1. **It's a legitimate synthetic benchmark.** Learning a known generative process under
   controlled noise is a real, standard exercise. The whole field does this. It has the rare
   virtue that ground truth is *knowable*, so you can tell whether the model found the real
   structure or a shortcut.
2. **It validates the pipeline end-to-end.** Generation → features → split → train → export →
   Worker inference → served prediction. Every joint gets exercised on data you fully control.
   That's the hard part of ML engineering, and it's the part that's identical whether the data is
   synthetic or real.
3. **It's good practice on the parts that transfer.** Leakage discipline, baseline comparison,
   calibration, the export path — none of that cares where the rows came from.
4. **If real data ever appears, the pipeline is ready.** Swap the data source, retrain, redeploy.
   The architecture doesn't change at all.

**The sin isn't doing it. The sin is reporting the number as if it meant something about reality.**
So we label it, every time, in the UI and in the README:

> **Synthetic benchmark.** Trained and evaluated on simulator-generated races. Measures agreement
> with SimZoner's physics model, not with real-world vehicle performance.

One sentence. It costs nothing, and it's the difference between a good project and a misleading
one.

---

## 2. The two cars

**Cybertruck vs BMW M3.**

This is the most interesting contrast available, and "interesting" here has a precise meaning:
**neither car wins by default.** The decision boundary depends on conditions, which is exactly
what makes the task learnable rather than trivial.

| Axis | Cybertruck | BMW M3 | Consequence for the model |
|---|---|---|---|
| Mass | ~6,600 lb | ~3,900 lb | Dominates accel and any speed change |
| Powertrain | Electric, instant torque | ICE, gear-dependent | CT wins standing starts; M3 wins rolling |
| Drag | High Cd·A (frontal area) | Low | Flips the advantage at highway speed |
| Agility | Poor | High | Traffic density is worth more to the M3 |
| Occupancy | Can carry passengers | Can carry passengers | HOV eligibility — a *conditional* advantage |

The physical story is a real crossover: the Cybertruck's torque advantage decays as drag scales
with v², so it wins short/congested/stop-and-go segments while the M3 wins long open ones. Plus
traffic and HOV, which cut across the aerodynamics entirely. A model has something to learn here
because *the answer changes*.

**Waymo is the natural third, later,** and deliberately not now. Its behavior is categorically
different — rule-following, conservative, speed-limit-bounded, no risk-taking. It's not "a third
sports car"; it's an agent with a different objective function. That's a great addition once the
binary pipeline is proven, and it turns the label into a 3-class problem, which is a change worth
making on purpose rather than by accident.

---

## 3. Data generation

### 3.1 Noise is the entire point

A deterministic simulator with fixed inputs is 100% predictable. Train a model on it and you'll
score 100%, having learned nothing — you'll have built an expensive lookup table for a function
you already have the source code to.

**Noise is what makes the task non-trivial.** It's not a realism garnish; it's the thing that
creates a genuine prediction problem. Every race must sample from a distribution of conditions,
and the outcome must be genuinely uncertain given the features.

| Noise source | Distribution | Effect |
|---|---|---|
| Traffic density | vehicles/mile, per segment | Penalizes the heavy/less agile car |
| Weather | dry / wet / wind (magnitude + direction) | Grip and drag; headwind punishes high Cd·A |
| Driver variance | per-race skill/aggression jitter | Irreducible noise — the human factor |
| Start position | grid offset, lane | Small but real |
| Occupancy / HOV | passengers, HOV lane availability by segment | Conditional, high-leverage |
| Segment | length, grade, curvature, speed limit | Where the crossover lives |

### 3.2 Noise level is a difficulty dial — and you set it on validation

Because we control the noise, we control the task difficulty, and therefore the accuracy we'd
observe. This deserves saying plainly since it's the thing that makes §1.2 tempting:

- **Too little noise** → near-100% accuracy → the model memorized our formula → tells us nothing.
- **Too much noise** → ~50% → outcome is a coin flip regardless of features → also tells us nothing.
- **Calibrated in between** → a real learning problem with a meaningful ceiling.

There's a genuine and legitimate calibration step here: pick noise levels that make the sim
*physically plausible*, and sanity-check on **validation** that the task isn't degenerate at
either end. That is a modeling decision, and validation is exactly where it belongs.

The line not to cross: setting noise so the *test* number lands in a target window. That's §1.2's
failure mode wearing a lab coat. Calibrate for plausibility, check for degeneracy, then stop
touching it.

**Target scale:** ~50k–200k races. Cheap — it's local TypeScript. Store the seed with every row
so any race is exactly reproducible.

### 3.3 Split before you do anything else

Split by **seed**, up front, and never let generation cross the boundary. Split by *race group*
(route × condition-bundle), not by individual row — otherwise near-identical races land on both
sides of the line and test performance is inflated by a hair's breadth of memorization. This is a
quiet, easy way to leak, and it's worth being deliberate about.

---

## 4. Features and label

### 4.1 Features

| Group | Fields |
|---|---|
| Vehicle specs | mass, power, torque curve summary, Cd·A, drivetrain, tire grip — per car, and as **deltas** |
| Segment | length, grade, curvature, speed limit, lane count |
| Traffic | density, variance, congestion events |
| Weather | precip, temp, wind speed/direction relative to heading |
| Start | grid offset, lane assignment |
| Occupancy | passengers per car, HOV-eligible (bool), HOV lane present (bool) |

Two notes worth spending a minute on:

**Deltas over absolutes.** For a 2-car problem, `mass_diff`, `power_diff`, `cda_diff` are the
physically meaningful quantities and they give logistic regression a much better shot, since the
underlying comparison genuinely is differential. Keep the absolutes too and let regularization
sort it out.

**Watch for leakage in the feature set.** Nothing that's downstream of the outcome may be a
feature. No mid-race positions, no elapsed times, no "gap at mile 8." If a feature is suspiciously
predictive on its own, that's the first thing to check — it's usually not a discovery.

### 4.2 Label: binary winner, or regression on margin?

Both. Start binary, add the regression — they answer different questions and the second one is
better.

| | Binary winner | Regression on margin (finish-time delta, seconds) |
|---|---|---|
| Answers | Who wins | By how much |
| Signal | 1 bit/race | Continuous — far richer |
| Near-ties | Treated same as blowouts | Correctly treated as near-ties |
| Metric | Accuracy — directly matches the ask | MAE / R² |
| Simplicity | Very | Slightly less |

The binary label throws away almost everything. A 0.02s win and a 40s win are the same row, so
the model spends capacity on coin-flip races that are inherently unpredictable, and gets no
credit for knowing a blowout is a blowout.

**The margin regression is the better model**, and it subsumes the binary one for free:
`sign(predicted_margin)` gives you the winner, so you can still report accuracy. It also gives you
something the classifier can't: an honest *confidence*. A predicted margin of 0.1s is a coin flip
and should be shown as one; 15s is not.

**Do both.** Binary logistic regression as the headline baseline (it's what "accuracy" means, and
it ports most cleanly), margin regression as the model that's actually more useful and more
informative. They share the entire feature pipeline.

---

## 5. Model and the Worker constraint

### 5.1 Start with logistic regression — and the reason is architectural

Not "start simple because simple is virtuous." Start with logistic regression because of a hard
platform constraint:

**A trained logistic regression is a vector of weights. Inference is a dot product.**

```
p(cybertruck wins) = sigmoid( Σ wᵢ·xᵢ + b )
```

That is ~15 lines of TypeScript, zero dependencies, zero bundle cost, and microseconds of CPU.
It fits inside the 10ms Worker budget with room to spare (ARCHITECTURE §3, §8) — the CPU budget
that the entire architecture is bent around. Same for the margin regression: linear regression is
the same dot product without the sigmoid.

Include a standardizer and a small polynomial/interaction expansion (e.g. `mass_diff × grade`,
`cda_diff × speed_limit`, `traffic × agility_diff`) — the crossovers in §2 are interactions, and a
linear model can capture them if you hand it the products. `StandardScaler` exports as two more
vectors (`mean_`, `scale_`) and applies as `(x - mean) / scale`. Still a dot product.

### 5.2 Then gradient boosting — but know what it costs

If the baseline underfits (validation accuracy near the naive baseline, or clear residual
structure), gradient boosting is the right next step. It will probably win on raw accuracy — tree
ensembles eat this kind of tabular, interaction-heavy problem.

**But be honest about the deployment cost.** XGBoost / LightGBM do **not** port easily to Workers:

| Option | Reality |
|---|---|
| Python runtime in Worker | Not on this architecture |
| Native/WASM build | Bundle weight against the 3 MB gzip cap; unverified CPU |
| Export trees to JSON, walk in TS | Doable, but you're writing and maintaining an inference engine |
| ONNX Runtime Web | Heavy; 10ms CPU is not friendly to it |
| Serve from elsewhere | Adds a network hop and a second piece of infrastructure |

So the decision rule is explicit:

> **Ship the logistic regression unless gradient boosting beats it by a margin large enough to
> justify a new inference path.** Two points of accuracy does not justify it. Twelve might.

Train the GBM regardless — as a **ceiling probe**. If GBM scores 79% and logistic scores 77%, that
gap tells you the linear model already captured nearly all the available structure, and you can
ship the simple thing knowing what you gave up. That's a genuinely valuable measurement even when
the GBM never deploys.

### 5.3 Where training happens

**Locally. Python. sklearn.** Cloudflare cannot train — Workers AI is inference-only, and its LoRA
support is bring-your-own-adapter (ARCHITECTURE §5). This isn't a workaround; it's the normal
shape of ML deployment.

```
[ local Python ]                          [ Cloudflare ]
generate races (ts-node / node)
        ↓
  races.parquet
        ↓
sklearn: split → fit → evaluate
        ↓
  export weights ──────────────────────►  model.json (few KB, in bundle)
                                                ↓
                                          Worker: dot product → p(win)
```

The export is small — `coef_`, `intercept_`, `classes_`, plus the scaler's `mean_` and `scale_`,
plus the feature names **in order** and a schema version. Serialize to JSON; keep joblib only for
your local artifact.

Two things that will bite if you skip them:

- **Pin feature order in the JSON and assert it in TS.** A silently reordered feature vector
  produces plausible, wrong predictions with no error. This is the #1 way exported models break.
- **Golden tests.** Save ~100 rows with sklearn's `predict_proba` output. Assert the TS
  implementation matches to ~1e-6. Cheap to write, and it catches every scaler/ordering bug at
  once.

---

## 6. Evaluation — and the success criterion

### 6.1 Beat the naive baseline

**A model that doesn't beat a trivial rule is worth nothing, whatever its accuracy.** Compute
these first, before any model exists, on the same test split:

| Baseline | Rule |
|---|---|
| Majority class | Always predict whoever wins more often overall |
| **Always pick the lighter car** | Always M3 |
| Always pick the more powerful car | Static spec comparison |
| Single-feature logistic | One feature — the strongest one alone |

**This is the number that gives the model number meaning.** If "always pick the lighter car"
scores 71% and your model scores 74%, the model contributed **three points**, and any claim of
"74% accuracy" without that context is misleading — including to yourself. If the baseline scores
52% and the model scores 74%, you've learned something real.

The gap is the result. The raw accuracy is context.

### 6.2 The full report

Everything below gets reported, every time. Not just accuracy.

- **Split:** train/val/test by seed group, no crossing (§3.3)
- **Baselines:** the table above, on the same test split
- **Accuracy, precision, recall, F1** — and **AUC**, which doesn't depend on a threshold
- **Confusion matrix** — asymmetric errors are diagnostic. If the model is systematically wrong
  about Cybertruck wins specifically, that's a lead, not noise.
- **Calibration** (reliability curve, Brier score). When it says 70% confident, is it right 70% of
  the time? Logistic regression is usually decently calibrated out of the box, which is another
  quiet point in its favor. A UI that shows a confidence number needs that number to be honest.
- **Coefficient inspection.** Do the signs match physics? Does `cda_diff` hurt more as speed limit
  rises? **If the weights contradict the physics engine, one of them has a bug** — and this check
  finds real bugs. This is also where a linear model earns its keep: you can *read* it.
- **Margin model:** MAE, R², residuals vs predicted (structure in the residuals = missing feature)
- **Cross-validation on train+val** for stability. A model whose fold scores range 65–85% is not a
  74% model; it's an unstable model, and the mean is hiding that.
- **Learning curve.** Still improving with more data? Generate more — it's free.

### 6.3 The success criterion

Not "hit 70-75%."

> **Success = beat the naive baseline by a meaningful margin, on an honest test split touched
> once, with an understanding of *why* it wins that's consistent with the physics — and a label
> stating plainly that the number describes a simulator, not a road.**

That's a criterion you can actually fail, which is what makes passing it mean something. A
pre-set target is unfalsifiable: you can always reach 70-75% by tuning until you do, and you'll
have learned nothing except how to tune.

If the honest number is 91%, the finding is *"the synthetic task is too easy"* and the next move
is more noise. If it's 55%, the finding is *"noise dominates or features are weak"* and the next
move is diagnosis. If it's 74% against a 52% baseline, that's a good result and you can say so —
and you'll know exactly what you're saying.

---

## 7. This is not the driver agents

Two separate systems. Don't let them merge — they will try to.

| | **Outcome model** (this doc) | **Driver agents** (ARCHITECTURE §1, §4) |
|---|---|---|
| Purpose | Predict who wins, before the race | Tactical policy, during the race |
| Method | Trained weights (sklearn → JSON) | Prompting + persona + RAG |
| Training | Yes — local Python | **None.** No gradients anywhere. |
| Runs | Worker, dot product, microseconds | Workers AI, ~20 calls/race, neuron-budgeted |
| LangChain | Not involved | Retrieval layer only (`CloudflareVectorizeStore`) |
| Fails how | Wrong prediction, measurable | Bad tactics, judged qualitatively |

The driver agents don't learn — their behavior comes from prompting, persona, and retrieval over
real specs. That's not a limitation of the setup; it's what LLMs do. The outcome model learns and
the agents don't, and that asymmetry is correct.

They can *inform* each other — the outcome model's prediction could seed an agent's prompt
("you're the underdog here") — but that's a data flow, not a shared system.

---

## 8. Build order

1. Add noise injection to the physics engine (§3.1). This is the real work.
2. Generate ~50k Cybertruck-vs-M3 races. Seeds stored.
3. Split by seed group. **Set test aside and don't look at it.** (§3.3)
4. Compute naive baselines on test. Write the numbers down now. (§6.1)
5. Build features (§4.1). Both labels (§4.2).
6. Fit logistic regression. Iterate on **validation only**.
7. Check coefficient signs against the physics engine. Fix whichever is wrong. (§6.2)
8. Fit GBM as a ceiling probe. Record the gap. Probably don't ship it. (§5.2)
9. **Now** evaluate on test. Once. Report whatever it says.
10. Export weights → JSON. Golden tests against sklearn. (§5.3)
11. TS inference in the Worker. Assert feature order.
12. Ship it with the synthetic-benchmark label attached. (§1.3)
13. Waymo as a third class, once the binary path is proven end-to-end.

---

## 9. Open questions

1. **Noise calibration.** What levels are physically plausible for Texas highway traffic? This
   drives everything downstream and currently has no principled answer. Traffic density is the one
   axis where real public data might exist (TxDOT counts) — worth an hour of looking, because a
   defensible noise model is the closest this project gets to real grounding.
2. **Segment granularity.** Whole-route races, or per-segment with a route-level rollup? Per-segment
   gives ~10× the rows but they're correlated within a route — which affects the split (§3.3).
3. **Feature count vs sample size.** With interaction terms this grows fast. Regularization path
   (L1 vs L2) is a validation question, but worth deciding deliberately.
4. **HOV realism.** Which Texas segments actually have HOV lanes, and under what hours? If it's
   fictional, say so — it's still a fine synthetic feature, but it shouldn't be presented as a
   real-world finding.
5. **Where does the prediction surface in the UI?** A pre-race prediction with an honest
   calibrated confidence is a genuinely good feature — and it's the place where the labeling in
   §1.3 matters most, because that's where a user could mistake it for a claim about real cars.
