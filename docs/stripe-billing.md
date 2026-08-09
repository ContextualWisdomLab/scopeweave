# Stripe Billing Production Contract

ScopeWeave uses Stripe-hosted Checkout for subscription initiation and a
signed webhook boundary for server-authoritative entitlement changes.

## Required environment

```text
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Production startup and Checkout requests fail closed when the secret key and
Price configuration are absent or incomplete. `SCOPEWEAVE_DEV=1` is the only
boundary that permits a mock Checkout URL; it must never be set in staging or
production.

Configure the Stripe webhook destination as:

```text
POST https://<scopeweave-origin>/api/stripe/webhook
```

Subscribe to the following event types:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The handler verifies the `Stripe-Signature` against the exact raw request body,
rejects stale or malformed signatures, caps the body at 1 MiB, applies
organization plan changes transactionally, and deduplicates provider retries by
Stripe event ID. It does not log credentials, signature material, or raw event
payloads.

Checkout requests attach the ScopeWeave organization ID to both Checkout
Session metadata and Subscription metadata. Unknown or missing organizations
fail closed; client-provided plan state is never trusted.

## Operational verification

Before enabling live traffic:

1. create a real Stripe test-mode Product and recurring Price;
2. configure all three secrets in the deployment secret store;
3. create a Checkout Session through an owner account;
4. complete test-mode payment and confirm the signed webhook changes only the
   referenced organization to `pro`;
5. replay the exact event and confirm it is reported as a duplicate without a
   second entitlement mutation;
6. alter one request byte and confirm signature verification rejects it;
7. send `customer.subscription.deleted` and confirm the organization returns to
   `free`;
8. rotate the webhook endpoint secret and update deployment configuration
   atomically.

## Standards and primary documentation — APA 7th

Stripe. (2026). *The Checkout Sessions API*. Stripe Documentation.
https://docs.stripe.com/payments/checkout

Stripe. (2026). *Receive Stripe events in your webhook endpoint*. Stripe
Documentation. https://docs.stripe.com/webhooks

Stripe. (2026). *Idempotent requests*. Stripe Documentation.
https://docs.stripe.com/api/idempotent_requests
