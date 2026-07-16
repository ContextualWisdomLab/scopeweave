const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ recordVideo: { dir: 'videos/' } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173');
  await page.waitForSelector('#project-name');
  await page.fill('#project-name', '새로운 프로젝트');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshot.png' });
  await context.close();
  await browser.close();
})();
