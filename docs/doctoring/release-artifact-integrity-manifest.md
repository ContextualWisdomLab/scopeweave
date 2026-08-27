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

The verifier fails closed when the source revision, artifact set, artifact bytes, lengths, manifest schema, or manifest self-digest differ. Artifact logical names are bounded relative identifiers, duplicate names are rejected, and symlink inputs are rejected so a manifest cannot silently describe a redirected filesystem target. Manifest and artifact verification bind reads to opened file handles and compare their file identity/metadata with the pathname before accepting the result, including a second pathname identity check after artifact hashing. The manifest records logical names only and never records local build-runner paths.

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

Success prints a small machine-readable receipt containing `ok`, `source_revision`, `artifact_count`, and `manifest_sha256`. Deterministic failures return exit code `2` with a stable `error` and an operator-oriented `action`; local filesystem paths and raw filesystem exception text are not emitted. An `artifact_changed_during_read` result directs the operator to rebuild the release artifacts rather than retrying against a potentially replaced pathname.

## Threat and failure notes

- **Artifact replacement after build:** digest verification fails.
- **Artifact pathname replacement during verification:** the verifier hashes the opened handle, compares its identity with the live pathname after open and again after hashing, and fails closed with `artifact_changed_during_read` if the pathname no longer resolves to that same file.
- **Manifest pathname replacement during verification:** manifest JSON is read from the opened handle, and pathname identity is checked after open and after read; replacement fails closed as `manifest_file_invalid`.
- **Source/artifact mix-up:** exact source-revision comparison fails.
- **Manifest field tampering:** the manifest self-digest fails unless the attacker can also replace the entire unsigned manifest; signed provenance remains the authority for authenticity.
- **Symlink substitution:** direct symlink inputs are rejected with `O_NOFOLLOW` where the platform exposes it, in addition to file-type and identity checks.
- **Missing/extra artifacts:** verification requires an identical named artifact set.
- **Runner-path disclosure:** only logical artifact names are serialized; error envelopes use stable codes rather than raw filesystem messages.
- **Maliciously large manifest input:** verify-mode manifest JSON is bounded to 1 MiB before parsing.

## Verification evidence required for PR #616

The repository regression history now includes multiple real RED→GREEN stages rather than relying on assertion-only success:

- the initial contract was introduced RED before the production module existed and then implemented;
- predecessor RED `ec720063c5bf540671e3969289295e87e8ba0a19` demonstrated that manifest self-digest verification depended on nested artifact-object key insertion order; its production fix canonicalized the digest payload;
- predecessor RED `d3018a44d55a8ce6fadda67a6b53315ab289904a` registered the artifact-path replacement regression in normal unit/coverage execution and failed Server Tests run `33072327214`, `unit-and-api` job `98517475339`, because the artifact-open seam was not invoked (`0 !== 1`);
- production repair `ea9472e90bdb9de1365f69e385aeb98bdedb0178` wires the artifact-open seam through verification, checks live pathname identity around the opened handle, and maps a detected replacement to `rebuild_release_artifacts`; and
- hosted Server Tests run `33073885033`, `unit-and-api` job `98522928574`, is GREEN and explicitly records `release artifact pathname replacement regression passed`; cloud E2E, Fuzz, Dependency Review, OSV, Security Scan, and SAST are also run-level GREEN on the same pull-request event.

That hosted GREEN is **behavioral evidence, not exact-head merge authority**: Server Tests checked out synthetic merge `623d5765181ae52d133313f4bf942141932aad9d`, not immutable contributor head `ea9472e90bdb9de1365f69e385aeb98bdedb0178`. PR #523 owns the ScopeWeave exact-head Server Tests/100%-owned-coverage control and `ContextualWisdomLab/.github#1222` owns the reusable central SAST/Security exact-head defect. PR #616 must remain Draft until those controls protect and regenerate authoritative evidence on one unchanged exact contributor head, all public exports retain beginner-readable JSDoc, valid current-head review findings are zero, and the live independent-approval requirement is satisfied.

## References (APA 7th)

GitHub. (2026). *Using artifact attestations to establish provenance for builds*. GitHub Docs. https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

Supply-chain Levels for Software Artifacts. (2025). *SLSA specification (Version 1.2)*. The Linux Foundation. https://slsa.dev/spec/v1.2/

Supply-chain Levels for Software Artifacts. (2025). *Provenance (SLSA specification Version 1.2)*. The Linux Foundation. https://slsa.dev/spec/v1.2/provenance
