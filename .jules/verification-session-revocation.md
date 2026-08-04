# URL-token session revocation verification

## Security invariant

Calendar, server-sent-event, and attachment-view endpoints that accept a session JWT through the query string must enforce the same database-backed `token_version` revocation check as bearer-token authentication. Every verified ScopeWeave session JWT must carry a non-negative safe-integer `tv` claim; missing, null, Boolean, string, fractional, negative, and unsafe-integer claims fail closed before user lookup. Signed tokens for users that no longer exist also fail before tenant or resource lookup.

## Regression evidence

`tests/api/session-revocation.test.mjs` creates two device sessions, confirms that calendar, SSE, and attachment-view authentication accept both live tokens before revocation, invokes `logout-all`, then verifies that both stale tokens receive HTTP 401 while the replacement token continues through the shared authentication boundary.

The regression also signs malformed token-version claims and a validly signed token for a nonexistent user, proving that bearer middleware, calendar, SSE, and attachment-view transports all reject them with HTTP 401. The attachment regression deliberately requests a missing attachment: a valid session reaches tenant-scoped lookup and receives HTTP 404, while a malformed, nonexistent-user, or revoked session is rejected earlier with HTTP 401. This proves authentication ordering without requiring a fixture attachment.

The regression is part of `npm run test:api`. Every synchronized head must rerun Server Tests, Security Scan, SAST Semgrep, Dependency Review, OSV Scanner, and Fuzz before merge.
