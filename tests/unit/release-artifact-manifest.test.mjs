import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReleaseArtifactManifestError,
  buildReleaseArtifactManifest,
  runReleaseArtifactManifestCli,
  verifyReleaseArtifactManifest,
} from '../../scripts/release/release_artifact_manifest.mjs';

const SOURCE_REVISION = '0123456789abcdef0123456789abcdef01234567';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'scopeweave-release-manifest-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function captureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    value() {
      return value;
    },
  };
}

async function expectManifestError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReleaseArtifactManifestError);
    assert.equal(error.code, code);
    return true;
  });
}

await withTempDir(async (dir) => {
  const browserPath = join(dir, 'browser.tar');
  const serverPath = join(dir, 'server.tar');
  await writeFile(browserPath, Buffer.from('browser-artifact\n'));
  await writeFile(serverPath, Buffer.from('server-artifact\n'));

  const artifactInputs = [
    { name: 'server/server.tar', path: serverPath },
    { name: 'browser/browser.tar', path: browserPath },
  ];

  const first = await buildReleaseArtifactManifest({
    sourceRevision: SOURCE_REVISION,
    artifacts: artifactInputs,
  });
  const second = await buildReleaseArtifactManifest({
    sourceRevision: SOURCE_REVISION,
    artifacts: [...artifactInputs].reverse(),
  });

  assert.deepEqual(first, second, 'manifest must be deterministic regardless of input order');
  assert.equal(first.schema_version, 'scopeweave.release_artifact_manifest.v1');
  assert.equal(first.source_revision, SOURCE_REVISION);
  assert.deepEqual(first.artifacts.map((entry) => entry.name), [
    'browser/browser.tar',
    'server/server.tar',
  ]);
  for (const entry of first.artifacts) {
    assert.match(entry.digest.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(entry.byte_length));
    assert.ok(entry.byte_length > 0);
  }
  assert.match(first.manifest_digest.sha256, /^[0-9a-f]{64}$/);

  const verified = await verifyReleaseArtifactManifest({
    manifest: first,
    sourceRevision: SOURCE_REVISION,
    artifacts: artifactInputs,
  });
  assert.deepEqual(verified, {
    ok: true,
    source_revision: SOURCE_REVISION,
    artifact_count: 2,
    manifest_sha256: first.manifest_digest.sha256,
  });

  const reorderedArtifactFields = {
    ...first,
    artifacts: first.artifacts.map((entry) => ({
      digest: { sha256: entry.digest.sha256 },
      byte_length: entry.byte_length,
      name: entry.name,
    })),
  };
  const reorderedVerified = await verifyReleaseArtifactManifest({
    manifest: reorderedArtifactFields,
    sourceRevision: SOURCE_REVISION,
    artifacts: artifactInputs,
  });
  assert.deepEqual(
    reorderedVerified,
    verified,
    'canonical manifest digest must not depend on JSON object key insertion order',
  );

  await writeFile(browserPath, Buffer.from('tampered-browser-artifact\n'));
  await expectManifestError(
    verifyReleaseArtifactManifest({
      manifest: first,
      sourceRevision: SOURCE_REVISION,
      artifacts: artifactInputs,
    }),
    'artifact_digest_mismatch',
  );

  await expectManifestError(
    verifyReleaseArtifactManifest({
      manifest: first,
      sourceRevision: '89abcdef0123456789abcdef0123456789abcdef',
      artifacts: artifactInputs,
    }),
    'source_revision_mismatch',
  );
});

await withTempDir(async (dir) => {
  const targetPath = join(dir, 'target.bin');
  const linkPath = join(dir, 'link.bin');
  await writeFile(targetPath, 'artifact');
  await symlink(targetPath, linkPath);

  await expectManifestError(
    buildReleaseArtifactManifest({
      sourceRevision: SOURCE_REVISION,
      artifacts: [{ name: 'artifact.bin', path: linkPath }],
    }),
    'artifact_symlink_not_allowed',
  );

  await expectManifestError(
    buildReleaseArtifactManifest({
      sourceRevision: SOURCE_REVISION,
      artifacts: [
        { name: 'artifact.bin', path: targetPath },
        { name: 'artifact.bin', path: targetPath },
      ],
    }),
    'artifact_name_duplicate',
  );

  await expectManifestError(
    buildReleaseArtifactManifest({
      sourceRevision: SOURCE_REVISION,
      artifacts: [{ name: '../artifact.bin', path: targetPath }],
    }),
    'artifact_name_invalid',
  );

  await expectManifestError(
    buildReleaseArtifactManifest({
      sourceRevision: 'not-a-git-sha',
      artifacts: [{ name: 'artifact.bin', path: targetPath }],
    }),
    'source_revision_invalid',
  );
});

await withTempDir(async (dir) => {
  const artifactPath = join(dir, 'scopeweave-server.tar');
  const manifestPath = join(dir, 'release-manifest.json');
  await writeFile(artifactPath, 'server-release-artifact');

  const generateOut = captureStream();
  const generateErr = captureStream();
  const generateCode = await runReleaseArtifactManifestCli({
    argv: [
      'generate',
      '--source-revision',
      SOURCE_REVISION,
      '--artifact',
      `server/scopeweave-server.tar=${artifactPath}`,
    ],
    cwd: dir,
    stdout: generateOut,
    stderr: generateErr,
  });
  assert.equal(generateCode, 0);
  assert.equal(generateErr.value(), '');
  const generated = JSON.parse(generateOut.value());
  assert.equal(generated.source_revision, SOURCE_REVISION);
  assert.equal(generated.artifacts.length, 1);
  assert.equal(generated.artifacts[0].name, 'server/scopeweave-server.tar');
  assert.ok(!generateOut.value().includes(dir), 'manifest must not disclose build-runner paths');
  await writeFile(manifestPath, `${JSON.stringify(generated)}\n`);

  const verifyOut = captureStream();
  const verifyErr = captureStream();
  const verifyCode = await runReleaseArtifactManifestCli({
    argv: [
      'verify',
      '--source-revision',
      SOURCE_REVISION,
      '--manifest',
      manifestPath,
      '--artifact',
      `server/scopeweave-server.tar=${artifactPath}`,
    ],
    cwd: dir,
    stdout: verifyOut,
    stderr: verifyErr,
  });
  assert.equal(verifyCode, 0);
  assert.equal(verifyErr.value(), '');
  const verification = JSON.parse(verifyOut.value());
  assert.equal(verification.ok, true);
  assert.equal(verification.source_revision, SOURCE_REVISION);
  assert.equal(verification.artifact_count, 1);

  const malformedOut = captureStream();
  const malformedErr = captureStream();
  const malformedCode = await runReleaseArtifactManifestCli({
    argv: ['generate', '--source-revision', SOURCE_REVISION, '--artifact', `../bad=${artifactPath}`],
    cwd: dir,
    stdout: malformedOut,
    stderr: malformedErr,
  });
  assert.equal(malformedCode, 2);
  assert.equal(malformedOut.value(), '');
  assert.deepEqual(JSON.parse(malformedErr.value()), {
    ok: false,
    error: 'artifact_name_invalid',
    action: 'fix_release_manifest_input',
  });
  assert.ok(!malformedErr.value().includes(dir), 'operator errors must not disclose build-runner paths');

  await writeFile(manifestPath, '{bad json');
  const badManifestOut = captureStream();
  const badManifestErr = captureStream();
  const badManifestCode = await runReleaseArtifactManifestCli({
    argv: [
      'verify',
      '--source-revision',
      SOURCE_REVISION,
      '--manifest',
      manifestPath,
      '--artifact',
      `server/scopeweave-server.tar=${artifactPath}`,
    ],
    cwd: dir,
    stdout: badManifestOut,
    stderr: badManifestErr,
  });
  assert.equal(badManifestCode, 2);
  assert.equal(badManifestOut.value(), '');
  assert.deepEqual(JSON.parse(badManifestErr.value()), {
    ok: false,
    error: 'manifest_json_invalid',
    action: 'regenerate_release_manifest',
  });
});

console.log('release artifact manifest tests passed');
