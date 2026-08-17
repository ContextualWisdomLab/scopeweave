# Schedule reason-event authorization and audit boundary

## Status and scope

This document records **active stacked work**, not protected-`develop` shipped truth. The branch `feat/schedule-reason-authorization-287` is stacked on PR #517 (`feat/schedule-outcome-domain-287`) and implements one bounded security/operability slice of issue #287. Protected `develop` does not contain this capability until its prerequisite stack is independently reviewed, reconciled, integrated, and verified.

The slice adds a framework-neutral application-domain boundary for explicit `skipped`, `cancelled`, and `not_performed` schedule reasons. It does not add a browser route, Hono route, database table, migration, role model, approval UI, notification flow, or reporting metric. Those adapters remain separate work. The new boundary exists so later adapters cannot treat a client-supplied actor, tenant, approval reference, or reason identifier as authority merely because its shape is valid.

## Buyer-visible safety contract

`recordScheduleReasonEvent()` binds each state-changing reason event to the exact `organizationId`, `projectId`, `workItemId`, `actorId`, action, and expected work-item version before persistence. The supported actions are deliberately distinct:

- `skipped` -> `schedule_outcome.skip`
- `cancelled` -> `schedule_outcome.cancel`
- `not_performed` -> `schedule_outcome.not_performed`

The authorization adapter must return an allowed decision with an authorization identifier and the exact resource version it evaluated. A stale version is rejected; the domain does not retry against a newer resource because doing so would silently broaden authority beyond the decision that was actually checked.

Cancellation has a second trust boundary. A caller supplies only an `approvalRef`; a trusted approval adapter must resolve that reference and return a valid approval identifier, approver identity, approval-authorization identifier, and the same exact work-item version. After that trusted resolution, the domain independently rejects the approval when `approverId` equals the acting `actorId`, so a misconfigured approval adapter cannot turn self-approval into a valid cancellation decision. Non-cancellation events reject approval references so approval-shaped data cannot accidentally become a confused-deputy channel.

The repository adapter receives one immutable event plus the original expected resource version. Its contract is to atomically enforce optimistic concurrency and commit both the reason event and its audit record. A successful receipt must identify the exact committed event, the audit record, and the resulting resource version. The domain rejects malformed, mismatched, or non-committed receipts.

Generated public event identifiers must be opaque strings rather than sequential numeric identifiers. Caller and adapter objects are copied into immutable output so post-call mutation cannot rewrite the returned provenance.

## Failure and privacy behavior

The boundary fails closed before persistence when authorization is denied, authorization was evaluated against another resource version, cancellation approval is absent/denied/stale/self-approved, canonical timestamps are invalid or future-dated, a generated identifier is not opaque, or trusted adapter output is malformed.

Authorization and approval denials are intentionally generic. The domain does not echo provider-internal policy reasons, credentials, tokens, or tenant-discovery details. It stores no secret and does not require PII beyond stable actor/approver identifiers supplied by trusted adapters. Retention, export logging, encryption-at-rest, and deletion policy belong to the eventual persistence/operations layer and must preserve the purpose-bound authorization and tenant-isolation semantics established here.

## TDD and executable traceability

The original behavior contract preceded production implementation. Historical predecessor evidence does not authorize the reconciled head.

- `f3ae772e976a96c06d07e3d28437b4415d6678ff` added the initial reason-event behavior contract before `server/schedule_reason_event_domain.mjs` existed; local execution was RED with `ERR_MODULE_NOT_FOUND`.
- `48d3ecbc8f6292e593da6cff57aeb5a2298bbff1` added the initial production authorization/audit boundary.
- `d2ba9a2e6bca12f8bfa3d6c642074631df654015` added a focused regression proving a cancellation approval whose trusted `approverId` equals the acting user must never reach persistence.
- `e6e3fdebc3318d2a4358c37b5f76650a81c8572e` registered that regression in the normal unit and canonical c8 case paths before the production repair.
- `3c5acb5f86eb19ccd5daafb4a6b778243edb73e2` added the narrow domain-side distinct-approver check.

The realistic regressions cover tenant/resource identity propagation, action-specific authorization, stale-resource rejection, cancellation approval verification, direct self-approval rejection, authority-confusion rejection, future/malformed time evidence, opaque public identifiers, malformed trusted snapshots, commit/audit receipt mismatch, immutability, and side-effect ordering. Exact statement/branch/function/line coverage is accepted only from repository-native current-head c8 evidence; local-only or predecessor-head evidence is not promoted to passing.

## Standards rationale

ISO 21502:2020 remains the published general project-management guidance standard and is applicable across delivery approaches and project types. This slice does not claim that ISO prescribes ScopeWeave's reason-event vocabulary or authorization actions. It uses the standard only as project-management context for accountable management of project information and decisions.

NIST SP 800-53 Rev. 5 Release 5.2.0 provides the more directly relevant security-control context. AC-3 addresses access enforcement, while the Audit and Accountability family includes AU-3 audit-record content and AU-12 audit-record generation. ScopeWeave therefore separates caller facts from an explicit authorization decision, binds the decision to the exact resource version, and requires the persistence adapter to commit an auditable record together with the state-changing reason event. This is design evidence toward control readiness, not a claim of NIST, SOC 2, or any other certification.

The implementation remains deterministic and model-independent. LLM output may later explain a reason decision to an authorized user, but it cannot replace authorization, cancellation approval verification, optimistic concurrency, or the audit commit contract.

## Integration and rollback

Do not integrate this child independently of PR #517. If the parent head moves or reaches protected `develop`, compare this branch against the exact new parent/protected head for unintended deletion or weakening before trusting any green result.

Before persistence/API/UI integration, rollback removes `server/schedule_reason_event_domain.mjs`, its focused tests, package/coverage registrations, this doctoring record, and the corresponding Unreleased CHANGELOG entry together. No database state is introduced by this slice.

A later adapter must implement the repository port with one transaction (or an equivalent atomic durable operation) that checks `expectedResourceVersion`, writes the reason event, writes its audit record, and returns a receipt for the exact generated event. The adapter must derive tenant/resource authority from authenticated server context rather than browser claims. A later cancellation-approval adapter must likewise resolve and verify approval authority rather than trusting `approvalRef` as proof.

## References

International Organization for Standardization. (2020). *Project, programme and portfolio management—Guidance on project management* (ISO Standard No. 21502:2020). https://www.iso.org/standard/74947.html

National Institute of Standards and Technology. (2025). *Security and privacy controls for information systems and organizations* (NIST Special Publication 800-53 Rev. 5, Release 5.2.0). https://doi.org/10.6028/NIST.SP.800-53r5
