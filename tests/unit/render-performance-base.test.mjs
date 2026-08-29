import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveBenchmarkBaseSha } from '../helpers/benchmark-base.mjs';

const PR_BASE_SHA = '1111111111111111111111111111111111111111';
const PUSH_BEFORE_SHA = '2222222222222222222222222222222222222222';
const OVERRIDE_SHA = '3333333333333333333333333333333333333333';

function packageScripts() {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return packageJson.scripts;
}

function serverTestsWorkflow() {
  return readFileSync(new URL('../../.github/workflows/server-tests.yml', import.meta.url), 'utf8');
}

test('render benchmark base prefers an explicit immutable override', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: OVERRIDE_SHA,
    event: {
      pull_request: { base: { sha: PR_BASE_SHA } },
      before: PUSH_BEFORE_SHA,
    },
  }), OVERRIDE_SHA);
});

test('render benchmark base uses the pull-request base snapshot', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: '',
    event: { pull_request: { base: { sha: PR_BASE_SHA } } },
  }), PR_BASE_SHA);
});

test('render benchmark base uses the previous protected commit for push runs', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: '',
    event: { before: PUSH_BEFORE_SHA },
  }), PUSH_BEFORE_SHA);
});

test('render benchmark base fails closed without an immutable comparison revision', () => {
  assert.throws(
    () => resolveBenchmarkBaseSha({ override: '', event: {} }),
    /benchmark base SHA is unavailable/i,
  );
});

test('render benchmark base rejects malformed and all-zero revisions', () => {
  for (const sha of ['not-a-sha', '0'.repeat(40)]) {
    assert.throws(
      () => resolveBenchmarkBaseSha({ override: sha, event: {} }),
      /benchmark base SHA is invalid/i,
    );
  }
});

test('local cloud e2e does not require benchmark authority', () => {
  const scripts = packageScripts();

  assert.doesNotMatch(scripts['test:e2e:cloud'], /render-performance\.spec\.js/);
  assert.match(scripts['test:e2e:performance'], /render-performance\.spec\.js/);
});

test('server CI executes the authorized performance benchmark', () => {
  assert.match(
    serverTestsWorkflow(),
    /run:\s*npm run test:e2e:performance\b/,
    'Server Tests must keep the performance benchmark in CI after it is separated from local cloud E2E',
  );
});
