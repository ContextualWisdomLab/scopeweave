import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const checkoutCount = workflow.split('uses: actions/checkout@').length - 1;
const exactHeadRefCount = workflow.split(exactHeadRef).length - 1;

assert.equal(checkoutCount, 2, 'Server Tests must keep its two explicit checkout steps');
assert.equal(
  exactHeadRefCount,
  checkoutCount,
  'every Server Tests checkout must execute the exact pull-request head SHA, not GitHub synthetic merge evidence',
);

console.log('✓ workflow exact-head checkout contract tests passed');
