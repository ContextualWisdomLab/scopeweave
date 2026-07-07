## 2026-06-14 - Remove emojis from ARIA labels
**Learning:** Emojis should be avoided in `aria-label` attributes as they are announced awkwardly by screen readers, leading to poor accessibility. Also, icon-only buttons need explicit `title` attributes explaining the disabled state (e.g. why they can't be clicked) to improve user experience.
**Action:** Use plain text for `aria-label` attributes. When an icon-only button is disabled, ensure the `title` attribute clearly explains the reason for it being disabled.
## 2026-06-15 - Add required field indicators to editor fields
**Learning:** Forms are difficult for screen-reader and visual users alike when required fields are unclear until submission fails. Combining a visual asterisk with a hidden (필수) text and aria-required significantly improves form accessibility.
**Action:** Use aria-required="true", visual indicators like asterisks, and placeholders for dynamically generated form fields.
## 2026-06-16 - Inline Styles vs Existing Classes
**Learning:** Adding new UI states (like empty states) often tempts the use of inline styles when existing classes don't quite fit the new elements. However, this violates the strict rule against custom CSS and inline styles.
**Action:** Always search the existing CSS files (`styles.css`) for utility classes before writing inline styles. If custom styling is absolutely necessary, add it directly to `styles.css` instead of using inline style attributes.

## 2026-06-16 - Package Lock Drift during Testing
**Learning:** Running `npm install` to set up the local testing environment (Playwright) can accidentally modify `package-lock.json`, which should not be committed unless dependencies were explicitly changed as part of the task.
**Action:** Always run `git checkout package-lock.json` or `git restore package-lock.json` before creating a pull request if the task did not involve dependency updates.
## 2026-06-16 - Safe HTML Rendering in UX Improvements
**Learning:** Adding new UI elements or templates often requires building HTML strings and inserting them via `innerHTML`. However, if these templates include user-controllable data without escaping, it creates a Stored XSS vulnerability, which can be flagged by security scanners (like Strix) or exploited by attackers.
**Action:** When improving UX with new layouts or lists, always use safe rendering methods: use `textContent` when updating pure text, and pass any dynamic user input through `escapeHtml()` when building larger template strings before injecting them into the DOM.
## 2026-06-16 - Safe CSV and LocalStorage usage
**Learning:** Sensitive data should not be stored in `localStorage`; if local persistence must protect sensitive data, use real encryption with appropriate key management instead of reversible obfuscation such as XOR or Base64. CSV exports also need protection against formula injection. For CSV generation, RFC 4180 must be followed and lines starting with special characters (`=`, `+`, `-`, `@`) must be escaped with a leading single quote to match the app's CSV export behavior.
**Action:** Keep sensitive values out of `localStorage`, or use properly designed encryption with key management when sensitive local persistence is unavoidable. When generating CSVs from user input, always sanitize values by escaping double quotes, enclosing in quotes if needed, and prefixing potentially malicious formulas with a leading single quote.
## 2026-06-16 - CI dependency resolution
**Learning:** During test runs, upstream tools like Strix Agent might occasionally fail due to unpinned or missing transitive dependencies (like `tzlocal` dropping out of `scrubadub` or `dateparser`).
**Action:** When CI pipelines fail with `ModuleNotFoundError` for packages like `tzlocal` that should be present, update the owning workflow's dependency contract. OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler dependencies are owned centrally in `ContextualWisdomLab/.github`.
## 2026-06-17 - Disable unavailable actions instead of hiding or erroring
**Learning:** Users can be confused if actions like 'Export CSV' or 'Gantt Chart' are clickable but do nothing (or show an error) when there's no data. Disabling the buttons with a clear `title` tooltip improves the experience.
**Action:** Proactively disable buttons that require a certain state (like having tasks or browser API support) and explain the reason via a `title` tooltip.

## 2026-06-20 - Forms & Empty States
**Learning:** For a complex app like a WBS planner with inline editing, dynamic DOM mutations must communicate intent properly to screen readers. Live regions should be used for dynamic form validation messages (`aria-live="polite"`).
**Action:** When improving micro-UX in heavily dynamic apps, prefer adding appropriate ARIA attributes for existing dynamic UI. Make validation messages `aria-live="polite"`. Add explicit id-based labeling (`for="project-name"`, `id="..."`) to inputs, ensuring they are unique if dynamic. And empty states should contain actionable buttons instead of just text hints.

## 2026-06-20 - Focus Management in Dynamic JS Render Cycles
**Learning:** In pure JavaScript render architectures that rebuild DOM aggressively (`renderAll()`), accessibility context like `document.activeElement` is lost when components (like inline editors or modals) are unmounted or remounted.
**Action:** Always capture `document.activeElement` before a major destructive DOM update or modal opening, and explicitly restore `.focus()` on close. When mounting forms, explicitly focus the first input inside a `requestAnimationFrame` to maintain user flow.
## 2026-06-21 - Avoid indirect string replacements
**Learning:** When trying to edit files, it is an anti-pattern to create temporary node scripts to do string replacements on source files. It is brittle and fails code reviews.
**Action:** Always modify source files directly using standard editing tools (like `replace_with_git_merge_diff`) instead of writing separate scripts to mutate the codebase.
## 2026-06-21 - Gantt Chart Actionable Empty State
**Learning:** Generic "no data" messages in complex components (like a Gantt chart modal) create dead ends. Empty states represent an opportunity to guide users on exactly which fields (e.g., planned start/end dates) they need to fill in to see the data they expect. Reusing existing table-empty UI patterns inside modals also maintains visual consistency and reduces perceived friction.
**Action:** Always prefer structured, actionable empty states with a helpful description over basic text strings, and reuse existing empty-state CSS patterns wherever possible to guide users out of the dead end.
## 2026-06-22 - Hide Unicode Icons from Screen Readers
**Learning:** Icon-only buttons with `aria-label` can still cause screen readers to read the text content (unicode symbols like '✎' or '▼') if they aren't explicitly hidden.
**Action:** Always wrap text-based icons in `<span aria-hidden="true">` to ensure screen readers only read the intended `aria-label`.
## 2026-06-23 - Contextual ARIA labels and Input-Error Linking
**Learning:** Repetitive UI elements like "Edit" or "Delete" buttons in a data table need contextual `aria-label`s (e.g., "Requirement Analysis Edit") to be meaningful for screen readers. Additionally, when dynamic validation messages appear alongside an input element, setting `aria-invalid="true"` and `aria-describedby="[error-id]"` is critical so screen readers explicitly announce the validation text upon focusing the invalid field.
**Action:** When working on data table actions, inject the row's primary contextual name (like Task Name) into button `aria-label`s. When dynamically rendering validation warnings near form elements, assign a unique `id` to the warning and use `aria-invalid` and `aria-describedby` on the input to link them.
## 2026-06-23 - Prevent DOM XSS false positives by using strict string interpolation
**Learning:** When using boolean values from an untrusted source (like `localStorage`) in DOM attributes directly without sanitization, security scanners (like Strix) might flag the usage as Stored XSS, even if DOM APIs like `setAttribute` naturally encode the raw strings. Double-escaping text when using `.textContent` or string-interpolation for `.setAttribute` causes visual breakage (e.g. `Task &amp; 1`) because these sinks do not decode HTML entities.
**Action:** When evaluating boolean properties in DOM templates (e.g., `aria-expanded`), explicitly use a ternary coercion to string primitives (e.g., `task.expanded ? 'true' : 'false'`) instead of relying on generic `String(task.expanded)` to prevent scanners from treating it as an untyped generic string injection vector. Avoid using `escapeHtml()` when updating DOM text via `textContent` or `setAttribute`, as the browser handles the encoding safely.
## 2026-06-25 - Improve Screen Reader UX for Empty Table Cells
**Learning:** Dense data tables often use placeholder characters like dashes (`-`) to represent empty cells visually. However, screen readers read these aloud sequentially, causing a frustrating "dash, dash, dash" experience that degrades usability.
**Action:** When a table cell is conceptually empty but uses a visual placeholder like `-`, wrap the placeholder in `<span aria-hidden="true">` and add a visually hidden span (`.sr-only`) with a meaningful semantic text like "값 없음" (No value) or "비어있음" (Empty).

## 2026-06-24 - Provide Context for Repeating Inline Actions
**Learning:** Repeating form fields and action buttons in a data grid (like "Edit", "Delete", or inline selects) sound identical to screen reader users (e.g., "편집") without the row context.
**Action:** When working with inline action buttons or fields in a data grid, extract an identifying entity name from the row data and append/prepend it to the `aria-label` or `sr-only` label text to provide clear context (e.g., "편집 - [작업명]").

## 2026-06-24 - Improve contrast and add keyboard shortcut hints
**Learning:** Light gray and red text on white backgrounds often fail WCAG AA contrast requirements. Keyboard users benefit from explicit tooltip hints for shortcuts.
**Action:** Check contrast ratios for muted/warning text and include `aria-keyshortcuts` for buttons with keyboard shortcuts, with `title` as an optional pointer for mouse users.

## 2026-06-29 - Add drag handle for task reordering
**Learning:** Hidden interactions (like drag-and-dropping rows without a visible handle) are poorly discoverable and can lead to accidental activation of other row actions. Also, warning colors often fail accessibility contrast ratios against light background tones if not checked.
**Action:** Always provide visual affordances (like drag handles) for complex interactions like drag-and-drop, and verify color contrast ratios for dynamically generated badges or warnings.

## 2026-06-26 - Project Name Placeholder
**Learning:** Users can be unsure of what format or granularity is expected for a project name. Providing a concrete example placeholder (like '예: 신규 서비스 구축 프로젝트') gives immediate context and reduces cognitive load.
**Action:** Add helpful, context-specific placeholders to empty text inputs, especially those representing broad or important fields like project names.

## 2026-06-26 - Placeholder text and document titles
**Learning:** Empty text inputs without placeholders fail to provide examples, and static document titles do not help screen-reader or multi-tab users identify the active project.
**Action:** Add helpful `placeholder` attributes to form fields and build dynamic document titles from `DEFAULT_PROJECT_NAME` so app naming stays centralized.

## 2026-06-24 - Interactive Chart Accessibility
**Learning:** Visual chart elements like Gantt bars convey critical information through width and position, making them inaccessible to screen readers and keyboard users by default. Adding informative tooltips (`title`) combined with `aria-label`, `role="img"`, and `tabindex="0"` creates an inclusive experience that works for hover, focus, and assistive technologies.
**Action:** When rendering data visualizations, ensure individual graphical elements are focusable (`tabindex="0"`), semantically identified (`role="img"` or similar), and provide a text alternative (`aria-label` or `title`) explaining what the graphic represents.

## 2026-06-27 - Add keyboard shortcut hints to tooltips
**Learning:** Consistently adding `title` attributes with keyboard shortcut hints to primary actions (e.g., `(Enter)`) and cancel actions (e.g., `(Esc)`) improves discoverability, but `title` alone is not reliably exposed to keyboard and screen-reader users.
**Action:** Include keyboard shortcut hints in `title` attributes and pair them with `aria-keyshortcuts` for primary and cancel buttons when implementing or updating forms and dialogs.

## 2026-06-27 - Replace native disabled with aria-disabled for action buttons
**Learning:** Native `disabled` attributes swallow all DOM events, including clicks, and prevent focus. This breaks keyboard accessibility because users tabbing through the page skip the element entirely, and it prevents click handlers from showing helpful toast messages explaining why an action is unavailable.
**Action:** Use `aria-disabled="true"` instead of `disabled` for interactive buttons when the UI should preserve focusability or show inline feedback. Control visual presentation with `[aria-disabled="true"]` in CSS and guard the click handler by checking `getAttribute('aria-disabled') === 'true'` before preventing the action and showing feedback.

## 2026-06-28 - Keyboard Shortcut Hints
**Learning:** Keyboard shortcut hints are more useful when they are discoverable to both mouse and assistive-technology users; `title` alone is hover-driven and unreliable for screen readers.
**Action:** Pair optional title tooltips with `aria-keyshortcuts` on buttons that expose keyboard shortcuts.

## 2026-06-30 - Add skip link for dense planner layouts
**Learning:** Dense planning screens with top panels and wide data tables create long keyboard paths before users reach the main work area.
**Action:** Add a visually hidden skip link at the start of the document that becomes visible on focus and targets the primary `<main>` content region.

## 2026-06-28 - Keep row context during keyboard navigation
**Learning:** Table row hover styles do not help keyboard users, so visual context can disappear while tabbing through dense row controls.
**Action:** Pair row hover styling with `:focus-within` so focused controls preserve the same row-level context.

## 2026-06-25 - Surface editor validation state before submit
**Learning:** Keeping a submit button active while validation errors are already visible makes invalid forms feel broken, especially for keyboard and screen-reader users.
**Action:** Disable editor submit controls while validation errors are present and mark the affected inputs with `aria-invalid` and `aria-describedby`.

## 2026-06-30 - Restore keyboard focus after synchronous DOM replacement
**Learning:** In applications that rely on replacing large chunks of the DOM tree (e.g., calling `renderAll()` on every state change), elements that triggered the change (like dropdowns or toggle buttons) get destroyed and recreated. This causes the browser to reset focus to the `<body>` element, completely breaking keyboard navigation and forcing screen reader users to start over.
**Action:** When implementing interactions that trigger a full re-render, identify the element that triggered the change (e.g., using its ID or data attributes), and use `requestAnimationFrame` to manually call `.focus()` on the newly rendered equivalent element after the DOM has been updated.
