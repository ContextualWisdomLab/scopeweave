# Authoritative Stripe billing reconciliation

Status: **active stacked PR evidence; not protected-`develop` shipped truth**.

## Buyer problem

A verified webhook delivery proves that Stripe sent particular bytes, but it does not prove that the embedded Subscription or Invoice snapshot is still current when ScopeWeave processes the delivery. Stripe explicitly documents that webhook events are not guaranteed to arrive in generation order and recommends retrieving missing/current objects through the API when ordering differs. ScopeWeave therefore needs one service boundary that treats delivery identity as provenance and re-reads current provider authority before changing durable entitlement evidence.

## Decision

`server/stripe_billing_reconciliation.mjs` composes the already-separated provider and persistence boundaries without granting either the webhook payload or caller-selected evidence IDs new authority.

For one tenant-owned Subscription the service performs this bounded sequence:

1. validate the local organization/Subscription authority and all required ports before provider I/O;
2. retrieve the current Subscription through the authoritative bounded provider reader;
3. append the accepted Subscription observation, optionally linked to a previously verified webhook event only as provenance;
4. when that Subscription names a latest Invoice, retrieve the current Invoice using the exact organization, Customer, Subscription, and Invoice identities from accepted provider authority;
5. append the Invoice observation against the just-recorded Subscription observation; and
6. ask the durable claim repository to evaluate its own latest accepted evidence.

The service returns only organization/Subscription identity and the resulting Subscription-observation, optional Invoice-observation, and claim-decision identifiers. It never returns the Stripe secret, raw provider response, webhook body, idempotency key, or other retry authority.

## Ordering and convergence contract

Webhook event IDs never choose which Subscription/Invoice state wins. Every invocation reads the current provider objects. An older event delivered after a newer event therefore causes another current-state read rather than overwriting entitlement from its historical payload.

Concurrent reconciliation can legitimately race at the optimistic claim-head compare-and-swap boundary. The service handles exactly one such race by refreshing the durable current decision ID and retrying **only claim application**. It does not repeat the provider GETs or append another pair of provider observations during that retry. A second conflict is propagated for bounded job/operator retry instead of entering an unbounded loop.

This composition complements, rather than replaces, Stripe request idempotency. Stripe documents idempotency keys as protection for safely retrying create/update API operations; this service performs authoritative GETs and local append/evaluate work, while the existing Checkout-attempt boundary remains the owner of Stripe POST retry identity.

## Failure and authority boundaries

- malformed local organization, Subscription, event provenance, or dependency ports fail before provider I/O;
- a provider seam that returns tenant/Subscription/Customer/Invoice identity inconsistent with the requested authority fails closed before local persistence;
- provider errors remain the sanitized errors owned by the Subscription/Invoice provider modules;
- persistence and policy errors remain causal and are not translated into false success;
- only `stripe_entitlement_claim_conflict` receives the single bounded retry described above;
- no `orgs.plan`, session, membership, RBAC, capability, or browser-selected evidence state is mutated here.

The service is intentionally not yet a webhook background queue or public/operator HTTP endpoint. A later slice must decide invocation/queue ownership, retry scheduling, dead-letter/operator recovery, and audit exposure without making the webhook request lifetime depend on remote provider latency.

## Verification traceability

`tests/unit/stripe-billing-authoritative-reconciliation.test.mjs` exercises:

- current Subscription → durable Subscription evidence → current Invoice → durable Invoice evidence → claim-decision ordering;
- newer-then-older event provenance while each trigger re-reads current provider state;
- Subscription snapshots without a latest Invoice;
- one optimistic claim-head race with claim-only retry;
- a second conflict remaining bounded;
- non-conflict causal-error preservation; and
- malformed local authority/ports failing before provider I/O.

The module and focused regression are explicitly registered in `test:unit`, `test:coverage:cases`, and the c8 owned-production include set. Hosted exact-head evidence remains authoritative for integration.

## Rollback

Before this stacked slice is integrated, rollback is branch deletion. After integration, rollback removes the reconciliation service, focused tests, coverage registrations, doctoring record, and matching Unreleased changelog entry together. The service introduces no schema migration, so rollback does not require destructive data surgery; observations written by callers remain valid append-only provider evidence owned by their existing schemas.

## References

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. Retrieved August 20, 2026, from https://docs.stripe.com/webhooks

Stripe. (n.d.). *Using webhooks with subscriptions*. Stripe Documentation. Retrieved August 20, 2026, from https://docs.stripe.com/billing/subscriptions/webhooks

Stripe. (n.d.). *Idempotent requests*. Stripe API Reference. Retrieved August 20, 2026, from https://docs.stripe.com/api/idempotent_requests
