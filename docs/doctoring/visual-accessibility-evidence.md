# Visual and accessibility evidence

## Status

The repository-local `Visual Accessibility Evidence` workflow captures real Chromium screenshots for the sample, skip-link focus, and empty-plan states on the exact pull-request head. It retains the artifact for three days as release evidence.

## WCAG 2.2 baseline checks

The browser test also verifies the skip link target, keyboard-focusable `main` landmark, labeled WBS search control, scoped table headers, and body foreground/background contrast at the WCAG 2.2 normal-text threshold of 4.5:1. These checks are intentionally limited to deterministic contracts; they do not claim a complete automated accessibility audit.

No Storybook, Figma runtime, axe dependency, or application runtime dependency is needed for this static-hostable product. Design artifacts remain the rendered production page and its retained browser evidence.

## Exact-head and artifact contract

The workflow checks out `github.event.pull_request.head.sha`, verifies `git rev-parse HEAD`, uses no credential persistence, and uploads only the Playwright `test-results` evidence with a three-day retention limit. A failed browser test still retains any screenshots produced before the failure.

## Rollback

Rollback removes the workflow and its test. There is no persisted-data, API, authentication, or schema impact.
