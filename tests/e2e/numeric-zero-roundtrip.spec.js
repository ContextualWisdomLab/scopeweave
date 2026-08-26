import { test, expect } from '@playwright/test';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

const createTask = (overrides = {}) => ({
  id: 'task-zero-regression',
  parentId: null,
  depth: 1,
  expanded: true,
  pendingDelete: false,
  isSynthetic: false,
  phase: 'P0000.제로값 회귀',
  activity: '',
  task: '',
  categoryLarge: '데이터 무결성',
  categoryMedium: '',
  documentName: '',
  owner: 'QA',
  supportTeam: '',
  plannedStartDate: '2026-08-25',
  plannedEndDate: '2026-08-26',
  actualProgressStatus: '미착수(0%)',
  actualStartDate: '',
  actualEndDate: '',
  predecessors: '',
  budget: '',
  actualCost: '',
  sprint: '',
  storyPoints: '',
  ...overrides,
});

const seedPersistedTask = async (page, overrides) => {
  await page.addInitScript(({ storageKey, task }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      projectName: 'Numeric Zero Integrity',
      baseDate: '2026-08-26',
      tasks: [task],
    }));
  }, { storageKey: STORAGE_KEY, task: createTask(overrides) });
  await page.goto('./');
};

const openEditor = async (page) => {
  const row = page.locator('tbody tr[data-task-id]').first();
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /^편집/ }).click();
};

const saveAndReopen = async (page) => {
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await openEditor(page);
};

for (const { field, testId } of [
  { field: 'budget', testId: 'editor-budget' },
  { field: 'actualCost', testId: 'editor-actual-cost' },
  { field: 'storyPoints', testId: 'editor-story-points' },
]) {
  test(`preserves numeric zero for ${field} through edit/save/reopen`, async ({ page }) => {
    await seedPersistedTask(page, { [field]: 0 });
    await openEditor(page);

    await expect(page.getByTestId(testId)).toHaveValue('0');
    await saveAndReopen(page);
    await expect(page.getByTestId(testId)).toHaveValue('0');

    const persistedValue = await page.evaluate(({ storageKey, fieldName }) => {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return saved.tasks[0][fieldName];
    }, { storageKey: STORAGE_KEY, fieldName: field });
    expect(String(persistedValue)).toBe('0');
  });
}

test('preserves budget, actual cost, and story points when all are numeric zero', async ({ page }) => {
  await seedPersistedTask(page, { budget: 0, actualCost: 0, storyPoints: 0 });
  await openEditor(page);

  await expect(page.getByTestId('editor-budget')).toHaveValue('0');
  await expect(page.getByTestId('editor-actual-cost')).toHaveValue('0');
  await expect(page.getByTestId('editor-story-points')).toHaveValue('0');

  await saveAndReopen(page);

  await expect(page.getByTestId('editor-budget')).toHaveValue('0');
  await expect(page.getByTestId('editor-actual-cost')).toHaveValue('0');
  await expect(page.getByTestId('editor-story-points')).toHaveValue('0');
});
