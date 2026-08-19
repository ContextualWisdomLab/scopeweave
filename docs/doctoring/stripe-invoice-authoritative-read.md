# Authoritative Stripe Invoice read boundary

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This record belongs to the bounded #488 Invoice-read slice stacked on the current Stripe entitlement-policy branch. Protected `develop` remains the shipped authority until the entire prerequisite stack is independently reviewed, protected-integrated, and revalidated on its final exact heads.

The slice adds payment evidence only. It does not persist Invoice observations, mutate an organization plan, write entitlement claims, grant session/API capability, or make an Invoice webhook authoritative by arrival order.

## Buyer and control objective

The entitlement policy already requires authoritative paid-Invoice evidence before an `active` Stripe Subscription can grant or extend paid access. A webhook payload is insufficient for that decision because delivery can be delayed, duplicated, or reordered. ScopeWeave therefore needs a separate provider-read boundary that retrieves the exact Invoice named by the current authoritative Subscription and verifies its tenant-bound identities before the Invoice can become policy evidence.

`server/stripe_invoice_provider.mjs` owns that boundary. It requires server-owned organization, Invoice, Subscription, and Customer authority and performs exactly one bounded `GET /v1/invoices/{invoice}` against Stripe's fixed HTTPS API origin.

## Provider contract

The reader:

- accepts only a positive safe-integer ScopeWeave organization ID and bounded `in_...`, `sub_...`, and `cus_...` provider identities;
- uses one hard-coded `https://api.stripe.com/v1/invoices/` GET, `redirect: "error"`, a 15-second abort budget, and no application retry loop;
- sends the server-owned Stripe secret only to that fixed authority;
- requires a successful JSON response and enforces a 256 KiB ceiling from both `Content-Length` and streamed bytes before JSON parsing;
- decodes UTF-8 fatally and maps malformed transport/provider data to stable sanitized application errors;
- distinguishes a provider 404 from transient/unavailable provider failure without exposing response bodies or network diagnostics;
- verifies exact Invoice ID, Customer ID, and Subscription ID before returning evidence; and
- returns an immutable normalized payment fact containing only bounded lifecycle, amount, currency, and timestamp fields needed by the later policy/persistence layers.

No response field can choose another ScopeWeave tenant. Subscription metadata is supplementary mismatch evidence only; exact server-owned Customer and Subscription identities remain mandatory.

## Stripe API-version compatibility boundary

ScopeWeave's current direct Stripe REST adapters intentionally inherit the Stripe account's configured default API version rather than silently pinning a new provider version inside one feature slice. That makes Invoice provenance shape an explicit compatibility concern.

Stripe's `2025-03-31.basil` breaking change introduced `invoice.parent` and moved Subscription provenance from the deprecated top-level `invoice.subscription` / `invoice.subscription_details` fields to `invoice.parent.subscription_details.subscription`, after verifying `invoice.parent.type === "subscription_details"`. The reader therefore accepts both generations:

- current Basil-style `parent.subscription_details.subscription`; and
- legacy pre-Basil top-level `subscription` plus optional `subscription_details.metadata`.

If both shapes are present, they must identify the same Subscription. A non-Subscription parent, malformed parent/details object, missing Subscription identity, or disagreement between old and new shapes fails closed. A future provider representation outside these validated contracts also fails closed. Explicit `Stripe-Version` migration remains a separately tested operator compatibility change with rollback evidence rather than an implicit behavior change here.

## Invoice lifecycle evidence

Stripe documents Invoice statuses `draft`, `open`, `paid`, `uncollectible`, and `void`, with payment moving an Invoice to `paid`. The reader accepts only those states and requires the provider `paid` boolean to agree with `status === "paid"`. It also requires `status_transitions.paid_at` exactly when the Invoice is paid. This catches contradictory provider representations before they reach entitlement policy.

Currency must be a three-letter lowercase code. `amount_due`, `amount_paid`, `amount_remaining`, `created`, and any `paid_at` timestamp must be non-negative safe integers. This slice preserves the provider amounts as evidence and does not infer tax, revenue recognition, refund, chargeback, or accounting policy from them.

## TDD and executable evidence

Test-only commit `a83b002210c2448f7cdfaaab94b506ab1c581473` registered `tests/unit/stripe-invoice-provider.test.mjs` before the production module existed, so the new contract initially failed at module resolution rather than obtaining a false green.

The completed focused regression set exercises:

- one exact HTTPS GET and bounded dependency seams;
- current Basil and legacy pre-Basil Subscription provenance;
- conflicting dual-shape provenance;
- exact Customer, Subscription, and optional tenant-metadata mismatch rejection;
- lifecycle/status/paid/paid-at contradictions;
- malformed identifiers, currency, amounts, timestamps, media type, JSON, and provider envelopes;
- 404, transient failure, stream-read failure, declared oversize, streamed oversize, and cancellation failure; and
- sanitized errors that never echo provider bodies, credentials, or network diagnostics.

Private focused execution after implementation produced 100% line, branch, and function coverage for `server/stripe_invoice_provider.mjs`. Hosted repository-native CI, security, dependency, supply-chain, and review evidence remains authoritative for PR integration and must be regenerated on the unchanged final contributor head.

## Privacy, rollback, and recovery

The boundary returns no customer email, postal address, hosted Invoice URL, payment method, secret, raw response, or arbitrary metadata. The expected tenant IDs are already server-owned routing authority; optional `orgId` metadata is used only to detect contradiction.

Rollback removes the Invoice reader, its focused tests/coverage registration, this doctoring record, and the matching Unreleased changelog entry together. It does not require a database migration because this slice introduces no persisted Invoice relation or entitlement mutation. A provider-read failure therefore leaves all existing entitlement state untouched and available for later operator reconciliation.

## References

Stripe. (n.d.). *Retrieve an invoice*. Stripe API Reference. https://docs.stripe.com/api/invoices/retrieve

Stripe. (n.d.). *The Invoice object*. Stripe API Reference. https://docs.stripe.com/api/invoices/object

Stripe. (2025, March 31). *Invoicing resources now specify how they were generated*. Stripe Documentation. https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

Stripe. (n.d.). *Status transitions and finalization*. Stripe Documentation. https://docs.stripe.com/invoicing/integration/workflow-transitions
