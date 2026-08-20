import { test, expect } from './coverage-test.js';

const STATIC_BASE = 'http://127.0.0.1:4173';
const TOKEN = 'coverage-token';
const SHARE_TOKEN = 'abcdefghijklmnop';
const INVITE_TOKEN = 'ponmlkjihgfedcba';

function project(id = 1, name = 'Coverage Project') {
  return {
    id,
    name,
    baseDate: '2026-08-20',
    version: 1,
    orgId: 7,
    archived: false,
    methodology: 'waterfall',
    tasks: [{
      id: 'task-1',
      name: 'Coverage task',
      phase: 'Coverage task',
      depth: 1,
      plannedStartDate: '2026-08-20',
      plannedEndDate: '2026-08-22',
      plannedProgress: 50,
      actualProgress: 20,
      sprint: 'Coverage Sprint',
      storyPoints: 5,
    }],
  };
}

async function primeAuth(page, { projectId = '1', token = TOKEN } = {}) {
  await page.addInitScript(({ authToken, selectedProject }) => {
    localStorage.clear();
    localStorage.setItem('scopeweave:token', authToken);
    if (selectedProject) localStorage.setItem('scopeweave:project', selectedProject);
  }, { authToken: token, selectedProject: projectId });
}

async function installApiMock(page, options = {}) {
  const state = {
    projects: options.projects ?? [project()],
    sprintRows: options.sprintRows ?? [{
      id: 31,
      name: 'Coverage Sprint',
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      goal: 'Exercise delete boundary',
    }],
    attachments: options.attachments ?? [{
      id: 41,
      name: 'buyer-proof.pdf',
      taskId: 'task-1',
      status: 'SUCCEEDED',
    }],
    portfolioProjects: options.portfolioProjects ?? [],
    revisions: options.revisions ?? [{ version: 1, savedAt: '2026-08-20T01:02:03Z', savedBy: 'owner@example.com' }],
    createProjectFail: Boolean(options.createProjectFail),
    exportMode: 'ok',
    log: [],
  };

  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    state.log.push(`${method} ${path}${url.search}`);

    if (path.endsWith('/stream')) return route.fulfill({ status: 204, body: '' });
    if (path === '/api/projects' && method === 'GET') {
      return json(route, { projects: state.projects.map(({ tasks, ...meta }) => meta) });
    }
    if (path === '/api/projects' && method === 'POST') {
      if (state.createProjectFail) return json(route, { error: 'project creation denied' }, 503);
      const created = project(9, 'Created Project');
      state.projects.push(created);
      return json(route, { id: created.id, name: created.name, version: created.version });
    }
    if (path === '/api/notifications') return json(route, { notifications: [] });
    if (/^\/api\/projects\/\d+$/.test(path) && method === 'GET') {
      const id = Number(path.split('/').at(-1));
      return json(route, state.projects.find((item) => Number(item.id) === id) || project(id, `Project ${id}`));
    }
    if (/^\/api\/projects\/\d+$/.test(path) && method === 'PUT') return json(route, { version: 2 });
    if (/^\/api\/projects\/\d+\/seen$/.test(path)) return json(route, { ok: true });
    if (/^\/api\/projects\/\d+\/duplicate$/.test(path) && method === 'POST') {
      const created = project(2, 'Duplicated buyer plan');
      state.projects.push(created);
      return json(route, { id: created.id, name: created.name, version: created.version });
    }
    if (/^\/api\/projects\/\d+\/ai\/brief$/.test(path)) return json(route, { analysis: 'Buyer-ready bounded analysis' });
    if (/^\/api\/projects\/\d+\/sprints$/.test(path) && method === 'GET') {
      return json(route, { sprints: state.sprintRows, methodology: 'waterfall' });
    }
    if (/^\/api\/projects\/\d+\/sprints\/\d+$/.test(path) && method === 'DELETE') {
      state.sprintRows = [];
      return json(route, { ok: true });
    }
    if (/^\/api\/projects\/\d+\/attachments$/.test(path) && method === 'GET') return json(route, { attachments: state.attachments });
    if (/^\/api\/projects\/\d+\/calendar\.ics$/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'text/calendar', body: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n' });
    }
    if (/^\/api\/projects\/\d+\/revisions$/.test(path)) return json(route, { revisions: state.revisions });
    if (/^\/api\/projects\/\d+\/revisions\/\d+\/restore$/.test(path) && method === 'POST') return json(route, { version: 2 });
    if (/^\/api\/projects\/\d+\/revisions\/\d+$/.test(path)) {
      return json(route, { tasks: [{ ...project().tasks[0], plannedEndDate: '2026-08-25' }] });
    }
    if (/^\/api\/projects\/\d+\/baselines$/.test(path)) return json(route, { baselines: [] });
    if (path === '/api/orgs/7/portfolio') return json(route, { projects: state.portfolioProjects });
    if (path === '/api/orgs/7/members') {
      return json(route, {
        members: [
          { id: 70, email: 'owner@example.com', role: 'owner' },
          { id: 71, email: 'member@example.com', role: 'member' },
        ],
        invites: [],
      });
    }
    if (path === '/api/me') return json(route, { orgs: [{ id: 7, role: 'owner' }] });
    if (path === '/api/orgs/7/billing') {
      return json(route, {
        plan: 'free',
        planName: 'Free',
        usage: { projects: state.projects.length, members: 2 },
        limits: { projects: 3, members: 5 },
      });
    }
    if (path === '/api/tokens' && method === 'GET') return json(route, { tokens: [] });
    if (path === '/api/orgs/7/webhooks' && method === 'GET') return json(route, { webhooks: [] });
    if (path === '/api/orgs/7/audit') return json(route, { events: [] });
    if (path === '/api/orgs/7/invites' && method === 'POST') return json(route, { token: INVITE_TOKEN });
    if (path === '/api/orgs/7' && method === 'PATCH') return json(route, { ok: true });
    if (path === '/api/orgs/7/transfer' && method === 'POST') return json(route, { ok: true });
    if (path === '/api/orgs/7/checkout' && method === 'POST') return json(route, { mock: false, url: '/checkout-target' });
    if (path === '/api/orgs/7/export') {
      if (state.exportMode === 'abort') return route.abort('failed');
      if (state.exportMode === 'forbidden') return json(route, { error: 'owner only' }, 403);
      if (state.exportMode === 'error') return json(route, { error: 'temporary export failure' }, 500);
      return json(route, { projects: [] });
    }
    if (/^\/api\/invites\/[A-Za-z0-9_-]+\/accept$/.test(path) && method === 'POST') return json(route, { orgId: 7 });
    return json(route, { error: `unhandled mock route: ${method} ${path}` }, 404);
  });
  return state;
}

test('offline bootstrap remains functional when the optional cloud bridge is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    Object.defineProperty(window, 'ScopeWeaveCloud', {
      configurable: true,
      get: () => undefined,
      set: () => {},
    });
  });
  await page.goto(`${STATIC_BASE}/`);
  await expect(page.locator('#task-table-body tr').first()).toBeVisible();
  await expect(page.locator('#cloud-auth')).toHaveCount(0);
});

test('cloud API path validation fails closed before a tampered project id can escape /api', async ({ page }) => {
  await primeAuth(page, { projectId: '../../outside-api' });
  const state = await installApiMock(page);
  await page.goto(`${STATIC_BASE}/`);
  await expect(page.locator('#task-table-body tr').first()).toBeVisible();
  expect(state.log.some((entry) => entry.includes('/outside-api'))).toBeFalsy();
});

test('public share boot hydrates the planner and exposes an explicit read-only state', async ({ page }) => {
  await page.route(`**/api/shared/${SHARE_TOKEN}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(project(1, 'Shared acquisition plan')),
  }));
  await page.goto(`${STATIC_BASE}/?share=${SHARE_TOKEN}`);
  await expect(page.locator('#cloud-auth .team-role-tag')).toHaveText('읽기 전용 공유 보기');
  await expect(page.locator('#project-name')).toHaveValue('Shared acquisition plan');
  await expect(page.locator('#cloud-auth button')).toHaveCount(0);
});

test('commercial cloud controls execute success, denial, recovery, and empty-state boundaries', async ({ page }) => {
  await primeAuth(page);
  await page.addInitScript(() => {
    window.__scopeweaveOpened = null;
    window.open = (...args) => { window.__scopeweaveOpened = args; return null; };
  });
  const state = await installApiMock(page);
  await page.goto(`${STATIC_BASE}/`);
  await page.waitForSelector('#cloud-auth select');

  await page.click('#cloud-auth button:has-text("주간보고")');
  await page.click('#report-panel button:has-text("AI 요약")');
  await expect(page.locator('#report-ai')).toContainText('Buyer-ready bounded analysis');
  await page.click('#report-panel button[aria-label="주간보고 닫기"]');

  await page.click('#cloud-auth button:has-text("스프린트")');
  await expect(page.locator('#sprint-panel .team-list')).toContainText('Coverage Sprint');
  await page.click('#sprint-panel button:has-text("삭제")');
  await expect(page.locator('#sprint-panel .team-list')).toContainText('스프린트가 없습니다.');
  await page.click('#sprint-panel button[aria-label="스프린트 닫기"]');

  await page.click('#cloud-auth button:has-text("산출물")');
  await page.click('#attachments-panel button:has-text("보기")');
  await expect.poll(() => page.evaluate(() => window.__scopeweaveOpened?.[0] || '')).toContain('/attachments/41/view?token=');
  await page.click('#attachments-panel button[aria-label="산출물 닫기"]');

  await page.click('#cloud-auth button:has-text("대시보드")');
  await expect(page.locator('#portfolio-panel')).toContainText('프로젝트가 없습니다.');
  await page.click('#portfolio-panel button[aria-label="대시보드 닫기"]');
  state.portfolioProjects = [{
    id: 1,
    name: 'Coverage Project',
    tasks: 1,
    planned: 50,
    actual: 20,
    spi: 0.4,
    status: 'delay',
    label: '지연',
    overdue: 1,
    archived: false,
  }];
  await page.click('#cloud-auth button:has-text("대시보드")');
  await page.click('#portfolio-panel button:has-text("열기")');
  await expect(page.locator('#toast')).toContainText('프로젝트를 열었습니다');

  await page.click('#cloud-auth button:has-text("기준선")');
  await expect(page.locator('#baseline-panel')).toContainText('v1');
  const revisionItem = page.locator('#baseline-panel .team-list li').filter({ hasText: 'v1' }).first();
  await revisionItem.getByRole('button', { name: '비교' }).click();
  await expect(page.locator('#baseline-result')).not.toBeEmpty();
  page.once('dialog', (dialog) => dialog.accept());
  await revisionItem.getByRole('button', { name: '복원' }).click();
  await expect(page.locator('#toast')).toContainText('복원했습니다');

  state.revisions = [];
  await page.click('#cloud-auth button:has-text("기준선")');
  await expect(page.locator('#baseline-panel')).toContainText('저장 이력이 없습니다.');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#baseline-panel button:has-text("캘린더 내보내기")');
  const calendarDownload = await downloadPromise;
  expect(calendarDownload.suggestedFilename()).toBe('scopeweave-1.ics');
  await page.click('#baseline-panel button[aria-label="기준선 닫기"]');

  await page.click('#cloud-auth button:has-text("팀")');
  await page.fill('#team-email', 'new-member@example.com');
  await page.selectOption('#team-role', 'viewer');
  await page.click('#team-invite button:has-text("초대")');
  await expect(page.locator('#team-msg')).toContainText(`?invite=${INVITE_TOKEN}`);

  page.once('dialog', (dialog) => dialog.accept('Renamed Workspace'));
  await page.click('#team-body button:has-text("워크스페이스 이름 변경")');
  await expect(page.locator('#toast')).toContainText('이름을 변경했습니다');
  await expect(page.locator('#team-body li').filter({ hasText: 'member@example.com' })).toHaveCount(1);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#team-body li').filter({ hasText: 'member@example.com' }).getByRole('button', { name: '소유권 이전' }).click();
  await expect(page.locator('#toast')).toContainText('소유권을 이전했습니다');

  state.exportMode = 'forbidden';
  await page.click('#team-body button:has-text("데이터 내보내기")');
  await expect(page.locator('#toast')).toContainText('소유자만 데이터를 내보낼 수 있습니다');
  state.exportMode = 'error';
  await page.click('#team-body button:has-text("데이터 내보내기")');
  await expect(page.locator('#toast')).toContainText('내보내기에 실패했습니다');
  state.exportMode = 'abort';
  await page.click('#team-body button:has-text("데이터 내보내기")');
  await expect(page.locator('#toast')).toContainText('내보내기에 실패했습니다');

  await page.locator('#team-modal button[data-team-close="true"]').click();
  state.createProjectFail = true;
  page.once('dialog', (dialog) => dialog.accept('Rejected Project'));
  await page.click('#cloud-auth button:has-text("+ 새 프로젝트")');
  await expect(page.locator('#toast')).toContainText('project creation denied');
  state.createProjectFail = false;

  page.once('dialog', (dialog) => dialog.accept('Duplicated buyer plan'));
  await page.click('#cloud-auth button:has-text("복제")');
  await expect(page.locator('#project-name')).toHaveValue('Duplicated buyer plan');
});

test('first-project onboarding surfaces a failed sample creation without corrupting local planning', async ({ page }) => {
  await primeAuth(page, { projectId: '' });
  await installApiMock(page, { projects: [], createProjectFail: true });
  await page.goto(`${STATIC_BASE}/`);
  await page.waitForSelector('#cloud-auth button:has-text("샘플로 시작")');
  await page.click('#cloud-auth button:has-text("샘플로 시작")');
  await expect(page.locator('#toast')).toContainText('project creation denied');
  await expect(page.locator('#task-table-body tr').first()).toBeVisible();
});

test('parser rejects malformed tag candidates without losing later valid MSP tasks', async ({ page }) => {
  await page.goto(`${STATIC_BASE}/`);
  const parsed = await page.evaluate(async () => {
    const { parseMsProjectXml } = await import('/cloud-sync.js');
    return parseMsProjectXml(`
      <Project><Tasks>
        <TaskX><UID>999</UID></TaskX>
        <Task attr="not-supported"><UID>998</UID></Task>
        <Task \t\r\n><UID>7</UID><Name>A &amp; B</Name><OutlineLevel>1</OutlineLevel>
          <Start>2026-08-20T09:00:00</Start><Finish>2026-08-21T18:00:00</Finish>
          <PredecessorLink><PredecessorUID>6</PredecessorUID></PredecessorLink>
        </Task>
      </Tasks></Project>`);
  });
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ id: 'msp-7', name: 'A & B', predecessors: 'msp-6' });
});

test('SSO fragment cleanup and invite acceptance execute on the instrumented primary page', async ({ page }) => {
  await installApiMock(page, { projects: [] });
  await page.goto(`${STATIC_BASE}/?invite=${INVITE_TOKEN}#token=${encodeURIComponent(TOKEN)}`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('scopeweave:token'))).toBe(TOKEN);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('scopeweave:project'))).toBe(null);
  await expect(page.locator('#toast')).toContainText('초대를 수락했습니다');
});
