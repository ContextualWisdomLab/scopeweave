# Hono dependency security RCA

Status: Proposed until exact-current-head hosted Checks and independent review
complete.

## Failure evidence

`scopeweave#776@e778476d8dfd50e31b6ed7015b40738cbee0bd0d`
failed Security Scan `36805584131`, job `110189111375`. Exact-head Trivy
reported four fixable findings at `package-lock.json:384`:
CVE-2026-84363, CVE-2026-84364, CVE-2026-84365, and CVE-2026-93981.

## Canonical repair and integration

Canonical dependency owner `scopeweave#737@3f7fc0e13731544fe69d4919c07c44e8fb706249`
changes only `package.json` and `package-lock.json`, advancing Hono from 4.13.0
to 4.13.9. Its Server Tests, Security, SAST, and Fuzz Checks are terminal
GREEN; its Draft-skipped CodeQL is not passing evidence.

#776 ordinary-merges that owner as a second parent. Its timing-attack repair
remains unchanged. The dependency contract was run against #776 before the
merge and failed at the 4.13.0 declaration; after integration it requires the
4.13.9 source declaration, root lock declaration, and exact installed lock
entry together.

The resulting exact head must rerun Server Tests, Security, SAST, Fuzz, and
CodeQL. Pending, queued, skipped, or predecessor outcomes do not authorize a
merge.
