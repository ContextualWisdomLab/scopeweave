# Deploying ScopeWeave (SaaS backend)

The SaaS backend (`server/`) runs the API **and** serves the static client from
one origin (so the browser's `default-src 'self'` CSP allows the API calls).

## Quick start (Docker Compose)

```bash
export SCOPEWEAVE_JWT_SECRET=$(openssl rand -base64 32)   # required
docker compose up --build
# open http://localhost:8787
```

That builds `Dockerfile.server`, runs the Node backend as a non-root user, and
persists the database in the `scopeweave-data` volume.

## Required / optional environment

| Var | Required | Purpose |
| --- | --- | --- |
| `SCOPEWEAVE_JWT_SECRET` | **yes** | Signs session JWTs. Use a long random value. The app warns loudly if the dev default is used. |
| `PORT` | no (default 8787) | Listen port |
| `SCOPEWEAVE_DB` | no (default `/data/scopeweave.db`) | SQLite file path (on the volume) |
| `SCOPEWEAVE_DEV` | no | Must be `1` to enable the dev `activate-pro` endpoint. **Never set in production.** |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | for live billing | Enables real Stripe Checkout (`npm i stripe` too). Without them, billing uses the mock path. |

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
