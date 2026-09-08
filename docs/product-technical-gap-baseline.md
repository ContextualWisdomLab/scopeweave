# ScopeWeave product–technical gap baseline

Updated: 2026-09-08

## Current authority

- Protected branch: `develop@2c328875e00e86537df3e965170be80532571cad`
- Authentication repair lane: PR #674
- Deterministic causal-regression commit: `f3bd01eaa827f3ff3dc6f27ff491d51fbee62847`
- Release state: not released; the PR remains Draft until current-head required checks and independent review complete.

## Authentication boundary

`server/auth.mjs` owns local password/JWT cryptographic primitives. The `/api/auth/login` application boundary in `server/app.mjs` coordinates user lookup and credential admission. WBS/project aggregate truth remains separate from authentication and tenant admission.

Invariant: a login lookup miss must not skip the password-verification path performed for an existing user with a wrong password. This does not imply that the complete HTTP request is constant-time; database lookup, request parsing, scheduling, network transport, rate limiting, and other layers can vary.

## Active gap: login discrepancy factor

Protected `develop` uses a missing-user quick exit before `verifyPassword`. A wrong password for an existing user therefore performs `scryptSync`, while a missing user can return without that work. OWASP's Authentication Cheat Sheet identifies processing-time differences caused by authentication quick exits as a discrepancy factor that can support user enumeration.

The repository contains no retained endpoint-level measurement establishing a remotely exploitable latency threshold. The defect is therefore recorded as account-enumeration risk and control-flow asymmetry, not as a claim that the endpoint is constant-time or that a particular severity has been empirically established.

### RED

The pre-fix login route contains the lookup-miss short circuit. `tests/unit/auth-password.test.mjs` now locks the causal mechanism structurally: `verifyPassword(...)` must occur before missing-user rejection. Unlike a wall-clock threshold, this regression is deterministic and would fail against the protected pre-fix control flow. The API smoke test separately exercises a deterministic missing user in a fresh in-memory database.

### Candidate fix

PR #674 performs verification after lookup regardless of user existence and supplies fixed-shape dummy material when the stored credential is absent. Both missing-user and wrong-password cases retain the same generic `401` response.

Rejected alternatives:

- Early return: preserves the discrepancy factor.
- Artificial sleep or a minimum elapsed-time assertion: does not prove equivalent authentication work and is scheduler/host dependent.
- User-specific failure messages: increase enumeration disclosure.

### GREEN acceptance

A single exact candidate SHA must show:

1. deterministic causal regression PASS;
2. `npm run test:unit` and `npm run test:api` PASS;
3. protected-branch required checks (`unit-and-api`, `cloud-e2e`, `Analyze (javascript-typescript)`, `Analyze (python)`, `property fuzz`) terminal PASS on that SHA;
4. independent current-head review with no unresolved valid finding;
5. normal protected-branch merge without predecessor receipts, synthetic status, no-op retriggers, or gate weakening.

If a quantitative timing claim is later made, retain repeated existing-user/wrong-password versus missing-user endpoint distributions under equivalent representative runtime/network conditions and report median/tail latency plus uncertainty.

## Traceability

- OWASP Foundation. (n.d.). *Authentication cheat sheet*. OWASP Cheat Sheet Series. Retrieved September 8, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Foundation. (2025). *OWASP Application Security Verification Standard 5.0.0*. https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release
- OpenJS Foundation. (n.d.). *Crypto: `crypto.timingSafeEqual`*. Node.js documentation. Retrieved September 8, 2026, from https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b

ASVS 5.0.0 is the latest stable ASVS release at this update. When a specific ASVS requirement is mapped into acceptance evidence, use its version-qualified identifier as recommended by the ASVS project.
