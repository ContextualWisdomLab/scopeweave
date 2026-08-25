const BASELINE_LABEL = 'protected-base';
const CANDIDATE_LABEL = 'exact-contributor-head';

/**
 * Return the two benchmark rounds needed to neutralize execution-position bias.
 *
 * Each revision runs once first and once second. This prevents a systematic
 * warm-cache, JIT, thermal, or browser-process advantage from being attributed
 * to whichever revision happens to run second every time.
 *
 * @returns {ReadonlyArray<ReadonlyArray<string>>} Counterbalanced revision labels.
 */
export function counterbalancedBenchmarkRounds() {
  return Object.freeze([
    Object.freeze([BASELINE_LABEL, CANDIDATE_LABEL]),
    Object.freeze([CANDIDATE_LABEL, BASELINE_LABEL]),
  ]);
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('benchmark samples must be a non-empty array');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

/**
 * Aggregate two counterbalanced A/B rounds without losing semantic evidence.
 *
 * @param {Array<{label: string, samples: number[], semanticSnapshot: string, checksum: number}>} measurements
 *   Measurements emitted in the execution order declared by
 *   {@link counterbalancedBenchmarkRounds}.
 * @returns {{baselineSamples: number[], candidateSamples: number[], baselineMedianDurationMs: number, candidateMedianDurationMs: number, improvementPercent: number, semanticSnapshot: string, checksum: number}}
 *   Combined timing and semantic evidence for the protected base and candidate.
 */
export function summarizeCounterbalancedMeasurements(measurements) {
  if (!Array.isArray(measurements) || measurements.length !== 4) {
    throw new Error('counterbalanced benchmark requires exactly four measurements');
  }

  const baselineMeasurements = measurements.filter(({ label }) => label === BASELINE_LABEL);
  const candidateMeasurements = measurements.filter(({ label }) => label === CANDIDATE_LABEL);
  if (baselineMeasurements.length !== 2 || candidateMeasurements.length !== 2) {
    throw new Error('counterbalanced benchmark requires two measurements per revision');
  }

  const reference = measurements[0];
  for (const measurement of measurements) {
    if (!Array.isArray(measurement.samples) || measurement.samples.length === 0) {
      throw new Error(`benchmark measurement ${measurement.label} has no samples`);
    }
    if (measurement.semanticSnapshot !== reference.semanticSnapshot) {
      throw new Error('date-format semantic snapshots differ across benchmark rounds');
    }
    if (measurement.checksum !== reference.checksum) {
      throw new Error('date-format checksums differ across benchmark rounds');
    }
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
    semanticSnapshot: reference.semanticSnapshot,
    checksum: reference.checksum,
  });
}
