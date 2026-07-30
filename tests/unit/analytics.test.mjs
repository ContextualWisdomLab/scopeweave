// Pure EVM + S-curve math tests. Run: node tests/unit/analytics.test.mjs
import assert from 'node:assert';
import { computeEvm, buildScurve } from '../../analytics.js';

// ---- computeEvm ----------------------------------------------------------
// on-schedule: EV == PV → SPI 1.0, SV 0
let r = computeEvm({ pv: 0.5, ev: 0.5 });
assert.equal(r.spi, 1, 'SPI = EV/PV = 1');
assert.equal(r.sv, 0, 'SV = 0');
assert.equal(r.status, 'active');

// behind: EV < PV
r = computeEvm({ pv: 0.5, ev: 0.4 });
assert.ok(Math.abs(r.spi - 0.8) < 1e-9, 'SPI = 0.8');
assert.ok(Math.abs(r.sv - -0.1) < 1e-9, 'SV = -0.1');
assert.equal(r.status, 'delay');
assert.equal(r.label, '지연 위험'); // spi 0.8 < 0.9

// slightly behind (0.9 ≤ spi < 1)
assert.equal(computeEvm({ pv: 1, ev: 0.95 }).label, '경미한 지연');

// ahead: EV > PV
r = computeEvm({ pv: 0.4, ev: 0.6 });
assert.ok(r.spi > 1, 'SPI > 1 when ahead');
assert.equal(r.label, '일정 선행');

// nothing planned yet → SPI N/A, no divide-by-zero
r = computeEvm({ pv: 0, ev: 0 });
assert.equal(r.spi, null, 'SPI null when PV=0');
assert.equal(r.status, 'before');

// ---- buildScurve ---------------------------------------------------------
// Deterministic injected helpers mirroring app.js semantics.
const calcDuration = (s, e) => {
  const d = Math.round((Date.parse(e) - Date.parse(s)) / 86400000);
  return e < s ? 0 : Math.max(1, d);
};
const calcPlannedRatio = (base, start, end, dur) => {
  if (!base || !start || !end) return 0;
  if (base <= start) return 0;
  if (base >= end) return 1;
  const elapsed = calcDuration(start, base);
  return Math.min(1, Math.max(0, elapsed / (dur || calcDuration(start, end))));
};
// Simple weekday-ish timeline: every day inclusive (weekends fine for the test).
const buildTimeline = (min, max) => {
  const out = [];
  let cur = min;
  for (let i = 0; i < 400 && cur <= max; i++) {
    out.push({ date: cur });
    const d = new Date(cur + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
};

const tasks = [
  { id: 'a', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-11' }, // 10d
  { id: 'b', plannedStartDate: '2026-01-11', plannedEndDate: '2026-01-21' }, // 10d
];
const s = buildScurve({ tasks, calcPlannedRatio, calcDuration, buildTimeline });
assert.ok(s.timeline.length >= 2, 'timeline built');
// monotonic non-decreasing cumulative planned curve
for (let i = 1; i < s.planned.length; i++) {
  assert.ok(s.planned[i] >= s.planned[i - 1] - 1e-9, `S-curve monotonic at ${i}`);
}
assert.ok(Math.abs(s.planned[0]) < 1e-9, 'starts at 0');
assert.ok(Math.abs(s.planned[s.planned.length - 1] - 1) < 1e-9, 'ends at 1.0 (100%)');
// midpoint (2026-01-11): task a fully done (0.5 weight), task b just starting → ~0.5
const midIdx = s.timeline.indexOf('2026-01-11');
assert.ok(midIdx > 0 && Math.abs(s.planned[midIdx] - 0.5) < 1e-6, 'midpoint ≈ 50%');

// empty / undated tasks → empty series, no throw
assert.deepEqual(buildScurve({ tasks: [], calcPlannedRatio, calcDuration, buildTimeline }), { timeline: [], planned: [] });

// dated tasks whose total duration is zero → empty series (no 0/0 NaN weight).
// Distinct from the empty-input case above: these tasks DO pass the "has both
// planned dates" filter, so they populate `dated`, but each contributes 0 days
// (end<start via the injected calcDuration), leaving totalDays==0. Guards the
// `dur/totalDays` weight division in the cumulative curve from producing NaN.
const zeroDuration = [
  { id: 'z1', plannedStartDate: '2026-01-11', plannedEndDate: '2026-01-01' }, // end<start → 0d
  { id: 'z2', plannedStartDate: '2026-02-05', plannedEndDate: '2026-02-01' }, // end<start → 0d
];
assert.deepEqual(
  buildScurve({ tasks: zeroDuration, calcPlannedRatio, calcDuration, buildTimeline }),
  { timeline: [], planned: [] },
  'zero total planned duration → empty series (no divide-by-zero)'
);
// and the returned curve carries no NaN (regression guard on the weight math)
const zeroSeries = buildScurve({ tasks: zeroDuration, calcPlannedRatio, calcDuration, buildTimeline });
assert.ok(zeroSeries.planned.every((v) => Number.isFinite(v)), 'no NaN in planned series');

console.log('✓ analytics (EVM + S-curve) unit tests passed');
