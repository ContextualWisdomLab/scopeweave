/**
 * Report a browser-coverage processing failure without replacing a failed test run.
 *
 * When Playwright already failed, its exit status remains the authoritative CI
 * result and the later coverage-processing error is emitted as secondary
 * diagnostic evidence. When Playwright passed, the coverage-processing error is
 * rethrown so malformed, incomplete, or unverifiable coverage still fails closed.
 *
 * @param {number|null} testStatus Exit status reported by the Playwright child process.
 * @param {unknown} coverageError Error raised while processing browser coverage evidence.
 * @param {(...parts: unknown[]) => void} [log=console.error] Error logger used for diagnostics.
 * @returns {number} The non-zero Playwright exit status that should remain authoritative.
 * @throws {unknown} The coverage error when Playwright itself completed successfully.
 */
export function reportCoverageProcessingFailure(testStatus, coverageError, log = console.error) {
  if (testStatus === 0) throw coverageError;

  const preservedStatus = Number.isInteger(testStatus) && testStatus !== 0 ? testStatus : 1;
  log(`Browser tests failed with exit status ${preservedStatus}.`);
  const detail = coverageError instanceof Error ? coverageError.message : String(coverageError);
  log(`Browser coverage processing also failed: ${detail}`);
  return preservedStatus;
}
