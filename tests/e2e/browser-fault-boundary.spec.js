import { test, expect } from './coverage-test.js';

const routeSeed = async (page, tasks) => {
  await page.route('**/wbs.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(tasks),
  }));
};

const rootTask = (overrides = {}) => ({
  __id: 'root-task',
  __depth: 1,
  phase: 'Coverage Phase',
  plannedStartDate: '2026-08-17',
  plannedEndDate: '2026-08-21',
  ...overrides,
});

test.describe('browser fault-boundary behavior', () => {
  test('closes Gantt through backdrop and Escape while trapping keyboard focus', async ({ page }) => {
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    const open = page.getByRole('button', { name: '간트차트보기' });
    const modal = page.locator('#gantt-modal');
    const close = page.getByRole('button', { name: '간트 차트 닫기' });

    await open.click();
    await expect(modal).not.toHaveClass(/hidden/);
    await modal.locator('.modal-backdrop[data-close-modal="true"]').click({ position: { x: 2, y: 2 } });
    await expect(modal).toHaveClass(/hidden/);
    await expect(open).toBeFocused();

    await open.click();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/);
    await expect(open).toBeFocused();

    await open.click();
    const planBar = modal.locator('.gantt-bar.plan').first();
    await expect(planBar).toBeVisible();
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(planBar).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
  });

  test('keeps a dirty editor open when cancellation is rejected and closes after confirmation', async ({ page }) => {
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    const row = page.locator('tr[data-task-id="root-task"]');
    await row.getByRole('button', { name: '편집 - Coverage Phase' }).click();
    await page.getByTestId('editor-owner').fill('Changed Owner');

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.getByTestId('editor-owner')).toHaveValue('Changed Owner');

    page.once('dialog', (dialog) => dialog.accept());
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });

  test('explains the leaf-depth boundary and restores useful focus after deleting the final task', async ({ page }) => {
    await routeSeed(page, [
      rootTask(),
      {
        __id: 'activity-task',
        __parentId: 'root-task',
        __depth: 2,
        phase: 'Coverage Phase',
        activity: 'Coverage Activity',
      },
      {
        __id: 'leaf-task',
        __parentId: 'activity-task',
        __depth: 3,
        phase: 'Coverage Phase',
        activity: 'Coverage Activity',
        task: 'Coverage Leaf',
      },
    ]);
    await page.goto('/');

    const leafAdd = page.locator('tr[data-task-id="leaf-task"]').getByRole('button', { name: '하위 추가 - Coverage Leaf' });
    await expect(leafAdd).toHaveAttribute('aria-disabled', 'true');
    await leafAdd.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toast')).toContainText('최대 3단계까지만 추가할 수 있습니다');

    const rootDelete = page.locator('tr[data-task-id="root-task"]').getByRole('button', { name: '삭제 - Coverage Phase' });
    page.once('dialog', (dialog) => dialog.accept());
    await rootDelete.click();
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '최상위 작업 추가' }).last()).toBeFocused();
  });

  test('connects a writable JSON file and records the exported plan', async ({ page }) => {
    await page.addInitScript(() => {
      window.__scopeweavePickerWrites = [];
      window.__scopeweavePickerClosed = false;
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({
          async createWritable() {
            return {
              async write(value) { window.__scopeweavePickerWrites.push(value); },
              async close() { window.__scopeweavePickerClosed = true; },
            };
          },
        }),
      });
    });
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    await page.getByRole('button', { name: /wbs\.json 자동저장 연결/ }).click();
    await expect(page.locator('#sync-status')).toContainText('연결된 wbs.json 파일');
    await expect(page.locator('#toast')).toContainText('자동저장 연결이 완료되었습니다');
    await expect.poll(() => page.evaluate(() => window.__scopeweavePickerWrites.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__scopeweavePickerClosed)).toBe(true);
    const exported = JSON.parse(await page.evaluate(() => window.__scopeweavePickerWrites.at(-1)));
    expect(exported[0].phase).toBe('Coverage Phase');
  });

  test('treats file-picker cancellation as cancellation rather than a product failure', async ({ page }) => {
    await page.addInitScript(() => {
      window.__scopeweavePickerAttempted = false;
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => {
          window.__scopeweavePickerAttempted = true;
          throw new DOMException('cancelled', 'AbortError');
        },
      });
    });
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    await page.getByRole('button', { name: /wbs\.json 자동저장 연결/ }).click();
    await expect.poll(() => page.evaluate(() => window.__scopeweavePickerAttempted)).toBe(true);
    await expect(page.locator('#toast')).not.toContainText('wbs.json 연결에 실패했습니다');
    await expect(page.locator('#sync-status')).toContainText('브라우저 로컬 자동저장');
  });

  test('surfaces a non-cancellation file-picker failure without pretending sync succeeded', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => { throw new Error('forced picker failure'); },
      });
    });
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    await page.getByRole('button', { name: /wbs\.json 자동저장 연결/ }).click();
    await expect(page.locator('#toast')).toContainText('wbs.json 연결에 실패했습니다');
    await expect(page.locator('#sync-status')).toContainText('브라우저 로컬 자동저장');
  });

  test('rejects oversized and malformed CSV imports without replacing the current plan', async ({ page }) => {
    await routeSeed(page, []);
    await page.goto('/');

    const input = page.locator('#csv-file-input');
    await input.setInputFiles({
      name: 'too-large.csv',
      mimeType: 'text/csv',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x41),
    });
    await expect(page.locator('#toast')).toContainText('5MB를 초과할 수 없습니다');

    await input.setInputFiles({
      name: 'malformed.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('foo,bar\nvalue,other', 'utf8'),
    });
    await expect(page.locator('#toast')).toContainText('필수 컬럼이 없습니다');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
  });

  test('honors CSV replacement cancellation and clears the chooser for a safe retry', async ({ page }) => {
    await routeSeed(page, [rootTask()]);
    await page.goto('/');

    const headers = [
      '단계', 'Activity', 'Task', '대분류', '중분류', '산출물', '담당자', '지원팀',
      '실적진척상태', '계획시작일', '계획종료일', '실적시작일', '실적종료일',
    ];
    const replacement = [
      'Replacement Phase', '', '', '', '', '', '', '', '미착수(0%)',
      '2026-08-20', '2026-08-21', '', '',
    ];
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#csv-file-input').setInputFiles({
      name: 'replacement.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${headers.join(',')}\n${replacement.join(',')}`, 'utf8'),
    });

    await expect(page.locator('tr[data-task-id="root-task"]')).toBeVisible();
    await expect(page.getByText('Replacement Phase', { exact: true })).toHaveCount(0);
    await expect(page.locator('#csv-file-input')).toHaveValue('');
  });
});
