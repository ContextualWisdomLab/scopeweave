## 2026-05-31 - Add tooltips to icon-only buttons
**Learning:** Icon-only buttons without tooltips lack proper context for some users. Use aria-label for accessible labeling; use title only for visual tooltips and do not rely on it for screen reader labeling. Also ensure tests pass after small HTML modifications.
**Action:** When adding aria-labels to icon buttons, consider adding identical or complementary title attributes to ensure both hover-based tooltips and assistive technology context. Always run `npm run test:e2e` and verify nothing breaks in tests that rely on strict text matchers.
