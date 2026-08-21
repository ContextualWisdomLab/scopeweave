# Metric-card explanatory text accessibility

## Status

Active PR evidence only. This record documents the bounded accessibility change on the contributor branch; it does not claim protected `develop` ships this behavior until the PR is integrated.

## Buyer-visible problem

The planner's three summary metric cards exposed calculation explanations only through HTML `title` attributes. That makes the explanation dependent on user-agent tooltip behavior and is not reliably discoverable by sighted keyboard or touch users. Making otherwise static summary cards synthetic tab stops solely to expose those tooltips adds navigation cost without adding an action.

The new visible copy is normal-size text, so it also needs sufficient foreground/background contrast. The original light ends of the plan and actual gradients did not provide the WCAG 2.2 SC 1.4.3 minimum 4.5:1 contrast for the 12 px explanatory text.

## Decision

Keep the metric cards non-interactive and make each explanation persistent visible text inside its card. Do not add `tabindex="0"`, `role="note"`, or any `title` fallback to these static cards merely to surface help text.

This follows the W3C Authoring Practices guidance to prefer visible text and avoid relying on browser fallback naming/description mechanisms. The APG specifically notes that `title` tooltips are not particularly discoverable and are not accessible to visual users who do not use a pointing device. WCAG 2.2 SC 1.4.13 governs author-controlled content that appears on hover or focus; persistent visible explanatory copy avoids introducing an additional hover/focus popup interaction entirely.

For the two accent cards, keep the existing 92% white explanatory foreground but constrain the plan gradient to `#1e40af` → `#2563eb` and the actual gradient to `#065f46` → `#047857`. Browser acceptance coverage samples each rendered gradient and requires at least 4.5:1 contrast for the composited explanatory text, matching WCAG 2.2 SC 1.4.3 for normal text.

If ScopeWeave later needs genuinely supplemental, non-persistent help, it should use an explicit interaction with a reviewed tooltip/disclosure contract rather than making unrelated static content focusable. WAI-ARIA 1.2 describes a tooltip as a contextual popup associated with an owning element, typically shown on hover or owner focus, and recommends linking it with `aria-describedby`.

## TDD traceability

The discoverability regression was committed before the production correction. `tests/e2e/metric-card-explanations.spec.js` requires all three explanations to be visibly rendered, rejects the synthetic `tabindex="0"` and `role="note"`, and rejects the presence of any `title` attribute on these cards rather than checking only one expected title value. The legacy metric-card assertions in `tests/e2e/scopeweave.spec.js` are aligned to the same visible `.meta-description` contract instead of retaining contradictory title-based expectations. The subsequent production correction in `index.html` replaces the tooltip-only contract with persistent `.meta-description` text.

A separate RED contrast regression was added before the gradient correction. It reads the browser-computed description color and gradient stops, composites the alpha foreground over 21 samples across each gradient, and requires the minimum contrast to be at least 4.5:1. `styles.css` then darkens only the two gradient endpoints needed to satisfy that acceptance contract.

Hosted exact-head browser/CI evidence is authoritative. A queued, pending, skipped, stale, predecessor-head, model-only, or otherwise non-terminal result is not promoted to passing evidence.

## Rollback

Rollback reverts the visible descriptions, accessible gradient endpoints, and their regressions together. There is no persisted-data, API, authentication, or schema migration impact.

## References

World Wide Web Consortium. (2023). *Web Content Accessibility Guidelines (WCAG) 2.2*. https://www.w3.org/TR/WCAG22/

World Wide Web Consortium, Web Accessibility Initiative. (2026). *Understanding Success Criterion 1.4.13: Content on hover or focus*. https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html

World Wide Web Consortium, Web Accessibility Initiative. (n.d.). *Providing accessible names and descriptions*. WAI-ARIA Authoring Practices Guide. Retrieved August 15, 2026, from https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/

World Wide Web Consortium. (2023). *Accessible Rich Internet Applications (WAI-ARIA) 1.2*. https://www.w3.org/TR/wai-aria-1.2/
