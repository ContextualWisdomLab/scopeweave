// Security regression: pending invitation secrets must stay private and only
// the account uniquely named by an invitation may redeem it.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `scopeweave-invite-security-${process.pid}-${Date.now()}.db`);
process.env.SCOPEWEAVE_DB = dbPath;
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const observedLogs = [];
const originalConsoleLog = console.log;
console.log = (...args) => observedLogs.push(args.join(' '));

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
const ambiguousPrimaryToken = await signup('CaseVictim@example.com', 'Case victim');
const ambiguousCollisionToken = await signup('casevictim@example.com', 'Case collision');
const ownerAuth = authFor(ownerToken);
const viewerAuth = authFor(viewerToken);
const intendedAuth = authFor(intendedToken);
const attackerAuth = authFor(attackerToken);
const ambiguousPrimaryAuth = authFor(ambiguousPrimaryToken);
const ambiguousCollisionAuth = authFor(ambiguousCollisionToken);

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

// A case-insensitive address can exist in more than one historical account
// because the legacy users.email uniqueness rule is case-sensitive. An invite
// must fail closed for that ambiguous canonical identity rather than letting
// either account win possession of the role.
response = await req(`/api/orgs/${orgId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ email: 'CASEVICTIM@example.com', role: 'admin' }),
});
assert.equal(response.status, 200);
const ambiguousInvite = await response.json();
for (const candidateAuth of [ambiguousPrimaryAuth, ambiguousCollisionAuth]) {
  response = await req(`/api/invites/${ambiguousInvite.token}/accept`, {
    method: 'POST',
    headers: candidateAuth,
  });
  assert.equal(response.status, 404, 'ambiguous canonical identity cannot redeem invite');
  assert.deepEqual(await response.json(), { error: 'invalid or used invite' });
  response = await req(`/api/orgs/${orgId}/members`, { headers: candidateAuth });
  assert.equal(response.status, 404, 'ambiguous account gains no organization membership');
}

// Create a higher-privilege pending invite for a different, unique identity.
// Invite creation canonicalizes the address, while the existing account
// intentionally retains mixed case to cover historical identity data.
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

// The request logger is a second secret boundary: an unauthenticated request
// must not copy a still-live invite bearer token from the URL into access logs.
// Non-sensitive paths should remain useful for operations and incident triage.
observedLogs.length = 0;
response = await req(`/api/invites/${adminInvite.token}/accept`, { method: 'POST' });
assert.equal(response.status, 401, 'unauthenticated invite acceptance is rejected before consumption');
const inviteLogLines = observedLogs.filter((line) => line.includes('/api/invites/'));
assert.equal(inviteLogLines.length, 1, 'invite acceptance emits one structured request log');
assert.doesNotMatch(inviteLogLines[0], new RegExp(adminInvite.token), 'access log must never contain the live invite token');
assert.equal(JSON.parse(inviteLogLines[0]).path, '/api/invites/:token/accept', 'secret path segment is represented by its route name');

observedLogs.length = 0;
response = await req('/api/me');
assert.equal(response.status, 401);
assert.equal(JSON.parse(observedLogs.at(-1)).path, '/api/me', 'ordinary request paths stay intact');

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

console.log = originalConsoleLog;
await rm(dbPath, { force: true });
originalConsoleLog('invite identity security: ok');
