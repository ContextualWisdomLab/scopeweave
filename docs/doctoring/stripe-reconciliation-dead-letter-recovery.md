# Stripe reconciliation dead-letter recovery

## Status and scope

This document describes **active pull-request behavior**, not protected-`develop` shipped truth. The recovery slice is stacked on the finite-lease Stripe reconciliation worker and remains non-integrable independently of that prerequisite stack.

The bounded objective is operational: when verified Stripe reconciliation work has exhausted its automatic retry budget and reached durable `dead_letter`, an authorized workspace operator can inspect that tenant's backlog and explicitly retry one exact verified Event without resetting automatic retry history, deleting prior evidence, or treating webhook delivery order as current billing authority.

## Decision

ScopeWeave uses a separate manual recovery authority instead of resetting `billing_stripe_reconciliation_jobs.attempt_count` or reopening the automatic retry budget.

For one dead-letter Event, an owner/admin supplies a bounded evidence reference such as an incident, ticket, or change identifier. ScopeWeave then:

1. resolves the Event's Subscription and organization through existing normalized server-owned Stripe identity;
2. creates one new finite worker lease and monotonically increasing attempt number;
3. appends one immutable `billing_stripe_reconciliation_recoveries` authorization record linked to that exact attempt and authenticated actor;
4. re-fetches current Subscription/Invoice state through the existing authoritative reconciliation service;
5. atomically records either the resulting successful claim decision or a new terminal dead-letter outcome; and
6. returns a bounded non-secret receipt to the operator.

A failed manual recovery does **not** enter another automatic retry cycle. It returns immediately to `dead_letter`. Another manual attempt requires a new explicit evidence reference.

## Why this is safer than resetting retry state

Resetting `attempt_count` would blur automatic and operator-authorized work, could collide with the append-only `(event_id, attempt_number)` attempt key, and would make the historical retry budget difficult to audit. Deleting prior attempts would be worse because it would destroy the evidence needed to explain why an operator recovery was necessary.

The recovery table therefore stores only recovery-specific facts: recovery identity, Event/attempt identity, authenticated actor, bounded evidence reference, timestamps, terminal recovery outcome, sanitized error code, and optional claim-decision identity. Tenant identity remains normalized through Event trigger → Subscription → Customer → organization. Attempt timing/outcome remains on worker attempt history. Provider payloads, webhook raw bodies, lease plaintext, API secrets, session tokens, and membership authority are not copied into recovery evidence.

## Idempotency and concurrency

`(event_id, evidence_reference)` is unique. Replaying the same recovery request returns the already-durable receipt and does not perform another provider read or create another worker attempt.

A new recovery is claimed only while the exact job is still `dead_letter` and its current attempt count matches the selected row. The job transition, new attempt, and recovery-authorization row share one named SQLite savepoint. If any mutation fails, ScopeWeave performs `ROLLBACK TO SAVEPOINT` and releases the savepoint only after rollback is confirmed, preserving the causal error and avoiding a partial operator authorization.

Completion and failure also wrap the existing worker completion/failure operation inside the recovery savepoint. Because the worker uses a distinct nested savepoint, worker state, append-only attempt outcome, and recovery receipt commit or roll back together.

## Lease and crash behavior

The plaintext manual lease token is returned only inside the in-process recovery orchestration boundary. Durable worker state contains only its SHA-256 digest and finite expiration.

If a process dies after manual claim and before resolution, the existing worker's expired-lease logic remains authoritative. Since a manual attempt number is already beyond the automatic attempt budget, lease expiry resolves back to terminal dead-letter evidence rather than silently reopening automatic retries. Replaying the same operator evidence can derive the dead-letter outcome from the linked append-only attempt.

## Authorization and tenant isolation

The HTTP surface is purpose-specific:

- `GET /api/orgs/:id/billing/reconciliation/dead-letters`
- `POST /api/orgs/:id/billing/reconciliation/dead-letters/:eventId/retry`

Authentication uses the existing JWT/PAT credential contract. Workspace owners/admins may inspect or retry only their own organization. The repository scopes dead-letter selection through normalized Subscription → Customer → organization identity; callers do not provide a Subscription ID. A caller who is authorized in one workspace but supplies an Event belonging to another receives a non-disclosing not-found result.

Responses use `Cache-Control: no-store` and never expose lease tokens, Stripe secrets, raw provider bodies, webhook raw bytes, or arbitrary exception text.

## Evidence reference contract

The evidence reference is operator provenance and idempotency authority, not free-form incident content. It must be a non-empty control-free string no longer than 256 characters. Operators should use a stable identifier that an auditor can follow in the system of record, for example `INC-2026-0042` or a bounded change-ticket key, rather than copying sensitive incident narratives into ScopeWeave.

## Failure handling

Provider/persistence/policy exceptions may contain sensitive provider text. Only bounded machine-readable `stripe_*` error codes are retained; otherwise the outcome collapses to `stripe_reconciliation_recovery_failed`.

If ScopeWeave cannot prove that worker completion/failure and recovery-receipt persistence changed atomically, the API fails closed as `stripe_reconciliation_recovery_state_uncertain`. It must not invent success or issue a speculative second provider call.

## TDD and acceptance evidence

The tests were introduced before the production recovery module/route existed.

`tests/unit/stripe-reconciliation-dead-letter-recovery.test.mjs` exercises tenant-scoped listing, append-only attempt 5 → manual attempt 6, authoritative success, immediate dead-letter failure, same-evidence replay, new-evidence retry, input bounds, in-progress replay, secret-text non-persistence, and rollback when recovery audit insertion fails after the job mutation has begun.

`tests/api/stripe-reconciliation-dead-letter-recovery.test.mjs` exercises unauthenticated/ordinary-member denial, owner inspection, foreign-tenant non-disclosure, bounded evidence input, one real application-route recovery against a deterministic Stripe transport seam, same-request idempotency without a second provider call, backlog clearing, and durable actor/evidence attribution.

Both production recovery modules are part of canonical owned-production c8 instrumentation, and focused unit/API tests are part of normal repository test execution. Hosted exact-head evidence remains authoritative for integration.

## Rollback

Before protected integration, rollback removes the recovery route module, recovery repository/schema, bootstrap wiring, focused tests, coverage registrations, documentation, and changelog entry together.

After integration, rollback of executable recovery behavior should stop exposing the recovery routes first but **must not delete** existing `billing_stripe_reconciliation_recoveries` rows or prior reconciliation attempts. Those rows are historical audit evidence. A later schema-retirement migration, if ever justified by retention policy, must be separately designed and reviewed.

## Remaining work

This slice does not add a perpetual scheduler, automatic operator paging, UI recovery console, final out-of-order end-to-end convergence acceptance, retention/export policy, or release acceptance. It also does not change `orgs.plan`, membership/RBAC, authentication semantics, or browser capability issuance.

## References

SQLite. (n.d.). *SAVEPOINT*. SQLite documentation. Retrieved August 21, 2026, from https://sqlite.org/lang_savepoint.html

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe documentation. Retrieved August 21, 2026, from https://docs.stripe.com/webhooks
