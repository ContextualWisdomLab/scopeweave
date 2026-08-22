import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((path) => path.trim())
  .filter(Boolean);

const mergeArtifacts = trackedFiles.filter(
  (path) => path.endsWith('.orig') || /^fix-[^/]+\.patch$/u.test(path),
);
assert.deepEqual(
  mergeArtifacts,
  [],
  `tracked merge/patch artifacts must be removed: ${mergeArtifacts.join(', ')}`,
);

if (existsSync('.trivyignore')) {
  const lines = readFileSync('.trivyignore', 'utf8').split(/\r?\n/u);
  const undocumentedEntries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index].trim();
    if (!entry || entry.startsWith('#')) continue;
    const preceding = index > 0 ? lines[index - 1].trim() : '';
    if (!preceding.startsWith('#') || preceding.length <= 1) {
      undocumentedEntries.push(entry);
    }
  }
  assert.deepEqual(
    undocumentedEntries,
    [],
    `Trivy suppressions require an adjacent rationale comment: ${undocumentedEntries.join(', ')}`,
  );
}

console.log('repository hygiene unit test passed');
