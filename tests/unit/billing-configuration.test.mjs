import assert from 'node:assert/strict';
import { BillingConfigurationError, createCheckout } from '../../server/billing.mjs';

const ORIGINAL_ENV = { ...process.env };

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

try {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.SCOPEWEAVE_DEV;

  await assert.rejects(
    createCheckout({ orgId: 42, origin: 'https://scopeweave.example' }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_not_configured',
    'production checkout must fail closed instead of returning a mock URL',
  );

  process.env.SCOPEWEAVE_DEV = '1';
  const development = await createCheckout({
    orgId: 42,
    origin: 'http://localhost:3000',
  });
  assert.deepEqual(development, {
    url: 'http://localhost:3000/?billing=mock&org=42',
    live: false,
    mock: true,
  });

  process.env.STRIPE_SECRET_KEY = 'sk_test_partial';
  delete process.env.STRIPE_PRICE_ID;
  await assert.rejects(
    createCheckout({ orgId: 42, origin: 'http://localhost:3000' }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_configuration_incomplete',
    'partial Stripe configuration must fail before importing the provider SDK',
  );
} finally {
  restoreEnvironment();
}
