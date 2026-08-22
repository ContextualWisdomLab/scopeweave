/**
 * ScopeWeave verified SQLite backup and recovery-verification boundary.
 *
 * The operator flow deliberately uses SQLite `VACUUM INTO` to obtain a
 * transactionally consistent snapshot of a live WAL database. It never
 * overwrites an existing destination and never performs destructive restore.
 */
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const MAX_SCHEMA_OBJECTS = 100_000;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const SCHEMA_QUERY_LIMIT = MAX_SCHEMA_OBJECTS + 1;

/** Stable public error used by the backup operator boundary. */
export class SqliteBackupError extends Error {
  /**
   * @param {string} code Stable machine-readable failure code.
   * @param {Error | undefined} cause Optional private causal error.
   */
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'SqliteBackupError';
    this.code = code;
  }
}

function fail(code, cause) {
  return new SqliteBackupError(code, cause);
}

function validatePath(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw fail(code);
  }
  return value;
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function canonicalExistingFile(path, missingCode, regularCode) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fail(missingCode);
    throw error;
  }
  const info = statSync(canonical);
  if (!info.isFile()) throw fail(regularCode);
  return canonical;
}

function canonicalDestination(path) {
  const parent = dirname(path);
  let parentReal;
  try {
    parentReal = realpathSync(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fail('destination_parent_not_found');
    if (error?.code === 'ENOTDIR') throw fail('destination_parent_not_directory');
    throw error;
  }
  if (!statSync(parentReal).isDirectory()) throw fail('destination_parent_not_directory');
  return join(parentReal, basename(path));
}

function sqliteScalar(database, pragma, key) {
  const row = database.prepare(pragma).get();
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) throw fail('database_metadata_invalid');
  return value;
}

/**
 * Inspect an already-open SQLite connection and fail closed on corruption or
 * foreign-key inconsistency.
 *
 * @param {DatabaseSync | {prepare: Function}} database Open database-like object.
 * @param {string} prefix Error-code prefix, for example `source_database`.
 * @returns {{applicationId:number,userVersion:number,schema:Array<object>}}
 */
export function inspectOpenSqliteDatabase(database, prefix) {
  const integrityRows = database.prepare('PRAGMA integrity_check').all();
  if (
    !Array.isArray(integrityRows)
    || integrityRows.length !== 1
    || integrityRows[0]?.integrity_check !== 'ok'
  ) {
    throw fail(`${prefix}_integrity_failed`);
  }

  const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').iterate();
  if (!foreignKeyRows.next().done) {
    throw fail(`${prefix}_foreign_key_failed`);
  }

  const applicationId = sqliteScalar(database, 'PRAGMA application_id', 'application_id');
  const userVersion = sqliteScalar(database, 'PRAGMA user_version', 'user_version');
  const schemaStatement = database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT ${SCHEMA_QUERY_LIMIT}`,
  );
  const schema = [];
  let schemaBytes = 2; // JSON array brackets: []
  for (const row of schemaStatement.iterate()) {
    const normalizedRow = { ...row };
    const separatorBytes = schema.length === 0 ? 0 : 1;
    const rowBytes = Buffer.byteLength(JSON.stringify(normalizedRow), 'utf8');
    if (
      schema.length >= MAX_SCHEMA_OBJECTS
      || schemaBytes + separatorBytes + rowBytes > MAX_SCHEMA_BYTES
    ) {
      throw fail(`${prefix}_schema_too_large`);
    }
    schema.push(normalizedRow);
    schemaBytes += separatorBytes + rowBytes;
  }

  return { applicationId, userVersion, schema };
}

/**
 * Verify one on-disk SQLite database without modifying it.
 *
 * @param {string} databasePath Database file to verify.
 * @returns {{applicationId:number,userVersion:number,schema:Array<object>,bytes:number}}
 */
export function verifySqliteDatabase(databasePath) {
  validatePath(databasePath, 'database_path_invalid');
  let canonical;
  try {
    canonical = canonicalExistingFile(databasePath, 'database_not_found', 'database_not_regular_file');
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw fail('database_verification_failed', error);
  }

  let database;
  try {
    database = new DatabaseSync(canonical, { readOnly: true });
    const metadata = inspectOpenSqliteDatabase(database, 'database');
    const bytes = statSync(canonical).size;
    assertBackupFileSize(bytes);
    return { ...metadata, bytes };
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw fail('database_verification_failed', error);
  } finally {
    try { database?.close(); } catch { /* read-only cleanup cannot change result */ }
  }
}

/**
 * Require positive finite backup size.
 *
 * @param {number} bytes Backup file size.
 */
export function assertBackupFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) throw fail('backup_file_empty');
}

/**
 * Require source and backup SQLite metadata to match exactly.
 *
 * @param {object} sourceMetadata Source metadata.
 * @param {object} backupMetadata Backup metadata.
 */
export function assertBackupMetadataMatches(sourceMetadata, backupMetadata) {
  const source = {
    applicationId: sourceMetadata?.applicationId,
    userVersion: sourceMetadata?.userVersion,
    schema: sourceMetadata?.schema,
  };
  const backup = {
    applicationId: backupMetadata?.applicationId,
    userVersion: backupMetadata?.userVersion,
    schema: backupMetadata?.schema,
  };
  if (!isDeepStrictEqual(source, backup)) throw fail('backup_metadata_mismatch');
}

/** Execute cleanup without allowing a secondary failure to replace the cause. */
export function runBestEffortCleanup(cleanup) {
  try { cleanup(); } catch { /* causal error wins */ }
}

/** Remove an incomplete backup artifact without throwing. */
export function removeIncompleteBackupBestEffort(path) {
  runBestEffortCleanup(() => rmSync(path, { force: true }));
}

function defaultSnapshot({ database, destinationPath }) {
  database.prepare('VACUUM INTO ?').run(destinationPath);
}

function createSecureTemporaryPath(parent) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(parent, `.scopeweave-backup-${process.pid}-${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(candidate, 'wx', 0o600);
      closeSync(descriptor);
      return candidate;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw fail('temporary_path_unavailable');
}

/**
 * Create a verified, non-overwriting SQLite snapshot.
 *
 * The destination parent is resolved once to a canonical directory and every
 * later existence check and publish uses that canonical path. A caller-visible
 * parent symlink therefore cannot redirect the verified artifact after
 * validation while SQLite is snapshotting. Publication is a single no-overwrite
 * hard-link operation; if another process wins that destination name, its file
 * is never treated as cleanup owned by this attempt.
 *
 * @param {{sourcePath:string,destinationPath:string,snapshot?:Function}} options
 * Operator inputs plus an injectable snapshot seam for deterministic tests.
 * @returns {{bytes:number,applicationId:number,userVersion:number,schemaObjects:number}}
 */
export function createVerifiedSqliteBackup({ sourcePath, destinationPath, snapshot = defaultSnapshot } = {}) {
  validatePath(sourcePath, 'source_path_invalid');
  validatePath(destinationPath, 'destination_path_invalid');
  if (typeof snapshot !== 'function') throw fail('snapshot_invalid');

  let sourceReal;
  let destinationReal;
  try {
    sourceReal = canonicalExistingFile(sourcePath, 'source_not_found', 'source_not_regular_file');
    destinationReal = canonicalDestination(destinationPath);
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw fail('sqlite_backup_failed', error);
  }

  if (sourceReal === destinationReal) throw fail('destination_matches_source');
  try {
    if (pathEntryExists(destinationReal)) throw fail('destination_exists');
  } catch (error) {
    if (error instanceof SqliteBackupError) throw error;
    throw fail('sqlite_backup_failed', error);
  }

  const parentReal = dirname(destinationReal);
  let temporaryPath;
  let database;
  try {
    temporaryPath = createSecureTemporaryPath(parentReal);
    database = new DatabaseSync(sourceReal, { readOnly: true });
    database.exec('PRAGMA foreign_keys = ON');
    const sourceMetadata = inspectOpenSqliteDatabase(database, 'source_database');

    snapshot({ database, destinationPath: temporaryPath });
    const bytes = statSync(temporaryPath).size;
    assertBackupFileSize(bytes);
    chmodSync(temporaryPath, 0o600);

    const backupMetadata = verifySqliteDatabase(temporaryPath);
    assertBackupMetadataMatches(sourceMetadata, backupMetadata);

    try {
      linkSync(temporaryPath, destinationReal);
    } catch (error) {
      if (error?.code === 'EEXIST') throw fail('destination_exists');
      throw error;
    }

    // The published hard link points at the already-verified 0600 inode. Once
    // publication succeeds, temporary-name cleanup cannot invalidate that
    // durable logical result or justify deleting a destination we now own.
    runBestEffortCleanup(() => unlinkSync(temporaryPath));

    return {
      bytes,
      applicationId: backupMetadata.applicationId,
      userVersion: backupMetadata.userVersion,
      schemaObjects: backupMetadata.schema.length,
    };
  } catch (error) {
    // Only the unique temporary file is owned before publication. In
    // particular, EEXIST means another process owns destinationReal.
    if (temporaryPath) removeIncompleteBackupBestEffort(temporaryPath);
    if (error instanceof SqliteBackupError) throw error;
    throw fail('sqlite_backup_failed', error);
  } finally {
    runBestEffortCleanup(() => database?.close());
  }
}

/**
 * Execute the standalone operator CLI with stable JSON success/error output.
 *
 * @param {string[]} args CLI arguments excluding node/script names.
 * @param {{log:Function,error:Function}} io Output sink.
 * @returns {0|1} Process-style exit code.
 */
export function runSqliteBackupCli(args, io = console) {
  try {
    if (!Array.isArray(args)) throw fail('usage_invalid');
    let result;
    let operation;
    if (args.length === 3 && args[0] === 'backup') {
      operation = 'backup';
      result = createVerifiedSqliteBackup({ sourcePath: args[1], destinationPath: args[2] });
    } else if (args.length === 2 && args[0] === 'verify') {
      operation = 'verify';
      const verified = verifySqliteDatabase(args[1]);
      result = {
        bytes: verified.bytes,
        applicationId: verified.applicationId,
        userVersion: verified.userVersion,
        schemaObjects: verified.schema.length,
      };
    } else {
      throw fail('usage_invalid');
    }
    try {
      io.log(JSON.stringify({ ok: true, operation, ...result }));
    } catch {
      if (operation !== 'backup') {
        // Verification is read-only and safe to retry. If its result cannot be
        // delivered, fail the command so automation does not treat missing
        // verification evidence as a successful verification.
        throw fail('success_output_failed');
      }
      // Publication is the durable backup boundary. Once it succeeds, a closed
      // output sink must not invite an unsafe retry against the same path.
      runBestEffortCleanup(() => io.error(JSON.stringify({
        ok: true,
        operation: 'backup',
        warning: 'success_output_failed',
        action: 'verify_destination_before_retry',
      })));
      return 0;
    }
    return 0;
  } catch (error) {
    const code = error instanceof SqliteBackupError ? error.code : 'sqlite_backup_failed';
    runBestEffortCleanup(() => io.error(JSON.stringify({ ok: false, error: code })));
    return 1;
  }
}

const directScript = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (directScript) process.exitCode = runSqliteBackupCli(process.argv.slice(2));