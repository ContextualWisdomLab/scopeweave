import { PLANS } from './billing.mjs';

function planMatchesResponse(plan, payload) {
  return plan.name === payload.planName
    && plan.priceKrw === payload.priceKrw
    && plan.limits.projects === payload.limits?.projects
    && plan.limits.members === payload.limits?.members;
}

/**
 * Normalize the public billing-status payload so `plan` always identifies the
 * effective authorization plan while `storedPlan` preserves the durable/manual
 * organization value for audit and operator diagnosis.
 *
 * The legacy route already derives `planName`, price, and limits through
 * `planOf(org)`. Matching that complete bounded definition against the shared
 * `PLANS` catalog avoids trusting a browser-selected claim or inferring paid
 * authority from the stored plan alone.
 *
 * @param {object} payload JSON payload produced by the internal billing route.
 * @returns {Readonly<object>} normalized public response payload.
 * @throws {TypeError} when the internal payload does not match a known plan.
 */
export function normalizeBillingStatusResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('billing status payload must be an object');
  }
  const effectivePlan = Object.entries(PLANS).find(([, plan]) => planMatchesResponse(plan, payload));
  if (!effectivePlan) throw new TypeError('billing status payload does not match a known plan');

  return Object.freeze({
    ...payload,
    plan: effectivePlan[0],
    storedPlan: payload.plan,
  });
}
