// 번다운 (순수 로직 in cloud-sync.js).
import assert from 'node:assert';
import { computeBurndown } from '../../cloud-sync.js';

const sprint = { name: 'S1', startDate: '2026-07-01', endDate: '2026-07-05' }; // 5일
const tasks = [
  { id: 'a', sprint: 'S1', storyPoints: 5, actualProgress: 100, actualEndDate: '2026-07-02' },
  { id: 'b', sprint: 'S1', storyPoints: 3, actualProgress: 100, actualEndDate: '2026-07-04' },
  { id: 'c', sprint: 'S1', storyPoints: 2, actualProgress: 50 },
  { id: 'x', sprint: 'S2', storyPoints: 99 },                       // 타 스프린트 제외
  { id: 's', sprint: 'S1', storyPoints: 7, isSynthetic: true },     // 합성 제외
];

const bd = computeBurndown(tasks, sprint, '2026-07-04');
assert.equal(bd.days.length, 5);
assert.equal(bd.committed, 10, '5+3+2');
assert.equal(bd.ideal[0], 10);
assert.equal(bd.ideal[4], 0, '이상선은 0으로 소진');
assert.deepEqual(bd.actual, [10, 5, 5, 2, null], 'D1 잔여10 → D2 a완료(5) → D4 b완료(2) → 미래 null');

// 완료일 없는 100% 작업은 today 완료로 간주
const bd2 = computeBurndown([{ id: 'a', sprint: 'S1', storyPoints: 4, actualProgress: 100 }], sprint, '2026-07-03');
assert.deepEqual(bd2.actual.slice(0, 3), [4, 4, 0], 'today(D3)에 소진 반영');

assert.equal(computeBurndown(tasks, { name: 'S1' }, '2026-07-04'), null, '기간 없으면 null');
assert.equal(computeBurndown([], sprint, '2026-07-04'), null, '포인트 0이면 null');

console.log('✓ burndown tests passed');
