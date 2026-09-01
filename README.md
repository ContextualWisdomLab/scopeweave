# ScopeWeave

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ContextualWisdomLab/scopeweave)

**Schedule-control workspace for building a WBS, tracking plan versus actual, and turning project structure into explainable schedule evidence.**

ScopeWeave helps a project manager structure work, maintain planned and actual dates, inspect weighted progress, understand critical-path and earned-value signals, and share the same planning model in a lightweight browser-only workflow or an optional self-hosted server mode.

The repository keeps those modes deliberately compatible: the standalone planner remains useful without an account or backend, while the server adds authenticated shared workspaces and API-backed collaboration for teams that need it.

## What ScopeWeave provides

| Need | Current product capability |
| --- | --- |
| Build a work breakdown structure | Three-level `단계 → Activity → Task` hierarchy with inline editing and same-level subtree reordering |
| Track schedule execution | Planned/actual dates, weighted progress, weekly Gantt overlays, and baseline comparisons |
| Understand schedule risk | CPM critical-path/slack calculations and predecessor consistency checks |
| Review delivery performance | EVM/S-curve signals including SPI and schedule variance, plus deterministic readiness analysis from plan evidence |
| Exchange planning data | CSV import/export and the user-facing `wbs.json` model |
| Work without a backend | Browser `localStorage` plus optional File System Access API synchronization |
| Collaborate through a server | Authenticated workspaces, project persistence, revision history, comments, search, SSE updates, and public API surfaces |
| Integrate adjacent services | Explicit optional contracts for `contextual-orchestrator` and Clearfolio rather than copied implementations or shared databases |

## Choose a mode

### Standalone planner

The standalone application is plain HTML, CSS, and JavaScript. It can be served from any ordinary static host and keeps the working plan in the browser unless the user explicitly connects a writable `wbs.json` file.

```bash
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`.

This is the simplest way to evaluate the WBS, CSV, Gantt, CPM, EVM, baseline, and local planning flows without creating an account or running a database.

### Self-hosted server mode

The repository also contains a Node/Hono backend that serves the same client and adds authenticated, server-backed workspace features. Current package metadata requires Node.js `^22.13.0 || >=23.4.0`.

Install from the lockfile and create one persistent signing secret:

```bash
npm ci

install -d -m 700 "$HOME/.config/scopeweave"
if [ ! -s "$HOME/.config/scopeweave/jwt-secret" ]; then
  umask 077
  openssl rand -base64 32 > "$HOME/.config/scopeweave/jwt-secret"
fi
export SCOPEWEAVE_JWT_SECRET="$(cat "$HOME/.config/scopeweave/jwt-secret")"

npm run server
```

Open `http://127.0.0.1:8787`.

Do not mint a different signing secret on every restart: rotating `SCOPEWEAVE_JWT_SECRET` intentionally invalidates existing sessions. Managed deployments should keep it in the platform secret manager.

For container deployment, use `docker compose up --build` only after supplying the same persistent secret. See [`docs/deploy.md`](docs/deploy.md) for the full deployment contract and current scaling ceiling.

## Product boundary

ScopeWeave owns project schedule-control behavior represented by this repository: WBS structure, plan/actual state, local and server persistence of that model, schedule analytics, project collaboration surfaces, and explicit integration adapters.

It does **not** make every adjacent system part of its own product boundary:

- `contextual-orchestrator` remains authoritative for model/provider routing when AI briefing is enabled;
- Clearfolio remains authoritative for its document/viewer job state when attachments are connected;
- OIDC providers remain authoritative for external identity;
- Stripe remains authoritative for live payment processing when configured;
- customer infrastructure remains authoritative for TLS termination, secrets, database topology, backup, and deployment policy.

Unset external integrations use the repository's documented development/test behavior where one exists; a mock or deterministic fallback is not evidence that a real provider transaction occurred.

## Standalone data model

Every standalone mutation autosaves to browser `localStorage`. On supported Chromium-family browsers, the user can explicitly connect a writable `wbs.json` through the File System Access API and keep the same user-facing JSON schema synchronized.

CSV import replaces the current plan using the screen column contract; CSV export produces `wbs_export_YYYYMMDD.csv`. Synthetic hierarchy wrapper rows used internally are not written into the external `wbs.json` representation.

The user guide documents the current hierarchy, validation, save, CSV, Gantt, and PM-analysis behavior: [`docs/user-guide.md`](docs/user-guide.md).

## Server mode and integration context

The self-hosted server currently uses Hono with `@hono/node-server` and `node:sqlite` for the single-node path. The deployment guide names SQLite as the development/self-host single-writer ceiling and describes managed PostgreSQL as the intended multi-instance persistence boundary rather than pretending the current SQLite path scales horizontally.

Important optional integration settings include:

| Setting | Purpose |
| --- | --- |
| `SCOPEWEAVE_JWT_SECRET` | Required server-mode session signing secret |
| `SCOPEWEAVE_DB` | SQLite path for the current single-node server path |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | External OIDC identity provider |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Live billing integration |
| `ORCHESTRATOR_URL`, `ORCHESTRATOR_TOKEN` | `contextual-orchestrator` integration |
| `CLEARFOLIO_URL`, `CLEARFOLIO_HMAC_SECRET` | Clearfolio integration |
| `SCOPEWEAVE_RATE_LIMIT_MAX`, `SCOPEWEAVE_RATE_LIMIT_WINDOW_MS` | Optional per-IP fixed-window rate limiting |

Development mock paths for billing or identity are not production configuration. See [`docs/deploy.md`](docs/deploy.md), [`docs/api.md`](docs/api.md), and [`docs/orchestrator-production.md`](docs/orchestrator-production.md) before enabling external integrations.

## Architecture at a glance

```text
Browser
  |
  +---- standalone -----------------------+
  |                                       |
  |   localStorage / optional wbs.json    |
  |                                       |
  +---- self-hosted server ---------------+
          |
          v
     ScopeWeave API
     auth · workspace · project
     schedule · history · collaboration
          |
          +---- node:sqlite (single-node path)
          |
          +---- explicit external adapters
                  OIDC / Stripe / orchestrator / Clearfolio
```

The static client remains intentionally evaluable without top-level module imports; optional browser modules bridge through the documented `window.ScopeWeave*` contracts. Server and provider concerns stay behind their own interfaces rather than being copied into the standalone planner.

## Security and trust boundaries

The current server path uses a configured signing secret, scrypt password handling, hash-stored personal access tokens and webhook secrets, server-side workspace authorization, and optional rate limiting. Secrets must not be logged or committed.

A successful local calculation, mock provider path, API response, or test result is evidence only for the operation it actually performed. It does not prove an external IdP authenticated a person, Stripe completed a payment, Clearfolio finished a document job, or an AI provider produced a result unless the corresponding integration evidence says so.

Read [`docs/security.md`](docs/security.md) and the operational/deployment documentation before exposing server mode beyond a local evaluation environment.

## Verify the source

Install from the checked-in lockfile:

```bash
npm ci
```

Then run the repository's current verification paths:

```bash
npm run test:api
npm run test:unit
npm run test:e2e
npm run test:fuzz
```

The repository also contains targeted configuration and security evidence under `tests/` and organization-required security workflows. A green source revision is engineering evidence for that exact revision; it is not a release, deployment, customer, or commercial claim.

## Current maturity

The current package metadata is `1.0.0` and the repository is private-package marked for npm, but **there is no published GitHub release**. The source checkout contains both standalone and server-mode implementation; the old stacked-PR merge train is historical development context and no longer belongs on the customer landing page.

Treat source version metadata, development mocks, successful checks, and documentation as distinct from release publication and production deployment evidence.

## Documentation map

- [`docs/user-guide.md`](docs/user-guide.md) — standalone planner workflow, storage, CSV, validation, Gantt, and PM analysis.
- [`docs/api.md`](docs/api.md) — current server API contract.
- [`docs/deploy.md`](docs/deploy.md) — self-hosted deployment, secrets, persistence, TLS, and scaling guidance.
- [`docs/security.md`](docs/security.md) — security and trust-boundary guidance.
- [`docs/orchestrator-production.md`](docs/orchestrator-production.md) — production-oriented orchestrator integration.
- [`docs/operations/`](docs/operations/) — operator procedures and evidence.
- [`docs/research/`](docs/research/) and [`docs/doctoring/`](docs/doctoring/) — research/standards traceability.

## Contributing

Keep standalone mode usable without a server and keep server-only behavior behind explicit boundaries. Changes to schedule mathematics, authentication, tenant isolation, persistence, billing, provider calls, or externally visible APIs should update their tests and documentation together.

Do not move merge queues, agent workflow instructions, or internal PR-stack maps back into the customer README. Those are contributor/governance concerns, not product value.

## License

ScopeWeave is licensed under the [MIT License](LICENSE). Third-party Node packages, provider APIs, external services, and other dependencies retain their own license and service terms and are not relicensed by ScopeWeave.
