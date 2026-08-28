import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 8831;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;

async function api(path, { method = 'GET', body, tok } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server/server.mjs'], {
    env: {
      ...process.env,
      SCOPEWEAVE_DB: ':memory:',
      SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef',
      PORT: String(PORT),
    },
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) break;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  token = (await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'onboarding-safety@cloud.com', password: 'password123' },
  })).token;

  await api('/api/projects', {
    method: 'POST',
    body: { name: '실제 클라우드 프로젝트' },
    tok: token,
  });
  await api('/api/projects/1', {
    method: 'PUT',
    tok: token,
    body: {
      name: '실제 클라우드 프로젝트',
      baseDate: '2026-08-28',
      version: 1,
      tasks: [
        {
          id: 'cloud-task-1',
          depth: 1,
          parentId: null,
          phase: '운영 단계',
          task: '보존되어야 할 실제 작업',
          plannedStartDate: '2026-08-28',
          plannedEndDate: '2026-08-29',
        },
      ],
    },
  });
});

test.afterAll(() => {
  server?.kill();
});

test('opening a real cloud project clears first-visit sample state before destructive sample actions can run', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const onboarding = page.locator('#seed-onboarding');
  await expect(onboarding).toBeVisible();

  // Authenticate without selecting a project. This keeps the first-visit seed
  // visible while the project chooser is populated, reproducing the transition
  // from standalone sample data to a real cloud project.
  await page.evaluate((authToken) => {
    localStorage.setItem('scopeweave:token', authToken);
    localStorage.removeItem('scopeweave:project');
  }, token);
  await page.reload();
  await expect(onboarding).toBeVisible();

  const projectPicker = page.getByRole('combobox', { name: '프로젝트 선택' });
  await expect(projectPicker).toBeVisible();
  await projectPicker.selectOption('1');

  await expect(page.getByTestId('project-name-input')).toHaveValue('실제 클라우드 프로젝트');
  await expect(page.locator('tbody tr[data-task-id]')).toContainText('보존되어야 할 실제 작업');
  await expect(onboarding).toBeHidden();

  // A programmatic click models stale/automation-driven activation even though
  // the button is hidden with the banner. The handler must be inert because
  // real project hydration has revoked the sample-only destructive capability.
  await page.evaluate(() => document.getElementById('clear-seed-data').click());
  await page.waitForTimeout(800);

  await expect(page.locator('tbody tr[data-task-id]')).toContainText('보존되어야 할 실제 작업');
  const project = await api('/api/projects/1', { tok: token });
  expect(project.tasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'cloud-task-1', task: '보존되어야 할 실제 작업' }),
  ]));
});

test('picker-opened cloud projects persist progress changes even without a planner autosave entry', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate((authToken) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', authToken);
  }, token);
  await page.reload();

  const projectPicker = page.getByRole('combobox', { name: '프로젝트 선택' });
  await expect(projectPicker).toBeVisible();
  await projectPicker.selectOption('1');
  await expect(page.getByTestId('project-name-input')).toHaveValue('실제 클라우드 프로젝트');

  expect(await page.evaluate(() => localStorage.getItem('scopeweave:planner-state:v1'))).toBeNull();

  const progress = page.locator('select[data-inline-progress]').first();
  await expect(progress).toBeEnabled();
  await progress.selectOption({ label: '진행(50%)' });

  await expect.poll(async () => {
    const project = await api('/api/projects/1', { tok: token });
    return project.tasks.find((task) => task.id === 'cloud-task-1')?.actualProgressStatus;
  }, { timeout: 4000 }).toBe('진행(50%)');
});
