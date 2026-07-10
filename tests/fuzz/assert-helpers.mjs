// Realm-safe assertion helpers.
//
// The functions under test run inside a `vm` context (see harness.mjs), so any
// error they throw is an instance of THAT realm's Error — cross-realm
// `instanceof Error` returns false. `Object.prototype.toString` tags are
// realm-independent, so we brand-check instead.
import assert from 'node:assert/strict';

export function isError(value) {
  return Object.prototype.toString.call(value) === '[object Error]';
}

// Assert a caught throwable is a genuine Error (any realm) with a message —
// i.e. a controlled rejection, not a bare string / undefined / hang.
export function assertControlledError(err, context = '') {
  assert.ok(isError(err), `${context} threw a non-Error: ${String(err)}`);
  assert.equal(typeof err.message, 'string');
}
