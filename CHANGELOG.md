# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added deterministic PM analysis for requirements/RFI/RFP readiness, WBS
  estimation coverage, dependency risk, and procurement package section checks.
- Preserved PM-analysis research papers, NASA WBS handbook, BCP 14, and JSON
  Schema 2020-12 source documents under `docs/research/pm-analysis/`.
- Added companion dependency-review and OSV workflows so Strix
  manifest-only findings can be verified against authoritative PR-head
  checks.
- Added workflow ownership regression coverage so central review
  workflows stay inherited from `ContextualWisdomLab/.github`, not copied
  into this repository.

### Security

- Made Clearfolio conversion and artifact access fail closed unless a real HTTPS endpoint and tenant-claim HMAC secret are configured. The in-memory successful conversion adapter is restricted to explicit `SCOPEWEAVE_DEV=1`, provider calls are bounded, and untrusted or insecure artifact URLs are rejected.
- Made `SCOPEWEAVE_JWT_SECRET` mandatory at startup and rejected weak or
  unexpanded placeholder values so production deployments fail closed.
- Neutralized audit-log CSV formulas even when executable prefixes are hidden
  behind leading whitespace.
- Replaced dynamic and lazy-regex MS Project XML block extraction with bounded
  linear scans to prevent pathological backtracking on malformed imports.
- Rejected non-string password candidates at the authentication boundary.
- Added regression coverage that prevents array-valued passwords from being
  coerced into valid credentials.
- Updated Hono runtime dependencies to patched supported releases.
