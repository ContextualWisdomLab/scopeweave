const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ZERO_COMMIT_SHA = '0'.repeat(40);
const BASELINE_LABEL = 'protected-base';
const CANDIDATE_LABEL = 'candidate';

function canonicalCommitSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(sha) || sha === ZERO_COMMIT_SHA) {
    throw new Error(`Benchmark base SHA is invalid: ${sha || '<missing>'}`);
  }
  return sha;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Benchmark samples must be a non-empty array.');
  }
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Benchmark samples must contain only positive finite durations.');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

/**
 * Resolve the immutable revision that a performance run must compare against.
 *
 * Pull-request runs compare to the PR base snapshot that triggered the run.
 * Protected-branch push runs compare to the immediately previous protected
 * commit from the push event. Operators may provide an explicit immutable SHA
 * when replaying the benchmark outside those GitHub event shapes.
 *
 * @param {{override?: unknown, event?: unknown}} input benchmark authority input
 * @returns {string} canonical 40-character commit SHA
 */
export function resolveBenchmarkBaseSha({ override, event } = {}) {
  const explicit = String(override || '').trim();
  if (explicit) return canonicalCommitSha(explicit);

  const eventObject = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const pullRequestBase = eventObject.pull_request?.base?.sha;
  if (pullRequestBase) return canonicalCommitSha(pullRequestBase);

  const pushBefore = eventObject.before;
  if (pushBefore) return canonicalCommitSha(pushBefore);

  throw new Error('Benchmark base SHA is unavailable; provide an immutable comparison revision.');
}

/**
 * Return two benchmark rounds that reverse which revision executes first.
 *
 * A browser process, JIT, operating-system cache, or runner can make the second
 * measurement systematically faster. Running each revision once first and once
 * second prevents that position effect from being credited to one revision.
 *
 * @returns {ReadonlyArray<ReadonlyArray<string>>} execution labels for both rounds
 */
export function counterbalancedBenchmarkRounds() {
  return Object.freeze([
    Object.freeze([BASELINE_LABEL, CANDIDATE_LABEL]),
    Object.freeze([CANDIDATE_LABEL, BASELINE_LABEL]),
  ]);
}

/**
 * Combine timing samples from the two counterbalanced benchmark rounds.
 *
 * Exactly two measurements are required for each revision. The returned median
 * handles the resulting even sample count by averaging the two middle values,
 * then reports the candidate improvement relative to the protected baseline.
 *
 * @param {Array<{label: string, samples: number[]}>} measurements four timed measurements
 * @returns {{baselineSamples: number[], candidateSamples: number[], baselineMedianDurationMs: number, candidateMedianDurationMs: number, improvementPercent: number}} combined timing evidence
 */
export function summarizeCounterbalancedSamples(measurements) {
  if (!Array.isArray(measurements) || measurements.length !== 4) {
    throw new Error('Counterbalanced benchmark requires exactly four measurements.');
  }

  const baselineMeasurements = measurements.filter(({ label }) => label === BASELINE_LABEL);
  const candidateMeasurements = measurements.filter(({ label }) => label === CANDIDATE_LABEL);
  if (baselineMeasurements.length !== 2 || candidateMeasurements.length !== 2) {
    throw new Error('Counterbalanced benchmark requires two measurements per revision.');
  }

  for (const measurement of measurements) {
    median(measurement.samples);
  }

  const baselineSamples = baselineMeasurements.flatMap(({ samples }) => samples);
  const candidateSamples = candidateMeasurements.flatMap(({ samples }) => samples);
  const baselineMedianDurationMs = median(baselineSamples);
  const candidateMedianDurationMs = median(candidateSamples);
  const improvementPercent = (
    (baselineMedianDurationMs - candidateMedianDurationMs)
    / baselineMedianDurationMs
  ) * 100;

  return Object.freeze({
    baselineSamples,
    candidateSamples,
    baselineMedianDurationMs,
    candidateMedianDurationMs,
    improvementPercent,
  });
}
