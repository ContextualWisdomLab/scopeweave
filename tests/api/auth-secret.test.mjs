import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const importAuth = (secret) => {
  const env = { ...process.env };
  if (secret === undefined) delete env.SCOPEWEAVE_JWT_SECRET;
  else env.SCOPEWEAVE_JWT_SECRET = secret;

  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./server/auth.mjs')"],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
};

for (const secret of [
  undefined,
  '',
  'x'.repeat(31),
  ' '.repeat(32),
  `${'x'.repeat(31)} `,
  '${SCOPEWEAVE_JWT_SECRET:-}',
]) {
  const result = importAuth(secret);
  assert.notEqual(result.status, 0, 'missing or weak JWT secrets must fail startup');
  assert.match(result.stderr, /SCOPEWEAVE_JWT_SECRET must be set/);
}

assert.equal(
  importAuth('0123456789abcdef0123456789abcdef').status,
  0,
  'a 32-character JWT secret permits startup',
);

const compose = readFileSync('docker-compose.yml', 'utf8');
assert.match(compose, /SCOPEWEAVE_JWT_SECRET:\s*\$\{SCOPEWEAVE_JWT_SECRET:-\}/);
assert.doesNotMatch(compose, /insecure-dev-secret|dev-insecure-secret/);

console.log('✓ JWT secret startup contract tests passed');
