# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first — it is the canonical agent operating guide** (runtime
constraints, the CWL security/review gate protocol, trivy-fs remediation, CodeGraph usage).
This file complements it with commands and architecture; if anything here conflicts with
`AGENTS.md`, `AGENTS.md` wins.

## What ScopeWeave is

Schedule-control (공정관리) WBS planner with cumulative progress, EVM (SPI·SV) + S-curve,
CPM critical path, and a weekly Gantt overlay. Two modes:

- **Standalone** — zero-dependency static HTML/CSS/JS client; data in
  `localStorage`/`wbs.json`; deployable to any static host (GitHub Pages).
- **Cloud (SaaS)** — opt-in Node backend (`server/`) adds auth/SSO, multi-tenant
  workspaces, SSE live collaboration, billing, baselines, webhooks, and a public API.
  The static client is the frontend; cloud features layer on without breaking standalone.

## Common commands

```bash
# Standalone client (no install needed)
python3 -m http.server 4173          # open http://127.0.0.1:4173

# Cloud server (Node ^22.13.0 || >=23.4.0 — uses node:sqlite; matches package.json engines)
npm install
npm run server                       # API + static client on :8787

# Tests
npm run test:unit                    # pure-math: EVM/S-curve, CPM, baselines, workload, …
npm run test:api                     # API smoke (auth·tenancy·RBAC·billing·webhooks) + rate limit
npm run test:e2e                     # Playwright UI suite (auto-starts http.server on :4173)
npm run test:e2e:cloud               # cloud UI spec only
npm run fuzz                         # fast-check property fuzz (node --test tests/fuzz/*.mjs)
python3 -m pytest tests/config       # workflow-ownership / governance checks

# Single test: unit tests are plain Node scripts
node tests/unit/cpm.test.mjs
npx playwright test tests/e2e/scopeweave.spec.js

# Full stack via Docker (needs SCOPEWEAVE_JWT_SECRET — persist across restarts)
# Generate once and store outside git (e.g. shell profile / secrets manager).
# Re-running openssl each start mints a new key and invalidates existing JWTs.
: "${SCOPEWEAVE_JWT_SECRET:?Set a persistent ≥32-char secret before starting}"
# First-time only: export SCOPEWEAVE_JWT_SECRET="$(openssl rand -base64 32)"
docker compose up --build            # Dockerfile.server → :8787
```

Environment variables (`SCOPEWEAVE_JWT_SECRET`, `SCOPEWEAVE_DB`, `PORT`, OIDC/Stripe
config, rate limiting) are documented in `docs/deploy.md`; API reference is `docs/api.md`.

## Architecture

### Client (repo root)

- `index.html` — app shell + modals, strict CSP meta tag; loads `styles.css`,
 `toast-state.css`, `cloud-sync.js`, `analytics.js`, then `app.js`.
- `app.js` — all state, rendering, editing, validation, persistence, CSV
  import/export, and Gantt logic. The single global `tasks` array is the source of
  truth and `renderAll()` is the only rerender path (see `AGENTS.md`).
  **`app.js` must stay eval-safe: no top-level `import`/`export`** — the test harness
  evaluates it with `new Function`, and CI enforces this.
- `analytics.js` — EVM/S-curve/CPM pure math (ESM exports so unit tests can import
  it) plus an optional DOM panel; bridges onto `window.ScopeWeaveAnalytics`.
- `cloud-sync.js` — opt-in cloud overlay: login UI, project open/save, SSE live sync,
  optimistic concurrency (409 on stale version). Logged out it is a no-op; bridges
  onto `window.ScopeWeaveCloud`.
- Because `app.js` cannot use import statements, optional modules bridge via
  `window.*` globals and `app.js` calls them with optional chaining
  (`window.ScopeWeaveCloud?.push?.(payload)`).
- `landing.html` / `landing.en.html` — marketing pages; `wbs.json` — seed data.

### Server (`server/`)

- `server.mjs` — `@hono/node-server` entry (PORT, default 8787), serves the API and
  the static client via a strict allowlist.
- `app.mjs` — Hono routes (auth/SSO, projects, teams, billing, webhooks, baselines,
  revisions, comments, search…); `auth.mjs` — scrypt + pinned-HS256 JWT + PAT hashing;
  `billing.mjs` — plans/caps, Stripe via dynamic import; `db.mjs` — `node:sqlite`.
- Only two runtime dependencies (`hono`, `@hono/node-server`); everything else is
  Node built-ins. Do not add runtime dependencies (repository contract in
  `AGENTS.md`/`README.md`); dev-only tooling is allowed.

### Persistence

- Standalone: every mutation autosaves to `localStorage`; optional File System Access
  API sync to `wbs.json`. Synthetic hierarchy wrapper rows are stripped from external
  `wbs.json` sync so the saved JSON stays in the user-facing schema.
- Cloud: server-side versioned saves (last 20 revisions), SSE fan-out to
  collaborators, offline fallback to the standalone model.

### Deployment surfaces

- `Dockerfile.server` — node:22-alpine image running `server/server.mjs`: the full
  SaaS stack (API + static client) on :8787. Used by `docker-compose.yml`.
- `Dockerfile` — nginx-alpine static-client-only image on :8080
  (`infra/nginx/default.conf`; `infra/k8s/` manifests deploy this one).
- `.github/workflows/pages.yml` — GitHub Pages deploy of the standalone client on
  push to `develop`.

## Git and CI

- **Default branch is `develop`.** Before retargeting or merging stacked work, refetch the live protected `develop` tip, each PR's exact base/head ancestry, and current required evidence; do not rely on a hard-coded merge order.
- Repo-local PR gates: `server-tests.yml` (unit + API + eval-safe check + cloud e2e),
  `fuzz.yml`, `codeql.yml`, `dependency-review.yml`.
- OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler are
  organization-level required workflows from `ContextualWisdomLab/.github` — never
  copy them into this repository (`tests/config` pytest enforces this).
- A failing `trivy-fs` is a real finding, not a flake — follow the remediation
  protocol in `AGENTS.md`.

## Key conventions

- Keep the client static-host compatible; standalone mode must never break.
- Browser-native APIs only in the client — no frameworks, no inline styles (extend
  `styles.css` instead).
- `ARCHITECTURE.md` records core decisions; UI copy is Korean (`landing.en.html` is
  the English variant).
- `.jules/*.md` hold accumulated learnings — performance (`bolt.md`: build a `Map`
  before ID lookups in render loops, avoid O(N²)), accessibility (`palette.md`), and
  security (`sentinel.md`: `Object.create(null)` for untrusted-key maps,
  `crypto.randomUUID()`, CSP). Follow them when touching related code.
- `.agents/skills/github-robot-review-gate/SKILL.md` covers diagnosing PR merge-gate
  blockers (CodeRabbit robot-review policy, required checks, rulesets).
