import assert from 'node:assert/strict';

import { compareBaseline, computeBurndown, computeSprintStats } from '../../cloud-sync.js';

const tasks = [
  { id: 'done', sprint: 'S1', storyPoints: 3, actualProgress: 100 },
  { id: 'doing', sprint: 'S1', storyPoints: 2, actualProgress: 50 },
  { id: 'closed', sprint: 'S2', storyPoints: 5, actualProgress: 100 },
  { id: 'backlog', storyPoints: 1, actualProgress: 0 },
  { id: 'unknown', sprint: 'S9', storyPoints: 1, actualProgress: 0 },
  { id: 'synthetic', sprint: 'S1', storyPoints: 99, isSynthetic: true },
];

const sprintStats = computeSprintStats(tasks, [
  { id: 's1', name: 'S1', startDate: '2026-01-01', endDate: '2026-01-05', goal: 'ship' },
  { id: 's2', name: 'S2', startDate: '2026-01-06', endDate: '2026-01-20', goal: 'polish' },
], '2026-01-10');
assert.deepEqual(sprintStats.rows.map(({ name, committed, completed, remaining, closed }) => ({
  name, committed, completed, remaining, closed,
})), [
  { name: 'S1', committed: 5, completed: 3, remaining: 2, closed: true },
  { name: 'S2', committed: 5, completed: 5, remaining: 0, closed: false },
]);
assert.equal(sprintStats.velocity, 3);
assert.equal(sprintStats.backlogCount, 2);
assert.deepEqual(computeSprintStats(), { rows: [], velocity: null, backlogCount: 0 });

assert.equal(computeBurndown(tasks, null, '2026-01-02'), null);
assert.equal(computeBurndown(tasks, { name: 'S1', startDate: '2026-01-03', endDate: '2026-01-02' }, '2026-01-02'), null);
assert.equal(computeBurndown([{ sprint: 'S1', storyPoints: 0 }], { name: 'S1', startDate: '2026-01-01', endDate: '2026-01-02' }, '2026-01-02'), null);

const burndown = computeBurndown([
  { sprint: 'S1', storyPoints: 2, actualEndDate: '2026-01-01' },
  { sprint: 'S1', storyPoints: 1, actualProgress: 100 },
  { sprint: 'S1', storyPoints: 2, actualProgress: 20 },
], { name: 'S1', startDate: '2026-01-01', endDate: '2026-01-03' }, '2026-01-02');
assert.deepEqual(burndown.days, ['2026-01-01', '2026-01-02', '2026-01-03']);
assert.deepEqual(burndown.ideal, [5, 2.5, 0]);
assert.deepEqual(burndown.actual, [3, 2, null]);

const oneDay = computeBurndown(
  [{ sprint: 'S1', storyPoints: 1, actualProgress: 100 }],
  { name: 'S1', startDate: '2026-01-01', endDate: '2026-01-01' },
  '2026-01-01',
);
assert.deepEqual(oneDay.ideal, [0]);
assert.deepEqual(oneDay.actual, [0]);

const capped = computeBurndown(
  [{ sprint: 'S1', storyPoints: 1 }],
  { name: 'S1', startDate: '2026-01-01', endDate: '2026-05-01' },
  '2026-01-01',
);
assert.equal(capped.days.length, 121);

const comparison = compareBaseline([
  { id: 'same', name: '같음', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10' },
  { id: 'moved', name: '이동', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10' },
  { id: 'removed', name: '삭제' },
  { id: 'invalid', name: '잘못됨', plannedStartDate: 'invalid' },
], [
  { id: 'same', name: '같음', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10' },
  { id: 'moved', name: '이동', plannedStartDate: '2026-01-02', plannedEndDate: '2026-01-12' },
  { id: 'added', name: '추가' },
  { id: 'invalid', name: '잘못됨', plannedStartDate: '2026-01-02' },
]);
assert.deepEqual(comparison.rows, [
  { id: 'moved', name: '이동', kind: 'moved', baseEnd: '2026-01-10', curEnd: '2026-01-12', endSlip: 2 },
  { id: 'added', name: '추가', kind: 'added', endSlip: null },
  { id: 'removed', name: '삭제', kind: 'removed', endSlip: null },
]);
assert.deepEqual(comparison.summary, { changed: 3, slipped: 1, maxSlip: 2 });
assert.deepEqual(compareBaseline(), { rows: [], summary: { changed: 0, slipped: 0, maxSlip: 0 } });

console.log('✓ cloud-sync metric tests passed');
