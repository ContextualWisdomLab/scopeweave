# Summary-card keyboard accessibility verification

## Accessibility contract

Every summary metric card that exposes explanatory text must be keyboard focusable, present a visible `:focus-visible` indicator, and reference explicit assistive text through `aria-describedby`.

## Regression evidence

`tests/unit/meta-card-accessibility.test.mjs` binds each metric to its own card and verifies the focusability and accessible-description relationship. `tests/e2e/summary-card-keyboard-tooltip.spec.js` verifies keyboard focus and a visible outline in Chromium.

Every synchronized head must rerun the unit, end-to-end, accessibility, and security checks before merge.
