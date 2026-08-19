[Output truncated for brevity]

## 2024-05-31 - [Keyboard Navigation Focus Management on Deletion]
**Learning:** [When an element is removed from the DOM, focus naturally resets to the document body, breaking the keyboard navigation flow. It is critical to calculate the next logical focus target prior to deletion and programmatically restore focus post-render.]
**Action:** [In future components involving item deletion within lists or tables, proactively incorporate index calculations before removing items to manage focus restoration correctly.]

## $(date +%Y-%m-%d) - Add Confirmation Dialog for CSV Import
**Learning:** File import actions that completely overwrite existing application state can lead to severe data loss if triggered accidentally. In a WBS planner where users invest significant time building task hierarchies, destructive imports need explicit user confirmation.
**Action:** Always add a confirmation dialog (`window.confirm` or custom modal) for any import or sync action that wipes out the current in-memory or persisted state, especially when there's no undo mechanism.

## $(date +%Y-%m-%d) - Prevent accidental data loss in inline editors
**Learning:** Forms that take a long time to fill out (like a WBS editor) are prone to accidental closure by users pressing `Escape` or clicking cancel. This causes immediate data loss without any warning, resulting in frustration.
**Action:** When working on editors that can be dismissed, track whether the user has modified any fields compared to their initial state. If there are changes, intercept the close action and present a confirmation dialog (`window.confirm`) to ensure they really want to discard their edits. Bypass this for intentional saves or explicit data overrides.

## $(date +%Y-%m-%d) - Replace native disabled with aria-disabled for submit buttons
**Learning:** Replacing `disabled` with `aria-disabled="true"` on a `<button type='submit'>` prevents the button from swallowing focus and hover events, which allows tooltips or toasts to explain why the action is unavailable. However, `aria-disabled` does not natively block the `submit` event from firing, and does not block native HTML5 form validation popups from showing when the button is clicked.
**Action:** When replacing a native `disabled` attribute with `aria-disabled='true'` on a submit button, explicitly check the attribute in the form's `submit` event handler AND the button's `click` event handler, calling `event.preventDefault()` in both places to block unintended form execution and native validation UI.
