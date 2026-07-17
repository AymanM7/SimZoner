# Vehicle Specifications — Sourced Parameters

**Compiled:** 2026-07-16
**Purpose:** Ground the SimZoner physics engine in real, citable published specifications.
**Scope note:** This document establishes **real parameters, synthetic outcomes**. Every number
below feeds a deterministic road-load model. The *races* remain synthetic — no real race
telemetry exists for these vehicles (see `ARCHITECTURE.md` §10). Real inputs do not make the
outputs real; they make them *defensible*.

## Tagging convention

| Tag | Meaning |
|---|---|
| **[VERIFIED]** | Fetched from a primary/manufacturer source. URL given. |
| **[SECONDARY]** | Reputable third party, not the manufacturer. URL given. |
| **[ESTIMATED]** | Computed or inferred. Formula and inputs shown. |
| **[UNPUBLISHED]** | Genuinely not published. Left as a gap, not filled. |

A documented gap is worth more than a confident guess. Nothing below is invented to look complete.

---

## 1. Provenance summary — the most important table in this document

**The three vehicles are NOT equally well characterized.** This asymmetry is a property of the
data, not of the effort spent looking.

| Vehicle | VERIFIED | SECONDARY | ESTIMATED | UNPUBLISHED | Cd source | Frontal area source |
|---|---|---|---|---|---|---|
| **BMW M5 (G90)** | **10** | 0 | 0 | 1 (Crr) | **Manufacturer** | **Manufacturer** |
| **Jaguar I-Pace EV400** (Waymo) | 7 | 3 | 1 | 1 (sensor penalty) | **Manufacturer** | *Estimated* |
| **Tesla Cybertruck Cyberbeast** | **0** | 9 | 1 | 2 (track, Crr) | *Secondary* | *Estimated* |

### What this table means

- **The BMW M5 is the only vehicle where both aerodynamic terms are manufacturer-published.**
  Cd *and* frontal area come from BMW's own data sheet as a matched pair.
- **The Cybertruck has zero verified parameters.** `tesla.com` blocks automated fetching
  (confirmed: `https://www.tesla.com/cybertruck/specs` returns **HTTP 403 Forbidden**).
  Every Cybertruck number is secondary-sourced. Its frontal area is estimated, and its track
  width — an input to that estimate — is itself unpublished, so the estimate rests on a proxy.
- **The I-Pace sits in between:** Cd is manufacturer-verified, but frontal area is estimated and
  kerb mass is secondary.

**Consequence for the sim:** a Cybertruck-vs-M5 result is not a comparison of two equally known
things. The M5 side is measured; the Cybertruck side is inferred. Surface this per-vehicle
confidence in the UI. Do not render both with the same visual authority.

---

## 2. BMW — the M3 vs M5 decision

**This was the central open question from the prior audit** (`ARCHITECTURE.md` §10:
*"Unverified: whether M3/M4 sheets carry `cX x A`"*). It is now resolved.

### Method

BMW's **German** press sheets (`press.bmwgroup.com/deutschland`) publish a
`Luftwiderstand cX x A` line — drag coefficient and reference area as a matched pair. US
releases omit the area. The prior audit verified this for the M5 but flagged the M3 as unchecked.
A second agent reported the M3's Cd was unfindable and had to invent it.

I located and parsed the actual BMW M3 "Technische Daten" PDF from PressClub Deutschland:

`https://www.press.bmwgroup.com/deutschland/article/attachment/T0447610DE/627553`
("Technische Daten. BMW M3 Touring. M3 CS.", BMW Medieninformation 01/2025)

### Finding: the M3 sheet does NOT carry `cX x A`

**Confirmed by direct text extraction of the official PDF.** The M3 CS Touring sheet contains no
`Luftwiderstand` line and no `cX` token anywhere in its three pages. The `BMW EfficientDynamics`
section lists *"optimierte Aerodynamikeigenschaften"* (optimized aerodynamic properties) as a
qualitative feature — with **no number attached**.

This **independently corroborates the second agent's report**. The M3's Cd is not published by
BMW, and the omission is structural, not an artifact of which sheet you happen to open.

The contrast is exact. From the M5 sheet (`.../attachment/T0443252DE/621213`), verbatim:

```
Kofferraumvolumen l  466  Luftwiderstand cX x A  0,32 x 2,55
```

The M3 sheet's corresponding row simply ends after `Kofferraumvolumen l 500 – 1510`.

### What the M3 sheet *does* give (for the record)

Everything **except** the two parameters that matter most at speed. BMW M3 CS Touring, all
[VERIFIED] from the sheet above: 1850 kg DIN / 1925 kg EU, 405 kW (550 PS), 650 Nm,
0–100 km/h 3.5 s, top speed 300 km/h, M xDrive AWD, track 1623/1605 mm, height 1447 mm,
tires 275/35 ZR19 front / 285/30 ZR20 rear.

### Recommendation: **use the M5 (G90).** Unambiguously.

The reasoning is not about which car is cooler — it is about **which parameters the sim is
actually sensitive to**:

1. **Drag dominates the 65–95 mph band.** Aerodynamic force scales with v². In this envelope the
   drag term is the largest single force on a level road. Cd and A are therefore the two
   highest-leverage parameters in the entire model.
2. **The M3 sheet omits exactly those two.** Every other M3 parameter is verified — which is
   precisely the trap. The M3 looks 90% sourced while missing the 10% that decides the race.
3. **An unsourced Cd makes every M3 result provisional.** With Cd invented, the M3's outcome is a
   function of the guess, not of the car. Worse, that guess would be *invisible* in the output —
   the result would look as authoritative as the M5's.
4. **A fully-sourced M5 is worth more than a nominally-cooler M3.** The M5 gives a manufacturer-
   published Cd *and* frontal area as a matched pair — eliminating the single largest guess in
   road-load modeling. This is a rare thing to have. Spend it.

**Fallback if the M3 is required for product reasons:** its Cd and A must both be tagged
[ESTIMATED], and every M3 result must be labeled provisional in the UI. Do not silently paper
over it. The M3's `0.84 × track × height` area estimate is `0.84 × 1.623 × 1.447 = 1.97 m²`;
its Cd has no defensible source at all.

---

## 3. BMW M5 (G90) — 2024, plug-in hybrid V8

**Primary source:** BMW Group PressClub Deutschland — "Der neue BMW M5"
Article: https://www.press.bmwgroup.com/deutschland/article/detail/T0443252DE/der-neue-bmw-m5
Data sheet PDF: https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213
(BMW Medieninformation 06/2024, "Technische Daten. BMW M5.")

> ⚠️ **Preliminary-values caveat.** The sheet states verbatim: *"Bei allen Angaben handelt es
> sich um **vorläufige Werte**"* — **all** figures are preliminary. Note this is broader than the
> M3 sheet, which scopes the caveat only to performance/consumption/emissions. Carry this caveat
> into any published result. It does not invalidate the data; it bounds its precision.

| Parameter | Value | Tag | Notes |
|---|---|---|---|
| **Drag coefficient (Cd)** | **0.32** | **[VERIFIED]** | `Luftwiderstand cX x A  0,32 x 2,55` |
| **Frontal area (A)** | **2.55 m²** | **[VERIFIED]** | Same line — matched pair, not two sources |
| **Cd·A** | **0.816 m²** | [ESTIMATED] | `0.32 × 2.55` — both inputs verified |
| Kerb mass (DIN) | **2435 kg** | [VERIFIED] | `Leergewicht nach DIN/EU kg 2435 / 2510` |
| Kerb mass (EU) | 2510 kg | [VERIFIED] | EU = DIN + 75 kg driver + luggage allowance |
| System power | **535 kW** (727 PS) | [VERIFIED] | `Systemleistung` — combined ICE + e-motor |
| System torque | **1000 Nm** | [VERIFIED] | `Systemdrehmoment` |
| ICE power / torque | 430 kW (585 PS) / 750 Nm | [VERIFIED] | 4395 cm³ V8 M TwinPower Turbo |
| E-motor peak / torque | 145 kW (197 PS) / 280 Nm | [VERIFIED] | 450 Nm effective after pre-gearing |
| 0–100 km/h | **3.5 s** | [VERIFIED] | `Fahrleistungen` |
| 0–200 km/h | 10.9 s | [VERIFIED] | Useful for validating the high-speed drag term |
| 80–120 km/h (4th/5th) | 2.2 / 2.9 s | [VERIFIED] | **Directly in the 50–75 mph band** |
| Top speed | **250 km/h** limited / **305 km/h** | [VERIFIED] | 305 with optional M Driver's Package |
| Drivetrain | M xDrive AWD | [VERIFIED] | Full-hybrid, 8-speed M Steptronic |
| Battery (gross/net) | **22.1 / 18.6 kWh** | [VERIFIED] | Li-ion, underfloor, 347.5 V |
| Electric range (WLTP) | 67–69 km | [VERIFIED] | Electric-only top speed 140 km/h |
| Tires (front/rear) | 285/40 ZR20 / 295/35 ZR21 | [VERIFIED] | Staggered |
| Track (front/rear) | 1684 / 1660 mm | [VERIFIED] | Not needed for A — it is published |
| Height | 1510 mm | [VERIFIED] | L/W/H 5096 / 1970 / 1510 |
| **Rolling resistance (Crr)** | — | **[UNPUBLISHED]** | See §7 |

---

## 4. Tesla Cybertruck — Cyberbeast (tri-motor AWD)

**Trim selected: Cyberbeast.** The AWD and Cyberbeast differ materially — see the variant note
below. The Cyberbeast is the flagship and the better-documented of the two in secondary sources.

> ⚠️ **No manufacturer source was obtainable.** `https://www.tesla.com/cybertruck/specs`
> returns **HTTP 403 Forbidden** to automated fetches — verified firsthand during this exercise,
> confirming the prior audit's claim. Tesla also publishes no German-style `cX x A` sheet; there
> is no Tesla equivalent of BMW PressClub's technical data PDF. **Every value in this table is
> [SECONDARY] or [ESTIMATED]. None is [VERIFIED].**

**Secondary source:** https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast

| Parameter | Value | Tag | Notes |
|---|---|---|---|
| **Drag coefficient (Cd)** | **0.335** | **[SECONDARY]** | Widely and consistently reported; **not manufacturer-confirmed via any fetchable primary source** |
| **Frontal area (A)** | **≈ 3.06 m²** | **[ESTIMATED]** | See derivation below — **weakest number in this document** |
| **Cd·A** | ≈ 1.02 m² | [ESTIMATED] | `0.335 × 3.06` — a secondary × an estimate |
| Curb mass | 3104 kg (6843 lb) | [SECONDARY] | US curb convention (no driver) |
| Power | 622 kW (834–845 hp) | [SECONDARY] | Tri-motor; sources vary 834–845 hp |
| Torque | 1390 Nm (1025 lb-ft) | [SECONDARY] | |
| 0–60 mph | 2.6 s | [SECONDARY] | Likely excludes 1-ft rollout — **not directly comparable to BMW's 0–100 km/h**; see §6 |
| Top speed | 209 km/h (130 mph) | [SECONDARY] | |
| Drivetrain | Tri-motor AWD | [SECONDARY] | |
| Battery (gross/usable) | 123 / 120 kWh | [SECONDARY] | |
| Tires | 285/65 R20 | [SECONDARY] | All-terrain |
| Height | 1791 mm (70.5 in) | [SECONDARY] | |
| Body width (excl. mirrors) | 2032 mm (79.9 in) | [SECONDARY] | |
| **Track width (front/rear)** | — | **[UNPUBLISHED]** | Not findable in any source. Blocks a proper area estimate. |
| **Rolling resistance (Crr)** | — | **[UNPUBLISHED]** | All-terrain tires likely raise it materially — see §7 |

### Frontal area derivation — and why it is the weakest number here

The standard estimate is `A ≈ 0.84 × track_width × height`. **Cybertruck track width is
unpublished**, so the formula cannot be applied as intended. Substituting body width
(excluding mirrors) as a proxy:

```
A ≈ 0.84 × 2.032 m × 1.791 m = 3.06 m²
```

**This estimate carries a compounding caveat, stated plainly:** the 0.84 coefficient is
calibrated against *track width*, and body width exceeds track width. Using body width therefore
**biases the result high**. The true value plausibly falls in **~2.9–3.1 m²**, but that range is
judgment, not measurement.

**This propagates directly into the result.** A ±5% error in A is a ±5% error in the drag force,
which at 65–95 mph is the dominant term. The Cybertruck's simulated top-end performance is
uncertain to at least this degree — **before** accounting for the fact that its Cd is also
merely secondary.

### Variant note — AWD vs Cyberbeast

These are **not interchangeable**. The dual-motor AWD is ~448 kW (~600 hp), 0–60 ≈ 4.1 s, top
speed ≈ 112 mph, and roughly 110 kg lighter [SECONDARY, lower confidence — the AWD variant page
was not independently retrievable]. Cd and frontal area are effectively shared. **Any published
result must name the trim**, since the power gap alone is ~40%.

---

## 5. Waymo — Jaguar I-Pace EV400

Waymo's fleet is built on the **Jaguar I-Pace** (EV400, 2018–2024). Spec sourcing therefore
splits cleanly into two parts: **the Jaguar base vehicle** (well sourced) and **the Waymo
modifications** (not sourced at all).

### 5a. Jaguar I-Pace EV400 base vehicle

**Primary source:** Jaguar Land Rover Media Newsroom — "2019 Jaguar I-PACE"
https://media.jaguarlandrover.com/en-us/news/2018/03/2019-jaguar-i-pace

| Parameter | Value | Tag | Notes |
|---|---|---|---|
| **Drag coefficient (Cd)** | **0.29** | **[VERIFIED]** | JLR verbatim: *"assist the I‑PACE in achieving a drag coefficient of just 0.29Cd"* |
| **Frontal area (A)** | **≈ 2.16 m²** | **[ESTIMATED]** | Jaguar does not publish it — see derivation |
| **Cd·A** | ≈ 0.63 m² | [ESTIMATED] | `0.29 × 2.16` — verified Cd × estimated A |
| Power | 294 kW (394 hp) | [VERIFIED] | Twin concentric motors |
| Torque | 512 lb-ft | [VERIFIED] | = **694 Nm** [ESTIMATED — unit conversion, `512 × 1.35582`] |
| 0–60 mph | 4.5 s | [VERIFIED] | |
| Top speed | 124 mph (200 km/h) | [VERIFIED] | |
| Battery | 90 kWh | [VERIFIED] | Li-ion, 432 NMC pouch cells |
| Range | up to 240 mi | [VERIFIED] | Base vehicle, pre-sensor-load |
| Drivetrain | AWD, twin motor | [VERIFIED] | Front + rear concentric |
| Kerb mass | 2208 kg (4868 lb) | **[SECONDARY]** | EU kerb convention. **Not on the JLR page** — https://www.evspecs.org/tech-specs/jaguar/i-pace/ev400 |
| Height | 1565 mm | [SECONDARY] | Not on the JLR release |
| Track (front/rear) | 1644 / 1652 mm | [SECONDARY] | 64.7 / 65.4 in |
| **Rolling resistance (Crr)** | — | [UNPUBLISHED] | See §7 |

**Frontal area derivation** (Jaguar publishes Cd but *not* area — unlike BMW's paired line):

```
A ≈ 0.84 × track_front × height
  = 0.84 × 1.644 m × 1.565 m
  = 2.16 m²
```

Caveat: the 0.84 factor is calibrated on passenger cars and is known to **under**-estimate for
tall crossovers. Some references place the I-Pace nearer 2.3 m². **The estimate is tagged, not
tuned** — it has not been adjusted to match an expected answer.

### 5b. Waymo sensor suite — mass and drag penalty: **UNPUBLISHED**

**Waymo publishes neither the mass nor the aerodynamic penalty of its sensor pods.** This was
searched directly and the answer is a clean negative:

- Waymo's public data releases are **perception sensor data** (Phoenix/SF) — for training
  self-driving perception. They contain **no vehicle-dynamics parameters**, no mass budget, no
  aero data. This is consistent with `ARCHITECTURE.md` §10.
- Waymo's hardware announcements (5th-gen sensor suite) describe capability and cost reduction.
  **No mass or drag figures.**
- Teardown/industry coverage (Tangram Vision, Forbes, ITS International) enumerates the sensor
  *configuration* — lidar, radar, cameras, compute — but **states no weight or Cd delta**.

**The only adjacent public figure** is a reported ~562 Wh/mi consumption for a retrofitted Waymo
I-Pace [SECONDARY, and it is an *aggregate efficiency* number, not an isolated sensor penalty —
it confounds sensor drag, sensor mass, compute load, and driving style, and **cannot be
decomposed** into a Cd or mass delta without assumptions this document declines to make].

**Therefore:**

| Parameter | Value | Tag |
|---|---|---|
| Sensor suite mass | **Unknown** | **[UNPUBLISHED]** |
| Sensor drag penalty (ΔCd, ΔA) | **Unknown** | **[UNPUBLISHED]** |

**This gap is left open on purpose.** The roof pod is a large, bluff, high-mounted body sitting
in undisturbed flow — physically it is *certain* to raise both Cd and A non-trivially, and the
compute hardware certainly adds mass. But "certainly non-zero" is not a number.

**Recommended handling — pick one, and label it:**
- **(a) Model the base I-Pace and label it as such.** Honest, and *knowingly optimistic* — it
  under-states drag and mass. Preferred default.
- **(b) Introduce an explicit `sensor_penalty` parameter defaulted to zero,** exposed in the UI
  as an unknown the user may set. **Do not hard-code a guessed value.**

Either way: **a Waymo result is a Jaguar I-Pace result.** Do not present it as a measured Waymo.

---

## 6. Where these values feed the physics

The road-load equation:

```
F = 0.5·ρ·Cd·A·v²  +  Crr·m·g·cos(θ)  +  m·g·sin(θ)  +  m·a
     └─ aerodynamic ─┘  └─ rolling ──┘   └─ grade ──┘   └ inertia ┘
```

with air density `ρ ≈ 1.225 kg/m³` at sea level, 15 °C. **`ρ` is itself an input the sim must
declare** — it varies ~10–15% with altitude and temperature and is not a vehicle property.

Mapping of sourced parameters to terms:

| Term | Consumes | Best-sourced vehicle | Worst |
|---|---|---|---|
| Aerodynamic | **Cd, A** (as the product **Cd·A**) | M5 (both verified) | Cybertruck (secondary × estimate) |
| Rolling | **Crr**, m | **None — Crr unpublished for all three** | — |
| Grade | m, θ | M5 (DIN mass verified) | Cybertruck (secondary) |
| Inertia | m | M5 | Cybertruck |

**Cd·A is the quantity that actually enters the equation** — never Cd alone. This is why BMW's
paired `cX x A` line is so valuable and why a Cd-without-area source (US press releases,
most outlets) is only half a parameter.

### Cd·A comparison — the single most decisive derived number

| Vehicle | Cd | A (m²) | **Cd·A (m²)** | Confidence |
|---|---|---|---|---|
| Jaguar I-Pace | 0.29 [V] | 2.16 [E] | **0.63** | Medium — verified Cd, estimated A |
| BMW M5 | 0.32 [V] | 2.55 [V] | **0.82** | **High — both verified** |
| Cybertruck Cyberbeast | 0.335 [S] | 3.06 [E] | **1.02** | **Low — neither verified** |

The Cybertruck's drag load is **~25% higher than the M5's** and **~62% higher than the I-Pace's**
— but that spread is exactly where the sourcing is weakest.

### Mass convention warning — do not mix conventions

Three different conventions appear above and **they are not interchangeable**:

- **DIN** (BMW 2435 kg): vehicle + 90% fuel, **no driver**.
- **EU** (BMW 2510 kg, I-Pace 2208 kg): DIN + **75 kg driver** + luggage allowance.
- **US curb** (Cybertruck 3104 kg): vehicle with fluids, **no driver**.

Comparing the M5's **EU** 2510 kg against the Cybertruck's **US curb** 3104 kg silently gives the
M5 a ~75 kg handicap. **The sim must normalize to one convention** — recommend **DIN/US-curb
(driverless)** — and add a driver mass explicitly. For the I-Pace, only the EU figure was found;
subtracting 75 kg to reach ≈2133 kg DIN-equivalent is an [ESTIMATED] step and should be tagged.

### Acceleration figures are not comparable as published

- BMW M5: **0–100 km/h, 3.5 s**, no rollout deduction.
- BMW M3 CS Touring: **3.5 s**, and **3.2 s** with 1-ft rollout deducted — the sheet publishes
  both, which quantifies the rollout effect at **~0.3 s**.
- Cybertruck: **0–60 mph (96.6 km/h), 2.6 s** — different speed target, and US figures commonly
  *include* rollout.
- I-Pace: **0–60 mph, 4.5 s**.

**These should not be placed in the same column without conversion.** They are useful as
*validation checks* on the physics model, not as direct inputs — the sim derives acceleration
from forces. The M5's published **80–120 km/h (2.2 s)** is the most valuable such check, since it
sits inside the 65–95 mph band of interest.

---

## 7. Parameter confidence — what the sim should trust

### Which vehicle's results to trust most

1. **BMW M5 — HIGH.** The only vehicle with a manufacturer-published Cd **and** frontal area, and
   verified DIN mass. Its dominant force term is measured. Caveat: **all figures preliminary**
   (*vorläufige Werte*).
2. **Jaguar I-Pace (Waymo) — MEDIUM.** Cd verified by JLR; frontal area estimated; mass
   secondary. **Additionally, the Waymo configuration is not the modeled configuration** — the
   sensor penalty is unpublished, so results are for a *base Jaguar*.
3. **Tesla Cybertruck — LOW.** Zero verified parameters. Cd secondary, area estimated from a
   proxy because track width is unpublished. **Both aerodynamic inputs are unverified**, and they
   are the two that matter most.

**Do not present a Cybertruck-vs-M5 result as a like-for-like comparison.** It is a measured car
against an inferred one.

### Which parameters most affect outcomes at 65–95 mph

At 65–95 mph (29–42 m/s), ranked by leverage:

1. **Cd·A — dominant.** Drag scales with **v²**. From 65→95 mph, drag force rises **~2.1×**
   (`(95/65)² = 2.14`). In this band aero is the largest resistive force on level ground. **An
   error in Cd·A is close to a proportional error in the result.** This is the whole reason the
   M3-vs-M5 decision matters.
2. **Mass — dominant on grades, and only there.** The grade term `m·g·sin(θ)` is
   **speed-independent** and scales linearly with mass. On a 4% grade the Cybertruck's ~3104 kg
   contributes ≈ `3104 × 9.81 × 0.04 ≈ 1218 N` — comparable to its entire aero load at 65 mph.
   **Mass decides hills; drag decides flats.** On level road at constant speed, mass barely
   matters (it enters only via Crr).
3. **Crr — moderate, and entirely unsourced.** Typically 0.008–0.015. At these speeds it is a
   minority term, but it is **not negligible**, and it is **[UNPUBLISHED] for all three
   vehicles** — a uniform, honest gap. The Cybertruck's **all-terrain 285/65 R20** tires
   plausibly sit at the high end, which would penalize it more than the others. **This is a known
   unmodeled bias, not a modeled one.**
4. **Power — matters for acceleration, saturates at steady speed.** At constant cruise, power
   only needs to match losses. It governs transitions and top speed, not steady-state.
5. **Air density ρ — a silent multiplier.** Scales the entire drag term linearly. At 1500 m
   elevation, ρ drops ~15%, cutting drag ~15%. **If routes have elevation, ρ must vary with it —
   otherwise the sim is precise about Cd and sloppy about the term Cd multiplies.**

---

## 8. What remains genuinely unknown

Stated plainly, because these bound how results may be interpreted.

| # | Gap | Affects | Consequence |
|---|---|---|---|
| 1 | **Crr for all three vehicles** | Rolling term | Must be assumed. Any value is a modeling choice, not data. Cybertruck's all-terrain tires are likely penalized *less* than reality. |
| 2 | **Cybertruck frontal area** (track width unpublished) | **Aero — dominant** | ~±5% or worse on the dominant force. |
| 3 | **Cybertruck Cd not manufacturer-confirmed** | **Aero — dominant** | 0.335 is consistently reported but tesla.com 403s. Widely-repeated ≠ verified. |
| 4 | **Waymo sensor mass + drag penalty** | Aero + mass + grade | Waymo results are **base-I-Pace results**. Known-optimistic in an unquantified direction. |
| 5 | **I-Pace frontal area** | Aero — dominant | Estimated; formula under-estimates for crossovers. |
| 6 | **I-Pace DIN-equivalent mass** | Grade/inertia | Only EU kerb found; the −75 kg step is inferred. |
| 7 | **BMW figures are preliminary** | All M5 params | *"vorläufige Werte."* Production values may differ. |
| 8 | **BMW M3 Cd — not published at all** | Aero | Confirmed by direct inspection of the official PDF. **Reason to prefer the M5.** |
| 9 | **Powertrain behavior beyond peak numbers** | Accel/top speed | No torque curves, gear-by-gear tractive effort, thermal derating, or battery-SoC power limits are published for **any** of the three. Peak power is a ceiling, not a curve. |
| 10 | **Drivetrain efficiency** | All tractive calc | Unpublished for all three. Typically assumed ~0.90–0.95. |

### What this means for interpreting results

- **Results are directionally meaningful, not predictive.** They express what published specs
  imply under a stated model — not what these vehicles would do on a road.
- **Precision must not exceed provenance.** Reporting a Cybertruck time to 0.01 s implies a
  confidence its ±5% frontal-area estimate cannot support. **Round to the uncertainty.**
- **Cross-vehicle margins inside ~±5% are noise.** If the M5 beats the Cybertruck by 2%, the
  honest statement is *"too close to call given parameter uncertainty."* A confident winner
  requires a margin exceeding the error bars on the worst-sourced input.
- **The asymmetry is directional, not random.** The Cybertruck's uncertainty is not
  centered noise — its area estimate is biased *high* (drag over-stated) while its Crr is likely
  *under*-stated. These partially cancel, by luck rather than design. Do not rely on it.
- **The physics is deterministic; the inputs are not.** SimZoner's arithmetic has one right
  answer. That guarantee applies to the *computation*, not to the *specs*. Determinism is not
  accuracy.

---

## 9. Source index

| # | Source | Type | Used for |
|---|---|---|---|
| 1 | [BMW PressClub DE — Der neue BMW M5](https://www.press.bmwgroup.com/deutschland/article/detail/T0443252DE/der-neue-bmw-m5) | **Manufacturer** | M5 narrative specs |
| 2 | [BMW M5 — Technische Daten (PDF)](https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213) | **Manufacturer** | **M5 `cX x A` = 0,32 x 2,55**, mass, power, torque, tires, gearing |
| 3 | [BMW M3 Touring / M3 CS — Technische Daten (PDF)](https://www.press.bmwgroup.com/deutschland/article/attachment/T0447610DE/627553) | **Manufacturer** | **Negative result: no `cX x A` line**; M3 mass/power/track/height |
| 4 | [JLR Media — 2019 Jaguar I-PACE](https://media.jaguarlandrover.com/en-us/news/2018/03/2019-jaguar-i-pace) | **Manufacturer** | **I-Pace Cd 0.29**, power, torque, 0–60, battery |
| 5 | [EVSpecs — Cybertruck Cyberbeast](https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast) | Secondary | All Cybertruck values |
| 6 | [EVSpecs — Jaguar I-Pace EV400](https://www.evspecs.org/tech-specs/jaguar/i-pace/ev400) | Secondary | I-Pace kerb mass, height |
| 7 | `https://www.tesla.com/cybertruck/specs` | **Blocked (HTTP 403)** | **Nothing — confirms Tesla blocks automated fetches** |

### Reproducibility note

The BMW figures were obtained by fetching the PressClub PDFs and extracting their text
(`pypdf`), not by reading summaries. The M3 negative result is a direct token search for
`Luftwiderstand` / `cX` across all three pages of source #3, returning zero matches — the same
search against source #2 returns the M5's line. **The M3 finding is a verified absence, not a
failure to find.**

---

*Every number above can be traced to the table in §9 or to a formula shown inline. Where it
could not be traced, it is marked [UNPUBLISHED] rather than filled in.*
