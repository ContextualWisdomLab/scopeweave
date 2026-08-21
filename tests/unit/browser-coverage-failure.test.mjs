// Regression coverage for the browser-coverage failure boundary.
// A failed Playwright run remains the primary failure even if the collector
// encounters a second coverage-processing error while preserving diagnostics.
import assert from 'node:assert/strict';

import { reportCoverageProcessingFailure } from '../../scripts/ci/browser_coverage_failure.mjs';

const secondaryFailure = new Error('coverage evidence is incomplete');
const messages = [];
const preservedStatus = reportCoverageProcessingFailure(
  7,
  secondaryFailure,
  (...parts) => messages.push(parts.map(String).join(' ')),
);

assert.equal(preservedStatus, 7, 'the original Playwright exit status remains authoritative');
assert.equal(messages.length, 2, 'both the primary and secondary failure must be explicit');
assert.match(messages[0], /Browser tests failed with exit status 7/);
assert.match(messages[1], /Browser coverage processing also failed: coverage evidence is incomplete/);

const signalledMessages = [];
assert.equal(
  reportCoverageProcessingFailure(
    null,
    secondaryFailure,
    (...parts) => signalledMessages.push(parts.map(String).join(' ')),
  ),
  1,
  'a signal-terminated Playwright run remains non-passing when no numeric status exists',
);
assert.match(signalledMessages[0], /exit status 1/);

assert.throws(
  () => reportCoverageProcessingFailure(0, secondaryFailure, () => {}),
  (error) => error === secondaryFailure,
  'coverage-processing failures remain fail-closed when Playwright itself passed',
);

console.log('✓ browser coverage failure precedence tests passed');
