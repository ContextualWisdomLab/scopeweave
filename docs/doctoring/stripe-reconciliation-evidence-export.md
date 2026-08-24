# Stripe reconciliation evidence export

Status: **active PR only**. This document describes the bounded evidence-export slice on PR #582. It is not protected-`develop` shipped truth until the prerequisite #488 stack is integrated and the then-current required gates pass on the exact integrated head.

## Buyer and operator decision

Use `GET /api/orgs/:organizationId/billing/reconciliation/evidence` when a workspace owner or administrator needs a portable reconciliation record for incident review, diligence, or customer/auditor evidence. The response is an attachment-oriented JSON document and is deliberately read-only. If an Event is still `pending` or `processing`, inspect the corresponding reconciliation queue before taking a recovery action. If it is `dead_letter`, use the separately authorized recovery endpoint rather than editing evidence state.

## Authority and privacy boundary

The export derives tenant authority only through the persisted `billing_stripe_subscriptions -> billing_stripe_customers -> organization_id` relationship. The URL tenant identifier never substitutes provider or persisted tenant authority. Authentication plus owner/admin membership is required before export.

The exported document contains bounded reconciliation facts needed to understand what ScopeWeave observed and attempted: Stripe Event and Subscription identifiers, Event type and provider creation time, the stored payload SHA-256, local receipt/queue/completion timing, processing state, attempt history, recovery history, stable error codes, and entitlement claim-decision linkage when present.

The export does **not** include raw webhook payloads, Stripe credentials, active worker lease-token hashes, or plaintext operator recovery references. A recovery reference is exported only as a SHA-256 correlation value so an authorized operator who already possesses the reference can compare it without copying the free-form reference into a portable artifact. The response uses `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a JSON content type, and an attachment disposition.

Every successful disclosure is durably access-logged before response bytes are released. ScopeWeave serializes the report once, records the document's SHA-256 as `evidenceDocumentSha256` together with its schema version and Event count, and then returns those exact serialized bytes. This binds the audit event to the specific portable artifact without copying its private contents into the audit stream. If the audit write fails, disclosure fails closed instead of returning an unaudited evidence document.

These choices implement purpose-bound access and data minimization rather than indiscriminate masking. NIST Privacy Framework Control-P calls for managing data at sufficient granularity to manage privacy risk, and CT.DM-P8 specifically connects audit/log records with data minimization. The export therefore keeps decision-relevant provenance while excluding unrelated secret or free-form payload material.

## Boundedness and failure behavior

- `limit` defaults to 50 Events and cannot exceed 100.
- Event selection is tenant-scoped and bounded before nested history is loaded.
- The combined selected attempt/recovery history is capped at 1,000 rows before materialization; larger exports fail closed with HTTP-compatible `413` and `stripe_reconciliation_evidence_export_too_large`.
- Persisted identifiers, hashes, times, states, outcomes, and stable error codes are revalidated during export. Corrupt or contradictory evidence fails closed instead of being serialized as authoritative audit evidence.
- The selected Event rows and their nested attempt/recovery histories are read under one SQLite snapshot so concurrent worker progress cannot create a mixed-time artifact.
- An unknown tenant identifier produces no cross-tenant evidence. The HTTP route separately hides workspace membership with the existing not-found boundary.
- A successful response is emitted only after its audit event has been persisted; an unavailable audit sink returns `stripe_reconciliation_evidence_export_audit_failed` and no evidence document.

## Why immutable Event evidence is retained

Stripe documents that webhook deliveries can be duplicated, retried, and delivered out of order. It recommends tracking processed Event IDs to prevent duplicate processing, and its undelivered-Event guidance notes that automatic retries can continue while operators manually process events. ScopeWeave therefore exports durable Event identity, ordering/provenance timestamps, processing state, and attempt/recovery evidence rather than treating receipt order as entitlement authority. Authoritative reconciliation remains responsible for re-reading current provider state.

## Acceptance evidence

The implementation was developed test-first on the existing #488 stack. RED evidence first proved the repository module was absent and then proved the authenticated HTTP route was absent. Later realistic regressions cover recovery/attempt linkage, append-only history completeness, contradictory job/attempt lifecycle state, lease consistency, one-snapshot concurrent reads, nested-evidence bounds, audit-before-disclosure, and exact exported-document digest binding.

The repository's normal unit/API suite, browser cloud E2E, dependency review, and OSV scan have produced useful behavioral evidence on PR-associated revisions, but synthetic pull-request merge checkouts are **not** exact-head merge authorization. Exact-head Server Tests control remains owned by the repository-wide CI repair path (#523), and centrally reusable SAST/Security exact-head attestation remains on its separate organization-owned repair path. Current-head evidence must be regenerated after every contributor-head change; queued, cancelled, predecessor, synthetic-only, absent, or model-only results are non-passing.

The production export module and route are explicitly included by the canonical coverage contract, and the unit/API regressions are registered in the canonical test scripts. No release or certification claim is made by this slice.

## References

National Institute of Standards and Technology. (2020). *NIST privacy framework: A tool for improving privacy through enterprise risk management, version 1.0*. https://www.nist.gov/privacy-framework

Stripe. (n.d.). *Process undelivered webhook events*. https://docs.stripe.com/webhooks/process-undelivered-events

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. https://docs.stripe.com/webhooks
