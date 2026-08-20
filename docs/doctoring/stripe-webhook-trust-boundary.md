# Stripe webhook trust boundary

## Status

**Active PR only — not protected-`develop` shipped truth.** This note describes the bounded implementation on PR #520, stacked on PR #516 for issue #488. The protected `develop` branch does not contain this behavior until the stack is independently reviewed and merged through live repository protection.

## Buyer-visible risk closed by this slice

A billing webhook is an unauthenticated Internet ingress unless the application proves that the exact bytes were signed by the payment provider. Before this slice, `/api/stripe/webhook` parsed arbitrary JSON and could promote an organization to Pro from caller-controlled fields. That made entitlement state writable by an untrusted request.

PR #520 changes the boundary so a webhook is acknowledged only after verification of the exact raw request bytes. It also removes direct entitlement mutation from the webhook handler. A cryptographically valid delivery therefore proves delivery authenticity, but it does **not** by itself grant billing authority. Durable event deduplication, authoritative provider-state reconciliation, and out-of-order lifecycle handling remain separate follow-on work under #488.

## Normative evidence and design decisions

Stripe's webhook documentation requires signature verification against the raw, unmodified request body and warns that JSON parsing, whitespace changes, key reordering, or encoding changes invalidate verification. Stripe also documents a five-minute default timestamp tolerance to mitigate replay and recommends quickly returning a `2xx` response before complex processing. These requirements drive the implementation rather than model judgment.

The ScopeWeave verifier therefore:

- reads and signs the exact raw request bytes before JSON parsing;
- bounds both declared and streamed body size at 256 KiB and bounds the signature header at 4 KiB;
- requires one valid signed timestamp plus at least one SHA-256 `v1` signature;
- computes HMAC-SHA-256 over `timestamp + "." + raw_body` and compares candidate digests in constant time;
- applies a symmetric 300-second recency window using an injected clock in tests;
- rejects invalid UTF-8, malformed JSON, and missing or oversized event identity before acknowledging the delivery;
- maps expected verifier failures to sanitized stable error codes and returns `Cache-Control: no-store`;
- acknowledges a valid event without directly changing plan entitlements.

The body/header limits are ScopeWeave defense-in-depth limits, not claims about Stripe protocol maxima. They bound memory and parser work at an Internet-facing trust boundary.

## TDD and acceptance trace

The implementation is covered by two realistic regression layers:

1. `tests/unit/stripe-webhook-boundary.test.mjs` exercises exact-byte signatures, payload mutation, multiple `v1` signatures, stale/future timestamps, malformed headers, oversized declared and streamed bodies, invalid UTF-8/JSON, configuration errors, and event-identity bounds.
2. `tests/api/stripe-webhook.test.mjs` exercises the real Hono route and database state. It proves unsigned, stale, and mutated deliveries cannot upgrade an organization; a correctly signed delivery is acknowledged; and even a valid `checkout.session.completed` delivery cannot directly mutate the entitlement.

`package.json` registers both the API regression and the webhook module/unit suite in the canonical c8 coverage path. `tests/unit/coverage-script-contract.test.mjs` fails if that instrumentation or regression registration is later removed.

Hosted CI on the implementation head must be treated as head-specific evidence. A predecessor run is never sufficient after any subsequent source, test, or documentation commit.

## Authority boundary still open

This slice intentionally stops before durable billing lifecycle processing. The next billing authority layer must, at minimum, persist provider event identity for idempotent processing, tolerate duplicate and out-of-order delivery, reconcile against authoritative Stripe state before releasing held Checkout attempts, and produce auditable tenant-scoped evidence. PR #516 provides the adjacent reconciliation persistence boundary but remains a separate stacked dependency.

No ScopeWeave document should describe webhook-driven Pro activation as shipped until those authority layers and the protected-stack merge are complete.

## References (APA 7th)

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. Retrieved August 16, 2026, from https://docs.stripe.com/webhooks

Stripe. (n.d.). *Resolve webhook signature verification errors*. Stripe Documentation. Retrieved August 16, 2026, from https://docs.stripe.com/webhooks/signature
