import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBenchmarkBaseSha } from '../helpers/benchmark-base.mjs';

const PR_BASE_SHA = '1111111111111111111111111111111111111111';
const PUSH_BEFORE_SHA = '2222222222222222222222222222222222222222';
const OVERRIDE_SHA = '3333333333333333333333333333333333333333';

test('benchmark base prefers an explicit immutable override', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: OVERRIDE_SHA,
    event: {
      pull_request: { base: { sha: PR_BASE_SHA } },
      before: PUSH_BEFORE_SHA,
    },
  }), OVERRIDE_SHA);
});

test('benchmark base uses the pull-request base snapshot for pull_request runs', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: '',
    event: { pull_request: { base: { sha: PR_BASE_SHA } } },
  }), PR_BASE_SHA);
});

test('benchmark base uses the previous protected commit for push runs', () => {
  assert.equal(resolveBenchmarkBaseSha({
    override: '',
    event: { before: PUSH_BEFORE_SHA },
  }), PUSH_BEFORE_SHA);
});

test('benchmark base fails closed when no immutable comparison revision exists', () => {
  assert.throws(
    () => resolveBenchmarkBaseSha({ override: '', event: {} }),
    /benchmark base SHA is unavailable/i,
  );
});

test('benchmark base rejects malformed and all-zero revisions', () => {
  for (const sha of ['not-a-sha', '0'.repeat(40)]) {
    assert.throws(
      () => resolveBenchmarkBaseSha({ override: sha, event: {} }),
      /benchmark base SHA is invalid/i,
    );
  }
});
