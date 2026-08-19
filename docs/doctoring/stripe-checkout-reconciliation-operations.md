# Stripe Checkout reconciliation operations — active PR #516

## Status and scope

This document describes **active stacked PR #516**, based on active PR #511 at
`2743a58c9ac65ab125c3898ec94370a7dc91f095`. It is not protected-`develop`
shipped truth and it is not a billing-release claim.

PR #511 deliberately moves stale or clock-ambiguous unresolved Checkout attempts
to `reconciliation_required` instead of minting a speculative fresh Stripe
idempotency key. PR #516 supplies the next bounded persistence/operator boundary:
a safe tenant-scoped inspection surface, a backlog count for an internal metric
adapter, and an atomic audited transition after an authorized caller has already
verified authoritative provider evidence.

This slice does **not** expose an HTTP operator route, does not decide operator
authorization, does not verify a Stripe webhook signature, and does not treat a
caller-provided reference as provider truth. Those controls must exist in the
service adapter before reconciliation can be customer- or operator-invoked.

## Evidence-to-control traceability

| Primary evidence / requirement | ScopeWeave control in this active PR | Acceptance evidence |
| --- | --- | --- |
| Stripe's API v1 idempotency contract can retain a key for at least 24 hours and a reused key can become a new request after pruning. | A held attempt remains blocking after ScopeWeave's conservative 23-hour automatic-replay ceiling until an authoritative reconciliation decision closes it. | `tests/unit/billing-checkout-attempt.test.mjs`; `tests/unit/billing-checkout-reconciliation.test.mjs` |
| Stripe documents idempotency as protection against duplicate mutation when retrying an uncertain POST. | Reconciliation never exposes or replaces the held `idempotency_key`; safe inspection deliberately omits it. | credential non-disclosure and fresh-identity tests |
| Stripe requires the unmodified raw request body for webhook signature verification. | This persistence primitive refuses to implement provider-truth verification itself; the later webhook/service adapter must verify the raw signed request before calling resolution. | explicit public JSDoc boundary; no public reconciliation route in this slice |
| Stripe warns that webhook events may be delivered more than once. | This slice records one immutable reconciliation event per Checkout attempt through an `attempt_id` uniqueness constraint; broader Stripe event-ID deduplication remains separate webhook-ledger work. | schema normalization test |
| Stripe does not guarantee webhook event ordering. | Reconciliation outcome is an explicit authoritative terminal fact for one held attempt rather than an assumption based on arrival order. Subscription/entitlement ordering remains out of scope. | success/failure transition tests |
| Commercial operations need a recoverable path when an uncertain provider mutation is intentionally held. | `countReconciliationRequired` exposes low-cardinality backlog state, and `listReconciliationRequired` exposes only tenant-scoped non-credential metadata for an authorized management adapter. | tenant-filter/count/list regressions |
| An operator release must be auditable and must not silently succeed if audit persistence fails. | Attempt transition and `billing_checkout_reconciliation_events` insert execute inside one SQLite savepoint; an invalid/missing resolving user rolls the whole operation back. | foreign-key rollback regression |

## Data model and normalization

`billing_checkout_reconciliation_events` is a separate relation from
`billing_checkout_attempts`, rather than duplicating attempt/provider-retry
identity in the audit record. Its owned identifiers are descriptive multi-word
`snake_case` names.

- `reconciliation_event_id`: audit-row primary key.
- `attempt_id`: unique foreign key to the held Checkout attempt.
- `resolved_by_user_id`: resolving actor foreign key to `users`; deletion is
  restricted so an audit record cannot lose its actor through normal user-row
  deletion.
- `provider_resolution`: exactly `provider_succeeded` or `provider_failed`.
- `provider_session_id`: required only for authoritative success.
- `evidence_reference`: bounded non-control-character reference to separately
  verified provider evidence; it is not an authorization credential and is not
  sufficient by itself to establish truth.
- `resolved_at_ms`: persisted monotonic resolution timestamp.

The audit relation intentionally does not copy the Stripe idempotency key,
webhook signing secret, bearer token, session secret, credential hash, or other
reusable authority. A separate actor/time index supports audit investigation
without changing the normalized ownership of attempt state.

## Authorization and tenant isolation contract

The repository method requires the organization ID as part of the state-change
predicate. A valid attempt ID from another organization therefore cannot be used
to release the caller's tenant hold. Inspection likewise requires an explicit
organization ID and never returns the provider retry key.

These are persistence-layer defense-in-depth controls, **not** an authorization
system. A service/HTTP adapter must, before calling `resolveReconciliation`:

1. authenticate the operator using ScopeWeave's normal non-URL credential path;
2. prove owner/admin authority for the target organization under the current
   tenant membership state;
3. retrieve or consume provider evidence through a trusted Stripe boundary;
4. verify any webhook signature against the exact raw request bytes and the
   endpoint-specific secret before parsing that evidence as authoritative;
5. map the verified provider fact to the held attempt and organization; and
6. pass only a bounded audit reference to the persistence primitive.

A route that merely accepts `{ outcome: "provider_succeeded" }` from an
authenticated browser would violate this contract.

## Failure semantics and recovery

- A stale/clock-ambiguous attempt remains `reconciliation_required` until exactly
  one authorized authoritative resolution succeeds.
- Cross-tenant or already-terminal attempts fail without creating an audit row.
- `provider_succeeded` requires a bounded provider Session ID and stores it on
  the attempt; `provider_failed` forbids inventing a provider Session ID.
- If the audit row cannot be persisted, the savepoint restores the held attempt.
- Persisted update and audit timestamps are clamped monotonically so wall-clock
  rollback cannot invalidate a valid authoritative terminal decision.
- A successful resolution removes the unresolved uniqueness hold; a subsequent
  deliberate Checkout receives a fresh local attempt and fresh provider
  idempotency key.

Rollback must preserve held attempts and reconciliation audit evidence. Do not
resolve rows merely to make a deployment rollback easier. If this slice is
withdrawn before protected integration, revert the child commits. If it has ever
been integrated with real provider traffic, retain/export the ledger until every
held attempt has an independently recoverable provider disposition.

## TDD and failure-repair chronology

The first child commit added the realistic SQLite reconciliation contract before
production support existed. The implementation then added the normalized audit
relation and repository operations, and the tests were registered in both the
canonical unit and c8 coverage paths.

The first hosted exact-head run exposed a real bootstrap-contract mismatch: the
new audit statement references the existing `users` parent table, while two
legacy isolated Checkout-attempt fixtures created only `orgs`. The production
installer already documented that `users` and `orgs` must exist before billing
schema installation, so the repair changed the fixtures rather than adding
request-time DDL or weakening foreign keys. The first fixture repair made the
Checkout-attempt suite green and exposed the same mismatch in the separate
review-regression fixture. The second fixture repair aligned that fixture as
well. Exact-head `unit-and-api` is green on
`bea914e1d7fd674dd21e1e62b36a38efbf61bf86`; remaining exact-head workflows and
all Ready-event organization gates must still be treated independently before
integration.

## Remaining #488 release blockers

This active PR intentionally leaves these buyer-visible controls open:

- a purpose-bound authorized reconciliation operator API/service adapter;
- exposure of reconciliation backlog on the sanitized metrics/operability
  surface;
- Stripe webhook raw-body signature verification;
- durable Stripe event deduplication and replay handling;
- out-of-order subscription/payment/entitlement reconciliation;
- formal migration-ledger, backup/restore, retention, and deletion acceptance;
- end-to-end production billing recovery drill and incident runbook evidence.

Until those controls converge, ScopeWeave must not claim complete production
Stripe lifecycle readiness.

## References

Stripe, Inc. (n.d.). *Idempotent requests*. Stripe API Reference. Retrieved
August 16, 2026, from https://docs.stripe.com/api/idempotent_requests

Stripe, Inc. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe
Documentation. Retrieved August 16, 2026, from https://docs.stripe.com/webhooks

Stripe, Inc. (n.d.). *Resolve webhook signature verification errors*. Stripe
Documentation. Retrieved August 16, 2026, from
https://docs.stripe.com/webhooks/signature
