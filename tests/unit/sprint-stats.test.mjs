// Agile 스프린트 지표 (순수 로직 in cloud-sync.js).
import assert from 'node:assert';
import { computeSprintStats } from '../../cloud-sync.js';

const sprints = [
  { id: 1, name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, // 종료
  { id: 2, name: 'Sprint 2', startDate: '2026-06-15', endDate: '2026-06-28' }, // 종료
  { id: 3, name: 'Sprint 3', startDate: '2026-07-06', endDate: '2026-07-19' }, // 진행
];
const tasks = [
  { id: 'a', sprint: 'Sprint 1', storyPoints: 5, actualProgress: 100 },
  { id: 'b', sprint: 'Sprint 1', storyPoints: 3, actualProgress: 100 },
  { id: 'c', sprint: 'Sprint 2', storyPoints: 8, actualProgress: 100 },
  { id: 'd', sprint: 'Sprint 2', storyPoints: 5, actualProgress: 50 },   // 미완 → 벨로시티 제외
  { id: 'e', sprint: 'Sprint 3', storyPoints: 13, actualProgress: 20 },
  { id: 'f', storyPoints: 8 },                                            // 백로그(스프린트 없음)
  { id: 'g', sprint: '없는스프린트', storyPoints: 2 },                     // 백로그(미존재 스프린트)
  { id: 's', sprint: 'Sprint 3', storyPoints: 99, isSynthetic: true },    // 합성행 제외
];

const st = computeSprintStats(tasks, sprints, '2026-07-07');
const [s1, s2, s3] = st.rows;
assert.equal(s1.committed, 8);  assert.equal(s1.completed, 8);  assert.ok(s1.closed);
assert.equal(s2.committed, 13); assert.equal(s2.completed, 8);  assert.equal(s2.remaining, 5);
assert.equal(s3.committed, 13); assert.equal(s3.completed, 0);  assert.ok(!s3.closed, '진행 중');
assert.equal(st.velocity, 8, '(8+8)/2 종료 스프린트 평균');
assert.equal(st.backlogCount, 2, '미배정 + 미존재 스프린트');
assert.equal(computeSprintStats([], [], '2026-07-07').velocity, null, '종료 스프린트 없음 → N/A');

console.log('✓ sprint-stats tests passed');
