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

const seedExternalTask = async (page, overrides) => {
  await page.route('**/wbs.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([createTask(overrides)]),
    });
  });
  await page.goto('./');
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(1);
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

const readDownloadText = async (download) => {
  const stream = await download.createReadStream();
  let content = '';
  for await (const chunk of stream) {
    content += chunk.toString('utf8');
  }
  return content;
};

const parseFirstCsvDataRow = (csvText) => {
  const [, dataRow] = csvText.trimEnd().split(/\r?\n/);
  return dataRow.split(',').map((cell) => cell.slice(1, -1).replace(/""/g, '"'));
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

test('keeps unrelated falsy fields empty while preserving numeric zero', async ({ page }) => {
  await seedPersistedTask(page, { owner: false, budget: 0 });
  await openEditor(page);

  await expect(page.getByTestId('editor-owner')).toHaveValue('');
  await expect(page.getByTestId('editor-budget')).toHaveValue('0');

  await saveAndReopen(page);
  await expect(page.getByTestId('editor-owner')).toHaveValue('');
  await expect(page.getByTestId('editor-budget')).toHaveValue('0');

  const persisted = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)).tasks[0], STORAGE_KEY);
  expect(persisted.owner).toBe('');
  expect(String(persisted.budget)).toBe('0');
});

test('keeps numeric zero empty for unrelated text fields', async ({ page }) => {
  await seedPersistedTask(page, { owner: 0, budget: 0 });
  await openEditor(page);

  await expect(page.getByTestId('editor-owner')).toHaveValue('');
  await expect(page.getByTestId('editor-budget')).toHaveValue('0');

  await saveAndReopen(page);
  await expect(page.getByTestId('editor-owner')).toHaveValue('');
  await expect(page.getByTestId('editor-budget')).toHaveValue('0');

  const persisted = await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)).tasks[0], STORAGE_KEY);
  expect(persisted.owner).toBe('');
  expect(String(persisted.budget)).toBe('0');
});

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

test('preserves numeric zero while normalizing an external wbs.json record', async ({ page }) => {
  await seedExternalTask(page, { budget: 0, actualCost: 0, storyPoints: 0 });
  await openEditor(page);

  await expect(page.getByTestId('editor-budget')).toHaveValue('0');
  await expect(page.getByTestId('editor-actual-cost')).toHaveValue('0');
  await expect(page.getByTestId('editor-story-points')).toHaveValue('0');
});

test('preserves numeric zero fields in wbs.json sync output', async ({ page }) => {
  await page.addInitScript(() => {
    window.__savedWbsJson = null;
    window.showSaveFilePicker = async () => ({
      async createWritable() {
        return {
          async write(content) {
            window.__savedWbsJson = content;
          },
          async close() {},
        };
      },
    });
  });
  await seedPersistedTask(page, { budget: 0, actualCost: 0, storyPoints: 0 });

  await page.getByRole('button', { name: 'wbs.json 자동저장 연결' }).click();
  await expect.poll(async () => page.evaluate(() => window.__savedWbsJson)).not.toBeNull();
  const savedPayload = await page.evaluate(() => JSON.parse(window.__savedWbsJson));

  expect(savedPayload[0]).toMatchObject({ budget: 0, actualCost: 0, storyPoints: 0 });
});

test('exports numeric zero values instead of empty CSV cells', async ({ page }) => {
  await seedPersistedTask(page, { budget: 0, actualCost: 0, storyPoints: 0 });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const cells = parseFirstCsvDataRow(await readDownloadText(await downloadPromise));

  expect(cells.slice(-4)).toEqual(['0', '0', '', '0']);
});

test('does not serialize boolean false from persisted numeric fields into CSV', async ({ page }) => {
  await seedPersistedTask(page, { budget: false, actualCost: false, storyPoints: false });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const cells = parseFirstCsvDataRow(await readDownloadText(await downloadPromise));

  expect(cells.slice(-4)).toEqual(['', '', '', '']);
});

test('does not preserve boolean false from external numeric fields', async ({ page }) => {
  await seedExternalTask(page, { budget: false, actualCost: false, storyPoints: false });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const cells = parseFirstCsvDataRow(await readDownloadText(await downloadPromise));

  expect(cells.slice(-4)).toEqual(['', '', '', '']);
});