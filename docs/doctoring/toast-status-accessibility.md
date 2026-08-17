# Toast and sync status accessibility and visibility evidence

## Status and decision

ScopeWeave treats transient toast text and synchronization feedback as
advisory status messages. The shipped contract is:

- `#toast` has `role="status"`, `aria-live="polite"`, and
  `aria-atomic="true"` and does not receive focus when its content
  changes;
- `#sync-status` uses the same explicit status/polite/atomic semantics
  without becoming a synthetic keyboard stop; and
- the cloud/SaaS toast producer's `.visible` state is backed by shipped
  CSS that raises opacity to `1` and restores the translated element.

The visual-state control matters because the base application producer
uses `.show` while `cloud-sync.js` adds and removes `.visible`.
`styles.css` renders `.toast.show`, so a cloud message can update its
live-region text while remaining visually transparent unless
`.toast.visible` is also rendered. After a share link fails, the next
action is to request a fresh share URL from the project owner.

## Standards boundary

WAI-ARIA 1.2 defines `status` as advisory live-region content and gives
the role implicit `aria-live="polite"` and `aria-atomic="true"`
semantics. It also advises authors not to move focus to a status message
as a result of the update. WCAG 2.2 Success Criterion 4.1.3 requires
status messages to be programmatically determinable so assistive
technology can present them without receiving focus. ScopeWeave keeps
the explicit live-region attributes in addition to the role so the
intended contract remains visible in markup and executable regression
evidence.

The `.visible` compatibility rule is a product-integrity control, not a
separate WCAG success criterion. It prevents the same advisory toast
from being available to screen-reader users while remaining transparent
for sighted users.

## Repair boundary

PR #491 head `794ecbdf1416e883942dac2b836859ba6f9ac0f9` titled a CI
re-kick but deleted this slice and reverted already-landed orchestrator
and Microsoft Project XML hardening. This repair replays only the toast
and sync-status contract onto current `develop`. It does not change
orchestrator, XML import, authentication, or workflow files.

`toast-state.css` must stay on every production serve path: the SaaS
static allowlist, both Docker images, and the GitHub Pages stage list.
A share-error toast that updates the live region while remaining
transparent is the buyer-visible failure this lock prevents.

Do not use empty `ci: re-kick` commits to mutate the tree. Rollback must
remove the status semantics, `toast-state.css`, its production link,
allowlist and image copies, both focused toast regressions and their
test registrations, this doctoring record, and the CHANGELOG entry
together.

## Executable acceptance evidence

`tests/unit/toast-accessibility.test.mjs` reads the shipped
`index.html`, `cloud-sync.js`, and `toast-state.css`. It proves that:

- the production toast exposes status/polite/atomic semantics;
- the production synchronization feedback exposes the same explicit
  advisory status semantics;
- neither advisory status region becomes a synthetic keyboard stop;
- the cloud producer actually activates `.visible`;
- the production document loads `toast-state.css`; and
- `.toast.visible` is rendered with visible opacity and transform.

`tests/e2e/toast-accessibility.spec.js` drives the production cloud
share-error path in Chromium using a valid-shaped but unavailable share
token. It requires the real toast to contain the customer-facing failure
guidance, retain the status semantics, carry `.visible`, reach computed
opacity of at least `0.99`, be visually visible, and leave keyboard
focus elsewhere.

## Scope and security boundary

This change does not alter toast or synchronization content, timing,
persistence, authentication, authorization, API semantics, credential
handling, tenant isolation, attachment behavior, Clearfolio integration,
database state, dependencies, workflows, or application
focus-management code. Urgent blocking errors that require immediate
interruption need a separate interaction design rather than silently
changing these advisory status regions to assertive alerts.

## References

World Wide Web Consortium. (2023). *Accessible Rich Internet
Applications (WAI-ARIA) 1.2*. https://www.w3.org/TR/wai-aria-1.2/

World Wide Web Consortium. (2023). *Web Content Accessibility Guidelines
(WCAG) 2.2*. https://www.w3.org/TR/WCAG22/
