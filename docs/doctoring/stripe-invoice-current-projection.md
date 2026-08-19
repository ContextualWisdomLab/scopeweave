# Current authoritative Stripe Invoice projection

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This #488 slice is stacked on the authoritative Invoice observation ledger. It exposes current accepted Invoice evidence to later entitlement reconciliation without treating webhook delivery order, provider wall-clock fields, or one payment status as local authorization authority. Protected `develop` remains the shipped truth until the prerequisite stack is independently reviewed and integrated.

## Decision boundary

`server/stripe_invoice_current_projection.mjs` is read-only. It selects current Invoice state by the highest append-only local `observation_id`, because that identity records the order in which ScopeWeave accepted authoritative provider reads. It does not choose by webhook receipt, provider creation time, paid transition time, or `observed_at_ms`; those values remain evidence, not sequencing authority.

Each read is tenant-scoped through Invoice → Subscription → Customer → organization. The caller must provide a canonical positive organization ID. String tenant IDs are accepted only in canonical positive decimal form, rejecting leading zeroes, plus signs, exponent notation, whitespace, and other JavaScript-coercible spellings. Invoice and optional Subscription filters must be bounded provider identifiers.

## Projection contract

`getCurrentInvoice` returns one immutable latest accepted observation for an exact tenant-owned Invoice or `null` when the Invoice is absent or belongs to another organization.

`listCurrentInvoices` returns one immutable latest observation per Invoice owned by the organization, ordered by Invoice identity. An optional Subscription filter narrows the result without weakening tenant isolation.

Each result preserves the accepted evidence needed by the entitlement-policy layer: local observation identity/time, organization/Customer/Subscription/Invoice identity, exact source Subscription observation, optional verified webhook-event provenance, Invoice lifecycle state, paid flag, currency, minor-unit amounts, provider creation time, and paid transition time. No raw provider JSON, secrets, customer contact data, entitlement claim, or `orgs.plan` mutation is introduced.

## TDD and acceptance evidence

A test-only commit introduces `tests/unit/stripe-invoice-current-projection.test.mjs` before the production module exists, establishing RED module-resolution evidence. The focused acceptance suite proves append-order selection even when `observed_at_ms` and provider timestamps move in the opposite direction, tenant isolation, one-current-row-per-Invoice listing, Subscription filtering, immutable outputs, unpaid/null-paid-time behavior, canonical authority validation, and fail-closed dependency contracts.

Private focused execution after the production implementation produced 100% line, branch, and function coverage for both the projection module and its focused suite. Hosted exact-head CI, browser, security, dependency, and independent review evidence remains authoritative for integration.

## Rollback

Rollback removes the read-only projection, focused test/coverage registration, this doctoring record, and the matching active Unreleased changelog entry. No schema migration or entitlement mutation is introduced by this slice.

## References

SQLite. (n.d.). *SELECT*. https://www.sqlite.org/lang_select.html

Stripe. (n.d.). *The Invoice object*. Stripe API Reference. https://docs.stripe.com/api/invoices/object
