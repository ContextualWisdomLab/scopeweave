// Security regression: pending invitation secrets must stay private and only
// the account named by an invitation may redeem it.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const { app } = await import('../../server/app.mjs');

const body = (value) => JSON.stringify(value);
const req = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});
const authFor = (token) => ({ authorization: `Bearer ${token}` });

async function signup(email, name = email) {
  const response = await req('/api/auth/signup', {
    method: 'POST',
    body: body({ email, password: 'password123', name }),
  });
  assert.equal(response.status, 200, `signup succeeds for ${email}`);
  return (await response.json()).token;
}

const ownerToken = await signup('owner@example.com', 'Owner');
const viewerToken = await signup('viewer@example.com', 'Viewer');
const intendedToken = await signup('Invitee@Example.com', 'Invitee');
const attackerToken = await signup('attacker@example.com', 'Attacker');
const ownerAuth = authFor(ownerToken);
const viewerAuth = authFor(viewerToken);
const intendedAuth = authFor(intendedToken);
const attackerAuth = authFor(attackerToken);

let response = await req('/api/me', { headers: ownerAuth });
assert.equal(response.status, 200);
const ownerMe = await response.json();
const orgId = ownerMe.orgs[0].id;

// Give the low-privilege account legitimate roster visibility.
response = await req(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'viewer@example.com', role: 'viewer' }),
});
assert.equal(response.status, 200);
const viewerInvite = await response.json();
response = await req(`/api/invites/${viewerInvite.token}/accept`, {
  method: 'POST',
  headers: viewerAuth,
});
assert.equal(response.status, 200);
assert.equal((await response.json()).role, 'viewer');

// Create a higher-privilege pending invite for a different identity. Invite
// creation canonicalizes the address, while the existing account intentionally
// retains mixed case to cover historical identity data.
response = await req(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'INVITEE@example.com', role: 'admin' }),
});
assert.equal(response.status, 200);
const adminInvite = await response.json();
assert.ok(adminInvite.token, 'inviter receives the one-time invitation secret');
assert.equal(adminInvite.email, 'invitee@example.com');

// A viewer may inspect the roster, but pending invitation secrets must never be
// projected into that response.
response = await req(`/api/orgs/${orgId}/members`, { headers: viewerAuth });
assert.equal(response.status, 200);
const roster = await response.json();
const pendingAdmin = roster.invites.find((invite) => invite.email === 'invitee@example.com');
assert.ok(pendingAdmin?.id, 'pending invite remains manageable by stable id');
assert.equal('token' in pendingAdmin, false, 'roster never discloses invitation bearer tokens');

// Possession of a leaked/copied invite token is insufficient: the authenticated
// identity must match the invited address, and rejection must not consume the
// invitation or create membership.
response = await req(`/api/invites/${adminInvite.token}/accept`, {
  method: 'POST',
  headers: attackerAuth,
});
assert.equal(response.status, 404, 'wrong authenticated identity receives generic invalid-invite response');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });
response = await req(`/api/orgs/${orgId}/members`, { headers: attackerAuth });
assert.equal(response.status, 404, 'rejected account gains no organization membership');

// The intended historical mixed-case account can still accept exactly once and
// receives the role selected by the inviter.
response = await req(`/api/invites/${adminInvite.token}/accept`, {
  method: 'POST',
  headers: intendedAuth,
});
assert.equal(response.status, 200, 'matching invited identity can accept');
assert.equal((await response.json()).role, 'admin');
response = await req(`/api/invites/${adminInvite.token}/accept`, {
  method: 'POST',
  headers: intendedAuth,
});
assert.equal(response.status, 404, 'used invite remains fail-closed');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });
response = await req('/api/invites/definitely-missing-token/accept', {
  method: 'POST',
  headers: intendedAuth,
});
assert.equal(response.status, 404, 'missing invite remains fail-closed');
assert.deepEqual(await response.json(), { error: 'invalid or used invite' });

console.log('invite identity security: ok');
