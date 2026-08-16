# Stripe entitlement policy

## Status and scope

This record describes **active stacked PR work** under issue #488. It is not protected-`develop` shipped truth and it does not by itself grant, revoke, persist, or authorize ScopeWeave access. The slice is a deterministic policy boundary over already-authoritative provider facts. Persistence, transactionality with owned entitlement state, invoice retrieval/storage, operator recovery, and runtime authorization remain follow-on integration work.

The policy consumes the tenant-scoped current Subscription projection from the preceding stack plus independently authoritative invoice evidence when paid access is being considered. It returns an immutable transition candidate and never writes `orgs.plan`, a database row, a session, or a provider object.

## Decision

A Stripe Subscription status is provider lifecycle evidence, not sufficient local entitlement authority by itself. In particular, Stripe documents an `active` subscription as normally paid or inside a trial, while its lifecycle guidance also permits collection actions such as marking an invoice uncollectible without necessarily changing the underlying Subscription out of `active`. ScopeWeave therefore requires a matching authoritative `paid` Invoice fact before an `active` Subscription can create or extend paid access.

The policy is deliberately conservative:

| Subscription status | ScopeWeave policy candidate |
| --- | --- |
| `trialing` | Grant only until a future authoritative `trial_end`; exact/past expiry fails closed. |
| `active` | Grant/extend only when the Subscription's exact `latest_invoice` is independently observed as `paid` for the same Subscription and the current period is still future. |
| `past_due` | Never create or extend access. An already-paid, unexpired prior claim may be retained only through its existing expiry while dunning/recovery is handled elsewhere. |
| `unpaid` | Deny or revoke the affected Subscription claim. |
| `paused` | Deny or revoke the affected Subscription claim. |
| `canceled` | Deny or revoke the affected Subscription claim. |
| `incomplete` | Deny or revoke the affected Subscription claim. |
| `incomplete_expired` | Deny or revoke the affected Subscription claim. |

`cancel_at_period_end` does not itself revoke an otherwise paid current period. The claim is already capped at `current_period_end`, so cancellation can become effective without inventing an earlier local cutoff.

## Monotonic evidence rule

Every claim records the authoritative Subscription `observation_id` that produced it. A Subscription observation older than the claim's source observation is ignored, preventing late or replayed evidence from rolling back a newer local decision candidate.

Equal observation identity is not automatically ignored. That permits an initially inconclusive Subscription observation to be enriched later by independently retrieved matching Invoice evidence without manufacturing a newer Subscription read. The future persistence adapter must still perform compare-and-set/idempotent writes under one transaction so equal-source retries cannot duplicate audit or entitlement mutations.

## Invoice evidence boundary

Paid access requires all of the following at the same policy call:

- bounded authoritative Subscription identity and tenant authority;
- a future current-period end;
- non-null Subscription `latest_invoice` identity;
- an authoritative Invoice with `status=paid`;
- exact Invoice identity equality with `latest_invoice`; and
- exact Invoice→Subscription identity equality.

Missing, mismatched, open, draft, void, uncollectible, malformed, or cross-Subscription invoice evidence cannot create or extend paid access. An already-paid unexpired claim may remain unchanged when fresh paid evidence is temporarily unavailable, but it is never lengthened without new matching paid evidence.

This slice deliberately does not infer payment from webhook arrival order or from browser/client plan state.

## Multiple subscriptions

Entitlement is first modeled per Subscription and only then aggregated for an organization. A canceled or unpaid Subscription cannot erase access independently supported by another unexpired Subscription claim. Organization aggregation therefore returns the set of currently active Subscription identities and the furthest valid-until bound across them.

This is a projection contract, not a recommendation to encode all product packaging as one Boolean forever. Future feature/seat/quantity entitlements should remain normalized per product/price/grant dimension rather than overloading this aggregate.

## Security and privacy

Inputs are bounded and fail closed before a decision. Organization identifiers and observation identifiers must be positive safe integers. Provider identifiers are bounded structured strings. Cross-tenant previous claims are rejected. Output objects and Subscription-ID collections are immutable.

The module accepts no Stripe secret, raw webhook body, browser session credential, HMAC material, or arbitrary provider response. No PII is introduced by this slice.

## TDD and coverage evidence

The first branch commit introduced the entitlement behavior contract while `server/stripe_entitlement_policy.mjs` was absent; focused local Node execution failed with `ERR_MODULE_NOT_FOUND` before production implementation. The production implementation followed on the same owning branch.

The edge suite then locks fail-closed validation, exact-expiry behavior, same-observation invoice enrichment, stale-observation rejection, all supported lifecycle states, cross-tenant evidence rejection, and multi-Subscription aggregation. Local Node 22.16.0 verification of the production module with the behavior and edge suites reports **100% line, 100% branch, and 100% function coverage** under Node's built-in test coverage. Hosted exact-head c8 evidence remains mandatory before integration; local evidence and test registration are not substitutes for live protected checks.

`package.json` registers both behavior suites in normal unit CI and canonical c8 execution, and `tests/unit/coverage-script-contract.test.mjs` prevents the module or either suite from silently dropping out of those paths.

## Remaining executable work

This pure policy does not complete #488. The next bounded slices must provide authoritative Invoice/payment retrieval and normalized persistence, transactional per-Subscription claim/audit storage, organization-entitlement aggregation persistence, out-of-order reconciliation that invokes this policy from authoritative provider reads, reversible grant/revoke application, operator recovery, API/authorization integration, migration/restart/concurrency acceptance, and incident/privacy/release evidence.

No production route should call this module and directly mutate `orgs.plan` as a shortcut. The persistence boundary must preserve source observation/invoice identities, old/new claim state, actor/system reason, idempotency, and rollback in one auditable transaction.

## Rollback and recovery

Before persistence/runtime integration, rollback removes `server/stripe_entitlement_policy.mjs`, its two focused suites, coverage registrations, this doctoring record, and its Unreleased changelog line together. There is no data migration in this slice.

After a future persistent entitlement adapter ships, rollback must not erase claim/audit history or restore webhook-arrival/provider-status overwrite behavior. Recovery must replay authoritative provider facts through a versioned policy and compare the reconstructed result against durable state before any corrective mutation.

## References

Stripe. (2026). *The Subscription object*. Stripe API Reference. https://docs.stripe.com/api/subscriptions/object

Stripe. (2026). *How subscriptions work*. Stripe Documentation. https://docs.stripe.com/billing/subscriptions/overview

Stripe. (2026). *Using webhooks with subscriptions*. Stripe Documentation. https://docs.stripe.com/billing/subscriptions/webhooks
