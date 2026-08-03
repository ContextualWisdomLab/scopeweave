import assert from 'node:assert';
import { PLANS, planOf, orgUsage, wouldExceed, createCheckout } from '../../server/billing.mjs';

// Test planOf
assert.deepEqual(planOf(null), PLANS.free, 'planOf(null) is free plan');
assert.deepEqual(planOf({}), PLANS.free, 'planOf({}) is free plan');
assert.deepEqual(planOf({ plan: 'pro' }), PLANS.pro, 'planOf({ plan: "pro" }) is pro plan');
assert.deepEqual(planOf({ plan: 'unknown' }), PLANS.free, 'planOf({ plan: "unknown" }) falls back to free plan');

// Mock DB
const mockDb = {
  prepare: (query) => {
    return {
      get: (orgId) => {
        if (query.includes('FROM projects')) return { n: orgId === 1 ? 2 : 1 };
        if (query.includes('FROM memberships')) return { n: orgId === 1 ? 3 : 2 };
        return { n: 0 };
      }
    };
  }
};

// Test orgUsage
const usage1 = orgUsage(mockDb, 1);
assert.deepEqual(usage1, { projects: 2, members: 3 }, 'orgUsage returns counts from DB');

// Test wouldExceed
const freeOrg = { id: 1, plan: 'free' };
assert.equal(wouldExceed(mockDb, freeOrg, 'projects'), true, 'would exceed projects limit on free plan');
assert.equal(wouldExceed(mockDb, freeOrg, 'members'), true, 'would exceed members limit on free plan');

const freeOrg2 = { id: 2, plan: 'free' };
assert.equal(wouldExceed(mockDb, freeOrg2, 'projects'), false, 'would not exceed projects limit on free plan');
assert.equal(wouldExceed(mockDb, freeOrg2, 'members'), false, 'would not exceed members limit on free plan');

const proOrg = { id: 1, plan: 'pro' };
assert.equal(wouldExceed(mockDb, proOrg, 'projects'), false, 'unlimited projects on pro plan');
assert.equal(wouldExceed(mockDb, proOrg, 'members'), false, 'unlimited members on pro plan');

// Test createCheckout
async function runCheckoutTests() {
  const originalKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const mockResult = await createCheckout({ orgId: 123, origin: 'http://localhost' });
  assert.equal(mockResult.live, false);
  assert.equal(mockResult.mock, true);
  assert.equal(mockResult.url, 'http://localhost/?billing=mock&org=123');

  if (originalKey !== undefined) {
    process.env.STRIPE_SECRET_KEY = originalKey;
  }

  console.log('✓ billing unit tests passed');
}
runCheckoutTests().catch(err => {
  console.error(err);
  process.exit(1);
});
