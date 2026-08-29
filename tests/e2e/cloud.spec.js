// Cloud (SaaS) UI e2e — self-contained: spawns the Node API server itself, so
// the static python webServer from playwright.config is untouched.
// Run: npx playwright test tests/e2e/cloud.spec.js
import { test, expect } from './coverage-fixtures.js';
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

async function loginAndOpen(page, projectId = '1') {
  await page.goto(`${BASE}/`);
  await page.evaluate(([t, id]) => {
    localStorage.setItem('scopeweave:token', t);
    localStorage.setItem('scopeweave:project', id);
  }, [token, projectId]);
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
}

test('opening a cloud project clears standalone seed onboarding', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.locator('#seed-onboarding')).toBeVisible();

  await page.getByRole('button', { name: /클라우드 로그인/ }).click();
  await page.fill('#cloud-email', 'e2e@cloud.com');
  await page.fill('#cloud-password', 'password123');
  await page.click('#cloud-submit');
  await page.waitForSelector('#cloud-auth select');
  await page.getByRole('searchbox', { name: 'WBS 작업 검색' }).fill('사업수행계획');
  await page.locator('#cloud-auth select').selectOption('1');

  await expect(page.locator('#seed-onboarding')).toBeHidden();
  await expect(page.locator('#clear-seed-data')).toBeHidden();
  await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' })).toHaveValue('');
  const project = await api('/api/projects/1', { tok: token });
  expect(project.tasks.length).toBeGreaterThan(0);
});

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
  await page.locator('#comments-panel select').selectOption('t1');
  await page.fill('#comments-panel input[type="text"]', '일정 확인 부탁드립니다');
  await page.click('#comments-panel button:has-text("등록")');
  await expect(page.locator('#comments-panel .team-list')).toContainText('e2e@cloud.com');
  await expect(page.locator('#comments-panel .team-list')).toContainText('[설계]');
  await expect(page.locator('#comments-panel .team-list')).toContainText('일정 확인 부탁드립니다');
  await page.click('#comments-panel .team-list button:has-text("삭제")');
  await expect(page.locator('#comments-panel .team-list')).toContainText('코멘트가 없습니다.');
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
  const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
  await search.fill('설계');
  page.on('dialog', (d) => d.accept());
  await page.click('#cloud-auth button:has-text("MSP 가져오기")');
  const xml = `<?xml version="1.0"?><Project><Tasks>
    <Task><UID>1</UID><Name>MSP단계</Name><OutlineLevel>1</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-13T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>MSP액티비티</Name><OutlineLevel>2</OutlineLevel><Start>2026-03-02T08:00:00</Start><Finish>2026-03-06T17:00:00</Finish></Task>
  </Tasks></Project>`;
  await page.setInputFiles('#msp-file-input', { name: 'plan.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await expect(search).toHaveValue('');
  await page.waitForFunction(() => document.querySelector('#task-table-body')?.textContent.includes('MSP단계'));
  // wait for the debounced cloud push, then confirm server state
  await page.waitForTimeout(1200);
  const server = await api('/api/projects/1', { tok: token });
  expect(server.tasks.some((t) => t.id === 'msp-1' && t.depth === 1)).toBeTruthy();
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

test('cloud management modals cover share, sprint, attachment, and search flows', async ({ page }) => {
  const project = await api('/api/projects', { method: 'POST', body: { name: '모달 프로젝트' }, tok: token });
  await api(`/api/projects/${project.id}`, {
    method: 'PUT',
    tok: token,
    body: {
      tasks: [{
        id: 'modal-task',
        name: '모달 작업',
        sprint: '모달 스프린트',
        storyPoints: 5,
        plannedStartDate: '2026-01-01',
        plannedEndDate: '2026-01-07',
        actualProgress: 100,
      }],
      version: project.version,
    },
  });
  await api(`/api/projects/${project.id}/sprints`, {
    method: 'POST',
    tok: token,
    body: { name: '모달 스프린트', startDate: '2026-01-01', endDate: '2026-01-07' },
  });

  await loginAndOpen(page, String(project.id));
  page.on('dialog', (dialog) => dialog.accept(''));

  await page.click('#cloud-auth button:has-text("공유")');
  await expect(page.locator('#share-panel')).toContainText('활성 공유 링크가 없습니다.');
  await page.click('#share-panel button:has-text("공유 링크 만들기")');
  await expect(page.locator('#share-panel')).toContainText('?share=');
  await page.click('#share-panel button:has-text("복사")');
  await page.click('#share-panel button:has-text("철회")');
  await expect(page.locator('#share-panel')).toContainText('활성 공유 링크가 없습니다.');
  await page.click('#share-panel button[aria-label="공유 닫기"]');

  await page.click('#cloud-auth button:has-text("스프린트")');
  await expect(page.locator('#sprint-panel')).toContainText('모달 스프린트');
  await page.selectOption('#methodology-select', 'hybrid');
  await page.click('#sprint-panel button:has-text("번다운")');
  await expect(page.locator('#burndown-holder svg')).toBeVisible();
  await page.locator('#sprint-panel input[placeholder*="스프린트 이름"]').fill('추가 스프린트');
  await page.locator('#sprint-panel input[type="date"]').nth(0).fill('2026-02-01');
  await page.locator('#sprint-panel input[type="date"]').nth(1).fill('2026-02-07');
  await page.click('#sprint-panel button:has-text("추가")');
  await expect(page.locator('#sprint-panel')).toContainText('추가 스프린트');
  const addedSprint = page.locator('#sprint-panel li').filter({ hasText: '추가 스프린트' });
  await addedSprint.getByRole('button', { name: '삭제' }).click();
  await expect(addedSprint).toHaveCount(0);
  await page.click('#sprint-panel button[aria-label="스프린트 닫기"]');

  await page.click('#cloud-auth button:has-text("산출물")');
  await expect(page.locator('#attachments-panel')).toContainText('첨부된 산출물이 없습니다.');
  await page.locator('#attachments-panel select').selectOption('modal-task');
  await page.setInputFiles('#attachment-file-input', { name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('e2e artifact') });
  await page.click('#attachments-panel button:has-text("업로드")');
  await expect(page.locator('#attachments-panel .team-list')).toContainText('brief.txt');
  const popupPromise = page.waitForEvent('popup');
  await page.click('#attachments-panel button:has-text("보기")');
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).pathname).toContain('/api/mock-clearfolio/');
  await popup.close();
  await page.click('#attachments-panel button:has-text("삭제")');
  await expect(page.locator('#attachments-panel')).toContainText('첨부된 산출물이 없습니다.');
  await page.click('#attachments-panel button[aria-label="산출물 닫기"]');

  await page.click('#cloud-auth button:has-text("검색")');
  await page.locator('#search-panel input[type="search"]').fill('모달 작업');
  await page.click('#search-panel button:has-text("검색")');
  await expect(page.locator('#search-panel')).toContainText('모달 프로젝트');
  await page.click('#search-panel button:has-text("열기")');
  await expect(page.locator('#cloud-auth select')).toHaveValue(String(project.id));
});

test('team management covers owner, member, billing, token, webhook, and audit flows', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("팀")');
  await expect(page.locator('#team-body')).toContainText('e2e@cloud.com');

  page.once('dialog', (dialog) => dialog.accept('E2E 워크스페이스'));
  await page.click('#team-body button:has-text("워크스페이스 이름 변경")');
  await expect(page.locator('#team-body')).toContainText('Free');
  await page.click('#team-body button:has-text("Pro 업그레이드")');
  await expect(page.locator('#toast')).toContainText('결제 연동');

  await page.fill('#team-email', 'cancelled@cloud.com');
  await page.locator('#team-email').press('Enter');
  await expect(page.locator('#team-body')).toContainText('cancelled@cloud.com');
  await page.locator('#team-body li').filter({ hasText: 'cancelled@cloud.com' }).getByRole('button', { name: '초대 취소' }).dispatchEvent('click');
  await expect(page.locator('#team-body')).not.toContainText('cancelled@cloud.com');

  await page.fill('#team-email', 'member@cloud.com');
  await page.locator('#team-email').press('Enter');
  const pending = await api('/api/orgs/1/members', { tok: token });
  const invite = pending.invites.find((row) => row.email === 'member@cloud.com');
  expect(invite?.token).toBeTruthy();
  const member = await api('/api/auth/signup', { method: 'POST', body: { email: 'member@cloud.com', password: 'password123' } });
  await api(`/api/invites/${invite.token}/accept`, { method: 'POST', tok: member.token });

  await page.click('#team-modal button[aria-label="닫기"]');
  await expect(page.locator('#team-modal')).toBeHidden();
  await page.click('#cloud-auth button:has-text("팀")');
  const memberRow = page.locator('#team-body .team-list li').filter({ hasText: 'member@cloud.com' });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole('combobox').selectOption('viewer');
  page.once('dialog', (dialog) => dialog.dismiss());
  await memberRow.getByRole('button', { name: '소유권 이전' }).dispatchEvent('click');
  await memberRow.getByRole('button', { name: '제거' }).dispatchEvent('click');
  await expect(memberRow).toHaveCount(0);

  await page.fill('#team-body input[placeholder="https://example.com/webhook"]', 'https://example.com/hook');
  await page.locator('#team-body input[placeholder="https://example.com/webhook"]').press('Enter');
  await expect(page.locator('#team-body')).toContainText('서명 시크릿(한 번만 표시): whsec_');
  await page.click('#team-modal button[aria-label="닫기"]');
  await expect(page.locator('#team-modal')).toBeHidden();
  await page.click('#cloud-auth button:has-text("팀")');
  const webhookRow = page.locator('#team-body .team-list li').filter({ hasText: 'https://example.com/hook' });
  let rotateDialogs = 0;
  const handleRotateDialog = (dialog) => {
    rotateDialogs += 1;
    dialog.accept('');
    if (rotateDialogs === 2) page.off('dialog', handleRotateDialog);
  };
  page.on('dialog', handleRotateDialog);
  await webhookRow.getByRole('button', { name: '키 교체' }).dispatchEvent('click');
  await webhookRow.getByRole('button', { name: '삭제' }).dispatchEvent('click');
  await expect(page.locator('#team-body')).not.toContainText('https://example.com/hook');

  await page.fill('#team-body input[placeholder*="토큰 이름"]', 'CI');
  await page.locator('#team-body input[placeholder*="토큰 이름"]').press('Enter');
  await expect(page.locator('#team-body')).toContainText('한 번만 표시됩니다');
  await page.click('#team-modal button[aria-label="닫기"]');
  await expect(page.locator('#team-modal')).toBeHidden();
  await page.click('#cloud-auth button:has-text("팀")');
  const tokenRow = page.locator('#team-body .team-list li').filter({ hasText: 'CI' });
  await tokenRow.getByRole('button', { name: '폐기' }).dispatchEvent('click');
  await expect(page.locator('#team-body')).not.toContainText('CI');

  const auditDownload = page.waitForEvent('download');
  await page.locator('#team-body button:has-text("CSV 다운로드")').dispatchEvent('click');
  expect((await auditDownload).suggestedFilename()).toContain('scopeweave-audit-');
  const exportDownload = page.waitForEvent('download');
  await page.locator('#team-body button:has-text("데이터 내보내기")').dispatchEvent('click');
  expect((await exportDownload).suggestedFilename()).toContain('scopeweave-org-');

  await page.fill('#team-body input[placeholder="현재 비밀번호"]', 'password123');
  await page.fill('#team-body input[placeholder*="새 비밀번호"]', 'password456');
  await page.locator('#team-body input[placeholder*="새 비밀번호"]').press('Enter');
  await expect(page.locator('#toast')).toContainText('비밀번호를 변경했습니다');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#team-body button:has-text("다른 모든 기기에서 로그아웃")').dispatchEvent('click');
  await expect(page.locator('#toast')).toContainText('다른 모든 기기에서 로그아웃했습니다');
  await page.click('#team-modal button[aria-label="닫기"]');
  await expect(page.locator('#team-modal')).toBeHidden();
  await page.click('#cloud-auth button:has-text("로그아웃")');
  await expect(page.getByRole('button', { name: /클라우드 로그인/ })).toBeVisible();
});

test('cloud project creation prompt creates a project for a new account', async ({ page }) => {
  const creator = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'creator@cloud.com', password: 'password123' },
  });
  await page.goto(`${BASE}/`);
  await page.evaluate((t) => {
    localStorage.setItem('scopeweave:token', t);
    localStorage.removeItem('scopeweave:project');
  }, creator.token);
  await page.reload();
  page.once('dialog', (dialog) => dialog.accept('UI 생성 프로젝트'));
  await page.click('#cloud-auth button:has-text("+ 새 프로젝트")');
  await expect(page.locator('#cloud-auth select')).toContainText('UI 생성 프로젝트');
});

test('cloud onboarding creates the first project from the sample', async ({ page }) => {
  const sampleUser = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'sample@cloud.com', password: 'password123' },
  });
  await page.goto(`${BASE}/`);
  await page.evaluate((t) => {
    localStorage.setItem('scopeweave:token', t);
    localStorage.removeItem('scopeweave:project');
  }, sampleUser.token);
  await page.reload();
  await page.getByRole('button', { name: '✨ 샘플로 시작' }).click();
  await expect(page.locator('#cloud-auth select')).toContainText('샘플 프로젝트');
});
