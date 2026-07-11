// PM readiness analysis for requirements/RFI/RFP/WBS estimation.
// Run: node tests/unit/pm-analysis.test.mjs
import assert from 'node:assert';
import { computePmAnalysis } from '../../analytics.js';

const tasks = [
  {
    id: 'P1',
    depth: 1,
    phase: '요구사항 정의 및 RFP 준비',
    documentName: '요구사항정의서',
    owner: 'PM',
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-05',
  },
  {
    id: 'A1',
    parentId: 'P1',
    depth: 2,
    activity: 'RFI 질의응답',
    owner: 'PM',
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-03',
    predecessors: '',
  },
  {
    id: 'T1',
    parentId: 'A1',
    depth: 3,
    task: 'Stakeholder requirement workshop',
    documentName: 'RFI 질문지',
    owner: 'BA',
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-03',
    storyPoints: '5',
    budget: '1000',
  },
  {
    id: 'T2',
    parentId: 'A1',
    depth: 3,
    task: '평가기준 및 제안요청서 작성',
    documentName: 'RFP 평가표',
    owner: 'PM',
    plannedStartDate: '2026-01-03',
    plannedEndDate: '2026-01-07',
    predecessors: 'T1',
    budget: '2000',
  },
];

const analysis = computePmAnalysis(tasks);
assert.equal(analysis.tasks.leaf, 2, 'leaf tasks drive readiness coverage');
assert.equal(analysis.signals.requirements, 1, 'requirements signal counted from leaf text');
assert.equal(analysis.signals.procurement, 2, 'RFI/RFP signals counted');
assert.equal(analysis.signals.evaluation, 1, 'evaluation criteria signal counted');
assert.equal(analysis.estimates.estimateReady, 2, 'both leaves have estimate evidence');
assert.equal(analysis.estimates.budget, 3000, 'budget rolls up from leaves');
assert.equal(analysis.dependencies.declaredLinks, 1, 'one dependency link');
assert.equal(analysis.dependencies.risk, 'low', 'valid dependency keeps risk low');
assert.equal(analysis.procurement.ready, analysis.procurement.total, 'complete RFI/RFP section coverage');
assert.ok(analysis.readinessScore >= 80, 'complete pack is high readiness');

const risky = computePmAnalysis([
  { id: 'A', depth: 3, task: '요구사항 정리', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-02' },
  { id: 'B', depth: 3, task: '구현', predecessors: 'ghost', storyPoints: '3' },
]);
assert.equal(risky.dependencies.risk, 'high', 'dangling predecessor is high risk');
assert.equal(risky.dependencies.danglingPredecessors.length, 1);
assert.ok(risky.recommendations.some((r) => r.includes('선행작업')), 'dependency recommendation appears');

assert.equal(computePmAnalysis([]).readinessScore, 0, 'empty plan has zero readiness');

console.log('✓ PM analysis tests passed');
