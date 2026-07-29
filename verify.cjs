const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ recordVideo: { dir: 'videos/' } });
  const page = await context.newPage();
  await page.goto('http://localhost:8787');
  await page.keyboard.press('Tab'); // skip link
  await page.keyboard.press('Tab'); // project name
  await page.keyboard.press('Tab'); // base date
  await page.keyboard.press('Tab'); // overall days card
  await page.screenshot({ path: 'verification.png' });
  await context.close();
  await browser.close();
})();
