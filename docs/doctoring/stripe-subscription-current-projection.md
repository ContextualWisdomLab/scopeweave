# Current authoritative Stripe subscription projection

## Status and scope

This record describes **active PR work** stacked on the authoritative Stripe subscription observation ledger. It is not protected-`develop` shipped truth and it does not grant, revoke, or otherwise infer ScopeWeave entitlements.

The slice adds a read-only SQLite projection that selects the latest accepted authoritative observation for one tenant-owned Stripe Subscription, or one latest observation per tenant-owned Subscription. It preserves ordered Price membership and source-event provenance, returns immutable values, and leaves `orgs.plan` and all other entitlement state unchanged.

## Decision boundary

Webhook delivery order is not used as current-state authority. Stripe subscription activity is asynchronous and webhook events are notifications that must be handled as such; the preceding stack independently retrieves tenant-verified authoritative Subscription state and appends accepted observations. This projection operates only over those accepted observations.

Within the append-only observation ledger, `observation_id` is the explicit local append-order key. `getCurrentSubscription()` selects the greatest observation identifier for the requested Subscription. `listCurrentSubscriptions()` selects the greatest observation identifier per Subscription, then applies the owning-organization filter through the immutable Customer→Subscription binding. Result ordering is explicit by Subscription identifier; SQLite does not guarantee multi-row result order without `ORDER BY`.

## Tenant and input authority

Organization authority is local server state, not Stripe metadata or browser claims. The projection accepts positive safe-integer organization identifiers and canonical positive decimal string representations such as `"42"`. Ambiguous numeric spellings such as leading/trailing whitespace, signs, hexadecimal, exponent notation, and leading zeroes fail closed before a query. Subscription identifiers must remain bounded provider identifiers.

The projection joins observations through `billing_stripe_subscriptions` and `billing_stripe_customers` and filters by the requested local organization. Cross-tenant lookup returns the same absent result as an unknown Subscription and never reveals another tenant's provider facts.

## Evidence and coverage

The realistic regression suite covers:

- newest-observation selection when multiple accepted reads share the same wall-clock observation time;
- ordered Price membership;
- non-null trial expiry and verified source-event provenance;
- cross-tenant non-disclosure;
- one-current-row-per-Subscription list behavior and stable result ordering;
- immutable outputs and no mutation of authoritative evidence or `orgs.plan`;
- empty/absent behavior; and
- malformed and ambiguous local authority values.

The module and its focused behavior suite are registered in both normal unit CI and the canonical `c8` owned-production coverage producer. The coverage-script contract explicitly locks those registrations so a future manifest edit cannot silently remove projection coverage.

The initial behavior-only commit preceded the production module. A later authority-hardening test commit preceded its canonical-string implementation, but its hosted jobs were cancelled by subsequent branch movement before execution. Commit order therefore records the TDD sequence; cancelled predecessor runs are not represented as hosted RED evidence. Only terminal evidence on the unchanged current head is merge-relevant.

## Security, privacy, and entitlement separation

This module contains no Stripe secret, webhook raw body, session credential, or provider transport. It returns only normalized Subscription facts already accepted by the parent persistence boundary. An `active`, `trialing`, or other Stripe status remains provider evidence; it is not itself a ScopeWeave authorization or entitlement decision. A later monotonic policy layer must make any local entitlement transition transactionally, idempotently, and audibly.

No mutable webhook arrival timestamp, browser-supplied organization, or Stripe event ordering is allowed to select the current observation. The projection is deliberately read-only and has no SQL mutation statement.

## Rollback and recovery

Before protected integration, rollback removes `server/stripe_subscription_current_projection.mjs`, its focused tests, coverage registrations, this doctoring record, and the matching Unreleased changelog entry together. No schema or customer data migration is required because the slice creates no database object and mutates no persisted state.

After integration, rollback of this read capability must not delete the append-only authoritative observations owned by the preceding ledger. Reintroducing webhook-arrival ordering or direct entitlement mutation is not an acceptable rollback path.

## Dependency and merge boundary

This PR must remain stacked on the exact authoritative-observation parent and the preceding #488 Stripe trust chain. Final integration also requires the repository's exact-contributor-head workflow control to be protected-shipped or equivalently reconciled, followed by fresh exact-head CI, browser, owned coverage, security, dependency, supply-chain, package/provenance, resolved-review, and independent-approval evidence under the live protected rules.

## References

SQLite Consortium. (2026). *SELECT*. SQLite documentation. https://www.sqlite.org/lang_select.html

Stripe. (2026). *Using webhooks with subscriptions*. Stripe documentation. https://docs.stripe.com/billing/subscriptions/webhooks

Stripe. (2026). *Receive Stripe events in your webhook endpoint*. Stripe documentation. https://docs.stripe.com/webhooks
