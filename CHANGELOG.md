# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added deterministic PM analysis for requirements/RFI/RFP readiness, WBS
  estimation coverage, dependency risk, and procurement package section checks.
- Preserved PM-analysis research papers, NASA WBS handbook, BCP 14, and JSON
  Schema 2020-12 source documents under `docs/research/pm-analysis/`.
- Added companion dependency-review and OSV workflows so Strix
  manifest-only findings can be verified against authoritative PR-head
  checks.
- Added workflow ownership regression coverage so central review
  workflows stay inherited from `ContextualWisdomLab/.github`, not copied
  into this repository.

### Security

- Added a deterministic Stripe entitlement-policy boundary over authoritative
  Subscription and Invoice evidence: paid `active` access requires an exact paid
  Invoice match, `past_due` never provisions or extends access, terminal states
  fail closed, stale observations cannot roll back newer claims, and one canceled
  Subscription cannot erase another independent unexpired claim. This active PR
  slice derives immutable candidates only and does not persist or authorize access.
- Added a tenant-scoped read-only projection over accepted authoritative Stripe
  Subscription observations, selecting current state by explicit append order,
  preserving ordered Price and source-event provenance, rejecting ambiguous local
  organization authority strings, and never treating provider status as local
  entitlement authority.
- Made contextual-orchestrator briefing requests fail closed unless an authenticated endpoint is configured. Deterministic generated text is restricted to explicit `SCOPEWEAVE_DEV=1`, message/provider responses are bounded and validated, and non-loopback HTTP transport is rejected.
- Persist authoritative Stripe Subscription reads as normalized append-only
  tenant-bound observations without mutating local entitlement state; atomic
  savepoint writes now preserve the causal failure and never release an
  unconfirmed rollback, preventing failed observation writes from being
  accidentally committed during cleanup failure.
- Added a bounded authoritative Stripe Subscription read boundary that validates
  exact subscription and tenant identity, normalizes immutable provider lifecycle
  facts without granting entitlement, and propagates `orgId` onto the underlying
  Subscription created by Checkout so later reconciliation can fail closed on
  missing or cross-tenant provider metadata.
- Persist verified Stripe webhook event metadata and per-delivery replay evidence
  after raw-body signature verification without retaining the signed raw body;
  exact event-ID/hash duplicates are idempotent, conflicting bytes and malformed
  request envelopes fail closed, and no webhook event directly grants entitlement
  before authoritative lifecycle reconciliation.
- Persisted a tenant/price-scoped Stripe Checkout attempt identity and opaque
  idempotency key before live Session creation, reusing unresolved identity only
  inside a 23-hour safety window; network/abort, Stripe 5xx, malformed or
  untrusted successful responses, and local success-persistence failures remain
  pending for same-key retry or reconciliation, while known Stripe 4xx outcomes
  close the attempt before a later deliberate Checkout receives fresh authority.
- Bounded hosted Stripe Checkout provider calls to one 15-second, no-retry
  attempt with a 1 MiB response ceiling before JSON parsing until durable
  idempotency exists; validated returned destinations as exact HTTPS
  `checkout.stripe.com` URLs without credentials or non-standard ports while
  preserving Stripe-issued client fragments; and mapped provider failures to
  sanitized no-store 502 responses.
- Bound Stripe Checkout success/cancel redirects to an operator-configured
  canonical public origin instead of request authority, rejected partial or
  ambiguous billing configuration at startup, and confined successful mock
  checkout to explicit development mode.
- Made live Stripe Checkout fail closed on network errors, provider non-2xx
  responses, malformed JSON, missing hosted URLs, plaintext redirect URLs, and
  URL credentials, returning a stable non-leaking HTTP 502 retry/operator action
  instead of treating provider error documents as successful sessions.
- Made `SCOPEWEAVE_JWT_SECRET` mandatory at startup and rejected weak or
  unexpanded placeholder values so production deployments fail closed.
- Neutralized audit-log CSV formulas even when executable prefixes are hidden
  behind leading whitespace.
- Replaced dynamic and lazy-regex MS Project XML block extraction with bounded
  linear scans to prevent pathological backtracking on malformed imports.
- Rejected non-string password candidates at the authentication boundary.
- Added regression coverage that prevents array-valued passwords from being
  coerced into valid credentials.
- Updated Hono runtime dependencies to patched supported releases.
- Sanitized Clearfolio submission, status, and artifact-link transport failures
  so network details and downstream response text cannot reach browser or
  diagnostic payloads; rejected unknown or whitespace-padded conversion states
  and malformed, unsupported-scheme, or HTTPS-downgrade artifact links.
- Centralized session JWT verification and database-backed `token_version`
  revocation across bearer middleware, calendar feeds, server-sent events, and
  attachment-view URL transports.
- Made session-token minting fail closed unless the subject, token version, and
  lifetime are bounded safe integers, and capped general session lifetime at
  seven days so internal callers cannot mint excessive or numerically unsafe
  credentials.
- Rejected signed session JWTs with a non-HS256/JWT header, non-object claims,
  missing or invalid subject/expiry, or a missing, Boolean, fractional,
  negative, unsafe, or otherwise invalid token-version claim before user lookup.
- Added cross-device regression coverage proving that `logout-all` rejects stale
  tokens on bearer, calendar, SSE, and attachment-view transports while the
  replacement token continues through the same authentication boundary.

### Changed

- Switched the repository-local OpenCode development configuration from GitHub
  Models to an NVIDIA NIM-only candidate set while preserving organization-level
  review-workflow ownership in `ContextualWisdomLab/.github`.
- Production planning-analysis requests now combine tenant-bound, server-derived
  contextual-orchestrator cost attribution with explicit `auto` orchestration
  mode, delegating provider/model/topology policy to the shared service without
  weakening ScopeWeave's authenticated, fail-closed transport or response
  boundary controls.
- Accepted XML whitespace before exact Microsoft Project element delimiters
  while preserving the linear, regex-free import scanner and rejecting
  attributes, longer names, non-XML whitespace, nested unmatched blocks, and
  truncated input.
- Attachment-list status refresh now removes the per-row database lookup,
  uses a configurable bounded worker pool with per-item abortable timeouts and
  a request-wide latency budget, preserves stale status after downstream,
  timeout, malformed-response, and persistence failures, excludes internal
  conversion identifiers from responses, reports attempted, changed, failed,
  skipped-data, and deferred-budget counters separately, and exposes fixed
  low-cardinality timeout, lookup, validation, and persistence failure counters.
- Toast notifications and synchronization feedback now expose advisory updates
  as explicit polite, atomic WAI-ARIA status regions without adding keyboard
  stops, and cloud toast feedback now has a shipped visual state so the same
  message remains visible to sighted users.
- GitHub Pages, both Docker images, and the SaaS static allowlist now ship
  `cloud-sync.js`, `analytics.js`, and `toast-state.css` with the documents
  that load them, so share-error and cloud status toasts stay visible after
  deploy.
- 프로젝트 이름 입력 필드에 입력 예시(placeholder)를 추가하여 사용자 편의성을 개선했습니다.
- 데이터 테이블의 반복되는 액션 버튼에 컨텍스트 정보(작업명)를 포함한 명시적인 ARIA 레이블을 추가하고, 유효성 검사 에러를 폼 필드에 연결하여 접근성을 개선했습니다.
- `createGanttBarElement`, `renderGantt`, `buildWeekdayTimeline`에서 반복적으로 호출되던 `compareDateStrings`를 직접적인 문자열 비교 연산(`>=`, `<=`)으로 교체하여 O(N*D) 복잡도의 캐시 스레싱과 정규식 검사를 방지했습니다.
- Treat fields added only to an editor draft as unsaved changes so unload and
  cancel safeguards cannot silently discard newly introduced data.
- Centralized OpenCode Review, Strix Security Scan, PR Review Merge
  Scheduler, failed-check explanation, and coverage evidence ownership in
  `ContextualWisdomLab/.github`, removing repository-local workflow,
  script, and requirements copies.
- Documented Kubernetes/IaC as follow-up work rather than a current
  blocker for this static app.

## [1.0.0] - 2026-04-20

<!-- markdownlint-disable-next-line MD024 -->
### Added

- Initial ScopeWeave Planner release with tree-table editing,
  cumulative metrics, CSV import/export, and Gantt modal.
- `wbs.json` seed loading plus browser autosave and optional file sync.
- Playwright E2E coverage for add/edit hierarchy flows, delete
  confirmation, subtree drag-and-drop, and JSON sync shape.
- GitHub Pages deployment workflow and operator documentation.

## [1.0.1] - 2026-06-25
### 성능 개선 (Performance)
- 드래그 앤 드롭 동작 중 `dragover` 이벤트에서 발생하던 O(N) 작업 리스트 검색 성능 병목 문제를, O(1) 해시맵(Map) 기반의 캐싱 조회 로직으로 개선하여 큰 크기의 WBS 리스트에서의 버벅임 현상을 해결했습니다.
