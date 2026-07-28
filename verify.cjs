const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ recordVideo: { dir: 'videos/' } });
  const page = await context.newPage();
  await page.goto('http://localhost:4173');
  await page.waitForLoadState('networkidle');

  // Tab to a meta-value-card
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');

  // Click Add Root Task to open editor
  await page.click('#add-root-task');

  // Wait for save button and force focus on it
  await page.waitForSelector('button[type="submit"]');
  await page.focus('button[type="submit"]');

  // Screenshot the focused button
  await page.screenshot({ path: 'verification.png', fullPage: true });
  await browser.close();
})();
