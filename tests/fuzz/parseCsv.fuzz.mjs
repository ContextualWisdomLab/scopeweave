// Fuzz target: parseCsv — the CSV format handler behind "CSV 가져오기" (import).
// Untrusted input: a user-supplied .csv file (up to 5MB).
//
// Invariants:
//  1. On arbitrary bytes it either throws a plain Error (rejected input) or
//     returns an array of row records — never a non-Error, never a non-array.
//  2. Every cell it accepts has been run through the formula/HTML sanitizer:
//     no accepted cell begins with a spreadsheet-formula lead char, and none
//     contains raw < or > (those must be rejected with an Error instead).
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { app } from './harness.mjs';
import { nastyString, wellHeaderedCsv } from './arbitraries.mjs';
import { assertControlledError } from './assert-helpers.mjs';

const RUNS = Number(process.env.FUZZ_RUNS || 3000);
// Mirror of CSV_FORMULA_PREFIX_PATTERN in app.js: optional leading whitespace
// followed by a spreadsheet-formula lead char. Sanitized cells are prefixed
// with a single quote, so they must NOT match this.
const FORMULA_LEAD = /^\s*[=+\-@|]/;

function checkResult(rows) {
  assert.ok(Array.isArray(rows), 'parseCsv returned a non-array');
  for (const row of rows) {
    assert.equal(typeof row, 'object');
    for (const value of Object.values(row)) {
      if (typeof value !== 'string' || value === '') continue;
      assert.ok(
        !FORMULA_LEAD.test(value),
        `accepted an un-neutralized formula cell: ${JSON.stringify(value)}`
      );
      assert.ok(
        !/[<>]/.test(value),
        `accepted a cell with HTML metacharacters: ${JSON.stringify(value)}`
      );
    }
  }
}

test('parseCsv on fully arbitrary text: array-or-Error, no hang', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), nastyString), (text) => {
      try {
        checkResult(app.parseCsv(text));
      } catch (err) {
        assertControlledError(err, 'parseCsv');
      }
    }),
    { numRuns: RUNS }
  );
});

test('parseCsv on well-headed hostile bodies keeps cell invariants', () => {
  fc.assert(
    fc.property(wellHeaderedCsv, (text) => {
      try {
        checkResult(app.parseCsv(text));
      } catch (err) {
        assertControlledError(err, 'parseCsv');
      }
    }),
    { numRuns: RUNS }
  );
});
