import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createVerifiedSqliteBackup } from '../../server/sqlite_backup.mjs';

const root = mkdtempSync(join(tmpdir(), 'scopeweave-backup-source-race-'));
try {
  const sourcePath = join(root, 'source.db');
  const replacementPath = join(root, 'replacement.db');
  const displacedPath = join(root, 'source-original.db');
  const destinationPath = join(root, 'backup.db');

  const source = new DatabaseSync(sourcePath);
  source.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE project_records(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO project_records(name) VALUES ('original-project');
  `);
  source.close();

  const replacement = new DatabaseSync(replacementPath);
  replacement.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE project_records(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO project_records(name) VALUES ('replacement-project');
  `);
  replacement.close();

  assert.throws(
    () => createVerifiedSqliteBackup({
      sourcePath,
      destinationPath,
      snapshot({ database, destinationPath: temporaryPath }) {
        // Simulate a deployment/attacker replacing the configured database
        // pathname after ScopeWeave has already opened the original inode.
        renameSync(sourcePath, displacedPath);
        renameSync(replacementPath, sourcePath);
        database.prepare('VACUUM INTO ?').run(temporaryPath);
      },
    }),
    (error) => error?.code === 'source_changed_during_backup',
  );
  assert.equal(existsSync(destinationPath), false);

  const configured = new DatabaseSync(sourcePath, { readOnly: true });
  assert.equal(
    configured.prepare('SELECT name FROM project_records').get().name,
    'replacement-project',
  );
  configured.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('sqlite backup source replacement regression passed');
