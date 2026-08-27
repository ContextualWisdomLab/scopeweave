import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const consoleLogBeforeImport = console.log;

await import('../../server/app.mjs');

assert.strictEqual(
  console.log,
  consoleLogBeforeImport,
  'importing the ScopeWeave facade must not replace process-wide console.log',
);

console.log('console observability boundary regression passed');
