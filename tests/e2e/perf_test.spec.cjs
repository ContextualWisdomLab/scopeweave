const { test, expect } = require('@playwright/test');

test('Measure Gantt modal rendering time', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.waitForLoadState('networkidle');

  // Load a large dataset to stress the Gantt rendering via file import to bypass window.state encapsulation

  const csvText = [
    ['단계','Activity','Task','대분류','중분류','산출물','담당자','지원팀','실적진척상태','계획시작일','계획종료일','실적시작일','실적종료일','__id','__parentId','__depth'].join(',')
  ];
  const baseDate = new Date('2024-01-01');
  for (let i = 0; i < 500; i++) {
    const startDate = new Date(baseDate);
    startDate.setDate(startDate.getDate() + (i % 30));
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 5);

    csvText.push([
      `Phase ${Math.floor(i / 100)}`,
      `Activity ${Math.floor(i / 10)}`,
      `Task ${i}`,
      '', '', '', '', '', '미착수(0%)',
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0],
      '', '',
      `task-${i}`, '', '3'
    ].join(','));
  }

  const fs = require('fs');
  fs.writeFileSync('perf_test.csv', csvText.join('\n'));

  // Trigger import
  await page.evaluate(() => {
    window.confirm = () => true; // auto accept confirm dialog
  });
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.click('#import-csv');
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles('perf_test.csv');

  // wait for it to render
  await page.waitForFunction(() => document.querySelectorAll('#task-table-body tr').length > 400);

  // Click the open Gantt button and measure time
  const startTime = Date.now();
  await page.click('#open-gantt');
  await page.waitForSelector('.gantt-chart', { state: 'visible' });
  const endTime = Date.now();

  console.log(`Gantt rendering time for 500 tasks: ${endTime - startTime}ms`);
});
