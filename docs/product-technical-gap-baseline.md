# ScopeWeave product and technical gap baseline

This snapshot binds current gaps to exact evidence. It does not authorize a
merge; current-head Checks and independent review remain required.

| Gap ID | Status | Exact evidence | Owner and acceptance |
|---|---|---|---|
| SECURITY-DEPENDENCY-HONO-01 | Proposed — canonical owner integrated; consumer revalidation required | `scopeweave#776@e778476d8dfd50e31b6ed7015b40738cbee0bd0d`, Security `36805584131`, job `110189111375`: four fixable Hono 4.13.0 CVEs | `scopeweave#737@3f7fc0e13731544fe69d4919c07c44e8fb706249` advances source and lock to 4.13.9. #776 ordinary-merges the owner without changing its login timing contract. Accept after exact-head Server Tests, Security, SAST, Fuzz, non-skipped CodeQL, and independent review. |

## Product and technical effect

The standalone planner and cloud API contracts are unchanged. The dependency
repair preserves the native Hono boundary and adds no runtime package or
parallel server implementation.
