# Verified SQLite backup and recovery

Status: **implemented on active PR only** until the owning branch is merged into protected `develop`.

ScopeWeave persists the self-hosted/cloud runtime in SQLite with WAL enabled. A raw copy of only the main database file is not an acceptable live-backup procedure because committed state can still reside in the WAL. The supported operator boundary therefore asks SQLite itself to create a consistent snapshot with `VACUUM INTO`, verifies the snapshot before publication, and never performs an automatic restore.

## Create a backup

Choose a destination on trusted storage that is not the live database path and does not already exist:

```bash
npm run ops:sqlite-backup -- backup "$SCOPEWEAVE_DB" "/secure/backups/scopeweave-$(date +%Y%m%d-%H%M%S).db"
```

The command performs the following fail-closed sequence:

1. Resolve the source and destination parent to canonical filesystem paths and reject source/destination aliasing.
2. Require the source to be a regular file and the destination parent to be an existing directory.
3. Run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` against the source.
4. Capture `application_id`, `user_version`, and a canonical ordered `sqlite_schema` snapshot.
5. Reserve a unique temporary destination with owner-only `0600` permissions.
6. Execute parameterized `VACUUM INTO` against that temporary path while SQLite owns consistency across the live database/WAL state.
7. Verify the produced database independently with integrity and foreign-key checks, positive file size, and exact metadata/schema comparison.
8. Publish the verified inode into the already resolved canonical destination directory with one no-overwrite hard-link operation. If another process wins the destination name first, the backup attempt fails with `destination_exists` and leaves the winner untouched.
9. Remove only the uniquely owned temporary path best-effort; never treat a pre-existing or concurrently created destination as cleanup owned by the losing attempt.

Success and failure output is stable JSON. Failure output contains only a machine-readable error code; raw SQLite/network/path exception text is not emitted by the operator boundary.

## Verify an existing backup

Verification is read-only:

```bash
npm run ops:sqlite-backup -- verify "/secure/backups/scopeweave-20260816-220000.db"
```

A successful response reports file size, SQLite application ID, user version, and schema-object count. It deliberately does not dump schema SQL into operator output.

A backup is not considered usable merely because the file exists. Verification must succeed before the backup enters a retention tier or a recovery rehearsal.

## Recovery rehearsal

ScopeWeave intentionally does **not** provide an automatic destructive restore command. Recovery remains an explicit operator-controlled procedure:

1. Put the service in maintenance mode or stop every ScopeWeave process that can write the database.
2. Preserve the existing database evidence. If the stopped runtime still has `-wal` or `-shm` companions, retain them with the original database for incident analysis; do not copy or discard one live SQLite component independently while writers are active.
3. Run the read-only `verify` command against the selected backup and record the stable verification result.
4. Preserve the original database path before replacement. Restoration must occur only while writers remain stopped.
5. Place the verified backup at the configured database path with owner-only permissions. Do not merge a stale WAL from the failed database with the restored snapshot.
6. Start ScopeWeave and run application acceptance checks covering authentication, organization/project reads, permissions, and representative writes.
7. Run backup verification/integrity checks again against the recovered database after the acceptance pass.
8. Retain the recovery evidence and original failed-state files according to incident and privacy-retention policy.

Do not claim a recovery-time objective, recovery-point objective, or disaster-recovery SLA until repeated protected-environment rehearsals establish measured evidence.

## Operational constraints

- The destination filesystem must support the file operations used by the verified publication path; unsupported filesystems fail closed rather than falling back to an overwriting copy.
- The destination parent is resolved once before snapshot creation. Later caller-visible symlink retargeting cannot redirect the verified publication into another directory.
- The destination name is never reclaimed from another process. Operators should choose unique backup names; a collision fails closed and preserves the existing entry.
- Backup destinations are operator-selected trusted storage. This command does not upload, encrypt, rotate, or retain backups on behalf of the operator.
- `VACUUM INTO` captures committed state. Uncommitted transactions are intentionally absent.
- The command does not mutate application schema, change `journal_mode`, or checkpoint WAL as a prerequisite.
- Backup creation should be scheduled according to the buyer's measured recovery-point requirement once that requirement is formally defined; the repository does not invent an RPO.
- Restore remains separate from backup so a typo or compromised automation cannot overwrite the live database through this interface.

## Verification evidence

The owning regression suite covers a populated relational database, live WAL with an open writer connection, source and backup integrity/FK checks, schema/version matching, destination collisions and aliases, caller-visible parent-symlink retargeting, a competing process that wins the destination name, malformed/corrupt inputs, invalid foreign keys, metadata mismatch, incomplete-snapshot cleanup, owner-only permissions, stable CLI output, and direct CLI invocation. The new module is registered in normal unit CI and the repository's instrumented coverage command.

See `docs/doctoring/sqlite-backup-recovery.md` for the primary-source basis and requirement-to-test traceability.
