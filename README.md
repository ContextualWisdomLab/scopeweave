# ScopeWeave

Schedule-control (공정관리) tool: a WBS planner with cumulative progress, EVM
(SPI·SV) + S-curve, CPM critical path, and a weekly Gantt overlay — usable in
two modes:

- **Standalone (static)** — the original zero-dependency HTML/CSS/JS planner.
  Works from any static host; data stays in `localStorage`/`wbs.json`.
- **Cloud (SaaS)** — an opt-in Node backend adds accounts + SSO, multi-tenant
  workspaces, real-time collaboration, team roles, billing, baselines/history,
  webhooks, and a public API. The static client is the frontend; cloud features
  layer on without breaking standalone mode.

> The SaaS pivot lands as a stacked PR train (see **Merge order** below). On
> `develop` as of this branch, only standalone mode exists.

## Standalone features

- Pure static runtime: HTML, CSS, JavaScript only
- 3-level WBS hierarchy (`단계 > Activity > Task`) with expand/collapse
- Inline add/edit/delete, row-click edit, and same-level drag-and-drop
  subtree reorder
- Automatic day, weight, planned progress, actual progress, and weighted
  progress calculations
- CSV import/export using the screen column contract
- Local autosave with optional File System Access API sync to `wbs.json`
- Weekly Gantt modal with planned (`#333333`) and actual (`#34cb03`) overlays
- Responsive column reduction for screens under 800px

## Cloud (SaaS) features

- **Auth**: email/password (scrypt) + JWT (7d, revocable via logout-everywhere),
  SSO (OIDC + PKCE, built-in mock IdP for dev), personal access tokens (`swk_`,
  hash-stored)
- **Multi-tenancy**: workspaces (orgs) with owner/admin/member/viewer roles —
  enforced server-side; invites (revocable), member removal, leave, rename,
  ownership transfer
- **Collaboration**: SSE live sync, optimistic concurrency (409 on stale
  version), task comments
- **Schedule control**: EVM (SPI·SV) + S-curve, CPM critical path with slack,
  predecessors, baselines (freeze/compare — slip table), revision history +
  restore
- **PM analysis**: deterministic requirements/RFI/RFP readiness, WBS estimation
  coverage, inter-event dependency risk, and procurement package section checks
  from the existing WBS fields
- **Billing**: Free (2 projects / 3 members) vs Pro ₩19,000/mo — server-enforced
  402 caps; Stripe when configured, mock otherwise
- **Platform**: signed webhooks (HMAC-SHA256, retry + delivery log, secret
  rotation), audit log, workspace export (JSON), cross-project search,
  project duplicate (templates), rate limiting (opt-in), metrics
  (JSON + Prometheus), structured logs
- **Docs**: complete API reference at [`docs/api.md`](docs/api.md) (served at
  `/docs/api.md`); deploy guide at [`docs/deploy.md`](docs/deploy.md)

## Architecture

```
index.html + app.js + styles.css     ← static client (eval-safe; no top-level imports)
  ├─ analytics.js                    ← EVM/S-curve/CPM (window.ScopeWeaveAnalytics)
  └─ cloud-sync.js                   ← opt-in cloud overlay (window.ScopeWeaveCloud)
server/
  ├─ server.mjs                      ← @hono/node-server entry (PORT, default 8787)
  ├─ app.mjs                         ← Hono routes: auth/SSO, projects, teams, billing,
  │                                    webhooks, baselines, revisions, comments, search…
  ├─ auth.mjs                        ← scrypt + pinned-HS256 JWT + PAT hashing (node:crypto)
  ├─ billing.mjs                     ← plans/caps; Stripe via dynamic import
  └─ db.mjs                          ← node:sqlite schema (Postgres-portable)
```

Only two runtime dependencies (`hono`, `@hono/node-server`); everything else is
Node built-ins. `node:sqlite` is for dev/self-host — swap the driver for managed
Postgres in production.

## Local development

Standalone:

```bash
python3 -m http.server 4173   # open http://127.0.0.1:4173
```

Cloud (Node ≥ 22):

```bash
npm install
pnpm run server                # serves the API + the static client on :8787
```

Docker: `docker compose up` (see `Dockerfile.server` / `docs/deploy.md`).

### Environment

| Var | Purpose |
| --- | --- |
| `SCOPEWEAVE_JWT_SECRET` | **Required in prod** — JWT signing secret |
| `SCOPEWEAVE_DB` | SQLite path (default `data.db`; `:memory:` for tests) |
| `PORT` | API port (default 8787) |
| `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI` | Real SSO IdP (mock when unset) |
| `STRIPE_SECRET_KEY` | Real checkout (mock URL when unset) |
| `SCOPEWEAVE_RATE_LIMIT_MAX` (+`_WINDOW_MS`) | Opt-in per-IP rate limiting |
| `SCOPEWEAVE_DEV=1` | Dev-only endpoints (activate-pro) |

## Verification

```bash
pnpm run test:api    # API smoke (auth, tenancy, RBAC, billing, webhooks, …) + rate limit
pnpm run test:unit   # EVM/S-curve, CPM, baseline-compare (pure math)
pnpm run test:e2e    # Playwright UI suite
python3 -m pytest tests/config
```

`app.js` must stay eval-safe (no top-level `import`/`export`) — the e2e harness
evaluates it with `new Function`. Optional modules bridge via `window.*` globals.

## Merge order (SaaS PR stack)

`#233` first — it fixes pre-existing infra misconfigs that fail the required
`trivy-fs` gate on **every** PR. Then the stack in order (each PR is based on
the previous; merging in order auto-retargets the next):

| Order | PR | Slice |
| --- | --- | --- |
| 0 | #233 | fix(ci): trivy-fs misconfigs (Dockerfile HEALTHCHECK, k8s uid/gid + namespace) |
| 1 | #212 | multi-tenant backend foundation (auth·projects·SSE·isolation) |
| 2 | #214 | client wiring (login UI, cloud save, live sync) |
| 3 | #215 | EVM (SPI·SV) + S-curve |
| 4 | #216 | teams + RBAC |
| 5 | #217 | billing + plan gating |
| 6 | #218, #219 | CPM engine + UI |
| 7 | #220 | public API + PAT |
| 8 | #221 | predecessors (editor + CSV) |
| 9 | #222 | Dockerfile + compose |
| 10 | #223 | landing page |
| 11 | #224 | audit log |
| 12 | #225 | workspace export |
| 13 | #226 | onboarding (샘플로 시작) |
| 14 | #227 | observability (metrics + logs) |
| 15 | #228 | signed webhooks |
| 16 | #230 | English landing (i18n) |
| 17 | #231 | SSO (OIDC) |
| 18 | #232 | webhook retry + delivery log |
| 19 | #234 | lifecycle (delete project / change pw / delete account) |
| 20 | #236 | baselines |
| 21 | #237 | rate limiting |
| 22 | #238 | create workspaces |
| 23 | #239 | baseline-vs-actual comparison UI |
| 24 | #240 | project duplicate |
| 25 | #241 | Prometheus metrics |
| 26 | #242 | webhook secret rotation |
| 27 | #243 | invite revocation |
| 28 | #244 | leave + rename workspace |
| 29 | #245 | complete API docs |
| 30 | #246 | ownership transfer |
| 31 | #247 | cross-project search |
| 32 | #248 | logout everywhere |
| 33 | #249 | revision history + restore |
| 34 | #250 | task comments |
| 35 | #251 | SEO (OG cards, hreflang, robots, sitemap) |
| 36 | (this PR) | README: architecture + merge map |

## Repository contract

- The static client stays static-host compatible for GitHub Pages
  (standalone mode is preserved).
- Runtime dependencies are minimized (`hono`, `@hono/node-server` only, added
  by the SaaS stack); CI/dev-only automation under `.github/`, `scripts/`,
  `tests/`, and `docs/` is allowed.
- OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler are
  inherited from the organization-level required workflows in
  `ContextualWisdomLab/.github`, not copied into this repository.

## Persistence model

- Standalone: every mutation autosaves to `localStorage`; `wbs.json` seeds
  static hosting; File System Access API can sync a writable `wbs.json`.
- Cloud: projects live server-side with versioned saves (last 20 revisions),
  SSE fan-out to collaborators, and offline fallback to the standalone model.
- Synthetic hierarchy wrapper rows generated from imported flat records are
  excluded from external `wbs.json` sync so the saved JSON remains in the
  user-facing schema.
- Requirements/RFI/RFP and WBS-estimation analysis is computed locally from the
  single `tasks` array. It is a readiness signal over evidence already present
  in the plan, not an external estimator or LLM judgment.

## Security workflow

- Organization required workflows provide OpenCode Review, Strix Security
  Scan, PR Review Merge Scheduler, failed-check explanation, and coverage
  evidence.
- Repository-local workflows remain for ScopeWeave-specific static delivery
  and companion SCA lanes, including dependency review, OSV, Trivy,
  Scorecard, and Pages.
- Server hardening: pinned-HS256 JWT (no header-alg trust), scrypt passwords,
  hash-only PAT/webhook-secret storage (secrets shown once), server-side RBAC,
  secrets never logged.

See `docs/user-guide.md` for operator guidance and `docs/api.md` for the API.
