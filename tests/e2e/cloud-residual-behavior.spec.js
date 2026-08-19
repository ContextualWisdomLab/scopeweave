// Residual SaaS UI behavior coverage. This suite owns its API server so it can
// exercise buyer-visible cloud workflows without sharing mutable state with the
// primary cloud.spec.js fixture.
import { test, expect } from './coverage-test.js';
import { spawn } from 'node:child_process';

const PORT = 8832;
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
  throw new Error('ScopeWeave residual cloud test server did not become ready');
}

async function loginAndOpen(page, token = ownerToken, id = projectId) {
  await page.goto(`${BASE}/`);
  await page.evaluate(({ authToken, project }) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', authToken);
    localStorage.setItem('scopeweave:project', String(project));
  }, { authToken: token, project: id });
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
  await page.waitForSelector('#task-table-body tr[data-task-id]');
}

async function closeCloudModal(page, panelSelector, accessibleName) {
  const panel = page.locator(panelSelector);
  const close = panel.getByRole('button', { name: accessibleName });
  await expect(close).toHaveCount(1);
  await close.click();
  await expect(panel).toBeHidden();
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
    body: { email: 'residual-owner@scopeweave.test', password: 'password123', name: 'Residual Owner' },
  });
  if (!signup.ok) throw new Error(`owner signup failed (${signup.status})`);
  ownerToken = signup.data.token;

  const me = await api('/api/me');
  ownerOrgId = me.data.orgs[0].id;
  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Residual Coverage Project', orgId: ownerOrgId },
  });
  projectId = created.data.id;
  const seeded = await api(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: {
      name: 'Residual Coverage Project',
      baseDate: '2026-08-19',
      version: created.data.version,
      tasks: [{
        id: 'residual-task',
        parentId: null,
        depth: 1,
        expanded: true,
        phase: 'Residual Phase',
        task: 'Residual deliverable',
        owner: 'Residual Owner',
        plannedStartDate: '2026-08-18',
        plannedEndDate: '2026-08-20',
        actualProgressStatus: '진행중(50%)',
      }],
    },
  });
  if (!seeded.ok) throw new Error(`project seed failed (${seeded.status})`);
});

test.afterAll(() => { server?.kill(); });

test('task-bound attachments and comments preserve visible project context through CRUD', async ({ page }) => {
  await loginAndOpen(page);

  await page.click('#cloud-auth button:has-text("산출물")');
  const attachments = page.locator('#attachments-panel');
  await attachments.locator('select.cloud-select').selectOption({ label: 'Residual deliverable' });
  await page.setInputFiles('#attachment-file-input', {
    name: 'residual-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ScopeWeave residual evidence', 'utf8'),
  });
  await attachments.getByRole('button', { name: '업로드', exact: true }).click();
  await expect(attachments.locator('.team-list')).toContainText('residual-evidence.txt');
  await expect(attachments.locator('.team-list')).toContainText('[Residual deliverable]');
  await expect(attachments.getByRole('button', { name: '보기', exact: true })).toHaveCount(1);
  await attachments.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(attachments).toContainText('첨부된 산출물이 없습니다.');

  await closeCloudModal(page, '#attachments-panel', '산출물 닫기');
  await page.click('#cloud-auth button:has-text("코멘트")');
  const comments = page.locator('#comments-panel');
  await comments.locator('select.cloud-select').selectOption({ label: 'Residual deliverable' });
  await comments.locator('input[type="text"]').fill('Task-bound residual comment');
  await comments.getByRole('button', { name: '등록', exact: true }).click();
  await expect(comments.locator('.team-list')).toContainText('[Residual deliverable]');
  await expect(comments.locator('.team-list')).toContainText('Task-bound residual comment');
  await comments.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(comments).toContainText('코멘트가 없습니다.');
});

test('baseline comparison renders moved, added, and deleted buyer-visible schedule evidence', async ({ page }) => {
  await loginAndOpen(page);
  page.once('dialog', (dialog) => dialog.accept('Residual baseline'));
  await page.click('#cloud-auth button:has-text("기준선")');
  const baselinePanel = page.locator('#baseline-panel');
  await baselinePanel.getByRole('button', { name: '현재 계획을 기준선으로 저장' }).click();
  await expect(baselinePanel).toContainText('Residual baseline');

  const current = await api(`/api/projects/${projectId}`);
  const changed = await api(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: {
      name: current.data.name,
      baseDate: current.data.baseDate,
      version: current.data.version,
      tasks: [{
        ...current.data.tasks[0],
        plannedEndDate: '2026-08-25',
      }, {
        id: 'residual-added',
        parentId: null,
        depth: 1,
        expanded: true,
        phase: 'Added Phase',
        task: 'Added buyer task',
        plannedStartDate: '2026-08-21',
        plannedEndDate: '2026-08-22',
      }],
    },
  });
  expect(changed.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('#cloud-auth select');
  await page.click('#cloud-auth button:has-text("기준선")');
  const refreshedPanel = page.locator('#baseline-panel');
  const baselineRow = refreshedPanel.locator('.team-list li').filter({ hasText: 'Residual baseline' });
  await baselineRow.getByRole('button', { name: '비교', exact: true }).click();
  await expect(page.locator('#baseline-result')).toContainText('변경');
  await expect(page.locator('#baseline-result')).toContainText('+5일');
  await expect(page.locator('#baseline-result')).toContainText('신규');

  await baselineRow.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('#baseline-panel')).toContainText('저장된 기준선이 없습니다.');
});

test('team governance actions exercise revocation, webhook rotation, and audit export paths', async ({ page }) => {
  await loginAndOpen(page);
  await page.click('#cloud-auth button:has-text("팀")');
  await page.waitForSelector('#team-body');

  let tokenSection = page.locator('#team-body .token-section').filter({ hasText: 'API 토큰' });
  await tokenSection.locator('input[type="text"]').fill('Residual PAT');
  await tokenSection.getByRole('button', { name: '토큰 생성', exact: true }).click();
  await expect(tokenSection.locator('.token-secret')).toContainText('한 번만 표시됩니다');

  const webhookSection = page.locator('#team-body .token-section').filter({ hasText: '웹훅' });
  await webhookSection.locator('input[type="url"]').fill('https://example.com/scopeweave-residual');
  await webhookSection.getByRole('button', { name: '웹훅 추가', exact: true }).click();
  await expect(webhookSection).toContainText('https://example.com/scopeweave-residual');

  await closeCloudModal(page, '#team-modal', '닫기');
  await page.click('#cloud-auth button:has-text("팀")');
  await page.waitForSelector('#team-body');

  tokenSection = page.locator('#team-body .token-section').filter({ hasText: 'API 토큰' });
  const tokenRow = tokenSection.locator('.team-list li').filter({ hasText: 'Residual PAT' });
  await tokenRow.getByRole('button', { name: '폐기', exact: true }).click();
  await expect(tokenSection.locator('.team-list')).not.toContainText('Residual PAT');

  const refreshedWebhook = page.locator('#team-body .token-section').filter({ hasText: '웹훅' });
  const webhookRow = refreshedWebhook.locator('.team-list li').filter({ hasText: 'scopeweave-residual' });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') await dialog.accept();
    else if (dialog.type() === 'prompt') await dialog.accept('acknowledged');
  });
  await webhookRow.getByRole('button', { name: '키 교체', exact: true }).click();
  await webhookRow.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('#team-body .token-section').filter({ hasText: '웹훅' })).not.toContainText('scopeweave-residual');

  const audit = page.locator('#team-body .token-section').filter({ hasText: '감사 로그' });
  await expect(audit).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await audit.getByRole('button', { name: 'CSV 다운로드', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('scopeweave-audit-');
});

test('SSO fragment cleanup and invite auto-accept keep credentials out of the visible URL', async ({ page, context }) => {
  const ssoPage = await context.newPage();
  await ssoPage.goto(`${BASE}/#token=${encodeURIComponent(ownerToken)}`);
  await expect.poll(() => ssoPage.evaluate(() => localStorage.getItem('scopeweave:token'))).toBe(ownerToken);
  await expect.poll(() => ssoPage.evaluate(() => location.hash)).toBe('');
  await ssoPage.close();

  const invite = await api(`/api/orgs/${ownerOrgId}/invites`, {
    method: 'POST',
    body: { email: 'residual-invitee@scopeweave.test', role: 'viewer' },
  });
  expect(invite.ok).toBe(true);
  const inviteeSignup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'residual-invitee@scopeweave.test', password: 'password123', name: 'Residual Invitee' },
  });
  expect(inviteeSignup.ok).toBe(true);
  const inviteeToken = inviteeSignup.data.token;

  const invitePage = await context.newPage();
  await invitePage.addInitScript((authToken) => {
    localStorage.setItem('scopeweave:token', authToken);
  }, inviteeToken);
  await invitePage.goto(`${BASE}/?invite=${invite.data.token}`);
  await expect(invitePage.locator('#toast')).toContainText('초대를 수락했습니다.');
  await expect.poll(async () => {
    const me = await api('/api/me', { tok: inviteeToken });
    return me.data.orgs.some((org) => String(org.id) === String(ownerOrgId));
  }).toBe(true);
  await invitePage.close();
});
