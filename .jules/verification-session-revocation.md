# Query-token session revocation verification

## Security invariant

Calendar and server-sent-event endpoints that accept a JWT through the query string must enforce the same database-backed `token_version` revocation check as bearer-token authentication.

## Regression evidence

`tests/api/session-revocation.test.mjs` creates two device sessions, confirms that both query-token endpoints accept them before revocation, invokes logout-all, then verifies that both stale tokens receive HTTP 401 while the replacement token remains valid.

The regression is part of `npm run test:api`. Every synchronized head must rerun Server Tests, Security Scan, SAST Semgrep, Dependency Review, OSV Scanner, and Fuzz before merge.
