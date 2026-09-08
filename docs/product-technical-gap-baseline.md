# ScopeWeave product–technical gap baseline

Updated: 2026-09-08

This document records buyer-visible product and technical gaps against the protected `develop` branch. It is evidence-led: a candidate branch is not treated as shipped capability until the protected branch contains the change and its required checks, review, and release evidence are complete.

## Current authority

- Protected branch: `develop`
- Protected branch head inspected: `2c328875e00e86537df3e965170be80532571cad`
- Authentication repair lane: PR #674
- Causal regression commit: `9a244c5c4597e3b7ee87c5e2cd52c1b30bd00f73`
- Release state: not released; PR #674 remains Draft until current-head required checks and independent review are complete.

## Context boundary

ScopeWeave owns its product authentication admission policy and WBS domain truth. `server/auth.mjs` owns local password/JWT cryptographic primitives; the `/api/auth/login` application boundary in `server/app.mjs` coordinates user lookup and credential admission. The WBS/project aggregate remains separate from authentication and tenant admission. Authentication policy must not be copied into unrelated product contexts.

The relevant invariant is: a login lookup miss must not skip the expensive password-verification path that a lookup hit with a wrong password performs. This does **not** assert that the complete HTTP request is constant-time; database lookup, request parsing, scheduling, network transport, rate limiting, and other layers can still vary.

## Active gap: login discrepancy factor

### Problem and buyer impact

The protected branch rejects a missing user before calling `verifyPassword`. A wrong password for an existing user performs `scryptSync`, while a missing user can return without that work. That quick-exit is a discrepancy factor that can contribute to account enumeration. OWASP's Authentication Cheat Sheet explicitly warns that authentication logic can disclose account existence through processing-time differences and recommends avoiding quick-exit behavior.

No repository evidence currently establishes a remotely exploitable latency threshold or a severity-specific timing distribution. Therefore this baseline records an account-enumeration risk and a control-flow defect, not a claim that the entire endpoint is constant-time or that exploitation has been measured in production.

### RED

On the protected implementation, the login condition contains the missing-user short-circuit before `verifyPassword`. The regression added in `tests/unit/auth-password.test.mjs` requires password verification to occur before missing-user rejection; that contract is intended to fail against the protected pre-fix control flow. The API smoke fixture uses an in-memory database and exercises a deterministic lookup miss.

### Candidate fix

PR #674 performs password verification unconditionally after lookup and supplies fixed-shape dummy password material when the stored credential is absent. The application still returns the same generic `401` response for a missing user and a wrong password. This preserves the product behavior while removing the known quick-exit.

Alternatives rejected:

- Early return: preserves the discrepancy factor.
- Artificial sleep: does not make the authentication work equivalent and introduces scheduler-dependent behavior.
- Different user-facing errors: directly increases account-enumeration information disclosure.

### GREEN acceptance

The lane is GREEN only when one exact candidate SHA demonstrates all of the following:

1. The causal control-flow regression passes and would fail against the protected pre-fix route.
2. `npm run test:unit` and `npm run test:api` pass on that exact SHA.
3. Repository-required `unit-and-api`, `cloud-e2e`, `Analyze (javascript-typescript)`, `Analyze (python)`, and `property fuzz` checks reach authenticated terminal success for that SHA, or an owner-approved ruleset change replaces them without weakening the security gate.
4. Independent current-head review has no unresolved valid finding.
5. Merge is a normal protected-branch merge; predecessor receipts, synthetic statuses, and source-neutral retriggers do not substitute for current-head evidence.

### Follow-up measurement

If the product makes a quantitative timing claim, measure the actual login endpoint with representative right-cleared workloads, warm-up and repeated samples, identical network/runtime conditions, and distributions for existing-user/wrong-password versus missing-user cases. Record median and tail latency plus uncertainty. Do not infer an HTTP constant-time guarantee from `timingSafeEqual` or from equivalent scrypt work alone.

## Traceability

- OWASP Foundation. (n.d.). *Authentication cheat sheet*. OWASP Cheat Sheet Series. Retrieved September 8, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Foundation. (2025). *OWASP Application Security Verification Standard 5.0.0*. https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release
- OpenJS Foundation. (n.d.). *Crypto: `crypto.timingSafeEqual`*. Node.js documentation. Retrieved September 8, 2026, from https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b

ASVS 5.0.0 is the latest stable ASVS release at this update. Versioned requirement identifiers should be used when a specific ASVS control is later mapped into acceptance evidence; the ASVS project recommends version-qualified identifiers because identifiers can change between releases.
