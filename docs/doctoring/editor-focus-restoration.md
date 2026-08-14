# Inline editor focus restoration

## Decision

ScopeWeave restores keyboard focus after the inline editor closes by storing a
stable description of the invoking control rather than retaining the original
DOM object. The WBS table is rerendered when the editor opens and closes, so the
original `document.activeElement` reference may become detached and cannot be a
reliable focus target.

For row actions, the stored identity contains the row's `data-task-id` and the
control's `data-action`. For persistent page-level controls, the identity uses
the element `id`. After the rerender, a `requestAnimationFrame()` callback looks
up the new element and calls `focus()` only when a matching target exists.

## Accessibility contract

The change preserves the user's point of regard after both Save and Cancel. It
covers:

- opening and closing the root-task creator;
- opening and closing an existing task editor;
- keyboard activation;
- pointer activation; and
- a narrow mobile/touch viewport.

Focus is restored after the DOM update rather than before it. When the invoking
control no longer exists, ScopeWeave does not focus a detached node or throw an
exception; normal document focus remains in effect.

## Executable evidence

`tests/e2e/test_focus_restoration.spec.js` uses Playwright's retryable
`toBeFocused()` assertion for the root Add control and a row Edit control.
`tests/e2e/test_focus_mobile.spec.js` repeats the root-control contract at a
375-by-667 touch viewport.

Both files are included in `test:e2e:cloud`, so the protected-branch browser lane
executes them rather than relying on unregistered test files.

## Compatibility and rollback

This change does not alter persisted WBS data, the editor's validation or
unsaved-change confirmation, API contracts, authentication, or server storage.

Rollback must revert the stable focus identity, the two browser tests, cloud test
registration, CHANGELOG entry, and this record together. Reintroducing a direct
DOM reference requires new evidence that the referenced element survives every
editor rerender.

## References

World Wide Web Consortium. (2024). *Web Content Accessibility Guidelines
(WCAG) 2.2*. https://www.w3.org/TR/WCAG22/

World Wide Web Consortium. (2025). *Developing a keyboard interface*.
WAI-ARIA Authoring Practices Guide.
https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/

Web Hypertext Application Technology Working Group. (2026). *HTML standard:
Focus*. https://html.spec.whatwg.org/multipage/interaction.html#focus
