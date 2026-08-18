// Targeted API regressions for production branches that must stay covered.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const body = (value) => JSON.stringify(value);
const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

let response = await request('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'owner@example.com', password: 'password123', name: 'Owner' }),
});
assert.equal(response.status, 200, 'owner signup succeeds');
const ownerToken = (await response.json()).token;
const ownerAuth = { authorization: `Bearer ${ownerToken}` };

response = await request('/api/me', { headers: ownerAuth });
assert.equal(response.status, 200, 'owner identity loads');
const ownerMe = await response.json();
const orgId = ownerMe.orgs[0].id;

// Legacy/imported audit rows may have no metadata. Workspace export must retain
// them as explicit null instead of throwing while parsing the audit stream.
db.prepare(
  `INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta)
   VALUES(?,?,?,?,?,?)`,
).run(orgId, ownerMe.user.id, 'legacy.audit.null_meta', 'org', String(orgId), null);

response = await request(`/api/orgs/${orgId}/export`, { headers: ownerAuth });
assert.equal(response.status, 200, 'owner can export a workspace containing null audit metadata');
const exported = await response.json();
const legacyAudit = exported.audit.find((event) => event.action === 'legacy.audit.null_meta');
assert.ok(legacyAudit, 'legacy audit event is exported');
assert.equal(legacyAudit.meta, null, 'null audit metadata remains null in the export');

response = await request('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'outsider@example.com', password: 'password123', name: 'Outsider' }),
});
assert.equal(response.status, 200, 'outsider signup succeeds');
const outsiderAuth = { authorization: `Bearer ${(await response.json()).token}` };

response = await request(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ url: 'https://example.com/scopeweave-hook', events: ['project.update'] }),
});
assert.equal(response.status, 200, 'owner can create a webhook');
const webhook = await response.json();

// Deletion is a management boundary: a non-member must not be able to remove
// an integration owned by another tenant, while the owner still can.
response = await request(`/api/orgs/${orgId}/webhooks/${webhook.id}`, {
  method: 'DELETE',
  headers: outsiderAuth,
});
assert.equal(response.status, 403, 'non-member webhook deletion is forbidden');

response = await request(`/api/orgs/${orgId}/webhooks/${webhook.id}`, {
  method: 'DELETE',
  headers: ownerAuth,
});
assert.equal(response.status, 200, 'owner can delete the webhook after the denied attempt');
assert.deepEqual(await response.json(), { ok: true }, 'successful deletion returns the stable success contract');

console.log('✓ export/webhook coverage regressions passed');
