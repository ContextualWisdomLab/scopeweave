import { test, expect } from './coverage-test.js';

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installCloudApi(page, { role = 'member', checkoutUrl = null } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('scopeweave:token', 'coverage-token');
    localStorage.removeItem('scopeweave:project');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname}${url.search}`;
    const method = request.method();

    if (method === 'GET' && path === '/api/projects') return json(route, { projects: [] });
    if (method === 'GET' && path === '/api/notifications') return json(route, { notifications: [] });
    if (method === 'GET' && path === '/api/me') {
      return json(route, { orgs: [{ id: 7, role }] });
    }
    if (method === 'GET' && path === '/api/orgs/7/members') {
      return json(route, { members: [{ id: 11, email: 'member@example.com', role }], invites: [] });
    }
    if (method === 'GET' && path === '/api/orgs/7/billing') {
      return json(route, {
        plan: 'free',
        planName: 'Free',
        usage: { projects: 0, members: 1 },
        limits: { projects: 1, members: 3 },
      });
    }
    if (method === 'GET' && path === '/api/tokens') return json(route, { tokens: [] });
    if (method === 'GET' && path === '/api/orgs/7/webhooks') return json(route, { webhooks: [] });
    if (method === 'GET' && path.startsWith('/api/orgs/7/audit')) return json(route, { events: [] });
    if (method === 'POST' && path === '/api/orgs/7/invites') {
      return json(route, { error: '이미 멤버이거나 초대된 사용자입니다.' }, 409);
    }
    if (method === 'POST' && path === '/api/orgs/7/leave') return json(route, { ok: true });
    if (method === 'POST' && path === '/api/orgs/7/checkout' && checkoutUrl) {
      return json(route, { mock: false, url: checkoutUrl });
    }
    return json(route, {});
  });
}

test('failed file-picker writes never retain false auto-save authority', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => {
          throw new DOMException('write denied', 'NotAllowedError');
        },
      }),
    });
  });

  await page.goto('/');
  const connect = page.getByRole('button', { name: 'wbs.json 자동저장 연결' });
  await expect(connect).not.toHaveAttribute('aria-disabled', 'true');
  await connect.click();

  await expect(page.locator('#toast')).toContainText('wbs.json 연결에 실패했습니다.');
  await expect(page.locator('#sync-status')).toHaveText('브라우저 로컬 자동저장 사용 중');

  // Force a later normal render. A failed candidate must not linger in state and
  // become false connected authority after the original error path completes.
  const projectName = page.locator('#project-name');
  await projectName.fill('Picker failure regression');
  await projectName.blur();
  await expect(page.locator('#sync-status')).toHaveText('브라우저 로컬 자동저장 사용 중');
});

test('invalid file-picker return shapes fail closed without claiming sync authority', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => null,
    });
  });

  await page.goto('/');
  const connect = page.getByRole('button', { name: 'wbs.json 자동저장 연결' });
  await connect.click();
  await expect(page.locator('#toast')).toContainText('wbs.json 연결에 실패했습니다.');
  await expect(page.locator('#sync-status')).toHaveText('브라우저 로컬 자동저장 사용 중');

  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({}),
    });
  });
  await connect.click();
  await expect(page.locator('#toast')).toContainText('wbs.json 연결에 실패했습니다.');
  await expect(page.locator('#sync-status')).toHaveText('브라우저 로컬 자동저장 사용 중');
});

test('inline progress keeps keyboard focus after the row is re-rendered', async ({ page }) => {
  await page.goto('/');
  const progress = page.locator('select[data-inline-progress]').first();
  await expect(progress).toBeVisible();
  await progress.focus();
  await progress.selectOption('진행(30%)');

  const taskId = await progress.getAttribute('data-inline-progress');
  const replacement = page.locator(`select[data-inline-progress="${taskId}"]`);
  await expect(replacement).toHaveValue('진행(30%)');
  await expect(replacement).toBeFocused();
});

test('cloud bootstrap remains usable when an optional host-init hook is absent', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ScopeWeaveCloud', {
      configurable: true,
      set(value) {
        delete value.init;
        Object.defineProperty(window, 'ScopeWeaveCloud', {
          configurable: true,
          writable: true,
          value,
        });
      },
    });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '최상위 작업 추가' })).toBeVisible();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
});

test('editor validation tolerates a future field label without losing the form', async ({ page }) => {
  await page.goto('/');
  const edit = page.locator('button[data-action="edit"]').first();
  await expect(edit).toBeVisible();
  await edit.click();

  await page.evaluate(() => {
    const form = document.querySelector('form[data-editor-form="true"]');
    const input = document.createElement('input');
    input.dataset.editorField = 'futureField';
    input.value = 'future value';
    input.id = 'future-editor-field';
    form.appendChild(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const future = page.locator('#future-editor-field');
  await expect(future).toBeVisible();
  await expect(future).not.toHaveAttribute('aria-invalid', 'true');
});

test('editor validation ignores a malformed unlabeled extension field while reporting real errors', async ({ page }) => {
  await page.goto('/');
  const edit = page.locator('button[data-action="edit"]').first();
  await edit.click();

  await page.locator('[data-testid="editor-planned-start"]').fill('2026-12-31');
  await page.locator('[data-testid="editor-planned-end"]').fill('2026-01-01');
  await page.evaluate(() => {
    const form = document.querySelector('form[data-editor-form="true"]');
    const input = document.createElement('input');
    input.setAttribute('data-editor-field', '');
    input.id = 'unlabeled-extension-field';
    form.appendChild(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('#editor-errors')).toContainText('계획종료일은 계획시작일보다 빠를 수 없습니다.');
  await expect(page.locator('#unlabeled-extension-field')).not.toHaveAttribute('aria-invalid', 'true');
});

test('team recovery resolves tenant authority, reports invite rejection, and lets a member leave', async ({ page }) => {
  await installCloudApi(page, { role: 'member' });
  await page.goto('/');

  await page.getByRole('button', { name: '팀' }).click();
  const team = page.locator('#team-modal');
  await expect(team).not.toHaveClass(/hidden/);

  await team.locator('#team-email').fill('member@example.com');
  await team.getByRole('button', { name: '초대' }).click();
  await expect(team.locator('#team-msg')).toHaveText('이미 멤버이거나 초대된 사용자입니다.');

  page.once('dialog', (dialog) => dialog.accept());
  await team.getByRole('button', { name: '워크스페이스 나가기' }).click();
  await expect(team).toHaveClass(/hidden/);
  await expect(page.locator('#toast')).toContainText('워크스페이스에서 나왔습니다.');
});

test('paid checkout redirects through the server-provided hosted destination', async ({ page }) => {
  await installCloudApi(page, { role: 'owner', checkoutUrl: '/checkout-target' });
  await page.route('**/checkout-target', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Checkout target</title>',
  }));
  await page.goto('/');

  await page.getByRole('button', { name: '팀' }).click();
  await expect(page.locator('#team-modal')).not.toHaveClass(/hidden/);

  await Promise.all([
    page.waitForURL('**/checkout-target'),
    page.getByRole('button', { name: 'Pro 업그레이드' }).click(),
  ]);
  await expect(page).toHaveURL(/\/checkout-target$/);
});
