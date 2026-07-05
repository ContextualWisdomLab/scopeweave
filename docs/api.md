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

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | Current user + workspaces |
| `GET` | `/api/projects` | List accessible projects |
| `POST` | `/api/projects` | Create a project `{ name }` |
| `GET` | `/api/projects/:id` | Load `{ name, baseDate, tasks, version }` |
| `PUT` | `/api/projects/:id` | Save `{ tasks, baseDate?, version }` (optimistic concurrency; `409` on stale `version`) |
| `GET` | `/api/tokens` | List your tokens (prefix + last-used, never the secret) |
| `POST` | `/api/tokens` | Create a token `{ name }` → returns the secret once |
| `DELETE` | `/api/tokens/:id` | Revoke a token |

## Example

```bash
TOKEN=swk_xxxxxxxxxxxxxxxxxxxxxxxx
# list projects
curl -s https://YOUR_HOST/api/projects -H "Authorization: Bearer $TOKEN"
# save tasks (must send the current version)
curl -s -X PUT https://YOUR_HOST/api/projects/42 \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tasks":[{"id":"1","phase":"P0000.준비단계"}],"version":7}'
```

Revoke a token immediately if it leaks — the hash is deleted and any request
using it returns `401`.
