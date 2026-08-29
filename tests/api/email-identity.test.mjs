import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;

const { app } = await import('../../server/app.mjs');

const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});

const jsonBody = (value) => JSON.stringify(value);

let response = await request('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({
    email: ' User@Example.COM ',
    password: 'password123',
    name: 'Canonical User',
  }),
});
assert.equal(response.status, 200, 'mixed-case signup succeeds');
const { token } = await response.json();
assert.ok(token, 'signup returns a session token');

response = await request('/api/me', {
  headers: { authorization: `Bearer ${token}` },
});
assert.equal(response.status, 200, 'new account is readable');
assert.equal(
  (await response.json()).user.email,
  'user@example.com',
  'new accounts persist the canonical trimmed lowercase email identity',
);

response = await request('/api/auth/login', {
  method: 'POST',
  body: jsonBody({ email: 'USER@EXAMPLE.COM', password: 'password123' }),
});
assert.equal(response.status, 200, 'login resolves the same mailbox case-insensitively');

response = await request('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'user@example.com', password: 'password123' }),
});
assert.equal(response.status, 409, 'canonical-equivalent signup cannot create a second identity');

response = await request('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'é@example.com', password: 'password123' }),
});
assert.equal(response.status, 200, 'composed Unicode mailbox signup succeeds');
response = await request('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'e\u0301@example.com', password: 'password123' }),
});
assert.equal(response.status, 409, 'decomposed Unicode mailbox cannot create a duplicate identity');
response = await request('/api/auth/login', {
  method: 'POST',
  body: jsonBody({ email: 'e\u0301@example.com', password: 'password123' }),
});
assert.equal(response.status, 200, 'decomposed Unicode mailbox resolves the composed identity');

function seedLegacyUsers(rows) {
  const directory = mkdtempSync(join(tmpdir(), 'scopeweave-email-identity-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = database.prepare(
    'INSERT INTO users(id,email,password_hash,name,token_version) VALUES(?,?,?,?,0)',
  );
  for (const row of rows) insert.run(row.id, row.email, 'salt:hash', row.name || '');
  database.close();
  return { directory, databasePath };
}

function importDatabase(databasePath) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./server/db.mjs')"],
    {
      cwd: process.cwd(),
      env: { ...process.env, SCOPEWEAVE_DB: databasePath },
      encoding: 'utf8',
    },
  );
}

{
  const { directory, databasePath } = seedLegacyUsers([
    { id: 1, email: ' Legacy.User@Example.COM ', name: 'Legacy User' },
  ]);
  try {
    const result = importDatabase(databasePath);
    assert.equal(
      result.status,
      0,
      `unambiguous legacy email migration succeeds: ${result.stderr}`,
    );

    const database = new DatabaseSync(databasePath);
    assert.equal(
      database.prepare('SELECT email FROM users WHERE id = 1').get().email,
      'legacy.user@example.com',
      'unambiguous legacy identities are canonicalized during migration',
    );
    const index = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get('users_email_canonical_unique');
    assert.match(
      String(index?.sql || ''),
      /UNIQUE\s+INDEX[\s\S]*scopeweave_canonical_email\s*\(\s*email\s*\)/iu,
      'database enforces one canonical mailbox identity even for direct writes',
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const { directory, databasePath } = seedLegacyUsers([
    { id: 1, email: 'Collision@Example.COM', name: 'First' },
    { id: 2, email: 'collision@example.com', name: 'Second' },
  ]);
  try {
    const result = importDatabase(databasePath);
    assert.notEqual(
      result.status,
      0,
      'legacy canonical-email collisions fail startup rather than auto-merging tenant identities',
    );
    assert.match(
      result.stderr,
      /canonical email collision/i,
      'startup failure explains the operator remediation boundary',
    );

    const database = new DatabaseSync(databasePath);
    assert.deepEqual(
      database.prepare('SELECT id,email FROM users ORDER BY id').all()
        .map((row) => ({ id: row.id, email: row.email })),
      [
        { id: 1, email: 'Collision@Example.COM' },
        { id: 2, email: 'collision@example.com' },
      ],
      'failed migration leaves colliding legacy identities untouched for explicit remediation',
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log('email canonical identity contract passed');
