# Focusable editor validation and synchronous save authority

## Decision

The editor save button remains a native button in the sequential keyboard order.
When the current draft is invalid, ScopeWeave exposes
`aria-disabled="true"`, connects the button to `#editor-errors` with
`aria-describedby`, and keeps the control physically focusable. Activation is
still accepted as an input event, but `saveEditor()` synchronously validates the
latest draft and refuses persistence while errors remain.

The debounced validation pass is presentation only. It updates field error
states, the error summary, and save-button semantics; it is not an authorization
or persistence boundary. This avoids two inverse races:

- a user corrects the final error and immediately clicks or presses Enter before
  the debounce updates a stale disabled state; and
- a user introduces an error and immediately submits before the presentation
  layer catches up.

Both paths are decided by the same latest-draft validation inside
`saveEditor()`.

## Accessibility rationale

WAI-ARIA defines `aria-disabled` as a perceivable disabled state. W3C's
Authoring Practices notes that disabled commands can remain focusable when their
discoverability is useful, provided scripting prevents the unavailable action.
The save action is a primary command whose error relationship benefits from
keyboard discovery, so ScopeWeave keeps it focusable and exposes the current
error summary as its accessible description.

The native `disabled` attribute is not used for this state because it removes the
button from normal keyboard focus and can preserve a stale block while the
debounced presentation state catches up. The implementation must not treat
`aria-disabled` alone as enforcement; synchronous validation prevents mutation.

## Executable evidence

`tests/e2e/editor-validation-sync.spec.js` verifies:

- an invalid save control remains focusable and described;
- activating it does not create a task;
- a draft corrected immediately before click saves without waiting for debounce;
- a draft corrected immediately before Enter saves without waiting for debounce;
- a newly invalid draft cannot persist before debounce completes; and
- error text remains available through `#editor-errors`.

The existing full-browser suite is updated to activate invalid save controls and
assert that task count and editor state are unchanged for reversed dates,
invalid calendar dates, and HTML input. It also re-enables the complete
`scopeweave.spec.js` cloud path and restores module-preload assertions for the
three production modules.

## Compatibility and rollback

This change does not modify persisted WBS data, API contracts, authentication,
or server storage. It changes only the editor's presentation semantics and keeps
existing synchronous validation behavior as the persistence authority.

Rollback must revert the button-state implementation, focused browser tests,
full-suite expectations, module-preload restoration, package script, CHANGELOG
entry, and this record together. Reintroducing native `disabled` requires a new
proof that immediate correction cannot be blocked by stale debounced state.

## References

World Wide Web Consortium. (2023). *Accessible Rich Internet Applications
(WAI-ARIA) 1.2*. https://www.w3.org/TR/wai-aria-1.2/

World Wide Web Consortium. (2025). *Developing a keyboard interface*.
WAI-ARIA Authoring Practices Guide.
https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/

World Wide Web Consortium. (2024). *Web Content Accessibility Guidelines
(WCAG) 2.2*. https://www.w3.org/TR/WCAG22/
