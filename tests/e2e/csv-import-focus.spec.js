import { test, expect } from '@playwright/test';

test('returns keyboard focus to the CSV import trigger after replacing project data', async ({ page }) => {
  await page.goto('./');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV 내보내기' }).click();
  const exportedCsv = await downloadPromise;
  const exportedPath = await exportedCsv.path();
  expect(exportedPath).toBeTruthy();

  const importButton = page.locator('#import-csv');
  const fileChooserPromise = page.waitForEvent('filechooser');
  await importButton.click();
  const fileChooser = await fileChooserPromise;

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('현재 등록된 모든 작업 데이터가 지워집니다');
    await dialog.accept();
  });
  await fileChooser.setFiles(exportedPath);

  await expect(page.locator('#toast')).toContainText('CSV를 가져왔습니다.');
  await expect(importButton).toBeFocused();
});
