// Fuzz target: the WBS import mapper — normalizeImportedTasks +
// validateImportedTasks. This is the highest-value surface: it consumes both
// CSV-imported rows AND arbitrary parsed wbs.json (bootstrap() feeds the
// fetched seed straight in), then builds the task hierarchy.
//
// Invariants:
//  1. normalizeImportedTasks either returns an ARRAY or throws an Error
//     (validation reject). Never a non-Error, never a non-array, never a hang.
//  2. When it returns, every produced task has depth in 1..3 and a string id.
//  3. validateImportedTasks either confirms referential integrity (unique ids,
//     every parentId resolvable, no cycles) or throws an Error — it must always
//     TERMINATE (the cycle detector must not loop forever) and never pollute the
//     global prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { app } from './harness.mjs';
import { taskArrayArb, anyJsonValue } from './arbitraries.mjs';
import { assertControlledError } from './assert-helpers.mjs';

const RUNS = Number(process.env.FUZZ_RUNS || 3000);

function assertHierarchy(tasks) {
  assert.ok(Array.isArray(tasks), 'normalizeImportedTasks returned a non-array');
  for (const t of tasks) {
    assert.equal(typeof t, 'object');
    assert.ok(t !== null);
    assert.ok([1, 2, 3].includes(t.depth), `depth out of range: ${t.depth}`);
    assert.equal(typeof t.id, 'string');
  }
}

test('normalizeImportedTasks: array-or-Error on structured task arrays', () => {
  fc.assert(
    fc.property(taskArrayArb, (tasks) => {
      let normalized;
      try {
        normalized = app.normalizeImportedTasks(tasks);
      } catch (err) {
        assertControlledError(err, 'normalizeImportedTasks');
        return;
      }
      assertHierarchy(normalized);
      // Feed the mapper output into the integrity validator (the real pipeline).
      try {
        const validated = app.validateImportedTasks(normalized);
        assert.ok(Array.isArray(validated));
        const ids = new Set(normalized.map((t) => t.id));
        for (const t of normalized) {
          if (t.parentId) {
            assert.ok(ids.has(t.parentId), 'validated tree has a dangling parentId');
          }
        }
      } catch (err) {
        assertControlledError(err, 'validateImportedTasks');
      }
      assert.equal(Object.prototype.polluted, undefined);
    }),
    { numRuns: RUNS }
  );
});

test('normalizeImportedTasks: never throws a non-Error on arbitrary JSON', () => {
  // Mirrors a hand-edited / malicious wbs.json parsed straight from disk.
  fc.assert(
    fc.property(fc.oneof(anyJsonValue, fc.array(anyJsonValue, { maxLength: 20 })), (value) => {
      try {
        const out = app.normalizeImportedTasks(value);
        assert.ok(Array.isArray(out));
      } catch (err) {
        assertControlledError(err, 'normalizeImportedTasks');
      }
    }),
    { numRuns: RUNS }
  );
});

test('validateImportedTasks terminates on adversarial id/parent graphs', () => {
  // Build records with explicit __id/__parentId that may form cycles or dangle,
  // then normalize (preserves ids) and validate. The cycle detector must halt.
  const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e');
  const cyclicRecords = fc.array(
    fc.record({
      __id: idArb,
      __parentId: fc.oneof(idArb, fc.constant(undefined)),
      __depth: fc.constantFrom('1', '2', '3'),
      phase: fc.string(),
    }),
    { maxLength: 12 }
  );
  fc.assert(
    fc.property(cyclicRecords, (records) => {
      let normalized;
      try {
        normalized = app.normalizeImportedTasks(records);
      } catch (err) {
        assertControlledError(err, 'normalizeImportedTasks');
        return;
      }
      try {
        app.validateImportedTasks(normalized);
      } catch (err) {
        assertControlledError(err, 'validateImportedTasks');
      }
    }),
    { numRuns: RUNS }
  );
});
