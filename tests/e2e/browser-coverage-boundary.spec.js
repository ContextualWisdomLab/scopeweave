import { test, expect } from './coverage-test.js';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

const hierarchy = [
  { id: 'root-a', parentId: null, depth: 1, expanded: true, phase: 'Root A', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualProgressStatus: '미착수(0%)' },
  { id: 'activity-a', parentId: 'root-a', depth: 2, expanded: true, phase: 'Root A', activity: 'Activity A', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualProgressStatus: '미착수(0%)' },
  { id: 'leaf-a', parentId: 'activity-a', depth: 3, expanded: true, phase: 'Root A', activity: 'Activity A', task: 'Leaf A', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualProgressStatus: '미착수(0%)' },
  { id: 'root-b', parentId: null, depth: 1, expanded: true, phase: 'Root B', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualProgressStatus: '미착수(0%)' },
];

async function seedPlanner(page, tasks = hierarchy, { captureHost = false } = {}) {
  await page.addInitScript(({ storageKey, seedTasks, shouldCaptureHost }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      projectName: 'Coverage boundary',
      baseDate: '2026-08-19',
      tasks: seedTasks,
    }));

    if (!shouldCaptureHost) return;
    let cloudApi;
    Object.defineProperty(window, 'ScopeWeaveCloud', {
      configurable: true,
      get() { return cloudApi; },
      set(value) {
        if (value && typeof value.init === 'function') {
          const originalInit = value.init;
          value.init = function capturePlannerHost(hostApi) {
            window.__scopeweavePlannerHost = hostApi;
            return originalInit.call(this, hostApi);
          };
        }
        cloudApi = value;
      },
    });
  }, { storageKey: STORAGE_KEY, seedTasks: tasks, shouldCaptureHost: captureHost });
}

function dragEventPayload() {
  return { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() };
}

test.describe('browser defensive coverage boundaries', () => {
  test('fails closed for stale table events while preserving valid drag behavior', async ({ page }) => {
    await seedPlanner(page);
    await page.goto('/');

    const result = await page.evaluate(() => {
      const tbody = document.querySelector('#task-table-body');
      const rootA = document.querySelector('tr[data-task-id="root-a"]');
      const activity = document.querySelector('tr[data-task-id="activity-a"]');
      const rootB = document.querySelector('tr[data-task-id="root-b"]');
      if (!tbody || !rootA || !activity || !rootB) throw new Error('expected seeded rows');

      tbody.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      tbody.dispatchEvent(new DragEvent('dragstart', dragEventPayload()));
      tbody.dispatchEvent(new DragEvent('dragover', dragEventPayload()));
      tbody.dispatchEvent(new DragEvent('drop', dragEventPayload()));
      tbody.dispatchEvent(new DragEvent('dragend', dragEventPayload()));

      const invalidTransfer = new DataTransfer();
      rootA.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: invalidTransfer }));
      activity.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: invalidTransfer,
        clientY: activity.getBoundingClientRect().bottom - 1,
      }));
      rootA.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: invalidTransfer }));

      const validTransfer = new DataTransfer();
      rootA.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: validTransfer }));
      rootB.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: validTransfer,
        clientY: rootB.getBoundingClientRect().bottom - 1,
      }));
      const becameDropTarget = rootB.classList.contains('drop-target');
      rootB.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: validTransfer }));
      const clearedDropTarget = !rootB.classList.contains('drop-target');
      rootA.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: validTransfer }));

      const progress = rootA.querySelector('[data-inline-progress]');
      progress.dataset.inlineProgress = 'missing-task';
      progress.dispatchEvent(new Event('change', { bubbles: true }));

      const edit = rootA.querySelector('[data-action="edit"]');
      rootA.dataset.taskId = 'missing-task';
      edit.click();
      rootA.querySelector('td:nth-child(2)').click();

      return { becameDropTarget, clearedDropTarget };
    });

    expect(result).toEqual({ becameDropTarget: true, clearedDropTarget: true });

    const leafAdd = page.locator('tr[data-task-id="leaf-a"] [data-action="add-child"]');
    await leafAdd.evaluate((button) => button.removeAttribute('aria-disabled'));
    await leafAdd.click();
    await expect(page.locator('#toast')).toContainText('최대 3단계까지만 추가할 수 있습니다');
  });

  test('keeps editor validation and stale edit races contained', async ({ page }) => {
    await seedPlanner(page, hierarchy, { captureHost: true });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__scopeweavePlannerHost));

    const root = page.locator('tr[data-task-id="root-a"]');
    await root.getByRole('button', { name: '편집 - Root A' }).click();
    await page.getByTestId('editor-owner').fill('Updated owner');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('tr[data-task-id="root-a"]')).toContainText('Updated owner');

    await page.locator('tr[data-task-id="root-a"]').getByRole('button', { name: '편집 - Root A' }).click();
    await page.getByTestId('editor-phase').fill('');
    await page.locator('form[data-editor-form="true"]').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다');

    page.once('dialog', (dialog) => dialog.accept());
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-panel')).toHaveCount(0);

    await page.evaluate(() => {
      const host = window.__scopeweavePlannerHost;
      host.hydrateState({ projectName: 'Concurrent replacement', baseDate: '2026-08-19', tasks: [] });
    });
    await page.locator('tr[data-task-id="root-a"] [data-action="edit"]').click();
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });

  test('recovers from local-state and seed-read failures', async ({ page }) => {
    await page.addInitScript((storageKey) => {
      const nativeGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function guardedGetItem(key) {
        if (key === storageKey) throw new DOMException('blocked', 'SecurityError');
        return nativeGetItem.call(this, key);
      };
    }, STORAGE_KEY);
    await page.route('**/wbs.json', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto('/');

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '최상위 작업 추가' }).first()).toBeVisible();
  });

  test('treats a non-array seed document as an empty plan', async ({ page }) => {
    await page.route('**/wbs.json', (route) => route.fulfill({ contentType: 'application/json', body: '{"unexpected":true}' }));
    await page.goto('/');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
    await expect(page.locator('.table-empty')).toContainText('등록된 작업이 없습니다');
  });

  test('covers empty, invalid-depth, and CRLF CSV chooser boundaries', async ({ page }) => {
    await page.route('**/wbs.json', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('/');

    await page.locator('#csv-file-input').evaluate((input) => input.dispatchEvent(new Event('change', { bubbles: true })));
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);

    const required = ['단계', 'Activity', 'Task', '대분류', '중분류', '산출물', '담당자', '지원팀', '실적진척상태', '계획시작일', '계획종료일', '실적시작일', '실적종료일', '__depth'];
    const invalidDepth = ['Invalid depth', '', '', '', '', '', '', '', '미착수(0%)', '2026-08-20', '2026-08-21', '', '', '9'];
    await page.locator('#csv-file-input').setInputFiles({
      name: 'invalid-depth.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${required.join(',')}\r\n${invalidDepth.join(',')}\r\n`, 'utf8'),
    });
    await expect(page.locator('#toast')).toContainText('__depth 컬럼은 1, 2, 3 중 하나여야 합니다');

    const valid = ['CRLF phase', '', '', '', '', '', '', '', '미착수(0%)', '2026-08-20', '2026-08-21', '', '', '1'];
    await page.locator('#csv-file-input').setInputFiles({
      name: 'valid-crlf.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${required.join(',')}\r\n${valid.join(',')}\r\n`, 'utf8'),
    });
    await expect(page.getByText('CRLF phase', { exact: true })).toHaveCount(1);
  });

  test('detects picker disappearance and a later connected-file write failure', async ({ page }) => {
    await page.addInitScript(() => {
      window.__scopeweaveWriteAttempt = 0;
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({
          async createWritable() {
            window.__scopeweaveWriteAttempt += 1;
            const attempt = window.__scopeweaveWriteAttempt;
            return {
              async write() {
                if (attempt > 1) throw new Error('simulated later write failure');
              },
              async close() {},
            };
          },
        }),
      });
    });
    await page.route('**/wbs.json', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('/');

    await page.getByRole('button', { name: /wbs\.json 자동저장 연결/ }).click();
    await expect(page.locator('#toast')).toContainText('자동저장 연결이 완료되었습니다');
    await page.locator('#project-name').fill('Trigger connected write');
    await page.locator('#project-name').blur();
    await expect(page.locator('#toast')).toContainText('연결된 wbs.json 파일 저장에 실패했습니다');
  });

  test('explains when an enabled picker control loses browser support before activation', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({}) });
    });
    await page.route('**/wbs.json', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('/');
    await page.evaluate(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });
    await page.getByRole('button', { name: /wbs\.json 자동저장 연결/ }).click();
    await expect(page.locator('#toast')).toContainText('이 브라우저는 wbs.json 직접 저장 연결을 지원하지 않습니다');
  });

  test('keeps Gantt safe for out-of-window actual dates and an emptied focus trap', async ({ page }) => {
    await seedPlanner(page, [
      { id: 'early', parentId: null, depth: 1, expanded: true, phase: 'Early actual', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualStartDate: '2026-08-10', actualEndDate: '2026-08-11', actualProgressStatus: '진행(50%)' },
      { id: 'late', parentId: null, depth: 1, expanded: true, phase: 'Late actual', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualStartDate: '2026-08-24', actualEndDate: '2026-08-25', actualProgressStatus: '진행(50%)' },
      { id: 'reversed', parentId: null, depth: 1, expanded: true, phase: 'Reversed actual', plannedStartDate: '2026-08-17', plannedEndDate: '2026-08-21', actualStartDate: '2026-08-20', actualEndDate: '2026-08-18', actualProgressStatus: '진행(50%)' },
    ]);
    await page.goto('/');
    await page.getByRole('button', { name: '간트차트보기' }).click();

    await expect(page.locator('.gantt-bar.plan')).toHaveCount(3);
    await expect(page.locator('.gantt-bar.actual')).toHaveCount(0);
    const dispatchResult = await page.locator('#gantt-modal').evaluate((modal) => {
      modal.querySelectorAll('button').forEach((button) => button.remove());
      modal.querySelectorAll('[tabindex]').forEach((element) => element.setAttribute('tabindex', '-1'));
      modal.setAttribute('tabindex', '-1');
      modal.focus();
      return modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(dispatchResult).toBe(false);
    await expect(page.locator('#gantt-modal')).toBeFocused();
  });

  test('expires planner toasts after their announced interval', async ({ page }) => {
    await seedPlanner(page);
    await page.goto('/');
    const leafAdd = page.locator('tr[data-task-id="leaf-a"] [data-action="add-child"]');
    await leafAdd.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toast')).toHaveClass(/show/);
    await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 3000 });
  });
});
