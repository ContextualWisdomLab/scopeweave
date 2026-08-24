import { test, expect } from '@playwright/test';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

test.describe('Focus Restoration after Editor Close', () => {
  test('restores focus to add root task button when closing root creator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#add-root-task');

    // Set initial focus to the button
    const addBtn = page.locator('#add-root-task');
    await addBtn.focus();
    await addBtn.click();

    // Wait for editor to appear
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    // Click cancel
    await page.locator('button[data-action="cancel-editor"]').click();

    // Wait for editor to disappear
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    // Wait for retryable focus restoration
    await expect(addBtn).toBeFocused();
  });

  test('restores focus to empty-state add root task button when cancelling root creator', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((storageKey) => {
      // Persist an explicit empty planner so bootstrap does not fall back to the
      // non-empty wbs.json seed fixture. This keeps the regression on the real
      // production empty-state render path.
      localStorage.setItem(storageKey, JSON.stringify({
        projectName: 'ScopeWeave Planner',
        baseDate: '2026-08-24',
        tasks: []
      }));
    }, STORAGE_KEY);
    await page.reload();

    const emptyAddBtn = page.locator('#empty-state-add-root-task');
    await expect(emptyAddBtn).toBeVisible();
    await emptyAddBtn.focus();
    await emptyAddBtn.click();
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();
    await expect(emptyAddBtn).toBeFocused();
  });

  test('restores focus to add root task button after saving root creator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#add-root-task');

    const addBtn = page.locator('#add-root-task');
    await addBtn.focus();
    await addBtn.click();
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    await page.fill('input[data-editor-field="phase"]', 'Saved phase');
    await page.click('button[type="submit"]');

    // saveEditor() closes the editor and then performs a second full render.
    // Assert against the live page after both renders so a stale detached invoker
    // cannot satisfy the focus-restoration contract.
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();
    await expect(addBtn).toBeFocused();
  });

  test('restores focus to edit button when closing task editor', async ({ page }) => {
    await page.goto('/');

    // Add a root task first
    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'My Phase');
    await page.click('button[type="submit"]');

    // Locate the edit button for the newly created task (first row)
    const firstRow = page.locator('tr.task-row').first();
    const editBtn = firstRow.locator('button[data-action="edit"]');

    await editBtn.focus();
    await editBtn.click();

    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    // Cancel editing
    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    // Wait for retryable focus restoration on the edit button
    await expect(editBtn).toBeFocused();
  });

  test('keeps editor focus restoration independent from a nested Gantt visit', async ({ page }) => {
    await page.goto('/');

    // Create a persisted task so the row Edit control is a stable restoration target.
    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'Nested modal focus');
    await page.click('button[type="submit"]');

    const firstRow = page.locator('tr.task-row').first();
    const editBtn = firstRow.locator('button[data-action="edit"]');
    await editBtn.focus();
    await editBtn.click();
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    // Visiting and closing the Gantt modal must not overwrite the inline editor's
    // independent point-of-regard descriptor.
    await page.click('#open-gantt');
    await expect(page.locator('#gantt-modal')).toBeVisible();
    await page.click('#close-gantt');
    await expect(page.locator('#gantt-modal')).not.toBeVisible();

    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();
    await expect(editBtn).toBeFocused();
  });

  test('falls back to a stable id when a row action is not allowlisted', async ({ page }) => {
    await page.goto('/');

    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'Future action fallback');
    await page.click('button[type="submit"]');

    const row = page.locator('tr.task-row').first();
    const inlineProgress = row.locator('select[data-inline-progress]');
    const stableId = await inlineProgress.getAttribute('id');
    expect(stableId).toBeTruthy();

    await row.evaluate((taskRow) => {
      const control = taskRow.querySelector('select[data-inline-progress]');
      if (!control) throw new Error('expected inline progress control');
      control.dataset.action = 'future-action';
      control.focus();

      // Programmatic click on a non-focusable data cell preserves activeElement
      // while exercising the production row-to-editor path. The full rerender
      // recreates the inline control with the same stable id but without the
      // synthetic action marker.
      const cell = taskRow.querySelector('td:not(:first-child)');
      if (!cell) throw new Error('expected data cell');
      cell.click();
    });

    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();
    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    await expect(page.locator(`#${stableId}`)).toBeFocused();
  });

  test('restores focus when a persisted task id contains CSS selector syntax', async ({ page }) => {
    await page.goto('/');

    // Persist a real task first so this exercises the production storage/load path.
    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'Selector-safe focus');
    await page.click('button[type="submit"]');

    const selectorHostileId = 'task"] [data-action="delete';
    await page.evaluate(({ storageKey, taskId }) => {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved?.tasks?.length) throw new Error('expected persisted task state');
      saved.tasks[0].id = taskId;
      localStorage.setItem(storageKey, JSON.stringify(saved));
    }, { storageKey: STORAGE_KEY, taskId: selectorHostileId });
    await page.reload();

    const firstRow = page.locator('tr.task-row').first();
    const editBtn = firstRow.locator('button[data-action="edit"]');
    await editBtn.focus();
    await editBtn.click();
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();
    await expect(editBtn).toBeFocused();
  });
});