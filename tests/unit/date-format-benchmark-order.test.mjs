import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  counterbalancedBenchmarkRounds,
  stableBenchmarkChecksum,
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

assert.equal(
  stableBenchmarkChecksum([42, 42, 42, 42]),
  42,
  'an even number of stable samples must preserve the semantic checksum instead of cancelling to zero',
);
assert.throws(
  () => stableBenchmarkChecksum([42, 42, 43, 42]),
  /checksum changed between samples/i,
  'the benchmark must fail closed if one timed run produces different semantic evidence',
);

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const benchmarkSpec = readFileSync(
  new URL('../e2e/date-format-performance.spec.js', import.meta.url),
  'utf8',
);
assert.match(
  packageJson.scripts['test:e2e'],
  /--grep-invert\s+["']?@benchmark["']?/u,
  'the ordinary offline e2e command must exclude network-dependent benchmark tests',
);
assert.match(
  benchmarkSpec,
  /test\(['"]@benchmark\b/u,
  'the network-dependent performance acceptance test must carry the benchmark marker excluded by ordinary e2e runs',
);
assert.match(
  packageJson.scripts['test:e2e:cloud'],
  /date-format-performance\.spec\.js/u,
  'the protected cloud e2e path must continue to run the benchmark explicitly',
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
