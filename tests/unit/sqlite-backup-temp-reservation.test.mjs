import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteBackupError,
  createVerifiedSqliteBackup,
} from '../../server/sqlite_backup.mjs';

if (process.platform === 'linux') {
  const root = mkdtempSync(join(tmpdir(), 'scopeweave-backup-reservation-'));
  const sourcePath = join(root, 'source.db');
  const source = new DatabaseSync(sourcePath);
  source.exec('CREATE TABLE recovery_records(id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  source.close();

  try {
    // GitHub-hosted Server Tests run on Ubuntu. /proc is a real directory but
    // does not permit creating arbitrary regular files, so this exercises the
    // operating-system failure at the exact secure temporary-file reservation
    // boundary without relying on user/umask permission assumptions.
    const destinationPath = join('/proc', `scopeweave-backup-${process.pid}.db`);
    assert.throws(
      () => createVerifiedSqliteBackup({ sourcePath, destinationPath }),
      (error) => error instanceof SqliteBackupError && error.code === 'sqlite_backup_failed',
      'temporary-path reservation failures must preserve the public stable-error contract',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ SQLite temporary reservation failure contract passed');
