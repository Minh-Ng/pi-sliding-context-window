import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { stableJson } from "../rocksdb/schema.js";
import { normalizeArchiveRetentionPolicy } from "../daemon/retention-policy.js";
import { SqliteArchiveSource } from "./sqlite-source.js";

// Shared primitives (constants, keys, checkpoint/status helpers, error
// classes) used by the copy, verification, and authority phases of the
// offline migration. This module is the common dependency of the other
// migration-*.js siblings; migration.js re-exports the public surface.

export const MIGRATION_FORMAT_VERSION = 1;
export const MIGRATION_KEYSPACE = "migration";
export const MIGRATION_SOURCE_BUCKET_SIZE = 10_000;

export const MIGRATION_RETENTION_POLICY = normalizeArchiveRetentionPolicy();

export function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBucket(orderingKey) {
  return Math.floor((positiveInteger(orderingKey, "source ordering key") - 1)
    / MIGRATION_SOURCE_BUCKET_SIZE);
}

export const migrationKeys = Object.freeze({
  backendAuthority() {
    return [MIGRATION_KEYSPACE, "backend-authority"];
  },
  status() {
    return [MIGRATION_KEYSPACE, "status"];
  },
  checkpoint(sourceId) {
    return [MIGRATION_KEYSPACE, "checkpoint", identifier(sourceId, "sourceId")];
  },
  source(sourceId, orderingKey) {
    return [
      MIGRATION_KEYSPACE,
      "source",
      identifier(sourceId, "sourceId"),
      sourceBucket(orderingKey),
      positiveInteger(orderingKey, "source ordering key"),
    ];
  },
  sourceBucket(sourceId, bucket) {
    return [
      MIGRATION_KEYSPACE,
      "source",
      identifier(sourceId, "sourceId"),
      nonNegativeInteger(bucket, "source bucket"),
    ];
  },
  sourcePrefix(sourceId) {
    return [MIGRATION_KEYSPACE, "source", identifier(sourceId, "sourceId")];
  },
  failure(sourceId, orderingKey) {
    return [
      MIGRATION_KEYSPACE,
      "failure",
      identifier(sourceId, "sourceId"),
      positiveInteger(orderingKey, "source ordering key"),
    ];
  },
  comparison(sourceId, runId, index) {
    return [
      MIGRATION_KEYSPACE,
      "comparison",
      identifier(sourceId, "sourceId"),
      identifier(runId, "runId"),
      nonNegativeInteger(index, "comparison index"),
    ];
  },
  comparisonRun(sourceId, runId) {
    return [
      MIGRATION_KEYSPACE,
      "comparison-run",
      identifier(sourceId, "sourceId"),
      identifier(runId, "runId"),
    ];
  },
  comparisonHistory(sourceId) {
    return [
      MIGRATION_KEYSPACE,
      "comparison-history",
      identifier(sourceId, "sourceId"),
    ];
  },
  authority(sourceId) {
    return [MIGRATION_KEYSPACE, "authority", identifier(sourceId, "sourceId")];
  },
});

export class MigrationSourceMismatchError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "MigrationSourceMismatchError";
    // Source drift is a non-retryable migration admission block on the wire.
    // Keep the class for local callers while using a stable protocol code.
    this.code = "MIGRATION_BLOCKED";
    this.details = details;
  }
}

export class MigrationBlockedError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "MigrationBlockedError";
    this.code = "MIGRATION_BLOCKED";
    this.details = details;
  }
}

export class MigrationInterruptionError extends Error {
  constructor(boundary) {
    super(`Migration interrupted at ${boundary}.`);
    this.name = "MigrationInterruptionError";
    this.code = "ERR_MIGRATION_INTERRUPTED";
    this.boundary = boundary;
  }
}

export function backendAuthorityRecord(value) {
  if (value === undefined) return undefined;
  if (!value || value.migrationFormatVersion !== MIGRATION_FORMAT_VERSION
    || !["sqlite", "rocksdb"].includes(value.backend)
    || typeof value.sourcePath !== "string" || value.sourcePath.length === 0
    || !Number.isSafeInteger(value.selectedAt) || value.selectedAt < 0) {
    throw new MigrationBlockedError("Backend authority record is malformed.");
  }
  return value;
}

export function sourceDescriptor(info) {
  return {
    sourcePath: info.path,
    sourceDatabaseId: info.databaseId,
    sourceDatabaseIdentity: info.databaseIdentity,
    sourceFileFingerprint: info.fileFingerprint,
    sourceFingerprint: info.sourceFingerprint,
    sourceCorpusFingerprint: info.corpusFingerprint,
    sourceSchemaFingerprint: info.schemaFingerprint,
    sourceOrderingMode: info.orderingMode,
  };
}

export function retentionStartedAt(checkpoint) {
  const value = checkpoint?.retentionStartedAt;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MigrationBlockedError(
      "Migration checkpoint has no valid retention start timestamp.",
      { retentionStartedAt: value },
    );
  }
  return value;
}

function currentSourceInfo(path) {
  const source = SqliteArchiveSource.open(path);
  try {
    return source.info();
  } finally {
    source.close();
  }
}

function rollbackEligible(checkpoint, phase, authorityWrite, currentInfo) {
  if (!checkpoint || phase !== "offline-ready" || authorityWrite !== undefined) return false;
  if (checkpoint.verification?.status !== "passed"
    || checkpoint.verification.sourceFingerprint !== checkpoint.sourceFingerprint) return false;
  try {
    const info = currentInfo ?? currentSourceInfo(checkpoint.sourcePath);
    return info.sourceFingerprint === checkpoint.verification.sourceFingerprint
      && stableJson(info.databaseIdentity) === stableJson(checkpoint.sourceDatabaseIdentity);
  } catch {
    return false;
  }
}

export function statusFor(checkpoint, phase, comparisonFailures = 0, options = {}) {
  return {
    phase,
    sourcePath: checkpoint.sourcePath,
    sourceFingerprint: checkpoint.sourceFingerprint,
    migratedCount: checkpoint.migratedCount,
    failedCount: checkpoint.failedCount,
    comparisonFailures,
    rollbackEligible: rollbackEligible(
      checkpoint,
      phase,
      options.authorityWrite,
      options.currentInfo,
    ),
    checkpoint,
  };
}

async function readMigrationStatus(view) {
  const status = await view.get(migrationKeys.status());
  if (status) {
    const sourceId = status.checkpoint?.sourceDatabaseId;
    const authorityWrite = sourceId === undefined
      ? undefined
      : await view.get(migrationKeys.authority(sourceId));
    if (authorityWrite !== undefined) {
      return statusFor(
        { ...status.checkpoint, authorityWrite },
        "rocksdb-authority",
        status.comparisonFailures,
        { authorityWrite },
      );
    }
    if (status.phase === "rocksdb-authority") {
      return statusFor(
        {
          ...status.checkpoint,
          gateFailure: "The persisted RocksDB authority phase has no durable authority seal.",
        },
        "blocked",
        status.comparisonFailures,
      );
    }
    const eligible = rollbackEligible(status.checkpoint, status.phase);
    if (status.phase === "offline-ready" && !eligible) {
      return statusFor(
        {
          ...status.checkpoint,
          gateFailure: "The verified SQLite source changed or became unavailable before RocksDB authority was sealed.",
        },
        "blocked",
        status.comparisonFailures,
      );
    }
    return { ...status, rollbackEligible: eligible };
  }
  return {
    phase: "not-started",
    migratedCount: 0,
    failedCount: 0,
    comparisonFailures: 0,
    rollbackEligible: false,
  };
}

export async function getMigrationStatus(store) {
  return typeof store.snapshot === "function"
    ? store.snapshot(readMigrationStatus)
    : readMigrationStatus(store);
}

export function statusMatchesSource(status, sourcePath) {
  return typeof status?.sourcePath === "string"
    && resolve(status.sourcePath) === sourcePath;
}

export function assertSameDatabase(checkpoint, info) {
  const expected = sourceDescriptor(info);
  for (const field of [
    "sourcePath",
    "sourceDatabaseId",
    "sourceSchemaFingerprint",
    "sourceOrderingMode",
  ]) {
    if (checkpoint[field] !== expected[field]) {
      throw new MigrationSourceMismatchError(`Migration source ${field} changed.`, {
        field,
        expected: checkpoint[field],
        actual: expected[field],
      });
    }
  }
  if (stableJson(checkpoint.sourceDatabaseIdentity) !== stableJson(expected.sourceDatabaseIdentity)) {
    throw new MigrationSourceMismatchError("Migration source database identity changed.", {
      expected: checkpoint.sourceDatabaseIdentity,
      actual: expected.sourceDatabaseIdentity,
    });
  }
}

function assertSameSource(checkpoint, info) {
  assertSameDatabase(checkpoint, info);
  if (checkpoint.sourceFingerprint !== info.sourceFingerprint) {
    throw new MigrationSourceMismatchError("Migration source corpus changed.", {
      field: "sourceFingerprint",
      expected: checkpoint.sourceFingerprint,
      actual: info.sourceFingerprint,
    });
  }
}

export async function persistState(store, checkpoint, status, options = {}) {
  await store.transaction(async (transaction) => {
    if (options.clearSqliteAuthority === true) {
      const authority = backendAuthorityRecord(
        await transaction.get(migrationKeys.backendAuthority()),
      );
      if (authority?.backend === "sqlite") {
        await transaction.remove(migrationKeys.backendAuthority());
      }
    }
    await transaction.put(migrationKeys.checkpoint(checkpoint.sourceDatabaseId), checkpoint, {
      kind: "migration-checkpoint",
    });
    await transaction.put(migrationKeys.status(), status, { kind: "migration-status" });
  });
}

export function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "ERR_MIGRATION_DOCUMENT",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function assertSnapshotStillCurrent(source, snapshotInfo) {
  try {
    source.assertUnchanged();
  } catch (error) {
    throw new MigrationSourceMismatchError(
      "The SQLite source corpus changed after the migration snapshot was captured.",
      { sourcePath: snapshotInfo.path },
      { cause: error },
    );
  }
}
