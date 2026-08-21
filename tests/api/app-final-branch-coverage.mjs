// Final exact-head branch cases that remain observable through public API and
// integration boundaries after the broader residual suite. These are real
// authorization, malformed-auth, attachment-metadata, billing, and tenant-
// isolation behaviors rather than assertion-only coverage probes.
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { mkdir, rm, writeFile } from 'node:fs/promises';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1000';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;
delete process.env.OIDC_ISSUER;

const [{ app, logAudit }, { db }, { submitJob }, { signToken }, { PLANS, planOf }] = await Promise.all([
  import('../../server/app.mjs'),
  import('../../server/db.mjs'),
  import('../../server/clearfolio.mjs'),
  import('../../server/auth.mjs'),
  import('../../server/billing.mjs'),
]);

const jsonBody = (value) => JSON.stringify(value);
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });
const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};
const status = async (expected, promise, label) => {
  const response = await promise;
  assert.equal(response.status, expected, label);
  return response;
};

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'final-owner@example.com', password: 'password123', name: 'Final Owner' }),
});
assert.equal(response.status, 200);
const ownerToken = (await response.json()).token;
const ownerAuth = authHeaders(ownerToken);
const ownerMe = await (await req('/api/me', { headers: ownerAuth })).json();
const ownerId = ownerMe.user.id;
const orgId = ownerMe.orgs[0].id;
db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);

// Forward-compatible plan reads must fail safely to Free rather than granting
// capabilities from an unknown persisted plan value.
assert.equal(planOf({ plan: 'future-plan' }), PLANS.free, 'unknown plans default to Free');

// System-originated audit entries legitimately have no actor, target metadata,
// or payload. Persist those nullable values as SQL NULL while keeping the audit
// write on the same best-effort path used by production requests.
logAudit(orgId, null, 'system.nullable-audit', undefined, null, null);
const nullableAudit = db.prepare(
  `SELECT user_id AS userId, target_type AS targetType, target_id AS targetId, meta
   FROM audit_log WHERE org_id = ? AND action = ? ORDER BY id DESC LIMIT 1`,
).get(orgId, 'system.nullable-audit');
assert.deepEqual(nullableAudit, {
  userId: null,
  targetType: null,
  targetId: null,
  meta: null,
});

// Exercise the configured Stripe boundary through the public checkout API
// without adding a production Stripe dependency to this CI-repair branch. The
// temporary ESM fixture validates the exact non-secret checkout contract and is
// removed unconditionally before the test continues.
const stripeFixtureUrl = new URL('../../server/node_modules/stripe/', import.meta.url);
await mkdir(stripeFixtureUrl, { recursive: true });
await writeFile(new URL('package.json', stripeFixtureUrl), JSON.stringify({
  name: 'stripe',
  version: '0.0.0-scopeweave-test',
  type: 'module',
  exports: './index.js',
}));
await writeFile(new URL('index.js', stripeFixtureUrl), `
export default class Stripe {
  constructor(key) {
    if (key !== 'sk_scopeweave_test') throw new Error('unexpected Stripe test key');
    this.checkout = {
      sessions: {
        create: async (options) => ({
          url: 'https://checkout.example.test/session?' + new URLSearchParams({
            mode: options.mode,
            price: options.line_items[0].price,
            quantity: String(options.line_items[0].quantity),
            success_url: options.success_url,
            cancel_url: options.cancel_url,
            client_reference_id: options.client_reference_id,
            metadata_org_id: options.metadata.orgId,
          }),
        }),
      },
    };
  }
}
`);
process.env.STRIPE_SECRET_KEY = 'sk_scopeweave_test';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_pro';
try {
  response = await req(`/api/orgs/${orgId}/checkout`, {
    method: 'POST',
    headers: ownerAuth,
  });
  assert.equal(response.status, 200);
  const checkout = await response.json();
  assert.equal(checkout.live, true);
  const checkoutUrl = new URL(checkout.url);
  assert.equal(checkoutUrl.searchParams.get('mode'), 'subscription');
  assert.equal(checkoutUrl.searchParams.get('price'), 'price_scopeweave_pro');
  assert.equal(checkoutUrl.searchParams.get('quantity'), '1');
  assert.equal(checkoutUrl.searchParams.get('success_url'), 'http://localhost/?billing=success');
  assert.equal(checkoutUrl.searchParams.get('cancel_url'), 'http://localhost/?billing=cancel');
  assert.equal(checkoutUrl.searchParams.get('client_reference_id'), String(orgId));
  assert.equal(checkoutUrl.searchParams.get('metadata_org_id'), String(orgId));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  await rm(stripeFixtureUrl, { recursive: true, force: true });
}

// A cryptographically valid token for an account that no longer exists must
// fail closed. This is the realistic stale-session boundary after account
// deletion and exercises the short-circuit user lookup in authenticated routes.
const deletedAccountToken = signToken({
  sub: 999999,
  email: 'deleted-account@example.com',
  tv: 0,
});
const deletedAccountAuth = authHeaders(deletedAccountToken);
await status(401, req('/api/me', { headers: deletedAccountAuth }), 'deleted account bearer token');

response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'final-viewer@example.com', password: 'password123' }),
});
const viewerAuth = authHeaders((await response.json()).token);
const viewerId = (await (await req('/api/me', { headers: viewerAuth })).json()).user.id;
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, viewerId, 'viewer');

response = await req('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: jsonBody({ name: 'Final Branch Project', orgId }),
});
assert.equal(response.status, 200);
const projectId = (await response.json()).id;

// Calendar clients that supply neither bearer nor query credentials fail closed.
await status(401, req(`/api/projects/${projectId}/calendar.ics`), 'calendar missing credentials');

// Read-only members cannot mutate roster roles or remove another member. These
// checks happen before target lookup, preserving the management boundary.
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'PATCH',
  headers: viewerAuth,
  body: jsonBody({ role: 'member' }),
}), 'viewer cannot change member role');
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'DELETE',
  headers: viewerAuth,
}), 'viewer cannot remove member');

// WHATWG multipart parsing treats filename="" as a regular form field rather
// than a File. The upload boundary must reject that malformed file part instead
// of pretending the unreachable File.name fallback is a browser behavior.
const emptyFilename = new FormData();
emptyFilename.append('file', new File(['unnamed document'], '', { type: '' }));
await status(400, app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST',
  headers: ownerAuth,
  body: emptyFilename,
}), 'empty multipart filename is not accepted as a file');

// A named browser file without explicit MIME metadata is normalized by the
// multipart parser and remains uploadable/viewable through a valid query JWT.
const untypedFile = new FormData();
untypedFile.append('file', new File(['untyped document'], 'untyped.bin', { type: '' }));
response = await app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST',
  headers: ownerAuth,
  body: untypedFile,
});
assert.equal(response.status, 200);
const untypedAttachmentId = (await response.json()).id;
response = await req(`/api/projects/${projectId}/attachments/${untypedAttachmentId}/view?token=${encodeURIComponent(ownerToken)}`);
assert.equal(response.status, 302);
await status(
  401,
  req(`/api/projects/${projectId}/attachments/${untypedAttachmentId}/view?token=${encodeURIComponent(deletedAccountToken)}`),
  'deleted account attachment-view token',
);
await status(404, req(`/api/projects/${projectId}/attachments/999999`, {
  method: 'DELETE',
  headers: ownerAuth,
}), 'missing attachment delete');

// A mock Clearfolio artifact with no MIME metadata must still be served with a
// safe binary fallback rather than an absent or malformed Content-Type.
const rawJob = await submitJob(orgId, ownerId, {
  name: 'raw.bin',
  mime: '',
  bytes: Buffer.from('raw artifact'),
});
response = await req(`/api/mock-clearfolio/${rawJob.jobId}`);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') || '', /^application\/octet-stream\b/);

// Share-list tenant isolation returns not-found for an inaccessible project.
await status(404, req('/api/projects/999999/shares', { headers: ownerAuth }), 'share list missing project');

console.log('app final branch coverage: ok');