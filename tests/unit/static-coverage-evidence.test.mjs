// Coverage + contract for scripts/ci/static_coverage_evidence.mjs
// Run: node tests/unit/static-coverage-evidence.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
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

// Validate auth timing structural requirements (Sentinel) since this is the designated file for structural checks that aren't hooked up to package.json
import { readFileSync } from 'node:fs';
const appCode = readFileSync(path.join(root, 'server/app.mjs'), 'utf8');
const loginEndpoint = appCode.substring(
  appCode.indexOf("app.post('/api/auth/login'"),
  appCode.indexOf("app.get('/api/me'")
);

assert.ok(
  loginEndpoint.includes("const dummyHash = '0'.repeat(32) + ':' + '0'.repeat(128);") &&
  loginEndpoint.includes("const hashToVerify = u ? u.password_hash : dummyHash;") &&
  loginEndpoint.includes("const isValid = verifyPassword(candidatePassword, hashToVerify);"),
  'Login endpoint must use a dynamic dummy hash and unconditional verifyPassword to prevent user enumeration timing attacks.'
);

console.log('✓ static_coverage_evidence tests passed');
