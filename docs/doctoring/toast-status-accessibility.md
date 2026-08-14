# Toast status accessibility evidence

## Decision

ScopeWeave treats transient toast text as an advisory status message. The shipped `#toast` container therefore has `role="status"`, `aria-live="polite"`, and `aria-atomic="true"` and does not receive focus merely because its content changes.

WAI-ARIA 1.2 defines `status` as advisory live-region content and gives the role implicit `aria-live="polite"` and `aria-atomic="true"` semantics. It also advises authors not to move focus to a status message as a result of the update. WCAG 2.2 Success Criterion 4.1.3 requires status messages to be programmatically determinable so assistive technology can present them without receiving focus. ScopeWeave keeps the explicit live-region attributes in addition to the role so the intended contract remains visible in markup and executable regression evidence.

## Enforcement boundary

The production contract is the toast element in `index.html`. `tests/unit/toast-accessibility.test.mjs` reads that shipped document and proves that the element exists, exposes the `status` role, uses polite and atomic announcements, and has no `tabindex` that would make status updates focus-taking.

This change does not alter toast content, timing, persistence, authentication, APIs, or application focus-management code. Urgent blocking errors that require immediate interruption or user action would need a separate interaction design rather than silently changing this advisory status region to an assertive alert.

## Rollback

Rollback reverts the toast ARIA attributes, this regression test and its `test:unit` registration, the associated learning note, and the CHANGELOG entry together. After rollback, the previous `aria-live="polite"` behavior remains, but ScopeWeave would no longer claim the stronger status-message evidence described here.

## References

World Wide Web Consortium. (2023). *Accessible Rich Internet Applications (WAI-ARIA) 1.2*. https://www.w3.org/TR/wai-aria-1.2/

World Wide Web Consortium. (2023). *Web Content Accessibility Guidelines (WCAG) 2.2*. https://www.w3.org/TR/WCAG22/
