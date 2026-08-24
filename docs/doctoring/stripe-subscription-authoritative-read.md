# Authoritative Stripe subscription read boundary

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This record belongs to PR #525 and is stacked on PR #521's verified webhook evidence ledger. The protected `develop` branch remains the shipped authority until the whole stack is independently reviewed, protected-integrated, and revalidated against its final exact heads.

Issue #488 remains open for durable subscription-state reconciliation, monotonic lifecycle/application policy, normalized entitlement persistence, operator recovery, retention/export controls, and release acceptance. This slice deliberately provides only the provider-read trust boundary needed by those later steps.

## Buyer and control objective

Stripe does not guarantee webhook event delivery order. A signed webhook event therefore proves authenticity of one delivery but cannot, by itself, prove that its subscription snapshot is the latest state. ScopeWeave needs a distinct read boundary that can retrieve the current provider resource before durable lifecycle or entitlement mutation.

The boundary implemented by `server/stripe_subscription_provider.mjs` has four acquisition-grade responsibilities:

1. make exactly one bounded HTTPS GET for a known Stripe Subscription ID;
2. reject malformed, contradictory, oversized, or non-JSON successful responses before they can become reconciliation evidence;
3. bind the returned Subscription to the expected ScopeWeave organization using exact `metadata.orgId` equality;
4. return immutable normalized provider facts while making no local entitlement decision and performing no persistence mutation.

## Checkout-to-subscription tenant binding

ScopeWeave creates Stripe Checkout Sessions in `subscription` mode. Checkout Session metadata and Subscription metadata are separate provider objects. To make a later authoritative Subscription read tenant-verifiable, the live checkout request now sends the organization binding in both locations:

- `metadata[orgId]` on the Checkout Session; and
- `subscription_data[metadata][orgId]` on the Subscription created by Checkout.

Both the injected SDK-compatible seam and the direct `application/x-www-form-urlencoded` HTTPS transport have executable assertions for this behavior. The authoritative reader accepts the provider object only when its own Subscription metadata contains a string `orgId` that exactly equals the expected positive ScopeWeave organization ID. Missing metadata, alternate textual representations, wrong tenants, and non-string values fail closed.

Metadata is treated only as a tenant-binding claim carried by the provider object. It does not grant a plan or entitlement by itself.

## Bounded provider-read contract

`fetchStripeSubscriptionAuthoritative(...)` validates local authority before transport and then performs one direct GET to the Subscription API.

Local authority validation requires:

- a positive safe-integer organization ID;
- a bounded Stripe `sub_...` subscription identifier;
- a non-empty bounded server-owned Stripe secret;
- callable transport and timeout seams;
- an actual `AbortSignal` from the timeout seam.

The provider call uses a hard-coded HTTPS Stripe API authority, `GET`, redirect rejection, and a 15-second request budget. Successful responses must be `application/json` and are capped at 256 KiB by both declared `Content-Length` and incremental stream accounting before JSON parsing. Invalid UTF-8, invalid JSON, malformed stream reads, oversized bodies, and contradictory provider values collapse to a stable sanitized provider-response error.

Non-success provider response bodies are cancelled without parsing. HTTP 404 remains distinguishable from transient/unavailable provider failures so a later reconciliation layer can decide whether absence is meaningful without exposing provider response text.

## Normalized immutable provider facts

The returned snapshot is frozen and contains only bounded reconciliation facts:

- subscription ID and customer ID;
- ScopeWeave organization ID verified against Subscription metadata;
- Stripe subscription status as provider data;
- cancel-at-period-end flag;
- current period start/end timestamps;
- nullable canceled, ended, and trial-end timestamps;
- nullable latest-invoice ID;
- one to 100 price IDs from subscription items.

The current Stripe status vocabulary accepted by this boundary is `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, and `paused`. These values are deliberately preserved as external provider state rather than collapsed into a local `active/inactive` entitlement decision.

The snapshot rejects impossible period ordering, unsafe timestamps, expanded objects where an identifier is expected, unknown statuses, missing items, unbounded item collections, and invalid identifiers. A later policy layer must explicitly translate a valid provider snapshot into durable ScopeWeave lifecycle and entitlement transitions.

## Security and privacy boundary

This slice minimizes provider material retained in memory and does not persist the Stripe response. It intentionally does **not** expose or retain:

- Stripe secret keys;
- arbitrary Stripe error bodies or network diagnostics;
- raw webhook payloads;
- customer PII beyond the bounded provider identifiers needed for reconciliation;
- local session/authentication material;
- any inferred entitlement decision.

`StripeSubscriptionProviderError` carries a stable ScopeWeave code only. Tenant mismatch is explicit but does not echo the expected or received tenant identity. Unexpected network, timeout-factory, or provider transport failures are sanitized as unavailable-provider evidence.

The design supports purpose-bound authorization and tenant isolation without blanket PII masking: the expected local organization authority must already be known by the caller, and the provider object must independently assert the same tenant before it can progress to reconciliation.

## API-version contract boundary

Stripe documents that direct API requests use the account's default API version unless a request explicitly supplies `Stripe-Version`. ScopeWeave's current direct REST adapters do not yet pin or operator-configure that header. This PR therefore does **not** claim that provider response schemas are version-invariant across Stripe account upgrades.

That is a deliberate follow-up boundary, not something to silently fix by hard-coding today's newest Stripe version into an in-flight billing stack. A safe versioning slice must define the supported provider version, compatibility tests/migration path, rollback behavior, and operator upgrade procedure before enforcing a header. Until then, this reader remains fail-closed when an account-version response falls outside its validated contract.

## TDD and causal verification trace

The authoritative-read contract began as a RED test importing an absent production module. Once the narrow production implementation and Subscription metadata propagation were added, hosted validation exposed two independent integration defects that were corrected without weakening any gate.

### Coverage-contract failure

On contributor head `c5838867c13d43ffbb21ca6d05866491666aa954`, hosted `unit-and-api` failed because the canonical c8 producer did not instrument `server/stripe_subscription_provider.mjs` or execute the new focused provider tests. Commit `38c7b232b17d5b766f62c5cb14e6fe3a6eb45fa5` repaired the coverage contract by adding the provider module to `--include` and both new billing tests to the canonical coverage cases.

### Subscription-metadata regression

The next hosted run reached the wider unit suite and failed `tests/unit/billing-checkout.test.mjs`: production correctly propagated `subscription_data.metadata.orgId`, while the inherited expected SDK payload still described the older Checkout-only metadata shape. Commit `344955437d81340a5b1f997d45912f866efa37e2` updated both SDK-style and direct-form assertions to require Subscription tenant metadata. On that exact contributor revision, repository-native `unit-and-api`, dependency review, OSV paths, and cloud E2E completed successfully.

Those hosted runs are causal test evidence, not final merge-grade exact-head evidence under the repository's current evidence policy. This stack still inherits the older default pull-request checkout behavior, which can execute GitHub's synthetic merge ref. PR #523 separately repairs repository-owned workflows to attest the immutable contributor SHA. After that control is protected-shipped, this stack must be reconciled to the live base and all applicable deterministic evidence rerun on the exact contributor heads.

## Acceptance trace

Executable contracts include:

- `tests/unit/stripe-subscription-provider.test.mjs` — exact bounded GET, immutable normalization, full current status vocabulary, tenant mismatch, malformed snapshots, sanitized provider failure, body bounds, and local-authority validation;
- `tests/unit/stripe-subscription-metadata-propagation.test.mjs` — Subscription metadata propagation through both SDK-compatible and direct REST Checkout transports;
- `tests/unit/billing-checkout.test.mjs` — wider Checkout regression proving the same tenant metadata contract remains part of normal live checkout behavior;
- `tests/unit/coverage-script-contract.test.mjs` — requires the authoritative provider module and focused tests to remain in the canonical owned-production coverage producer;
- `package.json` — includes the provider module in c8 owned-production instrumentation and both focused suites in normal/coverage execution.

Any head, parent, or protected-base movement invalidates the head-specific evidence above until freshly reconciled.

## Rollback and recovery

Before protected integration, rollback is source-only: remove the provider reader, Subscription metadata propagation, focused tests, coverage registration, this doctoring record, and its active-PR changelog entry together. Do not retain a reader whose tenant-binding precondition is no longer produced by Checkout.

After future lifecycle persistence is protected-shipped, rollback must preserve durable billing evidence and must not restore webhook-order assumptions or grant entitlements directly from a signed event payload. Recovery must re-fetch authoritative provider state and replay policy from one explicitly verified local/provider point.

## References

Stripe. (n.d.). *Create a Checkout Session*. Stripe API Reference. https://docs.stripe.com/api/checkout/sessions/create

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe Documentation. https://docs.stripe.com/webhooks

Stripe. (n.d.). *The Subscription object*. Stripe API Reference. https://docs.stripe.com/api/subscriptions/object

Stripe. (n.d.). *Versioning*. Stripe API Reference. https://docs.stripe.com/api/versioning
