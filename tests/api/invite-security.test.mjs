import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_invites';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_invites';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_invite_secret';

const { app } = await import('../../server/app.mjs?invite-security=1');
const { app: applicationRoutes } = await import('../../server/application_routes.mjs');
const { app: implementationRoutes } = await import('../../server/application_routes_core.mjs');
const body = (value) => JSON.stringify(value);
const withJson = (router) => (path, options = {}) => router.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});
const request = withJson(app);
const coreRequest = withJson(applicationRoutes);
const implementationRequest = withJson(implementationRoutes);

async function signup(email) {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: body({ email, password: 'password123' }),
  });
  assert.equal(response.status, 200, `signup succeeds for ${email}`);
  return (await response.json()).token;
}

const ownerToken = await signup('invite-owner@example.com');
const viewerToken = await signup('invite-viewer@example.com');
const attackerToken = await signup('invite-attacker@example.com');
const targetToken = await signup('Target.Invitee@Example.com');
const ownerAuth = { authorization: `Bearer ${ownerToken}` };
const viewerAuth = { authorization: `Bearer ${viewerToken}` };
const attackerAuth = { authorization: `Bearer ${attackerToken}` };
const targetAuth = { authorization: `Bearer ${targetToken}` };

let response = await request('/api/me', { headers: ownerAuth });
const ownerMe = await response.json();
const orgId = ownerMe.orgs[0].id;

response = await request(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'invite-viewer@example.com', role: 'viewer' }),
});
assert.equal(response.status, 200);
const viewerInvite = await response.json();
response = await request(`/api/invites/${viewerInvite.token}/accept`, {
  method: 'POST',
  headers: viewerAuth,
});
assert.equal(response.status, 200, 'intended viewer can join');

response = await request(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'TARGET.INVITEE@EXAMPLE.COM', role: 'admin' }),
});
assert.equal(response.status, 200);
const targetInvite = await response.json();
assert.ok(targetInvite.token, 'creator receives the bearer token for delivery');

response = await request(`/api/orgs/${orgId}/members`, { headers: viewerAuth });
assert.equal(response.status, 200, 'viewer may inspect the organization roster');
const roster = await response.json();
const pendingTarget = roster.invites.find((invite) => invite.email === 'target.invitee@example.com');
assert.ok(pendingTarget, 'pending invitation remains visible as workflow state');
assert.equal('token' in pendingTarget, false, 'roster never discloses pending invite bearer tokens');

response = await coreRequest(`/api/orgs/${orgId}/members`, { headers: viewerAuth });
assert.equal(response.status, 200, 'the supported shared route graph exposes the same safe roster contract');
const coreRoster = await response.json();
const corePendingTarget = coreRoster.invites.find((invite) => invite.email === 'target.invitee@example.com');
assert.ok(corePendingTarget, 'supported shared route graph preserves pending invitation workflow state');
assert.equal(
  'token' in corePendingTarget,
  false,
  'supported shared route graph cannot bypass pending-invite bearer-token redaction',
);

response = await implementationRequest(`/api/orgs/${orgId}/members`, { headers: viewerAuth });
assert.equal(response.status, 200, 'internal implementation keeps the same non-secret roster projection');
const implementationRoster = await response.json();
const implementationPendingTarget = implementationRoster.invites.find((invite) => invite.email === 'target.invitee@example.com');
assert.ok(implementationPendingTarget, 'internal implementation preserves pending invitation workflow state');
assert.equal(
  'token' in implementationPendingTarget,
  false,
  'internal implementation must not retain a reusable bearer-token disclosure path',
);

response = await request(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'target.invitee@example.com', role: 'member' }),
});
assert.equal(response.status, 200);
const implementationInvite = await response.json();
response = await implementationRequest(`/api/invites/${implementationInvite.token}/accept`, {
  method: 'POST',
  headers: attackerAuth,
});
assert.equal(response.status, 404, 'internal implementation cannot retain a bypass around invited-identity binding');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });

response = await coreRequest(`/api/invites/${targetInvite.token}/accept`, {
  method: 'POST',
  headers: attackerAuth,
});
assert.equal(response.status, 404, 'supported shared route graph binds invite redemption to the invited identity');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });

response = await request(`/api/invites/${targetInvite.token}/accept`, {
  method: 'POST',
  headers: attackerAuth,
});
assert.equal(response.status, 404, 'authenticated account with the wrong email cannot redeem the invite');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });

response = await request('/api/me', { headers: attackerAuth });
const attackerMe = await response.json();
assert.equal(
  attackerMe.orgs.some((org) => Number(org.id) === Number(orgId)),
  false,
  'mismatched redemption creates no organization membership',
);

response = await request(`/api/invites/${targetInvite.token}/accept`, {
  method: 'POST',
  headers: targetAuth,
});
assert.equal(response.status, 200, 'case-insensitively matching invited identity can redeem');
assert.equal((await response.json()).role, 'admin');

response = await request(`/api/invites/${targetInvite.token}/accept`, {
  method: 'POST',
  headers: targetAuth,
});
assert.equal(response.status, 404, 'accepted invitation cannot be replayed');

console.log('invite identity-boundary regression passed');
