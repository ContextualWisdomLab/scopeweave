import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const packageLock = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
);

const packageName = '@playwright/test';
const declaredVersion = packageJson.devDependencies?.[packageName];
assert.equal(
  typeof declaredVersion,
  'string',
  `${packageName} must remain a direct devDependency`,
);

const lockEntry = packageLock.packages?.[`node_modules/${packageName}`];
assert.ok(lockEntry, `${packageName} must be represented in package-lock.json`);
assert.equal(
  lockEntry.version,
  declaredVersion,
  'Playwright lock version must match package.json',
);
assert.equal(
  lockEntry.resolved,
  `https://registry.npmjs.org/${packageName}/-/test-${declaredVersion}.tgz`,
  'Playwright lock metadata must retain the canonical npm registry tarball URL',
);
assert.match(
  lockEntry.integrity ?? '',
  /^sha512-.+/,
  'Playwright lock entry must retain sha512 integrity metadata',
);

console.log('✓ package lock preserves canonical direct-dependency metadata');
