// Coverage + contract for scripts/ci/static_coverage_evidence.mjs
// Run: node tests/unit/static-coverage-evidence.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsSync from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts/ci/static_coverage_evidence.mjs');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// Happy path used by check:python-docstrings / OpenCode docstring gate.
const ok = run(['docstrings']);
assert.equal(ok.status, 0, `docstrings exit: ${ok.status}\n${ok.stderr}`);
assert.match(ok.stdout, /not applicable/i, 'docstrings path prints N/A message');

// Usage / invalid mode must fail closed (covers the else branch).
const bad = run(['coverage']);
assert.equal(bad.status, 2, 'invalid mode → exit 2');
assert.match(bad.stderr, /Usage: static_coverage_evidence\.mjs docstrings/);

const missing = run([]);
assert.equal(missing.status, 2, 'missing mode → exit 2');

// ⚡ Bolt: Verify setTableBodyRows uses createDocumentFragment to prevent Maximum Call Stack
{
  const appJsPath = path.join(root, 'app.js');
  const source = fsSync.readFileSync(appJsPath, 'utf8');
  assert.ok(source.includes('const fragment = document.createDocumentFragment();'), 'setTableBodyRows must use DocumentFragment');
  assert.ok(!source.includes('elements.tableBody.replaceChildren(...rows)'), 'setTableBodyRows must not spread large arrays');
}

console.log('✓ static_coverage_evidence tests passed');
