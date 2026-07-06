// Cost EVM (BAC/EV/AC/CPI/EAC/VAC) — classic PMBOK worked example.
// Run: node tests/unit/cost-evm.test.mjs
import assert from 'node:assert';
import { computeCostEvm } from '../../analytics.js';

// Two tasks: budgets 1,000,000 + 1,000,000 (BAC 2,000,000).
// T1: 100% done, planned 100%, cost 1,200,000 (overrun).
// T2: 25% done, planned 50%, cost 300,000.
const tasks = [
  { id: 'a', budget: 1000000, plannedProgress: 100, actualProgress: 100, actualCost: 1200000 },
  { id: 'b', budget: 1000000, plannedProgress: 50, actualProgress: 25, actualCost: 300000 },
];
const c = computeCostEvm(tasks);
assert.equal(c.bac, 2000000, 'BAC = Σbudget');
assert.equal(c.pv, 1500000, 'PV = Σ budget×planned%');
assert.equal(c.ev, 1250000, 'EV = Σ budget×actual%');
assert.equal(c.ac, 1500000, 'AC = ΣactualCost');
assert.ok(Math.abs(c.cpi - 1250000 / 1500000) < 1e-9, 'CPI = EV/AC ≈ 0.833');
assert.equal(c.cv, -250000, 'CV = EV-AC');
assert.ok(Math.abs(c.eac - 2000000 / (1250000 / 1500000)) < 1e-6, 'EAC = BAC/CPI = 2.4M');
assert.ok(Math.abs(c.vac - (2000000 - c.eac)) < 1e-6, 'VAC = BAC-EAC (negative overrun)');
assert.ok(c.vac < 0, 'overrun → negative VAC');
assert.equal(c.status, 'delay', 'CPI<0.9 → 예산 초과 위험');

// on-budget: CPI 1 → active
const good = computeCostEvm([{ id: 'a', budget: 100, actualProgress: 50, actualCost: 50 }]);
assert.equal(good.cpi, 1);
assert.equal(good.status, 'active');
assert.equal(good.eac, 100, 'EAC = BAC when CPI=1');

// no cost spent yet → CPI null, before
const before = computeCostEvm([{ id: 'a', budget: 100, actualProgress: 0, actualCost: 0 }]);
assert.equal(before.cpi, null);
assert.equal(before.status, 'before');

// no budgets → null (cost EVM not applicable)
assert.equal(computeCostEvm([{ id: 'a', plannedProgress: 50 }]), null);
assert.equal(computeCostEvm([]), null);

console.log('✓ cost-EVM tests passed');
