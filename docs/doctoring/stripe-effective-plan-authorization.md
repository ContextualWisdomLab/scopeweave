# Claim-backed effective plan authorization

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This bounded #488 slice is stacked on the transactional entitlement-claim ledger. Protected `develop` remains shipped authority until the prerequisite billing stack is independently reviewed and integrated.

The slice applies durable Stripe claim state to ScopeWeave's existing project/member plan-limit authorization. It does not change membership roles, authentication, Stripe provider state, claim derivation, or `orgs.plan` persistence.

## Buyer objective

A durable paid claim is not commercially useful if product limits still read only the legacy `orgs.plan` column. Conversely, copying Stripe state into that column would destroy provenance and make revocation/recovery ambiguous. ScopeWeave therefore resolves an **effective access plan** at the resource-limit boundary without mutating the stored plan.

`effectivePlanOf` in `server/billing.mjs` treats an explicit stored `pro` plan as a manual/legacy non-Stripe override. Otherwise, an organization receives Pro limits only while at least one current Stripe entitlement claim head for that exact organization is both `entitled = 1` and has `valid_until_sec` strictly greater than the current epoch second.

When that claim expires or the current head advances to a revoke/deny claim, the organization automatically returns to its stored Free limits. No plan-row rewrite or compensating revocation mutation is required.

## Tenant and failure boundary

The claim query joins current claim head → decision → Subscription → Customer → organization and filters on the exact server-owned organization ID. A claim from another tenant cannot unlock this organization.

The helper validates a positive safe-integer organization ID, a SQLite-like database boundary, and a non-negative safe-integer clock before entitlement lookup. Claim-table absence or read failure does not manufacture paid authority: resolution fails closed to the explicit stored plan. This permits rolling schema deployment and incident containment without turning persistence failure into Pro access.

An explicit stored Pro plan remains independent of Stripe claim-table health. This preserves pre-existing/manual commercial authority and avoids silently revoking a non-Stripe contract during Stripe reconciliation incidents.

## Resource-limit application

`wouldExceed` now evaluates project/member limits from `effectivePlanOf`. Existing callers require no new browser-provided authority and cannot supply claim IDs. Consequently:

- Free organizations at their current limit remain blocked without a claim;
- one unexpired tenant-owned claim unlocks Pro's unlimited project/member limits;
- exact expiry re-locks the limits;
- a later false/revoked current claim re-locks immediately;
- a foreign-tenant claim has no effect; and
- stored Pro remains unlimited even if claim tables are absent.

This is an authorization application, but it is intentionally narrow: it governs the existing commercial resource limits only. A later UI/API truth-status slice should surface claim-backed effective billing status so buyers see the same authority the server enforces.

## TDD and rollback

Test-only commit introduces `tests/unit/billing-effective-plan.test.mjs` before production changes and requires claim-backed unlock, expiry/revoke re-lock, tenant isolation, stored-Pro override, fail-closed missing-table behavior, and bounded authority inputs. The production change keeps `server/billing.mjs` in the existing canonical c8 producer and registers the focused regression in normal unit CI and coverage cases.

Rollback restores `wouldExceed` to stored-plan-only behavior and removes the effective-plan regression, doctoring record, and matching Unreleased changelog entry. It does not alter claim evidence or require a database migration.

## References

SQLite. (n.d.). *SELECT*. https://www.sqlite.org/lang_select.html

Stripe. (n.d.). *The Subscription object*. Stripe API Reference. https://docs.stripe.com/api/subscriptions/object
