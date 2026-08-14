# Toast status accessibility evidence

## Decision

ScopeWeave exposes transient advisory toast messages through a non-focus-moving `status` live region. The production container uses `role="status"`, retains `aria-live="polite"`, and explicitly sets `aria-atomic="true"` so assistive technology can announce the complete current message while keyboard focus stays on the user's active control.

WAI-ARIA 1.2 defines `status` as an advisory live-region role and gives it implicit `aria-live="polite"` and `aria-atomic="true"` semantics. ScopeWeave keeps those two properties explicit because the markup is also an operator- and test-visible contract. WCAG 2.2 Success Criterion 4.1.3 requires status messages to be programmatically determinable without receiving focus; `role="status"` is the appropriate semantic boundary for these non-urgent toasts.

## Executable contract

`tests/unit/toast-accessibility.test.mjs` reads the shipped `index.html` and fails unless the real toast container:

- exists;
- has `role="status"`;
- has `aria-live="polite"`;
- has `aria-atomic="true"`; and
- has no `tabindex` that would make status updates a focus-management mechanism.

The test is registered in `npm run test:unit`, so the accessibility semantics are checked by the normal repository verification path rather than existing only as documentation.

## Compatibility and rollback

This change does not alter toast timing, visual presentation, text generation, persistence, APIs, authentication, or data handling. Rollback removes the added ARIA semantics, the regression test, and this evidence record together. If future usability testing demonstrates that a specific toast is urgent rather than advisory, that message should use a separately reviewed alert interaction instead of changing every toast to an interruptive live region.

## References

World Wide Web Consortium. (2023). *Accessible Rich Internet Applications (WAI-ARIA) 1.2* (W3C Recommendation). https://www.w3.org/TR/wai-aria-1.2/

World Wide Web Consortium. (2024). *Web Content Accessibility Guidelines (WCAG) 2.2* (W3C Recommendation). https://www.w3.org/TR/WCAG22/
