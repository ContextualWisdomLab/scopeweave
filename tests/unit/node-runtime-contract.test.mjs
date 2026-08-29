import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const databaseSource = readFileSync(new URL('../../server/db.mjs', import.meta.url), 'utf8');

assert.match(
  databaseSource,
  /\bdb\.function\(/,
  'the database bootstrap registers a JavaScript-backed SQLite function',
);
assert.equal(
  packageJson.engines?.node,
  '^22.13.0 || >=23.5.0',
  'the supported Node range must exclude Node 23.4 because DatabaseSync.function starts at Node 23.5 on the 23.x line',
);

console.log('✓ Node runtime contract tests passed');
