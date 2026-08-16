# Verified Stripe webhook event ledger

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This record belongs to PR #521 and is stacked on the raw-body signature boundary in PR #520. The ledger is deliberately downstream of signature verification: it records evidence only after the exact request bytes have passed the Stripe signature/timestamp boundary. It is not an entitlement authority, does not infer subscription state, and does not make out-of-order webhook delivery safe by itself.

Issue #488 remains open for the larger monotonic subscription lifecycle, authoritative provider-state reconciliation, normalized customer/subscription/payment/entitlement state, migration/recovery, retention, and release acceptance.

## Buyer and control objective

A commercial billing system needs durable evidence that answers four different questions without retaining a signed request body indefinitely:

1. Which verified Stripe event identity was first accepted?
2. Which immutable provider/object metadata arrived with that verified event?
3. Did the same event ID arrive again, and was the signed body byte-for-byte equivalent?
4. Can a replay or persistence conflict be distinguished from an entitlement transition?

The ledger addresses only that evidence boundary. Stripe documents that webhook endpoints can receive duplicate events and recommends logging processed event IDs; Stripe also warns that event delivery order is not guaranteed. The ScopeWeave implementation therefore treats duplicate receipt as an auditable delivery fact while keeping downstream reconciliation as a separate authority.

## Normalized storage model

`installStripeWebhookEventSchema(database)` creates two relations during database bootstrap, never during an individual webhook request:

### `billing_stripe_webhook_events`

One immutable fact row per verified Stripe `event_id`:

- `event_id` — bounded provider event identity and primary key;
- `provider_created_at_sec` — Stripe event creation time as a non-negative safe integer;
- `event_type` — bounded Stripe event type;
- `object_id` and `object_type` — bounded identity/type of `data.object`;
- `api_version` — optional bounded provider API-version evidence;
- `request_id` — optional bounded Stripe request identity, accepted only from a valid non-array request envelope;
- `payload_sha256` — SHA-256 of the exact signed request bytes;
- `first_received_at_ms` — trusted local receipt time.

### `billing_stripe_webhook_deliveries`

One row per accepted delivery attempt, referencing the immutable event fact:

- `delivery_id` — local surrogate identity;
- `event_id` — foreign key to `billing_stripe_webhook_events`;
- `received_at_ms` — trusted local receipt time;
- `replay_state` — `first_delivery` or `duplicate_event`;
- `processing_result` — `received` or `duplicate_ignored`.

Indexes use descriptive multiword snake_case names. The event fact and delivery history are separated so repeated deliveries do not denormalize provider metadata. The signed raw JSON body is not retained by this ledger.

## Replay and conflict semantics

`recordVerifiedEvent({ event, payloadSha256 })` normalizes and bounds the provider evidence before opening its write savepoint.

- A new event ID inserts one immutable event fact and one `first_delivery` / `received` delivery row.
- An existing event ID with the same exact-byte SHA-256 leaves the immutable event fact unchanged and appends a `duplicate_event` / `duplicate_ignored` delivery row.
- An existing event ID with a different exact-byte SHA-256 fails closed with stable `stripe_webhook_event_conflict` / HTTP 409 and records no false replay evidence.
- Malformed event ordering, object identity, API/request metadata, payload hashes, or trusted-clock values fail before persistence with stable sanitized errors.

The savepoint encloses the event/delivery mutation together. On failure, `ROLLBACK TO` restores the state at the savepoint before it is released. This composes with an outer SQLite transaction rather than pretending that `RELEASE SAVEPOINT` alone has durably committed to storage.

## Runtime integration boundary

Database bootstrap creates the repository and installs `recordVerifiedEvent` through `configureStripeWebhookEventRecorder(...)`. The webhook verifier exposes the SHA-256 derived from the exact bytes it authenticated and calls the configured recorder only after verification succeeds.

Verifier-only consumers may intentionally have no runtime recorder; this keeps pure signature tests and reusable verification code free from hidden database creation. The production application imports database bootstrap before serving the webhook route, so the runtime path has a recorder installed.

Known `StripeWebhookLedgerError` values preserve stable sanitized status/code semantics. Unexpected persistence failures collapse to the existing unavailable boundary rather than leaking SQLite/provider details.

## Security and privacy boundary

The ledger stores bounded identifiers, timestamps, type/version metadata, and an exact-byte digest. It intentionally does **not** store:

- the signed raw webhook body;
- Stripe API keys or webhook secrets;
- application session tokens;
- entitlement decisions derived from the event;
- arbitrary provider response/error text.

A SHA-256 digest is evidence of byte identity, not a confidentiality mechanism or a substitute for signature verification. Retention/export policy for these billing evidence rows remains explicit #488 follow-up work; this active PR does not claim SOC 2, CSAP, or any other certification.

## TDD and current verification evidence

The event-ledger implementation was followed by a focused review of its malformed-input and coverage boundary. Regression commit `e1a403cb4c1c3bc45902db09aca4349f07734e6d` added invalid non-null Stripe `request` envelopes and made the recorder-integration tests part of normal and c8 execution. The then-current hosted Server Tests run observed the intended failure before the production repair.

Commit `67dd5e70ec6bb273e4d9ff1967a09be0f305cb08` added the narrow `normalizedRequestId(...)` production check. The subsequent repository-native unit/API, browser, dependency, and OSV jobs completed successfully, including the new malformed-envelope and recorder-integration regressions.

Those Server Tests results are **not merge-grade exact-head evidence** under the repository's current execution contract: the job log shows `actions/checkout` fetched PR #521's synthetic merge ref and executed commit `250b24a31e5be818dfe63d036a12611f0f3723ba`, not contributor head `67dd5e70ec6bb273e4d9ff1967a09be0f305cb08`. The repository workflow checkout integrity gap must be repaired and current-head evidence re-established before any protected integration. Green synthetic-merge evidence is preserved here only as causal test information, never promoted to the exact-head merge gate.

## Acceptance trace

Executable contracts include:

- `tests/unit/stripe-webhook-event-ledger.test.mjs` — schema shape, raw-body non-retention, first delivery, exact replay, conflicting-byte rejection, and malformed provider metadata;
- `tests/unit/stripe-webhook-recorder-integration.test.mjs` — verifier-only behavior, runtime recorder installation, exact-byte evidence forwarding, and sanitized persistence failures;
- `tests/api/stripe-webhook.test.mjs` — real Hono/SQLite route behavior, signed durable receipt without entitlement mutation, concurrent duplicate convergence, and signature/body-mutation rejection;
- `tests/unit/coverage-script-contract.test.mjs` — locks the production ledger and both focused suites into the canonical c8 producer;
- `package.json` — executes the focused suites in normal unit and owned-production coverage paths.

After every head movement, predecessor runs and reviews are historical. The PR stays Draft until the unchanged exact head has applicable deterministic CI/security/dependency/coverage evidence and the live review/ruleset requirements can be satisfied.

## Rollback and recovery

Before protected integration, rollback is source-only: remove the ledger module, bootstrap recorder wiring, verifier recorder integration, tests/coverage registrations, this record, and the corresponding Unreleased changelog entry together.

After a future shipped migration creates durable ledger rows, rollback must be a reviewed database migration/recovery operation. Do not drop evidence tables merely to revert application code, and do not restore direct entitlement mutation from webhook payloads as a fallback. A database restore must preserve schema and billing evidence from one verified recovery point.

## References

SQLite Consortium. (n.d.). *Savepoints*. SQLite. https://www.sqlite.org/lang_savepoint.html

SQLite Consortium. (n.d.). *SQLite foreign key support*. SQLite. https://www.sqlite.org/foreignkeys.html

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. https://docs.stripe.com/webhooks
