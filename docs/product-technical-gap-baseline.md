# ScopeWeave product–technical gap baseline

Updated: 2026-09-08

## Current authority

- Protected branch: `develop@2c328875e00e86537df3e965170be80532571cad`
- Authentication repair lane: PR #674
- Deterministic lookup-miss regression commit: `d49fcba86cd77bbfba939fa7a8e15def63838ad0`
- Release state: not released; current-head required checks and independent review remain acceptance gates.

## Authentication boundary

`server/auth.mjs` owns local password/JWT cryptographic primitives. The `/api/auth/login` application boundary in `server/app.mjs` coordinates user lookup and credential admission. WBS/project aggregate truth remains separate from authentication and tenant admission.

Invariant: for a string password, a login lookup miss must not take the protected branch's password-verification quick exit. The candidate miss path invokes `verifyPassword(password, null)`, which performs dummy scrypt work before returning the same generic `401` used for invalid credentials. This narrows a known processing-work discrepancy; it does not make the complete HTTP request constant-time. Database lookup, parsing, scheduling, transport, rate limiting, memory allocation, and other layers can still vary.

## Active gap: login discrepancy factor

Protected `develop` rejects a missing user before calling `verifyPassword`. A wrong password for an existing user performs `scryptSync`, while a missing user can return without that work. OWASP's Authentication Cheat Sheet identifies authentication quick exits and processing-time differences as discrepancy factors that can contribute to user enumeration.

No retained endpoint measurement establishes a remotely exploitable timing threshold or severity-specific latency distribution. Accordingly, this baseline records a control-flow asymmetry and account-enumeration risk, not a measured endpoint constant-time guarantee or proven remote exploitability.

### RED

The protected route contains the lookup-miss quick exit before password verification. `tests/unit/auth-password.test.mjs` deterministically requires the missing-user branch to call `verifyPassword(password, null)` before returning `401`; this causal contract fails against the protected pre-fix route. `tests/api/smoke.mjs` separately exercises a deterministic missing user in a fresh in-memory database.

### Candidate repair

PR #674 adds an explicit missing-user branch that calls the shared verification primitive with absent storage. `verifyPassword` substitutes fixed-shape dummy salt material and performs scrypt before failing closed. Existing-user wrong-password behavior remains generic `401`; non-string password bodies continue to fail closed without being coerced into real credentials.

Rejected alternatives:

- protected-branch early return: preserves the known quick exit;
- artificial sleep or wall-clock pass/fail threshold: does not prove equivalent authentication work and varies with host/scheduler load;
- user-specific failure messages: increase account-enumeration disclosure;
- claiming constant-time HTTP behavior from `timingSafeEqual` or dummy scrypt alone: exceeds the available evidence.

### GREEN acceptance

One exact candidate SHA must demonstrate all of the following:

1. deterministic lookup-miss control-flow and password-boundary regressions PASS;
2. `npm run test:unit` and `npm run test:api` PASS;
3. protected-branch required checks (`unit-and-api`, `cloud-e2e`, `Analyze (javascript-typescript)`, `Analyze (python)`, `property fuzz`) reach authenticated terminal PASS on that SHA;
4. independent current-head review has no unresolved valid finding;
5. merge is a normal protected-branch merge without predecessor receipts, synthetic statuses, source-neutral/no-op retriggers, or gate weakening.

If a quantitative timing claim is later required, retain repeated existing-user/wrong-password and missing-user endpoint distributions under equivalent representative runtime/network conditions, and report median/tail latency with uncertainty rather than a single minimum-duration assertion.

## Traceability

- OWASP Foundation. (n.d.). *Authentication cheat sheet*. OWASP Cheat Sheet Series. Retrieved September 8, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Foundation. (2025). *OWASP Application Security Verification Standard 5.0.0*. https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release
- OpenJS Foundation. (n.d.). *Crypto: `crypto.timingSafeEqual`*. Node.js documentation. Retrieved September 8, 2026, from https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b
