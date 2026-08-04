# Deploying ScopeWeave (SaaS backend)

The SaaS backend (`server/`) runs the API **and** serves the static client from
one origin (so the browser's `default-src 'self'` CSP allows the API calls).

## Quick start (Docker Compose)

Create the signing key once in a user-only file outside the repository, then
reload that same key for every restart. Replacing it invalidates all existing
session JWTs.

```bash
install -d -m 700 "$HOME/.config/scopeweave"
if [ ! -s "$HOME/.config/scopeweave/jwt-secret" ]; then
  umask 077
  openssl rand -base64 32 > "$HOME/.config/scopeweave/jwt-secret"
fi
export SCOPEWEAVE_JWT_SECRET="$(cat "$HOME/.config/scopeweave/jwt-secret")"
docker compose up --build
# open http://localhost:8787
```

For managed deployments, store the same value in the platform's secrets
manager instead of a local file. Rotate it only as an intentional global
session-revocation operation.

That builds `Dockerfile.server`, runs the Node backend as a non-root user, and
persists the database in the `scopeweave-data` volume.

## Required / optional environment

| Var | Required | Purpose |
| --- | --- | --- |
| `SCOPEWEAVE_JWT_SECRET` | **yes** | Signs session JWTs. Startup fails unless it contains at least 32 non-whitespace characters. |
| `PORT` | no (default 8787) | Listen port |
| `SCOPEWEAVE_DB` | no (default `/data/scopeweave.db`) | SQLite file path (on the volume) |
| `SCOPEWEAVE_DEV` | no | Must be `1` to enable the dev `activate-pro` endpoint. **Never set in production.** |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | for live billing | Enables real Stripe Checkout (`npm i stripe` too). Without them, billing uses the mock path. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | for real SSO | Points the OIDC login at your IdP. Unset → a built-in mock IdP (dev/test only). |
| `ORCHESTRATOR_URL` | for AI 브리핑 | contextual-orchestrator 주소. Unset → deterministic mock. |
| `ORCHESTRATOR_TOKEN` | with URL | orchestrator Bearer 토큰 (`CONTEXTUAL_ORCHESTRATOR_TOKEN`). |
| `CLEARFOLIO_URL` | for 산출물 viewer | Clearfolio 문서 뷰어 백엔드 주소. Unset → built-in mock (dev/test). |
| `CLEARFOLIO_HMAC_SECRET` | optional | Signs tenant-claim headers (`clearfolio.tenant-claims.hmac-secret`와 동일 값). |
| `SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY` | no (default 8, maximum 32) | Maximum concurrent Clearfolio status lookups during one attachment-list request. Invalid values fall back to 8; values above 32 are clamped. |
| `SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS` | no (default 3000, maximum 30000) | Hard caller-side timeout for each Clearfolio status lookup. The AbortSignal is also forwarded downstream. |
| `SCOPEWEAVE_ATTACHMENT_STATUS_BUDGET_MS` | no (default 5000, maximum 60000) | Wall-clock budget for the entire best-effort refresh pass. Work not started before the deadline is deferred to a later list request. |
| `SCOPEWEAVE_RATE_LIMIT_MAX` (+ `SCOPEWEAVE_RATE_LIMIT_WINDOW_MS`) | recommended | Per-IP fixed-window rate limiting (429 + Retry-After). Off when unset. |

## Attachment status refresh operations

The attachment-list API reads `job_id` in its initial project-scoped query and
refreshes only `PENDING` or `RUNNING` rows through a bounded worker pool. It
never performs one database lookup per row. A timeout, unsuccessful HTTP
response, malformed response body, invalid status value, or persistence failure
is isolated to that attachment: ScopeWeave preserves its previously stored
status and still returns the rest of the list. Internal Clearfolio job
identifiers are removed before JSON serialization.

The process metrics endpoint exposes cumulative counters for operational
monitoring:

- `attachmentStatusRefreshAttempted`
- `attachmentStatusRefreshChanged`
- `attachmentStatusRefreshFailed`
- `attachmentStatusRefreshDeferred`

The Prometheus representation uses the corresponding
`scopeweave_attachment_status_refresh_*` names. Alert on a sustained increase in
`failed`, and compare `deferred` with list traffic before increasing concurrency
or the request-wide budget. Raise limits conservatively because every worker
consumes a downstream Clearfolio connection; horizontal ScopeWeave replicas
multiply the aggregate concurrency.

## Data & scale path

- **Dev / single node**: `node:sqlite` on a persistent volume (this setup). Simple, no external DB.
- **Production / multi-instance**: swap the SQLite driver in `server/db.mjs` for
  managed **Postgres** (the schema is Postgres-portable) and run several stateless
  backend replicas behind a load balancer. `node:sqlite` is a single-writer,
  single-node store — do not scale it horizontally. *(named ceiling)*

## TLS / reverse proxy

Terminate TLS at a reverse proxy (nginx/Caddy/ALB) in front of the backend and
forward to `:8787`. The client and API share the origin, so no CORS config is
needed.

## Kubernetes

The existing `infra/k8s/` manifests deploy the **static-only** nginx image. For
the SaaS backend, build/push `Dockerfile.server`, then run it as a Deployment
with: a readiness/liveness probe on `/api/health`, a `PersistentVolumeClaim`
mounted at `/data` (SQLite) *or* a managed Postgres, `SCOPEWEAVE_JWT_SECRET`
from a Secret, and a non-root `securityContext`. (Left as a follow-up so this PR
stays focused on the container + compose path.)

## Health

`GET /api/health` → `{"ok":true}`. Wired as the container `HEALTHCHECK` and the
compose healthcheck.
