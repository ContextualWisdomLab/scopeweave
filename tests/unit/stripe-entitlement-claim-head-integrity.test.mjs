import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installStripeEntitlementClaimSchema } from '../../server/stripe_entitlement_claim_ledger.mjs';

function decisionSql(id, subscriptionId, observationId) {
  return `
    INSERT INTO billing_stripe_entitlement_decisions(
      decision_id, subscription_id, evaluated_subscription_observation_id,
      evaluated_invoice_observation_id, previous_decision_id, decision_action,
      decision_reason, entitled, valid_until_sec,
      claim_subscription_observation_id, claim_invoice_observation_id,
      evaluated_at_sec, recorded_at_ms
    ) VALUES(
      ${id}, '${subscriptionId}', ${observationId},
      NULL, NULL, 'grant', 'paid_active_subscription', 1, 3000,
      ${observationId}, NULL, 1000, 1000
    );
  `;
}

test('claim heads cannot point at entitlement decisions for another Subscription', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE billing_stripe_subscriptions(subscription_id TEXT PRIMARY KEY);
      CREATE TABLE billing_stripe_subscription_observations(
        observation_id INTEGER PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id)
      );
      CREATE TABLE billing_stripe_invoice_observations(observation_id INTEGER PRIMARY KEY);
      INSERT INTO billing_stripe_subscriptions VALUES('sub_alpha'),('sub_beta');
      INSERT INTO billing_stripe_subscription_observations VALUES(101,'sub_alpha'),(201,'sub_beta'),(102,'sub_alpha');
    `);
    installStripeEntitlementClaimSchema(db);
    db.exec(decisionSql(1, 'sub_alpha', 101));
    db.exec(decisionSql(2, 'sub_beta', 201));
    db.exec(decisionSql(3, 'sub_alpha', 102));
    db.exec("INSERT INTO billing_stripe_entitlement_claim_heads(subscription_id,decision_id) VALUES('sub_alpha',1)");

    assert.throws(
      () => db.exec("UPDATE billing_stripe_entitlement_claim_heads SET decision_id=2 WHERE subscription_id='sub_alpha'"),
      /FOREIGN KEY constraint failed/iu,
      'a tenant-owned Subscription head must not accept another Subscription decision',
    );
    assert.equal(
      db.prepare("SELECT decision_id FROM billing_stripe_entitlement_claim_heads WHERE subscription_id='sub_alpha'").get().decision_id,
      1,
      'a rejected cross-Subscription rebind must leave the original head intact',
    );

    db.exec("UPDATE billing_stripe_entitlement_claim_heads SET decision_id=3 WHERE subscription_id='sub_alpha'");
    assert.equal(
      db.prepare("SELECT decision_id FROM billing_stripe_entitlement_claim_heads WHERE subscription_id='sub_alpha'").get().decision_id,
      3,
      'a same-Subscription head advance remains valid',
    );
  } finally {
    db.close();
  }
});
