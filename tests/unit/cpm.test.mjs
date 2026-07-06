// CPM engine tests. Run: node tests/unit/cpm.test.mjs
import assert from 'node:assert';
import { computeCpm } from '../../analytics.js';

// Classic AON example:
//   A(3) → B(4) → D(5) → E(1)   and   A(3) → C(2) → D
// Forward: A[0,3] B[3,7] C[3,5] D[7,12] E[12,13]  → project = 13
// Critical path A→B→D→E (slack 0); C has slack 2.
const tasks = [
  { id: 'A', duration: 3 },
  { id: 'B', duration: 4, predecessors: ['A'] },
  { id: 'C', duration: 2, predecessors: 'A' },          // comma/string form
  { id: 'D', duration: 5, predecessors: ['B', 'C'] },
  { id: 'E', duration: 1, predecessors: ['D'] },
];
const r = computeCpm(tasks);
assert.equal(r.cycleDetected, false);
assert.equal(r.projectDurationDays, 13, 'project duration = 13');
assert.deepEqual(r.criticalPath, ['A', 'B', 'D', 'E'], 'critical path A→B→D→E');
assert.equal(r.perTask.A.es, 0);
assert.equal(r.perTask.D.es, 7, 'D starts after both B and C');
assert.equal(r.perTask.E.ef, 13);
assert.equal(r.perTask.C.slack, 2, 'C has 2 days slack');
assert.equal(r.perTask.C.critical, false);
assert.equal(r.perTask.B.critical, true);
assert.equal(r.perTask.A.slack, 0);

// Date-based durations (no explicit duration field) — mirrors app.js day-count.
const dated = [
  { id: 'S', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-06' }, // 5d
  { id: 'T', plannedStartDate: '2026-01-06', plannedEndDate: '2026-01-09', predecessors: ['S'] }, // 3d
];
const rd = computeCpm(dated);
assert.equal(rd.perTask.S.duration, 5);
assert.equal(rd.perTask.T.es, 5, 'T starts after S (5)');
assert.equal(rd.projectDurationDays, 8);
assert.deepEqual(rd.criticalPath, ['S', 'T']);

// Cycle: X↔Y — must not throw, flags cycleDetected.
const cyclic = [
  { id: 'X', duration: 2, predecessors: ['Y'] },
  { id: 'Y', duration: 2, predecessors: ['X'] },
];
const rc = computeCpm(cyclic);
assert.equal(rc.cycleDetected, true, 'cycle detected');
assert.ok(Array.isArray(rc.criticalPath), 'no crash on cycle');
assert.equal(rc.perTask.X.critical, false, 'no critical tasks under a cycle');

// Empty / missing predecessor ids handled gracefully.
assert.equal(computeCpm([]).projectDurationDays, 0);
assert.equal(computeCpm([{ id: 'Z', duration: 4, predecessors: ['ghost'] }]).perTask.Z.es, 0);

console.log('✓ CPM (critical path) unit tests passed');
