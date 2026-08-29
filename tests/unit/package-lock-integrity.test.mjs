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

const yargsParserVersion = '22.0.0';
const yargsParserLockEntry =
  packageLock.packages?.['node_modules/yargs/node_modules/yargs-parser'];
assert.ok(
  yargsParserLockEntry,
  'nested yargs-parser must remain represented in package-lock.json',
);
assert.equal(
  yargsParserLockEntry.version,
  yargsParserVersion,
  'nested yargs-parser lock version must remain pinned to the installed version',
);
assert.equal(
  yargsParserLockEntry.resolved,
  `https://registry.npmjs.org/yargs-parser/-/yargs-parser-${yargsParserVersion}.tgz`,
  'nested yargs-parser lock metadata must retain the canonical npm registry tarball URL',
);
assert.match(
  yargsParserLockEntry.integrity ?? '',
  /^sha512-.+/,
  'nested yargs-parser lock entry must retain sha512 integrity metadata',
);
assert.equal(
  yargsParserLockEntry.license,
  'ISC',
  'yargs-parser 22.0.0 lock metadata must retain its published ISC license',
);

console.log('✓ package lock preserves canonical direct-dependency metadata');
