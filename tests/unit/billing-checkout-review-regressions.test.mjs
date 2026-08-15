import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createCheckout } from '../../server/billing.mjs';
import {
  createSqliteBillingCheckoutAttemptRepository,
  installBillingCheckoutAttemptSchema,
} from '../../server/billing_checkout_attempt.mjs';

const liveConfiguration = {
  mode: 'live',
  publicOrigin: 'https://planner.example.com',
};

function createAttemptRepository() {
  const events = [];
  return {
    events,
    startAttempt(input) {
      events.push({ type: 'start', input });
      return {
        attemptId: 'attempt-review-regression',
        idempotencyKey: 'idem-review-regression',
        state: 'pending',
        reused: false,
      };
    },
    markProviderSucceeded(input) {
      events.push({ type: 'success', input });
    },
    markProviderFailed(input) {
      events.push({ type: 'failure', input });
    },
  };
}

async function withStripeEnv(run) {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  const previousFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_review_regression';
  process.env.STRIPE_PRICE_ID = 'price_review_regression';
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
}

async function expectProviderInvalidResponse(run) {
  let rejected;
  await assert.rejects(run, (error) => {
    rejected = error;
    assert.equal(error.status, 502);
    return true;
  });
  const response = rejected.getResponse();
  const payload = await response.json();
  assert.equal(payload.error, 'billing_provider_invalid_response');
}

test('malformed successful Stripe responses keep the durable retry identity unresolved', async () => {
  await withStripeEnv(async () => {
    const cases = [
      {
        name: 'non-JSON 2xx response',
        response: () => new Response('<html>unexpected</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      },
      {
        name: 'untrusted hosted URL in a 2xx response',
        response: () => new Response(JSON.stringify({
          id: 'cs_test_review_regression',
          url: 'https://checkout.stripe.com.evil.example/c/pay/session',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
    ];

    for (const scenario of cases) {
      const repository = createAttemptRepository();
      globalThis.fetch = async () => scenario.response();

      await expectProviderInvalidResponse(() => createCheckout({
        orgId: 73,
        configuration: liveConfiguration,
        attemptRepository: repository,
      }));

      assert.deepEqual(
        repository.events.map((event) => event.type),
        ['start'],
        `${scenario.name} is an uncertain provider outcome and must retain the same idempotency key`,
      );
    }
  });
});

function createCheckoutAttemptFixture(startTimeMs) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.exec('CREATE TABLE orgs (id INTEGER PRIMARY KEY)');
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(7);
  installBillingCheckoutAttemptSchema(database);

  let nowMs = startTimeMs;
  const identifiers = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    now: () => nowMs,
    randomUUID: () => identifiers.shift(),
  });
  const attempt = repository.startAttempt({
    organizationId: 7,
    priceId: 'price_review_regression',
  });
  return {
    database,
    repository,
    attempt,
    rollbackClock() {
      nowMs = startTimeMs - 1_000;
    },
  };
}

test('terminal success remains durable when the wall clock moves behind attempt creation', () => {
  const fixture = createCheckoutAttemptFixture(5_000_000);
  fixture.rollbackClock();

  fixture.repository.markProviderSucceeded({
    attemptId: fixture.attempt.attemptId,
    providerSessionId: 'cs_test_clock_rollback',
  });

  const row = fixture.database.prepare(`
    SELECT attempt_state, provider_session_id, created_at_ms, updated_at_ms
    FROM billing_checkout_attempts
    WHERE attempt_id = ?
  `).get(fixture.attempt.attemptId);
  assert.deepEqual({ ...row }, {
    attempt_state: 'provider_succeeded',
    provider_session_id: 'cs_test_clock_rollback',
    created_at_ms: 5_000_000,
    updated_at_ms: 5_000_000,
  });
});

test('terminal failure remains durable when the wall clock moves behind attempt creation', () => {
  const fixture = createCheckoutAttemptFixture(6_000_000);
  fixture.rollbackClock();

  fixture.repository.markProviderFailed({ attemptId: fixture.attempt.attemptId });

  const row = fixture.database.prepare(`
    SELECT attempt_state, created_at_ms, updated_at_ms
    FROM billing_checkout_attempts
    WHERE attempt_id = ?
  `).get(fixture.attempt.attemptId);
  assert.deepEqual({ ...row }, {
    attempt_state: 'provider_failed',
    created_at_ms: 6_000_000,
    updated_at_ms: 6_000_000,
  });
});

test('live Checkout reports missing price configuration before touching durable state', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_review_regression';
  delete process.env.STRIPE_PRICE_ID;
  let startAttemptCalled = false;
  try {
    let rejected;
    await assert.rejects(
      () => createCheckout({
        orgId: 73,
        configuration: liveConfiguration,
        attemptRepository: {
          startAttempt() {
            startAttemptCalled = true;
            throw new Error('must not reach durable state without price configuration');
          },
          markProviderSucceeded() {},
          markProviderFailed() {},
        },
      }),
      (error) => {
        rejected = error;
        assert.equal(error.status, 503);
        return true;
      },
    );
    const payload = await rejected.getResponse().json();
    assert.equal(payload.error, 'billing_not_configured');
    assert.equal(startAttemptCalled, false);
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});
