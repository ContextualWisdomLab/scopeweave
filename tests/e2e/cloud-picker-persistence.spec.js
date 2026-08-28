import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 8842;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;
let projectId;

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
    body: { email: 'picker-persistence@cloud.com', password: 'password123' },
  })).token;

  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Picker persistence project' },
    tok: token,
  });
  projectId = created.id;

  await api(`/api/projects/${projectId}`, {
    method: 'PUT',
    tok: token,
    body: {
      name: 'Picker persistence project',
      baseDate: '2026-08-29',
      version: created.version,
      tasks: [
        {
          id: 'cloud-picker-task-1',
          depth: 1,
          parentId: null,
          phase: 'Delivery',
          task: 'Persist progress after picker open',
          actualProgressStatus: '미착수(0%)',
          plannedStartDate: '2026-08-29',
          plannedEndDate: '2026-08-30',
        },
      ],
    },
  });
});

test.afterAll(() => {
  server?.kill();
});

test('picker-opened cloud projects persist inline progress changes without a pre-existing local plan', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.evaluate((authToken) => {
    localStorage.setItem('scopeweave:token', authToken);
    localStorage.removeItem('scopeweave:project');
    localStorage.removeItem('scopeweave:planner-state:v1');
  }, token);
  await page.reload();

  const projectPicker = page.getByRole('combobox', { name: '프로젝트 선택' });
  await expect(projectPicker).toBeVisible();
  await expect(projectPicker.locator(`option[value="${projectId}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('scopeweave:planner-state:v1'))).toBeNull();

  await projectPicker.selectOption(String(projectId));

  const taskRow = page.locator('tbody tr[data-task-id="cloud-picker-task-1"]');
  await expect(taskRow).toContainText('Persist progress after picker open');
  const progress = taskRow.locator('select[data-inline-progress]');
  await expect(progress).toHaveValue('미착수(0%)');

  await progress.selectOption('진행(50%)');

  await expect.poll(async () => {
    const project = await api(`/api/projects/${projectId}`, { tok: token });
    return project.tasks.find((task) => task.id === 'cloud-picker-task-1')?.actualProgressStatus;
  }, { timeout: 5_000 }).toBe('진행(50%)');
});
