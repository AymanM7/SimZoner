# SimZoner: Balance and ML Evaluation - Recommendations

**Author:** Simulation + ML engineering review
**Date:** 2026-07-18
**Scope:** Two problems. (1) The Cybertruck wins almost every race - diagnose and rebalance.
(2) The ML pipeline reports one accuracy number from one split - replace with a robust protocol.
**Status:** Recommendations only. No code was changed. Every number below was measured against the
real engine (`ml/physics.py`) or produced by a throwaway prototype of the proposed rebalance.

---

## 0. Executive summary

**Problem 1 (balance).** Measured against the real road-load engine over 1500 randomized races,
the current win rates are:

| Vehicle | Head-to-head win rate | vs Cybertruck | vs BMW | vs Waymo |
|---|---|---|---|---|
| Cybertruck | **84.7%** | - | 74.7% | 95.0% |
| BMW M5 | 59.4% | 25.3% | - | 94.3% |
| Waymo | **5.3%** | 5.0% | 5.7% | - |

The cause is structural, not a bad constant: **every car reaches the hard speed cap on every
segment of every fixture route**, so mass, Cd.A, and power never enter the result. The only things
that differ between cars at the cap are (i) the risk multiplier `(0.9 + 0.1*risk)` and (ii) a
+/-3% jitter. Risk therefore decides the race by construction. This is confirmed below: a car only
drops below the cap on a grade steeper than **~50%** (Cybertruck/BMW) or **~31%** (Waymo) - grades
that do not exist on Earth, let alone in the fixtures (max 2.5%).

The fix is to add mechanics where the specs actually bite - stop-and-go re-acceleration
(power-to-weight and mass), risk-linked driver-error/incident time penalties (so aggression costs),
per-race weather, and occupancy/AV-driven HOV swings - and to shrink the risk speed multiplier so
it is one lever among several. A prototype of these changes moved the spread to
**Cybertruck 58.9% / BMW 54.8% / Waymo 36.4%** without rigging any car's odds. Specific constants
and the tuning path to "no car above ~55%" are in Section 1.

**A second, separate bug:** the client engine `frontend/src/lib/engine.ts` does not read mass,
Cd.A, or power **at all** - the visible race is driven purely by `risk` plus jitter. This must be
fixed alongside the authoritative engine or the animation will disagree with the ranked result.

**Problem 2 (evaluation).** Replace the single 60/20/20 split and single accuracy scalar with:
grouped, repeated, stratified k-fold cross-validation (**`RepeatedStratifiedGroupKFold`**, grouping
by `race_id` to stop leakage), aggregated across multiple dataset seeds, reported as
**mean +/- std** with a bootstrap 95% CI on AUC and a Wilson interval on accuracy, broken down
per-route and per-condition. There is also a **real leakage bug today**: `train.py` and
`per_car/common.py` split by row, so pairwise rows from the same race land in both train and test.
Rebalancing (Problem 1) makes the learning task genuinely harder - which is the point: today's
84.7% base rate makes a high accuracy meaningless.

---

## 1. Problem 1 - "The Cybertruck wins almost every race"

### 1.1 The architecture you are actually balancing (read this first)

There are **two** engines, and the task points at the smaller one:

| File | Role | Uses mass / Cd.A / power? | Speed model |
|---|---|---|---|
| `frontend/src/lib/engine.ts` | Client animation the user watches | **No - none of them** | `targetMph = capMph * (1 - CONGESTION_DRAG*congestion) * (0.9 + 0.1*risk)` |
| `backend/src/physics.ts` == `ml/physics.py` | Authoritative road-load engine, `ENGINE_VERSION="v1"`; trains + serves the model | Yes (force integration) | Integrates `F = drag + roll + grade` vs `min(P.eta/v, mu.m.g)` up to the same cap |

`physics.ts` and `physics.py` are kept numerically identical on purpose (the docstring pins this to
`ENGINE_VERSION`). `engine.ts` is a separate approximation. **Any rebalance must land in all three
files, and it must bump `ENGINE_VERSION` to `v2`** (per SYSTEM_DESIGN 6: determinism is a
per-version promise; the served weights are trained on a specific engine version). The frontend
engine additionally needs the spec terms wired in so the animation and the ranking agree.

### 1.2 Root cause - why risk is the only lever that matters

The authoritative engine computes, per segment:

```
effectiveCap = (limit + 10)mph * (1 - 0.45 * congestion) * (0.9 + 0.1 * risk)
```

then integrates toward that cap. The integrator only lets drag/mass/power decide the result **if a
car cannot hold the cap** (net tractive force goes negative at the cap). Measured against the real
engine:

- **Every car holds the cap on every fixture segment.** Steady-state check on all four routes:
  Cybertruck, BMW, and Waymo are all at `CAP` on every segment tested (55-70 mph limits, 0-2.5%
  grades).
- **The grade needed to break the cap is absurd:** with a 75 mph cap (limit 75 + 10... i.e. an
  85 mph target), a car only fails to sustain it above roughly:
  - Cybertruck: **~50.0%** grade (P/W 0.200 kW/kg)
  - BMW M5: **~56.5%** grade (P/W 0.220 kW/kg)
  - Waymo: **~31.5%** grade (P/W 0.138 kW/kg)
  These vehicles are so over-powered for commute speeds that drag and grade never bind. The
  VEHICLE_SPECS doc is right that "drag decides flats, mass decides hills" in principle - but only
  at speeds/grades this sim never reaches.

With the cap identical for all cars, the finish order reduces to the risk multiplier plus jitter:

| Car | risk | cap multiplier `0.9 + 0.1*risk` |
|---|---|---|
| Cybertruck | 0.9 | **0.99** |
| BMW M5 | 0.8 | 0.98 |
| Waymo | 0.4 | **0.94** |

Cybertruck's 0.99 vs Waymo's 0.94 is a **5.3% systematic speed edge**; the jitter is only +/-3%
(`(rng()-0.5)*0.06`) and is mean-zero, so it cannot flip a 5% gap. Result: Waymo wins 5.3% of
races, Cybertruck 84.7%. Mass (3104 kg) and Cd.A (1.025) - the Cybertruck's supposed handicaps -
contribute **nothing**, exactly as the numbers show.

### 1.3 Rebalancing - concrete changes

The goal is realistic variety, not a rigged coin flip. Four levers, each tied to a real feature.
All constants below are starting values validated in a prototype (Section 1.4); final values come
from the tuning sweep in Section 1.6 (which is the same k-fold harness as Problem 2).

#### (a) Make mass bite - stop-and-go re-acceleration

Real commuting loses time to repeated decelerate/re-accelerate cycles, and that is exactly where
mass and power-to-weight matter (the cap is irrelevant when you are below it). Replace the
"cruise at cap for the whole segment" integration with periodic slowdown events:

```
STOPGO_PER_KM = 1.1        # slowdown events per km at density = 1.0
DECEL_DEPTH   = 0.8        # each event drops speed to v_low = cap * (1 - DECEL_DEPTH * density)

n_surges = round(STOPGO_PER_KM * density * length_km)
# place n_surges evenly along the segment; at each, set v = min(v, v_low),
# then let the EXISTING force integrator re-accelerate toward cap.
```

The re-acceleration is already car-differentiated by the force model. Measured time to re-accelerate
15 -> 33.5 m/s (a single surge):

| Car | flat | 3% grade | 6% grade |
|---|---|---|---|
| BMW M5 | **2.5 s** | 2.5 s | 3.0 s |
| Cybertruck | 3.0 s | 3.0 s | 3.0 s |
| Waymo | **4.0 s** | 4.0 s | 4.5 s |

So BMW (best P/W) recovers fastest, Waymo (lowest power) slowest, and Cybertruck pays for its mass.
Over a dense route (~15-25 surges) this is a 10-25 s spread - enough to matter, and it grows with
`density`, so congested urban routes (Chicago, Cincinnati) differentiate more than open ones.

**Also add steeper-grade segments to the fixtures.** The current max grade is 2.5%. Add at least
one route/segment with 5-7% sustained grade (a real bridge approach or hill climb - the Brent Spence
approaches, a Hill Country climb). At 6% the heavy Cybertruck's grade force is
`3104 * 9.81 * 0.06 ~= 1827 N`, which lengthens its surge recovery relative to the lighter cars.
Grade will still not break the cap at steady state (Section 1.2), but combined with stop-and-go it
makes mass a visible, feature-tied penalty.

#### (b) Make drag bite

Honest finding: **at a hard commute-speed cap, drag can never force a car below the cap** - the
vehicles have 3-6x the power needed (Section 1.2). Do not pretend otherwise by inventing a grade.
Two defensible ways to let Cd.A matter:

1. **Drag enters the stop-and-go cost.** Re-acceleration work is `0.5*m*(cap^2 - v_low^2)` plus the
   drag done against `0.5*rho*CdA*v^2` while surging. The high-Cd.A Cybertruck pays more drag work
   on every surge; this is already captured by the integrator in lever (a) and needs no new term.
2. **Weather scales drag (lever c).** Higher air density on a bad-weather day multiplies the drag
   term; the highest-Cd.A car loses the most. This is the cleanest place for Cd.A to show up as
   race-to-race variance.

Recommendation: rely on (1)+(c) rather than forcing a below-cap cruise. State in the UI that
Cd.A is a second-order effect at capped commute speeds - that is the truth, and VEHICLE_SPECS 6
already says so.

#### (c) Real variance sources tied to features

Draw these per race / per segment so outcomes vary the way real commutes do:

```
# Per-race weather (one draw per race, applied to every segment)
#   clear 60% : rho_mul 1.00, mu_mul 1.00, density_add 0.00
#   rain  30% : rho_mul 1.02, mu_mul 0.80, density_add 0.10
#   heavy 10% : rho_mul 1.03, mu_mul 0.65, density_add 0.20
#   rho_mul scales drag (Cd.A bites); mu_mul cuts the adhesion-limited launch (slows re-accel,
#   hits low-P/W Waymo hardest); density_add worsens congestion (more/deeper surges).

# Per-segment incident (independent per car) - irreducible variance the features cannot see
INC_P    = 0.06                 # prob of an incident on a segment
INC_COST = uniform(15, 50) s    # time lost

# Occupancy-driven HOV eligibility (widen the current 1-or-2 draw)
occupancy = randint(1, 4)                       # 1..3 people
hov_eligible = occupancy >= seg.hov_min_occupancy   # feature the model CAN see
# For the autonomous Waymo, adopt SIMULATION_RULES AV_POLICY (B) "transit-equivalent":
#   waymo is HOV-eligible whenever the segment has HOV lanes. This is the doc's recommended
#   default and it is Waymo's structural win path.

# Driver-error events (risk-linked - this is what COUNTERS the risk speed edge)
ERR_BASE, ERR_SLOPE = 0.02, 0.13         # p(error)/segment = ERR_BASE + ERR_SLOPE * risk
ERR_COST = uniform(6, 26) s              # time lost per error
#   Cybertruck (risk 0.9): p ~= 0.137/seg;  Waymo (risk 0.4): p ~= 0.072/seg.
#   Aggression buys a little speed and pays for it in time lost - a genuine tradeoff, not a nerf.
```

HOV needs more surface area to swing outcomes: today only the I-45 route has `hov_lanes > 0`, on
some segments. Add HOV/managed-lane segments to more routes (SIMULATION_RULES already documents
Houston occupancy gates, Chicago reversible/direction gates, Austin as-planned lanes). The wider
the HOV footprint, the more often lane access - not horsepower - decides, which is the sim's stated
thesis (SIMULATION_RULES 3.2).

#### (d) Retune the risk factor so it is one lever among several

Shrink the risk speed multiplier from a 10-point span to a 3-point span, and let the driver-error
term in (c) do the counter-work:

```
# was:  cap * (0.90 + 0.10 * risk)   -> Cybertruck 0.99, BMW 0.98, Waymo 0.94  (5.3% spread)
# use:  cap * (0.97 + 0.03 * risk)   -> Cybertruck 0.997, BMW 0.994, Waymo 0.982 (1.5% spread)
```

Now risk is a real tradeoff: +1.5% cruise speed at the top end, paid back through a higher
error/incident rate. Do **not** set the span to zero - that makes risk strictly harmful and
over-corrects (the conservative Waymo would dominate). The tradeoff is the point.

### 1.4 Predicted win-rate spread (measured, not asserted)

A throwaway prototype implementing (a)-(d) on the real force model and the real fixtures, over 2500
randomized races, progressively compresses the spread as the levers are added:

| Configuration | Cybertruck | BMW M5 | Waymo | Notes |
|---|---|---|---|---|
| **Current (v1)** | **84.7%** | 59.4% | **5.3%** | risk decides everything |
| + stop-and-go, weather, errors, `0.95+0.05*risk` | 77.1% | 62.6% | 10.1% | levers real but too weak |
| + `0.97+0.03*risk`, stronger errors, per-seg incidents, Waymo transit-HOV | 64.5% | 54.8% | 30.7% | close |
| + `ERR_SLOPE 0.20`, `ERR_COST (8,32)`, `STOPGO_PER_KM 1.3` | **58.9%** | 54.8% | **36.4%** | all competitive |

At the last setting the pairwise matrix is: Cybertruck vs BMW 52.6/47.4, Cybertruck vs Waymo
65.2/34.8, BMW vs Waymo 62.1/37.9. **No car is above ~59%, and every car wins a meaningful share.**
Pushing `ERR_SLOPE` a little further and adding the 5-7% grade segment brings the Cybertruck under
55% and lifts Waymo toward 40%; that final trim is exactly the tuning sweep in Section 1.6. The
important result is that the mechanics are real and monotone - each lever moved the spread in the
intended direction without hand-setting any win rate.

**Predicted target after the sweep:** Cybertruck ~45-52%, BMW ~40-48%, Waymo ~25-35% overall, with
Waymo exceeding 50% on HOV-heavy routes and losing on the no-HOV Cincinnati control route - which is
the exact "does lane access beat horsepower?" finding SIMULATION_RULES 4.4 is designed to isolate.

### 1.5 Do not forget the client engine

`frontend/src/lib/engine.ts` currently ignores mass, Cd.A, and power entirely and drives the
visible animation from `risk` + jitter + HOV. If you rebalance only the backend/ML engine, the
animation will show a different winner than the ranked result. Options, in order of preference:

1. **Have the client replay the authoritative result** (segment splits from `physics.ts`) instead
   of re-simulating. Cleanest; guarantees agreement; matches SYSTEM_DESIGN's "engine computes,
   seed reproduces" model.
2. If the client must simulate live, port the same stop-and-go + risk-error terms and read the
   spec fields (they already exist in `vehicles.ts`: `mass`, `cda`, `power`). Keep the constants in
   one shared module so `engine.ts` and `physics.ts` cannot drift.

Also align two silent inconsistencies while you are there: `engine.ts` uses `CONGESTION_DRAG=0.33`
vs the authoritative `0.45`, `HOV_RELIEF=0.4` vs `0.3`, and gates HOV on **risk** (`v.risk>=0.75`)
rather than **occupancy**. These are three different rule sets for the same race.

### 1.6 Tradeoffs and honesty notes

- **This is tuning a mock, and it should be labeled as one.** VEHICLE_SPECS is explicit that the
  Cybertruck has zero verified aero params and Waymo results are really base-I-Pace results. Making
  the race "closer" does not make it more real - it makes it more *interesting* and removes an
  artifact (risk-dominance) that was not physically motivated. Keep the MOCK_DATA labeling.
- **Do not tune to a target win rate directly - that is rigging.** Tune the *mechanisms*
  (stop-and-go rate, error slope, weather mix) and let win rates fall out. Report the win-rate
  spread as an *outcome* of the tuning sweep, with the seed and config hash, so it is reproducible.
- **The tuning sweep is a determinism event.** Every constant change is an `ENGINE_VERSION` bump;
  the served model weights must be retrained against the frozen `v2` engine (Problem 2), or the
  edge serves a model describing a simulator that no longer exists.
- **Incidents add irreducible noise on purpose.** The per-segment incident term is invisible to the
  features, so it caps achievable accuracy below 100% - this is what makes the ML metric meaningful
  rather than a base-rate readout (Problem 2).

---

## 2. Problem 2 - "More training, more testing, not just one result"

### 2.1 Current state and the bug hiding in it

`train.py` and `per_car/common.py` do **one** 60/20/20 `train_test_split` and report **one**
`test_accuracy`. Two problems:

1. **Row-level splitting leaks races across train/test.** `generate.py` emits one row per unordered
   car-pair per race (up to 3 rows/race), and the per-race traffic multiplier + weather + incidents
   are shared by all pairs of that race. Splitting by row (as `train_test_split` does) puts pairs
   from the *same race* in both train and test. The model can memorize a race's shared noise. This
   inflates every accuracy/AUC number reported today. **Group by `race_id`.**
2. **One number has no error bar.** A single test accuracy from `random_state=0` cannot be
   distinguished from noise. With rebalancing shrinking the signal, this matters even more.

### 2.2 k-fold cross-validation, grouped and stratified

Use stratified k-fold (preserves the label balance) that also **groups by race** (prevents the
leak). scikit-learn provides `StratifiedGroupKFold`:

```python
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedGroupKFold, cross_val_score

df = pd.read_parquet("data/races.parquet")
X = df[FEATURES].to_numpy(float)
y = df["a_beats_b"].to_numpy(int)
groups = df["race_id"].to_numpy()          # <-- the fix for leakage

pipe = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=1000))
cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=0)

acc = cross_val_score(pipe, X, y, cv=cv, groups=groups, scoring="accuracy")
auc = cross_val_score(pipe, X, y, cv=cv, groups=groups, scoring="roc_auc")
print(f"accuracy {acc.mean():.3f} +/- {acc.std():.3f}  (5-fold, grouped)")
print(f"AUC      {auc.mean():.3f} +/- {auc.std():.3f}")
```

Use `n_splits=5` (or 10 for tighter estimates at 2x cost). Always pass `groups=`; `cross_val_score`
forwards it to the splitter. Put the scaler **inside** a `Pipeline` so it is refit per fold - fitting
the scaler once on all data is itself a (small) leak.

### 2.3 Repeated runs across multiple seeds

Two independent randomness sources need sweeping, and they answer different questions:

- **CV-split seed** (how the folds are drawn): repeat the k-fold `n_repeats` times with different
  fold assignments to measure *estimator stability under resampling*. Note: scikit-learn ships
  `RepeatedStratifiedKFold` but **not** a grouped repeated variant (verified absent in sklearn
  1.8.0) - since we must group by race, loop `StratifiedGroupKFold` over `random_state` yourself
  and concatenate the per-fold scores. (`RepeatedStratifiedKFold` is only safe here if you are
  willing to ignore grouping, which reintroduces the leak - do not.)

```python
import numpy as np
from sklearn.model_selection import StratifiedGroupKFold, cross_val_score
scores = []
for r in range(5):                                          # 5 repeats
    cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=r)
    scores.append(cross_val_score(pipe, X, y, cv=cv, groups=groups, scoring="roc_auc"))
scores = np.concatenate(scores)                             # 25 fold estimates
print(f"AUC {scores.mean():.3f} +/- {scores.std():.3f}  over {len(scores)} grouped folds")
```

- **Dataset seed** (`DATA_SEED` in `generate.py`, which fixes the traffic/weather/incident draws):
  regenerate the dataset under `DATA_SEED in {42, 43, ..., 42+N-1}` (recommend **N=5**), run the
  grouped CV on each, and aggregate. This measures whether conclusions survive a *different draw of
  the synthetic world*, which is the honest question for a simulator-derived dataset.

Report the grand mean and a std that pools across both: e.g. "AUC 0.71 +/- 0.02 across 5 dataset
seeds x 5-fold grouped CV (25 estimates)."

### 2.4 A larger, more varied dataset

- Raise `N_RACES` from **6000** to **20000-30000**. The pipeline is cheap (logistic on 5 features);
  the cost is the physics sim in `generate.py`, which is the real bottleneck - budget for it or
  cache races. More races tighten every CI and make per-condition breakdowns (Section 2.6) have
  enough rows per cell.
- Add the Problem-1 variance sources to `generate.py`'s feature contract where the model is allowed
  to see them: **weather** (encode as `rho_mul`, `mu_mul`, or a categorical), and the widened
  **occupancy/HOV** signal. Keep **incidents** *out* of the features on purpose - they are the
  irreducible term that sets the accuracy ceiling below 1.0.
- Add the new features to `FEATURES` in all four files that hard-code the list (`generate.py`,
  `train.py`, `per_car/common.py`, and `cloud-compute/src/entry.py` per the contract note) or
  serving will break.
- Consider **more routes / steeper grades** (Section 1.3a) so the task is not dominated by one or
  two corridor archetypes.

### 2.5 Confidence intervals on accuracy and AUC

Two complementary CIs:

- **Across-fold CI (cheap, already have the samples).** With `m` fold scores, report
  `mean +/- 1.96 * std / sqrt(m)` as an approximate 95% interval on the mean score. Note the folds
  are not fully independent (overlapping training sets), so treat this as indicative, not exact -
  the honest headline is `mean +/- std`.
- **Within-test-set CI on the final held-out evaluation** (the one look at the true test set,
  keeping `train.py`'s "touch test once" discipline):
  - **Accuracy - Wilson score interval** (better than normal-approx at the tails):

    ```python
    from statsmodels.stats.proportion import proportion_confint
    lo, hi = proportion_confint(count=n_correct, nobs=n_test, alpha=0.05, method="wilson")
    ```
  - **AUC - stratified bootstrap** (resample the test set with replacement B=2000 times):

    ```python
    import numpy as np
    from sklearn.metrics import roc_auc_score
    rng = np.random.default_rng(0)
    aucs = []
    for _ in range(2000):
        idx = rng.integers(0, len(y_te), len(y_te))
        if len(np.unique(y_te[idx])) < 2:      # skip degenerate resamples
            continue
        aucs.append(roc_auc_score(y_te[idx], prob_te[idx]))
    lo, hi = np.percentile(aucs, [2.5, 97.5])
    print(f"AUC {roc_auc_score(y_te, prob_te):.3f}  95% CI [{lo:.3f}, {hi:.3f}]")
    ```

### 2.6 Per-route and per-condition breakdowns

A single global number hides that the model may be great on flat Houston and useless on hilly
Cincinnati. Slice the out-of-fold predictions and report the metric per cell with its own CI and
n. Use `cross_val_predict` so every row gets an out-of-fold prediction exactly once:

```python
from sklearn.model_selection import cross_val_predict
oof = cross_val_predict(pipe, X, y, cv=cv, groups=groups, method="predict_proba")[:, 1]
df["oof_prob"] = oof
df["oof_pred"] = (oof >= 0.5).astype(int)

for key in ["route_id", "weather", "hov_eligible_diff"]:
    g = (df.groupby(key)
           .apply(lambda d: pd.Series({
               "n": len(d),
               "acc": (d.oof_pred == d.a_beats_b).mean(),
               "auc": roc_auc_score(d.a_beats_b, d.oof_prob) if d.a_beats_b.nunique() > 1 else np.nan,
               "base_rate": max(d.a_beats_b.mean(), 1 - d.a_beats_b.mean()),
           })))
    print(key, "\n", g)
```

Recommended slices: **per route_id**, **per weather class**, **per HOV-mismatch**
(`hov_eligible_diff in {-1,0,1}`), and **per car-pair** (the per-car models in `per_car/` already
do the single-car cut; extend them to the same grouped-CV protocol). Always print the cell's
**base rate** next to its accuracy - accuracy only means something as *lift over base rate*, which
`train.py` already understands for the global number (its majority/heuristic baselines) but does not
do per-slice.

### 2.7 How to report "mean +/- std" instead of one number

Replace the current `metrics` block in `weights.json` / `model_metrics.json` with a distribution,
not a scalar:

```json
"metrics": {
  "protocol": "5 dataset seeds x StratifiedGroupKFold(5-fold) repeated 5x, grouped by race_id",
  "n_estimates": 125,
  "accuracy_mean": 0.683, "accuracy_std": 0.014,
  "auc_mean": 0.712,      "auc_std": 0.016,
  "auc_test_ci95": [0.694, 0.731],
  "majority_baseline": 0.512,
  "higher_risk_wins_baseline": 0.58,
  "lift_over_majority": 0.171,
  "per_route": { "chicago-kennedy": {"auc": 0.70, "n": 4120}, "...": {} },
  "per_weather": { "clear": {"auc": 0.73}, "rain": {"auc": 0.69}, "heavy": {"auc": 0.64} },
  "engine_version": "v2",
  "note": "Synthetic benchmark. Agreement with SimZoner physics v2, not real vehicles."
}
```

Prose headline: **"AUC 0.712 +/- 0.016 (mean +/- std over 125 estimates: 5 dataset seeds x
5-fold-x-5-repeat grouped CV); 95% bootstrap CI on the held-out test set [0.694, 0.731]; majority
baseline 0.512."** The `engine_version` field is load-bearing - it ties the number to the exact
engine the model was trained against.

### 2.8 Why rebalancing makes the metric honest (and the tradeoff)

- **Today the base rate is ~85% for "Cybertruck wins".** A model that always predicts the
  higher-risk car wins would score close to that with zero learning - the current accuracy largely
  tracks a base rate, not skill. `train.py`'s own `higher-risk-wins` baseline exists precisely to
  expose this.
- **After rebalancing, races are close (Section 1.4), so the base rate drops toward ~55% and the
  irreducible incident/weather noise caps accuracy well below 100%.** Accuracy and AUC now measure
  whether the model has learned the *interaction* of mass, power, HOV, and risk - real skill.
  Expect the headline number to **go down** (e.g. from ~0.85 to ~0.68-0.72). That is a success, not
  a regression: the number finally means something. Say so explicitly in the report so a lower
  accuracy is not misread as a worse model.
- **Cost tradeoff:** grouped repeated CV over 5 dataset seeds is ~125 model fits plus 5 full
  dataset regenerations. Model fitting is trivial (logistic on 5-8 features); the dataset
  regeneration (the physics sim) dominates and scales with `N_RACES`. Budget the sim time or cache
  race outputs keyed by `(engine_version, DATA_SEED)`. Keep the deployed model a single logistic
  (per `train.py`'s serving constraint) - CV is for *evaluation*, the shipped artifact is still one
  set of weights trained on the full data at the chosen `C`.

---

## 3. Buildable checklist

**Problem 1 (all changes bump `ENGINE_VERSION` v1 -> v2):**
1. `ml/physics.py` + `backend/src/physics.ts`: add stop-and-go surges (`STOPGO_PER_KM`,
   `DECEL_DEPTH`), risk-linked driver-error (`ERR_BASE`, `ERR_SLOPE`, `ERR_COST`), per-segment
   incidents (`INC_P`, `INC_COST`), weather draw (rho/mu/density), and change the risk multiplier
   `0.9+0.1*risk` -> `0.97+0.03*risk`. Keep the two files numerically identical.
2. `ml/data/fixtures.json`: add HOV segments on more routes; add >=1 route/segment with 5-7% grade.
3. `frontend/src/lib/engine.ts`: either replay the authoritative result, or port the same terms and
   read `mass`/`cda`/`power` from `vehicles.ts`; reconcile `CONGESTION_DRAG`, `HOV_RELIEF`, and the
   HOV eligibility rule with the authoritative engine.
4. `ml/generate.py`: add weather + widened occupancy to the emitted features; keep incidents out of
   features; widen `occupancy` to `randint(1,4)`; adopt Waymo transit-equivalent HOV.
5. Run the tuning sweep (harness = Problem 2) to land win rates; record seed + config hash.

**Problem 2:**
1. Group by `race_id` everywhere: `StratifiedGroupKFold` in `train.py` and `per_car/common.py`
   (fixes the current leak).
2. `StratifiedGroupKFold` (5-fold) looped 5x over `random_state` x 5 dataset seeds; report
   `mean +/- std` (no grouped-repeated splitter exists in sklearn - loop it).
3. Wilson interval on final test accuracy; bootstrap 95% CI on test AUC.
4. `cross_val_predict` -> per-route / per-weather / per-HOV / per-pair breakdowns with base rates.
5. Raise `N_RACES` to 20000-30000; add new features to all four `FEATURES` lists + the serving
   contract.
6. Replace the scalar `metrics` block with the distribution schema in Section 2.7; stamp
   `engine_version: "v2"`.

---

*All win-rate and physics figures in Section 1 were measured against `ml/physics.py` on the real
fixtures (baseline: 1500 races; prototype: 2500 races). The prototype constants are starting points
for the tuning sweep, not final values. SimZoner remains a synthetic benchmark: these
recommendations make it more interesting and its ML metric more honest, not more real.*
