// Baseline-vs-current comparison (pure logic in cloud-sync.js).
// Run: node tests/unit/baseline-compare.test.mjs
import assert from 'node:assert';
import { compareBaseline } from '../../cloud-sync.js';

const base = [
  { id: 'a', name: 'A', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10' },
  { id: 'b', name: 'B', plannedStartDate: '2026-01-05', plannedEndDate: '2026-01-15' },
  { id: 'c', name: 'C', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-03' },
];

// b slipped +5 days, c removed, d added, a unchanged
const cur = [
  { id: 'a', name: 'A', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10' },
  { id: 'b', name: 'B', plannedStartDate: '2026-01-05', plannedEndDate: '2026-01-20' },
  { id: 'd', name: 'D', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-05' },
];

const { rows, summary } = compareBaseline(base, cur);
assert.equal(summary.changed, 3, 'b moved + d added + c removed');
assert.equal(summary.slipped, 1, 'only b slipped late');
assert.equal(summary.maxSlip, 5, 'b slipped 5 days');
const b = rows.find((r) => r.id === 'b');
assert.equal(b.kind, 'moved');
assert.equal(b.endSlip, 5);
assert.equal(rows.find((r) => r.id === 'd').kind, 'added');
assert.equal(rows.find((r) => r.id === 'c').kind, 'removed');
assert.ok(!rows.some((r) => r.id === 'a'), 'unchanged task not listed');

// identical → empty
const same = compareBaseline(base, base);
assert.equal(same.rows.length, 0, 'identical plans → no rows');

// early finish counts as changed but not slipped
const early = compareBaseline(base, [{ ...base[0], plannedEndDate: '2026-01-08' }, base[1], base[2]]);
assert.equal(early.summary.slipped, 0, 'early finish is not a slip');
assert.equal(early.rows.find((r) => r.id === 'a').endSlip, -2);

console.log('✓ baseline-compare tests passed');
