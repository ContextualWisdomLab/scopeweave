const { test, expect } = require('@playwright/test');

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
  phase: row.children[1]?.innerText.trim() || '',
  activity: row.children[2]?.innerText.trim() || '',
  task: row.children[3]?.innerText.trim() || ''
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
    await childRow.getByRole('button', { name: '하위 추가' }).click();
    await page.locator('[data-testid="editor-task"]').fill('세부업무');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    const leafRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '세부업무' });
    await expect(leafRow).toHaveCount(1);
    await expect(leafRow.getByRole('button', { name: '하위 추가' })).toBeDisabled();
  });

  test('opens gantt modal and renders chart bars with correct inline styles', async ({ page }) => {
    await page.getByRole('button', { name: '간트차트보기' }).click();
    await expect(page.getByRole('dialog', { name: '간트 차트' })).toBeVisible();
    await expect(page.locator('.gantt-bar.plan')).toHaveCount(2);

    const firstBar = page.locator('.gantt-bar.plan').first();
    await expect(firstBar).toHaveAttribute('style', /width:\s*\d+px/);
    await expect(firstBar).toHaveAttribute('style', /left:\s*\d+px/);
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
    expect(savedPayload[0]).toHaveProperty('plannedEndDdate');
    expect(savedPayload[0]).not.toHaveProperty('plannedEndDate');
    expect(savedPayload[0].task).toBe('사업수행계획');
    expect(savedPayload[1].task).toBe('단계작업계획');
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

  test('rejects invalid calendar dates from imported CSV', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P3000.검증단계,,잘못된날짜,검증,,,담당자A,,,2026-02-31,2026-03-02,,,미착수(0%),,,'].join('\n'));

    await expect(page.locator('#toast')).toContainText('CSV 가져오기에 실패했습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  });

  test('normalizes imported task rows into a full phase-activity-task hierarchy', async ({ page }) => {
    await importCsv(page, ['단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률', 'P4000.이행단계,,고아Task,이행,,,담당자A,,,2026-06-01,2026-06-03,,,미착수(0%),,,'].join('\n'));

    const snapshot = await readHierarchySnapshot(page);
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0].phase).toBe('P4000.이행단계');
    expect(snapshot[1].activity).toBe('-');
    expect(snapshot[2].task).toBe('고아Task');
  });

  test('can edit an existing row and cancel the edit', async ({ page }) => {
    const targetRow = page.locator('tbody tr[data-task-id]').filter({ hasText: '사업수행계획' }).first();
    const originalOwner = await targetRow.locator('.owner-badge').innerText();
    await targetRow.getByRole('button', { name: '편집' }).click();
    await expect(page.locator('.editor-panel')).toBeVisible();

    await page.locator('[data-testid="editor-owner"]').fill('임시담당자');
    await page.getByRole('button', { name: '취소' }).click();

    await expect(page.locator('.editor-panel')).toBeHidden();
    await expect(targetRow).not.toContainText('임시담당자');
    await expect(targetRow.locator('.owner-badge')).toHaveText(originalOwner);
  });

  test('can trigger CSV export download', async ({ page }) => {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV 내보내기' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^wbs_export_\d{8}\.csv$/);
  });

  test('can trigger CSV import file chooser', async ({ page }) => {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'CSV 가져오기' }).click();
    const fileChooser = await fileChooserPromise;
    expect(fileChooser.isMultiple()).toBe(false);
  });
});
