// Facade re-exporting the offline SQLite->RocksDB migration public surface.
// Implementation is split by phase across sibling modules:
//   - migration-shared.js: constants, keys, checkpoint/status primitives, errors.
//   - migration-copy.js: snapshot read, idempotent checkpointed batch copy.
//   - migration-verify.js: prefix revalidation and the comparison audit.
//   - migration-authority.js: offline-ready gating, rollback claims, and
//     rocksdb-authority sealing.
// No importer needs to change: every export below matches the pre-split
// public surface used by bin/context-window-migrate.js and the test suite.

export {
  MIGRATION_FORMAT_VERSION,
  MIGRATION_KEYSPACE,
  MIGRATION_SOURCE_BUCKET_SIZE,
  MigrationBlockedError,
  MigrationInterruptionError,
  MigrationSourceMismatchError,
  getMigrationStatus,
  migrationKeys,
} from "./migration-shared.js";

export {
  activateRocksBackend,
  claimSqliteBackend,
  getBackendAuthority,
  migrationRetentionGate,
  prepareMigrationAdmission,
} from "./migration-authority.js";

export {
  migrateSqliteArchive,
  prepareMigratedDocument,
  readMigratedDocument,
  startMigration,
} from "./migration-copy.js";

export {
  MIGRATION_COMPARISON_DETAIL_BYTES,
  MIGRATION_COMPARISON_DETAIL_LIMIT,
  MIGRATION_COMPARISON_RUN_LIMIT,
  MIGRATION_VERIFICATION_PAGE_SIZE,
  listMigrationDifferences,
  recordShadowDifferences,
  verifyMigration,
} from "./migration-verify.js";
