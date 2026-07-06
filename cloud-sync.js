// ScopeWeave cloud sync — an OPT-IN overlay on the offline planner.
// Logged out, every export here is a no-op and the app behaves exactly as the
// original localStorage-only planner (so existing e2e tests are unaffected).
// Logged in with a project open, edits sync to the API with optimistic
// concurrency and a project sees other tabs' changes live over SSE.

const TOKEN_KEY = 'scopeweave:token';
const PROJECT_KEY = 'scopeweave:project';

let host = null;   // { hydrateState, renderAll, getState } provided by app.js
let version = 0;   // open project's doc version (optimistic concurrency)
let sse = null;
let pushTimer = null;
let currentOrgId = null; // org of the open project, for team management

const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
const getProjectId = () => localStorage.getItem(PROJECT_KEY) || '';
const setProjectId = (id) => (id ? localStorage.setItem(PROJECT_KEY, String(id)) : localStorage.removeItem(PROJECT_KEY));
const isAuthed = () => Boolean(getToken());

function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('visible'), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { setToken(''); setProjectId(''); renderAuthUI(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---- realtime (EventSource can't set headers → token via query; ceiling:
// swap for a short-lived stream token before prod so JWTs stay out of URLs)
function subscribe(id) {
  if (sse) { sse.close(); sse = null; }
  sse = new EventSource(`/api/projects/${id}/stream?token=${encodeURIComponent(getToken())}`);
  sse.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'update' && typeof msg.version === 'number' && msg.version > version) {
      openProject(id, { silent: true }).then(() => toast('실시간 업데이트를 반영했습니다.')).catch(() => {});
    }
  };
}

async function openProject(id, { silent = false } = {}) {
  const p = await api(`/api/projects/${id}`);
  setProjectId(id);
  const meta = projectsCache.find((x) => String(x.id) === String(id));
  if (meta) currentOrgId = meta.orgId;
  version = p.version;
  host?.hydrateState({ projectName: p.name, baseDate: p.baseDate, tasks: p.tasks });
  host?.renderAll();
  subscribe(id);
  renderAuthUI();
  if (!silent) toast(`'${p.name}' 프로젝트를 열었습니다.`);
}

async function doPush(payload) {
  try {
    const r = await api(`/api/projects/${getProjectId()}`, {
      method: 'PUT',
      body: { name: payload.projectName, baseDate: payload.baseDate, tasks: payload.tasks, version },
    });
    version = r.version;
  } catch (e) {
    if (e.status === 409) {
      await openProject(getProjectId(), { silent: true }).catch(() => {});
      toast('다른 사용자가 먼저 저장하여 최신본을 불러왔습니다.');
    } else if (e.message !== 'unauthorized') {
      toast('클라우드 저장 실패 — 로컬에는 저장되었습니다.');
    }
  }
}

// ---------------------------------------------------------------- public API
export const cloud = {
  init(hostApi) {
    host = hostApi;
    ensureAuthUI();
    renderAuthUI();
    if (isAuthed()) refreshProjects().then(renderAuthUI).catch(() => {});
  },
  // Returns the saved project state to hydrate, or null (→ local/seed path).
  async boot() {
    if (!isAuthed() || !getProjectId()) { renderAuthUI(); return null; }
    try {
      const p = await api(`/api/projects/${getProjectId()}`);
      version = p.version;
      subscribe(p.id);
      renderAuthUI();
      return { projectName: p.name, baseDate: p.baseDate, tasks: p.tasks };
    } catch {
      renderAuthUI();
      return null;
    }
  },
  // Called from persistState(). No-op unless logged in with a project open.
  push(payload) {
    if (!isAuthed() || !getProjectId()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(payload), 600);
  },
};

// ------------------------------------------------------------------- auth UI
function ensureAuthUI() {
  if (document.getElementById('cloud-auth')) return;
  const titleRow = document.querySelector('.title-row');
  if (!titleRow) return;
  const bar = document.createElement('div');
  bar.id = 'cloud-auth';
  bar.className = 'cloud-auth';
  titleRow.appendChild(bar);

  // modal (reuses .modal/.hidden conventions from the gantt modal)
  const modal = document.createElement('div');
  modal.id = 'cloud-modal';
  modal.className = 'modal hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'cloud-modal-title');
  modal.innerHTML = `
    <div class="modal-backdrop" data-cloud-close="true"></div>
    <div class="modal-panel cloud-panel">
      <div class="modal-header">
        <h2 id="cloud-modal-title">클라우드 로그인</h2>
        <button type="button" class="icon-button close-button" data-cloud-close="true" aria-label="닫기"><span aria-hidden="true">✕</span></button>
      </div>
      <form id="cloud-form" class="cloud-form">
        <label class="meta-field"><span>이메일</span><input id="cloud-email" type="email" autocomplete="username" required /></label>
        <label class="meta-field cloud-name-field hidden"><span>이름</span><input id="cloud-name" type="text" autocomplete="name" /></label>
        <label class="meta-field"><span>비밀번호 (8자 이상)</span><input id="cloud-password" type="password" autocomplete="current-password" minlength="8" required /></label>
        <p id="cloud-error" class="cloud-error" role="alert"></p>
        <div class="cloud-actions">
          <button type="submit" class="primary-button" id="cloud-submit">로그인</button>
          <button type="button" class="secondary-button" id="cloud-toggle">계정 만들기</button>
        </div>
        <button type="button" class="secondary-button" id="cloud-sso" style="width:100%;margin-top:8px">SSO로 로그인 (OIDC)</button>
      </form>
    </div>`;
  document.body.appendChild(modal);

  let mode = 'login';
  const $ = (id) => modal.querySelector(id);
  const setMode = (m) => {
    mode = m;
    $('#cloud-modal-title').textContent = m === 'login' ? '클라우드 로그인' : '계정 만들기';
    $('#cloud-submit').textContent = m === 'login' ? '로그인' : '가입';
    $('#cloud-toggle').textContent = m === 'login' ? '계정 만들기' : '로그인으로';
    modal.querySelector('.cloud-name-field').classList.toggle('hidden', m !== 'signup');
    $('#cloud-error').textContent = '';
  };
  $('#cloud-toggle').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
  $('#cloud-sso').addEventListener('click', () => { window.location.href = '/api/auth/oidc/start'; });
  modal.addEventListener('click', (e) => { if (e.target.dataset.cloudClose) modal.classList.add('hidden'); });
  $('#cloud-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#cloud-email').value.trim();
    const password = $('#cloud-password').value;
    const name = $('#cloud-name').value.trim();
    try {
      const r = await api(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, { method: 'POST', body: { email, password, name } });
      setToken(r.token);
      modal.classList.add('hidden');
      await refreshProjects();
      renderAuthUI();
      toast(mode === 'login' ? '로그인되었습니다.' : '가입되어 클라우드 저장이 켜졌습니다.');
    } catch (err) {
      $('#cloud-error').textContent = err.data?.error || err.message || '요청 실패';
    }
  });
  bar._openModal = () => { setMode('login'); modal.classList.remove('hidden'); $('#cloud-email').focus(); };
}

let projectsCache = [];
async function refreshProjects() {
  try { projectsCache = (await api('/api/projects')).projects || []; } catch { projectsCache = []; }
}

function renderAuthUI() {
  const bar = document.getElementById('cloud-auth');
  if (!bar) return;
  bar.textContent = '';
  if (!isAuthed()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary-button';
    btn.textContent = '☁ 클라우드 로그인';
    btn.addEventListener('click', openLoginModal);
    bar.appendChild(btn);
    return;
  }
  // logged in: onboarding (no projects yet) → sample; else project switcher.
  if (!projectsCache.length) {
    const sample = document.createElement('button');
    sample.type = 'button';
    sample.className = 'primary-button';
    sample.textContent = '✨ 샘플로 시작';
    sample.addEventListener('click', sampleStart);
    bar.appendChild(sample);
  }
  const select = document.createElement('select');
  select.className = 'cloud-select';
  select.setAttribute('aria-label', '프로젝트 선택');
  const openId = getProjectId();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = projectsCache.length ? '프로젝트 선택…' : '프로젝트 없음';
  select.appendChild(ph);
  for (const p of projectsCache) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.name; // textContent → XSS-safe
    if (String(p.id) === String(openId)) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => { if (select.value) openProject(select.value).catch((e) => toast(e.message)); });
  bar.appendChild(select);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'secondary-button';
  newBtn.textContent = '+ 새 프로젝트';
  newBtn.addEventListener('click', createProjectFlow);
  bar.appendChild(newBtn);

  const team = document.createElement('button');
  team.type = 'button';
  team.className = 'secondary-button';
  team.textContent = '팀';
  team.addEventListener('click', () => openTeamModal().catch((e) => toast(e.message || '팀 정보를 불러오지 못했습니다.')));
  bar.appendChild(team);

  if (getProjectId()) {
    const bl = document.createElement('button');
    bl.type = 'button';
    bl.className = 'secondary-button';
    bl.textContent = '기준선';
    bl.addEventListener('click', () => openBaselineModal().catch((e) => toast(e.message || '기준선을 불러오지 못했습니다.')));
    bar.appendChild(bl);
  }

  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'secondary-button';
  out.textContent = '로그아웃';
  out.addEventListener('click', () => {
    if (sse) { sse.close(); sse = null; }
    setToken(''); setProjectId(''); projectsCache = [];
    renderAuthUI();
    toast('로그아웃되었습니다. 로컬 저장으로 전환합니다.');
  });
  bar.appendChild(out);
}

function openLoginModal() {
  const modal = document.getElementById('cloud-modal');
  const bar = document.getElementById('cloud-auth');
  if (bar && bar._openModal) return bar._openModal();
  modal?.classList.remove('hidden');
}

// Create a cloud project and seed it with `seedState` (defaults to what's on
// screen). Used by both "새 프로젝트" and the "샘플로 시작" onboarding.
async function makeProject(name, seedState) {
  const r = await api('/api/projects', { method: 'POST', body: { name } });
  await refreshProjects();
  version = r.version;
  setProjectId(r.id);
  const meta = projectsCache.find((x) => String(x.id) === String(r.id));
  if (meta) currentOrgId = meta.orgId;
  const base = seedState || host?.getState?.() || { baseDate: '', tasks: [] };
  await doPush({ ...base, projectName: name }); // keep the chosen project name
  subscribe(r.id);
  renderAuthUI();
  return r;
}

async function createProjectFlow() {
  const name = prompt('새 프로젝트 이름');
  if (!name || !name.trim()) return;
  try {
    await makeProject(name.trim());
    toast(`'${name.trim()}' 프로젝트를 만들었습니다.`);
  } catch (e) {
    toast(e.message || '프로젝트 생성 실패');
  }
}

// Onboarding: a first project pre-populated from the app's source-backed seed
// (whatever app.js has loaded on screen — the wbs.json sample for a new user).
async function sampleStart() {
  try {
    await makeProject('샘플 프로젝트', host?.getState?.());
    toast('샘플 프로젝트로 시작했습니다. 자유롭게 편집하세요.');
  } catch (e) {
    toast(e.message || '샘플 프로젝트 생성 실패');
  }
}

// ------------------------------------------------------------- team / RBAC UI
const ROLE_LABELS = { owner: '소유자', admin: '관리자', member: '멤버', viewer: '뷰어' };

async function exportOrg() {
  try {
    const res = await fetch(`/api/orgs/${currentOrgId}/export`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (res.status === 403) return toast('소유자만 데이터를 내보낼 수 있습니다.');
    if (!res.ok) return toast('내보내기에 실패했습니다.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scopeweave-org-${currentOrgId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('워크스페이스 데이터를 내보냈습니다.');
  } catch {
    toast('내보내기에 실패했습니다.');
  }
}

async function resolveOrgId() {
  if (currentOrgId) return currentOrgId;
  const me = await api('/api/me');
  currentOrgId = me.orgs?.[0]?.id || null;
  return currentOrgId;
}

// ------------------------------------------------------------- baselines
// Compare the live plan against a frozen baseline: which tasks' planned dates
// slipped, and by how many days.
const dayMs = 86400000;
const slipDays = (fromDate, toDate) => {
  if (!fromDate || !toDate) return null;
  const a = new Date(fromDate), b = new Date(toDate);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / dayMs);
};

export function compareBaseline(baselineTasks, currentTasks) {
  const base = new Map((baselineTasks || []).map((t) => [t.id, t]));
  const rows = [];
  for (const cur of currentTasks || []) {
    const old = base.get(cur.id);
    if (!old) { rows.push({ id: cur.id, name: cur.name, kind: 'added', endSlip: null }); continue; }
    const endSlip = slipDays(old.plannedEndDate, cur.plannedEndDate);
    const startSlip = slipDays(old.plannedStartDate, cur.plannedStartDate);
    if ((endSlip || 0) !== 0 || (startSlip || 0) !== 0) {
      rows.push({ id: cur.id, name: cur.name, kind: 'moved', baseEnd: old.plannedEndDate || '', curEnd: cur.plannedEndDate || '', endSlip: endSlip ?? 0 });
    }
  }
  const cur = new Set((currentTasks || []).map((t) => t.id));
  for (const old of baselineTasks || []) {
    if (!cur.has(old.id)) rows.push({ id: old.id, name: old.name, kind: 'removed', endSlip: null });
  }
  const slipped = rows.filter((r) => r.kind === 'moved' && r.endSlip > 0);
  return { rows, summary: { changed: rows.length, slipped: slipped.length, maxSlip: slipped.reduce((m, r) => Math.max(m, r.endSlip), 0) } };
}

async function openBaselineModal() {
  const pid = getProjectId();
  if (!pid) return;
  let modal = document.getElementById('baseline-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'baseline-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'baseline-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#baseline-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '기준선 (Baseline)';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '기준선 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary-button';
  save.textContent = '현재 계획을 기준선으로 저장';
  save.addEventListener('click', async () => {
    const name = prompt('기준선 이름', `기준선 ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    await api(`/api/projects/${pid}/baselines`, { method: 'POST', body: { name } });
    toast('기준선을 저장했습니다.');
    openBaselineModal();
  });
  panel.appendChild(save);

  const list = document.createElement('ul');
  list.className = 'team-list';
  panel.appendChild(list);
  const result = document.createElement('div');
  result.id = 'baseline-result';
  panel.appendChild(result);

  const data = await api(`/api/projects/${pid}/baselines`);
  if (!data.baselines.length) {
    const li = document.createElement('li');
    li.textContent = '저장된 기준선이 없습니다.';
    list.appendChild(li);
    return;
  }
  for (const b of data.baselines) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    who.textContent = `${b.name} · ${String(b.createdAt).slice(0, 10)}`;
    const cmp = document.createElement('button');
    cmp.type = 'button';
    cmp.className = 'secondary-button';
    cmp.textContent = '비교';
    cmp.addEventListener('click', async () => {
      const full = await api(`/api/projects/${pid}/baselines/${b.id}`);
      renderBaselineDiff(result, compareBaseline(full.tasks, host?.getState?.()?.tasks || []));
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary-button';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      await api(`/api/projects/${pid}/baselines/${b.id}`, { method: 'DELETE' });
      openBaselineModal();
    });
    li.append(who, cmp, del);
    list.appendChild(li);
  }
}

function renderBaselineDiff(el, { rows, summary }) {
  el.textContent = '';
  const sum = document.createElement('p');
  sum.textContent = rows.length
    ? `변경 ${summary.changed}건 · 지연 ${summary.slipped}건 · 최대 지연 ${summary.maxSlip}일`
    : '기준선과 차이가 없습니다.';
  el.appendChild(sum);
  if (!rows.length) return;
  const table = document.createElement('table');
  table.className = 'wbs-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const t of ['작업', '기준 종료', '현재 종료', '차이']) {
    const th = document.createElement('th');
    th.textContent = t;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows.slice(0, 50)) {
    const tr = document.createElement('tr');
    const cells = r.kind === 'moved'
      ? [r.name, r.baseEnd, r.curEnd, `${r.endSlip > 0 ? '+' : ''}${r.endSlip}일`]
      : [r.name, '', '', r.kind === 'added' ? '신규' : '삭제됨'];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c ?? '';
      tr.appendChild(td);
    }
    if (r.kind === 'moved' && r.endSlip > 0) tr.style.color = 'var(--delay, #ea580c)';
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  const wrap = document.createElement('div');
  wrap.style.overflowX = 'auto';
  wrap.appendChild(table);
  el.appendChild(wrap);
}

async function openTeamModal() {
  const orgId = await resolveOrgId();
  if (!orgId) return toast('워크스페이스를 찾을 수 없습니다.');
  let modal = document.getElementById('team-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'team-modal';
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-backdrop" data-team-close="true"></div>
      <div class="modal-panel cloud-panel">
        <div class="modal-header">
          <h2>팀 멤버</h2>
          <button type="button" class="icon-button close-button" data-team-close="true" aria-label="닫기"><span aria-hidden="true">✕</span></button>
        </div>
        <div id="team-body" class="team-body"></div>
        <form id="team-invite" class="team-invite">
          <input id="team-email" type="email" placeholder="초대할 이메일" required />
          <select id="team-role" class="cloud-select">
            <option value="member">멤버</option>
            <option value="admin">관리자</option>
            <option value="viewer">뷰어</option>
          </select>
          <button type="submit" class="primary-button">초대</button>
        </form>
        <p id="team-msg" class="cloud-error"></p>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.dataset.teamClose) modal.classList.add('hidden'); });
    modal.querySelector('#team-invite').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = modal.querySelector('#team-email').value.trim();
      const role = modal.querySelector('#team-role').value;
      try {
        const inv = await api(`/api/orgs/${currentOrgId}/invites`, { method: 'POST', body: { email, role } });
        const link = `${location.origin}/?invite=${inv.token}`;
        modal.querySelector('#team-msg').textContent = `초대 링크: ${link}`;
        modal.querySelector('#team-email').value = '';
        await renderTeam();
      } catch (err) {
        modal.querySelector('#team-msg').textContent = err.data?.error || err.message;
      }
    });
  }
  modal.classList.remove('hidden');
  await renderTeam();
}

async function renderTeam() {
  const body = document.getElementById('team-body');
  if (!body) return;
  const data = await api(`/api/orgs/${currentOrgId}/members`);
  body.textContent = '';

  // plan + usage indicator
  try {
    const b = await api(`/api/orgs/${currentOrgId}/billing`);
    const bar = document.createElement('div');
    bar.className = 'billing-bar';
    const cap = (used, limit) => `${used}/${limit == null ? '∞' : limit}`;
    const info = document.createElement('span');
    info.textContent = `${b.planName} · 프로젝트 ${cap(b.usage.projects, b.limits.projects)} · 멤버 ${cap(b.usage.members, b.limits.members)}`;
    bar.appendChild(info);
    if (b.plan === 'free') {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'primary-button billing-upgrade';
      up.textContent = 'Pro 업그레이드';
      up.addEventListener('click', async () => {
        try {
          const s = await api(`/api/orgs/${currentOrgId}/checkout`, { method: 'POST' });
          if (s.mock) toast('결제 연동(Stripe 키)이 필요합니다 — 데모 환경입니다.');
          else window.location.href = s.url;
        } catch (e) { toast(e.data?.error || e.message); }
      });
      bar.appendChild(up);
    }
    body.appendChild(bar);
  } catch { /* billing optional */ }
  const list = document.createElement('ul');
  list.className = 'team-list';
  for (const m of data.members) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    who.textContent = m.email;
    li.appendChild(who);
    if (m.role === 'owner') {
      const tag = document.createElement('span');
      tag.className = 'team-role-tag';
      tag.textContent = ROLE_LABELS.owner;
      li.appendChild(tag);
    } else {
      const sel = document.createElement('select');
      sel.className = 'cloud-select';
      for (const role of ['admin', 'member', 'viewer']) {
        const opt = document.createElement('option');
        opt.value = role; opt.textContent = ROLE_LABELS[role];
        if (role === m.role) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () =>
        api(`/api/orgs/${currentOrgId}/members/${m.id}`, { method: 'PATCH', body: { role: sel.value } })
          .then(() => toast(`${m.email} → ${ROLE_LABELS[sel.value]}`)).catch((e) => toast(e.message)));
      li.appendChild(sel);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary-button team-remove';
      del.textContent = '제거';
      del.addEventListener('click', () =>
        api(`/api/orgs/${currentOrgId}/members/${m.id}`, { method: 'DELETE' })
          .then(() => { toast(`${m.email} 제거됨`); renderTeam(); }).catch((e) => toast(e.message)));
      li.appendChild(del);
    }
    list.appendChild(li);
  }
  body.appendChild(list);
  if (data.invites?.length) {
    const pending = document.createElement('p');
    pending.className = 'team-pending';
    pending.textContent = `대기 중인 초대: ${data.invites.map((i) => i.email).join(', ')}`;
    body.appendChild(pending);
  }

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'secondary-button';
  exportBtn.textContent = '데이터 내보내기 (JSON)';
  exportBtn.style.marginTop = '8px';
  exportBtn.addEventListener('click', exportOrg);
  body.appendChild(exportBtn);

  await renderTokens(body);
  await renderWebhooks(body);
  await renderAudit(body);
  renderAccount(body);
}

// Account settings — change password / delete account.
function renderAccount(body) {
  const section = document.createElement('div');
  section.className = 'token-section';
  const h = document.createElement('h3');
  h.className = 'token-heading';
  h.textContent = '계정';
  section.appendChild(h);

  const form = document.createElement('form');
  form.className = 'cloud-form';
  const oldPw = document.createElement('input');
  oldPw.type = 'password'; oldPw.placeholder = '현재 비밀번호'; oldPw.autocomplete = 'current-password';
  const newPw = document.createElement('input');
  newPw.type = 'password'; newPw.placeholder = '새 비밀번호 (8자 이상)'; newPw.minLength = 8; newPw.autocomplete = 'new-password';
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'secondary-button'; save.textContent = '비밀번호 변경';
  form.append(oldPw, newPw, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: oldPw.value, newPassword: newPw.value } });
      oldPw.value = ''; newPw.value = '';
      toast('비밀번호를 변경했습니다.');
    } catch (err) { toast(err.data?.error || err.message); }
  });
  section.appendChild(form);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'secondary-button';
  del.style.color = 'var(--danger)';
  del.style.marginTop = '8px';
  del.textContent = '계정 삭제';
  del.addEventListener('click', async () => {
    const pw = prompt('계정과 소유한 워크스페이스가 영구 삭제됩니다. 확인하려면 비밀번호를 입력하세요.');
    if (!pw) return;
    try {
      await api('/api/account', { method: 'DELETE', body: { password: pw } });
      setToken(''); setProjectId('');
      document.getElementById('team-modal')?.classList.add('hidden');
      renderAuthUI();
      toast('계정을 삭제했습니다.');
    } catch (err) { toast(err.data?.error || err.message); }
  });
  section.appendChild(del);
  body.appendChild(section);
}

// Outbound webhooks — owner/admin. Secret shown once at creation.
async function renderWebhooks(body) {
  let data;
  try { data = await api(`/api/orgs/${currentOrgId}/webhooks`); } catch { return; }
  const section = document.createElement('div');
  section.className = 'token-section';
  const h = document.createElement('h3');
  h.className = 'token-heading';
  h.textContent = '웹훅';
  section.appendChild(h);
  const list = document.createElement('ul');
  list.className = 'team-list';
  for (const w of data.webhooks) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    const status = w.lastOk == null ? '' : (w.lastOk ? ' · 최근 ✓' : ' · 최근 ✗ 실패');
    who.textContent = `${w.url} · ${w.events}${status}`;
    li.appendChild(who);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary-button team-remove';
    del.textContent = '삭제';
    del.addEventListener('click', () =>
      api(`/api/orgs/${currentOrgId}/webhooks/${w.id}`, { method: 'DELETE' }).then(() => { toast('웹훅을 삭제했습니다.'); renderTeam(); }).catch((e) => toast(e.message)));
    li.appendChild(del);
    list.appendChild(li);
  }
  section.appendChild(list);
  const form = document.createElement('form');
  form.className = 'team-invite';
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://example.com/webhook';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'primary-button';
  btn.textContent = '웹훅 추가';
  form.append(input, btn);
  const secret = document.createElement('p');
  secret.className = 'token-secret';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const w = await api(`/api/orgs/${currentOrgId}/webhooks`, { method: 'POST', body: { url: input.value.trim(), events: '*' } });
      secret.textContent = `서명 시크릿(한 번만 표시): ${w.secret}`;
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      who.textContent = `${w.url} · ${w.events}`;
      li.appendChild(who);
      list.appendChild(li);
      input.value = '';
    } catch (err) { toast(err.data?.error || err.message); }
  });
  section.appendChild(form);
  section.appendChild(secret);
  body.appendChild(section);
}

const AUDIT_LABELS = {
  'project.create': '프로젝트 생성', 'project.update': '프로젝트 저장',
  'member.invite': '멤버 초대', 'member.join': '멤버 합류',
  'member.role_change': '역할 변경', 'member.remove': '멤버 제거',
  'billing.upgrade': '플랜 업그레이드',
};

// Recent activity (owner/admin only; endpoint 403s otherwise → section hidden).
async function renderAudit(body) {
  let data;
  try { data = await api(`/api/orgs/${currentOrgId}/audit?limit=12`); } catch { return; }
  if (!data.events?.length) return;
  const section = document.createElement('div');
  section.className = 'token-section';
  const h = document.createElement('h3');
  h.className = 'token-heading';
  h.textContent = '감사 로그';
  section.appendChild(h);
  const list = document.createElement('ul');
  list.className = 'audit-list';
  for (const e of data.events) {
    const li = document.createElement('li');
    const label = AUDIT_LABELS[e.action] || e.action;
    const who = e.actorEmail || '시스템';
    const when = (e.createdAt || '').replace('T', ' ').slice(0, 16);
    li.textContent = `${when} · ${who} · ${label}`;
    list.appendChild(li);
  }
  section.appendChild(list);
  body.appendChild(section);
}

// Personal Access Tokens — create/list/revoke, secret shown once.
async function renderTokens(body) {
  const section = document.createElement('div');
  section.className = 'token-section';
  const h = document.createElement('h3');
  h.className = 'token-heading';
  h.textContent = 'API 토큰';
  section.appendChild(h);

  let data;
  try { data = await api('/api/tokens'); } catch { return; }
  const list = document.createElement('ul');
  list.className = 'team-list';
  for (const t of data.tokens) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    who.textContent = `${t.name} · ${t.prefix}… ${t.lastUsed ? '· 최근 사용 ' + t.lastUsed.slice(0, 10) : '· 미사용'}`;
    li.appendChild(who);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary-button team-remove';
    del.textContent = '폐기';
    del.addEventListener('click', () =>
      api(`/api/tokens/${t.id}`, { method: 'DELETE' }).then(() => { toast('토큰을 폐기했습니다.'); renderTeam(); }).catch((e) => toast(e.message)));
    li.appendChild(del);
    list.appendChild(li);
  }
  section.appendChild(list);

  const form = document.createElement('form');
  form.className = 'team-invite';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '토큰 이름 (예: CI, Zapier)';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'primary-button';
  btn.textContent = '토큰 생성';
  form.append(input, btn);
  const secret = document.createElement('p');
  secret.className = 'token-secret';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const t = await api('/api/tokens', { method: 'POST', body: { name: input.value.trim() || 'token' } });
      secret.textContent = `한 번만 표시됩니다 — 지금 복사하세요: ${t.token}`;
      input.value = '';
      // append the new token to the list without wiping the shown secret
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      who.textContent = `${t.name} · ${t.prefix}… · 미사용`;
      li.appendChild(who);
      list.appendChild(li);
    } catch (err) { toast(err.data?.error || err.message); }
  });
  section.appendChild(form);
  section.appendChild(secret);
  body.appendChild(section);
}

// SSO (OIDC) redirect: the token arrives in the URL fragment (not query → not
// logged). Store it and clean the URL before anything else reads auth state.
if (typeof window !== 'undefined' && location.hash.startsWith('#token=')) {
  const t = decodeURIComponent(location.hash.slice('#token='.length));
  if (t) {
    setToken(t);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// Auto-accept an invite token from the URL (?invite=...) once logged in.
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(location.search);
  const inviteToken = params.get('invite');
  if (inviteToken && getToken()) {
    api(`/api/invites/${inviteToken}/accept`, { method: 'POST' })
      .then((res) => { currentOrgId = res.orgId; refreshProjects().then(renderAuthUI); toast('초대를 수락했습니다.'); })
      .catch(() => {});
  }
}

// Bridge onto window so app.js (a plain, non-import script) can reach us
// without an ESM import statement — keeps app.js eval-safe for unit tests.
if (typeof window !== 'undefined') {
  window.ScopeWeaveCloud = cloud;
}
