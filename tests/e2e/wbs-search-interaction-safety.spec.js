import { test, expect } from '@playwright/test';

test.describe('WBS search interaction safety', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('prevents drag reordering while filtered rows hide sibling context', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    const rows = page.locator('tbody tr[data-task-id]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute('draggable', 'false');
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'false');
    await expect(rows.nth(2)).toHaveAttribute('draggable', 'false');
  });

  test('blocks hierarchy changes while filtered rows hide context', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    const rows = page.locator('tbody tr[data-task-id]');
    const addRoot = page.getByRole('button', { name: '최상위 작업 추가' });
    const addChild = rows.first().getByRole('button', { name: /하위 추가 -/ });
    const deleteButton = rows.first().getByRole('button', { name: /삭제 -/ });

    await expect(addRoot).toHaveAttribute('aria-disabled', 'true');
    const toggle = rows.first().locator('button[data-action="toggle"]');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await toggle.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중 계층 맥락 고정');
    await expect(addChild).toHaveAttribute('aria-disabled', 'true');
    await expect(deleteButton).toHaveAttribute('aria-disabled', 'true');

    await addChild.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 추가할 수 없습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);

    await addRoot.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 추가할 수 없습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);

    await deleteButton.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 삭제할 수 없습니다.');
    await expect(rows).toHaveCount(3);
  });

  test('searches planning values and clears the query when CSV replaces the plan', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Planning search',
        baseDate: '2026-08-29',
        tasks: [{
          id: 'planning-search-task',
          parentId: null,
          depth: 3,
          expanded: true,
          phase: '계획',
          activity: '검색',
          task: '계획 값',
          budget: '125000',
          actualCost: '90000',
          storyPoints: '13'
        }]
      }));
    });
    await page.reload();

    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    const rows = page.locator('tbody tr[data-task-id]');
    for (const query of ['125000', '90000', '13']) {
      await search.fill(query);
      await expect(rows).toHaveCount(1);
    }

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#csv-file-input').setInputFiles({
      name: 'replacement.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from([
        '단계,Activity,Task,대분류,중분류,산출물,담당자,지원팀,진행상태,계획시작일,계획종료일,일수,계획진척률,가중치,가중치진척률,실적진척상태,실적진척률,실적시작일,실적종료일,가중치실적진척률,__id,__parentId,__depth,선행작업,예산,실투입비,스프린트,스토리포인트',
        '교체 단계,,,,,,,,,,,,,,미착수(0%),,,,,replacement-task,,,3,,,,,'
      ].join('\n'))
    });
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('교체 단계');
  });

  test('keeps an open editor visible by pausing search changes until editing finishes', async ({ page }) => {
    const firstRow = page.locator('tbody tr[data-task-id]').first();
    await firstRow.getByRole('button', { name: /편집 -/ }).click();

    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' })).toBeDisabled();
  });

  test('keeps the depth-limit explanation actionable when search is inactive', async ({ page }) => {
    const leafAddChild = page.locator('tbody tr[data-task-id].depth-3').first().locator('button[data-action="add-child"]');

    await expect(leafAddChild).toHaveAttribute('aria-disabled', 'true');
    await leafAddChild.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('최대 3단계까지만 추가할 수 있습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });
});
