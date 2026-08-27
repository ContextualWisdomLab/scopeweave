import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildReleaseArtifactManifest,
  runReleaseArtifactManifestCli,
} from '../../scripts/release/release_artifact_manifest.mjs';

const SOURCE_REVISION = '0123456789abcdef0123456789abcdef01234567';

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

const dir = await mkdtemp(join(tmpdir(), 'scopeweave-release-artifact-race-'));
try {
  const artifactPath = join(dir, 'scopeweave-server.tar');
  const openedArtifactPath = join(dir, 'scopeweave-server.opened.tar');
  const manifestPath = join(dir, 'release-manifest.json');
  await writeFile(artifactPath, 'server-release-artifact');

  const manifest = await buildReleaseArtifactManifest({
    sourceRevision: SOURCE_REVISION,
    artifacts: [{ name: 'server/scopeweave-server.tar', path: artifactPath }],
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  let artifactOpenHookCalls = 0;
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runReleaseArtifactManifestCli({
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
    stdout,
    stderr,
    afterArtifactOpen: async () => {
      artifactOpenHookCalls += 1;
      await rename(artifactPath, openedArtifactPath);
      await writeFile(artifactPath, 'replacement-release-artifact');
    },
  });

  assert.equal(
    artifactOpenHookCalls,
    1,
    'artifact replacement regression must run after the verified artifact is opened',
  );
  assert.equal(exitCode, 2, 'verification must fail closed when the artifact pathname is replaced after open');
  assert.equal(stdout.value(), '');
  assert.deepEqual(JSON.parse(stderr.value()), {
    ok: false,
    error: 'artifact_changed_during_read',
    action: 'rebuild_release_artifacts',
  });
  assert.ok(!stderr.value().includes(dir), 'artifact replacement errors must not disclose build-runner paths');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('release artifact pathname replacement regression passed');
