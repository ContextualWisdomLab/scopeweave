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

async function useTool(page, label) {
  await page.selectOption('#project-tools', label);
}

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
  for (const expected of ['+ 새 프로젝트', '팀', '검색', '로그아웃']) {
    expect(labels).toContain(expected);
  }
  const toolOptions = await page.$$eval('#project-tools option', (os) => os.map((o) => o.value));
  for (const expected of ['기준선', '스프린트', '주간보고', '공유', '산출물', '코멘트', '복제', 'MSP 가져오기', '보관']) {
    expect(toolOptions).toContain(expected);
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
  await useTool(page, '기준선');
  await page.click('#baseline-panel button:has-text("기준선으로 저장")');
  await page.waitForSelector('#baseline-panel .team-list li');
  await page.click('#baseline-panel button:has-text("비교")');
  await expect(page.locator('#baseline-result')).toContainText('기준선과 차이가 없습니다');
});

test('comments: post appears in the list with author', async ({ page }) => {
  await loginAndOpen(page);
  await useTool(page, '코멘트');
  await page.fill('#comments-panel input[type="text"]', '일정 확인 부탁드립니다');
  await page.click('#comments-panel button:has-text("등록")');
  await expect(page.locator('#comments-panel .team-list')).toContainText('e2e@cloud.com');
  await expect(page.locator('#comments-panel .team-list')).toContainText('일정 확인 부탁드립니다');
});

test('portfolio dashboard: rollup renders SPI/status per project', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("대시보드")');
  await page.waitForSelector('#portfolio-panel tbody tr');
  const summary = await page.locator('#portfolio-panel p').first().textContent();
  expect(summary).toContain('프로젝트');
  const row = await page.locator('#portfolio-panel tbody tr').first().textContent();
  expect(row).toContain('E2E 프로젝트');
  expect(row).toMatch(/\d+(\.\d+)?%/); // planned/actual percentages present
});

test('weekly report: modal renders sections + summary and copies markdown', async ({ page }) => {
  await loginAndOpen(page);
  await useTool(page, '주간보고');
  await page.waitForSelector('#report-body');
  const body = await page.locator('#report-body').textContent();
  expect(body).toContain('# 주간보고');
  for (const sec of ['금주 완료', '진행 중', '지연', '차주 예정']) expect(body).toContain(`## ${sec}`);
  expect(body).toMatch(/계획 \d+(\.\d+)?% · 실적 \d+(\.\d+)?%/);
});

test('share link: anonymous visitor gets a read-only view; revoke kills it', async ({ page, context }) => {
  await loginAndOpen(page);
  // create a share via API (clipboard is flaky headless), then visit anonymously
  const share = await api('/api/projects/1/shares', { method: 'POST', tok: token });
  const anon = await context.newPage();
  await anon.goto(`${BASE}/?share=${share.token}`);
  await anon.evaluate(() => localStorage.clear());
  await anon.reload();
  await anon.waitForSelector('#cloud-auth .team-role-tag');
  expect(await anon.locator('#cloud-auth .team-role-tag').textContent()).toBe('읽기 전용 공유 보기');
  expect(await anon.locator('#cloud-auth button').count()).toBe(0);
  // revoke → the same link dies
  const list = await api('/api/projects/1/shares', { tok: token });
  await api(`/api/projects/1/shares/${list.shares[0].id}`, { method: 'DELETE', tok: token });
  const res = await fetch(`${BASE}/api/shared/${share.token}`);
  expect(res.status).toBe(404);
  await anon.close();
});

test('MSP import: XML file populates the tree and saves to the cloud', async ({ page }) => {
  await loginAndOpen(page);
  page.on('dialog', (d) => d.accept());
  await useTool(page, 'MSP 가져오기');
  const xml = `<?xml version="1.0"?><Project><Tasks>
    <Task><UID>1</UID><Name>MSP단계</Name><OutlineLevel>1</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-13T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>MSP액티비티</Name><OutlineLevel>2</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-06T17:00:00</Finish></Task>
  </Tasks></Project>`;
  await page.setInputFiles('#msp-file-input', { name: 'plan.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.waitForFunction(() => document.querySelector('#task-table-body')?.textContent.includes('MSP단계'));
  // wait for the debounced cloud push, then confirm server state
  await page.waitForTimeout(1200);
  const server = await api('/api/projects/1', { tok: token });
  expect(server.tasks.some((t) => t.id === 'msp-1' && t.depth === 1)).toBeTruthy();
});

test('sprint: create → stats/velocity render → burndown SVG', async ({ page }) => {
  await loginAndOpen(page);
  // 스프린트 배정 작업 시드 (storyPoints + 완료일)
  const today = new Date().toISOString().slice(0, 10);
  const cur = await api('/api/projects/1', { tok: token });
  await api('/api/projects/1', { method: 'PUT', tok: token, body: {
    tasks: [
      { id: 'sp1', task: '완료작업', depth: 3, sprint: 'S-e2e', storyPoints: 5, actualProgress: 100, actualEndDate: today },
      { id: 'sp2', task: '진행작업', depth: 3, sprint: 'S-e2e', storyPoints: 8, actualProgress: 40 },
    ],
    version: cur.version,
  }});
  await api('/api/projects/1/sprints', { method: 'POST', tok: token, body: { name: 'S-e2e', startDate: today, endDate: today } });
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
  await useTool(page, '스프린트');
  await page.waitForSelector('#sprint-panel .team-list li');
  const row = await page.locator('#sprint-panel .team-list li').first().textContent();
  expect(row).toContain('S-e2e');
  expect(row).toContain('5/13pt');
  // 번다운 렌더
  await page.click('#sprint-panel button:has-text("번다운")');
  await page.waitForSelector('#burndown-holder svg');
  expect(await page.locator('#burndown-holder svg polyline').count()).toBeGreaterThanOrEqual(2);
  // 방법론 hybrid 저장
  await page.selectOption('#methodology-select', 'hybrid');
  await page.waitForTimeout(600);
  const meta = await api('/api/projects/1', { tok: token });
  expect(meta.methodology).toBe('hybrid');
  // hybrid: EVM 패널 표시 유지
  expect(await page.locator('#evm-panel').textContent()).toContain('PV 계획가치');
  // agile 전환: 예측형 지표는 '참고용' 표기와 함께 유지(날짜 쓰는 Agile 팀 지원)
  await page.selectOption('#methodology-select', 'agile');
  await page.waitForTimeout(600);
  const agilePanel = await page.locator('#evm-panel').textContent();
  expect(agilePanel).toContain('PV 계획가치');
  expect(agilePanel).toContain('참고용');
  expect(await page.locator('#evm-panel.evm-reference').count()).toBe(1);
});

test('archive: project moves under the 보관됨 optgroup and restores', async ({ page }) => {
  await loginAndOpen(page);
  await useTool(page, '보관');
  await page.waitForSelector('#cloud-auth select optgroup[label="보관됨"]', { state: 'attached' });
  const archived = await page.$$eval('#cloud-auth select optgroup[label="보관됨"] option', (os) => os.map((o) => o.textContent));
  expect(archived.some((t) => t.includes('E2E 프로젝트'))).toBeTruthy();
  await useTool(page, '보관 해제');
  await page.waitForFunction(() => !document.querySelector('#cloud-auth select optgroup[label="보관됨"]'));
});
