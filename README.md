# ScopeWeave

ScopeWeave is a schedule-control (공정관리) WBS planner with two independently usable profiles over the same planning model:

- **Standalone** — static HTML/CSS/JavaScript, local-first persistence, no server required, deployable to GitHub Pages or any static host.
- **Cloud/SaaS** — the same client with a Node/Hono backend for accounts, multi-tenant workspaces, collaboration, schedule-control history, integrations and a public API.

Both profiles are present on protected `develop`. Standalone compatibility is a product invariant: cloud work must not make local planning depend on a server, database, credential or model.

## What is implemented on protected `develop`

### Planning and analysis

- three-level WBS hierarchy (`단계 > Activity > Task`) with expand/collapse;
- inline create/edit/delete and same-level subtree drag/reorder;
- planned/actual/weighted progress;
- CSV/JSON portability and optional File System Access API sync;
- weekly Gantt overlay;
- deterministic EVM/S-curve, CPM, workload, cost and PM-readiness analysis;
- responsive browser UI and Playwright regression coverage.

### Cloud/SaaS

- email/password authentication, JWT/PAT security and database-backed session revocation;
- organization/project tenancy and server-side RBAC;
- optimistic project versioning, revisions, baselines, comments and SSE collaboration;
- billing/entitlement, webhooks, audit/export/search and observability surfaces;
- attachment conversion/status integration through a replaceable Clearfolio adapter;
- contextual-orchestrator client integration;
- Node/SQLite self-host profile and container deployment surfaces.

Open PRs may harden or extend these capabilities. Their behavior is **not** shipped truth until the change reaches protected `develop`. In particular, do not infer production readiness from an open Clearfolio/orchestrator PR, a PR description or a development mock.

## Architecture

```text
index.html + styles.css + app.js      static planner / canonical browser state
  ├─ analytics.js                     deterministic schedule analytics
  └─ cloud-sync.js                    optional authenticated cloud overlay

server/
  ├─ server.mjs                       @hono/node-server entry
  ├─ app.mjs                          HTTP/API composition and authorization
  ├─ auth.mjs                         password/JWT/PAT security
  ├─ db.mjs                           current node:sqlite persistence
  ├─ billing.mjs                      plan/billing boundary
  ├─ clearfolio.mjs                   replaceable document adapter
  ├─ attachment_status.mjs            bounded attachment refresh engine
  └─ orchestrator.mjs                 contextual-orchestrator adapter
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the as-built authority and trust boundaries. `CLAUDE.md` contains detailed development commands; `AGENTS.md` is the canonical agent/governance guide.

## Runtime contract

The standalone client has no runtime package dependency. The cloud process uses only the production dependencies declared in `package.json` (currently Hono and `@hono/node-server`) plus Node built-ins. New production dependencies require a bounded product/security justification and may not break standalone operation.

`node:sqlite` is the persistence implementation on protected `develop`. PostgreSQL is a migration target and must not be described as shipped until an adapter, migration and recovery evidence integrate.

## Local development

Standalone:

```bash
python3 -m http.server 4173
# open http://127.0.0.1:4173
```

Cloud:

```bash
npm ci
export SCOPEWEAVE_JWT_SECRET="$(openssl rand -base64 32)"
npm run server
# API + static client on http://127.0.0.1:8787
```

Persist the JWT signing secret across restarts in real environments; regenerating it invalidates existing sessions. Deployment configuration and optional integrations are documented in [`docs/deploy.md`](docs/deploy.md).

## Verification

Run the paths applicable to the change:

```bash
npm run test:unit
npm run test:api
npm run test:coverage
npm run test:e2e
npm run test:e2e:cloud
npm run fuzz
python3 -m pytest tests/config
```

`app.js` must remain eval-safe: no top-level `import` or `export`. Optional browser modules bridge through explicit `window.ScopeWeave*` interfaces.

## Persistence and data ownership

- Standalone mutations autosave to `localStorage`; `wbs.json` remains the seed/portable format and can be synchronized through the File System Access API where supported.
- Synthetic hierarchy wrappers used internally for imported flat data are removed from external JSON synchronization.
- Cloud state is server-owned and tenant-authorized. Browser metadata does not become tenancy authority.
- New database objects use descriptive two-or-more-word `snake_case` names and new schema work follows 3NF by default.
- Cross-service application databases are not shared: ScopeWeave talks to external CWL services through explicit adapter/API boundaries.

## Security and review

- Organization-required OpenCode, Noema, Strix, Security/SAST and merge-policy workflows come from `ContextualWisdomLab/.github`; do not copy those workflows into this repository.
- Repository-native Server Tests, Fuzz, Dependency Review, OSV and related workflows provide ScopeWeave-specific evidence.
- Required evidence is exact-commit evidence. Pending, skipped, cancelled, failed, missing, predecessor-head or stale-base results do not count as passing.
- Protected `develop` requires current-head checks, resolved review threads and a qualifying independent approval under the live rulesets. Do not self-approve or weaken protection.
- Secrets, provider payloads and sensitive identifiers must not leak through browser errors, logs, metrics labels or model context.

## Current development priorities

The live GitHub PR/issue queue is the authoritative development plan. Current commercial gaps include:

- replacing broad session-JWT query transport with scoped ephemeral access grants;
- completing zero-downtime canonical database-object naming and PostgreSQL parity;
- disabling orphaned GitHub Actions registry identities through an authorized operator path;
- hardening Stripe lifecycle and entitlement reconciliation;
- completing fail-closed Clearfolio production transport/artifact/readiness policy;
- completing contextual-orchestrator production hardening and cost attribution;
- decision-ready schedule intelligence and Waterfall/Agile/Hybrid projections.

Do not maintain a hard-coded historical PR merge table in this README. Always read the live PR base/head relationships and current protected branch before deciding integration order.

## Documentation

- [User guide](docs/user-guide.md)
- [API reference](docs/api.md)
- [Deployment guide](docs/deploy.md)
- [Security notes](docs/security.md)
- [Architecture authority](ARCHITECTURE.md)
- [Agent rules](AGENTS.md)
- [Change log](CHANGELOG.md)

Customer-facing explanations should state what is available now, what action the customer/operator can take next, and what remains gated rather than presenting active-PR or planned behavior as already delivered.