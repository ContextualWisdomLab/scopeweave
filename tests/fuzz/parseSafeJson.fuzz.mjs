// Fuzz target: parseSafeJson — the JSON deserializer used for both the
// persisted localStorage state and the fetched wbs.json seed. Untrusted input.
//
// Invariants:
//  1. On ANY string it either returns a value or throws a SyntaxError — never a
//     non-Error, never a hang.
//  2. It never allows prototype-pollution: parsing hostile __proto__ /
//     constructor / prototype payloads must not mutate Object.prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { app } from './harness.mjs';
import { nastyString } from './arbitraries.mjs';
import { assertControlledError } from './assert-helpers.mjs';

const RUNS = Number(process.env.FUZZ_RUNS || 3000);

test('parseSafeJson never crashes uncontrollably on arbitrary text', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), nastyString), (text) => {
      try {
        app.parseSafeJson(text);
      } catch (err) {
        assertControlledError(err, 'parseSafeJson');
        assert.equal(err.name, 'SyntaxError', `unexpected error type: ${err.name}`);
      }
    }),
    { numRuns: RUNS }
  );
});

test('parseSafeJson strips prototype-polluting keys', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        nastyString
      ),
      fc.string(),
      (key, payloadValue) => {
        const doc = JSON.stringify({ [key]: { polluted: payloadValue }, ok: 1 });
        const result = app.parseSafeJson(doc);
        // Global prototype must remain clean no matter what.
        assert.equal(
          Object.prototype.polluted,
          undefined,
          'Object.prototype was polluted'
        );
        assert.equal(({}).polluted, undefined);
        if (result && typeof result === 'object') {
          assert.ok(
            !Object.prototype.hasOwnProperty.call(result, '__proto__'),
            'result carried an own __proto__ data property'
          );
        }
      }
    ),
    { numRuns: RUNS }
  );
});
