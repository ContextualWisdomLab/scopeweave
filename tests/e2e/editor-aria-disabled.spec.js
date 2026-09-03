import { test, expect } from '@playwright/test';

test.describe('inline editor disabled-state feedback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('routes an invalid required-field submit through application feedback', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    const phaseInput = page.locator('[data-testid="editor-phase"]');
    const saveButton = page.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    const isDisabled = await saveButton.evaluate(n => n.disabled);
    expect(isDisabled).toBe(false);

    await saveButton.focus();
    await expect(saveButton).toBeFocused();
    await saveButton.press('Enter');

    await expect(page.locator('#toast')).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(phaseInput).toHaveAttribute('aria-invalid', 'true');
  });

  test('blocks invalid save via click and preserves editor', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    const phaseInput = page.locator('[data-testid="editor-phase"]');
    const saveButton = page.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    const isDisabled = await saveButton.evaluate(n => n.disabled);
    expect(isDisabled).toBe(false);

    // Instead of a Playwright synthetic click, use plain evaluate to sidestep test runner validation bugs
    await saveButton.evaluate(n => n.click());

    await expect(page.locator('#toast')).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(phaseInput).toHaveAttribute('aria-invalid', 'true');
  });

  test('saves a corrected draft on the first immediate submit', async ({ page }) => {
    const rows = page.locator('tbody tr[data-task-id]');
    const initialRowCount = await rows.count();

    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    const phaseInput = page.locator('[data-testid="editor-phase"]');
    const saveButton = page.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');

    await phaseInput.fill('Immediate valid phase');
    await saveButton.click();

    await expect(page.locator('.editor-panel')).toHaveCount(0);
    await expect(rows).toHaveCount(initialRowCount + 1);
    await expect(rows.filter({ hasText: 'Immediate valid phase' })).toHaveCount(1);
  });
});
