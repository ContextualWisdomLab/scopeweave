import assert from 'node:assert/strict';
import { normalizeBillingStatusResponse } from '../../server/billing_status_response.mjs';

const usage = Object.freeze({ projects: 1, members: 1 });

const claimBacked = normalizeBillingStatusResponse({
  plan: 'free',
  planName: 'Pro',
  priceKrw: 9900,
  limits: { projects: null, members: null },
  usage,
});
assert.equal(claimBacked.plan, 'pro');
assert.equal(claimBacked.storedPlan, 'free');
assert.equal(claimBacked.planName, 'Pro');
assert.equal(claimBacked.usage, usage);
assert.equal(Object.isFrozen(claimBacked), true);

const free = normalizeBillingStatusResponse({
  plan: 'free',
  planName: 'Free',
  priceKrw: 0,
  limits: { projects: 3, members: 3 },
  usage,
});
assert.equal(free.plan, 'free');
assert.equal(free.storedPlan, 'free');

const manualPro = normalizeBillingStatusResponse({
  plan: 'pro',
  planName: 'Pro',
  priceKrw: 9900,
  limits: { projects: null, members: null },
  usage,
});
assert.equal(manualPro.plan, 'pro');
assert.equal(manualPro.storedPlan, 'pro');

assert.throws(
  () => normalizeBillingStatusResponse(null),
  /billing status payload must be an object/,
);
assert.throws(
  () => normalizeBillingStatusResponse({
    plan: 'free',
    planName: 'Unknown',
    priceKrw: 0,
    limits: { projects: 3, members: 3 },
  }),
  /billing status payload does not match a known plan/,
);

console.log('✓ billing status response normalization passed');
