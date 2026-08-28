# Stripe Checkout attempt idempotency — active PR #511

## Status and decision

This document describes **active stacked PR #511**, based on PR #507 at
`f1ca84bab7603cb0882c1a5b4d822c5714daacdb`. It is not protected-`develop`
shipped truth and it is not a production-readiness claim. The slice exists to
make an uncertain Checkout Session creation retryable without silently creating
a second provider object.

The decision is to persist a ScopeWeave-owned Checkout attempt before the live
Stripe POST and bind exactly one opaque idempotency key to that attempt. The live
transport sends the key as `Idempotency-Key`; an unresolved attempt is reused
only for the same organization and price and only inside a 23-hour local safety
window. Terminal provider outcomes close the local attempt. No authentication
secret or bearer token is stored in the ledger.

The 23-hour window is intentionally shorter than Stripe's documented 24-hour
retry horizon / at-least-24-hour key retention boundary. It is a conservative
local ceiling, not a claim that Stripe purges every key at exactly 24 hours.

## Evidence-to-control traceability

| Primary evidence | ScopeWeave control | Acceptance evidence |
| --- | --- | --- |
| Stripe recommends sufficiently unique keys such as UUID v4 and permits keys up to 255 characters. | Generate opaque UUID-backed `attempt_id` and `idempotency_key`; never derive the provider key from a secret. | `tests/unit/billing-checkout-attempt.test.mjs` |
| Stripe records POST results by idempotency key and compares parameters on reuse. | Persist one organization/price attempt identity and reuse the same key only while that exact attempt is unresolved. | repository reuse/terminal-state tests plus transport header tests |
| A network failure can leave the client unable to know whether Stripe executed the mutation. | Network/abort failures leave the attempt `pending`; the next caller reuses the same key. | `tests/unit/billing-provider-boundary.test.mjs` |
| Stripe documents server errors, especially HTTP 500, as indeterminate and warns that a fresh key can duplicate side effects. | All Stripe 5xx responses keep the attempt `pending`; no fresh key is issued merely because a server-error response arrived. | regression commit `35571be0c0e81359dff09238f5815ed13dcf0440` followed by the production fix |
| A successful HTTP response can still be unusable locally after the provider has performed the mutation. | Malformed, unreadable, over-budget, or untrusted 2xx responses remain unresolved and reuse the same idempotency key instead of closing the attempt. | `tests/unit/billing-checkout-review-regressions.test.mjs` and provider-boundary regressions |
| A received 4xx normally identifies a correctable request failure, but Stripe does not begin endpoint execution for a concurrent idempotency conflict. | Known 4xx responses other than 409 close the current local attempt as `provider_failed`; a concurrent 409 remains pending so the same key can be retried. | provider-boundary 4xx/409 regression |
| Checkout Sessions expose `client_reference_id` for reconciliation with internal systems. | Send organization identity as `client_reference_id` and metadata while retaining a separate opaque local attempt ID. | transport form assertions |

## Data model

`billing_checkout_attempts` is the only new persisted object in this slice. Its
owned names are descriptive multi-word `snake_case` identifiers.

- `attempt_id`: opaque local primary key.
- `organization_id`: tenant boundary; foreign key to the existing organization
  row and cascade-deleted with it.
- `price_id`: server-owned Stripe price identity used for the request.
- `idempotency_key`: unique opaque Stripe POST identity.
- `attempt_state`: `pending`, `provider_succeeded`, `provider_failed`, or
  `reconciliation_required`.
- `provider_session_id`: populated only after a validated successful provider
  response.
- `created_at_ms` / `updated_at_ms`: bounded local lifecycle timestamps.

A partial unique index on `(organization_id, price_id)` while the state is
`pending` or `reconciliation_required` prevents two unresolved retry identities
for the same tenant/price. The repository uses a savepoint around each synchronous
state mutation; if savepoint rollback cannot confirm the state, it aborts the
shared transaction and preserves the causal error, and a connection that also
cannot roll back must be discarded. Clock rollback is fail-safe: a pending
attempt whose calculated age is negative is moved to `reconciliation_required`
rather than silently replayed, and terminal writes clamp `updated_at_ms` to at
least `created_at_ms` so a provider outcome can still be recorded without
violating the timestamp constraint.

The table is installed only during database bootstrap after the referenced
organization table exists. Repository construction and request handling do not
perform DDL. This is compatible with the repository's current bootstrap pattern,
but it is **not** a substitute for the formal migration-ledger/recovery work that
must converge before billing release approval.

## Failure semantics

1. **No provider response / transport abort** — customer receives stable no-store
   `billing_provider_unavailable`; local attempt remains pending.
2. **Stripe 5xx** — customer receives the same sanitized 502; local attempt
   remains pending because provider side effects are indeterminate.
3. **Stripe known 4xx other than concurrent 409** — customer receives sanitized
   502; the local attempt becomes `provider_failed` so a later corrected Checkout
   can use a fresh key. A concurrent 409 remains pending because Stripe allows
   retrying the same idempotency key when endpoint execution did not begin.
4. **Successful HTTP response with malformed/unbounded/untrusted content** — the
   provider may already have committed the mutation, so the local attempt remains
   pending; no provider body, network address, or credential is reflected to the
   caller, and a later retry reuses the same idempotency key.
5. **Validated provider success** — persist `provider_session_id` and
   `provider_succeeded` before returning the hosted URL.
6. **Provider success but local success-state commit fails** — fail closed with
   `billing_checkout_state_unavailable`; the attempt remains pending. A later
   request can replay the same provider key and recover the cached Session rather
   than create a new one.
7. **Known provider failure but local failure-state commit fails** — fail closed
   with `billing_checkout_state_unavailable`; do not pretend the local ledger is
   authoritative.
8. **Stale or clock-ambiguous unresolved attempt** — move it to
   `reconciliation_required` and fail closed. No fresh key is issued until an
   authoritative reconciliation path resolves that held identity.

## TDD chronology

The first child commit, `02f1728f0f271b258e7b0260c5806d51e6a68e2a`, added the
durable-attempt contract while `server/billing_checkout_attempt.mjs` did not yet
exist. Subsequent implementation commits added the repository, bootstrap wiring,
provider binding, coverage registration, and real failure-boundary tests.

During primary-source reconciliation, Stripe's server-error guidance exposed a
semantic defect in the first implementation: every received non-2xx response was
being treated as a known terminal failure. Regression commit
`35571be0c0e81359dff09238f5815ed13dcf0440` changed the test contract first so a
503 must keep the attempt pending while a 400 closes it. Production commit
`fee01e7dd3055f1aedc0ef12e094536d7af05d13` then made all 5xx responses
indeterminate.

A later current-head review exposed two additional causal defects and one
defensive configuration diagnostic: malformed 2xx outcomes were being closed as
known failures, and terminal ledger writes failed the timestamp CHECK after wall-
clock rollback. Regression file `tests/unit/billing-checkout-review-regressions.test.mjs`
was registered in the real unit/coverage gates before the production fix. The
exact merge checkout for head `e8abdf9bddb609aa5504a5c680e104772408d5d3`
failed all four targeted assertions, including both SQLite CHECK violations and
the missing-price diagnostic mismatch. The production fix must obtain its own
exact-head GREEN evidence before integration; predecessor success is not reused.

## Security, privacy, and operability boundaries

The ledger stores operational identifiers, not Stripe credentials. Tenant scope
is explicit in every lookup and the unresolved uniqueness constraint. Error
payloads remain no-store and sanitized. The new local attempt ID is suitable for
audit and support correlation, but customer-facing workflows should not treat it
as an authorization credential.

This slice still does **not** provide raw-body webhook verification, durable event
deduplication, out-of-order subscription reconciliation, normalized
customer/subscription/payment/entitlement state, retention cleanup policy,
operator-visible attempt inspection/alerting/audited resolution, formal schema
migrations, restore proof, or release acceptance. In particular, webhook or
another authoritative provider reconciliation path is required to resolve Stripe
5xx and malformed-2xx cases that may have produced provider-side objects, and
`reconciliation_required` remains intentionally blocking until that follow-up
slice exists.

## Rollback

Do not drop the table as an emergency rollback step. First disable the complete
live Stripe configuration and restart so no new live attempts are created. Revert
the live-route/idempotency code only after preserving any `pending`,
`reconciliation_required`, or `provider_succeeded` rows needed for incident
reconciliation. Schema removal, if ever required, belongs in a reviewed reversible
migration with export/restore proof; deleting the ledger during an unresolved
provider incident would destroy the evidence needed to avoid duplicate Checkout
Sessions.

## References

Stripe, Inc. (n.d.). *Advanced error handling*. Stripe Documentation. Retrieved
August 16, 2026, from https://docs.stripe.com/error-low-level

Stripe, Inc. (n.d.). *Create a Checkout Session*. Stripe API Reference. Retrieved
August 16, 2026, from https://docs.stripe.com/api/checkout/sessions/create

Stripe, Inc. (n.d.). *Idempotent requests*. Stripe API Reference. Retrieved
August 16, 2026, from https://docs.stripe.com/api/idempotent_requests
