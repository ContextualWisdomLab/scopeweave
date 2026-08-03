# URL-token session revocation verification

## Security invariant

Calendar, server-sent-event, and attachment-view endpoints that accept a session JWT through the query string must enforce the same database-backed `token_version` revocation check as bearer-token authentication.

## Regression evidence

`tests/api/session-revocation.test.mjs` creates two device sessions, confirms that calendar, SSE, and attachment-view authentication accept both live tokens before revocation, invokes `logout-all`, then verifies that both stale tokens receive HTTP 401 while the replacement token continues through the shared authentication boundary.

The attachment regression deliberately requests a missing attachment: a valid session reaches tenant-scoped lookup and receives HTTP 404, while a revoked session is rejected earlier with HTTP 401. This proves authentication ordering without requiring a fixture attachment.

The regression is part of `npm run test:api`. Every synchronized head must rerun Server Tests, Security Scan, SAST Semgrep, Dependency Review, OSV Scanner, and Fuzz before merge.
