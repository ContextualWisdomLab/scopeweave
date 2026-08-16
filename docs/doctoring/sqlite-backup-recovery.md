# Doctoring: verified SQLite backup and recovery

Status: **implemented on active PR only** until merged into protected `develop`.

## Decision

ScopeWeave's supported live SQLite backup path uses SQLite `VACUUM INTO` through the repository's existing Node `DatabaseSync` boundary. It does not raw-copy the live main database file, does not require a journal-mode transition, and does not silently raise the repository's Node runtime floor.

The operator boundary is intentionally narrow:

- backup and read-only verification only;
- no automated destructive restore;
- destination never overwritten;
- secure temporary output reserved with owner-only permissions before snapshot work begins;
- source and backup integrity plus foreign-key checks;
- exact `application_id`, `user_version`, and canonical `sqlite_schema` comparison;
- stable non-secret JSON error codes;
- incomplete output cleanup without replacing the causal failure.

## Primary-source basis

SQLite's current backup documentation identifies the Online Backup API as the original live-backup mechanism and `VACUUM INTO` as an alternative that creates a copy of a live database. The current `VACUUM` documentation likewise defines `VACUUM ... INTO` as a backup-copy mechanism. SQLite's corruption guidance warns that a live database and its rollback journal or WAL represent one logical state; copying only the main file while transactions are active can therefore produce an inconsistent backup. These properties justify letting SQLite materialize the snapshot rather than implementing a filesystem-level copy routine.

ScopeWeave currently supports Node `^22.13.0 || >=23.4.0`. Node's `node:sqlite` `DatabaseSync` API is available in the supported Node 22 line, including read-only database opens and prepared statements. The implementation therefore reuses `DatabaseSync` and parameterized SQL rather than adopting a newer helper that would silently change the runtime contract.

## Requirement-to-evidence traceability

| Requirement | Implementation evidence | Regression evidence |
| --- | --- | --- |
| Consistent live backup | `server/sqlite_backup.mjs` parameterized `VACUUM INTO` | open-writer WAL fixture verifies committed content in the snapshot |
| No destination overwrite | secure temp + hard-link publication | existing destination and source-alias tests fail closed |
| Owner-only output | temporary file reserved at `0600`; published inode retains permissions | final-mode assertion |
| Source corruption/FK rejection | source `integrity_check` and `foreign_key_check` | corrupt and invalid-FK fixtures |
| Backup corruption/FK rejection | independent read-only verification | verify failure fixtures |
| Schema/version fidelity | canonical `sqlite_schema`, `application_id`, `user_version` comparison | injected metadata-mismatch snapshot |
| Stable operator output | `runSqliteBackupCli` emits bounded JSON fields | success, usage, missing-file, output-sink, and direct-process tests |
| No destructive restore | no restore operation exported or accepted by CLI | operator runbook defines manual stopped-writer recovery rehearsal |
| CI/coverage retention | package scripts instrument and execute the module | coverage-script contract locks both the include and regression case |

The first branch commit, `3a04516d8cf3ff7336c47de911daf02faf496ef2`, intentionally added the backup contract before the production module existed. Production implementation followed on the same bounded branch. Later tests strengthened live-WAL and metadata-mismatch evidence without changing the product boundary.

## Security and privacy analysis

The backup may contain all persisted tenant/customer data present in the source database. The command therefore treats the destination as operator-controlled sensitive storage and never uploads it, logs row contents, or prints schema SQL. Stable CLI output is restricted to operation state, file size, SQLite application ID, user version, schema-object count, and error code. Encryption-at-rest, remote replication, key custody, retention, deletion, and geographic residency belong to the deployment/storage layer and must be configured there rather than simulated by this module.

The module rejects source/destination aliasing after canonical path resolution and refuses pre-existing destinations. Temporary snapshot files are created with exclusive creation and `0600` permissions before SQLite writes into them. Publication uses a no-overwrite filesystem operation so a time-of-check/time-of-use collision cannot silently replace an existing operator backup.

## Recovery boundary

A backup is evidence only after verification succeeds. Restoration is deliberately excluded from the executable API because replacing a live SQLite database is destructive and requires writer shutdown, preservation of failed-state evidence, deliberate handling of WAL/SHM companions, and post-start application acceptance. `docs/operations/sqlite-backup-recovery.md` defines that rehearsal without claiming an unmeasured RPO/RTO.

## References

Node.js contributors. (n.d.). *SQLite: Node.js v22 documentation*. Node.js. https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html

SQLite Consortium. (2026). *How to corrupt an SQLite database file*. SQLite. https://www.sqlite.org/howtocorrupt.html

SQLite Consortium. (2026). *SQLite backup API*. SQLite. https://www.sqlite.org/backup.html

SQLite Consortium. (2026). *VACUUM*. SQLite. https://www.sqlite.org/lang_vacuum.html
