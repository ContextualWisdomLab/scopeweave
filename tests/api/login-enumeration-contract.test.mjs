import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const requestJson = (path, body) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let response = await requestJson('/api/auth/signup', {
  email: 'known@example.com',
  password: 'password123',
  name: 'Known User',
});
assert.equal(response.status, 200, 'fixture signup succeeds');

const knownUserFailure = await requestJson('/api/auth/login', {
  email: 'known@example.com',
  password: 'wrong-password',
});
const knownUserBody = await knownUserFailure.json();

const unknownUserFailure = await requestJson('/api/auth/login', {
  email: 'missing@example.com',
  password: 'wrong-password',
});
const unknownUserBody = await unknownUserFailure.json();

assert.equal(knownUserFailure.status, 401, 'known user with a wrong password is rejected');
assert.equal(unknownUserFailure.status, 401, 'unknown user is rejected');
assert.deepEqual(
  unknownUserBody,
  knownUserBody,
  'unknown and known-user authentication failures expose the same API response',
);
