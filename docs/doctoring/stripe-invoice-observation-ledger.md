# Authoritative Stripe Invoice observation ledger

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This #488 slice is stacked on the authoritative Invoice reader. It persists accepted Invoice evidence only after an exact authoritative Subscription observation has already identified that same Invoice. Protected `develop` remains shipped authority until the stack is independently reviewed and integrated.

## Control objective

Invoice provider reads are transient. Entitlement reconciliation needs durable payment evidence that survives process restart without turning webhook order into authority or overwriting earlier facts. The ledger therefore separates immutable provider identities from append-only observations and keeps entitlement state out of the Invoice relations.

`billing_stripe_invoices` stores one Invoice identity permanently bound to one Stripe Subscription. `billing_stripe_invoice_observations` appends each accepted authoritative read with the exact `source_subscription_observation_id` that named the Invoice, optional verified webhook-event provenance, local observation time, lifecycle status, currency, minor-unit amounts, provider creation time, and paid transition time.

Customer and organization identities are not repeated in the Invoice table because they are functionally determined through the existing normalized Subscription → Customer → organization relations. Before a write, the repository joins that accepted Subscription observation back to those relations and requires exact organization, Customer, Subscription, and `latest_invoice_id` equality with the normalized Invoice snapshot.

## Transaction and failure boundary

Invoice identity creation and the corresponding observation append share one SQLite savepoint. On failure, ScopeWeave first attempts `ROLLBACK TO SAVEPOINT`; it releases the savepoint only after rollback is confirmed. Cleanup-release failure after a confirmed rollback cannot replace the causal operation error, while an unconfirmed rollback leaves the failed savepoint open instead of risking an accidental commit.

This follows SQLite's documented savepoint semantics: `ROLLBACK TO` restores state after the named savepoint but leaves that savepoint active, while releasing the outermost savepoint can commit the transaction. The fail-closed cleanup order is therefore part of the data-integrity contract, not incidental error handling.

## Validation and tenant isolation

The ledger independently revalidates the bounded Invoice snapshot even though the provider reader already validated it. It rejects malformed identifiers, ambiguous organization authority, unknown lifecycle states, contradictory `paid`/status/`paidAtSec` combinations, malformed currency, unsafe amounts/timestamps, unknown source observations/events, tenant/Customer/Subscription/Invoice mismatches, and attempts to rebind an existing Invoice to another Subscription.

Repeated provider reads append new observations. If the local wall clock moves backwards, `observed_at_ms` never decreases for the same Invoice. That local ordering is audit evidence only; it does not rewrite Stripe's provider timestamps and does not itself authorize access.

No raw Invoice JSON, customer contact fields, payment credentials, Stripe secrets, arbitrary metadata, entitlement claim, or `orgs.plan` value is stored by this slice.

## TDD and executable evidence

Test-only commit on the child branch registered `tests/unit/stripe-invoice-observation-ledger.test.mjs` while `server/stripe_invoice_observation_ledger.mjs` did not exist, establishing a realistic RED module-resolution failure before production implementation.

The completed focused suite covers normalized schema shape, exact Subscription-observation provenance, optional verified-event provenance, repeated appends, monotonic local observation time, tenant and identity conflicts, unknown provenance, malformed provider facts, dependency/clock contracts, cross-Subscription rebinding, and rollback/release cleanup failure. Private focused execution produced 100% line, branch, and function coverage for the production ledger module.

## Rollback and recovery

Rollback removes the Invoice observation module, bootstrap registration, focused test/coverage registration, this doctoring record, and the matching Unreleased changelog entry together. Because this remains an active stacked slice, no protected production migration is claimed. Once the schema is protected-shipped, rollback must preserve existing evidence tables until a separately reviewed migration/export/retention decision is available.

## References

SQLite. (n.d.). *Savepoints*. https://www.sqlite.org/lang_savepoint.html

Stripe. (n.d.). *The Invoice object*. Stripe API Reference. https://docs.stripe.com/api/invoices/object

Stripe. (n.d.). *Retrieve an invoice*. Stripe API Reference. https://docs.stripe.com/api/invoices/retrieve
