# Authoritative Stripe subscription observation ledger

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This record belongs to PR #526 and is stacked on PR #525's authoritative Stripe Subscription read boundary. Protected `develop` remains the shipped authority until the prerequisite stack is independently reviewed, protected-integrated, and revalidated against the final exact heads.

Issue #488 remains open for lifecycle projection, monotonic entitlement policy, invoice/payment state, operator reconciliation, retention/export controls, and release acceptance. This slice deliberately persists provider-read evidence only; it does not grant or revoke an organization plan.

## Buyer and data-integrity objective

Stripe documents that webhook delivery order is not guaranteed and recommends retrieving provider objects when required to recover authoritative state. ScopeWeave therefore separates three concerns:

1. cryptographically verified webhook delivery evidence;
2. a tenant-verified current Subscription read from Stripe;
3. an append-only local observation ledger that preserves each accepted provider read without treating arrival order as entitlement authority.

The ledger gives an operator or later reconciliation policy a durable chronology of what ScopeWeave actually observed. It never updates `orgs.plan` and never converts Stripe status directly into local authorization.

## Normalized data model

`server/stripe_subscription_observation_ledger.mjs` installs five normalized relations at database bootstrap:

- `billing_stripe_customers`: one Stripe customer identity bound permanently to one ScopeWeave organization;
- `billing_stripe_subscriptions`: one Stripe subscription identity bound permanently to one customer;
- `billing_stripe_prices`: deduplicated provider price identities;
- `billing_stripe_subscription_observations`: append-only provider lifecycle facts for one subscription read;
- `billing_stripe_subscription_observation_prices`: ordered many-to-many observation/price membership.

The design avoids storing organization plan/entitlement state in an observation row, avoids repeating customer/tenant facts in every observation, and preserves source-event provenance separately through an optional foreign key to `billing_stripe_webhook_events`. All newly owned database objects use descriptive multiword `snake_case` names.

## Persistence invariants

`recordAuthoritativeObservation(...)` validates the provider snapshot again at the persistence boundary even though PR #525 already normalizes the remote response. A valid record requires:

- a positive safe-integer organization ID that exists locally;
- bounded provider customer/subscription identifiers;
- one of the explicitly accepted Stripe Subscription statuses;
- Boolean cancel-at-period-end state;
- safe nonnegative provider timestamps with end not preceding start;
- one to 100 bounded price identifiers;
- optional bounded invoice and previously persisted source-event identifiers.

A previously seen Stripe Customer cannot be rebound to a different ScopeWeave organization, and a previously seen Subscription cannot be rebound to a different Customer. Identity conflicts fail closed with stable conflict semantics before a new observation is accepted.

Successful provider reads append observations rather than updating old snapshots. The local observation timestamp is monotonic per subscription even if the host wall clock moves backward; `observation_id` remains the durable append order when timestamps tie.

## Transaction and failure semantics

Customer identity, subscription identity, prices, the observation row, and ordered price memberships are written under one SQLite savepoint. A forced downstream junction-row failure is covered by a realistic trigger regression that proves all preceding mutations roll back together.

A distinct cleanup-failure regression was added after working-path comparison with the calendar-subscription persistence adapter exposed the same transaction hazard: an unconditional `RELEASE` in a `finally` block can commit the outermost savepoint when `ROLLBACK TO` itself failed. SQLite documents that releasing the outermost savepoint is equivalent to commit. The observation repository now:

- preserves the causal operation error;
- releases the savepoint only after rollback is confirmed;
- suppresses cleanup-release errors after a confirmed rollback so they cannot replace the business/persistence failure;
- leaves an unconfirmed failed savepoint open rather than risk committing partial state.

The RED contributor head `f337b90ef1803290efb7e7df02745c7280e9d5de` added the cleanup regression and caused hosted `unit-and-api` to fail. The narrow production repair at `dada7f0ef3327fc16e0b0d02f270196285fafcd1` restored hosted `unit-and-api`, API, dependency-review, and OSV success without weakening a gate.

## Tenant, privacy, and entitlement boundary

The ledger stores only provider identifiers and lifecycle facts required for reconciliation. It does not store Stripe secret keys, signed raw webhook bodies, session credentials, arbitrary provider error bodies, or local entitlement decisions.

Organization authority is purpose-bound: the local organization must already exist, the authoritative provider reader must have verified `Subscription.metadata.orgId`, and the persistence layer permanently binds the resulting Stripe identities to that tenant. A later policy layer must independently decide which observed provider state authorizes a local plan transition.

The optional `source_event_id` is audit/reconciliation-trigger provenance only. Event arrival time is not a lifecycle ordering key and source-event presence never grants entitlement.

## Acceptance trace

Executable evidence includes:

- `tests/unit/stripe-subscription-observation-ledger.test.mjs` for normalized schema shape, tenant/customer identity non-rebinding, append-only observations, validation, rollback atomicity, savepoint-cleanup failure, monotonic timestamps, source-event existence, and no direct plan mutation;
- `server/db.mjs` for bootstrap-only schema installation after the verified Stripe event ledger;
- `tests/unit/coverage-script-contract.test.mjs` for canonical coverage registration;
- `package.json` for normal unit execution and owned-production c8 instrumentation.

PR #523 is still the repository-owned exact-contributor-head checkout-control prerequisite for merge-grade evidence across this billing stack. Repository-native successes on a stack that still inherits the prior synthetic pull-request merge checkout behavior are useful causal evidence but are not promoted to final exact-head proof.

## Rollback and recovery

Before protected integration, rollback removes the observation schema/bootstrap wiring, repository, focused tests, coverage registration, this doctoring record, and the corresponding active-PR changelog entry together.

After this ledger is eventually protected-shipped, rollback must not destroy accumulated observation history merely to revert a later entitlement policy. Recovery should retain provider evidence, re-fetch authoritative Subscription state, append a new verified observation, and replay the explicitly versioned policy from a known local/provider point.

## References

SQLite. (n.d.). *Savepoints*. SQLite Documentation. https://sqlite.org/lang_savepoint.html

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. https://docs.stripe.com/webhooks

Stripe. (n.d.). *Retrieve a subscription*. Stripe API Reference. https://docs.stripe.com/api/subscriptions/retrieve

Stripe. (n.d.). *Using webhooks with subscriptions*. Stripe Documentation. https://docs.stripe.com/billing/subscriptions/webhooks
