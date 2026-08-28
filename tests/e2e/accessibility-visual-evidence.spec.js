import { test, expect } from '@playwright/test';

test('standalone mobile seed view keeps WCAG-sized named controls and visual evidence', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('./');
  await expect(page.locator('tbody tr[data-task-id]').first()).toBeVisible();

  const audit = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const getName = (element) => (
      element.getAttribute('aria-label')
      || element.labels?.[0]?.textContent?.trim()
      || element.textContent?.trim()
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || ''
    );
    const controls = [...document.querySelectorAll('button, a, input, select, textarea')]
      .filter(isVisible)
      .filter((element) => !element.matches('.skip-link'));
    const unnamed = controls.filter((element) => !getName(element));
    const undersized = controls.filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.width < 24 || box.height < 24);
    });
    const login = document.querySelector('#cloud-auth button');
    const loginBox = login?.getBoundingClientRect();
    const cloudAuth = document.querySelector('#cloud-auth');
    return {
      unnamed: unnamed.map((element) => element.outerHTML.slice(0, 180)),
      undersized: undersized.map((element) => ({
        name: getName(element),
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
      })),
      selectHeights: [...document.querySelectorAll('select')].map((element) => element.getBoundingClientRect().height),
      login: login && {
        width: loginBox.width,
        height: loginBox.height,
        whiteSpace: getComputedStyle(login).whiteSpace,
        fits: login.scrollWidth <= login.clientWidth && login.scrollHeight <= login.clientHeight,
      },
      cloudAuthJustifyContent: cloudAuth && getComputedStyle(cloudAuth).justifyContent,
      landmarks: ['header', 'main#main-content', 'footer'].every((selector) => document.querySelector(selector)),
      skipTarget: document.querySelector('.skip-link')?.getAttribute('href'),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(audit.unnamed).toEqual([]);
  expect(audit.undersized).toEqual([]);
  expect(audit.selectHeights.every((height) => height >= 24)).toBe(true);
  expect(audit.login).not.toBeNull();
  expect(audit.login.width).toBeGreaterThanOrEqual(120);
  expect(audit.login.height).toBeGreaterThanOrEqual(44);
  expect(audit.login.whiteSpace).toBe('nowrap');
  expect(audit.login.fits).toBe(true);
  expect(audit.cloudAuthJustifyContent).toBe('flex-start');
  expect(audit.landmarks).toBe(true);
  expect(audit.skipTarget).toBe('#main-content');
  expect(audit.horizontalOverflow).toBeLessThanOrEqual(1);

  await testInfo.attach('g04-mobile-seed', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.evaluate(() => {
    localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
      projectName: 'Empty Scope',
      baseDate: '2026-04-20',
      tasks: [],
    }));
  });
  await page.reload();
  await expect(page.locator('.table-empty')).toBeVisible();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
  await testInfo.attach('g04-mobile-empty', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
