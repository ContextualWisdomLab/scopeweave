# Transactional Stripe entitlement claim ledger

## Status and authority

**Status: active stacked PR evidence, not protected-`develop` shipped truth.**

This bounded #488 slice is stacked on the current authoritative Invoice projection. Protected `develop` remains shipped authority until the prerequisite billing stack is independently reviewed, protected-integrated, and revalidated on unchanged exact heads.

The slice persists deterministic policy decisions and a current claim pointer. It does **not** mutate `orgs.plan`, issue session/API capabilities, change membership/RBAC, or itself authorize product access. Application of a persisted claim to an authorization boundary remains a later separately tested slice.

## Buyer and control objective

The prior stack can now produce current tenant-scoped Subscription and Invoice evidence, while `stripe_entitlement_policy.mjs` derives a deterministic candidate from those facts. Commercial use additionally requires durable provenance and concurrency semantics: a process restart must not erase why access was granted or denied, and two concurrent reconcilers must not silently overwrite each other.

`server/stripe_entitlement_claim_ledger.mjs` therefore owns two normalized relations:

- `billing_stripe_entitlement_decisions` is append-only audit history. Each row records the evaluated current Subscription observation, optional evaluated current Invoice observation, previous decision link, deterministic action/reason, resulting claim facts, the exact claim source Subscription/Invoice observations, and bounded evaluation/recording times.
- `billing_stripe_entitlement_claim_heads` contains exactly one current decision pointer per Stripe Subscription. It is a projection pointer, not an authorization token.

Tenant identity is not duplicated in those relations because Subscription → Customer → organization already determines it. Every read and write re-scopes through that chain.

## Current-evidence authority

Callers invoke `applyCurrentDecision` with only server-owned organization/Subscription identity and an optional `expectedPreviousDecisionId` compare-and-swap token. They cannot choose a Subscription or Invoice observation ID.

Inside one SQLite savepoint, the repository:

1. selects the highest accepted Subscription observation for the exact tenant-owned Subscription;
2. selects the highest accepted Invoice observation for that Subscription's current `latest_invoice_id`, when present;
3. reconstructs the durable previous claim from the current decision head;
4. checks optimistic concurrency against `expectedPreviousDecisionId`;
5. invokes the deterministic entitlement policy with those persisted current facts;
6. independently validates the policy output and exact source provenance;
7. appends one decision; and
8. atomically advances the Subscription's current head.

This prevents stale-evidence injection through an API parameter and makes competing reconcilers observable as a stable conflict instead of last-writer-wins authorization history.

## Claim provenance and retention semantics

A resulting claim always identifies the exact Subscription observation from which the policy derived it. If the claim uses paid Invoice evidence, the decision also stores the exact Invoice observation—not merely the Invoice ID. A later `past_due` evaluation can retain a still-valid prior paid claim even when the newest Subscription observation no longer names an Invoice; in that case the new decision preserves the historical Invoice observation that originally authorized the retained window while separately recording that the current evaluation had no Invoice evidence.

This separation lets an operator answer both "what did the reconciler see now?" and "what evidence still supports the retained claim?" without rewriting old provider facts.

## Transaction and failure safety

Decision insertion and head advancement share one named SQLite savepoint. On an operation failure, ScopeWeave first attempts `ROLLBACK TO SAVEPOINT`. The savepoint is released only after rollback is confirmed. Cleanup-release failure after confirmed rollback cannot replace the causal operation error, while failed rollback leaves the savepoint open rather than risking an outermost `RELEASE` that could commit partial state.

SQLite documents that `ROLLBACK TO` restores state after a savepoint but does not remove that savepoint, while `RELEASE` of an outermost savepoint can commit. The cleanup sequence is therefore part of the data-integrity boundary.

## TDD and executable evidence

A test-only branch commit introduced `tests/unit/stripe-entitlement-claim-ledger.test.mjs` while the production module was absent, establishing a realistic RED module-resolution failure before implementation.

The focused acceptance suite exercises:

- normalized append-only schema shape with no plan/session/RBAC authority;
- automatic current Subscription and Invoice selection;
- atomic grant and retain decision chains;
- optimistic previous-decision conflicts;
- tenant isolation and unknown Subscription behavior;
- trial/no-Invoice and false-claim handling;
- malformed policy output and impossible source provenance;
- missing current Invoice evidence;
- retained historical paid-Invoice provenance;
- malformed authority, dependency seams, and clocks;
- default clock behavior; and
- rollback/release cleanup failure.

Private focused execution after implementation passed all claim-ledger subtests and produced **100% line / 100% branch / 100% function coverage** for `server/stripe_entitlement_claim_ledger.mjs`. A focused package contract locks the production module and regression into both normal unit CI and canonical c8 execution. Hosted exact-head CI/security/dependency/review evidence remains authoritative for integration.

## Bootstrap composition

`server/db.mjs` installs the claim schema only after Subscription and Invoice evidence schemas, then creates the repository with the production `deriveStripeSubscriptionEntitlement` function. Request handlers do not create billing schema. This wires deterministic policy and persistence without giving the persistence module authority to select a different policy implementation at runtime.

## Privacy and compliance posture

The ledger stores provider identifiers and minimal decision provenance needed for auditability. It stores no raw Stripe responses, webhook payloads, customer contact data, payment credentials, Stripe secrets, session tokens, arbitrary metadata, or human-readable provider error text. This supports purpose-bound audit evidence and later retention/export controls without claiming SOC 2 or other certification.

## Rollback and recovery

While this remains an active stacked PR, rollback removes the claim module, bootstrap registration, focused tests/package contract, this doctoring record, and the matching Unreleased changelog entry. No protected production migration is claimed. After protected integration, persisted decision history must be retained or exported until a separately reviewed migration/retention change exists; rollback of authorization application must not erase the evidence that produced prior access decisions.

## References

SQLite. (n.d.). *Savepoints*. https://www.sqlite.org/lang_savepoint.html

SQLite. (n.d.). *UPSERT*. https://www.sqlite.org/lang_upsert.html

Stripe. (n.d.). *The Subscription object*. Stripe API Reference. https://docs.stripe.com/api/subscriptions/object

Stripe. (n.d.). *The Invoice object*. Stripe API Reference. https://docs.stripe.com/api/invoices/object
