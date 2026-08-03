# Cached DOM-template regression verification

## Rendering contract

Cached owner, status, and actual-progress templates must create independent DOM nodes for every rendered task. Cloning must not share mutable state, duplicate identifiers, or break each progress label's association with its select element.

## Regression evidence

`tests/e2e/render-template-clone.spec.js` verifies independent owner and status nodes, unique progress control identifiers, and one-to-one label/select bindings after rendering.

Every synchronized head must rerun the end-to-end, performance-related, and security checks before merge.
