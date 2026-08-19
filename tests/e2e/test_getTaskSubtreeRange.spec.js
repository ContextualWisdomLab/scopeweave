import { test, expect } from './coverage-test.js';

const seededHierarchy = [
  { id: '1', parentId: null, depth: 1, expanded: true, phase: 'Root A' },
  { id: '2', parentId: '1', depth: 2, expanded: true, activity: 'Activity A' },
  { id: '3', parentId: '2', depth: 3, expanded: true, task: 'Leaf A' },
  { id: '7', parentId: '2', depth: 3, expanded: true, task: 'Leaf B' },
  { id: '4', parentId: '1', depth: 2, expanded: true, activity: 'Activity B' },
  { id: '5', parentId: null, depth: 1, expanded: true, phase: 'Root B' },
  { id: '6', parentId: '5', depth: 2, expanded: true, activity: 'Activity C' },
];

async function seedPlanner(page, { captureCloudHost = false } = {}) {
  await page.addInitScript(({ tasks, captureCloudHost: captureHost }) => {
    localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
      projectName: 'Subtree range regression',
      baseDate: '2026-08-19',
      tasks,
    }));

    if (!captureHost) return;
    let cloudApi;
    Object.defineProperty(window, 'ScopeWeaveCloud', {
      configurable: true,
      get() {
        return cloudApi;
      },
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
  }, { tasks: seededHierarchy, captureCloudHost });
}

async function dragTaskAfter(page, draggedId, targetId) {
  await page.evaluate(({ draggedId: sourceId, targetId: destinationId }) => {
    const source = document.querySelector(`tr[data-task-id="${sourceId}"]`);
    const target = document.querySelector(`tr[data-task-id="${destinationId}"]`);
    if (!source || !target) throw new Error('expected drag source and target rows');

    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    const targetRect = target.getBoundingClientRect();
    const clientY = targetRect.bottom - 1;
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY,
    }));
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY,
    }));
    source.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { draggedId, targetId });
}

function persistedTaskIds(page) {
  return expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('scopeweave:planner-state:v1');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.tasks) ? parsed.tasks.map((task) => task.id) : [];
  }));
}

test.describe('task subtree range behavior', () => {
  test('moves a root together with every descendant', async ({ page }) => {
    await seedPlanner(page);
    await page.goto('/');

    await dragTaskAfter(page, '1', '5');

    await persistedTaskIds(page).toEqual(['5', '6', '1', '2', '3', '7', '4']);
  });

  test('moves a middle-level task together with its nested leaves', async ({ page }) => {
    await seedPlanner(page);
    await page.goto('/');

    await dragTaskAfter(page, '2', '4');

    await persistedTaskIds(page).toEqual(['1', '4', '2', '3', '7', '5', '6']);
  });

  test('moves a leaf without consuming its sibling', async ({ page }) => {
    await seedPlanner(page);
    await page.goto('/');

    await dragTaskAfter(page, '3', '7');

    await persistedTaskIds(page).toEqual(['1', '2', '7', '3', '4', '5', '6']);
  });

  test('fails closed when cloud hydration removes a dragged subtree before drop', async ({ page }) => {
    await seedPlanner(page, { captureCloudHost: true });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__scopeweavePlannerHost));

    await page.evaluate(() => {
      const source = document.querySelector('tr[data-task-id="2"]');
      const target = document.querySelector('tr[data-task-id="4"]');
      if (!source || !target) throw new Error('expected stale-drag source and target rows');

      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));

      window.__scopeweavePlannerHost.hydrateState({
        projectName: 'Concurrent cloud replacement',
        baseDate: '2026-08-19',
        tasks: [{ id: '5', parentId: null, depth: 1, expanded: true, phase: 'Replacement root' }],
      });

      const targetRect = target.getBoundingClientRect();
      const clientY = targetRect.bottom - 1;
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientY,
      }));
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientY,
      }));
      source.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    });

    await persistedTaskIds(page).toEqual(['5']);
  });
});
