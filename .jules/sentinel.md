## 2026-06-02 - Add CSP Header and secure ID Generation
**Vulnerability:** Weak randomness when creating task IDs and lack of protection against XSS exfiltration.
**Learning:** `Math.random` is an easily predictable random source, and static applications without CSP allow scripts to run from unexpected domains and exfiltrate data.
**Prevention:** Always use `crypto.randomUUID()` when available in browser environments, and provide strong Content-Security-Policy headers on the entry `index.html`.

## 2026-06-08 - Added Content Security Policy to index.html
**Vulnerability:** Missing Content Security Policy (CSP) headers or meta tags, leaving the pure HTML/JS frontend exposed to Cross-Site Scripting (XSS) via potential data injection (e.g. from wbs.json).
**Learning:** For a static client-side application where no server is managing HTTP headers, a CSP can be enforced directly using a `<meta>` tag.
**Prevention:** Always add a `<meta http-equiv="Content-Security-Policy">` tag to `index.html` to establish baseline security for static apps, restricting executable scripts to 'self'.

## 2026-06-10 - Strict Dictionary Creation & Type Sanitization
**Vulnerability:** Object map lookups via literal objects (e.g. `{}`) leave prototype properties accessible, and missing input type coercion before `trim()` exposes the app to TypeError crashes (DoS) or logic bypasses through maliciously injected properties like `__proto__`.
**Learning:** In purely client-side static apps mapping properties, creating maps with `Object.assign(Object.create(null), {...})` neutralizes prototype injection. Furthermore, relying on untyped `.trim()` calls on user input must be guarded by strict string coercion.
**Prevention:** Always use `Object.create(null)` for lookup maps processing untrusted keys, and rigorously enforce `String(value).trim()` during data sanitization to avoid DoS issues via type confusion.
## 2026-06-20 - Container Hardening and Privilege Escalation
**Vulnerability:** The Docker container was running as the root user, and the Kubernetes deployment allowed privilege escalation. This could allow attackers who compromise the container to gain elevated permissions on the host system or cluster.
**Learning:** Containers must be run as non-root users by explicitly defining a `USER` instruction in the Dockerfile. Furthermore, in Kubernetes deployments, the `securityContext` should explicitly set `allowPrivilegeEscalation: false` and `runAsNonRoot: true`, alongside dropping all unused capabilities to restrict attackers if the container is breached.
**Prevention:** Always add a `USER` directive (e.g. `USER 1000`) before `CMD` or `ENTRYPOINT` in a Dockerfile. In Kubernetes, routinely implement the least-privilege principle by enforcing `securityContext` blocks on all containers.

## 2026-06-20 - Prevent DOM Clobbering Bypass in HTML Sanitizer
**Vulnerability:** The HTML sanitization loop in `stripUnsafeGeneratedMarkup` used `element.tagName`, `element.attributes` and `element.remove()` which are vulnerable to DOM Clobbering (e.g. `<form><input name="remove"></form>`). This caused the sanitizer to crash and skip elements/attributes filtering entirely, leading to XSS vulnerabilities.
**Learning:** In browser environments, attacker-controlled HTML elements like `<form>` can override their properties using named inputs. Using property getters (`element.tagName`) or methods (`element.remove()`) is not safe against DOM Clobbering during HTML sanitization.
**Prevention:** Always extract element tag names and attributes safely using prototype methods like `Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName').get.call(element)` and `Element.prototype.getAttributeNames.call(element)`, and invoke methods like `Element.prototype.remove.call(element)`.\n

## 2026-06-21 - Hardcoded Secrets
**Vulnerability:** A test script contained a hardcoded API key (`sk-test...`). Even though it was for testing purposes, hardcoding secrets is a bad practice and can lead to exposure if the script is deployed or shared.
**Learning:** Never hardcode secrets in source code, including test scripts. Always use environment variables or a secure configuration management system to manage sensitive data.
**Prevention:** Replace hardcoded strings with environment variable references (e.g., `os.getenv("TEST_API_KEY")` or `{env:TEST_API_KEY}`) and manage secrets externally.

## 2026-06-21 - Prevent Prototype Injection in Lookup Maps
**Vulnerability:** Lookup maps defined as literal objects (e.g., `CSV_FIELD_LABELS` and `HTML_ESCAPE_ENTITIES`) exposed prototype properties, leaving the application vulnerable to prototype injection if an untrusted key (like `__proto__`) is looked up.
**Learning:** Even statically defined maps used for key lookups can be abused if user-controlled input determines the key.
**Prevention:** Always initialize lookup maps with `Object.assign(Object.create(null), { ... })` to ensure the maps have no prototype chain.

## 2026-06-21 - [MEDIUM] Add input length and file size limits to prevent DoS
**Vulnerability:** Missing file size limits during CSV import and missing length limits on text fields.
**Learning:** Browser memory can be exhausted resulting in Denial of Service (DoS) attacks if large files or strings are imported and parsed into memory.
**Prevention:** Enforce client-side file size limits (e.g. 5MB) before processing imports, add `maxLength` attributes to text inputs, and strictly truncate fields on submission to prevent bypassing client-side constraints.

## 2026-06-22 - Fix weak random number generation fallback
**Vulnerability:** The application was using `Math.random()` as a fallback when generating unique task IDs if `crypto.randomUUID()` was unavailable.
**Learning:** `Math.random()` is not cryptographically secure and can generate predictable sequences, leading to potential ID collisions or predictable IDs that could be abused in certain contexts. While this is primarily an issue in non-secure contexts (HTTP), using `crypto.getRandomValues()` as a fallback provides a cryptographically secure random number generator when `randomUUID()` is missing but `getRandomValues()` is supported.
**Prevention:** Always use cryptographically secure methods like `crypto.getRandomValues()` to generate random strings when `crypto.randomUUID()` is not an option. Avoid relying on `Math.random()` for any form of unique identifier or security-related token generation.
## 2026-06-24 - Validate HTML tags in Editor Drafts
**Vulnerability:** The application was not rejecting HTML tag characters in the inline editor, which could introduce cross-site scripting (XSS) vectors or payload issues during data export (e.g. CSV).
**Learning:** Even if data is rendered securely via `textContent`, accepting malicious HTML characters during input creates inconsistencies with import checks and introduces supply-chain risks when exported.
**Prevention:** Add input validation within `validateDraft` to reject `<` and `>` characters in `EDITABLE_FIELDS`, ensuring consistency with `validateCsvCell` logic and stopping malicious injection at the input layer.

## 2026-06-24 - Document architectural limitations regarding missing authentication
**Vulnerability:** A security scanner incorrectly flagged the absence of authentication as a CRITICAL vulnerability.
**Learning:** Pure client-side HTML/JS applications that operate entirely on local storage without a backend server cannot implement server-side authentication or session-based access control. Security scanners may generate false positives if they assume a backend exists.
**Prevention:** When building pure client-side tools, document that they are static applications operating on local data. Security models that rely on backend controls (like JWT, sessions, HTTP-only cookies) do not apply to serverless, local-first tools.

## 2026-06-25 - Prevent DoS via type confusion in trim() and Prototype Injection in Lookup Maps
**Vulnerability:** Missing string coercion before calling `.trim()` exposed the app to Denial of Service via type confusion, and `testIdMap` was vulnerable to prototype injection.
**Learning:** In purely client-side static apps, relying on untyped `.trim()` calls on user input must be guarded by strict string coercion. Also, even locally scoped maps can be abused if untrusted keys are passed.
**Prevention:** Rigorously enforce `String(value ?? '').trim()` during data sanitization so nullish values stay empty, and use frozen `Object.assign(Object.create(null), { ... })` constants for lookup maps.

## 2026-06-25 - Prevent DOM-based XSS in createTextCellContent
**Vulnerability:** The `createTextCellContent` function appended user-controlled input directly to the DOM using `wrapper.append(value)` when a warning parameter was present. This allowed arbitrary JavaScript execution (DOM XSS).
**Learning:** Using `append()` with unsanitized strings directly into a DOM node is dangerous if the input can contain HTML payloads, as it will be interpreted as DOM content.
**Prevention:** Always use `document.createTextNode(value)` before appending untrusted data, or use `.textContent` to safely render strings as text content instead of executable HTML.

## 2026-06-24 - Prevent Prototype Injection in testIdMap
**Vulnerability:** The local variable `testIdMap` inside `renderEditorField` was instantiated as a literal object, exposing prototype properties. If the `field` variable could be manipulated to a standard prototype property like `__proto__`, it could lead to unexpected behavior and bypasses.
**Learning:** Even locally scoped dictionaries should be protected against prototype injection if they map dynamic string keys to values.
**Prevention:** Instantiate lookup maps with `Object.assign(Object.create(null), { ... })` when dynamic keys are used for lookups.

## 2026-06-24 - Normalize localStorage projectName
**Vulnerability:** The application loaded `projectName` directly from `localStorage` into state. Even when rendered through safe DOM APIs, unbounded untrusted strings from storage can cause inconsistent state and downstream export issues.
**Learning:** All data loaded from `localStorage` should be treated as untrusted and normalized before assignment to application state.
**Prevention:** Strictly coerce, trim, and length-limit user-controlled string values loaded from storage.

## 2026-06-24 - Filter prototype pollution keys in JSON.parse
**Vulnerability:** Parsed JSON from `localStorage` or seed files could retain keys such as `__proto__`, `constructor`, or `prototype` that become dangerous when later merged into objects.
**Learning:** JSON input is untrusted even in a static app when it comes from local storage or external seed files.
**Prevention:** Use a JSON reviver to filter prototype-pollution keys before parsed data enters application state.

## 2026-06-29 - Neutralize CSV formulas during import
**Vulnerability:** CSV import accepted spreadsheet formula prefixes such as `=`, `+`, `-`, and `@` into state, so a later export could preserve attacker-controlled formula payloads.
**Learning:** CSV formula injection needs defense at both boundaries: exported cells and imported cells that may be re-exported later.
**Prevention:** Normalize imported CSV cells with the same formula neutralization used by CSV export, and keep E2E coverage for import-to-storage formula payloads.

## 2026-06-26 - Eliminate Math.random from task ID generation entirely
**Vulnerability:** Even as a fallback to crypto implementations, `Math.random()` was still present in the application's unique task ID generation `createId` function. Its lack of cryptographic strength leaves it susceptible to predictability vectors.
**Learning:** For client-side static apps, `crypto.randomUUID()` and `crypto.getRandomValues()` cover most modern browsers. If neither is present, generating identifiers without cryptographic entropy risks weak or predictable IDs.
**Prevention:** Avoid relying on `Math.random()` or deterministic fallback counters for any form of unique identifier or security-related randomness. If Web Crypto is unavailable, fail closed rather than generating a weak ID.

## 2026-06-27 - Add timeout to static asset fetches
**Vulnerability:** The application fetched the same-origin static seed asset (`fetch('./wbs.json')`) without a timeout, which could leave startup waiting indefinitely if the network or response body stalled.
**Learning:** Static asset and other network fetches should have a bounded timeout covering both headers and body parsing to reduce client-side denial-of-service risk from stalled responses.
**Prevention:** Use an `AbortController` with a timeout around the complete fetch-and-read operation, and clear the timer in a `finally` block.

## 2026-06-28 - Fail closed when secure task ID generation is unavailable
**Vulnerability:** The ID generation function `createId` still had a non-cryptographic fallback path for environments without the Web Crypto API.
**Learning:** Fallback ID generation must not trade security for availability when the identifier is expected to be unpredictable.
**Prevention:** Prefer `crypto.randomUUID()`, fall back only to `crypto.getRandomValues()`, and throw an explicit error if secure random generation is unavailable.

## 2026-06-29 - Handle localStorage write failures
**Vulnerability:** Client-side storage writes can throw exceptions such as `QuotaExceededError`, interrupting persistence flows and potentially leaving the app in a partially updated state.
**Learning:** Browser storage is a failure-prone boundary even in a local-first static app.
**Prevention:** Wrap `localStorage.setItem` calls in `try...catch` blocks and log bounded errors without breaking the rest of the UI flow.

## 2026-06-29 - Prevent CSV DDE injection via pipe-prefixed formulas
**Vulnerability:** CSV export and import formula neutralization did not treat pipe-prefixed DDE payloads as spreadsheet formulas.
**Learning:** Spreadsheet formula defenses should include less common command-style prefixes such as `|`, not only `=`, `+`, `-`, and `@`.
**Prevention:** Include `|` in the formula prefix pattern so exported and imported CSV cells are neutralized before they can be opened in spreadsheet software.

## 2026-06-30 - Harden generated download links
**Vulnerability:** Dynamically generated download anchors can drift into unsafe patterns if they omit `rel` hardening or call potentially clobberable element methods directly.
**Learning:** Even short-lived DOM nodes should follow the same defensive DOM invocation conventions as longer-lived UI elements.
**Prevention:** Set `rel="noopener noreferrer"` on generated anchors and remove them with `Element.prototype.remove.call(anchor)`.

## 2026-06-29 - Prevent memory exhaustion via long project names
**Vulnerability:** Project names from live input and hydrated localStorage state were not bounded consistently in JavaScript, allowing bypass of HTML-only length constraints.
**Learning:** UI attributes such as `maxlength` are not a security boundary because persisted state and DOM APIs can bypass them.
**Prevention:** Enforce shared string length limits in application logic when handling user input and when hydrating client-side state.

## 2026-06-29 - Bound persisted metadata and report storage failures
**Vulnerability:** Persisted metadata can bypass UI constraints, and localStorage quota failures can silently prevent state from being saved.
**Learning:** Client-side storage is both attacker-controlled input during hydration and a fallible persistence boundary during writes.
**Prevention:** Apply explicit length limits to hydrated metadata and show a bounded user-facing failure message when localStorage writes fail.
## 2024-05-28 - Fix missing input validation on inline progress
**Vulnerability:** Inline progress dropdown update bypassed central sanitization logic.
**Learning:** Event handlers that modify state directly from DOM values must independently validate input.
**Prevention:** Apply validation rules (like ACTUAL_PROGRESS_OPTIONS) at all state mutation boundaries, not just in main form submission.
## 2024-07-11 - Prevent CSV DDE injection via pipe-prefixed formulas in backend audit export
**Vulnerability:** The backend CSV export for audit logs neutralized `=`, `+`, `-`, and `@` but failed to neutralize `|` (pipe) characters, allowing potential DDE (Dynamic Data Exchange) injection if exported logs were opened in spreadsheet software.
**Learning:** Spreadsheet formula defenses must cover all command-style prefixes including `|` across all CSV export boundaries, both frontend and backend.
**Prevention:** Update the sanitization regex in the backend export function to `/^[=+\-@|]/` so that all potentially executable spreadsheet payloads are prefixed with a single quote.

## 2026-07-14 - Replace dynamic RegExp with string methods for parsed inputs
**Learning:** `RegExp` objects built from untrusted or arbitrarily complex inputs (like XML/HTML tags) can be vulnerable to Regular Expression Denial of Service (ReDoS) if the input creates backtracking paths. Security scanners like Semgrep will flag dynamic instantiation of `RegExp` objects.
**Action:** When extracting simple patterns like tag blocks where the boundaries are deterministic, prefer string manipulation functions (`indexOf`, `substring`) over dynamic `RegExp` construction. This eliminates the ReDoS risk entirely and resolves SAST warnings.
