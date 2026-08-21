import assert from 'node:assert/strict';
import { constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// This fixture also remains the compatibility proof when the backup connection
// is opened read-only: the writer stays live throughout snapshot creation.
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

// Rehearse recovery through the actual ScopeWeave database bootstrap rather
// than treating a syntactically valid SQLite file as application recovery.
// The writer process exits before the verified snapshot is copied into the
// isolated recovery path, matching the documented stopped-writer procedure.
const dbModuleUrl = new URL('../../server/db.mjs', import.meta.url).href;
const productSource = join(root, 'product-source.db');
const productBackup = join(root, 'product-backup.db');
const recoveredDatabase = join(root, 'product-recovered.db');
const seedProductDatabase = spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { db } = await import(${JSON.stringify(dbModuleUrl)});
  db.prepare('INSERT INTO users(id,email,password_hash,name) VALUES(?,?,?,?)').run(7001, 'recovery@example.test', 'hash', 'Recovery Owner');
  db.prepare('INSERT INTO orgs(id,name,owner_id) VALUES(?,?,?)').run(7101, 'Recovery Org', 7001);
  db.prepare('INSERT INTO memberships(id,org_id,user_id,role) VALUES(?,?,?,?)').run(7201, 7101, 7001, 'owner');
  db.prepare('INSERT INTO projects(id,org_id,name,base_date,tasks_json,created_by) VALUES(?,?,?,?,?,?)').run(7301, 7101, 'Recovered Plan', '2026-08-16', '[{"id":"task-1","task":"Verify recovery"}]', 7001);
  db.close();
`], {
  encoding: 'utf8',
  env: { ...process.env, SCOPEWEAVE_DB: productSource },
});
assert.equal(seedProductDatabase.status, 0, seedProductDatabase.stderr);
createVerifiedSqliteBackup({ sourcePath: productSource, destinationPath: productBackup });
assert.doesNotThrow(() => verifySqliteDatabase(productBackup));
copyFileSync(productBackup, recoveredDatabase, constants.COPYFILE_EXCL);
assert.throws(
  () => copyFileSync(productBackup, recoveredDatabase, constants.COPYFILE_EXCL),
  (error) => error?.code === 'EEXIST',
);
assert.doesNotThrow(() => verifySqliteDatabase(recoveredDatabase));
const recoveredApplication = spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { db } = await import(${JSON.stringify(dbModuleUrl)});
  const recovered = db.prepare(` + "`" + `SELECT projects.name AS project_name, users.email AS owner_email, memberships.role AS member_role
    FROM projects
    JOIN orgs ON orgs.id = projects.org_id
    JOIN users ON users.id = orgs.owner_id
    JOIN memberships ON memberships.org_id = orgs.id AND memberships.user_id = users.id
    WHERE projects.id = ?` + "`" + `).get(7301);
  console.log(JSON.stringify(recovered));
  db.close();
`], {
  encoding: 'utf8',
  env: { ...process.env, SCOPEWEAVE_DB: recoveredDatabase },
});
assert.equal(recoveredApplication.status, 0, recoveredApplication.stderr);
assert.deepEqual(JSON.parse(recoveredApplication.stdout.trim()), {
  project_name: 'Recovered Plan',
  owner_email: 'recovery@example.test',
  member_role: 'owner',
});

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

// Resolve destination authority once, then keep publication bound to that
// canonical directory even if an attacker swaps the caller-visible symlink
// while SQLite is materializing the snapshot.
const trustedDirectory = join(root, 'trusted-directory'); mkdirSync(trustedDirectory);
const redirectedDirectory = join(root, 'redirected-directory'); mkdirSync(redirectedDirectory);
const destinationAlias = join(root, 'destination-alias'); symlinkSync(trustedDirectory, destinationAlias, 'dir');
const symlinkRaceDestination = join(destinationAlias, 'race.db');
createVerifiedSqliteBackup({
  sourcePath: source,
  destinationPath: symlinkRaceDestination,
  snapshot({ database, destinationPath }) {
    database.prepare('VACUUM INTO ?').run(destinationPath);
    unlinkSync(destinationAlias);
    symlinkSync(redirectedDirectory, destinationAlias, 'dir');
  },
});
assert.equal(existsSync(join(trustedDirectory, 'race.db')), true);
assert.equal(existsSync(join(redirectedDirectory, 'race.db')), false);

// A different process that wins the destination-name race owns that path. The
// losing backup attempt must fail without deleting or rewriting the winner.
const raceWinner = join(root, 'race-winner.db');
assert.throws(() => createVerifiedSqliteBackup({
  sourcePath: source,
  destinationPath: raceWinner,
  snapshot({ database, destinationPath }) {
    database.prepare('VACUUM INTO ?').run(destinationPath);
    writeFileSync(raceWinner, 'other-process-won', { flag: 'wx', mode: 0o600 });
  },
}), (e) => e.code === 'destination_exists');
assert.equal(readFileSync(raceWinner, 'utf8'), 'other-process-won');

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

const observedSchemaQueries = [];
const fake = (integrity, fk = [], scalar = 1, schema = []) => ({
  prepare(sql) {
    return {
      all() {
        if (sql === 'PRAGMA integrity_check') return integrity;
        if (sql === 'PRAGMA foreign_key_check') return fk;
        throw new Error('schema metadata must be streamed instead of materialized with all()');
      },
      get() { return { application_id: scalar, user_version: scalar }; },
      *iterate() {
        observedSchemaQueries.push(sql);
        yield* sql === 'PRAGMA foreign_key_check' ? fk : schema;
      },
    };
  },
});
assert.throws(() => inspectOpenSqliteDatabase(fake([], []), 'x'), (e) => e.code === 'x_integrity_failed');
assert.throws(() => inspectOpenSqliteDatabase(fake([{ integrity_check: 'broken' }], []), 'x'), (e) => e.code === 'x_integrity_failed');
assert.throws(() => inspectOpenSqliteDatabase(fake([{ integrity_check: 'ok' }], [{ table: 'x' }]), 'x'), (e) => e.code === 'x_foreign_key_failed');
assert.deepEqual(inspectOpenSqliteDatabase(fake([{ integrity_check: 'ok' }], [], 3, [{ type: 'table', name: 'x', tbl_name: 'x', sql: 'CREATE TABLE x(a)' }]), 'x'), { applicationId: 3, userVersion: 3, schema: [{ type: 'table', name: 'x', tbl_name: 'x', sql: 'CREATE TABLE x(a)' }] });
assert.match(observedSchemaQueries.at(-1), /\bLIMIT\s+100001\s*$/i, 'schema inspection should retain a SQL row bound while streaming');
const oversizedSchema = Array.from({ length: 100_001 }, (_, index) => ({ type: 'table', name: `table_${index}`, tbl_name: `table_${index}`, sql: 'CREATE TABLE x(a)' }));
assert.throws(
  () => inspectOpenSqliteDatabase(fake([{ integrity_check: 'ok' }], [], 3, oversizedSchema), 'x'),
  (e) => e.code === 'x_schema_too_large',
);
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
const backupScript = fileURLToPath(new URL('../../server/sqlite_backup.mjs', import.meta.url));
const directBackup = join(root, 'direct.db');
const direct = spawnSync(process.execPath, [backupScript, 'backup', source, directBackup], { encoding: 'utf8', env: process.env });
assert.equal(direct.status, 0, direct.stderr); assert.match(direct.stdout, /"operation":"backup"/);
const directVerify = spawnSync(process.execPath, [backupScript, 'verify', directBackup], { encoding: 'utf8', env: process.env });
assert.equal(directVerify.status, 0, directVerify.stderr); assert.match(directVerify.stdout, /"operation":"verify"/);
const directUsage = spawnSync(process.execPath, [backupScript], { encoding: 'utf8', env: process.env });
assert.equal(directUsage.status, 1); assert.match(directUsage.stderr, /usage_invalid/);

rmSync(root, { recursive: true, force: true });
console.log('✓ sqlite backup verification tests passed');