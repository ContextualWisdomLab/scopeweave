import { test, expect } from '@playwright/test';

const PROJECT_NAME = `R&D <Plan> & "Review" 'Q3'`;

test('keeps the project name literal in the browser title', async ({ page }) => {
  await page.goto('./');

  await page.getByTestId('project-name-input').fill(PROJECT_NAME);
  await page.getByTestId('project-name-input').blur();

  await expect(page).toHaveTitle(`${PROJECT_NAME} - ScopeWeave Planner`);
});
