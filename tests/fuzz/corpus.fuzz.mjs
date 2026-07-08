// Seed-corpus replay: every file under corpus/ is pushed through the real
// parse/import pipeline as a permanent regression set. It includes the two
// robustness gaps this fuzzing work surfaced (junk array entries,
// depth-overflow) plus prototype-pollution and formula-injection payloads.
//
// Each seed must be handled with the array-or-controlled-Error contract — no
// uncaught non-Error throw, no prototype pollution, and (for the mapper) a
// depth-in-1..3 hierarchy on success.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './harness.mjs';
import { assertControlledError } from './assert-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, 'corpus');

function filesIn(sub) {
  const dir = path.join(corpusDir, sub);
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).map((f) => path.join(dir, f))
    : [];
}

test('CSV corpus replays through parseCsv without uncontrolled crashes', () => {
  const files = filesIn('csv');
  assert.ok(files.length > 0, 'no CSV corpus seeds found');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      const rows = app.parseCsv(text);
      assert.ok(Array.isArray(rows), `${path.basename(file)}: parseCsv non-array`);
      const mapped = app.validateImportedTasks(app.normalizeImportedTasks(rows));
      for (const t of mapped) {
        assert.ok([1, 2, 3].includes(t.depth), `${path.basename(file)}: bad depth ${t.depth}`);
      }
    } catch (err) {
      assertControlledError(err, `csv:${path.basename(file)}`);
    }
    assert.equal(Object.prototype.polluted, undefined);
  }
});

test('JSON corpus replays through the import mapper without uncontrolled crashes', () => {
  const files = filesIn('json');
  assert.ok(files.length > 0, 'no JSON corpus seeds found');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = app.parseSafeJson(text);
    } catch (err) {
      assertControlledError(err, `json-parse:${path.basename(file)}`);
      continue;
    }
    // A seed may be an array of tasks OR an object; the mapper must tolerate both.
    const source = Array.isArray(parsed) ? parsed : parsed && parsed.tasks;
    try {
      const normalized = app.normalizeImportedTasks(source);
      assert.ok(Array.isArray(normalized), `${path.basename(file)}: non-array`);
      for (const t of normalized) {
        assert.ok([1, 2, 3].includes(t.depth), `${path.basename(file)}: bad depth ${t.depth}`);
      }
      app.validateImportedTasks(normalized);
    } catch (err) {
      assertControlledError(err, `json-map:${path.basename(file)}`);
    }
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).polluted, undefined);
  }
});
