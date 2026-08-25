import assert from 'node:assert/strict';
import test from 'node:test';

import {
  counterbalancedBenchmarkRounds,
  resolveBenchmarkBaseSha,
  resolveBenchmarkCandidateSha,
  summarizeCounterbalancedSamples,
} from '../helpers/benchmark-base.mjs';

const PR_BASE_SHA = '1111111111111111111111111111111111111111';
const PUSH_BEFORE_SHA = '2222222222222222222222222222222222222222';
const OVERRIDE_SHA = '3333333333333333333333333333333333333333';
const PR_HEAD_SHA = '4444444444444444444444444444444444444444';
const PUSH_AFTER_SHA = '5555555555555555555555555555555555555555';
const HEAD_OVERRIDE_SHA = '6666666666666666666666666666666666666666';

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

test('benchmark candidate prefers an explicit immutable override', () => {
  assert.equal(resolveBenchmarkCandidateSha({
    override: HEAD_OVERRIDE_SHA,
    event: {
      pull_request: { head: { sha: PR_HEAD_SHA } },
      after: PUSH_AFTER_SHA,
    },
  }), HEAD_OVERRIDE_SHA);
});

test('benchmark candidate uses the pull-request contributor head for pull_request runs', () => {
  assert.equal(resolveBenchmarkCandidateSha({
    override: '',
    event: { pull_request: { head: { sha: PR_HEAD_SHA } } },
  }), PR_HEAD_SHA);
});

test('benchmark candidate uses the pushed commit for push runs', () => {
  assert.equal(resolveBenchmarkCandidateSha({
    override: '',
    event: { after: PUSH_AFTER_SHA },
  }), PUSH_AFTER_SHA);
});

test('benchmark candidate fails closed instead of trusting the workflow worktree', () => {
  assert.throws(
    () => resolveBenchmarkCandidateSha({ override: '', event: {} }),
    /benchmark candidate SHA is unavailable/i,
  );
});

test('benchmark candidate rejects malformed and all-zero revisions', () => {
  for (const sha of ['not-a-sha', '0'.repeat(40)]) {
    assert.throws(
      () => resolveBenchmarkCandidateSha({ override: sha, event: {} }),
      /benchmark candidate SHA is invalid/i,
    );
  }
});

test('benchmark order measures each revision once in each execution position', () => {
  assert.deepEqual(counterbalancedBenchmarkRounds(), [
    ['protected-base', 'candidate'],
    ['candidate', 'protected-base'],
  ]);
});

test('counterbalanced timing neutralizes a systematic second-run advantage', () => {
  const measurements = [
    { label: 'protected-base', samples: Array(7).fill(10) },
    { label: 'candidate', samples: Array(7).fill(8) },
    { label: 'candidate', samples: Array(7).fill(10) },
    { label: 'protected-base', samples: Array(7).fill(8) },
  ];

  const summary = summarizeCounterbalancedSamples(measurements);
  assert.deepEqual(summary.baselineSamples, [
    ...Array(7).fill(10),
    ...Array(7).fill(8),
  ]);
  assert.deepEqual(summary.candidateSamples, [
    ...Array(7).fill(8),
    ...Array(7).fill(10),
  ]);
  assert.equal(summary.baselineMedianDurationMs, 9);
  assert.equal(summary.candidateMedianDurationMs, 9);
  assert.equal(
    summary.improvementPercent,
    0,
    'execution-position speedup must not be misattributed to the candidate',
  );
});
