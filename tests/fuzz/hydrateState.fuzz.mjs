// Fuzz target: hydrateState — rehydrates the in-memory model from whatever was
// in localStorage (untrusted: another tab, an extension, or a tampered store).
//
// Invariants:
//  1. hydrateState never throws on any object shape (it must defensively
//     coerce), and always leaves state.tasks as an array.
//  2. normalizeStoredTask likewise returns a plain object for any task-ish
//     value and never pollutes the global prototype.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { app } from './harness.mjs';
import { taskRecordArb, anyJsonValue } from './arbitraries.mjs';

const RUNS = Number(process.env.FUZZ_RUNS || 3000);

const savedStateArb = fc.record(
  {
    projectName: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    baseDate: fc.oneof(fc.string(), fc.constant(null)),
    tasks: fc.oneof(
      fc.array(anyJsonValue, { maxLength: 20 }),
      fc.constant(null),
      fc.string(),
      fc.integer()
    ),
  },
  { requiredKeys: [] }
);

test('hydrateState never throws and yields an array of tasks', () => {
  fc.assert(
    fc.property(savedStateArb, (saved) => {
      app.hydrateState(saved);
      assert.ok(Array.isArray(app.state.tasks), 'state.tasks is not an array after hydrate');
      assert.equal(typeof app.state.projectName, 'string');
    }),
    { numRuns: RUNS }
  );
});

test('normalizeStoredTask returns an object and keeps prototype clean', () => {
  fc.assert(
    fc.property(fc.oneof(taskRecordArb, anyJsonValue), (task) => {
      const out = app.normalizeStoredTask(task);
      assert.equal(typeof out, 'object');
      assert.ok(out !== null);
      assert.equal(Object.prototype.polluted, undefined);
    }),
    { numRuns: RUNS }
  );
});
