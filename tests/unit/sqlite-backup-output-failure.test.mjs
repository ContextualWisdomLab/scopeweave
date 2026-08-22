import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSqliteBackupCli, verifySqliteDatabase } from '../../server/sqlite_backup.mjs';

const root = mkdtempSync(join(tmpdir(), 'scopeweave-backup-output-'));
try {
  const source = join(root, 'source.db');
  const destination = join(root, 'published.db');
  const database = new DatabaseSync(source);
  database.exec('CREATE TABLE backup_output_records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO backup_output_records(value) VALUES (\'durable\');');
  database.close();

  const diagnostics = [];
  const closedSuccessSink = {
    log() {
      throw new Error('success output sink closed');
    },
    error(value) {
      diagnostics.push(JSON.parse(value));
    },
  };

  assert.equal(
    runSqliteBackupCli(['backup', source, destination], closedSuccessSink),
    0,
    'a verified backup that was already published must not be reclassified as a failed backup merely because success output could not be written',
  );
  assert.equal(existsSync(destination), true, 'the published backup must remain durable after output failure');
  assert.doesNotThrow(() => verifySqliteDatabase(destination));
  assert.deepEqual(diagnostics, [{
    ok: true,
    operation: 'backup',
    warning: 'success_output_failed',
    action: 'verify_destination_before_retry',
  }]);

  diagnostics.length = 0;
  assert.equal(
    runSqliteBackupCli(['verify', destination], closedSuccessSink),
    1,
    'verify must report failure when its successful result cannot be delivered because the read-only operation is safe to retry',
  );
  assert.deepEqual(diagnostics, [{
    ok: false,
    error: 'success_output_failed',
  }]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ sqlite backup output-failure contract passed');