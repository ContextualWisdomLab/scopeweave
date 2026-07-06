// ScopeWeave EVM + S-curve analytics — the 공정관리 (schedule-control) moat.
// Pure math (node-testable via ESM export) + an optional DOM panel bridged onto
// window.ScopeWeaveAnalytics. Reuses app.js's date/ratio helpers by injection so
// there's a single source of truth for the planned/actual calculation.
//
// EVM mapping to the existing weighted-progress model:
//   PV (Planned Value)  = totalWeightedPlannedRatio  (0..1)
//   EV (Earned Value)   = totalWeightedActualRatio    (0..1)
//   SPI = EV / PV   SV = EV - PV   (schedule performance)
// Cost axis (AC/CPI/CV) is intentionally omitted — the product tracks schedule,
// not cost. Add it when a cost/actual-hours field exists (named ceiling).

export function computeEvm({ pv, ev }) {
  const p = Number(pv) || 0;
  const e = Number(ev) || 0;
  const spi = p > 0 ? e / p : null; // null = nothing planned yet → N/A
  const sv = e - p;                 // weighted fraction; ×100 for %p
  let status, label;
  if (p === 0) {
    status = 'before';
    label = '계획 착수 전';
  } else if (spi >= 1) {
    status = 'active';
    label = spi > 1.001 ? '일정 선행' : '일정 준수';
  } else if (spi >= 0.9) {
    status = 'delay';
    label = '경미한 지연';
  } else {
    status = 'delay';
    label = '지연 위험';
  }
  return { pv: p, ev: e, spi, sv, status, label };
}

// Time-phased PLANNED cumulative curve across the project's weekday timeline.
// Actual is only known as of baseDate (no historical snapshots yet — a future
// backend version-history feature would supply the time-phased actual curve).
export function buildScurve({ tasks, calcPlannedRatio, calcDuration, buildTimeline }) {
  const dated = (tasks || []).filter((t) => t.plannedStartDate && t.plannedEndDate);
  if (!dated.length) return { timeline: [], planned: [] };
  const durations = new Map();
  let totalDays = 0;
  for (const t of dated) {
    const d = calcDuration(t.plannedStartDate, t.plannedEndDate);
    durations.set(t.id, d);
    totalDays += d;
  }
  if (totalDays <= 0) return { timeline: [], planned: [] };

  let minStart = null;
  let maxEnd = null;
  for (const t of dated) {
    if (minStart === null || t.plannedStartDate < minStart) minStart = t.plannedStartDate;
    if (maxEnd === null || t.plannedEndDate > maxEnd) maxEnd = t.plannedEndDate;
  }
  const timeline = buildTimeline(minStart, maxEnd).map((d) => d.date);
  const planned = timeline.map((date) => {
    let pv = 0;
    for (const t of dated) {
      const dur = durations.get(t.id);
      pv += (dur / totalDays) * calcPlannedRatio(date, t.plannedStartDate, t.plannedEndDate, dur);
    }
    return pv; // 0..1
  });
  return { timeline, planned };
}

// Critical Path Method (CPM). Pure. Duration per task from task.duration (days)
// or from plannedStart/End day-count (mirrors app.js calculateDurationDays; an
// injected calcDuration is used when provided). Dependencies come from an
// optional task.predecessors (array or comma-separated ids referencing task.id).
// Robust to cycles (returns cycleDetected:true, never throws).
export function computeCpm(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const ids = list.map((t) => String(t.id));
  const idset = new Set(ids);
  const byId = new Map(list.map((t) => [String(t.id), t]));

  const durOf = (t) => {
    if (typeof t.duration === 'number' && t.duration >= 0) return t.duration;
    if (t.plannedStartDate && t.plannedEndDate) {
      if (opts.calcDuration) return opts.calcDuration(t.plannedStartDate, t.plannedEndDate);
      const ms = Date.parse(t.plannedEndDate) - Date.parse(t.plannedStartDate);
      if (!Number.isFinite(ms) || ms < 0) return 0;
      return Math.max(1, Math.round(ms / 86400000));
    }
    return 0;
  };
  const predsOf = (t) => {
    let p = t.predecessors;
    if (!p) return [];
    if (typeof p === 'string') p = p.split(',').map((s) => s.trim()).filter(Boolean);
    return Array.isArray(p) ? p.map(String) : [];
  };

  const preds = new Map(ids.map((id) => [id, []]));
  const succ = new Map(ids.map((id) => [id, []]));
  for (const t of list) {
    const id = String(t.id);
    for (const p of predsOf(t)) {
      if (idset.has(p) && p !== id) { preds.get(id).push(p); succ.get(p).push(id); }
    }
  }

  // Kahn topological sort → cycle detection.
  const indeg = new Map(ids.map((id) => [id, preds.get(id).length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  const cycleDetected = order.length !== ids.length;
  const topo = cycleDetected ? ids : order; // best-effort order under a cycle

  const dur = new Map(ids.map((id) => [id, durOf(byId.get(id))]));
  const es = new Map();
  const ef = new Map();
  for (const id of topo) {
    const start = preds.get(id).reduce((m, p) => Math.max(m, ef.get(p) ?? 0), 0);
    es.set(id, start);
    ef.set(id, start + dur.get(id));
  }
  const projectDurationDays = ids.reduce((m, id) => Math.max(m, ef.get(id) ?? 0), 0);

  const lf = new Map();
  const ls = new Map();
  for (const id of [...topo].reverse()) {
    const succs = succ.get(id);
    const finish = succs.length
      ? succs.reduce((m, s) => Math.min(m, ls.get(s) ?? projectDurationDays), Infinity)
      : projectDurationDays;
    lf.set(id, finish);
    ls.set(id, finish - dur.get(id));
  }

  const perTask = {};
  for (const id of ids) {
    const slack = (ls.get(id) ?? 0) - (es.get(id) ?? 0);
    perTask[id] = {
      duration: dur.get(id),
      es: es.get(id) ?? 0,
      ef: ef.get(id) ?? 0,
      ls: ls.get(id) ?? 0,
      lf: lf.get(id) ?? 0,
      slack,
      critical: !cycleDetected && Math.abs(slack) < 1e-9,
    };
  }
  const criticalPath = ids
    .filter((id) => perTask[id].critical)
    .sort((a, b) => perTask[a].es - perTask[b].es);

  return { perTask, projectDurationDays, criticalPath, cycleDetected };
}

// --------------------------------------------------------------------- DOM
const SVGNS = 'http://www.w3.org/2000/svg';
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function ensurePanel() {
  let panel = document.getElementById('evm-panel');
  if (panel) return panel;
  const anchor = document.querySelector('.meta-grid-secondary') || document.querySelector('.top-panel');
  if (!anchor) return null;
  panel = el('section', { id: 'evm-panel', class: 'evm-panel', 'aria-label': '일정성과지표(EVM)' });
  anchor.insertAdjacentElement('afterend', panel);
  return panel;
}

// Cost EVM: the money axis (schedule EVM = computeEvm above). Tasks carry
// budget (예산) and actualCost (실투입비); progress fields are %.
// BAC=Σbudget · PV/EV in currency · AC=ΣactualCost · CPI=EV/AC ·
// EAC=BAC/CPI · VAC=BAC-EAC · ETC=EAC-AC.
export function computeCostEvm(tasks) {
  let bac = 0, pv = 0, ev = 0, ac = 0;
  for (const t of tasks || []) {
    const b = Number(t.budget) || 0;
    bac += b;
    pv += b * ((Number(t.plannedProgress) || 0) / 100);
    ev += b * ((Number(t.actualProgress) || 0) / 100);
    ac += Number(t.actualCost) || 0;
  }
  if (bac <= 0) return null; // no budgets → cost EVM not applicable
  const cpi = ac > 0 ? ev / ac : null;
  const cv = ev - ac;
  const eac = cpi ? bac / cpi : null;
  return {
    bac, pv, ev, ac, cpi, cv,
    eac,
    vac: eac === null ? null : bac - eac,
    etc: eac === null ? null : eac - ac,
    status: cpi === null ? 'before' : cpi >= 1 ? 'active' : 'delay',
    label: cpi === null ? '실투입 전' : cpi >= 1 ? '예산 준수' : cpi >= 0.9 ? '경미한 초과' : '예산 초과 위험',
  };
}

function renderCostEvm(panel, tasks) {
  const c = computeCostEvm(tasks);
  if (!c) return;
  const krw = (v) => `₩${Math.round(v).toLocaleString('ko-KR')}`;
  const metric = (title, value, cls) => {
    const card = el('div', { class: `evm-metric ${cls || ''}` });
    card.appendChild(el('span', { class: 'evm-label' }, title));
    card.appendChild(el('strong', { class: 'evm-value' }, value));
    return card;
  };
  const row = el('div', { class: 'evm-metrics' });
  row.appendChild(metric('BAC 총예산', krw(c.bac)));
  row.appendChild(metric('EV 획득가치', krw(c.ev)));
  row.appendChild(metric('AC 실투입비', krw(c.ac)));
  row.appendChild(metric('CPI 원가효율', c.cpi === null ? 'N/A' : c.cpi.toFixed(2), `evm-${c.status}`));
  row.appendChild(metric('EAC 완료시추정', c.eac === null ? 'N/A' : krw(c.eac), `evm-${c.status}`));
  row.appendChild(metric('VAC 예산편차', c.vac === null ? 'N/A' : krw(c.vac), `evm-${c.status}`));
  row.appendChild(el('span', { class: `evm-badge evm-${c.status}` }, c.label));
  panel.appendChild(row);
}

// Resource workload: aggregate leaf-level effort per 담당자 (owner).
// Pure — feeds the panel table and is unit-tested directly.
export function computeWorkload(tasks) {
  const byOwner = new Map();
  for (const t of tasks || []) {
    const owner = String(t.owner || '').trim() || '미지정';
    let o = byOwner.get(owner);
    if (!o) { o = { owner, count: 0, plannedSum: 0, actualSum: 0, behind: 0 }; byOwner.set(owner, o); }
    const planned = Number(t.plannedProgress) || 0;
    const actual = Number(t.actualProgress) || 0;
    o.count += 1;
    o.plannedSum += planned;
    o.actualSum += actual;
    if (actual < planned) o.behind += 1;
  }
  return [...byOwner.values()]
    .map((o) => ({
      owner: o.owner,
      count: o.count,
      avgPlanned: o.count ? o.plannedSum / o.count : 0,
      avgActual: o.count ? o.actualSum / o.count : 0,
      behind: o.behind,
    }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}

function renderWorkload(panel, tasks) {
  const rows = computeWorkload(tasks);
  const named = rows.filter((r) => r.owner !== '미지정');
  if (!named.length) return; // no owners assigned → nothing useful to show
  const title = el('p', { class: 'cpm-summary' }, `담당자별 워크로드 (상위 ${Math.min(rows.length, 8)}명)`);
  panel.appendChild(title);
  const table = el('table', { class: 'workload-table' });
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['담당자', '작업수', '계획평균', '실적평균', '지연']) hr.appendChild(el('th', {}, h));
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows.slice(0, 8)) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', {}, r.owner));
    tr.appendChild(el('td', {}, String(r.count)));
    tr.appendChild(el('td', {}, `${r.avgPlanned.toFixed(1)}%`));
    tr.appendChild(el('td', {}, `${r.avgActual.toFixed(1)}%`));
    const behind = el('td', {}, r.behind ? `${r.behind}건` : '-');
    if (r.behind) behind.classList.add('workload-behind');
    tr.appendChild(behind);
    tbody.appendChild(tr);
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  const wrap = el('div', { class: 'workload-wrap' });
  wrap.appendChild(table);
  panel.appendChild(wrap);
}

function renderPanel({ pv, ev, tasks, baseDate, calcPlannedRatio, calcDuration, buildTimeline }) {
  const panel = ensurePanel();
  if (!panel) return;
  const evm = computeEvm({ pv, ev });
  panel.textContent = '';

  const metric = (title, value, cls) => {
    const card = el('div', { class: `evm-metric ${cls || ''}` });
    card.appendChild(el('span', { class: 'evm-label' }, title));
    card.appendChild(el('strong', { class: 'evm-value' }, value));
    return card;
  };
  const row = el('div', { class: 'evm-metrics' });
  row.appendChild(metric('PV 계획가치', pct(evm.pv)));
  row.appendChild(metric('EV 획득가치', pct(evm.ev)));
  row.appendChild(metric('SPI 일정효율', evm.spi === null ? 'N/A' : evm.spi.toFixed(2), `evm-${evm.status}`));
  row.appendChild(metric('SV 일정편차', `${evm.sv >= 0 ? '+' : ''}${(evm.sv * 100).toFixed(1)}%p`, `evm-${evm.status}`));
  const badge = el('span', { class: `evm-badge evm-${evm.status}` }, evm.label);
  row.appendChild(badge);
  panel.appendChild(row);

  const series = buildScurve({ tasks, calcPlannedRatio, calcDuration, buildTimeline });
  if (series.timeline.length >= 2) {
    panel.appendChild(buildScurveSvg(series, evm, baseDate));
  }

  renderCpm(panel, tasks, calcDuration);
  renderCostEvm(panel, tasks);
  renderWorkload(panel, tasks);
}

// Critical-path summary + row highlighting. Only shown when tasks declare
// dependencies (task.predecessors). Row highlight is deferred to the next frame
// because this runs mid-renderAll, before app.js has appended the new rows.
function renderCpm(panel, tasks, calcDuration) {
  const hasPreds = (tasks || []).some((t) => {
    const p = t.predecessors;
    return p && (Array.isArray(p) ? p.length : String(p).trim());
  });
  const highlight = (predicate) => {
    requestAnimationFrame(() => {
      document.querySelectorAll('tbody tr[data-task-id]').forEach((tr) => {
        tr.classList.toggle('cpm-critical', predicate(tr.getAttribute('data-task-id')));
      });
    });
  };
  if (!hasPreds) { highlight(() => false); return; }

  const cpm = computeCpm(tasks, { calcDuration });
  const line = el('p', { class: `cpm-summary${cpm.cycleDetected ? ' cpm-warn' : ''}` },
    cpm.cycleDetected
      ? '⚠ 순환 의존성이 감지되어 임계경로를 계산할 수 없습니다.'
      : `임계경로(CPM): 프로젝트 기간 ${cpm.projectDurationDays}일 · 임계 작업 ${cpm.criticalPath.length}개`);
  panel.appendChild(line);
  highlight((id) => !cpm.cycleDetected && Boolean(cpm.perTask[id]?.critical));
}

function buildScurveSvg(series, evm, baseDate) {
  const W = 640;
  const H = 120;
  const PAD = 4;
  const n = series.timeline.length;
  const x = (i) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - v * (H - 2 * PAD);

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'evm-scurve');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'S-curve: 계획 누적 진척 곡선');

  // baseline (0 / 50 / 100%)
  for (const g of [0, 0.5, 1]) {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', PAD); line.setAttribute('x2', W - PAD);
    line.setAttribute('y1', y(g)); line.setAttribute('y2', y(g));
    line.setAttribute('class', 'evm-grid');
    svg.appendChild(line);
  }
  // planned S-curve polyline
  const pts = series.planned.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const poly = document.createElementNS(SVGNS, 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('class', 'evm-plan-line');
  svg.appendChild(poly);

  // actual EV marker at baseDate x-position (nearest timeline index)
  let idx = series.timeline.findIndex((d) => d >= baseDate);
  if (idx === -1) idx = n - 1;
  const evLine = document.createElementNS(SVGNS, 'line');
  evLine.setAttribute('x1', x(idx)); evLine.setAttribute('x2', x(idx));
  evLine.setAttribute('y1', y(0)); evLine.setAttribute('y2', y(1));
  evLine.setAttribute('class', 'evm-today');
  svg.appendChild(evLine);
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('cx', x(idx)); dot.setAttribute('cy', y(evm.ev)); dot.setAttribute('r', 4);
  dot.setAttribute('class', `evm-ev-dot evm-${evm.status}`);
  svg.appendChild(dot);

  const wrap = el('div', { class: 'evm-scurve-wrap' });
  const cap = el('p', { class: 'evm-caption' },
    '계획 누적 S-curve(가중치 기준) · 세로선=기준일, 점=현재 획득가치(EV)');
  wrap.appendChild(svg);
  wrap.appendChild(cap);
  return wrap;
}

if (typeof window !== 'undefined') {
  window.ScopeWeaveAnalytics = { render: renderPanel, computeEvm, buildScurve, computeCpm, computeWorkload, computeCostEvm };
}
