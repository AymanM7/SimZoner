# CI/CD Security

This document describes the hardened GitHub Actions setup for SimZoner, the
supply-chain hardening choices behind it, and the repository settings the owner
must enable manually in GitHub's UI (CI cannot toggle those).

## Workflows

All workflow files live under `.github/`.

### `.github/workflows/ci.yml` — build & typecheck

Runs on push and pull request to `main`.

- **`frontend-build`**: `npm ci` then `npm run build` in `frontend/` (Next.js 15).
  `frontend/.npmrc` sets `legacy-peer-deps=true`, so `npm ci` resolves cleanly.
- **`backend-typecheck`**: `npm ci` then `npx tsc --noEmit` in `backend/`
  (Cloudflare Worker, TypeScript).
- Node 20 via `actions/setup-node`, with npm download caching keyed off each
  subproject's `package-lock.json`.
- Top-level `permissions: contents: read` (least privilege). No job elevates.
- Includes a **disabled, commented-out** Cloudflare deploy example. Auto-deploy
  is intentionally OFF (see "Deploy is intentionally disabled" below).

### `.github/workflows/security.yml` — scanning

Runs weekly (cron `17 6 * * 1`, Mondays), on push to `main`, and on manual
`workflow_dispatch`.

- **`dependency-audit`** (matrix: frontend, backend): `npm audit
  --audit-level=high`. **Report-only** — see rationale below.
- **`gitleaks`**: official `gitleaks/gitleaks-action`, checks out full git
  history (`fetch-depth: 0`) and scans commits for leaked secrets.
- **`codeql`**: `github/codeql-action` init + analyze for the
  `javascript-typescript` language pack. This is the only job with write scope,
  and only `security-events: write` (plus `actions: read`), scoped to that job.
- Top-level `permissions: contents: read`; each job re-declares its own minimal
  `permissions:`.

### `.github/dependabot.yml` — automated dependency updates

Weekly update PRs for three ecosystems:

- **npm** in `/frontend`
- **npm** in `/backend`
- **github-actions** in `/` — this also bumps the SHA pins in the workflows
  above (Dependabot rewrites both the pinned SHA and its trailing version
  comment), so pinning does not mean the actions go stale.

The Python subprojects (`cloud-compute/`, `ml/`) are not yet covered; add a
`pip` ecosystem entry once they have a resolvable requirements/lock file.

## Hardening choices

### SHA-pinning every third-party action (core control)

Every non-`run` step that uses a third-party action is pinned to a **full
40-character commit SHA**, with a trailing comment naming the human-readable tag,
for example:

```yaml
uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
```

Why: a Git tag like `v7` is a **mutable pointer**. If an action's maintainer
account is compromised, an attacker can move that tag to a malicious commit, and
every workflow referencing `@v7` silently runs the attacker's code with your
`GITHUB_TOKEN` and secrets. This is the tag-hijack / mutable-reference
supply-chain attack class. A commit SHA is immutable and content-addressed, so a
pinned workflow always runs exactly the reviewed code. The trailing tag comment
keeps the pin human-readable, and Dependabot's `github-actions` updater proposes
reviewed bumps so the pin stays current without giving up immutability.

Pinned actions and versions currently in use:

| Action                          | SHA                                        | Tag     |
| ------------------------------- | ------------------------------------------ | ------- |
| `actions/checkout`              | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` | v7.0.0  |
| `actions/setup-node`            | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0  |
| `gitleaks/gitleaks-action`      | `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` | v3.0.0  |
| `github/codeql-action` (init/analyze) | `7188fc363630916deb702c7fdcf4e481b751f97a` | v4.37.1 |

These SHAs were resolved from each project's published tags at authoring time
(2026-07-17) and are the correct commit for the noted tag. When Dependabot (or a
maintainer) bumps a version, update both the SHA and the comment together.

### Least-privilege `GITHUB_TOKEN`

Both workflows set a top-level `permissions: contents: read`, which drops the
`GITHUB_TOKEN` from the default broad scope to read-only. Any capability beyond
reading the repo is granted **per job**, only where required:

- CI: no job needs more than read.
- Security: only `codeql` adds `security-events: write` (to upload scanning
  results) and `actions: read`. `dependency-audit` and `gitleaks` stay read-only.

This limits blast radius: if any step is compromised, the token it can reach
cannot push code, open PRs, or alter settings.

### `npm ci` for reproducible installs

Both build/scan paths use `npm ci`, never `npm install`. `npm ci` installs
strictly from `package-lock.json`, fails if `package.json` and the lockfile
disagree, and wipes `node_modules` first — giving deterministic, reproducible
dependency trees in CI and preventing silent lockfile drift or unexpected
transitive upgrades at build time.

### Dependency audit is report-only (rationale)

`npm audit --audit-level=high` runs with `continue-on-error: true`. High/critical
advisories are surfaced in the job log/summary but do not hard-block every PR.
Reasoning: many advisories live in transitive dependencies that cannot be fixed
on the spot, and a hard gate there blocks unrelated work. Dependabot is the
mechanism that actually drives upgrades. Once the dependency tree is clean, this
can be tightened into a hard gate (drop `continue-on-error`).

### Deploy is intentionally disabled

`ci.yml` contains a commented-out Cloudflare deploy job as a template only. No
deploy runs automatically, and **no secrets are referenced by any active step**.
To enable it later, the owner must create a least-privilege `CLOUDFLARE_API_TOKEN`
repository secret, gate the job behind a protected `production` environment with
required reviewers, then uncomment the job. Do not enable auto-deploy to `main`
without that review gate.

## Repository settings the owner must enable manually

The following are **GitHub repository/organization settings**. Workflows cannot
set them — they must be toggled in the GitHub web UI (or via `gh`/the REST API by
an admin). Enable them after the first push:

**Branch protection on `main`** (Settings -> Branches -> Add rule, or Rulesets):

- Require a pull request before merging.
- Require approvals (at least 1 review; more for shared repos).
- Dismiss stale approvals when new commits are pushed.
- Require status checks to pass before merging, and select the checks from these
  workflows: `Frontend build (Next.js)`, `Backend typecheck (Cloudflare Worker)`,
  and the security jobs (`CodeQL (javascript-typescript)`, `Secret scan
  (gitleaks)`). Note: a check only becomes selectable after it has run once, so
  push the workflows and let them run before configuring required checks.
- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Do not allow bypassing the above (including for admins) where practical.
- Restrict force pushes and branch deletion on `main`.

**Secret scanning & push protection** (Settings -> Code security):

- Enable **Secret scanning**.
- Enable **Push protection** (blocks commits that contain detected secrets
  before they land). This complements the in-CI gitleaks job — push protection
  stops secrets at push time; gitleaks provides history/PR scanning.

**Dependabot** (Settings -> Code security):

- Enable **Dependabot alerts**.
- Enable **Dependabot security updates**.
- `.github/dependabot.yml` already configures the weekly version-update PRs.

**Code scanning** (Settings -> Code security):

- Ensure **CodeQL / code scanning** results are allowed to be uploaded (the
  `security.yml` `codeql` job publishes them; results appear under the Security
  tab). On private repos this requires GitHub Advanced Security.

**Actions permissions** (Settings -> Actions -> General):

- Set "Fork pull request workflows" to require approval for first-time
  contributors (or all outside collaborators).
- Consider restricting allowed actions to "Allow <owner>, and select
  non-<owner>, actions" and pin-by-SHA policy for defense in depth.
- Confirm the default workflow token permission is set to **Read repository
  contents** (least privilege) at the org/repo level, matching the per-workflow
  `permissions:` blocks.

Being explicit: none of the settings in this final section can be created or
enforced by the committed CI files. They are account-level protections the
repository owner must switch on in GitHub's interface.
