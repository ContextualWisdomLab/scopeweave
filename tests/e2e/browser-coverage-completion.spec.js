import { spawn } from 'node:child_process';
import { test, expect } from './coverage-test.js';

const PORT = 8834;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let ownerToken;
let ownerOrgId;
let projectId;

async function api(path, { method = 'GET', body, tok = ownerToken } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('ScopeWeave coverage-completion server did not become ready');
}

async function loginAndOpen(page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(({ authToken, project }) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', authToken);
    localStorage.setItem('scopeweave:project', String(project));
  }, { authToken: ownerToken, project: projectId });
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
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
    body: {
      email: 'coverage-completion@scopeweave.test',
      password: 'password123',
      name: 'Coverage Completion Owner',
    },
  });
  if (!signup.ok) throw new Error(`coverage-completion signup failed (${signup.status})`);
  ownerToken = signup.data.token;

  const me = await api('/api/me');
  ownerOrgId = me.data.orgs[0].id;
  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Coverage Completion Project', orgId: ownerOrgId },
  });
  if (!created.ok) throw new Error(`coverage-completion project creation failed (${created.status})`);
  projectId = created.data.id;
});

test.afterAll(() => { server?.kill(); });

test('a clean page leaves beforeunload non-blocking before any editor session', async ({ page }) => {
  await page.goto('/');

  const unload = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    const dispatched = window.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });

  expect(unload).toEqual({ dispatched: true, defaultPrevented: false });
});

test('the first root task persists when randomUUID is unavailable but secure random values exist', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
      projectName: 'First Root Coverage',
      baseDate: '2026-08-21',
      tasks: [],
    }));
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');

  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');

  await page.locator('#add-root-task').click();
  await page.getByTestId('editor-phase').fill('Secure fallback root');
  await page.getByTestId('editor-category-large').fill('Coverage');
  await page.getByTestId('editor-owner').fill('Coverage Owner');
  await page.getByTestId('editor-planned-start').fill('2026-08-21');
  await page.getByTestId('editor-planned-end').fill('2026-08-22');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const row = page.locator('tbody tr[data-task-id]').filter({ hasText: 'Secure fallback root' });
  await expect(row).toHaveCount(1);
  const generatedId = await row.getAttribute('data-task-id');
  expect(generatedId).toMatch(/^task-[0-9a-f]+-[0-9a-f]+$/);
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('scopeweave:planner-state:v1') || '{}');
    return stored.tasks?.[0]?.id || null;
  })).toBe(generatedId);
});

test('a free-plan upgrade follows the live checkout redirect returned by the provider boundary', async ({ page }) => {
  await loginAndOpen(page);
  const checkoutTarget = `${BASE}/checkout-redirect-target`;

  await page.route('**/api/orgs/*/checkout', async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mock: false, url: checkoutTarget }),
    });
  });
  await page.route(checkoutTarget, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Checkout redirect target</title></head><body>redirected</body></html>',
  }));

  await page.getByRole('button', { name: '팀', exact: true }).click();
  const upgrade = page.locator('#team-body .billing-upgrade');
  await expect(upgrade).toBeVisible();

  await Promise.all([
    page.waitForURL(checkoutTarget),
    upgrade.click(),
  ]);
  await expect(page).toHaveTitle('Checkout redirect target');
});

test('a demo billing checkout explains the missing provider key without navigating away', async ({ page }) => {
  await loginAndOpen(page);
  const plannerUrl = page.url();
  let checkoutRequests = 0;

  await page.route('**/api/orgs/*/checkout', async (route) => {
    checkoutRequests += 1;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mock: true, url: null }),
    });
  });

  await page.getByRole('button', { name: '팀', exact: true }).click();
  const upgrade = page.locator('#team-body .billing-upgrade');
  await expect(upgrade).toBeVisible();
  await upgrade.click();

  await expect(page.locator('#toast')).toContainText('결제 연동(Stripe 키)이 필요합니다 — 데모 환경입니다.');
  expect(checkoutRequests).toBe(1);
  await expect(page).toHaveURL(plannerUrl);
});
