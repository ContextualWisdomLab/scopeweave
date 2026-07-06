# ScopeWeave Public API

Automate ScopeWeave from scripts, CI, or integrations using a **Personal Access
Token (PAT)**. Create one in the app: **팀 → API 토큰 → 토큰 생성**. The full
secret (`swk_…`) is shown **once** — copy it immediately. Only a SHA-256 hash is
stored server-side; the secret is never retrievable again.

Authenticate by sending the token as a Bearer credential (same header as a
session JWT):

```
Authorization: Bearer swk_xxxxxxxxxxxxxxxxxxxxxxxx
```

A PAT acts as your user across all your workspaces.

## Conventions

- **Roles** (per workspace): `owner` > `admin` > `member` > `viewer`. *Manage* =
  owner/admin. *Write* = owner/admin/member. Viewers are read-only (`403` on writes).
- **Optimistic concurrency**: `PUT /api/projects/:id` must send the current
  `version`; a stale version returns `409` with the server copy.
- **Plan caps** (Free): 2 projects / 3 members per workspace. Over-cap returns
  `402` with `{ upgrade: true }`. Pro removes the caps.
- Errors are JSON: `{ "error": "..." }` with a meaningful status.

## Auth & account

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | `{ email, password }` → `{ token }` (creates a personal workspace) |
| `POST` | `/api/auth/login` | `{ email, password }` → `{ token }` |
| `GET` | `/api/auth/oidc/start` | Begin SSO (OIDC + PKCE). Redirects to the IdP (or the built-in mock when `OIDC_ISSUER` is unset) |
| `GET` | `/api/auth/oidc/callback` | IdP redirect target; issues the app JWT via URL fragment |
| `POST` | `/api/auth/change-password` | `{ oldPassword, newPassword }` (min 8) |
| `POST` | `/api/auth/logout-all` | Invalidate every existing session JWT; returns a fresh token for this device (PATs unaffected) |
| `DELETE` | `/api/account` | `{ password }` — GDPR delete: removes owned workspaces + the user |
| `GET` | `/api/me` | Current user + workspaces (`orgs[].role`) |

## Projects

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List accessible projects |
| `POST` | `/api/projects` | Create `{ name, orgId? }` |
| `GET` | `/api/projects/:id` | Load `{ name, baseDate, tasks, version }` |
| `PUT` | `/api/projects/:id` | Save `{ tasks, baseDate?, version }` — write roles; `409` on stale version; fires `project.update` webhooks |
| `DELETE` | `/api/projects/:id` | Delete (write roles); fires `project.delete` |
| `POST` | `/api/projects/:id/duplicate` | `{ name? }` — copy tasks + base date into a new project (template use) |
| `POST` | `/api/projects/:id/archive` | `{ archived: bool }` — archive/restore (write roles) |
| `GET` | `/api/projects/:id/stream` | **SSE** live updates. EventSource can't send headers — pass `?token=<JWT>` |
| `GET` | `/api/notifications` | Per-project unseen counts (others' saves + comments since my last open) |
| `POST` | `/api/projects/:id/seen` | Mark a project seen (clears its unseen count) |
| `GET` | `/api/search?q=` | Cross-project search (project + task names, membership-scoped; min 2 chars) |
| `GET` | `/api/projects/:id/calendar.ics` | iCalendar feed of planned tasks (all-day VEVENTs). Calendar apps: pass `?token=` |

## Comments (코멘트)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:id/comments?taskId=` | List (latest first, author email; optional task filter) |
| `POST` | `/api/projects/:id/comments` | `{ taskId?, body }` (write roles, max 2000 chars) |
| `DELETE` | `/api/projects/:id/comments/:cid` | Author or manage |

## Revisions (변경 이력)

Every save snapshots the project (last 20 kept). Restore writes the old
snapshot as a **new** version — history stays linear.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:id/revisions` | List `{ version, savedAt, savedBy }` (desc) |
| `GET` | `/api/projects/:id/revisions/:version` | Full snapshot |
| `POST` | `/api/projects/:id/revisions/:version/restore` | Roll back (write roles) |

## Baselines (기준선)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects/:id/baselines` | `{ name? }` — freeze the current plan (write roles) |
| `GET` | `/api/projects/:id/baselines` | List baselines |
| `GET` | `/api/projects/:id/baselines/:bid` | Full frozen snapshot `{ tasks, baseDate }` |
| `DELETE` | `/api/projects/:id/baselines/:bid` | Remove a baseline (write roles) |

## Workspaces & members

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/orgs` | `{ name }` — create an additional workspace (creator = owner) |
| `PATCH` | `/api/orgs/:id` | `{ name }` — rename (owner) |
| `POST` | `/api/orgs/:id/transfer` | `{ userId }` — transfer ownership to a member (owner; old owner becomes admin) |
| `POST` | `/api/orgs/:id/leave` | Leave the workspace (non-owner; owner gets `403`) |
| `GET` | `/api/orgs/:id/members` | Roster + pending invites |
| `PATCH` | `/api/orgs/:id/members/:userId` | `{ role }` — change a member's role (manage; owner immutable) |
| `DELETE` | `/api/orgs/:id/members/:userId` | Remove a member (manage; owner immune) |
| `POST` | `/api/orgs/:id/invites` | `{ email, role? }` → `{ token }` invite link token (manage) |
| `DELETE` | `/api/orgs/:id/invites/:inviteId` | Revoke a pending invite (manage) — the token dies immediately |
| `POST` | `/api/invites/:token/accept` | Accept an invite (any authenticated user holding the token) |

## Billing

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:id/portfolio` | Executive rollup: per-project weighted plan/actual %, SPI + status, overdue counts |
| `GET` | `/api/orgs/:id/billing` | Plan, limits, usage |
| `POST` | `/api/orgs/:id/checkout` | Start a Pro checkout (Stripe when configured; mock URL otherwise) |

## Webhooks (signed outbound events)

Events: `project.update`, `project.delete`, `member.join`, `billing.upgrade`
(subscribe with `*` for all). Deliveries retry **once** on failure and each
attempt is recorded.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/orgs/:id/webhooks` | List (never returns secrets; includes `lastOk`/`lastAt`) |
| `POST` | `/api/orgs/:id/webhooks` | `{ url, events? }` → `whsec_` secret shown **once** (manage) |
| `POST` | `/api/orgs/:id/webhooks/:whId/rotate` | Rotate the signing secret → new secret shown **once** |
| `GET` | `/api/orgs/:id/webhooks/:whId/deliveries` | Recent delivery attempts (status, ok, attempt) |
| `DELETE` | `/api/orgs/:id/webhooks/:whId` | Remove a webhook |

**Verify a delivery** — the body is signed with HMAC-SHA256:

```
X-Scopeweave-Event:     project.update
X-Scopeweave-Signature: sha256=<hex hmac of the raw body with your whsec_ secret>
```

```js
const ok = req.headers['x-scopeweave-signature'] ===
  'sha256=' + crypto.createHmac('sha256', WHSEC).update(rawBody).digest('hex');
```

## Tokens, audit, export, ops

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tokens` | List your PATs (prefix + last-used, never the secret) |
| `POST` | `/api/tokens` | Create `{ name }` → secret shown once |
| `DELETE` | `/api/tokens/:id` | Revoke a token |
| `GET` | `/api/orgs/:id/audit` | Audit log (manage; `?format=csv` for a compliance CSV) |
| `GET` | `/api/orgs/:id/export` | Full workspace export JSON (owner) |
| `GET` | `/api/metrics` | Ops counters (JSON; add `?format=prometheus` for scrape-ready text) |
| `GET` | `/api/health` | Liveness |

## Example

```bash
TOKEN=swk_xxxxxxxxxxxxxxxxxxxxxxxx
# list projects
curl -s https://YOUR_HOST/api/projects -H "Authorization: Bearer $TOKEN"
# save tasks (must send the current version)
curl -s -X PUT https://YOUR_HOST/api/projects/42 \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tasks":[{"id":"1","phase":"P0000.준비단계"}],"version":7}'
# freeze today's plan as a baseline
curl -s -X POST https://YOUR_HOST/api/projects/42/baselines \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"착수 기준선"}'
```

Revoke a token immediately if it leaks — the hash is deleted and any request
using it returns `401`.

> Dev-only endpoints (`/api/auth/oidc/mock/authorize`, `/api/orgs/:id/_dev/activate-pro`)
> exist for local testing and are disabled or gated in production.
