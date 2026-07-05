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
  // logged in: project switcher + new + logout
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

async function createProjectFlow() {
  const name = prompt('새 프로젝트 이름');
  if (!name || !name.trim()) return;
  try {
    const r = await api('/api/projects', { method: 'POST', body: { name: name.trim() } });
    await refreshProjects();
    // seed the new project with whatever is currently on screen
    version = r.version;
    setProjectId(r.id);
    const s = host?.getState?.() || { projectName: name.trim(), baseDate: '', tasks: [] };
    await doPush(s);
    subscribe(r.id);
    renderAuthUI();
    toast(`'${name.trim()}' 프로젝트를 만들었습니다.`);
  } catch (e) {
    toast(e.message || '프로젝트 생성 실패');
  }
}

// ------------------------------------------------------------- team / RBAC UI
const ROLE_LABELS = { owner: '소유자', admin: '관리자', member: '멤버', viewer: '뷰어' };

async function resolveOrgId() {
  if (currentOrgId) return currentOrgId;
  const me = await api('/api/me');
  currentOrgId = me.orgs?.[0]?.id || null;
  return currentOrgId;
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
