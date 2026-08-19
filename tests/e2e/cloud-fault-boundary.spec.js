// Buyer-visible SaaS failure handling on an isolated in-memory API server.
import { test, expect } from './coverage-test.js';
import { spawn } from 'node:child_process';

const PORT = 8833;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let ownerToken;
let ownerOrgId;
let projectId;

async function api(path, { method = 'GET', body, tok = ownerToken } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('ScopeWeave cloud fault-boundary server did not become ready');
}

async function loginAndOpen(page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(({ token, id }) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', token);
    localStorage.setItem('scopeweave:project', String(id));
  }, { token: ownerToken, id: projectId });
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
  await page.waitForSelector('#task-table-body tr[data-task-id]');
}

async function replaceProject(patch = {}) {
  const current = await api(`/api/projects/${projectId}`);
  if (!current.ok) throw new Error(`project read failed (${current.status})`);
  const updated = await api(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: {
      name: current.data.name,
      baseDate: current.data.baseDate,
      tasks: current.data.tasks,
      version: current.data.version,
      ...patch,
    },
  });
  if (!updated.ok) throw new Error(`project update failed (${updated.status})`);
  return updated.data;
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
  await waitForServer();

  const signup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'fault-owner@scopeweave.test', password: 'password123', name: 'Fault Owner' },
  });
  if (!signup.ok) throw new Error(`owner signup failed (${signup.status})`);
  ownerToken = signup.data.token;

  const me = await api('/api/me');
  ownerOrgId = me.data.orgs[0].id;
  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Fault Boundary Project', orgId: ownerOrgId },
  });
  if (!created.ok) throw new Error(`project create failed (${created.status})`);
  projectId = created.data.id;
  await replaceProject({
    baseDate: '2026-08-19',
    tasks: [{
      id: 'fault-task',
      parentId: null,
      depth: 1,
      expanded: true,
      phase: 'Fault Phase',
      task: 'Fault deliverable',
      owner: 'Fault Owner',
      plannedStartDate: '2026-08-18',
      plannedEndDate: '2026-08-20',
      actualProgressStatus: '진행중(50%)',
    }],
  });
});

test.afterAll(() => { server?.kill(); });

test('expired share links fail closed and fall back to the signed-out planner', async ({ page }) => {
  await page.goto(`${BASE}/?share=missingShareToken1`);
  await expect(page.locator('#toast')).toContainText('공유 링크가 만료되었거나 철회되었습니다');
  await expect(page.locator('#cloud-auth button')).toContainText('클라우드 로그인');
});

test('stale credentials are cleared instead of leaving a misleading authenticated shell', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate((id) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', 'stale-credential-value');
    localStorage.setItem('scopeweave:project', String(id));
  }, projectId);
  await page.reload();

  await expect(page.locator('#cloud-auth button')).toContainText('클라우드 로그인');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('scopeweave:token'))).toBeNull();
  await expect(page.evaluate(() => localStorage.getItem('scopeweave:project'))).resolves.toBeNull();
});

test('project-list and notification outages keep authenticated onboarding usable', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate((token) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', token);
  }, ownerToken);
  await page.route(`${BASE}/api/projects`, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'projects unavailable' }),
  }));
  await page.route(`${BASE}/api/notifications`, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'notifications unavailable' }),
  }));
  await page.reload();

  await expect(page.getByRole('button', { name: '✨ 샘플로 시작' })).toBeVisible();
  await expect(page.locator('#cloud-auth select')).toContainText('프로젝트 없음');
});

test('optimistic-concurrency conflict reloads the server winner instead of overwriting it', async ({ page }) => {
  await loginAndOpen(page);
  await replaceProject({ name: 'Server Winner' });

  await page.locator('#project-name').fill('Stale Client Edit');
  await expect(page.locator('#toast')).toContainText('다른 사용자가 먼저 저장하여 최신본을 불러왔습니다', { timeout: 5000 });
  await expect(page.locator('#project-name')).toHaveValue('Server Winner');
});

test('cloud write failure preserves the local edit and tells the buyer what happened', async ({ page }) => {
  await loginAndOpen(page);
  await page.route(`${BASE}/api/projects/${projectId}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forced cloud write failure' }),
      });
      return;
    }
    await route.continue();
  });

  await page.locator('#project-name').fill('Locally Preserved Edit');
  await expect(page.locator('#toast')).toContainText('클라우드 저장 실패 — 로컬에는 저장되었습니다', { timeout: 5000 });
  await expect(page.locator('#project-name')).toHaveValue('Locally Preserved Edit');
});

test('duplicate cancellation and logout are safe no-op and session-teardown paths', async ({ page }) => {
  await loginAndOpen(page);
  const before = await api('/api/projects');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '복제', exact: true }).click();
  const after = await api('/api/projects');
  expect(after.data.projects.length).toBe(before.data.projects.length);

  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.locator('#cloud-auth button')).toContainText('클라우드 로그인');
  expect(await page.evaluate(() => ({
    token: localStorage.getItem('scopeweave:token'),
    project: localStorage.getItem('scopeweave:project'),
  }))).toEqual({ token: null, project: null });
});

test('share UI falls back when clipboard access is unavailable and can revoke the link', async ({ page }) => {
  await loginAndOpen(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied'); } },
    });
  });

  await page.getByRole('button', { name: '공유', exact: true }).click();
  const panel = page.locator('#share-panel');
  await expect(panel).toContainText('활성 공유 링크가 없습니다');

  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '공유 링크 만들기' }).click();
  await expect(panel.getByRole('button', { name: '철회', exact: true })).toHaveCount(1);

  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '복사', exact: true }).click();
  await panel.getByRole('button', { name: '철회', exact: true }).click();
  await expect(panel).toContainText('활성 공유 링크가 없습니다');
});

test('weekly report exposes clipboard and AI failures while restoring the action state', async ({ page }) => {
  await loginAndOpen(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied'); } },
    });
  });
  await page.route(`${BASE}/api/projects/${projectId}/ai/brief`, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'forced AI failure' }),
  }));

  await page.getByRole('button', { name: '주간보고', exact: true }).click();
  const panel = page.locator('#report-panel');
  await panel.getByRole('button', { name: '마크다운 복사' }).click();
  await expect(page.locator('#toast')).toContainText('복사에 실패했습니다');

  const ai = panel.getByRole('button', { name: 'AI 요약' });
  await ai.click();
  await expect(page.locator('#toast')).toContainText('forced AI failure');
  await expect(ai).toBeEnabled();
  await expect(ai).toHaveText('AI 요약');
  await panel.getByRole('button', { name: '주간보고 닫기' }).click();
  await expect(panel).toBeHidden();
});

test('MS Project import rejects empty XML and honors replacement cancellation', async ({ page }) => {
  await loginAndOpen(page);
  await page.getByRole('button', { name: 'MSP 가져오기', exact: true }).click();
  await page.setInputFiles('#msp-file-input', {
    name: 'empty.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from('<?xml version="1.0"?><Project><Tasks /></Project>', 'utf8'),
  });
  await expect(page.locator('#toast')).toContainText('가져올 작업이 없습니다');

  const valid = '<?xml version="1.0"?><Project><Tasks>' +
    '<Task><UID>1</UID><Name>Cancelled replacement</Name><OutlineLevel>1</OutlineLevel>' +
    '<Start>2026-08-20T08:00:00</Start><Finish>2026-08-21T17:00:00</Finish></Task>' +
    '</Tasks></Project>';
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.setInputFiles('#msp-file-input', {
    name: 'cancelled.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(valid, 'utf8'),
  });
  await expect(page.locator('tr[data-task-id="fault-task"]')).toBeVisible();
  await expect(page.getByText('Cancelled replacement', { exact: true })).toHaveCount(0);
});

test('dashboard guard explains missing workspace context for a first-time account', async ({ page }) => {
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'fresh-dashboard@scopeweave.test', password: 'password123', name: 'Fresh User' },
  });
  expect(signup.ok).toBe(true);
  await page.goto(`${BASE}/`);
  await page.evaluate((token) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', token);
  }, signup.data.token);
  await page.reload();
  await page.waitForSelector('#cloud-auth button:has-text("대시보드")');

  await page.getByRole('button', { name: '대시보드', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('워크스페이스를 먼저 선택하세요');
});
