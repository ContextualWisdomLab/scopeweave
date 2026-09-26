# Product and technical gap baseline

## Dependency security owner

Status: **Proposed** on open PR #737. This document does not describe a
protected-branch release.

The central `Security Scan / trivy-fs` run for webhook hardening PR #753 at
exact head `a03e84a9baf24f81b55b20d219fcd1ff25b4cf7a` reported three inherited
findings in `package-lock.json`:

- CVE-2026-84363 (Hono, medium);
- CVE-2026-84364 (Hono, medium);
- CVE-2026-84365 (Hono, medium).

The webhook delta did not change dependencies. Canonical dependency owner #737
raises Hono from 4.13.0 to 4.13.8 in both `package.json` and
`package-lock.json`. Downstream PR #753 adopts that owner through an ordinary
two-parent commit and differs from the owner in only its webhook source and API
regression fixture. This keeps dependency responsibility single-writer while
preserving the complete consumer delta.

Local owner-plus-consumer verification passed the API suite, the complete unit
suite, and `npm audit --omit=dev` with zero reported vulnerabilities. Fresh
exact-head hosted Security, CodeQL, SAST, server, fuzz, and independent-review
evidence remains required. Queued, skipped, cancelled, or absent checks are not
success.

## Follow-up

- Merge #737 only after its exact head is terminal GREEN and independently
  approved.
- Revalidate #753 at its current head after the owner result is published.
- Keep webhook URL validation, DNS resolution, and connect-time destination
  enforcement as separate runtime security evidence; a dependency update does
  not by itself prove the SSRF boundary.
