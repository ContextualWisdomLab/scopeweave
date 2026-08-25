import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRevision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim().toLowerCase();

const result = spawnSync(process.execPath, ['scripts/ops/release-evidence.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
assert.equal(result.status, 0, `release evidence CLI failed: ${result.stderr || result.stdout}`);
assert.equal(result.stderr, '');

const report = JSON.parse(result.stdout);
assert.equal(report.schemaVersion, 'scopeweave.release-evidence/v1');
assert.equal(report.sourceRevision, sourceRevision);
assert.equal(report.ready, true);
assert.equal(report.workingTreeClean, true);
assert.equal(report.packageLockConsistent, true);
assert.deepEqual(report.issues, []);

const paths = report.fileEvidence.map((entry) => entry.path);
for (const requiredPath of [
  'PRD.md',
  'TRD.md',
  'docs/OPERABILITY.md',
  'docs/TEST_STRATEGY.md',
  'docs/THREAT_MODEL.md',
  'docs/TRACEABILITY.md',
]) {
  assert.ok(paths.includes(requiredPath), `manifest must include ${requiredPath}`);
}
for (const entry of report.fileEvidence) {
  assert.equal(path.isAbsolute(entry.path), false, 'manifest paths must stay repository-relative');
  assert.equal(Object.hasOwn(entry, 'content'), false, 'manifest must never expose evidence contents');
  if (entry.status === 'present') {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
  }
}

console.log('release evidence CLI acceptance passed');
