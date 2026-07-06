// Cloud (SaaS) UI e2e — self-contained: spawns the Node API server itself, so
// the static python webServer from playwright.config is untouched.
// Run: npx playwright test tests/e2e/cloud.spec.js
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');

const PORT = 8830;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;

async function api(path, { method = 'GET', body, tok } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, SCOPEWEAVE_DB: ':memory:', PORT: String(PORT) },
    stdio: 'ignore',
  });
  // wait for the API to come up
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // seed: user + project with owners/dates (workload + baseline material)
  token = (await api('/api/auth/signup', { method: 'POST', body: { email: 'e2e@cloud.com', password: 'password123' } })).token;
  await api('/api/projects', { method: 'POST', body: { name: 'E2E 프로젝트' }, tok: token });
  await api('/api/projects/1', {
    method: 'PUT',
    tok: token,
    body: {
      tasks: [
        { id: 't1', name: '설계', owner: '김담당', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-10', plannedProgress: 80, actualProgress: 40 },
        { id: 't2', name: '개발', owner: '이담당', plannedStartDate: '2026-01-11', plannedEndDate: '2026-02-10', plannedProgress: 50, actualProgress: 50 },
      ],
      baseDate: '2026-01-05',
      version: 1,
    },
  });
});

test.afterAll(() => { server?.kill(); });

async function loginAndOpen(page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(([t]) => {
    localStorage.setItem('scopeweave:token', t);
    localStorage.setItem('scopeweave:project', '1');
  }, [token]);
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
}

test('cloud bar renders the full toolset when logged in', async ({ page }) => {
  await loginAndOpen(page);
  const labels = await page.$$eval('#cloud-auth button', (bs) => bs.map((b) => b.textContent));
  for (const expected of ['+ 새 프로젝트', '팀', '기준선', '복제', '검색', '코멘트', '로그아웃']) {
    expect(labels).toContain(expected);
  }
});

test('workload table aggregates per owner with behind highlight', async ({ page }) => {
  await loginAndOpen(page);
  await page.waitForSelector('.workload-table tbody tr');
  const rows = await page.$$eval('.workload-table tbody tr', (trs) => trs.map((tr) => tr.textContent));
  expect(rows.some((r) => r.includes('김담당') && r.includes('1건'))).toBeTruthy(); // 80% plan / 40% actual → behind
  expect(rows.some((r) => r.includes('이담당'))).toBeTruthy();
});

test('baseline: save then compare reports no diff', async ({ page }) => {
  await loginAndOpen(page);
  page.on('dialog', (d) => d.accept('착수 기준선'));
  await page.click('#cloud-auth button:has-text("기준선")');
  await page.click('#baseline-panel button:has-text("기준선으로 저장")');
  await page.waitForSelector('#baseline-panel .team-list li');
  await page.click('#baseline-panel button:has-text("비교")');
  await expect(page.locator('#baseline-result')).toContainText('기준선과 차이가 없습니다');
});

test('comments: post appears in the list with author', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("코멘트")');
  await page.fill('#comments-panel input[type="text"]', '일정 확인 부탁드립니다');
  await page.click('#comments-panel button:has-text("등록")');
  await expect(page.locator('#comments-panel .team-list')).toContainText('e2e@cloud.com');
  await expect(page.locator('#comments-panel .team-list')).toContainText('일정 확인 부탁드립니다');
});

test('archive: project moves under the 보관됨 optgroup and restores', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("보관")');
  await page.waitForSelector('#cloud-auth select optgroup[label="보관됨"]', { state: 'attached' });
  const archived = await page.$$eval('#cloud-auth select optgroup[label="보관됨"] option', (os) => os.map((o) => o.textContent));
  expect(archived.some((t) => t.includes('E2E 프로젝트'))).toBeTruthy();
  await page.click('#cloud-auth button:has-text("보관 해제")');
  await page.waitForFunction(() => !document.querySelector('#cloud-auth select optgroup[label="보관됨"]'));
});
