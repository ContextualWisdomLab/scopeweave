import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function seed(rows) {
  const directory = mkdtempSync(join(tmpdir(), 'scopeweave-unicode-email-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const insert = database.prepare('INSERT INTO users(id,email,password_hash,name) VALUES(?,?,?,?)');
  for (const row of rows) insert.run(row.id, row.email, 'salt:hash', row.name || '');
  database.close();
  return { directory, databasePath };
}

function migrate(databasePath) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    process.env.SCOPEWEAVE_DB = ${JSON.stringify(databasePath)};
    const { db } = await import('./server/db.mjs');
    const rows = db.prepare('SELECT id,email FROM users ORDER BY id').all().map(({id,email}) => ({id,email}));
    let duplicateBlocked = false;
    try {
      db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
        .run('ÄLICE@EXAMPLE.COM', 'salt:hash', 'Duplicate');
    } catch { duplicateBlocked = true; }
    console.log(JSON.stringify({ rows, duplicateBlocked }));
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
}

{
  const { directory, databasePath } = seed([{ id: 1, email: ' A\u0308LICE@Example.COM ', name: 'Legacy' }]);
  try {
    const result = migrate(databasePath);
    assert.equal(result.status, 0, `unicode legacy migration succeeds: ${result.stderr}`);
    const snapshot = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(snapshot.rows, [{ id: 1, email: 'älice@example.com' }], 'legacy email canonicalization uses the same Unicode-aware JavaScript algorithm as runtime auth');
    assert.equal(snapshot.duplicateBlocked, true, 'database uniqueness rejects a canonical-equivalent Unicode mailbox after migration');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const { directory, databasePath } = seed([
    { id: 1, email: 'A\u0308lice@example.com', name: 'First' },
    { id: 2, email: 'älice@example.com', name: 'Second' },
  ]);
  try {
    const result = migrate(databasePath);
    assert.notEqual(result.status, 0, 'Unicode canonical collisions fail startup instead of silently choosing an account');
    assert.match(result.stderr, /canonical email collision/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log('unicode email identity migration contract passed');
