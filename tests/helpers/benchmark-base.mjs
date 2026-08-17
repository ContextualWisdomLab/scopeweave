const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ZERO_COMMIT_SHA = '0'.repeat(40);

function canonicalCommitSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(sha) || sha === ZERO_COMMIT_SHA) {
    throw new Error(`Benchmark base SHA is invalid: ${sha || '<missing>'}`);
  }
  return sha;
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
