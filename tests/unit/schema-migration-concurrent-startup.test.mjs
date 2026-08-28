import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function startDatabaseModule(databasePath) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./server/db.mjs')"],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        SCOPEWEAVE_DB: databasePath,
        SCOPEWEAVE_JWT_SECRET: JWT_SECRET,
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

test('established legacy startup remains available while another writer holds the WAL write reservation', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'scopeweave-schema-concurrency-'));
  const databasePath = join(tempDirectory, 'rolling-start.sqlite');
  let writer;

  try {
    const bootstrap = startDatabaseModule(databasePath);
    assert.equal(
      bootstrap.status,
      0,
      `initial database bootstrap failed: ${bootstrap.stderr || bootstrap.error?.message || ''}`,
    );

    writer = new DatabaseSync(databasePath);
    writer.exec('PRAGMA busy_timeout = 0');
    writer.exec('BEGIN IMMEDIATE');

    const concurrentStartup = startDatabaseModule(databasePath);
    assert.equal(
      concurrentStartup.status,
      0,
      `an already-migrated startup must not require a write lock: ${concurrentStartup.stderr || concurrentStartup.error?.message || ''}`,
    );
  } finally {
    if (writer) {
      try {
        writer.exec('ROLLBACK');
      } finally {
        writer.close();
      }
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
