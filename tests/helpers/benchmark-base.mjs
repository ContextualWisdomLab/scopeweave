const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ZERO_COMMIT_SHA = '0'.repeat(40);
const BASELINE_LABEL = 'protected-base';
const CANDIDATE_LABEL = 'candidate';

function canonicalCommitSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(sha) || sha === ZERO_COMMIT_SHA) {
    throw new Error(`Benchmark ${label} SHA is invalid: ${sha || '<missing>'}`);
  }
  return sha;
}

function canonicalBranchRef(value) {
  const branchRef = String(value || '').trim();
  if (!branchRef || branchRef.length > 255 || /[\u0000-\u001f\u007f]/u.test(branchRef)) {
    throw new Error(`Benchmark base ref is invalid: ${branchRef || '<missing>'}`);
  }
  return branchRef;
}

function eventObject(event) {
  return event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
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
  if (explicit) return canonicalCommitSha(explicit, 'base');

  const sourceEvent = eventObject(event);
  const pullRequestBase = sourceEvent.pull_request?.base?.sha;
  if (pullRequestBase) return canonicalCommitSha(pullRequestBase, 'base');

  const pushBefore = sourceEvent.before;
  if (pushBefore) return canonicalCommitSha(pushBefore, 'base');

  throw new Error('Benchmark base SHA is unavailable; provide an immutable comparison revision.');
}

/**
 * Resolve a benchmark base and prove a pull request still targets that live tip.
 *
 * GitHub pull-request events are snapshots. A long-running or queued benchmark
 * must not claim a protected-base comparison after that branch has advanced.
 * For pull requests this helper independently resolves the live base branch and
 * requires it to equal the event snapshot (and any explicit override). Push
 * runs intentionally preserve `event.before` semantics because the live branch
 * already points at `event.after` once the push workflow starts.
 *
 * @param {{override?: unknown, event?: unknown, readLiveBaseSha?: ((baseRef: string) => unknown)}} input benchmark authority input
 * @returns {string} verified immutable comparison SHA
 */
export function resolveVerifiedBenchmarkBaseSha({ override, event, readLiveBaseSha } = {}) {
  const sourceEvent = eventObject(event);
  const pullRequestBase = sourceEvent.pull_request?.base;
  if (!pullRequestBase) {
    return resolveBenchmarkBaseSha({ override, event: sourceEvent });
  }

  const eventBaseSha = canonicalCommitSha(pullRequestBase.sha, 'base');
  const baseRef = canonicalBranchRef(pullRequestBase.ref);
  if (typeof readLiveBaseSha !== 'function') {
    throw new Error('Benchmark live protected-base resolver is unavailable for a pull request.');
  }

  const liveBaseSha = canonicalCommitSha(readLiveBaseSha(baseRef), 'live base');
  if (liveBaseSha !== eventBaseSha) {
    throw new Error(
      `Protected base moved from ${eventBaseSha} to ${liveBaseSha}; regenerate benchmark against fresh ${baseRef}.`,
    );
  }

  const explicit = String(override || '').trim();
  if (explicit) {
    const overrideSha = canonicalCommitSha(explicit, 'base override');
    if (overrideSha !== liveBaseSha) {
      throw new Error(
        `Benchmark base override ${overrideSha} does not match live protected base ${liveBaseSha}.`,
      );
    }
  }
  return liveBaseSha;
}

/**
 * Resolve the immutable candidate revision whose performance is being claimed.
 *
 * Pull-request runs use the submitted contributor head rather than the workflow
 * worktree, because GitHub may check out a synthetic merge commit. Protected
 * pushes use the event's `after` revision. Operators can supply an explicit
 * immutable override when replaying the benchmark deliberately.
 *
 * @param {{override?: unknown, event?: unknown}} input benchmark candidate input
 * @returns {string} canonical 40-character candidate commit SHA
 */
export function resolveBenchmarkCandidateSha({ override, event } = {}) {
  const explicit = String(override || '').trim();
  if (explicit) return canonicalCommitSha(explicit, 'candidate');

  const sourceEvent = eventObject(event);
  const pullRequestHead = sourceEvent.pull_request?.head?.sha;
  if (pullRequestHead) return canonicalCommitSha(pullRequestHead, 'candidate');

  const pushAfter = sourceEvent.after;
  if (pushAfter) return canonicalCommitSha(pushAfter, 'candidate');

  throw new Error('Benchmark candidate SHA is unavailable; provide an immutable candidate revision.');
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
