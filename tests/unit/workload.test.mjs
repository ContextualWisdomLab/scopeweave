// Resource workload aggregation (pure logic in analytics.js).
// Run: node tests/unit/workload.test.mjs
import assert from 'node:assert';
import { computeWorkload } from '../../analytics.js';

const tasks = [
  { id: '1', owner: '김담당', plannedProgress: 50, actualProgress: 50 },
  { id: '2', owner: '김담당', plannedProgress: 80, actualProgress: 40 }, // behind
  { id: '3', owner: '이담당', plannedProgress: 100, actualProgress: 100 },
  { id: '4', owner: '', plannedProgress: 10, actualProgress: 0 },       // 미지정, behind
];

const rows = computeWorkload(tasks);
assert.equal(rows.length, 3, '3 owners incl. 미지정');
assert.equal(rows[0].owner, '김담당', 'sorted by count desc');
assert.equal(rows[0].count, 2);
assert.equal(rows[0].avgPlanned, 65, '(50+80)/2');
assert.equal(rows[0].avgActual, 45, '(50+40)/2');
assert.equal(rows[0].behind, 1, 'one behind task');
const lee = rows.find((r) => r.owner === '이담당');
assert.equal(lee.behind, 0, 'on-track owner has 0 behind');
const unassigned = rows.find((r) => r.owner === '미지정');
assert.equal(unassigned.count, 1, 'blank owner grouped as 미지정');
assert.equal(unassigned.behind, 1);
assert.deepEqual(computeWorkload([]), [], 'empty input → empty');
assert.equal(computeWorkload([{ id: 'x', plannedProgress: 'abc' }])[0].avgPlanned, 0, 'non-numeric coerced to 0');

console.log('✓ workload tests passed');
