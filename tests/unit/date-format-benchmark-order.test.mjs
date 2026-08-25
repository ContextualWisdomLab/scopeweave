import assert from 'node:assert/strict';

import {
  counterbalancedBenchmarkRounds,
  summarizeCounterbalancedMeasurements,
} from '../helpers/date-format-benchmark.mjs';

const rounds = counterbalancedBenchmarkRounds();
assert.deepEqual(
  rounds,
  [
    ['protected-base', 'exact-contributor-head'],
    ['exact-contributor-head', 'protected-base'],
  ],
  'the benchmark must measure each revision once in each execution position',
);

const syntheticSecondRunAdvantage = [
  {
    label: 'protected-base',
    samples: Array(7).fill(10),
    semanticSnapshot: 'same-output',
    checksum: 42,
  },
  {
    label: 'exact-contributor-head',
    samples: Array(7).fill(8),
    semanticSnapshot: 'same-output',
    checksum: 42,
  },
  {
    label: 'exact-contributor-head',
    samples: Array(7).fill(10),
    semanticSnapshot: 'same-output',
    checksum: 42,
  },
  {
    label: 'protected-base',
    samples: Array(7).fill(8),
    semanticSnapshot: 'same-output',
    checksum: 42,
  },
];

const summary = summarizeCounterbalancedMeasurements(syntheticSecondRunAdvantage);
assert.equal(summary.baselineMedianDurationMs, 9);
assert.equal(summary.candidateMedianDurationMs, 9);
assert.equal(
  summary.improvementPercent,
  0,
  'counterbalancing must neutralize an execution-position speedup instead of misattributing it to the candidate',
);
assert.deepEqual(summary.baselineSamples, [
  ...Array(7).fill(10),
  ...Array(7).fill(8),
]);
assert.deepEqual(summary.candidateSamples, [
  ...Array(7).fill(8),
  ...Array(7).fill(10),
]);

console.log('✓ date-format benchmark execution-order regression passed');
