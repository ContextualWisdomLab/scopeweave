import { test, expect } from './coverage-test.js';

const ANALYTICS_TASKS = [
  {
    id: 'requirements',
    phase: 'Requirements workshop',
    activity: 'RFI clarification',
    task: 'Define acceptance criteria and business case',
    documentName: 'RFP requirements package',
    owner: 'PM',
    plannedStartDate: '2026-08-03',
    plannedEndDate: '2026-08-05',
    plannedProgress: 100,
    actualProgress: 100,
    budget: 1000,
    actualCost: 900,
    storyPoints: 3,
  },
  {
    id: 'implementation',
    parentId: 'requirements',
    activity: 'Implementation',
    task: 'Build bidder response workflow',
    documentName: 'Working feature',
    owner: 'Engineer',
    plannedStartDate: '2026-08-06',
    plannedEndDate: '2026-08-10',
    plannedProgress: 80,
    actualProgress: 60,
    budget: 2000,
    actualCost: 2200,
    storyPoints: 8,
    predecessors: 'requirementsFS+1',
  },
  {
    id: 'validation',
    task: 'Evaluation and Q&A',
    owner: '',
    plannedStartDate: '2026-08-10',
    plannedEndDate: '2026-08-11',
    plannedProgress: 50,
    actualProgress: 10,
    budget: 500,
    actualCost: 800,
    predecessors: ['implementationSS', 'requirementsFF+2', 'missingSF-1'],
  },
];

test.describe('exact browser analytics production coverage', () => {
  test('public analytics API covers schedule, cost, CPM, workload, and PM risk boundaries', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate((tasks) => {
      const api = window.ScopeWeaveAnalytics;
      if (!api) throw new Error('ScopeWeaveAnalytics is not available');

      const calcDuration = (start, end) => {
        const ms = Date.parse(end) - Date.parse(start);
        if (!Number.isFinite(ms) || ms < 0) return 0;
        return Math.max(1, Math.round(ms / 86400000));
      };
      const calcPlannedRatio = (date, start, end, duration) => {
        if (!date || !start || !end) return 0;
        if (date <= start) return 0;
        if (date >= end) return 1;
        const elapsed = calcDuration(start, date);
        return Math.max(0, Math.min(1, elapsed / Math.max(duration, 1)));
      };
      const buildTimeline = (start, end) => {
        const rows = [];
        const cursor = new Date(`${start}T00:00:00Z`);
        const finish = new Date(`${end}T00:00:00Z`);
        while (cursor <= finish) {
          rows.push({ date: cursor.toISOString().slice(0, 10) });
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return rows;
      };

      const evm = [
        api.computeEvm({ pv: 0, ev: 0 }),
        api.computeEvm({ pv: 0.5, ev: 0.6 }),
        api.computeEvm({ pv: 0.5, ev: 0.5 }),
        api.computeEvm({ pv: 0.5, ev: 0.46 }),
        api.computeEvm({ pv: 0.5, ev: 0.2 }),
      ];

      const noDates = api.buildScurve({
        tasks: [{ id: 'undated' }], calcPlannedRatio, calcDuration, buildTimeline,
      });
      const nullScurve = api.buildScurve({
        tasks: null, calcPlannedRatio, calcDuration, buildTimeline,
      });
      const zeroDuration = api.buildScurve({
        tasks: [{ id: 'invalid', plannedStartDate: '2026-08-05', plannedEndDate: '2026-08-03' }],
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });
      const curve = api.buildScurve({ tasks, calcPlannedRatio, calcDuration, buildTimeline });

      const relationCpm = api.computeCpm([
        { id: 'A', duration: 2 },
        { id: 'B', duration: 3, predecessors: 'A' },
        { id: 'C', duration: 1, predecessors: 'ASS+1' },
        { id: 'D', duration: 2, predecessors: 'BFF+1' },
        { id: 'E', duration: 1, predecessors: 'CSF-1,missing' },
        { id: 'FS', duration: 1 },
        { id: 'letters', duration: 1, predecessors: 'FS' },
        { id: 'dated', plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-03' },
        { id: 'invalid-date', plannedStartDate: 'bad', plannedEndDate: 'worse' },
        { id: 'reverse-date', plannedStartDate: '2026-08-05', plannedEndDate: '2026-08-03' },
        { id: 'negative-duration', duration: -1 },
      ], { calcDuration });
      const nativeDateCpm = api.computeCpm([
        { id: 'native-valid', plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-03' },
        { id: 'native-invalid', plannedStartDate: 'bad', plannedEndDate: 'worse' },
        { id: 'native-reverse', plannedStartDate: '2026-08-05', plannedEndDate: '2026-08-03' },
      ]);
      const cycle = api.computeCpm([
        { id: 'x', duration: 1, predecessors: 'y' },
        { id: 'y', duration: 1, predecessors: 'x' },
      ]);
      const emptyCpm = api.computeCpm(null);

      const nullCost = api.computeCostEvm(null);
      const costCases = [
        api.computeCostEvm([]),
        api.computeCostEvm([{ budget: 100, plannedProgress: 20, actualProgress: 0, actualCost: 0 }]),
        api.computeCostEvm([{ budget: 100, plannedProgress: 80, actualProgress: 100, actualCost: 80 }]),
        api.computeCostEvm([{ budget: 100, plannedProgress: 80, actualProgress: 95, actualCost: 100 }]),
        api.computeCostEvm([{ budget: 100, plannedProgress: 80, actualProgress: 50, actualCost: 100 }]),
      ];

      const nullWorkload = api.computeWorkload(null);
      const workload = api.computeWorkload([
        { owner: 'Kim', plannedProgress: 80, actualProgress: 70 },
        { owner: 'Kim', plannedProgress: 50, actualProgress: 50 },
        { owner: '', plannedProgress: 20, actualProgress: 0 },
      ]);
      const emptyPm = api.computePmAnalysis([]);
      const nonArrayPm = api.computePmAnalysis(null);
      const nativeDatePm = api.computePmAnalysis([
        {
          id: 'native-pm',
          task: 'Requirement acceptance',
          plannedStartDate: '2026-08-01',
          plannedEndDate: '2026-08-03',
        },
      ]);
      const parentCyclePm = api.computePmAnalysis([
        { id: 'parent-a', parentId: 'parent-b', task: 'A', duration: 1 },
        { id: 'parent-b', parentId: 'parent-a', task: 'B', duration: 1 },
      ]);
      const strongPm = api.computePmAnalysis(tasks, { calcDuration });
      const mediumPm = api.computePmAnalysis([
        { id: '1', task: 'Build', duration: 2 },
        { id: '2', task: 'Test', duration: 2 },
        { id: '3', task: 'Ship', duration: 2 },
        { id: '4', task: 'Operate', duration: 2 },
      ]);
      const cyclicPm = api.computePmAnalysis([
        { id: 'a', task: 'Requirement', predecessors: 'b' },
        { id: 'b', task: 'Review', predecessors: 'a' },
      ]);

      return {
        evm: evm.map(({ status, label, spi }) => ({ status, label, spi })),
        noDates,
        nullScurve,
        zeroDuration,
        curveLength: curve.timeline.length,
        relationDuration: relationCpm.projectDurationDays,
        relationCycle: relationCpm.cycleDetected,
        nativeDuration: nativeDateCpm.projectDurationDays,
        cycleDetected: cycle.cycleDetected,
        emptyDuration: emptyCpm.projectDurationDays,
        nullCost,
        costCases: costCases.map((entry) => entry && ({ status: entry.status, label: entry.label, cpi: entry.cpi })),
        nullWorkload,
        workload,
        emptyPm,
        nonArrayPm,
        nativePmDuration: nativeDatePm.estimates.totalDurationDays,
        parentCycleTotal: parentCyclePm.tasks.total,
        strongRisk: strongPm.dependencies.risk,
        strongReady: strongPm.procurement.ready,
        mediumRisk: mediumPm.dependencies.risk,
        cyclicRisk: cyclicPm.dependencies.risk,
      };
    }, ANALYTICS_TASKS);

    expect(result.evm.map((entry) => entry.label)).toEqual([
      '계획 착수 전', '일정 선행', '일정 준수', '경미한 지연', '지연 위험',
    ]);
    expect(result.noDates).toEqual({ timeline: [], planned: [] });
    expect(result.nullScurve).toEqual({ timeline: [], planned: [] });
    expect(result.zeroDuration).toEqual({ timeline: [], planned: [] });
    expect(result.curveLength).toBeGreaterThan(2);
    expect(result.relationDuration).toBeGreaterThan(0);
    expect(result.relationCycle).toBe(false);
    expect(result.nativeDuration).toBeGreaterThan(0);
    expect(result.cycleDetected).toBe(true);
    expect(result.emptyDuration).toBe(0);
    expect(result.nullCost).toBeNull();
    expect(result.costCases[0]).toBeNull();
    expect(result.costCases.slice(1).map((entry) => entry.label)).toEqual([
      '실투입 전', '예산 준수', '경미한 초과', '예산 초과 위험',
    ]);
    expect(result.nullWorkload).toEqual([]);
    expect(result.workload).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: 'Kim', count: 2, behind: 1 }),
      expect.objectContaining({ owner: '미지정', count: 1, behind: 1 }),
    ]));
    expect(result.emptyPm.tasks.total).toBe(0);
    expect(result.nonArrayPm.tasks.total).toBe(0);
    expect(result.nativePmDuration).toBeGreaterThan(0);
    expect(result.parentCycleTotal).toBe(2);
    expect(result.strongReady).toBeGreaterThan(0);
    expect(result.strongRisk).toBe('high');
    expect(result.mediumRisk).toBe('medium');
    expect(result.cyclicRisk).toBe('high');
  });

  test('analytics renderer exposes actionable EVM, CPM, cost, workload, and PM evidence', async ({ page }) => {
    await page.goto('/');

    const rendered = await page.evaluate((tasks) => {
      const api = window.ScopeWeaveAnalytics;
      const calcDuration = (start, end) => {
        const ms = Date.parse(end) - Date.parse(start);
        if (!Number.isFinite(ms) || ms < 0) return 0;
        return Math.max(1, Math.round(ms / 86400000));
      };
      const calcPlannedRatio = (date, start, end, duration) => {
        if (date <= start) return 0;
        if (date >= end) return 1;
        return calcDuration(start, date) / Math.max(duration, 1);
      };
      const buildTimeline = (start, end) => {
        const rows = [];
        const cursor = new Date(`${start}T00:00:00Z`);
        const finish = new Date(`${end}T00:00:00Z`);
        while (cursor <= finish) {
          rows.push({ date: cursor.toISOString().slice(0, 10) });
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return rows;
      };

      document.getElementById('evm-panel')?.remove();
      api.render({
        pv: 0.6,
        ev: 0.5,
        tasks,
        baseDate: '2026-08-07',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });

      const panel = document.getElementById('evm-panel');
      const first = {
        text: panel?.textContent || '',
        hasCurve: Boolean(panel?.querySelector('.evm-scurve')),
        workloadRows: panel?.querySelectorAll('.workload-table tbody tr').length || 0,
        pmItems: panel?.querySelectorAll('.pm-section-list li').length || 0,
      };

      api.render({
        pv: 0.2,
        ev: 0,
        tasks: [{
          id: 'solo-before-cost',
          duration: 1,
          budget: 100,
          actualCost: 0,
          predecessors: '',
        }],
        baseDate: '2026-08-01',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });
      const beforeCostText = document.getElementById('evm-panel')?.textContent || '';

      api.render({
        pv: 0.5,
        ev: 0.4,
        tasks: [
          { id: 'cycle-a', duration: 1, predecessors: 'cycle-b' },
          { id: 'cycle-b', duration: 1, predecessors: 'cycle-a' },
        ],
        baseDate: '2026-08-01',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });
      const cycleText = document.getElementById('evm-panel')?.textContent || '';

      api.render({
        pv: 0,
        ev: 0,
        tasks: null,
        baseDate: '2026-08-01',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });
      const nullText = document.getElementById('evm-panel')?.textContent || '';

      api.render({
        pv: 0,
        ev: 0,
        tasks: [],
        baseDate: '2026-08-01',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });
      const emptyText = document.getElementById('evm-panel')?.textContent || '';

      document.getElementById('evm-panel')?.remove();
      document.querySelector('.meta-grid-secondary')?.remove();
      document.querySelector('.top-panel')?.remove();
      api.render({
        pv: 0,
        ev: 0,
        tasks: [],
        baseDate: '2026-08-01',
        calcPlannedRatio,
        calcDuration,
        buildTimeline,
      });

      return {
        ...first,
        beforeCostText,
        cycleText,
        nullText,
        emptyText,
        noAnchorPanel: Boolean(document.getElementById('evm-panel')),
      };
    }, ANALYTICS_TASKS);

    expect(rendered.text).toContain('PV 계획가치');
    expect(rendered.text).toContain('임계경로(CPM)');
    expect(rendered.text).toContain('BAC 총예산');
    expect(rendered.text).toContain('담당자별 워크로드');
    expect(rendered.text).toContain('PM 분석: 요구사항 · RFI/RFP · WBS 추정');
    expect(rendered.hasCurve).toBe(true);
    expect(rendered.workloadRows).toBeGreaterThan(0);
    expect(rendered.pmItems).toBe(6);
    expect(rendered.beforeCostText).toContain('실투입 전');
    expect(rendered.cycleText).toContain('순환 의존성이 감지되어 임계경로를 계산할 수 없습니다.');
    expect(rendered.nullText).toContain('계획 착수 전');
    expect(rendered.emptyText).toContain('계획 착수 전');
    expect(rendered.noAnchorPanel).toBe(false);
  });
});
