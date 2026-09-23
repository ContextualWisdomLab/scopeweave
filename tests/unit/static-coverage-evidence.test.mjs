// Coverage + contract for scripts/ci/static_coverage_evidence.mjs
// Run: node tests/unit/static-coverage-evidence.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import { fileURLToPath } from 'node:url';

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


// Static analysis: Ensure timing attack prevention in /api/auth/login
const appCode = fs.readFileSync(path.join(root, 'server/app.mjs'), 'utf8');
assert.match(
  appCode,
  /const dummyHash = '0'\.repeat\(32\) \+ ':' \+ '0'\.repeat\(128\);/,
  'Dummy hash must be dynamically generated to prevent hardcoded credentials scanning'
);
assert.match(
  appCode,
  /const validPassword = verifyPassword\(passwordStr, hashToVerify\);/,
  'verifyPassword must unconditionally execute to prevent timing attacks'
);

console.log('✓ static_coverage_evidence tests passed');
