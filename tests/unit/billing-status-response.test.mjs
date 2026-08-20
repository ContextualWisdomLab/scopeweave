import assert from 'node:assert/strict';
import { PLANS } from '../../server/billing.mjs';
import { normalizeBillingStatusResponse } from '../../server/billing_status_response.mjs';

const usage = Object.freeze({ projects: 1, members: 1 });
const proPayload = (overrides = {}) => ({
  plan: 'free',
  planName: PLANS.pro.name,
  priceKrw: PLANS.pro.priceKrw,
  limits: { ...PLANS.pro.limits },
  usage,
  ...overrides,
});

const claimBacked = normalizeBillingStatusResponse(proPayload());
assert.equal(claimBacked.plan, 'pro');
assert.equal(claimBacked.storedPlan, 'free');
assert.equal(claimBacked.planName, PLANS.pro.name);
assert.equal(claimBacked.priceKrw, PLANS.pro.priceKrw);
assert.equal(claimBacked.usage, usage);
assert.equal(Object.isFrozen(claimBacked), true);

const free = normalizeBillingStatusResponse({
  plan: 'free',
  planName: PLANS.free.name,
  priceKrw: PLANS.free.priceKrw,
  limits: { ...PLANS.free.limits },
  usage,
});
assert.equal(free.plan, 'free');
assert.equal(free.storedPlan, 'free');

const manualPro = normalizeBillingStatusResponse(proPayload({ plan: 'pro' }));
assert.equal(manualPro.plan, 'pro');
assert.equal(manualPro.storedPlan, 'pro');

for (const invalidPayload of [null, 'not-an-object', []]) {
  assert.throws(
    () => normalizeBillingStatusResponse(invalidPayload),
    /billing status payload must be an object/,
  );
}

const mismatches = [
  { planName: 'Unknown' },
  { priceKrw: PLANS.pro.priceKrw + 1 },
  { limits: { projects: 1, members: PLANS.pro.limits.members } },
  { limits: { projects: PLANS.pro.limits.projects, members: 1 } },
  { limits: undefined },
];
for (const mismatch of mismatches) {
  assert.throws(
    () => normalizeBillingStatusResponse(proPayload(mismatch)),
    /billing status payload does not match a known plan/,
  );
}

console.log('✓ billing status response normalization passed');
