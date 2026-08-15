import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 8831;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;
let projectId;
let attachmentId;

async function jsonApi(path, { method = 'GET', body, authToken } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server/server.mjs'], {
    env: {
      ...process.env,
      SCOPEWEAVE_DB: ':memory:',
      SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef',
      CLEARFOLIO_URL: '',
      PORT: String(PORT),
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) break;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let result = await jsonApi('/api/auth/signup', {
    method: 'POST',
    body: {
      email: 'attachment-grant-e2e@scopeweave.test',
      password: 'password123',
      name: 'Attachment Grant E2E',
    },
  });
  expect(result.response.status).toBe(200);
  token = result.payload.token;

  result = await jsonApi('/api/projects', {
    method: 'POST',
    authToken: token,
    body: { name: 'Attachment Grant Browser Project' },
  });
  expect(result.response.status).toBe(200);
  projectId = result.payload.id;

  const form = new FormData();
  form.append(
    'file',
    new Blob(['browser attachment evidence'], { type: 'text/plain' }),
    'browser-evidence.txt',
  );
  form.set('taskId', 'grant-e2e-task');
  const upload = await fetch(`${BASE}/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  expect(upload.status).toBe(200);
  const uploaded = await upload.json();
  expect(uploaded.status).toBe('SUCCEEDED');
  attachmentId = uploaded.id;
});

test.afterAll(() => {
  server?.kill();
});

test('attachment view never transmits the full browser session JWT in a URL', async ({ page, context }) => {
  const requestedUrls = [];
  context.on('request', (request) => requestedUrls.push(request.url()));

  await page.goto(`${BASE}/`);
  await page.evaluate(([sessionToken, activeProjectId]) => {
    localStorage.setItem('scopeweave:token', sessionToken);
    localStorage.setItem('scopeweave:project', String(activeProjectId));
  }, [token, projectId]);
  await page.reload();
  await page.waitForSelector('#cloud-auth select');
  await page.click('#cloud-auth button:has-text("산출물")');
  await page.waitForSelector('#attachments-panel button:has-text("보기")');

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#attachments-panel button:has-text("보기")'),
  ]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(250);

  const viewPrefix = `${BASE}/api/projects/${projectId}/attachments/${attachmentId}/view`;
  const viewRequests = requestedUrls.filter((url) => url.startsWith(viewPrefix));
  expect(viewRequests.some((url) => url.includes('?grant='))).toBeTruthy();
  expect(viewRequests.some((url) => url.includes('?token='))).toBeFalsy();
  expect(requestedUrls.some((url) => url.includes(token))).toBeFalsy();
  expect(
    requestedUrls.some((url) => url === `${BASE}/api/projects/${projectId}/access-grants`),
  ).toBeTruthy();
  await popup.close();
});