// ScopeWeave cloud sync — an OPT-IN overlay on the offline planner.
// Logged out, every export here is a no-op and the app behaves exactly as the
// original localStorage-only planner (so existing e2e tests are unaffected).
// Logged in with a project open, edits sync to the API with optimistic
// concurrency and a project sees other tabs' changes live over SSE.

const TOKEN_KEY = 'scopeweave:token';
const PROJECT_KEY = 'scopeweave:project';
const ROUTE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

let host = null;   // { hydrateState, renderAll, getState } provided by app.js
let version = 0;   // open project's doc version (optimistic concurrency)
let sse = null;
let pushTimer = null;
let currentOrgId = null; // org of the open project, for team management
let shareMode = false;   // viewing via a public share token → read-only

const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
const getProjectId = () => localStorage.getItem(PROJECT_KEY) || '';
const setProjectId = (id) => (id ? localStorage.setItem(PROJECT_KEY, String(id)) : localStorage.removeItem(PROJECT_KEY));
const isAuthed = () => Boolean(getToken());

export function routeTokenPathSegment(value) {
  const token = String(value || '').trim();
  return ROUTE_TOKEN_RE.test(token) ? token : '';
}

function safeApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('invalid api path');
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  const url = new URL(path, origin);
  if (url.origin !== origin || !(url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
    throw new Error('invalid api path');
  }
  return `${url.pathname}${url.search}`;
}

function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('visible'), 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(safeApiPath(path), {
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
  currentOrgId = p.orgId || projectsCache.find((x) => String(x.id) === String(id))?.orgId || currentOrgId;
  version = p.version;
  host?.hydrateState({ projectName: p.name, baseDate: p.baseDate, tasks: p.tasks });
  host?.renderAll();
  subscribe(id);
  // opening = seen: clear the unseen badge for this project
  notifCache.delete(String(id));
  api(`/api/projects/${id}/seen`, { method: 'POST' }).catch(() => {});
  renderAuthUI();
  if (!silent) toast(`'${p.name}' 프로젝트를 열었습니다.`);
}

async function doPush(payload) {
  clearTimeout(pushTimer);
  pushTimer = null;
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
    // public read-only share view (?share=TOKEN) — no account needed
    const shareToken = routeTokenPathSegment(new URLSearchParams(location.search).get('share'));
    if (shareToken) {
      try {
        const p = await api(`/api/shared/${shareToken}`);
        shareMode = true;
        renderAuthUI();
        toast('읽기 전용 공유 보기입니다 — 변경은 저장되지 않습니다.');
        return { projectName: p.name, baseDate: p.baseDate, tasks: p.tasks };
      } catch {
        toast('공유 링크가 만료되었거나 철회되었습니다.');
      }
    }
    if (!isAuthed() || !getProjectId()) { renderAuthUI(); return null; }
    try {
      const p = await api(`/api/projects/${getProjectId()}`);
      version = p.version;
      currentOrgId = p.orgId || currentOrgId; // team/dashboard need the org right after reload
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
    if (shareMode) return; // read-only share view never writes
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
let notifCache = new Map(); // projectId -> unseen count

async function refreshProjects() {
  try { projectsCache = (await api('/api/projects')).projects || []; } catch { projectsCache = []; }
  try {
    const n = await api('/api/notifications');
    notifCache = new Map((n.notifications || []).map((x) => [String(x.projectId), x.unseen]));
  } catch { notifCache = new Map(); }
}

function renderAuthUI() {
  const bar = document.getElementById('cloud-auth');
  if (!bar) return;
  bar.textContent = '';
  if (shareMode) {
    const tag = document.createElement('span');
    tag.className = 'team-role-tag';
    tag.textContent = '읽기 전용 공유 보기';
    bar.appendChild(tag);
    return;
  }
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
  for (const p of projectsCache.filter((x) => !x.archived)) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    const unseen = notifCache.get(String(p.id));
    opt.textContent = unseen ? `${p.name} ●${unseen}` : p.name; // textContent → XSS-safe
    if (String(p.id) === String(openId)) opt.selected = true;
    select.appendChild(opt);
  }
  const archivedProjects = projectsCache.filter((x) => x.archived);
  if (archivedProjects.length) {
    const group = document.createElement('optgroup');
    group.label = '보관됨';
    for (const p of archivedProjects) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = `📦 ${p.name}`;
      if (String(p.id) === String(openId)) opt.selected = true;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }
  select.addEventListener('change', () => { if (select.value) openProject(select.value).catch((e) => toast(e.message)); });
  bar.appendChild(select);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'secondary-button';
  newBtn.textContent = '+ 새 프로젝트';
  newBtn.addEventListener('click', createProjectFlow);
  bar.appendChild(newBtn);

  const dash = document.createElement('button');
  dash.type = 'button';
  dash.className = 'secondary-button';
  dash.textContent = '대시보드';
  dash.addEventListener('click', () => openPortfolioModal().catch((e) => toast(e.message || '대시보드를 불러오지 못했습니다.')));
  bar.appendChild(dash);

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

    const dup = document.createElement('button');
    dup.type = 'button';
    dup.className = 'secondary-button';
    dup.textContent = '복제';
    dup.addEventListener('click', async () => {
      const name = prompt('새 프로젝트 이름 (템플릿으로 복제)');
      if (name === null) return;
      try {
        const created = await api(`/api/projects/${getProjectId()}/duplicate`, { method: 'POST', body: { name } });
        await refreshProjects();
        await openProject(created.id);
        toast(`"${created.name}" 프로젝트로 복제했습니다.`);
      } catch (err) { toast(err.data?.error || err.message); }
    });
    bar.appendChild(dup);

    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'secondary-button';
    share.textContent = '공유';
    share.addEventListener('click', () => openShareModal().catch((e) => toast(e.data?.error || e.message)));
    bar.appendChild(share);

    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'secondary-button';
    report.textContent = '주간보고';
    report.addEventListener('click', () => { try { openReportModal(); } catch (e) { toast(e.message || '보고서 생성 실패'); } });
    bar.appendChild(report);

    const msp = document.createElement('button');
    msp.type = 'button';
    msp.className = 'secondary-button';
    msp.textContent = 'MSP 가져오기';
    msp.addEventListener('click', () => {
      let fi = document.getElementById('msp-file-input');
      if (!fi) {
        fi = document.createElement('input');
        fi.id = 'msp-file-input';
        fi.type = 'file';
        fi.accept = '.xml,text/xml';
        fi.hidden = true;
        fi.addEventListener('change', () => {
          const f = fi.files?.[0];
          fi.value = '';
          if (f) importMsProjectFile(f).catch((e) => toast(e.message || 'MSP 가져오기에 실패했습니다.'));
        });
        document.body.appendChild(fi);
      }
      fi.click();
    });
    bar.appendChild(msp);

    const cur = projectsCache.find((x) => String(x.id) === String(getProjectId()));
    const arch = document.createElement('button');
    arch.type = 'button';
    arch.className = 'secondary-button';
    arch.textContent = cur?.archived ? '보관 해제' : '보관';
    arch.addEventListener('click', async () => {
      try {
        const res = await api(`/api/projects/${getProjectId()}/archive`, { method: 'POST', body: { archived: !cur?.archived } });
        await refreshProjects();
        renderAuthUI();
        toast(res.archived ? '프로젝트를 보관했습니다.' : '보관을 해제했습니다.');
      } catch (err) { toast(err.data?.error || err.message); }
    });
    bar.appendChild(arch);
  }

  const search = document.createElement('button');
  search.type = 'button';
  search.className = 'secondary-button';
  search.textContent = '검색';
  search.addEventListener('click', openSearchModal);
  bar.appendChild(search);

  if (getProjectId()) {
    const spr = document.createElement('button');
    spr.type = 'button';
    spr.className = 'secondary-button';
    spr.textContent = '스프린트';
    spr.addEventListener('click', () => openSprintModal().catch((e) => toast(e.data?.error || e.message)));
    bar.appendChild(spr);

    const att = document.createElement('button');
    att.type = 'button';
    att.className = 'secondary-button';
    att.textContent = '산출물';
    att.addEventListener('click', () => openAttachmentsModal().catch((e) => toast(e.data?.error || e.message)));
    bar.appendChild(att);

    const cmt = document.createElement('button');
    cmt.type = 'button';
    cmt.className = 'secondary-button';
    cmt.textContent = '코멘트';
    cmt.addEventListener('click', () => openCommentsModal().catch((e) => toast(e.message || '코멘트를 불러오지 못했습니다.')));
    bar.appendChild(cmt);
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

// ---------------------------------------------------------------- share links
async function openShareModal() {
  const pid = getProjectId();
  if (!pid) return;
  let modal = document.getElementById('share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'share-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#share-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '읽기 전용 공유';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '공유 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'primary-button';
  make.textContent = '공유 링크 만들기';
  make.addEventListener('click', async () => {
    try {
      const res = await api(`/api/projects/${pid}/shares`, { method: 'POST' });
      const url = `${location.origin}${res.url}`;
      try { await navigator.clipboard.writeText(url); toast('공유 링크를 복사했습니다.'); }
      catch { prompt('공유 링크 (복사하세요)', url); }
      openShareModal();
    } catch (e) { toast(e.data?.error || e.message); }
  });
  panel.appendChild(make);

  const list = document.createElement('ul');
  list.className = 'team-list';
  panel.appendChild(list);
  const data = await api(`/api/projects/${pid}/shares`);
  if (!data.shares.length) {
    const li = document.createElement('li');
    li.textContent = '활성 공유 링크가 없습니다.';
    list.appendChild(li);
    return;
  }
  for (const sRow of data.shares) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    who.textContent = `${location.origin}/?share=${sRow.token.slice(0, 8)}… · ${String(sRow.createdAt).slice(0, 10)}`;
    const copyB = document.createElement('button');
    copyB.type = 'button';
    copyB.className = 'secondary-button';
    copyB.textContent = '복사';
    copyB.addEventListener('click', async () => {
      const url = `${location.origin}/?share=${sRow.token}`;
      try { await navigator.clipboard.writeText(url); toast('복사했습니다.'); } catch { prompt('공유 링크', url); }
    });
    const rev = document.createElement('button');
    rev.type = 'button';
    rev.className = 'secondary-button team-remove';
    rev.textContent = '철회';
    rev.addEventListener('click', () =>
      api(`/api/projects/${pid}/shares/${sRow.id}`, { method: 'DELETE' })
        .then(() => { toast('공유를 철회했습니다.'); openShareModal(); })
        .catch((e) => toast(e.data?.error || e.message)));
    li.append(who, copyB, rev);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------ weekly report
// 주간보고 generator — the PM deliverable, straight from live data.
// Pure: takes tasks + a reference date, returns markdown.
export function buildWeeklyReport(tasks, refDate, projectName = '') {
  const ref = new Date(refDate);
  if (Number.isNaN(ref.getTime())) return '';
  const day = (d) => d.toISOString().slice(0, 10);
  const monday = new Date(ref);
  monday.setDate(ref.getDate() - ((ref.getDay() + 6) % 7)); // this week's Monday
  const weekStart = day(monday);
  const weekEnd = day(new Date(monday.getTime() + 6 * 86400000));
  const nextStart = day(new Date(monday.getTime() + 7 * 86400000));
  const nextEnd = day(new Date(monday.getTime() + 13 * 86400000));
  const today = day(ref);
  const name = (t) => t.name || t.task || t.activity || t.phase || t.id;
  const leaf = (tasks || []).filter((t) => !t.isSynthetic);

  const done = leaf.filter((t) => t.actualEndDate && t.actualEndDate >= weekStart && t.actualEndDate <= weekEnd);
  const doing = leaf.filter((t) => {
    const a = Number(t.actualProgress) || 0;
    return a > 0 && a < 100 && !t.actualEndDate;
  });
  const late = leaf.filter((t) => t.plannedEndDate && t.plannedEndDate < today && (Number(t.actualProgress) || 0) < 100);
  const upcoming = leaf.filter((t) => t.plannedStartDate && t.plannedStartDate >= nextStart && t.plannedStartDate <= nextEnd);

  let wSum = 0, pv = 0, ev = 0;
  for (const t of leaf) {
    const w = Number(t.weight) || 1;
    wSum += w;
    pv += w * ((Number(t.plannedProgress) || 0) / 100);
    ev += w * ((Number(t.actualProgress) || 0) / 100);
  }
  const pvPct = wSum ? (pv / wSum) * 100 : 0;
  const evPct = wSum ? (ev / wSum) * 100 : 0;
  const spi = pvPct > 0 ? evPct / pvPct : null;

  const section = (title, items, fmt) =>
    `## ${title}\n${items.length ? items.map((t) => `- ${fmt(t)}`).join('\n') : '- (없음)'}`;
  return [
    `# 주간보고${projectName ? ` — ${projectName}` : ''} (${weekStart} ~ ${weekEnd})`,
    '',
    `**진척 요약**: 계획 ${pvPct.toFixed(1)}% · 실적 ${evPct.toFixed(1)}%` +
      (spi === null ? '' : ` · SPI ${spi.toFixed(2)} (${spi >= 1 ? '일정 준수' : spi >= 0.9 ? '경미한 지연' : '지연 위험'})`),
    '',
    section('금주 완료', done, (t) => `${name(t)} (${t.actualEndDate})`),
    '',
    section('진행 중', doing, (t) => `${name(t)} — ${Number(t.actualProgress) || 0}%${t.owner ? ` (${t.owner})` : ''}`),
    '',
    section('지연', late, (t) => `${name(t)} — 계획종료 ${t.plannedEndDate}, 실적 ${Number(t.actualProgress) || 0}%${t.owner ? ` (${t.owner})` : ''}`),
    '',
    section('차주 예정', upcoming, (t) => `${name(t)} (${t.plannedStartDate} 시작${t.owner ? `, ${t.owner}` : ''})`),
    '',
  ].join('\n');
}

function openReportModal() {
  const state = host?.getState?.();
  if (!state) { toast('프로젝트를 먼저 여세요.'); return; }
  const md = buildWeeklyReport(state.tasks, new Date().toISOString().slice(0, 10), state.projectName || '');
  let modal = document.getElementById('report-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'report-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'report-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#report-panel');
  panel.textContent = '';
  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '주간보고';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '주간보고 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'primary-button';
  copy.textContent = '마크다운 복사';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(md); toast('주간보고를 복사했습니다.'); }
    catch { toast('복사에 실패했습니다 — 아래 내용을 직접 선택하세요.'); }
  });
  panel.appendChild(copy);

  const ai = document.createElement('button');
  ai.type = 'button';
  ai.className = 'secondary-button';
  ai.style.marginLeft = '8px';
  ai.textContent = 'AI 요약';
  ai.addEventListener('click', async () => {
    ai.disabled = true;
    ai.textContent = '분석 중…';
    try {
      const res = await api(`/api/projects/${getProjectId()}/ai/brief`, { method: 'POST' });
      let box = document.getElementById('report-ai');
      if (!box) {
        box = document.createElement('pre');
        box.id = 'report-ai';
        box.style.whiteSpace = 'pre-wrap';
        box.style.borderLeft = '3px solid var(--primary, #2563eb)';
        box.style.paddingLeft = '10px';
        panel.insertBefore(box, panel.querySelector('#report-body'));
      }
      box.textContent = `🤖 AI 브리핑\n${res.analysis}`;
    } catch (e) { toast(e.data?.error || e.message); }
    finally { ai.disabled = false; ai.textContent = 'AI 요약'; }
  });
  panel.appendChild(ai);

  const pre = document.createElement('pre');
  pre.id = 'report-body';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.userSelect = 'text';
  pre.textContent = md;
  panel.appendChild(pre);
}

// ------------------------------------------------------- MS Project import
// Parse Microsoft Project XML (Project 2003+ .xml export) into ScopeWeave's
// task schema. ponytail: regex block parsing (MSP XML is machine-generated,
// no DOMParser needed → node-testable); swap for a real XML parser if
// hand-edited files ever matter.
export function parseMsProjectXml(xml) {
  // Extract the text of a simple <name>…</name> element without building a
  // dynamic RegExp from `name` (which trips SAST ReDoS/regex-injection rules,
  // even though every caller passes a hardcoded tag). indexOf slicing mirrors
  // the original /<name>([^<]*)<\/name>/ semantics: the run must contain no
  // '<', so a nested tag yields '' rather than a false capture.
  const tag = (block, name) => {
    const open = `<${name}>`;
    const start = block.indexOf(open);
    if (start === -1) return '';
    const from = start + open.length;
    const end = block.indexOf(`</${name}>`, from);
    if (end === -1) return '';
    const content = block.slice(from, end);
    return content.includes('<') ? '' : content.trim();
  };
  const unescape = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const day = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '');
  const tasks = [];
  const parents = {}; // depth -> last task id at that depth
  const blocks = xml.match(/<Task>[\s\S]*?<\/Task>/g) || [];
  for (const block of blocks) {
    const uid = tag(block, 'UID');
    const name = unescape(tag(block, 'Name'));
    if (!uid || uid === '0' || !name) continue; // project-summary row / blanks
    const level = Math.max(1, Number(tag(block, 'OutlineLevel')) || 1);
    const depth = Math.min(level, 3); // deeper levels flatten to task level
    const preds = [...block.matchAll(/<PredecessorLink>[\s\S]*?<PredecessorUID>(\d+)<\/PredecessorUID>[\s\S]*?<\/PredecessorLink>/g)]
      .map((m) => `msp-${m[1]}`);
    const pct = Number(tag(block, 'PercentComplete')) || 0;
    const t = {
      id: `msp-${uid}`,
      parentId: depth > 1 ? (parents[depth - 1] || '') : '',
      depth,
      phase: depth === 1 ? name : '',
      activity: depth === 2 ? name : '',
      task: depth === 3 ? name : '',
      name,
      plannedStartDate: day(tag(block, 'Start')),
      plannedEndDate: day(tag(block, 'Finish')),
      actualProgress: pct,
      predecessors: preds.join(','),
    };
    tasks.push(t);
    parents[depth] = t.id;
    for (let d = depth + 1; d <= 3; d++) delete parents[d]; // reset deeper chain
  }
  return tasks;
}

async function importMsProjectFile(file) {
  const xml = await file.text();
  const tasks = parseMsProjectXml(xml);
  if (!tasks.length) { toast('가져올 작업이 없습니다 (MSP XML 형식을 확인하세요).'); return; }
  if (!confirm(`MS Project에서 ${tasks.length}개 작업을 가져옵니다. 현재 프로젝트 내용을 대체합니다.`)) return;
  // preserve name/baseDate — only the task tree is replaced
  const prev = host?.getState?.() || {};
  host?.hydrateState({ projectName: prev.projectName, baseDate: prev.baseDate, tasks });
  host?.renderAll();
  const state = host?.getState?.();
  if (state) await doPush(state);
  toast(`MS Project에서 ${tasks.length}개 작업을 가져왔습니다.`);
}

// ------------------------------------------------------------- portfolio
// Executive rollup: every project's weighted progress, SPI, and overdue count.
async function openPortfolioModal() {
  if (!currentOrgId) { toast('워크스페이스를 먼저 선택하세요.'); return; }
  let modal = document.getElementById('portfolio-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'portfolio-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'portfolio-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#portfolio-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '포트폴리오 대시보드';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '대시보드 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const data = await api(`/api/orgs/${currentOrgId}/portfolio`);
  const active = data.projects.filter((p) => !p.archived);
  if (!active.length) {
    const p = document.createElement('p');
    p.textContent = '프로젝트가 없습니다.';
    panel.appendChild(p);
    return;
  }
  const summary = document.createElement('p');
  const late = active.filter((p) => p.status === 'delay').length;
  const totOverdue = active.reduce((n, p) => n + p.overdue, 0);
  summary.textContent = `프로젝트 ${active.length}개 · 주의/지연 ${late}개 · 지연 작업 합계 ${totOverdue}건`;
  panel.appendChild(summary);

  const wrap = document.createElement('div');
  wrap.style.overflowX = 'auto';
  const table = document.createElement('table');
  table.className = 'wbs-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const t of ['프로젝트', '작업', '계획%', '실적%', 'SPI', '상태', '지연', '']) {
    const th = document.createElement('th');
    th.textContent = t;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const p of active) {
    const tr = document.createElement('tr');
    const cells = [p.name, String(p.tasks), `${p.planned}%`, `${p.actual}%`, p.spi === null ? '-' : p.spi.toFixed(2), p.label, p.overdue ? `${p.overdue}건` : '-'];
    for (const cText of cells) {
      const td = document.createElement('td');
      td.textContent = cText;
      tr.appendChild(td);
    }
    if (p.status === 'delay') tr.style.color = 'var(--delay, #ea580c)';
    const td = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'secondary-button';
    open.textContent = '열기';
    open.addEventListener('click', async () => {
      modal.classList.add('hidden');
      await openProject(p.id).catch((err) => toast(err.message));
    });
    td.appendChild(open);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
}

// --------------------------------------------------------------- sprints
// Agile/Hybrid 지표 (순수): 스프린트별 커밋/완료 스토리포인트와 팀 벨로시티.
// 작업 배정 = task.sprint(이름 일치), 추정 = task.storyPoints, 완료 = 실적 100%.
export function computeSprintStats(tasks, sprints, today) {
  const leaf = (tasks || []).filter((t) => !t.isSynthetic);
  const rows = (sprints || []).map((sp) => {
    const mine = leaf.filter((t) => String(t.sprint || '').trim() === sp.name);
    const pts = (t) => Number(t.storyPoints) || 0;
    const committed = mine.reduce((n, t) => n + pts(t), 0);
    const completed = mine.filter((t) => (Number(t.actualProgress) || 0) >= 100).reduce((n, t) => n + pts(t), 0);
    const closed = Boolean(sp.endDate && today && sp.endDate < today);
    return { id: sp.id, name: sp.name, startDate: sp.startDate, endDate: sp.endDate, goal: sp.goal, taskCount: mine.length, committed, completed, remaining: committed - completed, closed };
  });
  const closedWithWork = rows.filter((r) => r.closed && r.committed > 0);
  const velocity = closedWithWork.length
    ? closedWithWork.reduce((n, r) => n + r.completed, 0) / closedWithWork.length
    : null;
  const backlog = leaf.filter((t) => !String(t.sprint || '').trim() || !(sprints || []).some((sp) => sp.name === String(t.sprint).trim()));
  return { rows, velocity, backlogCount: backlog.length };
}

// 번다운 (순수): 스프린트 기간의 일별 잔여 포인트 — ideal(선형 소진) vs
// actual(완료일 actualEndDate 기준; 완료일 없는 100% 작업은 오늘 완료로 간주).
export function computeBurndown(tasks, sprint, today) {
  if (!sprint?.startDate || !sprint?.endDate || sprint.endDate < sprint.startDate) return null;
  const leaf = (tasks || []).filter((t) => !t.isSynthetic && String(t.sprint || '').trim() === sprint.name);
  const pts = (t) => Number(t.storyPoints) || 0;
  const committed = leaf.reduce((n, t) => n + pts(t), 0);
  if (committed <= 0) return null;
  const days = [];
  for (let d = new Date(sprint.startDate); ; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push(iso);
    if (iso >= sprint.endDate) break;
    if (days.length > 120) break; // 안전 상한
  }
  const n = days.length;
  const ideal = days.map((_, i) => committed * (1 - (n === 1 ? 1 : i / (n - 1))));
  const doneAt = (t) => t.actualEndDate || ((Number(t.actualProgress) || 0) >= 100 ? today : null);
  const actual = days.map((day) => {
    if (today && day > today) return null; // 미래는 미기록
    const burned = leaf.filter((t) => { const d = doneAt(t); return d && d <= day; }).reduce((s2, t) => s2 + pts(t), 0);
    return committed - burned;
  });
  return { days, committed, ideal, actual };
}

function renderBurndownSvg(bd) {
  const W = 420, H = 110, PAD = 6;
  const n = bd.days.length;
  const x = (i) => PAD + (n === 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD));
  const y = (v) => H - PAD - (v / bd.committed) * (H - 2 * PAD);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `번다운: 커밋 ${bd.committed}pt`);
  svg.style.width = '100%';
  svg.style.maxWidth = '460px';
  const grid = document.createElementNS(NS, 'line');
  grid.setAttribute('x1', PAD); grid.setAttribute('x2', W - PAD);
  grid.setAttribute('y1', y(0)); grid.setAttribute('y2', y(0));
  grid.setAttribute('stroke', '#e2e8f0');
  svg.appendChild(grid);
  const idealLine = document.createElementNS(NS, 'polyline');
  idealLine.setAttribute('points', bd.ideal.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  idealLine.setAttribute('fill', 'none');
  idealLine.setAttribute('stroke', '#94a3b8');
  idealLine.setAttribute('stroke-dasharray', '4 3');
  svg.appendChild(idealLine);
  const actualPts = bd.actual.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
  if (actualPts.length) {
    const actualLine = document.createElementNS(NS, 'polyline');
    actualLine.setAttribute('points', actualPts.join(' '));
    actualLine.setAttribute('fill', 'none');
    actualLine.setAttribute('stroke', '#2563eb');
    actualLine.setAttribute('stroke-width', '2');
    svg.appendChild(actualLine);
  }
  return svg;
}

const METHODOLOGY_LABELS = { waterfall: 'Waterfall (예측형)', agile: 'Agile (적응형)', hybrid: 'Hybrid (혼합형)' };

async function openSprintModal() {
  const pid = getProjectId();
  if (!pid) return;
  let modal = document.getElementById('sprint-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sprint-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'sprint-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#sprint-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '스프린트 (Agile / Hybrid)';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '스프린트 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const data = await api(`/api/projects/${pid}/sprints`);

  // 방법론 선택 — 프로젝트 메타로 저장
  const mLabel = document.createElement('label');
  mLabel.className = 'meta-field';
  const mSpan = document.createElement('span');
  mSpan.textContent = '프로젝트 방법론';
  const mSel = document.createElement('select');
  mSel.className = 'cloud-select';
  mSel.id = 'methodology-select';
  for (const [v, label] of Object.entries(METHODOLOGY_LABELS)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    if (v === (data.methodology || 'waterfall')) opt.selected = true;
    mSel.appendChild(opt);
  }
  mSel.addEventListener('change', async () => {
    try {
      const cur = await api(`/api/projects/${pid}`);
      await api(`/api/projects/${pid}`, { method: 'PUT', body: { methodology: mSel.value, version: cur.version } });
      toast(`방법론: ${METHODOLOGY_LABELS[mSel.value]}`);
    } catch (e) { toast(e.data?.error || e.message); }
  });
  mLabel.append(mSpan, mSel);
  panel.appendChild(mLabel);

  // 지표 + 목록
  const stats = computeSprintStats(host?.getState?.()?.tasks || [], data.sprints, new Date().toISOString().slice(0, 10));
  const summary = document.createElement('p');
  summary.className = 'cpm-summary';
  summary.textContent = `스프린트 ${stats.rows.length}개 · 벨로시티 ${stats.velocity === null ? 'N/A (종료 스프린트 없음)' : stats.velocity.toFixed(1) + 'pt'} · 백로그 ${stats.backlogCount}건`;
  panel.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'team-list';
  for (const r of stats.rows) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'team-who';
    const period = r.startDate || r.endDate ? ` (${r.startDate}~${r.endDate})` : '';
    who.textContent = `${r.name}${period} · ${r.taskCount}작업 · ${r.completed}/${r.committed}pt${r.closed ? ' · 종료' : ''}`;
    const bdBtn = document.createElement('button');
    bdBtn.type = 'button';
    bdBtn.className = 'secondary-button';
    bdBtn.textContent = '번다운';
    bdBtn.addEventListener('click', () => {
      const holder = document.getElementById('burndown-holder');
      holder.textContent = '';
      const bd = computeBurndown(host?.getState?.()?.tasks || [], r, new Date().toISOString().slice(0, 10));
      if (!bd) { holder.textContent = '번다운을 그리려면 스프린트 기간과 스토리포인트가 필요합니다.'; return; }
      const cap = document.createElement('p');
      cap.className = 'evm-caption';
      cap.textContent = `${r.name} 번다운 — 커밋 ${bd.committed}pt · 점선=이상적 소진, 실선=실제 잔여`;
      holder.append(cap, renderBurndownSvg(bd));
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary-button team-remove';
    del.textContent = '삭제';
    del.addEventListener('click', () =>
      api(`/api/projects/${pid}/sprints/${r.id}`, { method: 'DELETE' })
        .then(() => openSprintModal()).catch((e) => toast(e.data?.error || e.message)));
    li.append(who, bdBtn, del);
    list.appendChild(li);
  }
  if (!stats.rows.length) {
    const li = document.createElement('li');
    li.textContent = '스프린트가 없습니다. 아래에서 추가하세요. (작업 배정: 편집기의 스프린트 필드)';
    list.appendChild(li);
  }
  panel.appendChild(list);

  const bdHolder = document.createElement('div');
  bdHolder.id = 'burndown-holder';
  panel.appendChild(bdHolder);

  const form = document.createElement('form');
  form.className = 'cloud-form';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = '스프린트 이름 (예: Sprint 3)';
  nameIn.required = true;
  const startIn = document.createElement('input');
  startIn.type = 'date';
  const endIn = document.createElement('input');
  endIn.type = 'date';
  const add = document.createElement('button');
  add.type = 'submit';
  add.className = 'primary-button';
  add.textContent = '추가';
  form.append(nameIn, startIn, endIn, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/projects/${pid}/sprints`, { method: 'POST', body: { name: nameIn.value.trim(), startDate: startIn.value, endDate: endIn.value } });
      toast('스프린트를 추가했습니다.');
      openSprintModal();
    } catch (err) { toast(err.data?.error || err.message); }
  });
  panel.appendChild(form);
}

// ----------------------------------------------------------- attachments
// 산출물 첨부: Clearfolio 통합 문서 뷰어로 업로드/열람. 서버가 프록시하므로
// 브라우저에는 Clearfolio 자격/시크릿이 노출되지 않는다.
async function openAttachmentsModal() {
  const pid = getProjectId();
  if (!pid) return;
  let modal = document.getElementById('attachments-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'attachments-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'attachments-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#attachments-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '산출물 (문서 뷰어)';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '산출물 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  // 작업 선택 + 파일 업로드
  const sel = document.createElement('select');
  sel.className = 'cloud-select';
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = '전체 산출물';
  sel.appendChild(optAll);
  for (const t of host?.getState?.()?.tasks || []) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name || t.task || t.activity || t.phase || t.id;
    sel.appendChild(opt);
  }
  panel.appendChild(sel);

  const form = document.createElement('form');
  form.className = 'cloud-form';
  const fi = document.createElement('input');
  fi.type = 'file';
  fi.id = 'attachment-file-input';
  fi.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.md';
  const up = document.createElement('button');
  up.type = 'submit';
  up.className = 'primary-button';
  up.textContent = '업로드';
  form.append(fi, up);
  panel.appendChild(form);

  const list = document.createElement('ul');
  list.className = 'team-list';
  panel.appendChild(list);

  const taskName = (id) => {
    const t = (host?.getState?.()?.tasks || []).find((x) => x.id === id);
    return t ? (t.name || t.task || id) : id;
  };

  async function refresh() {
    list.textContent = '';
    const q = sel.value ? `?taskId=${encodeURIComponent(sel.value)}` : '';
    const data = await api(`/api/projects/${pid}/attachments${q}`);
    if (!data.attachments.length) {
      const li = document.createElement('li');
      li.textContent = '첨부된 산출물이 없습니다.';
      list.appendChild(li);
      return;
    }
    for (const a of data.attachments) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      const where = a.taskId ? ` [${taskName(a.taskId)}]` : '';
      const st = a.status === 'SUCCEEDED' ? '' : ` · ${a.status}`;
      who.textContent = `${a.name}${where}${st}`;
      li.appendChild(who);
      if (a.status === 'SUCCEEDED') {
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'secondary-button';
        view.textContent = '보기';
        view.addEventListener('click', () => {
          window.open(`/api/projects/${pid}/attachments/${a.id}/view?token=${encodeURIComponent(getToken())}`, '_blank', 'noopener');
        });
        li.appendChild(view);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary-button team-remove';
      del.textContent = '삭제';
      del.addEventListener('click', () =>
        api(`/api/projects/${pid}/attachments/${a.id}`, { method: 'DELETE' })
          .then(refresh).catch((e) => toast(e.data?.error || e.message)));
      li.appendChild(del);
      list.appendChild(li);
    }
  }
  sel.addEventListener('change', refresh);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fi.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('taskId', sel.value);
    try {
      const res = await fetch(`/api/projects/${pid}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getToken()}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      fi.value = '';
      toast(`'${f.name}' 산출물을 업로드했습니다.`);
      refresh();
    } catch (err) { toast(err.message); }
  });
  await refresh();
}

// ------------------------------------------------------------- comments
async function openCommentsModal() {
  const pid = getProjectId();
  if (!pid) return;
  let modal = document.getElementById('comments-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'comments-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'comments-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#comments-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '코멘트';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '코멘트 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  // task filter (전체 or a specific task)
  const sel = document.createElement('select');
  sel.className = 'cloud-select';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '전체 코멘트';
  sel.appendChild(all);
  for (const t of host?.getState?.()?.tasks || []) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name || t.task || t.id;
    sel.appendChild(opt);
  }
  panel.appendChild(sel);

  const list = document.createElement('ul');
  list.className = 'team-list';
  panel.appendChild(list);

  const form = document.createElement('form');
  form.className = 'cloud-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '코멘트 입력 (선택한 작업에 달림)';
  input.maxLength = 2000;
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'primary-button';
  send.textContent = '등록';
  form.append(input, send);
  panel.appendChild(form);

  const taskName = (id) => {
    const t = (host?.getState?.()?.tasks || []).find((x) => x.id === id);
    return t ? (t.name || t.task || id) : id;
  };

  async function refresh() {
    list.textContent = '';
    const q = sel.value ? `?taskId=${encodeURIComponent(sel.value)}` : '';
    const data = await api(`/api/projects/${pid}/comments${q}`);
    if (!data.comments.length) {
      const li = document.createElement('li');
      li.textContent = '코멘트가 없습니다.';
      list.appendChild(li);
      return;
    }
    for (const cm of data.comments) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      const where = cm.taskId ? ` [${taskName(cm.taskId)}]` : '';
      who.textContent = `${cm.email || '알 수 없음'}${where}: ${cm.body}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary-button team-remove';
      del.textContent = '삭제';
      del.addEventListener('click', () =>
        api(`/api/projects/${pid}/comments/${cm.id}`, { method: 'DELETE' })
          .then(refresh).catch((e) => toast(e.data?.error || e.message)));
      li.append(who, del);
      list.appendChild(li);
    }
  }
  sel.addEventListener('change', refresh);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    try {
      await api(`/api/projects/${pid}/comments`, { method: 'POST', body: { taskId: sel.value, body: input.value.trim() } });
      input.value = '';
      refresh();
    } catch (err) { toast(err.data?.error || err.message); }
  });
  await refresh();
}

// ------------------------------------------------------------- search
function openSearchModal() {
  let modal = document.getElementById('search-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'search-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => modal.classList.add('hidden'));
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.id = 'search-panel';
    modal.append(backdrop, panel);
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  const panel = modal.querySelector('#search-panel');
  panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = '프로젝트 검색';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button close-button';
  close.setAttribute('aria-label', '검색 닫기');
  close.textContent = '✕';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  head.append(h2, close);
  panel.appendChild(head);

  const form = document.createElement('form');
  form.className = 'cloud-form';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = '프로젝트/작업 이름 (2자 이상)';
  input.minLength = 2;
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'primary-button';
  go.textContent = '검색';
  form.append(input, go);
  panel.appendChild(form);

  const out = document.createElement('div');
  panel.appendChild(out);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    out.textContent = '';
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(input.value.trim())}`);
      if (!data.results.length) { out.textContent = '검색 결과가 없습니다.'; return; }
      const list = document.createElement('ul');
      list.className = 'team-list';
      for (const hit of data.results) {
        const li = document.createElement('li');
        const who = document.createElement('span');
        who.className = 'team-who';
        const taskNames = hit.tasks.map((t) => t.name).join(', ');
        who.textContent = hit.nameMatch && !taskNames ? hit.projectName : `${hit.projectName} — ${taskNames}`;
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'secondary-button';
        open.textContent = '열기';
        open.addEventListener('click', async () => {
          modal.classList.add('hidden');
          await openProject(hit.projectId).catch((err) => toast(err.message));
        });
        li.append(who, open);
        list.appendChild(li);
      }
      out.appendChild(list);
    } catch (err) { out.textContent = err.data?.error || err.message; }
  });
  input.focus();
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

  const ics = document.createElement('button');
  ics.type = 'button';
  ics.className = 'secondary-button';
  ics.style.marginLeft = '8px';
  ics.textContent = '캘린더 내보내기 (.ics)';
  ics.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/projects/${pid}/calendar.ics`, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return toast('캘린더 내보내기에 실패했습니다.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `scopeweave-${pid}.ics`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('캘린더 파일(.ics)을 내려받았습니다.');
    } catch { toast('캘린더 내보내기에 실패했습니다.'); }
  });
  panel.appendChild(ics);

  const list = document.createElement('ul');
  list.className = 'team-list';
  panel.appendChild(list);
  const result = document.createElement('div');
  result.id = 'baseline-result';
  panel.appendChild(result);

  // 변경 이력 (revision history) — related schedule-control tool, same modal.
  const histH = document.createElement('h3');
  histH.className = 'token-heading';
  histH.textContent = '변경 이력';
  const histList = document.createElement('ul');
  histList.className = 'team-list';
  api(`/api/projects/${pid}/revisions`).then((h) => {
    for (const rev of h.revisions.slice(0, 10)) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      who.textContent = `v${rev.version} · ${String(rev.savedAt).slice(0, 16)} · ${rev.savedBy || ''}`;
      const diff = document.createElement('button');
      diff.type = 'button';
      diff.className = 'secondary-button';
      diff.textContent = '비교';
      diff.addEventListener('click', async () => {
        try {
          const snap = await api(`/api/projects/${pid}/revisions/${rev.version}`);
          renderBaselineDiff(result, compareBaseline(snap.tasks, host?.getState?.()?.tasks || []));
        } catch (e) { toast(e.data?.error || e.message); }
      });
      li.appendChild(diff);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary-button';
      restore.textContent = '복원';
      restore.addEventListener('click', async () => {
        if (!confirm(`v${rev.version} 시점으로 복원합니다. (새 버전으로 기록됩니다)`)) return;
        try {
          await api(`/api/projects/${pid}/revisions/${rev.version}/restore`, { method: 'POST' });
          await openProject(pid);
          toast(`v${rev.version} 시점으로 복원했습니다.`);
          modal.classList.add('hidden');
        } catch (e) { toast(e.data?.error || e.message); }
      });
      li.append(who, restore);
      histList.appendChild(li);
    }
    if (!h.revisions.length) {
      const li = document.createElement('li');
      li.textContent = '저장 이력이 없습니다.';
      histList.appendChild(li);
    }
  }).catch(() => {});
  panel.append(histH, histList);

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

  // org actions: rename (owner) / leave (everyone else)
  try {
    const me = await api('/api/me');
    const myRole = me.orgs?.find((o) => String(o.id) === String(currentOrgId))?.role;
    const actions = document.createElement('div');
    actions.className = 'team-org-actions';
    if (myRole === 'owner') {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'secondary-button';
      rename.textContent = '워크스페이스 이름 변경';
      rename.addEventListener('click', async () => {
        const name = prompt('새 워크스페이스 이름');
        if (!name) return;
        try {
          await api(`/api/orgs/${currentOrgId}`, { method: 'PATCH', body: { name } });
          toast('이름을 변경했습니다.');
          renderTeam();
        } catch (e) { toast(e.data?.error || e.message); }
      });
      actions.appendChild(rename);
    } else if (myRole) {
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'secondary-button team-remove';
      leave.textContent = '워크스페이스 나가기';
      leave.addEventListener('click', async () => {
        if (!confirm('이 워크스페이스에서 나갑니다. 프로젝트 접근 권한을 잃습니다.')) return;
        try {
          await api(`/api/orgs/${currentOrgId}/leave`, { method: 'POST' });
          setProjectId('');
          document.getElementById('team-modal')?.classList.add('hidden');
          await refreshProjects();
          renderAuthUI();
          toast('워크스페이스에서 나왔습니다.');
        } catch (e) { toast(e.data?.error || e.message); }
      });
      actions.appendChild(leave);
    }
    if (actions.childNodes.length) body.appendChild(actions);
  } catch { /* org actions are best-effort */ }

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
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'secondary-button';
      xfer.textContent = '소유권 이전';
      xfer.addEventListener('click', async () => {
        if (!confirm(`${m.email}에게 소유권을 이전합니다. 나는 관리자가 됩니다.`)) return;
        try {
          await api(`/api/orgs/${currentOrgId}/transfer`, { method: 'POST', body: { userId: m.id } });
          toast('소유권을 이전했습니다.');
          renderTeam();
        } catch (e) { toast(e.data?.error || e.message); } // server 403s non-owners
      });
      li.appendChild(xfer);
    }
    list.appendChild(li);
  }
  body.appendChild(list);
  if (data.invites?.length) {
    const pending = document.createElement('p');
    pending.className = 'team-pending';
    pending.textContent = '대기 중인 초대:';
    body.appendChild(pending);
    const plist = document.createElement('ul');
    plist.className = 'team-list';
    for (const i of data.invites) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'team-who';
      who.textContent = `${i.email} · ${i.role}`;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary-button team-remove';
      revoke.textContent = '초대 취소';
      revoke.addEventListener('click', () =>
        api(`/api/orgs/${currentOrgId}/invites/${i.id}`, { method: 'DELETE' })
          .then(() => { toast('초대를 취소했습니다.'); renderTeam(); })
          .catch((e) => toast(e.data?.error || e.message)));
      li.append(who, revoke);
      plist.appendChild(li);
    }
    body.appendChild(plist);
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

  const outAll = document.createElement('button');
  outAll.type = 'button';
  outAll.className = 'secondary-button';
  outAll.style.marginTop = '8px';
  outAll.textContent = '다른 모든 기기에서 로그아웃';
  outAll.addEventListener('click', async () => {
    if (!confirm('다른 모든 기기의 세션을 무효화합니다. 이 기기는 유지됩니다.')) return;
    try {
      const res = await api('/api/auth/logout-all', { method: 'POST' });
      setToken(res.token); // fresh token keeps this device signed in
      toast('다른 모든 기기에서 로그아웃했습니다.');
    } catch (e) { toast(e.data?.error || e.message); }
  });
  section.appendChild(outAll);

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
    const rot = document.createElement('button');
    rot.type = 'button';
    rot.className = 'secondary-button';
    rot.textContent = '키 교체';
    rot.addEventListener('click', async () => {
      if (!confirm('서명 시크릿을 교체합니다. 기존 시크릿은 즉시 무효화됩니다.')) return;
      try {
        const res = await api(`/api/orgs/${currentOrgId}/webhooks/${w.id}/rotate`, { method: 'POST' });
        prompt('새 서명 시크릿 (지금만 표시됩니다 — 복사하세요)', res.secret);
      } catch (e) { toast(e.data?.error || e.message); }
    });
    li.appendChild(rot);
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
  const csvBtn = document.createElement('button');
  csvBtn.type = 'button';
  csvBtn.className = 'secondary-button';
  csvBtn.textContent = 'CSV 다운로드';
  csvBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/orgs/${currentOrgId}/audit?format=csv&limit=500`, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return toast('감사 로그 내보내기에 실패했습니다.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `scopeweave-audit-${currentOrgId}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('감사 로그 CSV를 내려받았습니다.');
    } catch { toast('감사 로그 내보내기에 실패했습니다.'); }
  });
  section.appendChild(csvBtn);
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
  const inviteToken = routeTokenPathSegment(params.get('invite'));
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
