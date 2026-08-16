import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteBackupError,
  assertBackupFileSize,
  assertBackupMetadataMatches,
  createVerifiedSqliteBackup,
  inspectOpenSqliteDatabase,
  removeIncompleteBackupBestEffort,
  runBestEffortCleanup,
  runSqliteBackupCli,
  verifySqliteDatabase,
} from '../../server/sqlite_backup.mjs';

const root = mkdtempSync(join(tmpdir(), 'scopeweave-backup-'));
const source = join(root, 'source.db');
const backup = join(root, 'backup.db');
let db = new DatabaseSync(source);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA user_version=7; PRAGMA application_id=1398228556;
CREATE TABLE parent_records(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE child_records(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parent_records(id),value TEXT NOT NULL);
INSERT INTO parent_records(name) VALUES ('portfolio'); INSERT INTO child_records(parent_id,value) VALUES(1,'baseline');`);
db.close();

const result = createVerifiedSqliteBackup({ sourcePath: source, destinationPath: backup });
assert.ok(result.bytes > 0); assert.equal(result.userVersion, 7); assert.equal(result.applicationId, 1398228556);
assert.equal(statSync(backup).mode & 0o777, 0o600);
db = new DatabaseSync(backup, { readOnly: true });
assert.deepEqual(db.prepare('SELECT * FROM child_records').all().map((r) => ({ ...r })), [{ id: 1, parent_id: 1, value: 'baseline' }]); db.close();
const verified = verifySqliteDatabase(backup); assert.equal(verified.userVersion, 7); assert.equal(verified.schema.length, 2);
assert.equal(new SqliteBackupError('sample').code, 'sample');

// Keep a writer connection open in WAL mode and prove committed WAL content is
// present in the consistent snapshot without raw-copying the database/WAL pair.
const liveSource = join(root, 'live-source.db');
const liveBackup = join(root, 'live-backup.db');
const liveWriter = new DatabaseSync(liveSource);
liveWriter.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE live_records(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO live_records(value) VALUES ('committed-before-backup');`);
createVerifiedSqliteBackup({ sourcePath: liveSource, destinationPath: liveBackup });
let liveSnapshot = new DatabaseSync(liveBackup, { readOnly: true });
assert.deepEqual(
  liveSnapshot.prepare('SELECT value FROM live_records ORDER BY id').all().map((row) => ({ ...row })),
  [{ value: 'committed-before-backup' }],
);
liveSnapshot.close();
liveWriter.close();

assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: backup }), (e) => e.code === 'destination_exists');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: source }), (e) => e.code === 'destination_matches_source');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: 4, destinationPath: backup }), (e) => e.code === 'source_path_invalid');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: '', destinationPath: backup }), (e) => e.code === 'source_path_invalid');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: '\0bad', destinationPath: backup }), (e) => e.code === 'source_path_invalid');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: '' }), (e) => e.code === 'destination_path_invalid');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: join(root, 'missing.db'), destinationPath: join(root, 'x.db') }), (e) => e.code === 'source_not_found');
assert.throws(() => verifySqliteDatabase(join(root, 'missing.db')), (e) => e.code === 'database_not_found');
assert.throws(() => verifySqliteDatabase('\0bad'), (e) => e.code === 'database_path_invalid');

const directory = join(root, 'directory'); mkdirSync(directory);
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: directory, destinationPath: join(root, 'd.db') }), (e) => e.code === 'source_not_regular_file');
assert.throws(() => verifySqliteDatabase(directory), (e) => e.code === 'database_not_regular_file');
const notDirectory = join(root, 'not-dir'); writeFileSync(notDirectory, 'x');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: join(notDirectory, 'x.db') }), (e) => e.code === 'destination_parent_not_directory');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: join(root, 'missing-dir', 'x.db') }), (e) => e.code === 'destination_parent_not_found');
const alias = join(root, 'alias'); symlinkSync(root, alias, 'dir');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: join(alias, 'source.db') }), (e) => e.code === 'destination_matches_source');

const corrupt = join(root, 'corrupt.db'); writeFileSync(corrupt, 'not sqlite');
assert.throws(() => verifySqliteDatabase(corrupt), (e) => e.code === 'database_verification_failed');
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: corrupt, destinationPath: join(root, 'corrupt-backup.db') }), (e) => e.code === 'sqlite_backup_failed');
const snapshotFailure = join(root, 'snapshot-failure.db'); assert.throws(() => createVerifiedSqliteBackup({ sourcePath: source, destinationPath: snapshotFailure, snapshot() { throw new Error('snapshot failure'); } }), (e) => e.code === 'sqlite_backup_failed'); assert.equal(existsSync(snapshotFailure), false);
const metadataMismatch = join(root, 'metadata-mismatch.db');
assert.throws(() => createVerifiedSqliteBackup({
  sourcePath: source,
  destinationPath: metadataMismatch,
  snapshot({ destinationPath }) {
    const other = new DatabaseSync(destinationPath);
    other.exec('CREATE TABLE mismatched_records(id INTEGER PRIMARY KEY)');
    other.close();
  },
}), (e) => e.code === 'backup_metadata_mismatch');
assert.equal(existsSync(metadataMismatch), false);

const invalidFk = join(root, 'fk.db'); db = new DatabaseSync(invalidFk); db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parent_records(id INTEGER PRIMARY KEY); CREATE TABLE child_records(parent_id INTEGER REFERENCES parent_records(id)); INSERT INTO child_records(parent_id) VALUES (99);'); db.close();
assert.throws(() => createVerifiedSqliteBackup({ sourcePath: invalidFk, destinationPath: join(root, 'fk-backup.db') }), (e) => e.code === 'source_database_foreign_key_failed');
assert.throws(() => verifySqliteDatabase(invalidFk), (e) => e.code === 'database_foreign_key_failed');

const fake = (integrity, fk = [], scalar = 1, schema = []) => ({ prepare(sql) { return { all() { if (sql === 'PRAGMA integrity_check') return integrity; if (sql === 'PRAGMA foreign_key_check') return fk; return schema; }, get() { return { application_id: scalar, user_version: scalar }; } }; } });
assert.throws(() => inspectOpenSqliteDatabase(fake([], []), 'x'), (e) => e.code === 'x_integrity_failed');
assert.throws(() => inspectOpenSqliteDatabase(fake([{ integrity_check: 'broken' }], []), 'x'), (e) => e.code === 'x_integrity_failed');
assert.throws(() => inspectOpenSqliteDatabase(fake([{ integrity_check: 'ok' }], [{ table: 'x' }]), 'x'), (e) => e.code === 'x_foreign_key_failed');
assert.deepEqual(inspectOpenSqliteDatabase(fake([{ integrity_check: 'ok' }], [], 3, [{ type: 'table', name: 'x', tbl_name: 'x', sql: 'CREATE TABLE x(a)' }]), 'x'), { applicationId: 3, userVersion: 3, schema: [{ type: 'table', name: 'x', tbl_name: 'x', sql: 'CREATE TABLE x(a)' }] });
const meta = { applicationId: 1, userVersion: 2, schema: [] }; assert.doesNotThrow(() => assertBackupMetadataMatches(meta, { ...meta }));
assert.throws(() => assertBackupMetadataMatches(meta, { ...meta, userVersion: 3 }), (e) => e.code === 'backup_metadata_mismatch');
assert.doesNotThrow(() => assertBackupFileSize(1));
assert.throws(() => assertBackupFileSize(Number.NaN), (e) => e.code === 'backup_file_empty');
assert.throws(() => assertBackupFileSize(0), (e) => e.code === 'backup_file_empty');
let cleaned = false; runBestEffortCleanup(() => { cleaned = true; }); assert.equal(cleaned, true);
assert.doesNotThrow(() => runBestEffortCleanup(() => { throw new Error('cleanup failed'); }));
const cleanupFile = join(root, 'cleanup.tmp'); writeFileSync(cleanupFile, 'partial'); removeIncompleteBackupBestEffort(cleanupFile); assert.equal(statSync(root).isDirectory(), true); assert.equal(existsSync(cleanupFile), false);

const messages = { logs: [], errors: [], log(v) { this.logs.push(v); }, error(v) { this.errors.push(v); } };
const cliBackup = join(root, 'cli.db'); assert.equal(runSqliteBackupCli(['backup', source, cliBackup], messages), 0); assert.match(messages.logs.at(-1), /"operation":"backup"/);
assert.equal(runSqliteBackupCli(['verify', cliBackup], messages), 0); assert.match(messages.logs.at(-1), /"operation":"verify"/);
assert.equal(runSqliteBackupCli([], messages), 1); assert.match(messages.errors.at(-1), /usage_invalid/);
assert.equal(runSqliteBackupCli(['verify', join(root, 'missing.db')], messages), 1); assert.match(messages.errors.at(-1), /database_not_found/);
const throwingIo = { log() { throw new Error('sink failed'); }, error(v) { messages.errors.push(v); } };
assert.equal(runSqliteBackupCli(['verify', cliBackup], throwingIo), 1); assert.match(messages.errors.at(-1), /sqlite_backup_failed/);
const directBackup = join(root, 'direct.db');
const direct = spawnSync(process.execPath, [new URL('../../server/sqlite_backup.mjs', import.meta.url).pathname, 'backup', source, directBackup], { encoding: 'utf8', env: process.env });
assert.equal(direct.status, 0, direct.stderr); assert.match(direct.stdout, /"operation":"backup"/);
const directVerify = spawnSync(process.execPath, [new URL('../../server/sqlite_backup.mjs', import.meta.url).pathname, 'verify', directBackup], { encoding: 'utf8', env: process.env });
assert.equal(directVerify.status, 0, directVerify.stderr); assert.match(directVerify.stdout, /"operation":"verify"/);
const directUsage = spawnSync(process.execPath, [new URL('../../server/sqlite_backup.mjs', import.meta.url).pathname], { encoding: 'utf8', env: process.env });
assert.equal(directUsage.status, 1); assert.match(directUsage.stderr, /usage_invalid/);

rmSync(root, { recursive: true, force: true });
console.log('✓ sqlite backup verification tests passed');
