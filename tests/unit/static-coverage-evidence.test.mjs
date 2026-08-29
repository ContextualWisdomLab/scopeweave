// Coverage + contract for scripts/ci/static_coverage_evidence.mjs
// Run: node tests/unit/static-coverage-evidence.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts/ci/static_coverage_evidence.mjs');

function run(args, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

// Happy path used by check:python-docstrings / OpenCode docstring gate.
const ok = run(['docstrings']);
assert.equal(ok.status, 0, `docstrings exit: ${ok.status}\n${ok.stderr}`);
assert.match(ok.stdout, /not applicable/i, 'docstrings path prints N/A message');

// The fail-closed branch must detect tracked runtime Python, while allowing
// explicitly scoped CI/test helpers. A temporary index exercises the same
// git-ls-files contract without mutating the real working tree.
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'scopeweave-docstrings-'));
try {
  mkdirSync(path.join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'tests', 'config'), { recursive: true });
  writeFileSync(path.join(fixtureRoot, 'runtime.py'), 'def runtime():\n    return 1\n');
  writeFileSync(path.join(fixtureRoot, 'scripts', 'ci', 'helper.py'), 'def helper():\n    return 1\n');
  writeFileSync(path.join(fixtureRoot, 'tests', 'config', 'fixture.py'), 'VALUE = 1\n');
  git(['init', '--quiet'], fixtureRoot);
  git(['add', 'runtime.py', 'scripts/ci/helper.py', 'tests/config/fixture.py'], fixtureRoot);

  const runtimePython = run(['docstrings'], fixtureRoot);
  assert.equal(runtimePython.status, 1, 'tracked runtime Python fails the applicability gate closed');
  assert.match(runtimePython.stderr, /runtime\.py/);
  assert.doesNotMatch(runtimePython.stderr, /scripts\/ci\/helper\.py/);
  assert.doesNotMatch(runtimePython.stderr, /tests\/config\/fixture\.py/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// Usage / invalid mode must fail closed (covers the else branch).
const bad = run(['coverage']);
assert.equal(bad.status, 2, 'invalid mode → exit 2');
assert.match(bad.stderr, /Usage: static_coverage_evidence\.mjs docstrings/);

const missing = run([]);
assert.equal(missing.status, 2, 'missing mode → exit 2');

console.log('✓ static_coverage_evidence tests passed');
