// Cloud (SaaS) UI e2e — self-contained: spawns the Node API server itself, so
// the static python webServer from playwright.config is untouched.
// Run: npx playwright test tests/e2e/cloud.spec.js
import { test, expect } from './coverage-test.js';
import { spawn } from 'node:child_process';

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
    env: { ...process.env, SCOPEWEAVE_DB: ':memory:', SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef', PORT: String(PORT) },
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
  await page.click('#cloud-auth button:has-text("주간보고")');
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
  await page.click('#cloud-auth button:has-text("MSP 가져오기")');
  const xml = `<?xml version="1.0"?><Project><Tasks>
    <Task><UID>1</UID><Name>MSP단계</Name><OutlineLevel>1</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-13T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>MSP액티비티</Name><OutlineLevel>2</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-06T17:00:00</Finish></Task>
  </Tasks></Project>`;
  await page.setInputFiles('#msp-file-input', { name: 'plan.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await page.waitForFunction(() => document.querySelector('#task-table-body')?.textContent.includes('MSP단계'));
  // wait for the debounced cloud push, then confirm server state
  await page.waitForTimeout(1200);
  const serverState = await api('/api/projects/1', { tok: token });
  expect(serverState.tasks.some((t) => t.id === 'msp-1' && t.depth === 1)).toBeTruthy();
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

test('login modal surfaces failed credentials, toggles signup mode, and authenticates', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#cloud-auth button:has-text("클라우드 로그인")');
  await page.click('#cloud-toggle');
  await expect(page.locator('#cloud-modal-title')).toHaveText('계정 만들기');
  await page.click('#cloud-toggle');
  await expect(page.locator('#cloud-modal-title')).toHaveText('클라우드 로그인');

  await page.fill('#cloud-email', 'e2e@cloud.com');
  await page.fill('#cloud-password', 'wrong-password');
  await page.click('#cloud-submit');
  await expect(page.locator('#cloud-error')).not.toHaveText('');

  await page.fill('#cloud-password', 'password123');
  await page.click('#cloud-submit');
  await page.waitForSelector('#cloud-auth select');
  expect(await page.evaluate(() => Boolean(localStorage.getItem('scopeweave:token')))).toBeTruthy();
});

test('first-time cloud user can seed the buyer-visible sample project', async ({ page }) => {
  const sampleToken = (await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'sample@cloud.com', password: 'password123', name: 'Sample User' },
  })).token;
  await page.goto(`${BASE}/`);
  await page.evaluate(([t]) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', t);
  }, [sampleToken]);
  await page.reload();
  await page.waitForSelector('#cloud-auth button:has-text("샘플로 시작")');
  await page.click('#cloud-auth button:has-text("샘플로 시작")');
  await page.waitForFunction(() => [...document.querySelectorAll('#cloud-auth select option')]
    .some((option) => option.textContent?.includes('샘플 프로젝트')));
  expect(await page.evaluate(() => Boolean(localStorage.getItem('scopeweave:project')))).toBeTruthy();
});

test('new-project and search flows operate through the shipped cloud UI', async ({ page }) => {
  await loginAndOpen(page);
  page.once('dialog', (dialog) => dialog.accept('검색 가능한 프로젝트'));
  await page.click('#cloud-auth button:has-text("+ 새 프로젝트")');
  await page.waitForFunction(() => [...document.querySelectorAll('#cloud-auth select option')]
    .some((option) => option.textContent?.includes('검색 가능한 프로젝트')));

  await page.click('#cloud-auth button:has-text("검색")');
  await page.fill('#search-panel input[type="search"]', '검색 가능한');
  await page.click('#search-panel button:has-text("검색")');
  await expect(page.locator('#search-panel')).toContainText('검색 가능한 프로젝트');
  await page.click('#search-panel button:has-text("열기")');
  await expect(page.locator('#toast')).toContainText('프로젝트를 열었습니다');
});

test('team administration renders governance controls and creates bounded credentials', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("팀")');
  await page.waitForSelector('#team-body');
  await expect(page.locator('#team-body')).toContainText('API 토큰');
  await expect(page.locator('#team-body')).toContainText('웹훅');
  await expect(page.locator('#team-body')).toContainText('계정');

  const tokenSection = page.locator('#team-body .token-section').filter({ hasText: 'API 토큰' });
  await tokenSection.locator('input[type="text"]').fill('E2E CI');
  await tokenSection.locator('button:has-text("토큰 생성")').click();
  await expect(tokenSection.locator('.token-secret')).toContainText('한 번만 표시됩니다');

  await page.fill('#team-email', 'invitee@example.com');
  await page.selectOption('#team-role', 'viewer');
  await page.click('#team-invite button:has-text("초대")');
  await expect(page.locator('#team-msg')).toContainText('초대 링크:');

  const downloadPromise = page.waitForEvent('download');
  await page.click('#team-body button:has-text("데이터 내보내기")');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('scopeweave-org-');
});

test('sprint workflow persists methodology and renders a real burndown', async ({ page }) => {
  const project = await api('/api/projects/1', { tok: token });
  await api('/api/projects/1', {
    method: 'PUT',
    tok: token,
    body: {
      tasks: [
        {
          id: 's1', name: 'Sprint done', sprint: 'Sprint E2E', storyPoints: 5,
          actualProgress: 100, actualEndDate: '2026-08-02', plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-03',
        },
        {
          id: 's2', name: 'Sprint open', sprint: 'Sprint E2E', storyPoints: 8,
          actualProgress: 40, plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-08',
        },
      ],
      baseDate: project.baseDate,
      version: project.version,
    },
  });

  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("스프린트")');
  const form = page.locator('#sprint-panel form.cloud-form');
  await form.locator('input[type="text"]').fill('Sprint E2E');
  await form.locator('input[type="date"]').nth(0).fill('2026-08-01');
  await form.locator('input[type="date"]').nth(1).fill('2026-08-08');
  await form.locator('button:has-text("추가")').click();
  await expect(page.locator('#sprint-panel .team-list')).toContainText('Sprint E2E');
  await expect(page.locator('#sprint-panel .cpm-summary')).toContainText('벨로시티');

  await page.selectOption('#methodology-select', 'hybrid');
  await expect(page.locator('#toast')).toContainText('Hybrid');
  await page.click('#sprint-panel button:has-text("번다운")');
  await expect(page.locator('#burndown-holder')).toContainText('커밋 13pt');
  await expect(page.locator('#burndown-holder svg')).toHaveCount(1);
});

test('share and attachment modals expose actionable empty states without hidden transport details', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("공유")');
  await expect(page.locator('#share-panel')).toContainText('활성 공유 링크가 없습니다.');

  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#share-panel button:has-text("공유 링크 만들기")');
  await page.waitForFunction(() => document.querySelectorAll('#share-panel .team-list li').length > 0);
  await expect(page.locator('#share-panel .team-list')).toContainText('복사');
  await page.click('#share-panel button:has-text("철회")');
  await expect(page.locator('#share-panel')).toContainText('활성 공유 링크가 없습니다.');

  await page.click('#cloud-auth button:has-text("산출물")');
  await expect(page.locator('#attachments-panel')).toContainText('첨부된 산출물이 없습니다.');
});
