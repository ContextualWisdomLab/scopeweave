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

// Bridge onto window so app.js (a plain, non-import script) can reach us
// without an ESM import statement — keeps app.js eval-safe for unit tests.
if (typeof window !== 'undefined') {
  window.ScopeWeaveCloud = cloud;
}
