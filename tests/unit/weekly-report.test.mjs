// 주간보고 generator (pure logic in cloud-sync.js).
// Run: node tests/unit/weekly-report.test.mjs
import assert from 'node:assert';
import { buildWeeklyReport } from '../../cloud-sync.js';

// Reference: Wednesday 2026-07-08 → week = Mon 2026-07-06 ~ Sun 2026-07-12,
// next week = 2026-07-13 ~ 2026-07-19.
const REF = '2026-07-08';
const tasks = [
  { id: 'a', name: '완료작업', actualEndDate: '2026-07-07', plannedProgress: 100, actualProgress: 100, weight: 1 },
  { id: 'b', name: '진행작업', owner: '김담당', plannedProgress: 60, actualProgress: 40, weight: 1 },
  { id: 'c', name: '지연작업', owner: '이담당', plannedEndDate: '2026-07-01', plannedProgress: 100, actualProgress: 20, weight: 2 },
  { id: 'd', name: '차주작업', plannedStartDate: '2026-07-14', plannedProgress: 0, actualProgress: 0, weight: 1 },
  { id: 'e', name: '지난완료', actualEndDate: '2026-06-20', plannedProgress: 100, actualProgress: 100, weight: 1 },
  { id: 's', name: '합성행', isSynthetic: true, plannedProgress: 0, actualProgress: 0 },
];

const md = buildWeeklyReport(tasks, REF, '데모');
assert.ok(md.startsWith('# 주간보고 — 데모 (2026-07-06 ~ 2026-07-12)'), 'week range from Monday');
assert.ok(md.includes('## 금주 완료\n- 완료작업 (2026-07-07)'), 'this-week completion listed');
assert.ok(!md.includes('지난완료'), 'old completion excluded');
assert.ok(md.includes('- 진행작업 — 40% (김담당)'), 'in-progress with owner');
assert.ok(md.includes('- 지연작업 — 계획종료 2026-07-01, 실적 20% (이담당)'), 'late task detail');
assert.ok(md.includes('- 차주작업 (2026-07-14 시작)'), 'next-week upcoming');
assert.ok(!md.includes('합성행'), 'synthetic rows excluded');
// weighted summary: pv=(100+60+2*100+0+100)/6=... weights: 1+1+2+1+1=6 → pv=(1+0.6+2+0+1)/6=76.7, ev=(1+0.4+0.4+0+1)/6=46.7
assert.ok(md.includes('계획 76.7% · 실적 46.7%'), 'weighted summary');
assert.ok(md.includes('SPI 0.61'), 'SPI computed');
assert.ok(md.includes('지연 위험'), 'status label');

// empty sections say (없음)
const empty = buildWeeklyReport([], REF);
assert.ok((empty.match(/- \(없음\)/g) || []).length === 4, 'all four sections empty-marked');
assert.equal(buildWeeklyReport([], 'not-a-date'), '', 'invalid date → empty string');

console.log('✓ weekly-report tests passed');
