# Toast and sync status accessibility and visibility evidence

## Status and decision

This document describes **active PR #491**, not protected-`develop` shipped truth. ScopeWeave treats transient toast text and synchronization feedback as advisory status messages. The active branch therefore makes the user-visible contract explicit for assistive-technology and sighted users:

- the shipped `#toast` container has `role="status"`, `aria-live="polite"`, and `aria-atomic="true"` and does not receive focus merely because its content changes;
- the shipped `#sync-status` container uses the same explicit status/polite/atomic semantics without becoming a synthetic keyboard stop; and
- the cloud/SaaS toast producer's `.visible` state is backed by shipped CSS that raises opacity to `1` and restores the translated element to its visible position.

The visual-state control matters because protected `develop` currently has two toast state names: the base application producer uses `.show`, while `cloud-sync.js` adds/removes `.visible`. `styles.css` renders `.toast.show`, so a cloud message can update its live-region text while remaining visually transparent unless `.toast.visible` is also rendered.

## Standards boundary

WAI-ARIA 1.2 defines `status` as advisory live-region content and gives the role implicit `aria-live="polite"` and `aria-atomic="true"` semantics. It also advises authors not to move focus to a status message as a result of the update. WCAG 2.2 Success Criterion 4.1.3 requires status messages to be programmatically determinable so assistive technology can present them without receiving focus. ScopeWeave keeps the explicit live-region attributes in addition to the role so the intended contract remains visible in markup and executable regression evidence.

This slice does not claim that the `.visible` compatibility rule itself is a WCAG conformance requirement. It is a product-integrity control that prevents the same advisory toast message from becoming available to screen-reader users while remaining transparent for sighted users.

## TDD and regression chronology

The branch previously contained the full toast accessibility and visibility slice at `aafd14ce6cc648b225080c5c7347ff75cfb5a1b0`. A later commit, `00c475f0312d958097a96d33356e4d6afb0a286b`, was titled as a CI re-kick but semantically removed `toast-state.css`, the production stylesheet link, both focused regressions, their test registrations, this doctoring record, and the CHANGELOG entry. Green checks on that reduced head did not prove the removed behavior.

The repair deliberately re-established a RED-to-GREEN path rather than trusting predecessor results:

1. `ff673caeacd953561d33256e22b14b42c6fd9d30` restored the static contract regression.
2. `09e937fe50dad0faab9c201745e067ce9c3e2c73` restored the browser acceptance regression.
3. `82cef187687a43041d6532558c42c2bbf4ce65d6` re-registered both paths in normal CI. Exact-head `unit-and-api` then failed, proving the removed production asset was observable by the regression; the same run's browser lane was cancelled after the branch moved and is not treated as passing evidence.
4. `66d515474f847caf23b358e9fbdd7aee58ea53d0` restored the `.toast.visible` rendering rule.
5. `700bed8419181865e4dcaeb2adb8bca60e921784` restored the production stylesheet link.
6. `0befe87f2ebfa3a608051e0f8ca0977618dedb49` strengthened the static regression first to require the same explicit status semantics on the existing `#sync-status` feedback region; the then-current production markup did not yet contain `role="status"`.
7. `20f6088225d5b28ce1049d0be049b38637a31fde` applied the narrow production markup repair by adding only the status role to that already-polite, already-atomic synchronization region.

Only terminal-success checks on the unchanged exact current head may establish GREEN evidence. Cancelled, skipped, pending, predecessor, model-only, or status-only results are non-passing.

## Executable acceptance evidence

`tests/unit/toast-accessibility.test.mjs` reads the shipped `index.html`, `cloud-sync.js`, and `toast-state.css`. It proves that:

- the production toast exposes status/polite/atomic semantics;
- the production synchronization feedback exposes the same explicit advisory status semantics;
- neither advisory status region becomes a synthetic keyboard stop;
- the cloud producer actually activates `.visible`;
- the production document loads `toast-state.css`; and
- `.toast.visible` is rendered with visible opacity and transform.

`tests/e2e/toast-accessibility.spec.js` drives the production cloud share-error path in Chromium using a valid-shaped but unavailable share token. It requires the real toast to contain the customer-facing failure guidance, retain the status semantics, carry `.visible`, have computed opacity of at least `0.99`, be visually visible, and leave keyboard focus elsewhere.

## Scope and security boundary

This change does not alter toast or synchronization content, timing, persistence, authentication, authorization, API semantics, credential handling, tenant isolation, attachment behavior, Clearfolio integration, database state, dependencies, workflows, or application focus-management code. Urgent blocking errors that require immediate interruption or user action need a separate interaction design rather than silently changing these advisory status regions to assertive alerts.

## Rollback

Rollback must remove the status semantics, `toast-state.css`, its production link, both focused toast regressions and their test registrations, this doctoring record, and the CHANGELOG entry together. A partial rollback that preserves tests but removes the rendering rule or status semantics should fail closed; a partial rollback that removes the tests would erase the evidence that detected the semantic regressions and is not acceptable.

## References

World Wide Web Consortium. (2023). *Accessible Rich Internet Applications (WAI-ARIA) 1.2*. https://www.w3.org/TR/wai-aria-1.2/

World Wide Web Consortium. (2023). *Web Content Accessibility Guidelines (WCAG) 2.2*. https://www.w3.org/TR/WCAG22/
