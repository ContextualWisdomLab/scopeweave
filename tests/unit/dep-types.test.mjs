// Dependency types SS/FF/SF + lag in computeCpm (FS remains the default).
// Run: node tests/unit/dep-types.test.mjs
import assert from 'node:assert';
import { computeCpm } from '../../analytics.js';

const T = (id, duration, predecessors = '') => ({ id, duration, predecessors });

// FS with lag: B starts 3 days after A finishes.
{
  const r = computeCpm([T('A', 5), T('B', 3, 'AFS+3')]);
  assert.equal(r.perTask.B.es, 8, 'FS+3: es = ef_A(5)+3');
  assert.equal(r.projectDurationDays, 11);
}

// SS: B starts 2 days after A STARTS (parallel work).
{
  const r = computeCpm([T('A', 5), T('B', 3, 'ASS+2')]);
  assert.equal(r.perTask.B.es, 2, 'SS+2: es = es_A(0)+2');
  assert.equal(r.projectDurationDays, 5, 'B(2..5) inside A(0..5)');
}

// FF: B must FINISH when A finishes → es = ef_A - dur_B.
{
  const r = computeCpm([T('A', 5), T('B', 3, 'AFF')]);
  assert.equal(r.perTask.B.es, 2, 'FF: es = ef_A(5) - dur_B(3)');
  assert.equal(r.perTask.B.ef, 5, 'finishes together');
}

// SF: B finishes 4 days after A starts.
{
  const r = computeCpm([T('A', 5), T('B', 3, 'ASF+4')]);
  assert.equal(r.perTask.B.ef, 4, 'SF+4: ef = es_A(0)+4');
  assert.equal(r.perTask.B.es, 1);
}

// negative lag (lead): B overlaps A by 2 days.
{
  const r = computeCpm([T('A', 5), T('B', 3, 'AFS-2')]);
  assert.equal(r.perTask.B.es, 3, 'FS-2 lead');
}

// backward pass + criticality under SS: A drives via SS chain.
{
  const r = computeCpm([T('A', 2), T('B', 6, 'ASS'), T('C', 1, 'B')]);
  assert.equal(r.projectDurationDays, 7, 'A(0-2)∥B(0-6)→C(6-7)');
  assert.ok(r.perTask.B.critical && r.perTask.C.critical, 'SS chain critical');
  // standard CPM (MSP-consistent): the SS link makes A's START drive B, so A's
  // total slack is 0 — A is critical through its start.
  assert.equal(r.perTask.A.slack, 0, 'SS predecessor start-driven → slack 0');
}

// plain FS unchanged + id that LOOKS like a type suffix stays an id.
{
  const r = computeCpm([T('PROGRESS', 2), T('B', 1, 'PROGRESS')]);
  assert.equal(r.perTask.B.es, 2, 'whole-token id match beats suffix parsing');
}

// cycle with types still detected.
{
  const r = computeCpm([T('A', 1, 'BSS'), T('B', 1, 'ASS')]);
  assert.equal(r.cycleDetected, true);
}

console.log('✓ dependency-type (SS/FF/SF+lag) tests passed');
