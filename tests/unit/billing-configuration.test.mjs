import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BillingConfigurationError,
  validateBillingStartupConfiguration,
} from '../../server/billing_configuration.mjs';

function expectConfigurationError(env, code) {
  assert.throws(
    () => validateBillingStartupConfiguration(env),
    (error) => error instanceof BillingConfigurationError && error.code === code,
  );
}

test('production without Stripe configuration keeps billing disabled instead of mocking', () => {
  const configuration = validateBillingStartupConfiguration({});
  assert.deepEqual(configuration, {
    mode: 'disabled',
    publicOrigin: null,
  });
});

test('explicit development mode permits the mock only with a canonical public origin', () => {
  const configuration = validateBillingStartupConfiguration({
    SCOPEWEAVE_DEV: '1',
    SCOPEWEAVE_PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
  });
  assert.deepEqual(configuration, {
    mode: 'mock',
    publicOrigin: 'http://127.0.0.1:8787',
  });
});

test('partial Stripe configuration fails closed during startup validation', () => {
  expectConfigurationError(
    { STRIPE_SECRET_KEY: 'sk_test_example' },
    'billing_configuration_incomplete',
  );
  expectConfigurationError(
    {
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_PRICE_ID: 'price_example',
    },
    'billing_configuration_incomplete',
  );
});

test('complete Stripe configuration requires and returns the operator public origin', () => {
  expectConfigurationError(
    {
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_PRICE_ID: 'price_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
    },
    'billing_public_origin_required',
  );

  const configuration = validateBillingStartupConfiguration({
    STRIPE_SECRET_KEY: 'sk_test_example',
    STRIPE_PRICE_ID: 'price_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    SCOPEWEAVE_PUBLIC_ORIGIN: 'https://planner.example.com',
  });
  assert.deepEqual(configuration, {
    mode: 'live',
    publicOrigin: 'https://planner.example.com',
  });
});

test('public origin rejects ambiguous URL components and remote plaintext transport', () => {
  for (const value of [
    'https://user:pass@planner.example.com',
    'https://planner.example.com/base',
    'https://planner.example.com/?tenant=1',
    'https://planner.example.com/#fragment',
    'http://planner.example.com',
    'ftp://planner.example.com',
    'not a URL',
  ]) {
    expectConfigurationError(
      { SCOPEWEAVE_DEV: '1', SCOPEWEAVE_PUBLIC_ORIGIN: value },
      'billing_public_origin_invalid',
    );
  }
});

test('development HTTP is restricted to loopback while HTTPS is canonicalized', () => {
  for (const value of [
    'http://localhost:8787/',
    'http://127.0.0.1:8787/',
    'http://[::1]:8787/',
  ]) {
    const configuration = validateBillingStartupConfiguration({
      SCOPEWEAVE_DEV: '1',
      SCOPEWEAVE_PUBLIC_ORIGIN: value,
    });
    assert.equal(configuration.mode, 'mock');
    assert.equal(configuration.publicOrigin, new URL(value).origin);
  }

  const production = validateBillingStartupConfiguration({
    SCOPEWEAVE_PUBLIC_ORIGIN: 'https://planner.example.com/',
  });
  assert.deepEqual(production, {
    mode: 'disabled',
    publicOrigin: 'https://planner.example.com',
  });
});
