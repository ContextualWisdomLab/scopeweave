const { test, expect } = require('@playwright/test');

const fs = require('fs');

const addTopLevelTask = async (page, values) => {
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  await page.locator('[data-testid="editor-phase"]').fill(values.phase);
  await page.locator('[data-testid="editor-category-large"]').fill(values.categoryLarge);
  await page.locator('[data-testid="editor-owner"]').fill(values.owner);
  await page.locator('[data-testid="editor-planned-start"]').fill(values.plannedStartDate);
  await page.locator('[data-testid="editor-planned-end"]').fill(values.plannedEndDate);
  await page.getByRole('button', { name: '저장', exact: true }).click();
};

const readHierarchySnapshot = async (page) => page.locator('tbody tr[data-task-id]').evaluateAll((rows) => rows.map((row) => ({
  phase: row.children[1]?.innerText.replace(/-\s*값 없음/g, '-').trim() || '',
  activity: row.children[2]?.innerText.replace(/-\s*값 없음/g, '-').trim() || '',
  task: row.children[3]?.innerText.replace(/-\s*값 없음/g, '-').trim() || ''
})));

const importCsv = async (page, csvText) => {
  await page.locator('#csv-file-input').setInputFiles({
    name: 'wbs_export_20260420.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvText, 'utf8')
  });
};

const createActivitySubtree = async (page, activityName, taskName) => {
  await page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: '하위 추가' }).click();
  await page.locator('[data-testid="editor-activity"]').fill(activityName);
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const activityRow = page.locator('tbody tr[data-task-id].depth-2').filter({ has: page.locator('td:nth-child(3)', { hasText: new RegExp(`^${activityName}$`) }) });
  await activityRow.getByRole('button', { name: '하위 추가' }).click();
  await page.locator('[data-testid="editor-task"]').fill(taskName);
  await page.getByRole('button', { name: '저장', exact: true }).click();

  return activityRow;
};

test.describe('ScopeWeave Planner', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__savedWbsJson = null;
      window.showSaveFilePicker = async () => ({
        async createWritable() {
          return {
            async write(content) {
              window.__savedWbsJson = content;
            },
            async close() {}
          };
        }
      });
    });
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('renders seeded rows and summary metrics', async ({ page }) => {
    await expect(page.getByRole('button', { name: '최상위 작업 추가' })).toBeVisible();
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.getByTestId('project-name-input')).toHaveValue(/ScopeWeave/i);
    await expect(page.getByTestId('summary-total-days')).not.toHaveText('0일');
    await expect(page.getByTestId('summary-planned-progress')).toContainText('%');
    await expect(page.getByTestId('summary-actual-progress')).toContainText('%');
    await expect(page).toHaveTitle('ScopeWeave Planner');

    await page.getByTestId('project-name-input').fill('My New Project');
    await expect(page).toHaveTitle('My New Project - ScopeWeave Planner');
  });

  [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 375, height: 667 }
  ].forEach(({ name, width, height }) => {
    test(`keeps wide WBS table scrolling inside the table panel on ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('./');

      await expect(page.locator('.table-scroll')).toBeVisible();
      await expect(page.locator('.wbs-table')).toBeVisible();

      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const tableScroll = document.querySelector('.table-scroll');
        const table = document.querySelector('.wbs-table');

        return {
          documentOverflow: root.scrollWidth - root.clientWidth,
          tableScrollsInternally: tableScroll.scrollWidth > tableScroll.clientWidth,
          tableScrollWidth: tableScroll.getBoundingClientRect().width,
          tableWidth: table.getBoundingClientRect().width,
          viewportWidth: root.clientWidth
        };
      });

      expect(layout.documentOverflow).toBeLessThanOrEqual(1);
      expect(layout.tableScrollsInternally).toBe(true);
      expect(layout.tableScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.tableWidth).toBeGreaterThan(layout.tableScrollWidth);
    });
  });

  test('keeps mobile WBS headers aligned with visible data cells', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('./');

    const mobileColumns = await page.evaluate(() => {
      const isVisible = (element) => getComputedStyle(element).display !== 'none';
      const headers = Array.from(document.querySelectorAll('thead th'))
        .filter(isVisible)
        .map((cell) => cell.textContent.trim());
      const firstTaskRow = document.querySelector('tbody tr[data-task-id]');
      const firstRowCells = Array.from(firstTaskRow?.querySelectorAll('td') || [])
        .filter(isVisible)
        .map((cell) => cell.innerText.trim());

      return { headers, firstRowCellCount: firstRowCells.length };
    });

    expect(mobileColumns.headers).toEqual(expect.arrayContaining(['단계', 'Activity', 'Task']));
    expect(mobileColumns.firstRowCellCount).toBe(mobileColumns.headers.length);
  });

  test('keeps the action bar from covering WBS rows on short desktop viewports', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./');

    await expect(page.locator('.bottom-action-bar')).toBeVisible();
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);

    const layout = await page.evaluate(() => {
      const footer = document.querySelector('.bottom-action-bar').getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll('tbody tr[data-task-id]')).map((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > footer.top && rect.top < footer.bottom;
      });

      return {
        footerPosition: getComputedStyle(document.querySelector('.bottom-action-bar')).position,
        overlappingRows: rows.filter(Boolean).length
      };
    });

    expect(layout.footerPosition).toBe('static');
    expect(layout.overlappingRows).toBe(0);
  });

  test('disables export and gantt actions when there are no tasks', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Empty Scope',
        baseDate: '2026-04-20',
        tasks: []
      }));
    });
    await page.reload();

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
    await expect(page.locator('.table-empty')).toBeVisible();
    await expect(page.locator('.table-empty')).toContainText('등록된 작업이 없습니다');
    await expect(page.locator('.table-empty').getByRole('button', { name: '최상위 작업 추가' })).toBeVisible();
    await expect(page.locator('.table-empty').getByRole('button', { name: 'CSV 가져오기' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'CSV 내보내기' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'CSV 내보내기' })).toHaveAttribute('title', '내보낼 작업이 없습니다. 하단의 버튼을 통해 작업을 추가해주세요.');
    await expect(page.getByRole('button', { name: '간트차트보기' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: '간트차트보기' })).toHaveAttribute('title', '간트 차트로 표시할 작업이 없습니다. 작업을 먼저 추가해주세요.');
  });

  test('keeps the empty WBS state inside the mobile table viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Empty Scope',
        baseDate: '2026-04-20',
        tasks: []
      }));
    });
    await page.reload();

    const layout = await page.evaluate(() => {
      const scrollRect = document.querySelector('.table-scroll').getBoundingClientRect();
      const emptyRect = document.querySelector('.empty-state-cell > .table-empty').getBoundingClientRect();
      const actionsRect = document.querySelector('.empty-state-cell .empty-actions').getBoundingClientRect();

      return {
        scrollLeft: scrollRect.left,
        scrollRight: scrollRect.right,
        emptyLeft: emptyRect.left,
        emptyRight: emptyRect.right,
        actionsRight: actionsRect.right
      };
    });

    expect(layout.emptyLeft).toBeGreaterThanOrEqual(layout.scrollLeft - 1);
    expect(layout.emptyRight).toBeLessThanOrEqual(layout.scrollRight + 1);
    expect(layout.actionsRight).toBeLessThanOrEqual(layout.scrollRight + 1);
  });

  test('adds a top-level task and restores it after reload', async ({ page }) => {
    const phaseName = 'P1000.분석단계';

    await addTopLevelTask(page, {
      phase: phaseName,
      categoryLarge: '요구사항분석',
      owner: '홍길동',
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });

    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: phaseName })).toHaveCount(1);
    await page.reload();
    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: phaseName })).toHaveCount(1);
  });

  test('adds child row with copied parent values and blocks fourth depth', async ({ page }) => {
    await page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: '하위 추가' }).click();
    await expect(page.locator('[data-testid="editor-phase"]')).toHaveValue('P0000.준비단계');
    await page.locator('[data-testid="editor-activity"]').fill('프로젝트준비 하위');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    const childRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '프로젝트준비 하위' });
    await expect(childRow).toHaveCount(1);
    const parentToggle = page.locator('tbody tr[data-task-id]').first().locator('button[data-action="toggle"]');
    await expect(parentToggle).toHaveAttribute('aria-label', '접기 - P0000.준비단계');
    await expect(parentToggle).toHaveAttribute('title', '접기 - P0000.준비단계');

    await childRow.getByRole('button', { name: '하위 추가' }).click();
    await page.locator('[data-testid="editor-task"]').fill('세부업무');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    const leafRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '세부업무' });
    await expect(leafRow).toHaveCount(1);
    const leafAddChildButton = leafRow.getByRole('button', { name: '하위 추가' });
    await expect(leafAddChildButton).toHaveAttribute('aria-disabled', 'true');
    await leafAddChildButton.click();
    await expect(page.locator('#toast')).toContainText('최대 3단계까지만 추가할 수 있습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });

  test('opens gantt modal and renders chart bars with correct inline styles', async ({ page }) => {
    await addTopLevelTask(page, {
      phase: '주말 보정 검증',
      categoryLarge: '간트검증',
      owner: '담당자A',
      plannedStartDate: '2026-05-16',
      plannedEndDate: '2026-05-24'
    });

    await page.getByRole('button', { name: '간트차트보기' }).click();
    await expect(page.getByRole('dialog', { name: '간트 차트' })).toBeVisible();
    await expect(page.locator('.gantt-bar.plan')).toHaveCount(3);

    const firstBar = page.locator('.gantt-bar.plan').first();
    await expect(firstBar).toHaveAttribute('style', /width:\s*\d+px/);
    await expect(firstBar).toHaveAttribute('style', /left:\s*\d+px/);

    const adjustedBar = page.locator('.gantt-bar.plan[aria-label*="주말 보정 검증"]').first();
    await expect(adjustedBar).toHaveAttribute('aria-label', /2026-05-18 ~ 2026-05-22/);
    await expect(adjustedBar).toHaveAttribute('title', /2026-05-18 ~ 2026-05-22/);
  });

  test('keeps keyboard focus inside the gantt modal', async ({ page }) => {
    await addTopLevelTask(page, {
      phase: '포커스 순환 검증',
      categoryLarge: '간트검증',
      owner: '담당자A',
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });

    await page.getByRole('button', { name: '간트차트보기' }).click();
    await expect(page.getByRole('dialog', { name: '간트 차트' })).toBeVisible();

    const closeButton = page.getByRole('button', { name: '간트 차트 닫기' });
    const firstBar = page.locator('.gantt-bar.plan').first();
    await expect(firstBar).toBeVisible();

    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(firstBar).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
  });

  test('does not create HTML elements from manual text in the gantt chart', async ({ page }) => {
    let dialogOpened = false;
    page.on('dialog', async (dialog) => {
      dialogOpened = true;
      await dialog.dismiss();
    });

    await addTopLevelTask(page, {
      phase: '<svg/onload=alert(1)>',
      categoryLarge: '간트검증',
      owner: '담당자A',
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });

    await page.getByRole('button', { name: '간트차트보기' }).click();
    await expect(page.getByRole('dialog', { name: '간트 차트' })).toBeVisible();
    await expect(page.locator('#gantt-content img, #gantt-content svg')).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(dialogOpened).toBe(false);
  });

  test('does not expose generated gantt rendering as a global XSS gadget', async ({ page }) => {
    let dialogOpened = false;
    page.on('dialog', async (dialog) => {
      dialogOpened = true;
      await dialog.dismiss();
    });

    await page.getByRole('button', { name: '간트차트보기' }).click();
    await expect(page.getByRole('dialog', { name: '간트 차트' })).toBeVisible();

    await expect.poll(async () => page.evaluate(() => typeof window.setGanttContent)).toBe('undefined');
    await expect(page.locator('#gantt-content img, #gantt-content svg, #gantt-content script, #gantt-content iframe, #gantt-content object')).toHaveCount(0);
    await expect(page.locator('#gantt-content [onclick], #gantt-content [onerror], #gantt-content [onload], #gantt-content [onmouseover]')).toHaveCount(0);
    await expect(page.locator('#gantt-content [style*="javascript"]')).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(dialogOpened).toBe(false);
  });

  test('escapes quotes from manual text before rendering editor attributes', async ({ page }) => {
    const ownerPayload = '" onmouseover="alert(1)';

    await addTopLevelTask(page, {
      phase: '속성검증',
      categoryLarge: '보안검증',
      owner: ownerPayload,
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });

    const taskRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '속성검증' }).first();
    await taskRow.getByRole('button', { name: '편집' }).click();

    const ownerInput = page.locator('[data-testid="editor-owner"]');
    await expect(ownerInput).toHaveValue(ownerPayload);
    await expect(ownerInput).not.toHaveAttribute('onmouseover', /alert/);
  });

  test('keeps descendant rows attached when reordering an activity subtree', async ({ page }) => {
    const secondActivityRow = await createActivitySubtree(page, '테스트 활동', '테스트 태스크');

    const firstActivityRow = page.locator('tbody tr[data-task-id].depth-2').filter({ has: page.locator('td:nth-child(3)', { hasText: /^프로젝트준비$/ }) }).first();
    const secondActivityBox = await secondActivityRow.boundingBox();
    await firstActivityRow.dragTo(secondActivityRow, {
      targetPosition: { x: 20, y: Math.max(4, Math.round((secondActivityBox?.height || 40) - 4)) }
    });

    const snapshot = await readHierarchySnapshot(page);
    const activityIndex = snapshot.findIndex((row) => row.activity === '테스트 활동');
    expect(activityIndex).toBeGreaterThan(-1);
    expect(snapshot[activityIndex + 1].task).toBe('테스트 태스크');
    expect(snapshot[activityIndex + 2].activity).toBe('프로젝트준비');
  });

  test('can move a later activity subtree before an earlier sibling', async ({ page }) => {
    const secondActivityRow = await createActivitySubtree(page, '테스트 활동', '테스트 태스크');

    const firstActivityRow = page.locator('tbody tr[data-task-id].depth-2').filter({ has: page.locator('td:nth-child(3)', { hasText: /^프로젝트준비$/ }) }).first();
    await secondActivityRow.dragTo(firstActivityRow, { targetPosition: { x: 20, y: 4 } });

    const snapshot = await readHierarchySnapshot(page);
    const firstMovedActivityIndex = snapshot.findIndex((row) => row.activity === '테스트 활동');
    expect(firstMovedActivityIndex).toBeGreaterThan(-1);
    expect(firstMovedActivityIndex).toBe(1);
    expect(snapshot[firstMovedActivityIndex + 1].task).toBe('테스트 태스크');
  });

  test('keeps the row when delete confirmation is cancelled', async ({ page }) => {
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      await dialog.dismiss();
    });

    await page.locator('tbody tr[data-task-id]').filter({ hasText: '단계작업계획' }).first().getByRole('button', { name: '삭제' }).click();

    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: '단계작업계획' })).toHaveCount(1);
  });

  test('confirms before deleting a row', async ({ page }) => {
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept();
    });

    await page.locator('tbody tr[data-task-id]').filter({ hasText: '단계작업계획' }).first().getByRole('button', { name: '삭제' }).click();

    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: '단계작업계획' })).toHaveCount(0);
  });

  test('writes autosaved wbs.json in the requested external shape', async ({ page }) => {
    await page.getByRole('button', { name: 'wbs.json 자동저장 연결' }).click();

    await expect.poll(async () => page.evaluate(() => window.__savedWbsJson)).not.toBeNull();
    const savedPayload = await page.evaluate(() => JSON.parse(window.__savedWbsJson));
    expect(savedPayload).toHaveLength(2);
    expect(savedPayload[0]).not.toHaveProperty('__id');
    expect(savedPayload[0]).not.toHaveProperty('__parentId');
    expect(savedPayload[0]).not.toHaveProperty('__depth');
    expect(savedPayload[0]).toHaveProperty('plannedEndDate');
    expect(savedPayload[0]).toHaveProperty('plannedEnd' + 'Ddate', savedPayload[0].plannedEndDate);
    expect(savedPayload[0].task).toBe('사업수행계획');
    expect(savedPayload[1].task).toBe('단계작업계획');
  });

  test('restores legacy planned end dates from local storage', async ({ page }) => {
    await page.evaluate(() => {
      const legacyPlannedEndField = 'plannedEnd' + 'Ddate';
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Legacy Project',
        baseDate: '2026-05-10',
        tasks: [
          null,
          'corrupt-task',
          {
            id: 'legacy-1',
            parentId: null,
            depth: 1,
            expanded: true,
            phase: 'P1000.레거시',
            activity: '',
            task: '레거시 작업',
            categoryLarge: '분석',
            categoryMedium: '',
            documentName: '',
            owner: '담당자',
            supportTeam: '',
            plannedStartDate: '2026-05-01',
            [legacyPlannedEndField]: '2026-05-20',
            actualProgressStatus: '미착수(0%)',
            actualStartDate: '',
            actualEndDate: ''
          }
        ]
      }));
    });
    await page.reload();

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(1);
    const firstRow = page.locator('tbody tr[data-task-id]').first();
    await expect(firstRow).toContainText('2026-05-20');

    await page.getByRole('button', { name: 'wbs.json 자동저장 연결' }).click();
    await expect.poll(async () => page.evaluate(() => window.__savedWbsJson)).not.toBeNull();
    const savedPayload = await page.evaluate(() => JSON.parse(window.__savedWbsJson));
    expect(savedPayload[0]).toHaveProperty('plannedEndDate', '2026-05-20');
    expect(savedPayload[0]).toHaveProperty('plannedEnd' + 'Ddate', '2026-05-20');
  });

  test('filters prototype pollution keys from saved local storage', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', `{
        "projectName": "  Prototype Project  ",
        "baseDate": "2026-05-10",
        "tasks": [{
          "id": "prototype-1",
          "parentId": null,
          "depth": 1,
          "expanded": true,
          "phase": "P9000.보안",
          "activity": "",
          "task": "프로토타입 검증",
          "categoryLarge": "보안",
          "categoryMedium": "",
          "documentName": "",
          "owner": "담당자",
          "supportTeam": "",
          "plannedStartDate": "2026-05-01",
          "plannedEndDate": "2026-05-20",
          "actualProgressStatus": "미착수(0%)",
          "actualStartDate": "",
          "actualEndDate": "",
          "__proto__": {"polluted": true},
          "constructor": {"prototype": {"polluted": true}},
          "prototype": {"polluted": true}
        }]
      }`);
    });
    await page.reload();

    await expect(page.getByTestId('project-name-input')).toHaveValue('Prototype Project');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(1);

    await page.getByTestId('project-name-input').fill('Prototype Project Saved');
    const savedState = await page.evaluate(() => JSON.parse(localStorage.getItem('scopeweave:planner-state:v1')));
    const savedTask = savedState.tasks[0];
    expect(Object.prototype.hasOwnProperty.call(savedTask, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(savedTask, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(savedTask, 'prototype')).toBe(false);
  });

  test('calculates planned progress ratio for edge cases', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Ratio Test',
        baseDate: '2023-01-15',
        tasks: [
          { id: 'ratio-1', task: 'Missing dates', plannedStartDate: '', plannedEndDate: '2023-01-20' },
          { id: 'ratio-2', task: 'Base before start', plannedStartDate: '2023-01-20', plannedEndDate: '2023-01-25' },
          { id: 'ratio-3', task: 'Base after end', plannedStartDate: '2023-01-01', plannedEndDate: '2023-01-10' },
          { id: 'ratio-4', task: 'Reversed dates', plannedStartDate: '2023-01-10', plannedEndDate: '2023-01-05' },
          { id: 'ratio-5', task: 'Normal range', plannedStartDate: '2023-01-10', plannedEndDate: '2023-01-20' }
        ]
      }));
    });
    await page.reload();

    const progressColumnIndex = await page.locator('thead th').evaluateAll((headers) => (
      headers.findIndex((header) => header.textContent.trim() === '계획진척률')
    ));

    expect(progressColumnIndex).toBeGreaterThan(-1);
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(5);

    const getPlannedProgressRatio = async (index) => page.locator('tbody tr[data-task-id]').nth(index).locator('td').nth(progressColumnIndex).innerText();

    expect(await getPlannedProgressRatio(0)).toBe('0.00%');
    expect(await getPlannedProgressRatio(1)).toBe('0.00%');
    expect(await getPlannedProgressRatio(2)).toBe('100.00%');
    expect(await getPlannedProgressRatio(3)).toBe('100.00%');
    expect(await getPlannedProgressRatio(4)).toBe('50.00%');
  });

  test('calculates duration as zero for missing, invalid, and reversed dates', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Duration Test',
        baseDate: '2023-01-15',
        tasks: [
          { id: 'duration-1', task: 'Missing start', plannedStartDate: '', plannedEndDate: '2023-01-20' },
          { id: 'duration-2', task: 'Invalid start', plannedStartDate: 'invalid_date', plannedEndDate: '2023-01-20' },
          { id: 'duration-3', task: 'Reversed dates', plannedStartDate: '2023-01-20', plannedEndDate: '2023-01-10' },
          { id: 'duration-4', task: 'Same day', plannedStartDate: '2023-01-20', plannedEndDate: '2023-01-20' }
        ]
      }));
    });
    await page.reload();

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);

    const getDurationDays = async (index) => page.locator('tbody tr[data-task-id]').nth(index).locator('[data-testid="task-duration-days"]').innerText();

    expect(await getDurationDays(0)).toBe('0');
    expect(await getDurationDays(1)).toBe('0');
    expect(await getDurationDays(2)).toBe('0');
    expect(await getDurationDays(3)).toBe('1');
  });

  test('counts same-day work as one day for totals and weights', async ({ page }) => {
    await addTopLevelTask(page, {
      phase: 'P2000.검증단계',
      categoryLarge: '동일일자검증',
      owner: '담당자A',
      plannedStartDate: '2026-05-20',
      plannedEndDate: '2026-05-20'
    });

    await expect(page.getByTestId('summary-total-days')).toHaveText('12일');
    const taskRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '동일일자검증' });
    await expect(taskRow.locator('[data-testid="task-duration-days"]')).toContainText('1');
    await expect(taskRow.locator('[data-testid="task-weight-ratio"]')).not.toContainText('0.000');
  });

  test('derives correct progress state labels and classes based on dates', async ({ page }) => {
    await page.locator('[data-testid="base-date-input"]').fill('2026-05-15');

    // 1. 완료 (done)
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('완료테스트');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-10');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-14');
    await page.locator('[data-testid="editor-actual-start"]').fill('2026-05-10');
    await page.locator('[data-testid="editor-actual-end"]').fill('2026-05-12');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    // 2. 지연 (delay)
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('지연테스트');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-10');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-14');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    // 3. 진행 (active)
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('진행테스트');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-10');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-20');
    await page.locator('[data-testid="editor-actual-start"]').fill('2026-05-12');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    // 4. 진행전 (before) - baseDate between planned start/end
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('진행전기본테스트');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-10');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-20');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    // 5. 진행전 (before) - future baseDate < planned start
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('진행전미래테스트');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-20');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-25');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    const getBadge = (text) => page.locator('tbody tr[data-task-id]').filter({ hasText: text }).locator('.status-badge');

    await expect(getBadge('완료테스트')).toHaveText('완료');
    await expect(getBadge('완료테스트')).toHaveClass(/done/);

    await expect(getBadge('지연테스트')).toHaveText('지연');
    await expect(getBadge('지연테스트')).toHaveClass(/delay/);

    await expect(getBadge('진행테스트')).toHaveText('진행');
    await expect(getBadge('진행테스트')).toHaveClass(/active/);

    await expect(getBadge('진행전기본테스트')).toHaveText('진행전');
    await expect(getBadge('진행전기본테스트')).toHaveClass(/before/);

    await expect(getBadge('진행전미래테스트')).toHaveText('진행전');
    await expect(getBadge('진행전미래테스트')).toHaveClass(/before/);
  });

  test('rejects planned end dates before start dates in the editor', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('P3000.검증단계');
    await page.locator('[data-testid="editor-category-large"]').fill('일정검증');
    await page.locator('[data-testid="editor-owner"]').fill('담당자A');
    await page.locator('[data-testid="editor-planned-start"]').fill('2026-05-20');
    await page.locator('[data-testid="editor-planned-end"]').fill('2026-05-19');

    const saveButton = page.getByRole('button', { name: '저장', exact: true });
    await expect(saveButton).toBeDisabled();
    await expect(page.locator('[data-testid="editor-planned-end"]')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#editor-errors')).toContainText('계획종료일은 계획시작일보다 빠를 수 없습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects invalid calendar dates in the editor', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('P3000.검증단계');
    await page.locator('[data-testid="editor-planned-start"]').evaluate((input) => {
      input.setAttribute('type', 'text');
    });

    await page.locator('[data-testid="editor-planned-start"]').fill('2026-02-31');

    const saveButton = page.getByRole('button', { name: '저장', exact: true });
    await expect(saveButton).toBeDisabled();
    await expect(page.locator('[data-testid="editor-planned-start"]')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#editor-errors')).toContainText('계획시작일은 YYYY-MM-DD 형식의 실제 달력 날짜여야 합니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects HTML payloads from the UI editor', async ({ page }) => {
    await page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: '편집' }).click();

    await page.locator('[data-testid="editor-task"]').fill('<script>alert(1)</script>');

    const saveButton = page.locator('.editor-panel').getByRole('button', { name: '저장' });
    await expect(saveButton).toBeDisabled();
    await expect(page.locator('[data-testid="editor-task"]')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#editor-errors')).toContainText('HTML 태그 문자를 사용할 수 없습니다');
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('validateDraft pure function logic', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const result = await page.evaluate(() => {
      if (typeof window.validateDraft !== 'function') return { error: 'Not exported' };

      const tests = [];
      const debug = [];

      // Test missing draft
      tests.push(window.validateDraft(null, 1).length === 0);

      // Test HTML injection
      const htmlErrors = window.validateDraft({ phase: '<script>' }, 1);
      // Depending on mapping it could be Phase or 단계, check for both or just generic HTML message
      tests.push(htmlErrors.some(e => e.includes('HTML 태그 문자를 사용할 수 없습니다.')));
      if (!htmlErrors.some(e => e.includes('HTML 태그 문자를 사용할 수 없습니다.'))) debug.push('HTML injection failed: ' + JSON.stringify(htmlErrors));

      // Test required depth 1
      const depth1Errors = window.validateDraft({ phase: '' }, 1);
      tests.push(depth1Errors.includes('최상위 작업은 단계 값을 입력해야 합니다.'));
      if (!depth1Errors.includes('최상위 작업은 단계 값을 입력해야 합니다.')) debug.push('Depth 1 failed: ' + JSON.stringify(depth1Errors));

      // Test required depth 2
      const depth2Errors = window.validateDraft({ phase: 'P1', activity: '' }, 2);
      tests.push(depth2Errors.includes('2단계 작업은 Activity 값을 입력해야 합니다.'));
      if (!depth2Errors.includes('2단계 작업은 Activity 값을 입력해야 합니다.')) debug.push('Depth 2 failed: ' + JSON.stringify(depth2Errors));

      // Test required depth 3
      const depth3Errors = window.validateDraft({ phase: 'P1', activity: 'A1', task: '' }, 3);
      tests.push(depth3Errors.includes('3단계 작업은 Task 값을 입력해야 합니다.'));
      if (!depth3Errors.includes('3단계 작업은 Task 값을 입력해야 합니다.')) debug.push('Depth 3 failed: ' + JSON.stringify(depth3Errors));

      // Test date validation
      const dateErrors = window.validateDraft({ plannedStartDate: 'invalid-date' }, 1);
      tests.push(dateErrors.includes('계획시작일은 YYYY-MM-DD 형식의 실제 달력 날짜여야 합니다.'));
      if (!dateErrors.includes('계획시작일은 YYYY-MM-DD 형식의 실제 달력 날짜여야 합니다.')) debug.push('Date valid failed: ' + JSON.stringify(dateErrors));

      const rangeErrors = window.validateDraft({ plannedStartDate: '2026-05-20', plannedEndDate: '2026-05-18' }, 1);
      tests.push(rangeErrors.includes('계획종료일은 계획시작일보다 빠를 수 없습니다.'));
      if (!rangeErrors.includes('계획종료일은 계획시작일보다 빠를 수 없습니다.')) debug.push('Date range failed: ' + JSON.stringify(rangeErrors));

      return tests.every(t => t === true) ? 'PASS' : 'FAIL: ' + debug.join(' | ');
    });

    expect(result).toBe('PASS');
  });

  test('rejects saving a top-level task with HTML tags in the phase field', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('Test Phase <script>');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect(page.locator('#editor-errors')).toContainText('HTML 태그 문자를 사용할 수 없습니다');
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects saving a top-level task without a phase', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects saving a depth 2 task without an activity', async ({ page }) => {
    await page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: '하위 추가' }).click();
    await page.locator('[data-testid="editor-activity"]').fill('');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect(page.locator('#editor-errors')).toContainText('2단계 작업은 Activity 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects saving a depth 3 task without a task value', async ({ page }) => {
    await page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: '하위 추가' }).click();
    await page.locator('[data-testid="editor-activity"]').fill('Test Activity');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    const activityRow = page.locator('tbody tr[data-task-id].depth-2').filter({ has: page.locator('td:nth-child(3)', { hasText: /^Test Activity$/ }) });
    await activityRow.getByRole('button', { name: '하위 추가' }).click();
    await page.locator('[data-testid="editor-task"]').fill('');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect(page.locator('#editor-errors')).toContainText('3단계 작업은 Task 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
  });

  test('rejects empty CSV import', async ({ page }) => {
    await importCsv(page, '');

    await expect(page.locator('#toast')).toContainText('CSV 가져오기에 실패했습니다: CSV 데이터가 비어 있습니다.');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('rejects CSV import without data rows', async ({ page }) => {
    await importCsv(page, 'HeaderOnlyNoRows\n');

    await expect(page.locator('#toast')).toContainText('CSV 가져오기에 실패했습니다: CSV 데이터가 비어 있습니다.');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('rejects CSV import missing required headers', async ({ page }) => {
    await importCsv(page, [
      '단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척률,실적시작일,실적종료일',
      'P3000.검증단계,,누락컬럼,검증,,,담당자A,,,2026-03-01,2026-03-02,,,미착수(0%),,,'
    ].join('\n'));

    await expect(page.locator('#toast')).toContainText('CSV 가져오기에 실패했습니다: 필수 컬럼이 없습니다: 실적진척상태');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('rejects invalid calendar dates from imported CSV', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P3000.검증단계,,잘못된날짜,검증,,,담당자A,,,2026-02-31,2026-03-02,,,미착수(0%),,,'].join('\n'));

    await expect(page.locator('#toast')).toContainText('CSV 가져오기에 실패했습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('rejects imported CSV rows with planned end dates before start dates', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P3000.검증단계,,역전일정,검증,,,담당자A,,,2026-03-05,2026-03-02,,,미착수(0%),,,'].join('\n'));

    await expect(page.locator('#toast')).toContainText('계획종료일은 계획시작일보다 빠를 수 없습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('rejects HTML payloads from imported CSV', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P3000.검증단계,,<img src=x onerror=alert(1)>,검증,,,담당자A,,,2026-03-01,2026-03-02,,,미착수(0%),,,'].join('\n'));

    await expect(page.locator('#toast')).toContainText('HTML 태그 문자를 사용할 수 없습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.locator('tbody')).not.toContainText('onerror');
  });

  test('rejects HTML payloads from imported CSV internal columns', async ({ page }) => {
    const header = ['단계', 'Activity', 'Task', '대분류', '중분류', '산출물', '담당자', '지원팀', '진행상태', '계획시작일', '계획종료일', '일수', '계획진척률', '가중치', '가중치진척률', '실적진척상태', '실적진척률', '실적시작일', '실적종료일', '가중치실적진척률', '__id', '__parentId', '__depth'];
    const row = ['P3000.검증단계', '', '내부컬럼검증', '검증', '', '', '담당자A', '', '', '2026-03-01', '2026-03-02', '', '', '', '', '미착수(0%)', '', '', '', '', '<img src=x onerror=alert(1)>', '', '3'];

    await importCsv(page, [header.join(','), row.join(',')].join('\n'));

    await expect(page.locator('#toast')).toContainText('HTML 태그 문자를 사용할 수 없습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.locator('tbody')).not.toContainText('onerror');
  });

  test('rejects overlong imported CSV cells without truncating', async ({ page }) => {
    const overlongTaskName = 'A'.repeat(1001);

    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', `P3000.검증단계,,${overlongTaskName},검증,,,담당자A,,,2026-03-01,2026-03-02,,,미착수(0%),,,`].join('\n'));

    await expect(page.locator('#toast')).toContainText('Task 컬럼은 1000자 이하로 입력해야 합니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
    await expect(page.locator('tbody')).not.toContainText(overlongTaskName.substring(0, 1000));
  });

  test('normalizes imported task rows into a full phase-activity-task hierarchy', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P4000.이행단계,,고아Task,이행,,,담당자A,,,2026-06-01,2026-06-03,,,미착수(0%),,,'].join('\n'));

    const snapshot = await readHierarchySnapshot(page);
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0].phase).toBe('P4000.이행단계');
    expect(snapshot[1].activity).toBe('-');

    const activityCell = page.locator('tbody tr[data-task-id]').nth(1).locator('td').nth(2);
    await expect(activityCell.locator('.empty-cell > span[aria-hidden="true"]')).toHaveText('-');
    await expect(activityCell.locator('.empty-cell > .sr-only')).toHaveText('값 없음');

    expect(snapshot[2].task).toBe('고아Task');
  });

  test('normalizes repeated flat CSV rows into shared hierarchy nodes', async ({ page }) => {
    const header = '단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률';
    await importCsv(page, [
      header,
      'P1000.분석,요구사항,인터뷰,분석,,,담당자A,,,2026-06-01,2026-06-03,,,미착수(0%),,,',
      'P1000.분석,요구사항,정리,분석,,,담당자A,,,2026-06-04,2026-06-05,,,미착수(0%),,,',
      'P1000.분석,설계입력,초안,분석,,,담당자B,,,2026-06-06,2026-06-07,,,미착수(0%),,,',
      'P2000.구현,개발,,구현,,,담당자C,,,2026-06-08,2026-06-09,,,미착수(0%),,,',
      'P3000.종료,,,,,,담당자D,,,2026-06-10,2026-06-10,,,미착수(0%),,,'
    ].join('\n'));

    const snapshot = await readHierarchySnapshot(page);

    expect(snapshot).toEqual([
      { phase: 'P1000.분석', activity: '-', task: '-' },
      { phase: 'P1000.분석', activity: '요구사항', task: '-' },
      { phase: 'P1000.분석', activity: '요구사항', task: '인터뷰' },
      { phase: 'P1000.분석', activity: '요구사항', task: '정리' },
      { phase: 'P1000.분석', activity: '설계입력', task: '-' },
      { phase: 'P1000.분석', activity: '설계입력', task: '초안' },
      { phase: 'P2000.구현', activity: '-', task: '-' },
      { phase: 'P2000.구현', activity: '개발', task: '-' },
      { phase: 'P3000.종료', activity: '-', task: '-' }
    ]);
  });

  test('can edit an existing row and cancel the edit', async ({ page }) => {
    const targetRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '사업수행계획' }).first();
    const originalOwner = await targetRow.locator('.owner-badge').innerText();
    await targetRow.getByRole('button', { name: '편집' }).click();
    await expect(page.locator('.editor-panel')).toBeVisible();

    await expect(page.getByTestId('editor-category-large')).toHaveAttribute('placeholder', '예: 공통');
    await expect(page.getByTestId('editor-category-medium')).toHaveAttribute('placeholder', '예: 기획');
    await expect(page.getByTestId('editor-document-name')).toHaveAttribute('placeholder', '예: 요구사항정의서');
    await expect(page.getByTestId('editor-owner')).toHaveAttribute('placeholder', '예: 홍길동');
    await expect(page.getByTestId('editor-support-team')).toHaveAttribute('placeholder', '예: 인프라팀');

    const saveBtn = page.getByRole('button', { name: '저장', exact: true });
    await expect(saveBtn).toHaveAttribute('title', '저장 (Enter)');
    await expect(saveBtn).toHaveAttribute('aria-keyshortcuts', 'Enter');

    const cancelBtn = page.getByRole('button', { name: '취소' });
    await expect(cancelBtn).toHaveAttribute('title', '취소 (Esc)');
    await expect(cancelBtn).toHaveAttribute('aria-keyshortcuts', 'Escape');

    await page.locator('[data-testid="editor-owner"]').fill('임시담당자');
    await cancelBtn.click();

    await expect(page.locator('.editor-panel')).toBeHidden();
    await expect(targetRow).not.toContainText('임시담당자');
    await expect(targetRow.locator('.owner-badge')).toHaveText(originalOwner);
  });

  test('can trigger CSV export download', async ({ page }, testInfo) => {
    await addTopLevelTask(page, {
      phase: '=HYPERLINK("http://evil.test","Click")',
      categoryLarge: 'CSV검증',
      owner: '담당자A',
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });
    await createActivitySubtree(page, 'CSV 활동', '@SUM(1,1)');
    await createActivitySubtree(page, 'DDE 활동', "|'cmd' /C calc'!A0");

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV 내보내기' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^wbs_export_\d{8}\.csv$/);
    const downloadPath = await download.path();
    const csvPath = downloadPath || testInfo.outputPath(download.suggestedFilename());
    if (!downloadPath) {
      await download.saveAs(csvPath);
    }
    const csvText = fs.readFileSync(csvPath, 'utf8');
    expect(csvText).toContain(`"'=HYPERLINK(""http://evil.test"",""Click"")"`);
    expect(csvText).toContain(`"'@SUM(1,1)"`);
    expect(csvText).toContain(`"'|'cmd' /C calc'!A0"`);
  });

  test('can trigger CSV import file chooser', async ({ page }) => {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'CSV 가져오기' }).click();
    const fileChooser = await fileChooserPromise;
    expect(fileChooser.isMultiple()).toBe(false);
  });

  test('truncates project names from input and persisted state', async ({ page }) => {
    const input = page.locator('#project-name');
    const longName = 'A'.repeat(150);

    await input.fill(longName);
    await expect(input).toHaveValue('A'.repeat(120));

    await page.evaluate((projectName) => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName,
        baseDate: '2026-04-20',
        tasks: []
      }));
    }, 'B'.repeat(150));
    await page.reload();
    await expect(input).toHaveValue('B'.repeat(120));
  });

  test('neutralizes spreadsheet formulas during CSV import', async ({ page }) => {
    const csvText = [
      '단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,실적진척상태,계획시작일,계획종료일,실적시작일,실적종료일',
      `"=HYPERLINK(""http://evil.test"",""Click"")",@SUM(1,1),+cmd,|DDE,,"|'cmd' /C calc'!A0",담당자A,지원팀A,미착수(0%),2026-05-18,2026-05-20,,`
    ].join('\n');

    await importCsv(page, csvText);

    const savedState = await page.evaluate(() => JSON.parse(localStorage.getItem('scopeweave:planner-state:v1')));
    const [savedTask] = savedState.tasks;
    expect(savedTask.phase).toBe('\'=HYPERLINK("http://evil.test","Click")');
    expect(savedTask.activity).toBe("'@SUM(1,1)");
    expect(savedTask.task).toBe("'+cmd");
    expect(savedTask.categoryLarge).toBe("'|DDE");
    expect(savedTask.deliverable).toBe("'|'cmd' /C calc'!A0");
  });

  test('buildWeekdayTimeline handles normal, same, reversed, and weekend dates', async ({ page }) => {
    await page.goto('./');
    const appJsCode = require('fs').readFileSync('app.js', 'utf-8');
    await page.evaluate((code) => {
      const func = new Function('minDate', 'maxDate', code + '\nreturn buildWeekdayTimeline(minDate, maxDate);');
      window.__buildWeekdayTimeline = func;
    }, appJsCode);

    // Normal date range
    const normal = await page.evaluate(() => window.__buildWeekdayTimeline('2026-05-01', '2026-05-15'));
    expect(normal.length).toBeGreaterThan(0);
    expect(normal[0].date).toBe('2026-04-27'); // Starts on preceding Monday
    expect(normal[normal.length - 1].date).toBe('2026-05-15'); // Ends on Friday

    // Same date
    const same = await page.evaluate(() => window.__buildWeekdayTimeline('2026-05-01', '2026-05-01'));
    expect(same.length).toBe(5);
    expect(same[0].date).toBe('2026-04-27');
    expect(same[same.length - 1].date).toBe('2026-05-01');

    // Reversed date range
    const reversed = await page.evaluate(() => window.__buildWeekdayTimeline('2026-05-15', '2026-05-01'));
    expect(reversed).toEqual([]);

    // Weekend date
    const weekend = await page.evaluate(() => window.__buildWeekdayTimeline('2026-05-02', '2026-05-03'));
    expect(weekend.length).toBe(5);
    expect(weekend[0].date).toBe('2026-04-27');
    expect(weekend[weekend.length - 1].date).toBe('2026-05-01'); // Returns the preceding week
  });

  test('wraps text icons in aria-hidden span for screen reader accessibility', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('A11y Test');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    // Check Gantt Close Button
    const closeBtnSpan = page.locator('#close-gantt span');
    await expect(closeBtnSpan).toHaveAttribute('aria-hidden', 'true');
    await expect(closeBtnSpan).toHaveText('✕');

    // Check Row Action Buttons
    const row = page.locator('tr.task-row').first();
    const toggleBtnSpan = row.locator('button[data-action="toggle"] span');
    await expect(toggleBtnSpan).toHaveAttribute('aria-hidden', 'true');
    await expect(toggleBtnSpan).toHaveText('▼');

    const addChildBtnSpan = row.locator('button[data-action="add-child"] span');
    await expect(addChildBtnSpan).toHaveAttribute('aria-hidden', 'true');
    await expect(addChildBtnSpan).toHaveText('＋');
  });

  test('mitigates XSS in createTextCellContent via textNode', async ({ page }) => {
    const result = await page.evaluate(() => {
      const wrapper = window.createTextCellContent('<img src=x onerror=alert(1)>', '날짜 오류');
      document.body.appendChild(wrapper);
      return {
        imageCount: wrapper.querySelectorAll('img').length,
        text: wrapper.textContent
      };
    });

    expect(result.imageCount).toBe(0);
    expect(result.text).toContain('<img src=x onerror=alert(1)>');
    expect(result.text).toContain('날짜 오류');
  });

  test('hardens dynamically generated download links', async ({ page }) => {
    await addTopLevelTask(page, {
      phase: 'Download hardening',
      categoryLarge: 'Security',
      owner: '담당자A',
      plannedStartDate: '2026-05-18',
      plannedEndDate: '2026-05-20'
    });

    await page.evaluate(() => {
      window.__downloadLinkSecurity = null;
      URL.createObjectURL = () => 'blob:scopeweave-test';
      URL.revokeObjectURL = () => {};

      HTMLAnchorElement.prototype.click = function click() {
        window.__downloadLinkSecurity = {
          download: this.download,
          rel: this.rel,
          appendedBeforeClick: document.body.contains(this),
          removedViaPrototype: false
        };
      };

      const originalRemove = Element.prototype.remove;
      Element.prototype.remove = function remove() {
        if (this.tagName === 'A' && window.__downloadLinkSecurity) {
          window.__downloadLinkSecurity.removedViaPrototype = true;
          window.__downloadLinkSecurity.relAtRemove = this.rel;
        }
        return originalRemove.call(this);
      };
    });

    await page.getByRole('button', { name: 'CSV 내보내기' }).click();

    const security = await page.evaluate(() => window.__downloadLinkSecurity);
    expect(security.download).toMatch(/^wbs_export_\d{8}\.csv$/);
    expect(security.rel).toBe('noopener noreferrer');
    expect(security.appendedBeforeClick).toBe(true);
    expect(security.removedViaPrototype).toBe(true);
    expect(security.relAtRemove).toBe('noopener noreferrer');
  });
});


test.describe('validateImportedTasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.__scopeweaveTestApi?.validateImportedTasks === 'function');
  });

  test('should validate valid tasks', async ({ page }) => {
    const result = await page.evaluate(() => {
      const tasks = [
        { id: '1', parentId: null },
        { id: '2', parentId: '1' }
      ];
      return window.__scopeweaveTestApi.validateImportedTasks(tasks);
    });
    expect(result).toHaveLength(2);
  });

  test('should throw error on duplicate IDs', async ({ page }) => {
    const errorMsg = await page.evaluate(() => {
      const tasks = [
        { id: '1', parentId: null },
        { id: '1', parentId: null }
      ];
      try {
        window.__scopeweaveTestApi.validateImportedTasks(tasks);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    expect(errorMsg).toContain('중복된 ID가 발견되었습니다: 1');
  });

  test('should throw error on non-existent parent IDs', async ({ page }) => {
    const errorMsg = await page.evaluate(() => {
      const tasks = [
        { id: '1', parentId: null },
        { id: '2', parentId: '999' }
      ];
      try {
        window.__scopeweaveTestApi.validateImportedTasks(tasks);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    expect(errorMsg).toContain('존재하지 않는 부모 ID를 참조합니다: 999');
  });

  test('should throw error on circular references', async ({ page }) => {
    const errorMsg = await page.evaluate(() => {
      const tasks = [
        { id: '1', parentId: '3' },
        { id: '2', parentId: '1' },
        { id: '3', parentId: '2' }
      ];
      try {
        window.__scopeweaveTestApi.validateImportedTasks(tasks);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    expect(errorMsg).toContain('순환 참조가 발견되었습니다');
  });
});

test.describe('ScopeWeave Planner - Palette UX Enhancements', () => {
  test('adds helpful placeholder to project name input', async ({ page }) => {
    await page.goto('./');

    const projectNameInput = page.getByTestId('project-name-input');
    await expect(projectNameInput).toHaveAttribute('placeholder', '예: 신규 서비스 구축 프로젝트');
  });

  test('adds helpful placeholder to project name input on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('./');

    const projectNameInput = page.getByTestId('project-name-input');
    await expect(projectNameInput).toHaveAttribute('placeholder', '예: 신규 서비스 구축 프로젝트');
  });
});
