import { test, expect } from '@playwright/test';

test('cloud status feedback is visibly rendered as a non-focus-taking live status', async ({ page }) => {
  await page.goto('/?share=ABCDEFGHIJKLMNOP');

  const toast = page.locator('#toast');
  await expect(toast).toHaveText('공유 링크가 만료되었거나 철회되었습니다.');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  await expect(toast).toHaveAttribute('aria-atomic', 'true');
  await expect(toast).not.toHaveAttribute('tabindex', /.+/);
  await expect(toast).toHaveClass(/\bvisible\b/);
  await expect(toast).toBeVisible();

  await expect.poll(
    () => toast.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    { message: 'advisory status must reach its fully visible transition state' },
  ).toBeGreaterThanOrEqual(0.99);

  await expect.poll(
    () => toast.evaluate((element) => document.activeElement === element),
    { message: 'advisory status must not capture keyboard focus' },
  ).toBe(false);
});

test('disabled empty-state actions expose and announce a reason plus next action', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
      projectName: 'Empty Scope',
      baseDate: '2026-04-20',
      tasks: [],
    }));
  });
  await page.goto('/');

  const exportButton = page.getByRole('button', { name: 'CSV 내보내기' });
  const ganttButton = page.getByRole('button', { name: '간트차트보기' });
  const help = page.locator('#task-dependent-actions-help');
  const status = page.locator('#task-dependent-actions-status');

  await expect(exportButton).toBeDisabled();
  await expect(ganttButton).toBeDisabled();
  await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
  await expect(ganttButton).toHaveAttribute('aria-disabled', 'true');
  await expect(exportButton).toHaveAttribute('aria-describedby', 'task-dependent-actions-help');
  await expect(ganttButton).toHaveAttribute('aria-describedby', 'task-dependent-actions-help');
  await expect(help).not.toHaveAttribute('role', 'status');
  await expect(help).not.toHaveAttribute('hidden', '');
  await expect(help).toBeVisible();
  await expect(help).toContainText('작업을 추가하거나 CSV를 가져오세요');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  await expect(status).toHaveClass(/\bsr-only\b/);
  await expect(status).toHaveText('작업이 없어 CSV 내보내기와 간트차트를 사용할 수 없습니다. 최상위 작업을 추가하거나 CSV를 가져오세요.');
});

test('task-dependent help disappears and detaches once the actions are available', async ({ page }) => {
  await page.goto('/');

  const exportButton = page.getByRole('button', { name: 'CSV 내보내기' });
  const ganttButton = page.getByRole('button', { name: '간트차트보기' });
  const help = page.locator('#task-dependent-actions-help');
  const status = page.locator('#task-dependent-actions-status');

  await expect(page.locator('tbody tr[data-task-id]')).not.toHaveCount(0);
  await expect(exportButton).toBeEnabled();
  await expect(ganttButton).toBeEnabled();
  await expect(exportButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(ganttButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(exportButton).not.toHaveAttribute('aria-describedby', 'task-dependent-actions-help');
  await expect(ganttButton).not.toHaveAttribute('aria-describedby', 'task-dependent-actions-help');
  await expect(help).toHaveAttribute('hidden', '');
  await expect(help).toBeHidden();
  await expect(status).toHaveText('');
});

test('the last task becoming unavailable is announced through an always-present live region', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
      projectName: 'One Task Scope',
      baseDate: '2026-04-20',
      tasks: [{
        id: 'task-only',
        parentId: null,
        depth: 1,
        expanded: true,
        isSynthetic: false,
        phase: '검증 단계',
        activity: '',
        task: '',
        actualProgressStatus: '미착수(0%)',
      }],
    }));
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');

  const status = page.locator('#task-dependent-actions-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  await expect(status).toHaveText('');

  await page.getByRole('button', { name: /삭제 - 검증 단계/ }).click();

  await expect(page.getByRole('button', { name: 'CSV 내보내기' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '간트차트보기' })).toBeDisabled();
  await expect(status).toHaveText('작업이 없어 CSV 내보내기와 간트차트를 사용할 수 없습니다. 최상위 작업을 추가하거나 CSV를 가져오세요.');
  await expect(page.locator('#task-dependent-actions-help')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#task-dependent-actions-help')).toBeVisible();
  await expect(page.locator('#add-root-task')).toBeFocused();
});
