# Doctoring: verified SQLite backup and recovery

Status: **implemented on active PR only** until merged into protected `develop`.

## Decision

ScopeWeave's supported live SQLite backup path uses SQLite `VACUUM INTO` through the repository's existing Node `DatabaseSync` boundary. It does not raw-copy the live main database file, does not require a journal-mode transition, and does not silently raise the repository's Node runtime floor.

The operator boundary is intentionally narrow:

- backup and read-only verification only;
- the source backup connection itself is opened read-only while retaining live-WAL `VACUUM INTO` support;
- the canonically resolved source file's filesystem device/inode identity is captured before snapshot work and rechecked after snapshot creation and immediately before publication, so replacing the configured source pathname fails closed rather than publishing a snapshot from a displaced old file;
- no automated destructive restore;
- destination never overwritten;
- destination publication remains bound to the canonically resolved directory even if a caller-visible parent symlink is retargeted during snapshot creation;
- a concurrent process that wins the destination name remains authoritative and is never deleted by the losing backup attempt;
- secure temporary output reserved with owner-only permissions before snapshot work begins;
- source and backup integrity plus foreign-key checks;
- exact `application_id`, `user_version`, and canonical `sqlite_schema` comparison;
- schema inspection streams at most 100,001 rows with `StatementSync.iterate()`, rejects before retaining a 100,001st non-internal schema object, and enforces an 8 MiB UTF-8 budget over the exact serialized JSON array including brackets and separators;
- stable non-secret JSON error codes;
- only uniquely owned temporary output is cleaned up after pre-publication failure, without replacing the causal failure.

## Primary-source basis

SQLite's current backup documentation identifies the Online Backup API as the original live-backup mechanism and `VACUUM INTO` as an alternative that creates a copy of a live database. The current `VACUUM` documentation likewise defines `VACUUM ... INTO` as a backup-copy mechanism and permits the output path to be absent or an empty file. SQLite's corruption guidance warns that a live database and its rollback journal or WAL represent one logical state; copying only the main file while transactions are active can therefore produce an inconsistent backup. These properties justify letting SQLite materialize the snapshot rather than implementing a filesystem-level copy routine.

ScopeWeave currently supports Node `^22.13.0 || >=23.4.0`. Node's `node:sqlite` `DatabaseSync` API is available in the supported Node 22 line, including read-only database opens and prepared statements. The implementation therefore reuses `DatabaseSync` and parameterized SQL rather than adopting a newer helper that would silently change the runtime contract. The live-WAL regression keeps a separate writer connection open while the backup connection runs `VACUUM INTO`, so changing the backup connection to `readOnly: true` retains the buyer-visible live-backup behavior while reducing source-side write authority.

## Requirement-to-evidence traceability

| Requirement | Implementation evidence | Regression evidence |
| --- | --- | --- |
| Consistent live backup | read-only source connection plus parameterized `VACUUM INTO` | open-writer WAL fixture verifies committed content in the snapshot |
| Configured source identity | canonically resolved source path retains its initial filesystem device/inode identity through snapshot work and the pre-publication boundary | source-replacement regression swaps the configured pathname to a different real SQLite database during snapshotting and requires `source_changed_during_backup` with no published destination |
| Bounded schema inspection | `sqlite_schema` query uses `LIMIT 100001`; `StatementSync.iterate()` enforces the 100,000-object and exact 8 MiB serialized UTF-8 budgets before retaining an overflowing row | fake-database contract rejects schema access through `.all()`, streams an oversized row, and requires `source_database_schema_too_large`; object-count regression preserves the row ceiling |
| No destination overwrite | secure temp + atomic no-overwrite hard-link publication | existing destination and source-alias tests fail closed |
| Canonical destination authority | publication uses the destination path resolved under the canonical parent directory | parent-symlink swap during snapshot cannot redirect the final backup |
| Preserve concurrent winner | an `EEXIST` publication failure cleans only the unique temporary path, never the destination | competing publisher fixture remains byte-for-byte intact after the losing attempt fails |
| Owner-only output | temporary file reserved at `0600`; published hard link references the same verified inode | final-mode assertion |
| Source corruption/FK rejection | source `integrity_check` and `foreign_key_check` | corrupt and invalid-FK fixtures |
| Backup corruption/FK rejection | independent read-only verification | verify failure fixtures |
| Schema/version fidelity | canonical `sqlite_schema`, `application_id`, `user_version` comparison | injected metadata-mismatch snapshot |
| Stable operator output | `runSqliteBackupCli` emits bounded JSON fields | success, usage, missing-file, output-sink, and direct-process tests |
| Portable direct-process test path | Node `fileURLToPath` converts the module URL to a filesystem path | backup, verify, and usage subprocess cases share the converted path |
| No destructive restore | no restore operation exported or accepted by CLI | operator runbook defines manual stopped-writer recovery rehearsal |
| CI/coverage retention | package scripts instrument and execute the module | coverage-script contract locks both the include and regression case |

The first branch commit, `3a04516d8cf3ff7336c47de911daf02faf496ef2`, intentionally added the backup contract before the production module existed. Production implementation followed on the same bounded branch. Later tests strengthened live-WAL and metadata-mismatch evidence. Security review then added a parent-symlink retarget regression at `3f55dafba40ace2a2d0192e893d961262878b8e5` and the canonical-directory repair at `1b31a58be5cfca0877252da79980d315369edf3e`. Concurrency review added a competing-publisher regression at `91f0cc411fcd8cd96be2538c8c99836ae4d76f81`; `b7083c6b8e038d1e772a2d43dfae6f804472edbb` corrected ownership so a losing publish attempt cannot delete another process's destination. Review follow-up `037fea3081774d78a80fcf04cab7fe2c1f98de76` added the pre-materialization schema-bound contract, and `2f7339486226730dd2103079b5312e437fcd4794` implemented the bounded query and read-only source connection. Current review hardening then made the byte bound a true memory-side admission control: `34575a38a2d388889c5072a1feb597d4a878f858` made the regression refuse schema `.all()` materialization, and `9322024327d6b6f745c0eca2947bacc1073ed454` changed production to incremental `iterate()` collection with exact JSON-array UTF-8 accounting. The source-replacement lane then followed the same RED-to-GREEN contract: `2822b3466f38c9f8004b46e78bad758aec87ad2a` registered a realistic failing path-replacement regression, and `2c7a241833683268366f8a03bb268e1ad98367cf` bound publication to the originally resolved source file identity.

## Security and privacy analysis

The backup may contain all persisted tenant/customer data present in the source database. The command therefore treats the destination as operator-controlled sensitive storage and never uploads it, logs row contents, or prints schema SQL. Stable CLI output is restricted to operation state, file size, SQLite application ID, user version, schema-object count, and error code. Encryption-at-rest, remote replication, key custody, retention, deletion, and geographic residency belong to the deployment/storage layer and must be configured there rather than simulated by this module.

The module rejects source/destination aliasing after canonical path resolution and refuses pre-existing destinations. It also records the canonically resolved source file's device/inode identity and rechecks that identity after snapshot creation and immediately before publication. A deployment or attacker replacing the configured pathname while the already-open SQLite handle still references the displaced original file therefore causes a fail-closed `source_changed_during_backup` result before the destination is published. Temporary snapshot files are created with exclusive creation and `0600` permissions before SQLite writes into them. Publication uses one no-overwrite hard-link operation into the already resolved canonical destination directory. A caller-visible parent-symlink change therefore cannot redirect publication after validation, and an `EEXIST` race means another process owns the destination; the losing attempt removes only its unique temporary file. This keeps source identity, destination-path authority, and cleanup ownership explicit rather than relying on vulnerable pathname assumptions or check-then-delete sequences.

## Recovery boundary

A backup is evidence only after verification succeeds. Restoration is deliberately excluded from the executable API because replacing a live SQLite database is destructive and requires writer shutdown, preservation of the original database plus any `-wal`, `-shm`, and `-journal` sidecars as one evidence set, deliberate removal of those sidecars from the configured active path before replacement, and post-start application acceptance. `docs/operations/sqlite-backup-recovery.md` defines that rehearsal without claiming an unmeasured RPO/RTO.

## References

Node.js contributors. (n.d.). *SQLite: Node.js v22 documentation*. Node.js. https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html

SQLite Consortium. (n.d.). *How to corrupt an SQLite database file*. SQLite. https://www.sqlite.org/howtocorrupt.html

SQLite Consortium. (n.d.). *SQLite backup API*. SQLite. https://www.sqlite.org/backup.html

SQLite Consortium. (n.d.). *VACUUM*. SQLite. https://www.sqlite.org/lang_vacuum.html
