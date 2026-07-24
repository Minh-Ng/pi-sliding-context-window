import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { derivedKeys } from "../rocksdb/derived.js";
import { encodeKey, KEYSPACE, keyFor } from "../rocksdb/keys.js";
import { prepareDocumentAdmission, readCanonicalDocument } from "../rocksdb/manifests.js";
import { stableJson, STORE_SCHEMA_VERSION } from "../rocksdb/schema.js";
import { retentionForAdmission } from "../daemon/retention-policy.js";
import { SqliteArchiveSource, createSourceBatchFingerprint } from "./sqlite-source.js";
import { getBackendAuthority } from "./migration-authority.js";
import { destinationSourceRecords, mappedSource, revalidateCheckpoint } from "./migration-verify.js";
import {
  MIGRATION_FORMAT_VERSION,
  MIGRATION_RETENTION_POLICY,
  MigrationBlockedError,
  MigrationInterruptionError,
  MigrationSourceMismatchError,
  assertSameDatabase,
  assertSnapshotStillCurrent,
  getMigrationStatus,
  hash,
  migrationKeys,
  nonNegativeInteger,
  persistState,
  retentionStartedAt,
  serializedError,
  sourceDescriptor,
  statusFor,
} from "./migration-shared.js";

// Copy phase: snapshot read of a quiesced SQLite archive in idempotent
// checkpointed batches.

// A migrated document is encoded both as canonical records and as exact SQLite
// provenance. Bound the transient encoder and RocksDB memtable footprint for
// unusually large source rows without forcing a flush for ordinary documents.
const MIGRATION_FLUSH_SOURCE_BYTES = 1 * 1_024 * 1_024;
let migrationGarbageCollector;

function migrationSourceBytes(source) {
  let bytes = Buffer.byteLength(source.text, "utf8")
    + Buffer.byteLength(source.metadataJson, "utf8");
  for (const message of source.structuralMessages) {
    bytes += Buffer.byteLength(message.text, "utf8");
  }
  return bytes;
}

function collectMigrationGarbage() {
  if (migrationGarbageCollector === undefined) {
    if (typeof globalThis.gc === "function") migrationGarbageCollector = globalThis.gc;
    else {
      // Node does not expose a direct low-memory notification API. Create one
      // private collector without leaving `gc` on the application global.
      setFlagsFromString("--expose-gc");
      try {
        migrationGarbageCollector = runInNewContext("gc");
      } finally {
        setFlagsFromString("--no-expose-gc");
      }
    }
  }
  migrationGarbageCollector();
}

function initialCheckpoint(info, store) {
  const startedAt = Date.now();
  return {
    checkpointFormatVersion: MIGRATION_FORMAT_VERSION,
    ...sourceDescriptor(info),
    lastStableSourceOrderingKey: 0,
    migratedCount: 0,
    failedCount: 0,
    destinationSchemaVersion: store.schema?.schemaVersion ?? STORE_SCHEMA_VERSION,
    retentionStartedAt: startedAt,
    offline: true,
    completed: false,
    updatedAt: startedAt,
  };
}

export function prepareMigratedDocument(source, info, options = {}) {
  const mapped = mappedSource(source, info);
  const retention = retentionForAdmission(MIGRATION_RETENTION_POLICY, {
    kind: mapped.document.kind,
    now: nonNegativeInteger(options.retentionStartedAt, "migration retentionStartedAt"),
  });
  const request = {
    idempotencyKey: `migration:${info.databaseId}:${source.sourceOrderingKey}`,
    document: mapped.document,
    structuralMessages: mapped.structuralMessages,
    ...retention,
  };
  const admission = prepareDocumentAdmission(request);
  const sourceRecordKey = migrationKeys.source(info.databaseId, source.sourceOrderingKey);
  const encodedSourceRecordKey = encodeKey(sourceRecordKey);
  return {
    ...mapped,
    request,
    admission: {
      ...admission,
      records: [
        ...admission.records,
        {
          key: sourceRecordKey,
          kind: "sqlite-source-document",
          payload: mapped.sourceRecord,
        },
      ],
      transitions: [
        ...admission.transitions,
        {
          key: derivedKeys.reference(
            mapped.document.documentId,
            mapped.document.version,
            encodedSourceRecordKey,
          ),
          kind: "derived-document-reference",
          previous: undefined,
          payload: {
            documentId: mapped.document.documentId,
            documentVersion: mapped.document.version,
            targetKey: encodedSourceRecordKey.toString("base64url"),
          },
        },
      ],
    },
  };
}

async function warmAdmission(store, admission) {
  const keys = [
    keyFor.idempotency(admission.requestId),
    keyFor.counter("outbox"),
    ...admission.records.map((record) => record.key),
  ];
  for (const key of keys) await store.get(key);
}

async function invokeFault(faultInjector, boundary, details) {
  if (typeof faultInjector !== "function") return;
  if (await faultInjector({ boundary, ...details }) === true) {
    throw new MigrationInterruptionError(boundary);
  }
}

async function blockOnFailure(store, checkpoint, status, source, error) {
  const key = migrationKeys.failure(checkpoint.sourceDatabaseId, source.sourceOrderingKey);
  const previous = await store.get(key);
  const unresolved = previous && previous.resolvedAt === undefined;
  const failedCount = checkpoint.failedCount + (unresolved ? 0 : 1);
  const nextCheckpoint = { ...checkpoint, failedCount, updatedAt: Date.now() };
  const nextStatus = statusFor(nextCheckpoint, "blocked", status.comparisonFailures);
  const failure = {
    migrationFormatVersion: MIGRATION_FORMAT_VERSION,
    sourceOrderingKey: source.sourceOrderingKey,
    documentId: source.id,
    attempts: Number(previous?.attempts ?? 0) + 1,
    firstFailedAt: previous?.firstFailedAt ?? Date.now(),
    lastFailedAt: Date.now(),
    error: serializedError(error),
  };
  await store.transaction(async (transaction) => {
    await transaction.put(key, failure, { kind: "migration-failure" });
    await transaction.put(migrationKeys.checkpoint(checkpoint.sourceDatabaseId), nextCheckpoint, {
      kind: "migration-checkpoint",
    });
    await transaction.put(migrationKeys.status(), nextStatus, { kind: "migration-status" });
  });
  throw new MigrationBlockedError(`Migration failed at SQLite ordering key ${source.sourceOrderingKey}.`, {
    sourceOrderingKey: source.sourceOrderingKey,
    documentId: source.id,
    error: failure.error,
  }, { cause: error });
}

async function resolveFailure(store, checkpoint, status, source) {
  const key = migrationKeys.failure(checkpoint.sourceDatabaseId, source.sourceOrderingKey);
  const previous = await store.get(key);
  if (!previous || previous.resolvedAt !== undefined) return { checkpoint, status };
  const nextCheckpoint = {
    ...checkpoint,
    failedCount: Math.max(0, checkpoint.failedCount - 1),
    updatedAt: Date.now(),
  };
  const nextStatus = statusFor(nextCheckpoint, "offline-copy", status.comparisonFailures);
  await store.transaction(async (transaction) => {
    // The checkpoint transition is the durable evidence that the retry
    // succeeded. Keeping an additional resolved row would grow one record per
    // historical retry without adding rollback or recovery information.
    await transaction.remove(key);
    await transaction.put(migrationKeys.checkpoint(checkpoint.sourceDatabaseId), nextCheckpoint, {
      kind: "migration-checkpoint",
    });
    await transaction.put(migrationKeys.status(), nextStatus, { kind: "migration-status" });
  });
  return { checkpoint: nextCheckpoint, status: nextStatus };
}

function batchLimit(value) {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new RangeError("Migration batchSize must be between 1 and 100000.");
  }
  return value;
}

function batchesLimit(value) {
  if (value === undefined || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Migration maxBatches must be a positive integer.");
  }
  return value;
}

function completedSourceInfo(store, info) {
  const corpus = createHash("sha256");
  let documentCount = 0;
  let lastSourceOrderingKey = 0;
  for (const record of destinationSourceRecords(store, info.databaseId)) {
    const orderingKey = Number(record.key.at(-1));
    const fingerprint = record.payload?.sourceRecordFingerprint;
    if (!Number.isSafeInteger(orderingKey) || orderingKey <= lastSourceOrderingKey
      || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new MigrationBlockedError("Migrated source records cannot form a corpus fingerprint.");
    }
    corpus.update(stableJson([orderingKey, fingerprint]));
    corpus.update("\n");
    lastSourceOrderingKey = orderingKey;
    documentCount += 1;
  }
  const corpusFingerprint = corpus.digest("hex");
  const sourceFingerprint = hash(stableJson({
    databaseIdentity: info.databaseIdentity,
    orderingMode: info.orderingMode,
    schemaFingerprint: info.schemaFingerprint,
    corpusFingerprint,
  }));
  return Object.freeze({
    ...info,
    corpusFingerprint,
    sourceFingerprint,
    documentCount,
    lastSourceOrderingKey,
  });
}

async function completeOfflineCopy(store, source, info, checkpoint, status) {
  assertSnapshotStillCurrent(source, info);
  const completedInfo = completedSourceInfo(store, info);
  const nextCheckpoint = {
    ...checkpoint,
    ...sourceDescriptor(completedInfo),
    completed: true,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const nextStatus = statusFor(
    nextCheckpoint,
    "offline-verification",
    status.comparisonFailures,
  );
  await persistState(store, nextCheckpoint, nextStatus);
  return { checkpoint: nextCheckpoint, status: nextStatus };
}

/** Copy a quiesced SQLite archive in idempotent batches. */
async function startOfflineMigration(store, {
  sourcePath,
  batchSize,
  maxBatches,
  faultInjector,
} = {}) {
  // Copy computes the semantic corpus fingerprint from the small migrated
  // source records. Avoid a full-text pre-scan before reading every row again.
  const source = SqliteArchiveSource.open(sourcePath, { deferCorpusIdentity: true });
  try {
    const info = source.info();
    const backendAuthority = await getBackendAuthority(store);
    if (backendAuthority?.backend === "rocksdb") {
      throw new MigrationBlockedError(
        "Offline migration cannot start after RocksDB backend authority is durable.",
        { sourcePath: info.path },
      );
    }
    if (backendAuthority?.backend === "sqlite"
      && backendAuthority.sourcePath !== info.path) {
      throw new MigrationSourceMismatchError(
        "SQLite backend authority belongs to another migration source.",
        { expected: backendAuthority.sourcePath, actual: info.path },
      );
    }
    const limit = batchLimit(batchSize);
    const maximumBatches = batchesLimit(maxBatches);
    let checkpoint = await store.get(migrationKeys.checkpoint(info.databaseId));
    let existingStatus = await getMigrationStatus(store);
    if (existingStatus.phase === "rocksdb-authority") {
      throw new MigrationBlockedError(
        "Offline migration cannot restart after a RocksDB authority write was acknowledged.",
      );
    }
    if (checkpoint === undefined) {
      if (existingStatus.phase !== "not-started"
        && existingStatus.sourceFingerprint !== info.sourceFingerprint) {
        throw new MigrationSourceMismatchError("The destination already tracks another SQLite source.");
      }
      const acknowledgedWrites = Number(await store.get(keyFor.counter("outbox")) ?? 0);
      if (acknowledgedWrites > 0 || store.scan([KEYSPACE.DOCUMENT], { limit: 1 }).length > 0) {
        throw new MigrationBlockedError(
          "Offline migration requires a fresh RocksDB destination with no acknowledged canonical documents.",
        );
      }
      checkpoint = initialCheckpoint(info, store);
      existingStatus = statusFor(checkpoint, "offline-copy", 0);
      await persistState(store, checkpoint, existingStatus, { clearSqliteAuthority: true });
    } else {
      assertSameDatabase(checkpoint, info);
      await revalidateCheckpoint(store, source, checkpoint, info);
      const {
        authorityWrite: _authorityWrite,
        destinationBuckets: _legacyDestinationBuckets,
        gateFailure: _gateFailure,
        verification: _verification,
        ...resumableCheckpoint
      } = checkpoint;
      checkpoint = {
        ...resumableCheckpoint,
        ...sourceDescriptor(info),
        completed: false,
        offline: true,
        updatedAt: Date.now(),
      };
      existingStatus = statusFor(
        checkpoint,
        "offline-copy",
        Number(existingStatus.comparisonFailures ?? 0),
      );
      await persistState(store, checkpoint, existingStatus, { clearSqliteAuthority: true });
    }

    let completedBatches = 0;
    while (completedBatches < maximumBatches) {
      const afterOrderingKey = checkpoint.lastStableSourceOrderingKey;
      const batchFingerprint = createSourceBatchFingerprint();
      let batchCount = 0;
      let firstDocumentId;
      let lastDocumentId;
      let throughOrderingKey = afterOrderingKey;
      while (batchCount < limit) {
        const row = source.readBatch(throughOrderingKey, 1)[0];
        if (row === undefined) break;
        firstDocumentId ??= row.id;
        lastDocumentId = row.id;
        throughOrderingKey = row.sourceOrderingKey;
        batchFingerprint.add(row);
        batchCount += 1;
        let prepared;
        try {
          prepared = prepareMigratedDocument(row, info, {
            retentionStartedAt: retentionStartedAt(checkpoint),
          });
          await warmAdmission(store, prepared.admission);
          await store.commitCanonical(prepared.admission);
          if (migrationSourceBytes(row) >= MIGRATION_FLUSH_SOURCE_BYTES) {
            await store.flush();
            collectMigrationGarbage();
          }
        } catch (error) {
          await blockOnFailure(store, checkpoint, existingStatus, row, error);
        }
        ({ checkpoint, status: existingStatus } = await resolveFailure(
          store,
          checkpoint,
          existingStatus,
          row,
        ));
        await invokeFault(faultInjector, "after-document-commit", {
          sourceOrderingKey: row.sourceOrderingKey,
          documentId: row.id,
        });
      }
      if (batchCount === 0) {
        const completed = await completeOfflineCopy(
          store,
          source,
          info,
          checkpoint,
          existingStatus,
        );
        return { accepted: true, status: completed.status };
      }
      const nextCheckpoint = {
        ...checkpoint,
        lastStableSourceOrderingKey: throughOrderingKey,
        migratedCount: checkpoint.migratedCount + batchCount,
        lastBatch: {
          afterOrderingKey,
          throughOrderingKey,
          count: batchCount,
          firstDocumentId,
          lastDocumentId,
          fingerprint: batchFingerprint.finish(),
        },
        updatedAt: Date.now(),
      };
      await invokeFault(faultInjector, "before-checkpoint", {
        checkpoint: nextCheckpoint,
      });
      const nextStatus = statusFor(
        nextCheckpoint,
        "offline-copy",
        existingStatus.comparisonFailures,
      );
      await persistState(store, nextCheckpoint, nextStatus);
      checkpoint = nextCheckpoint;
      existingStatus = nextStatus;
      completedBatches += 1;
      await invokeFault(faultInjector, "after-checkpoint", { checkpoint });
    }

    if (source.readBatch(checkpoint.lastStableSourceOrderingKey, 1).length === 0) {
      ({ checkpoint, status: existingStatus } = await completeOfflineCopy(
        store,
        source,
        info,
        checkpoint,
        existingStatus,
      ));
    }
    return { accepted: true, status: existingStatus };
  } finally {
    source.close();
  }
}

export async function startMigration(store, options = {}) {
  if (!options || typeof options !== "object" || options.offline !== true) {
    throw new TypeError(
      "Offline migration requires offline: true after every SQLite writer has been stopped.",
    );
  }
  const run = () => startOfflineMigration(store, options);
  return typeof store.withExclusiveWrites === "function"
    ? store.withExclusiveWrites(run)
    : run();
}

export const migrateSqliteArchive = startMigration;

export async function readMigratedDocument(store, sourceId, orderingKey) {
  const sourceRecord = await store.get(migrationKeys.source(sourceId, orderingKey));
  if (sourceRecord === undefined) return undefined;
  const canonical = await readCanonicalDocument(
    store,
    sourceRecord.documentId,
    sourceRecord.documentVersion,
  );
  if (canonical === undefined) return undefined;
  return {
    id: canonical.documentId,
    sessionId: canonical.sessionId,
    project: canonical.project,
    kind: canonical.kind,
    createdAt: canonical.createdAt,
    text: canonical.text,
    metadata: canonical.metadata,
    metadataParse: structuredClone(sourceRecord.metadataParse),
    provenance: structuredClone(sourceRecord.provenance),
  };
}
