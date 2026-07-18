# SimZoner Security

Authoritative security document for SimZoner, a Cloudflare Workers + Pages race-simulation
app. This document describes the threat model, the platform protections we rely on, and the
application-layer controls. It is deliberately proportionate: SimZoner is a hobby/portfolio
app on the Cloudflare free tier with no user accounts, no PII, no payments, and no secrets in
code. We recommend controls that fit that reality and call out where enterprise features would
be overkill.

Scope of the deployment this document covers:
- Backend Worker `simzoner` with bindings for Workers AI (`AI`), Vectorize (`VECTORIZE`),
  D1 (`DB`), and KV (`CONFIG`). See `docs/ARCHITECTURE.md`.
- Next.js frontend hosted on Cloudflare Pages.
- Free tier only. No custom paid add-ons assumed.

Two kinds of claims appear below and are labeled explicitly:
- **[VERIFIED]** -- checked against Cloudflare's official documentation/blog, with a cited URL.
- **[GUIDANCE]** -- standard security practice or plan-tier detail that changes over time;
  treat as advice and re-verify current plan limits before relying on it.

---

## 1. Threat model (realistic, not inflated)

SimZoner has **no authentication, no user accounts, no PII, no payment data, and no secrets in
the codebase**. That removes most of the categories a typical web-app threat model worries
about. The honest, actual risks are narrow:

### 1a. Abuse of AI / Vectorize endpoints draining the free budget (PRIMARY RISK)
This is the single most realistic threat. Workers AI is metered in "neurons" and the free
allocation is a fixed daily budget; Vectorize queries and D1 reads/writes also have free-tier
limits. An abuser (or a buggy client, or a scraper) hammering a race-setup endpoint that runs
an embedding + Vectorize query can exhaust the daily neuron/query budget and take the app
offline for the rest of the day. There is no billing blast radius on the free tier (the account
is not charged past the free cap; calls simply start failing), so the impact is **denial of
service / availability**, not cost. Mitigations live in Section 4 (per-IP rate limiting on
budget-sensitive endpoints, CORS allowlist, input validation).

Note: the AI, Vectorize, D1, and KV calls are **in-process binding calls** (`env.AI`,
`env.VECTORIZE`, etc.), not outbound TLS fetches to third parties. That matters for Section 2.

### 1b. A secret committed to the repo in the future (PREVENTABLE RISK)
Today there are **zero secrets** in the repo (verified: `backend/wrangler.jsonc` contains only
binding names and non-sensitive resource IDs -- a D1 database ID and a KV namespace ID, which are
not credentials). The forward-looking risk is that a contributor later adds an API key, token,
or `.dev.vars` content to a committed file. This is handled by posture, not by a scanner we run
today: see Sections 4 and 5, and the contributor checklist in Section 7. [GUIDANCE] Adding a
pre-commit secret scanner (e.g. gitleaks) is a reasonable low-cost future step but is not
required for the current zero-secret state.

### 1c. Supply-chain / dependency vulnerabilities (ONGOING, LOW-EFFORT MITIGATION)
The Worker and the Next.js frontend pull in npm dependencies. A compromised or vulnerable
transitive dependency is the classic supply-chain risk. Because there are no secrets and no
user data to exfiltrate, the blast radius is limited, but a malicious build-time dependency
could still tamper with deployed output. [GUIDANCE] Mitigate with `npm audit`, Dependabot/Renovate
for automated updates, and lockfile-pinned installs (`npm ci`). This is proportionate; a full
SBOM/SLSA pipeline would be overkill for a portfolio app.

### 1d. Denial of service (LARGELY HANDLED BY THE EDGE)
Volumetric and protocol DoS (L3/L4 and generic L7 floods) are absorbed by Cloudflare's edge
before traffic reaches the Worker -- see Section 3. What the edge does **not** solve for free is
*application-semantic* abuse: a modest number of well-formed requests that each trigger an
expensive AI/Vectorize call (i.e. risk 1a). That gap is closed at the application layer
(Section 4), not by DDoS protection.

### What is explicitly NOT a concern, and why
- **Account takeover / auth bypass / session hijacking** -- there is no auth system and no
  sessions. N/A.
- **PII / GDPR / data-breach exposure** -- no personal data is collected or stored. Race inputs
  and results are non-personal simulation data.
- **Payment / cardholder data (PCI)** -- no payments. N/A.
- **SQL injection into D1** -- mitigated structurally by using parameterized/prepared statements
  (owned by the backend, see `docs/ARCHITECTURE.md`); there is no user-authenticated data to
  exfiltrate even on a hypothetical injection.
- **Secret exfiltration at runtime** -- there are no runtime secrets to steal (Section 5).
- **Insider threat / privileged-user abuse** -- single-maintainer hobby project; formal RBAC,
  audit logging, and separation-of-duties controls would be overkill and are intentionally
  out of scope.

---

## 2. Post-quantum cryptography on Cloudflare

Cloudflare has deployed hybrid post-quantum key agreement across its network. "Hybrid" means a
classical algorithm (X25519) is combined with a post-quantum KEM (ML-KEM-768, FIPS 203) so the
connection stays secure even if one of the two is broken; the deployed named group is
**X25519MLKEM768**. Its purpose is to defend against "harvest-now, decrypt-later" attacks --
traffic recorded today and decrypted by a future quantum computer.

### 2a. Inbound: visitor -> Cloudflare edge (AUTOMATIC, NOTHING TO DO)
**[VERIFIED]** Inbound TLS 1.3 connections from end-user clients to Cloudflare's edge already
negotiate the X25519MLKEM768 hybrid automatically, at no cost and with no configuration. The
Cloudflare developer-platform products explicitly covered include **Workers custom domains,
`*.workers.dev`, and Pages** (also R2 public buckets, Stream, and Images). SimZoner's frontend
(Pages) and backend (`*.workers.dev` and/or a Workers custom domain) therefore get post-quantum
inbound key agreement with zero developer action.

Caveat (stated honestly): this protects the hop **only when the client also supports the hybrid**.
Post-quantum negotiation is opportunistic -- a browser that doesn't offer X25519MLKEM768 falls
back to classical X25519. Client support today includes Chrome 131+, Edge 131+, Firefox 132+
(desktop), and Safari 26+. The developer cannot force a non-supporting client to use it; this is
a property of the TLS handshake, not something the app configures.

Sources:
- https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-cloudflare-products/
- https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-support/
- https://blog.cloudflare.com/post-quantum-for-all/

### 2b. Outbound: Cloudflare/Worker -> origin, including `fetch()` (CONFIGURABLE, MOSTLY N/A HERE)
**[VERIFIED]** Cloudflare supports post-quantum key agreement on **outbound** connections to
origin servers, and this includes `fetch()` requests made by Workers. Per the docs: "This
setting affects all outbound connections from the zone you specify in the API call, including
`fetch()` requests made by Workers on your zone." Cloudflare uses the same X25519MLKEM768 hybrid.

There are three modes, set per zone via the API:
- **supported** (default): advertises post-quantum capability but sends a classical keyshare in
  the first ClientHello. No extra round trip in the common case; upgrades to hybrid if the origin
  asks for it. This is the default and requires no action.
- **preferred**: sends the post-quantum keyshare in the initial ClientHello (avoids the extra
  round trip when the origin already supports PQC). Opt-in via the API.
- **off**: disables it.

What this means for SimZoner, honestly: the app's data-plane calls to Workers AI, Vectorize, D1,
and KV are **in-process binding calls, not outbound TLS `fetch()` to external origins**, so the
outbound-PQC setting largely does not apply to them. If the Worker later adds an outbound
`fetch()` to a third-party HTTPS origin, that connection will already use the **supported** mode
by default with no code change; switching to **preferred** is an optional API tweak and only has
an effect if that origin itself supports PQC. Note also that per-zone configuration requires a
**zone** (a custom domain on Cloudflare); a plain `*.workers.dev` deployment has no zone to
configure and simply gets the default behavior. For this app, **no action is recommended** here.

Sources:
- https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-to-origin/
- https://blog.cloudflare.com/post-quantum-to-origins/
- https://developers.cloudflare.com/ssl/post-quantum-cryptography/

### 2c. Application-level cryptography
SimZoner implements **no** cryptography of its own (no token signing, no encryption at rest of
custom data, no password hashing -- because there are no tokens, secrets-at-rest, or passwords).
There is therefore no app-owned crypto to make post-quantum. The post-quantum story here is
entirely "we benefit from Cloudflare's transport-layer PQC for free," which is the correct and
honest characterization.

---

## 3. Edge protections (what comes free vs. what is paid)

SimZoner runs on the free tier, so this section distinguishes what is genuinely free from what
would require a paid plan. Plan-tier boundaries change over time -- the free/paid split below is
**[GUIDANCE]**; verify current limits at the cited docs before relying on a specific number.

### 3a. DDoS mitigation -- FREE, AUTOMATIC
**[VERIFIED]** Cloudflare provides unmetered, automatic L3/L4 and L7 DDoS protection on all
plans, including Free, always-on with no configuration. This is the main reason risk 1d is
"largely handled."
Source: https://developers.cloudflare.com/ddos-protection/

### 3b. TLS / HTTPS -- FREE, AUTOMATIC
**[VERIFIED]** Universal SSL provisions TLS certificates automatically for all plans including
Free, and inbound TLS 1.3 gets post-quantum key agreement automatically (Section 2a). [GUIDANCE]
Enable "Always Use HTTPS" / HSTS in the dashboard to force the upgrade; these are free settings.
Source: https://developers.cloudflare.com/ssl/

### 3c. WAF -- LIMITED FREE, FULL RULESET PAID
**[GUIDANCE]** The Free plan includes the Cloudflare Free Managed Ruleset (protection against
high-profile, widely-exploited vulnerabilities) and a small number of user-defined custom WAF
rules. The full WAF Managed Rules (Cloudflare Managed Ruleset, OWASP Core Ruleset, per-rule
tuning) require Pro or above. For a no-auth, no-PII simulation app, the free managed ruleset is
adequate; buying WAF tiers for this app would be overkill.
Source: https://developers.cloudflare.com/waf/

### 3d. Rate limiting -- LIMITED FREE, ADVANCED PAID
**[GUIDANCE]** The Free plan includes a limited rate-limiting capability (a small number of rules
with coarse granularity). Advanced Rate Limiting (fine-grained keys, complex characteristics)
is a paid feature. Because our primary risk (1a) is endpoint-budget abuse, we do **not** rely on
Cloudflare's free rate limiting alone -- we implement application-layer per-IP limiting in the
Worker (Section 4b), which is free, precise, and lets us protect exactly the AI/Vectorize
endpoints that matter.
Source: https://developers.cloudflare.com/waf/rate-limiting-rules/

### 3e. Bot management -- BASIC FREE, ADVANCED PAID
**[GUIDANCE]** Bot Fight Mode (a basic, on/off bot challenge) is available on the Free plan.
Super Bot Fight Mode requires Pro+, and enterprise Bot Management is paid. Enabling Bot Fight
Mode is a reasonable free step to blunt naive scrapers hitting AI endpoints; the paid bot
products are overkill here.
Source: https://developers.cloudflare.com/bots/

---

## 4. Application-layer controls (owned by the backend, cross-referenced here)

These controls are implemented in the Worker/frontend code, which is **owned by the backend**
(see `docs/ARCHITECTURE.md` and `docs/SYSTEM_DESIGN.md`). This document specifies *what* is
required and *why*; it does not re-implement them. Where a control is not yet present, it is a
recommendation for the backend owner.

### 4a. CORS allowlist
The Worker must respond with an explicit `Access-Control-Allow-Origin` **allowlist** limited to
the known SimZoner Pages origin(s), not `*`, for any endpoint that mutates state or spends
budget. This prevents arbitrary third-party sites from driving the AI/Vectorize endpoints from
users' browsers.

### 4b. Per-IP rate limiting on budget-sensitive endpoints
The endpoints that trigger Workers AI embeddings and Vectorize queries (i.e. race setup) must be
rate-limited per client IP inside the Worker. This is the direct mitigation for risk 1a and is
free and precise. A KV- or Durable-Object-backed counter keyed on `CF-Connecting-IP` is the
standard pattern; the DO SQLite decision cache described in the architecture docs is a natural
home for counters. Keep the limit low enough to protect the daily neuron budget from a single
source.

### 4c. Input validation
All request bodies and query parameters must be validated and bounded before any binding call:
enforce types, ranges, string lengths, and array sizes; reject oversized or malformed payloads
early (before spending an embedding/AI call). This protects the budget (fail before the neuron
spend) and guards D1 queries.

### 4d. Security headers
Responses (especially the Pages frontend) should set standard hardening headers: a restrictive
`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`X-Frame-Options`/`frame-ancestors`, and `Strict-Transport-Security`. These are free and reduce
clickjacking/injection surface.

### 4e. No-secrets-in-code posture
The app carries no secrets today and should keep it that way. Any future secret goes through
`wrangler secret put` (production) or a gitignored `.dev.vars` (local) -- never into a committed
file. See Section 5.

---

## 5. Secrets management

**Current state: SimZoner has zero secrets.** `backend/wrangler.jsonc` holds only binding names
and non-sensitive resource identifiers (D1 database ID, KV namespace ID) -- these are not
credentials and are safe to commit. There are no API keys or tokens anywhere in the repo.

The correct pattern to preserve this, if a secret is ever needed:

- **Never** put a secret in `wrangler.jsonc` / `wrangler.toml`. Those files are committed to git,
  so anything in them is public repo history forever.
- **Production secrets:** use `wrangler secret put <NAME>`. Wrangler stores the value encrypted
  and injects it into the Worker at runtime via `env.<NAME>`. The value never touches the repo.
  - Example: `npx wrangler secret put SOME_API_KEY`
- **Local development secrets:** put them in a `.dev.vars` file in the Worker directory
  (`KEY=value` per line). Wrangler loads it for `wrangler dev`. `.dev.vars` **must** be listed in
  `.gitignore` and never committed.
- **Rotation:** if a secret is ever exposed, rotate it at the provider immediately and re-run
  `wrangler secret put`; deleting it from git history is necessary but not sufficient (assume any
  pushed secret is already compromised).

Reference:
- https://developers.cloudflare.com/workers/configuration/secrets/

---

## 6. Responsible disclosure / contact

SimZoner is a personal portfolio project, not a commercial service; there is no bug-bounty
program and no SLA. Security reports are nonetheless welcome and appreciated.

- **Contact:** ayman.mohammad2025@gmail.com
- **What to send:** a description of the issue, affected endpoint/URL, and reproduction steps.
- **Please do not:** run automated scanners or load/stress tests against the live free-tier
  deployment (it shares the very neuron/query budget this document is about -- testing it *is* the
  denial-of-service). A written description is enough.
- **Response expectation:** best-effort, on a hobby-project timeline. No formal triage window is
  promised.

Because there is no user data and no payment data, most "breach" scenarios do not apply; the most
useful reports are about budget-draining abuse vectors (Section 1a) or an accidentally committed
secret (Section 1b).

---

## 7. Security checklist for contributors

Before opening a pull request:

- [ ] No secret, API key, token, password, or credential in any committed file -- including
      `wrangler.jsonc`, source, tests, and fixtures. Secrets go through `wrangler secret put`
      (prod) or gitignored `.dev.vars` (local).
- [ ] `.dev.vars` (and any `*.dev.vars`) is gitignored and not staged.
- [ ] Any new endpoint that calls Workers AI, Vectorize, or D1 has input validation and, if it
      spends budget, per-IP rate limiting (Section 4b/4c).
- [ ] CORS on state-changing / budget-spending endpoints uses the origin allowlist, not `*`
      (Section 4a).
- [ ] New/updated frontend responses keep the security headers intact (Section 4d).
- [ ] Dependencies added deliberately; `npm audit` reviewed; lockfile committed; install via
      `npm ci` in CI (Section 1c).
- [ ] No new PII collection, no auth/session system, and no runtime secret introduced without
      updating this document.
- [ ] D1 access uses parameterized/prepared statements, never string-concatenated SQL.

---

## Appendix: verified post-quantum facts and sources

- **X25519MLKEM768** is Cloudflare's deployed hybrid key agreement: classical X25519 combined
  with post-quantum ML-KEM-768 (FIPS 203), defending against harvest-now-decrypt-later attacks.
  https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-support/
- **Inbound (client -> edge)** post-quantum key agreement is **automatic** on TLS 1.3 and
  explicitly covers Workers custom domains, `*.workers.dev`, and Pages -- no developer action.
  https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-cloudflare-products/
- **Outbound (Cloudflare/Worker `fetch()` -> origin)** supports post-quantum; the zone setting
  "affects all outbound connections ... including `fetch()` requests made by Workers on your
  zone," with modes **supported** (default), **preferred**, and **off**.
  https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-to-origin/
- General PQC overview and rollout:
  https://developers.cloudflare.com/ssl/post-quantum-cryptography/ ,
  https://blog.cloudflare.com/post-quantum-for-all/ ,
  https://blog.cloudflare.com/post-quantum-to-origins/

_Last reviewed: 2026-07-17. Re-verify plan-tier ([GUIDANCE]) details against Cloudflare docs
before relying on specific limits._
