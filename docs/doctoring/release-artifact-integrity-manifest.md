# Release artifact integrity manifest

## Status

**Active PR only; not protected-shipped truth.** This control is introduced by ScopeWeave PR #616. Protected `develop` does not contain it until normal reviewed integration completes.

## Decision and scope

ScopeWeave release candidates need a deterministic receipt that answers a narrow operator question before a tag or release is created: **do these exact built artifact bytes still match the exact source revision they were produced from?**

`scripts/release/release_artifact_manifest.mjs` generates an unsigned JSON manifest containing:

- schema version `scopeweave.release_artifact_manifest.v1`;
- one exact 40-hex Git source revision;
- a sorted set of operator-assigned logical artifact names;
- the byte length and SHA-256 digest of each regular artifact file; and
- a SHA-256 self-digest over the canonical unsigned manifest payload.

The verifier fails closed when the source revision, artifact set, artifact bytes, lengths, manifest schema, or manifest self-digest differ. Artifact logical names are bounded relative identifiers, duplicate names are rejected, and symlink inputs are rejected so a manifest cannot silently describe a redirected filesystem target. The manifest records logical names only and never records local build-runner paths.

## What this control proves—and what it does not

A successful verification is **integrity evidence**, not provenance authentication. It proves that the locally supplied files still hash to the values bound into the supplied manifest and that the manifest names one exact source revision. It does **not** prove who built the files, which workflow produced them, that the named source revision was actually used by a trusted builder, or that the manifest itself was signed by an authorized identity.

Accordingly, do not use the manifest to claim a SLSA level, signed provenance, SOC 2 compliance, certification, or trustworthy-builder identity. SLSA v1.2 defines provenance as verifiable information about where, when, and how an artifact was produced, and GitHub artifact attestations provide cryptographically verifiable build-provenance/SBOM claims for artifacts produced in GitHub Actions. ScopeWeave's local manifest is intentionally complementary: it provides deterministic byte/source binding that can be checked before the independent provenance gate.

## Release decision contract

A release operator should proceed only when all of the following are true on the **same integrated protected revision**:

1. normal protected-branch review, required checks, security gates, coverage/docstrings, migration/recovery, accessibility, compatibility, package/build, and operational acceptance are passing for that revision;
2. release artifacts are built from that exact protected revision;
3. an artifact manifest is generated for every artifact that will be distributed;
4. the manifest verifies against the unchanged artifacts and the same exact source revision;
5. applicable GitHub/SLSA artifact provenance and SBOM attestations are generated and independently verified; and
6. source/artifact hashes recorded in the release evidence match the assets that are actually published.

A failed manifest verification is a **stop-release** signal. Rebuild the artifact set or regenerate the manifest from the correct unchanged artifacts; do not edit digest fields by hand to make verification pass.

## Operator examples

Generate a manifest from built artifacts and redirect the deterministic JSON to an evidence file:

```bash
npm run ops:release-manifest -- generate \
  --source-revision "$(git rev-parse HEAD)" \
  --artifact browser/scopeweave-static.tar=dist/scopeweave-static.tar \
  --artifact server/scopeweave-server.tar=dist/scopeweave-server.tar \
  > release-artifact-manifest.json
```

Verify the same bytes before publication:

```bash
npm run ops:release-manifest -- verify \
  --source-revision "$(git rev-parse HEAD)" \
  --manifest release-artifact-manifest.json \
  --artifact browser/scopeweave-static.tar=dist/scopeweave-static.tar \
  --artifact server/scopeweave-server.tar=dist/scopeweave-server.tar
```

Success prints a small machine-readable receipt containing `ok`, `source_revision`, `artifact_count`, and `manifest_sha256`. Deterministic failures return exit code `2` with a stable `error` and an operator-oriented `action`; local filesystem paths and raw filesystem exception text are not emitted.

## Threat and failure notes

- **Artifact replacement after build:** digest verification fails.
- **Source/artifact mix-up:** exact source-revision comparison fails.
- **Manifest field tampering:** the manifest self-digest fails unless the attacker can also replace the entire unsigned manifest; signed provenance remains the authority for authenticity.
- **Symlink substitution:** direct symlink inputs are rejected, and the hashing boundary compares file identity/metadata before and after the read to detect mutation during hashing.
- **Missing/extra artifacts:** verification requires an identical named artifact set.
- **Runner-path disclosure:** only logical artifact names are serialized; error envelopes use stable codes rather than raw filesystem messages.
- **Maliciously large manifest input:** verify-mode manifest JSON is bounded to 1 MiB before parsing.

## Verification evidence required for PR #616

The repository regression must preserve a real RED→GREEN history:

- RED: the registered unit job fails while the production manifest module is absent;
- GREEN: the same registered unit job passes on the implementation head;
- realistic tests cover deterministic ordering, tampering, source mismatch, symlink rejection, duplicate/traversal-style names, CLI generate/verify, path non-disclosure, and malformed manifest JSON;
- the production module remains registered in owned `c8` coverage execution and all public exports retain beginner-readable JSDoc; and
- exact-current-head repository, security, dependency/supply-chain, browser, review, and live-governance evidence is re-fetched before integration.

## References (APA 7th)

GitHub. (2026). *Using artifact attestations to establish provenance for builds*. GitHub Docs. https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

Supply-chain Levels for Software Artifacts. (2025). *SLSA specification (Version 1.2)*. The Linux Foundation. https://slsa.dev/spec/v1.2/

Supply-chain Levels for Software Artifacts. (2025). *Provenance (SLSA specification Version 1.2)*. The Linux Foundation. https://slsa.dev/spec/v1.2/provenance
