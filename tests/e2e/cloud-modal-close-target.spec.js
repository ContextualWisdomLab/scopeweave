import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 8836;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('ScopeWeave test server did not become ready');
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function clickDecorativeCloseGlyph(page, modal) {
  const glyph = modal.locator('.close-button [aria-hidden="true"]');
  await expect(glyph).toBeVisible();
  const box = await glyph.boundingBox();
  if (!box) throw new Error('close glyph was not rendered');

  // Click the rendered glyph coordinates instead of invoking Locator.click() on
  // the decorative span. With the production pointer-events contract the real
  // browser hit target must be the parent close button, exactly as for a user.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
});

test.afterAll(() => {
  server?.kill();
});

test('cloud login modal closes when the decorative close glyph is clicked', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /클라우드 로그인/ }).click();

  const modal = page.locator('#cloud-modal');
  await expect(modal).not.toHaveClass(/\bhidden\b/);
  await clickDecorativeCloseGlyph(page, modal);
  await expect(modal).toHaveClass(/\bhidden\b/);
});

test('team modal closes when the decorative close glyph is clicked', async ({ page }) => {
  const email = `close-target-${Date.now()}@scopeweave.test`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'password123', name: 'Close Target' },
  });
  const project = await api('/api/projects', {
    method: 'POST',
    token: signup.token,
    body: { name: 'Close target project' },
  });

  await page.goto(`${BASE}/`);
  await page.evaluate(([token, projectId]) => {
    localStorage.setItem('scopeweave:token', token);
    localStorage.setItem('scopeweave:project', String(projectId));
  }, [signup.token, project.id]);
  await page.reload();
  await page.getByRole('button', { name: '팀' }).click();

  const modal = page.locator('#team-modal');
  await expect(modal).not.toHaveClass(/\bhidden\b/);
  await clickDecorativeCloseGlyph(page, modal);
  await expect(modal).toHaveClass(/\bhidden\b/);
});
