import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 8836;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;

async function api(path, { method = 'GET', body, tok } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
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
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  token = (await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'modal-perf@scopeweave.test', password: 'password123' },
  })).token;
  const project = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Modal performance' },
    tok: token,
  });
  const tasks = Array.from({ length: 2_000 }, (_, index) => ({
    id: `task-${index}`,
    name: `Task ${index}`,
    plannedProgress: 0,
    actualProgress: 0,
  }));
  await api(`/api/projects/${project.id}`, {
    method: 'PUT',
    body: { name: project.name, tasks, baseDate: '2026-08-21', version: project.version },
    tok: token,
  });
  await Promise.all(Array.from({ length: 40 }, (_, index) => api(`/api/projects/${project.id}/comments`, {
    method: 'POST',
    body: { taskId: `task-${index * 41}`, body: `Comment ${index}` },
    tok: token,
  })));
});

test.afterAll(() => {
  server?.kill();
});

test('comments modal does not linearly scan the full task list per rendered comment', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFind = Array.prototype.find;
    globalThis.__scopeweaveLargeArrayFindCalls = 0;
    Array.prototype.find = function instrumentedFind(...args) {
      if (this.length >= 1_000) globalThis.__scopeweaveLargeArrayFindCalls += 1;
      return originalFind.apply(this, args);
    };
  });

  await page.goto(`${BASE}/`);
  await page.evaluate(([authToken]) => {
    localStorage.setItem('scopeweave:token', authToken);
    localStorage.setItem('scopeweave:project', '1');
  }, [token]);
  await page.reload();
  await page.waitForSelector('#cloud-auth select');

  await page.evaluate(() => {
    globalThis.__scopeweaveLargeArrayFindCalls = 0;
  });
  await page.click('#cloud-auth button:has-text("코멘트")');
  await expect(page.locator('#comments-panel .team-list li')).toHaveCount(40);

  const largeArrayFindCalls = await page.evaluate(() => globalThis.__scopeweaveLargeArrayFindCalls);
  expect(largeArrayFindCalls).toBe(0);
  await expect(page.locator('#comments-panel .team-list')).toContainText('Task 0');
  await expect(page.locator('#comments-panel .team-list')).toContainText('Comment 39');
});
