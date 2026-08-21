import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  StripeReconciliationRecoveryError,
  retryStripeReconciliationDeadLetter,
} from '../../server/stripe_reconciliation_recovery.mjs';

function claimedRecovery() {
  return {
    status: 'processing',
    replayed: false,
    recoveryId: 19,
    eventId: 'evt_completion_uncertain',
    subscriptionId: 'sub_completion_uncertain',
    organizationId: 7,
    attemptNumber: 6,
    leaseToken: 'manual_recovery_token_00000019',
    leaseExpiresAtMs: 90_000,
  };
}

test('provider success followed by uncertain completion never starts a contradictory failure transition', async () => {
  let failureTransitions = 0;
  const recoveryRepository = {
    claimDeadLetterRecovery() {
      return claimedRecovery();
    },
    completeRecovery() {
      throw new StripeReconciliationRecoveryError(
        'stripe_reconciliation_recovery_state_uncertain',
        500,
      );
    },
    failRecovery() {
      failureTransitions += 1;
      return { status: 'dead_letter' };
    },
  };
  const workerRepository = {
    complete() {},
    fail() {},
  };

  await assert.rejects(
    retryStripeReconciliationDeadLetter({
      recoveryRepository,
      workerRepository,
      reconcile: async () => ({
        organizationId: 7,
        subscriptionId: 'sub_completion_uncertain',
        claimDecisionId: 73,
      }),
      organizationId: 7,
      eventId: 'evt_completion_uncertain',
      actorUserId: 11,
      evidenceReference: 'INC-uncertain-completion',
    }),
    (error) => error instanceof StripeReconciliationRecoveryError
      && error.code === 'stripe_reconciliation_recovery_state_uncertain'
      && error.status === 500,
  );
  assert.equal(failureTransitions, 0);
});

test('provider reconciliation failure still performs one bounded failure transition', async () => {
  let failureTransitions = 0;
  const claim = claimedRecovery();
  const recoveryRepository = {
    claimDeadLetterRecovery() {
      return claim;
    },
    completeRecovery() {
      throw new Error('completion must not run after provider failure');
    },
    failRecovery({ errorCode }) {
      failureTransitions += 1;
      assert.equal(errorCode, 'stripe_provider_temporarily_unavailable');
      return { status: 'dead_letter' };
    },
  };
  const workerRepository = {
    complete() {},
    fail() {},
  };
  const providerError = new Error('provider body must not escape');
  providerError.code = 'stripe_provider_temporarily_unavailable';

  const result = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async () => {
      throw providerError;
    },
    organizationId: 7,
    eventId: claim.eventId,
    actorUserId: 11,
    evidenceReference: 'INC-provider-failure',
  });

  assert.deepEqual(result, {
    status: 'dead_letter',
    replayed: false,
    recoveryId: claim.recoveryId,
    eventId: claim.eventId,
    subscriptionId: claim.subscriptionId,
    attemptNumber: claim.attemptNumber,
    errorCode: 'stripe_provider_temporarily_unavailable',
  });
  assert.equal(failureTransitions, 1);
});
