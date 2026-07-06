## 2026-07-06 - Palette UX Enhancements
**Learning:** Adding helpful `title` tooltips to primary footer buttons provides necessary context for users. When making UX improvements, it's critical to avoid modifying files that contain pre-existing security vulnerabilities (like `app.js` in this repository) to prevent blocking the PR in security-gated CI environments.
**Action:** Confine UI metadata additions (like `title` or `aria-label`) to the static HTML files (`index.html`) when the core JavaScript is off-limits due to security scanner constraints.
