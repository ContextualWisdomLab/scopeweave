import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { app: coreApp } = await import('../../server/app_core.mjs');

const jsonHeaders = { 'content-type': 'application/json' };
const payload = (value) => JSON.stringify(value);

async function legacySignup(email, password = 'password123') {
  return coreApp.request('/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders,
    body: payload({ email, password, name: 'Legacy Owner' }),
  });
}

async function publicAuth(path, email, password = 'password123') {
  return app.request(path, {
    method: 'POST',
    headers: jsonHeaders,
    body: payload({ email, password, name: 'Canonical Owner' }),
  });
}

test('legacy mixed-case password identities remain reachable through the public login boundary', async () => {
  const legacyEmail = 'Legacy.Owner@ScopeWeave.Test';
  const created = await legacySignup(legacyEmail);
  assert.equal(created.status, 200, 'pre-canonical mixed-case account exists');

  const sameSpelling = await publicAuth('/api/auth/login', legacyEmail);
  assert.equal(
    sameSpelling.status,
    200,
    'the public facade must not lock out an account that previously authenticated with this exact spelling',
  );

  const canonicalSpelling = await publicAuth('/api/auth/login', legacyEmail.toLowerCase());
  assert.equal(
    canonicalSpelling.status,
    200,
    'canonical login remains compatible when exactly one legacy identity matches case-insensitively',
  );
});

test('canonical signup cannot create a case-only duplicate of a legacy account', async () => {
  const legacyEmail = 'Existing.Owner@ScopeWeave.Test';
  const created = await legacySignup(legacyEmail, 'password456');
  assert.equal(created.status, 200, 'pre-canonical mixed-case account exists');

  const duplicate = await publicAuth('/api/auth/signup', legacyEmail.toLowerCase(), 'password789');
  assert.equal(
    duplicate.status,
    409,
    'case-only duplicates must be rejected instead of creating a second login identity',
  );
});
