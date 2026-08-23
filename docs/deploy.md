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
| `SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS` | no (default unset) | Set to exactly `1` only after verifying that every current and future descendant host under the deployment domain is HTTPS-capable. Unset keeps HSTS scoped to the exact ScopeWeave host. |
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
- `attachmentStatusRefreshSkipped`
- `attachmentStatusRefreshDeferred`
- `attachmentStatusRefreshTimeoutFailures`
- `attachmentStatusRefreshDownstreamLookupFailures`
- `attachmentStatusRefreshInvalidStatusFailures`
- `attachmentStatusRefreshPersistenceFailures`

`skipped` counts pending rows that cannot be refreshed because their persisted
Clearfolio job identifier is absent or blank. `deferred` counts valid work that
was not started before the request-wide latency budget expired. Keeping these
causes separate prevents malformed stored data from being mistaken for
insufficient concurrency or downstream latency.

The four failure-category counters are fixed, low-cardinality diagnostics whose
sum equals the aggregate `failed` delta for a refresh pass. They contain no job
identifier, URL, downstream response text, or raw exception. The Prometheus
representation uses corresponding `scopeweave_attachment_status_refresh_*`
names. Alert on a sustained increase in `failed`, use the category counters for
triage, investigate `skipped` as a data-quality or migration defect, and compare
`deferred` with list traffic before increasing concurrency or the request-wide
budget. Raise limits conservatively because every worker consumes a downstream
Clearfolio connection; horizontal ScopeWeave replicas multiply the aggregate
concurrency.

### Rollout and alerting

Roll this behavior out behind a canary replica before raising limits across the
fleet. Start with concurrency `2`, the default per-item timeout, and a budget no
longer than the attachment-list latency objective. Compare the canary with the
previous version using the same tenant and Clearfolio environment.

Derive rates from counter deltas over the same observation window:

```text
failure_ratio  = failed_delta / max(attempted_delta, 1)
skipped_ratio  = skipped_delta / max(attempted_delta + skipped_delta, 1)
deferred_ratio = deferred_delta / max(attempted_delta + deferred_delta, 1)
change_ratio   = changed_delta / max(attempted_delta, 1)
```

A high `failure_ratio` indicates downstream, timeout, malformed-response, or
persistence errors and should block rollout. A non-zero `skipped_ratio` indicates
an attachment persistence or migration defect and should be investigated before
changing worker limits. A high `deferred_ratio` indicates that the request-wide
budget is protecting latency at the cost of freshness; first inspect Clearfolio
latency and attachment-list size before increasing worker count or budget. Track
attachment-list p50, p95, and p99 latency beside these ratios. Thresholds must be
derived from observed production baselines and an agreed service-level objective
rather than copied from development data.

Rollback is configuration-first: reduce concurrency and budget without changing
the persisted attachment statuses. If the application version must be rolled
back, the previous implementation can read the unchanged schema; no migration
is required by this feature. Never place Clearfolio job IDs, HMAC material,
request URLs containing credentials, or downstream response bodies in metrics,
logs, traces, or alert annotations.

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

The application emits `Strict-Transport-Security: max-age=15552000` by default.
That host-only policy protects the exact ScopeWeave origin without asserting
control over sibling or descendant hosts. Set
`SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS=1` only after a deployment-domain inventory
proves that every current and future subdomain is served exclusively over HTTPS
and that certificate and reverse-proxy routing cover those hosts. Do not enable
it blindly on a shared apex, customer-managed domain, or any domain that still
contains an HTTP-only descendant: browsers that have observed the policy will
upgrade those subdomain requests to HTTPS for the HSTS lifetime.

If the TLS terminator overwrites application response headers, configure it to
preserve the ScopeWeave HSTS value or to emit an equivalent, deliberately owned
policy. Treat changing HSTS scope or lifetime as a deployment-security change
that requires canary verification and rollback planning; it is not a generic
performance toggle.

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
