# Stripe reconciliation worker: leased consumption, bounded retry, and dead-letter evidence

## Status and shipped-truth boundary

This record describes the **active PR** stacked on the current Checkout identity-bootstrap slice. Protected `develop` does not ship this worker until the complete prerequisite #488 stack is integrated under live branch protection and exact-head evidence. The parent stack already authenticates Stripe webhook bytes, persists immutable verified events, derives bounded reconciliation triggers, re-fetches current Subscription/Invoice authority, persists observations and entitlement claims, and binds a first Subscription identity from one successful local Checkout attempt. This slice adds only the durable consumption boundary for those queued triggers.

A verified webhook is still not lifecycle or entitlement authority. Stripe explicitly documents automatic retries and non-guaranteed event ordering, and recommends retrieving missing/current objects instead of depending on webhook arrival order. The worker therefore leases a trigger and calls the existing authoritative reconciliation service, which re-fetches current Stripe state before any claim decision is persisted.

## Decision

Use two normalized worker relations in addition to the immutable `billing_stripe_reconciliation_triggers` relation:

- `billing_stripe_reconciliation_jobs` is one mutable scheduling head per verified event trigger. It records `pending`, `processing`, `succeeded`, or `dead_letter`, bounded attempt count, next eligible time, a SHA-256 lease-token digest, lease expiry, completion time, a stable machine error code, and the final claim decision identity when successful.
- `billing_stripe_reconciliation_attempts` is append-only attempt evidence. It records the attempt number, lease window, terminal outcome, and bounded machine error code without persisting the plaintext lease secret or arbitrary provider exception text.

The existing trigger table remains immutable event-to-Subscription work identity. Worker jobs are lazily seeded from triggers during claim so triggers that predate worker deployment are not stranded.

## Authority chain

The worker does not accept an organization identifier from a caller. After claiming a Subscription trigger, it resolves organization authority through the existing normalized `billing_stripe_subscriptions` → `billing_stripe_customers.organization_id` relation. If that authority is not present yet, the job remains explicit retryable work with `stripe_reconciliation_authority_missing`; the provider reconciliation port is not called.

For a resolved tenant, `runNextStripeReconciliationJob` invokes the existing `reconcileStripeBillingAuthoritatively` boundary with exactly the server-derived organization, claimed Subscription, and verified event ID as provenance. The returned receipt is revalidated against that tenant and Subscription before the lease can complete. The worker never writes `orgs.plan`, memberships, RBAC, browser sessions, or capabilities.

## Lease and concurrency contract

Each claim creates a finite lease with an opaque random token. Only the SHA-256 digest is durable. The plaintext token exists only in the claiming process and is required for compare-and-set completion or failure.

An unexpired lease excludes another worker. At or after exact lease expiry, a later claim records the abandoned attempt as `retry` and makes the job eligible again. A stale worker cannot complete or fail a reclaimed lease. If a lease expires on the final configured attempt, the job is moved to `dead_letter` instead of being left permanently `pending` but unclaimable.

Claim, lease-expiry repair, completion, retry, dead-letter transition, and corresponding attempt evidence each execute inside a named SQLite savepoint. SQLite documents that savepoints may be nested and that `ROLLBACK TO` rewinds to the savepoint while leaving it active until `RELEASE`; the implementation therefore releases after success, and after failure releases only when rollback was confirmed. Cleanup failure after confirmed rollback never replaces the causal failure.

## Retry and operational contract

Provider, persistence, and reconciliation failures are bounded by a finite attempt budget. Retry delay is exponential with an explicit ceiling, preventing a hot failure loop. Only stable machine-readable `stripe_*` error codes are retained from downstream failures; arbitrary exception messages are collapsed to `stripe_reconciliation_failed`, preventing provider response text or secret-like values from entering durable worker evidence.

The final-attempt state is `dead_letter`, not silent drop. This is deliberate operator-visible recovery evidence. A subsequent slice may add an authenticated operator inspection/requeue surface, but this worker does not create such authority implicitly.

## TDD and acceptance traceability

`tests/unit/stripe-reconciliation-worker.test.mjs` began as a test-only commit importing the absent production module, creating a deterministic module-resolution RED before implementation. Current behavior exercises real in-memory SQLite relations and requires:

1. exactly one trigger claim, server-owned tenant resolution, exact event provenance into authoritative reconciliation, and durable success/attempt evidence;
2. exclusion under an unexpired lease, reclaim after expiry, and rejection of stale first-worker completion;
3. capped retry with a finite dead-letter budget and no persistence of arbitrary provider/secret-like exception text;
4. explicit retry when Subscription tenant identity is not yet available, without invoking provider reconciliation; and
5. use of the actual production Stripe customer/subscription schema rather than a test-only alias, preventing schema-drift false greens.

`package.json` places the worker regression in normal unit CI and canonical c8 cases. `tests/unit/coverage-script-contract.test.mjs` locks both the production module instrumentation and the behavior test registration against silent removal. `server/db.mjs` installs the worker schema only after its trigger/evidence prerequisites and exports a configured `reconcileNextStripeBillingTrigger()` bootstrap boundary.

## Privacy, security, and audit implications

The worker stores provider event and Subscription identifiers already present in the billing evidence model, scheduling timestamps, bounded machine error codes, claim decision IDs, and lease-token hashes. It stores no raw Stripe payload, webhook body, Stripe secret, session token, plaintext worker lease token, email address, or payment method data. The design supports purpose-bound operational evidence and least-privilege processing without claiming SOC 2, CSAP, PCI DSS, or other certification.

## Rollback

Rollback removes `server/stripe_reconciliation_worker.mjs`, its bootstrap wiring, tests/coverage registration, this doctoring record, and its Unreleased changelog entry together. Before protected integration there is no production data migration. After integration, rollback must preserve the immutable verified events/triggers and worker job/attempt tables as evidence unless an approved migration explicitly proves safe archival; deleting failed/retry evidence is not a rollback strategy.

## Remaining #488 work

This slice intentionally does not run a perpetual scheduler, expose dead-letter recovery UI/API, define long-term retention/export policy, or complete final out-of-order end-to-end acceptance. Those remain subsequent bounded integration/recovery/release slices. External Stripe delivery latency never becomes ordering authority; successful reconciliation still depends on current provider reads and existing monotonic claim logic.

## References

Stripe. (2026). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. https://docs.stripe.com/webhooks

Stripe. (2026). *Process undelivered webhook events*. Stripe Documentation. https://docs.stripe.com/webhooks/process-undelivered-events

SQLite Consortium. (2026). *Savepoints*. SQLite Documentation. https://www.sqlite.org/lang_savepoint.html

SQLite Consortium. (2026). *Transaction*. SQLite Documentation. https://www.sqlite.org/lang_transaction.html
