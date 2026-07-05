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
  window.ScopeWeaveAnalytics = { render: renderPanel, computeEvm, buildScurve };
}
