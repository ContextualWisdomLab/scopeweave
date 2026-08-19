import { test, expect } from './coverage-test.js';
import { spawn } from 'node:child_process';

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
  return { status: response.status, ok: response.ok, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('ScopeWeave team-boundary server did not become ready');
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
}

async function openTeam(page) {
  await page.click('#cloud-auth button:has-text("팀")');
  await page.waitForSelector('#team-body');
  return page.locator('#team-body');
}

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server/server.mjs'], {
    env: {
      ...process.env,
      SCOPEWEAVE_DB: ':memory:',
      SCOPEWEAVE_JWT_SECRET: 'abcdef0123456789abcdef0123456789',
      PORT: String(PORT),
    },
    stdio: 'ignore',
  });
  await waitForServer();

  const signup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'team-owner@scopeweave.test', password: 'password123', name: 'Team Owner' },
  });
  if (!signup.ok) throw new Error(`team owner signup failed (${signup.status})`);
  ownerToken = signup.data.token;
  const me = await api('/api/me');
  ownerOrgId = me.data.orgs[0].id;
  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: 'Team Boundary Project', orgId: ownerOrgId },
  });
  if (!created.ok) throw new Error(`team project creation failed (${created.status})`);
  projectId = created.data.id;
});

test.afterAll(() => { server?.kill(); });

test('owner can rename the workspace, exercise upgrade guidance, and revoke a pending invite', async ({ page }) => {
  await loginAndOpen(page);
  const team = await openTeam(page);

  page.once('dialog', (dialog) => dialog.accept('Acquisition Ready Workspace'));
  await team.getByRole('button', { name: '워크스페이스 이름 변경' }).click();
  await expect(page.locator('#toast')).toContainText('이름을 변경했습니다.');
  await expect.poll(async () => {
    const me = await api('/api/me');
    return me.data.orgs.find((org) => String(org.id) === String(ownerOrgId))?.name;
  }).toBe('Acquisition Ready Workspace');

  await team.getByRole('button', { name: 'Pro 업그레이드' }).click();
  await expect(page.locator('#toast')).toContainText('결제 연동(Stripe 키)이 필요합니다');

  await page.locator('#team-email').fill('pending-viewer@scopeweave.test');
  await page.locator('#team-role').selectOption('viewer');
  await page.locator('#team-invite').getByRole('button', { name: '초대', exact: true }).click();
  await expect(page.locator('#team-msg')).toContainText('초대 링크:');
  const pendingRow = page.locator('#team-body .team-list li').filter({ hasText: 'pending-viewer@scopeweave.test' });
  await expect(pendingRow).toHaveCount(1);
  await pendingRow.getByRole('button', { name: '초대 취소' }).click();
  await expect(page.locator('#toast')).toContainText('초대를 취소했습니다.');
  await expect(page.locator('#team-body')).not.toContainText('pending-viewer@scopeweave.test');
});

test('owner can change a member role and remove the member through the team surface', async ({ page }) => {
  const invite = await api(`/api/orgs/${ownerOrgId}/invites`, {
    method: 'POST',
    body: { email: 'managed-member@scopeweave.test', role: 'member' },
  });
  expect(invite.ok).toBe(true);
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'managed-member@scopeweave.test', password: 'password123', name: 'Managed Member' },
  });
  expect(signup.ok).toBe(true);
  const accepted = await api(`/api/invites/${invite.data.token}/accept`, {
    method: 'POST',
    tok: signup.data.token,
  });
  expect(accepted.ok).toBe(true);

  await loginAndOpen(page);
  await openTeam(page);
  const memberRow = page.locator('#team-body .team-list li').filter({ hasText: 'managed-member@scopeweave.test' });
  await expect(memberRow).toHaveCount(1);

  await memberRow.locator('select.cloud-select').selectOption('viewer');
  await expect(page.locator('#toast')).toContainText('managed-member@scopeweave.test → 뷰어');
  await memberRow.getByRole('button', { name: '제거', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('managed-member@scopeweave.test 제거됨');
  await expect(page.locator('#team-body')).not.toContainText('managed-member@scopeweave.test');
});

test('account controls change a password and preserve the current device across global logout', async ({ page }) => {
  await loginAndOpen(page);
  const team = await openTeam(page);
  const account = team.locator('.token-section').filter({ hasText: '계정' });

  await account.locator('input[autocomplete="current-password"]').fill('password123');
  await account.locator('input[autocomplete="new-password"]').fill('password456');
  await account.getByRole('button', { name: '비밀번호 변경' }).click();
  await expect(page.locator('#toast')).toContainText('비밀번호를 변경했습니다.');

  const login = await api('/api/auth/login', {
    method: 'POST',
    tok: '',
    body: { email: 'team-owner@scopeweave.test', password: 'password456' },
  });
  expect(login.ok).toBe(true);
  ownerToken = login.data.token;
  await page.evaluate((token) => localStorage.setItem('scopeweave:token', token), ownerToken);

  page.once('dialog', (dialog) => dialog.accept());
  await account.getByRole('button', { name: '다른 모든 기기에서 로그아웃' }).click();
  await expect(page.locator('#toast')).toContainText('다른 모든 기기에서 로그아웃했습니다.');
  ownerToken = await page.evaluate(() => localStorage.getItem('scopeweave:token'));
  expect(ownerToken).toBeTruthy();

  const restored = await api('/api/auth/change-password', {
    method: 'POST',
    body: { oldPassword: 'password456', newPassword: 'password123' },
  });
  expect(restored.ok).toBe(true);
  const relogin = await api('/api/auth/login', {
    method: 'POST',
    tok: '',
    body: { email: 'team-owner@scopeweave.test', password: 'password123' },
  });
  expect(relogin.ok).toBe(true);
  ownerToken = relogin.data.token;
});

test('a throwaway owner can delete the account from the buyer-visible account controls', async ({ page }) => {
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    tok: '',
    body: { email: 'delete-me@scopeweave.test', password: 'password123', name: 'Delete Me' },
  });
  expect(signup.ok).toBe(true);
  const me = await api('/api/me', { tok: signup.data.token });
  const orgId = me.data.orgs[0].id;
  const project = await api('/api/projects', {
    method: 'POST',
    tok: signup.data.token,
    body: { name: 'Disposable Project', orgId },
  });
  expect(project.ok).toBe(true);

  await loginAndOpen(page, signup.data.token, project.data.id);
  const team = await openTeam(page);
  const account = team.locator('.token-section').filter({ hasText: '계정' });
  page.once('dialog', (dialog) => dialog.accept('password123'));
  await account.getByRole('button', { name: '계정 삭제' }).click();
  await expect(page.locator('#toast')).toContainText('계정을 삭제했습니다.');
  await expect(page.locator('#cloud-auth')).toContainText('로그인');

  const login = await api('/api/auth/login', {
    method: 'POST',
    tok: '',
    body: { email: 'delete-me@scopeweave.test', password: 'password123' },
  });
  expect(login.status).toBe(401);
});
