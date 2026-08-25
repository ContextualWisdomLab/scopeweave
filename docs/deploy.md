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
| `SCOPEWEAVE_DEV` | no | Must be `1` to enable development-only behavior: the `activate-pro` endpoint, the built-in OIDC mock when `OIDC_ISSUER` is unset, and the deterministic orchestrator mock when `ORCHESTRATOR_URL` is unset. **Never set in production.** |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | for live billing | Enables real Stripe Checkout (`npm i stripe` too). Without them, billing uses the mock path. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | for real SSO | Points the OIDC login at your IdP. Outside explicit `SCOPEWEAVE_DEV=1`, a missing issuer fails closed with `404 sso not configured`; the built-in mock exists only when the issuer is unset **and** development mode is explicitly enabled. |
| `ORCHESTRATOR_URL` | for AI briefing | contextual-orchestrator origin. A missing URL fails closed outside explicit `SCOPEWEAVE_DEV=1`; the deterministic mock exists only in development mode. |
| `ORCHESTRATOR_TOKEN` | with URL | Required Bearer token for configured orchestrator requests (`CONTEXTUAL_ORCHESTRATOR_TOKEN`). |
| `CLEARFOLIO_URL` | for 산출물 viewer | Clearfolio 문서 뷰어 백엔드 주소. Unset → built-in mock (dev/test). |
| `CLEARFOLIO_HMAC_SECRET` | optional | Signs tenant-claim headers (`clearfolio.tenant-claims.hmac-secret`와 동일 값). |
| `SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY` | no (default 8, maximum 32) | Maximum concurrent Clearfolio status lookups during one attachment-list request. Invalid values fall back to 8; values above 32 are clamped. |
| `SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS` | no (default 3000, maximum 30000) | Hard caller-side timeout for each Clearfolio status lookup. The AbortSignal is also forwarded downstream. |
| `SCOPEWEAVE_ATTACHMENT_STATUS_BUDGET_MS` | no (default 5000, maximum 60000) | Wall-clock budget for the entire best-effort refresh pass. Work not started before the deadline is deferred to a later list request. |
| `SCOPEWEAVE_RATE_LIMIT_MAX` | recommended | Per-client fixed-window request allowance. Unset or explicit `0` disables the limiter. Any other configured value must be a non-negative safe integer or startup fails. |
| `SCOPEWEAVE_RATE_LIMIT_WINDOW_MS` | no (default 60000) | Fixed-window duration in milliseconds. An explicit value must be a positive safe integer or startup fails. |
| `SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX` | no (default 10000) | Maximum number of live per-client limiter buckets held by one ScopeWeave process. An explicit value must be a positive safe integer or startup fails. Once capacity is reached, previously unseen identities share a fail-closed overflow bucket until expired regular buckets are reclaimed. |
| `SCOPEWEAVE_TRUSTED_PROXY_IPS` | only behind trusted reverse proxies | Comma-separated **immediate or chained proxy peer IPs** that ScopeWeave is allowed to trust when interpreting `X-Forwarded-For`. Configure the actual IP once; dotted IPv4-mapped Node spellings such as `::ffff:127.0.0.1` are normalized to their IPv4 address before trust comparison. Leave unset for direct deployments. |

### Rate-limit capacity and tuning

When the limiter is enabled, `429` responses include `Retry-After`. Client
identity is anchored to the actual network peer unless that peer is explicitly
trusted through `SCOPEWEAVE_TRUSTED_PROXY_IPS`. Valid dotted IPv4-mapped IPv6
peer and forwarded-hop spellings are canonicalized to their underlying IPv4
address before trust comparison and limiter-key selection. This prevents a
Node dual-stack listener from collapsing all proxied clients into one limiter
bucket merely because the socket exposed an IPv4 proxy as `::ffff:a.b.c.d`.
Invalid address text is never admitted as a trusted identity.

The regular in-memory bucket map is deliberately bounded by
`SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX`; attacker-driven high-cardinality source
identities therefore cannot create unbounded limiter state. At capacity, new
identities use one shared overflow bucket rather than allocating new map entries.
Expired regular buckets are reclaimed by a bounded sweep before admitting new
identities.

Size `SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX` for the maximum legitimate concurrent
client-identity population expected **per process**, with headroom for normal
bursts. Do not increase it merely to make overflow throttling disappear: first
confirm that trusted-proxy identity extraction is correct and that the observed
cardinality is legitimate. In horizontally scaled deployments, each replica has
its own limiter state; this fixed-window implementation is a process-local abuse
control, not a globally coordinated quota system. Use a shared rate-limit store
or edge control plane when a cross-replica/global quota is required.

Limiter numeric configuration is fail-closed. A malformed, infinite, negative,
or otherwise unsafe explicit value causes startup failure instead of silently
disabling protection or resetting windows on every request. Treat such a startup
failure as a configuration incident; correct the setting rather than removing
or bypassing the limiter gate.

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

`X-Forwarded-For` is **ignored for the security rate-limit identity by default**.
If a reverse proxy is the only permitted ingress to ScopeWeave, list its actual
network peer address in `SCOPEWEAVE_TRUSTED_PROXY_IPS`. For multiple trusted
proxy hops, list every trusted hop. You do not need to duplicate an IPv4 proxy
as both `a.b.c.d` and Node's dotted IPv4-mapped `::ffff:a.b.c.d` representation;
ScopeWeave canonicalizes that mapped socket/hop spelling before the trust
comparison. ScopeWeave then walks `X-Forwarded-For` from right to left, skips
explicitly trusted proxy addresses, and chooses the first untrusted valid IP as
the client identity. Missing, malformed, or all-trusted forwarding evidence
falls back to the actual socket peer.

Do not configure this trust list while untrusted clients can connect directly to
the backend. The proxy must overwrite or append forwarding information according
to a controlled ingress policy; accepting a caller-selected forwarding header
without an authenticated/trusted peer would make rate limiting bypassable.

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
