import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveOrganizationStripeEntitlement } from '../../server/stripe_entitlement_policy.mjs';

const NOW = 1_787_000_000;

function claim(overrides = {}) {
  return {
    organizationId: 42,
    subscriptionId: 'sub_scopeweave_42',
    entitled: true,
    validUntilSec: NOW + 3_600,
    ...overrides,
  };
}

test('organization aggregation rejects duplicate subscription identities', () => {
  for (const claims of [
    [claim(), claim({ validUntilSec: NOW + 7_200 })],
    [claim({ entitled: false, validUntilSec: null }), claim()],
  ]) {
    assert.throws(
      () => deriveOrganizationStripeEntitlement({ organizationId: 42, claims, nowSec: NOW }),
      /duplicate subscription/i,
    );
  }
});
