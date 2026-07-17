import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ARCHIVED_EVIDENCE_LABEL } from "../evidence-routing.js";
import { CHUNK_FORMAT_VERSION } from "../rocksdb/chunks.js";
import { derivedKeys } from "../rocksdb/derived.js";
import { encodeKey, KEYSPACE, keyFor } from "../rocksdb/keys.js";
import {
  MANIFEST_FORMAT_VERSION,
  manifestKeys,
  prepareDocumentAdmission,
  readCanonicalDocument,
} from "../rocksdb/manifests.js";
import { stableJson, STORE_SCHEMA_VERSION } from "../rocksdb/schema.js";
import {
  normalizeArchiveRetentionPolicy,
  retentionForAdmission,
} from "../daemon/retention-policy.js";
import { SqliteArchiveSource, createSourceBatchFingerprint } from "./sqlite-source.js";
import {
  applyDifferenceAllowlist,
  createShadowDifference,
} from "./shadow.js";

export const MIGRATION_FORMAT_VERSION = 1;
export const MIGRATION_KEYSPACE = "migration";
export const MIGRATION_SOURCE_BUCKET_SIZE = 10_000;
export const MIGRATION_COMPARISON_RUN_LIMIT = 8;
export const MIGRATION_COMPARISON_DETAIL_LIMIT = 256;
export const MIGRATION_COMPARISON_DETAIL_BYTES = 1_048_576;
// A source or manifest may carry several admitted MiB of metadata and
// structural provenance. Count-bounded pages therefore stay deliberately
// small so worst-case records remain below the daemon memory gate.
export const MIGRATION_VERIFICATION_PAGE_SIZE = 1;

const MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION = 1;
const MIGRATION_RETENTION_POLICY = normalizeArchiveRetentionPolicy();
const DIRECT_ROCKSDB_AUTHORITY_SOURCE = "rocksdb://direct-canonical-admission";

const STRUCTURAL_ROLES = new Set(["user", "assistant", "system", "tool", "unknown"]);

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function updateUtf8String(hashValue, value) {
  const chunkCodeUnits = 64 * 1_024;
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + chunkCodeUnits);
    if (end < value.length) {
      const preceding = value.charCodeAt(end - 1);
      const following = value.charCodeAt(end);
      if (preceding >= 0xd800 && preceding <= 0xdbff
        && following >= 0xdc00 && following <= 0xdfff) end -= 1;
    }
    hashValue.update(value.slice(start, end), "utf8");
    start = end;
  }
  return hashValue;
}

function hashUtf8String(value) {
  return updateUtf8String(createHash("sha256"), value).digest("hex");
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

function configuredSourcePath(path) {
  const requested = resolve(identifier(path, "SQLite source path"));
  let cursor = requested;
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(cursor), ...missing);
    } catch (cause) {
      if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") {
        throw new MigrationBlockedError(
          `SQLite source ${requested} cannot be resolved for backend authority.`,
          { sourcePath: requested },
          { cause },
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) return requested;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function canonicalCandidatePath(path) {
  const requested = resolve(identifier(path, "artifactPath"));
  let cursor = requested;
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(cursor), ...missing);
    } catch (cause) {
      if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) return requested;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathInside(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function storeContainsIdentity(root, target) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (sameFileIdentity(statSync(path, { bigint: true }), target)) return true;
      } catch {
        // RocksDB can retire files while this read-only identity check runs.
      }
    }
  }
  return false;
}

function safeVerificationArtifactPath(store, sourcePath, artifactPath) {
  const requested = resolve(artifactPath);
  const candidate = canonicalCandidatePath(requested);
  const storeRequested = resolve(store.path);
  const storeCanonical = realpathSync.native(storeRequested);
  if (pathInside(storeRequested, requested) || pathInside(storeCanonical, candidate)) {
    throw new MigrationBlockedError("Migration verification artifact cannot target the RocksDB store.", {
      artifactPath: requested,
    });
  }
  const protectedSourcePaths = ["", "-wal", "-shm", "-journal"]
    .map((suffix) => canonicalCandidatePath(`${sourcePath}${suffix}`));
  if (protectedSourcePaths.includes(candidate)) {
    throw new MigrationBlockedError("Migration verification artifact cannot overwrite SQLite source files.", {
      artifactPath: requested,
    });
  }
  if (existsSync(candidate)) {
    const target = statSync(candidate, { bigint: true });
    if (!target.isFile()) {
      throw new MigrationBlockedError("Migration verification artifact must target a regular file.");
    }
    for (const protectedPath of protectedSourcePaths) {
      if (existsSync(protectedPath)
        && sameFileIdentity(target, statSync(protectedPath, { bigint: true }))) {
        throw new MigrationBlockedError(
          "Migration verification artifact cannot alias SQLite source files.",
          { artifactPath: requested },
        );
      }
    }
    if (storeContainsIdentity(storeCanonical, target)) {
      throw new MigrationBlockedError(
        "Migration verification artifact cannot alias a RocksDB store file.",
        { artifactPath: requested },
      );
    }
  }
  return Object.freeze({ requested, target: candidate });
}

function writeVerificationArtifact(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, value, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function backendAuthorityRecord(value) {
  if (value === undefined) return undefined;
  if (!value || value.migrationFormatVersion !== MIGRATION_FORMAT_VERSION
    || !["sqlite", "rocksdb"].includes(value.backend)
    || typeof value.sourcePath !== "string" || value.sourcePath.length === 0
    || !Number.isSafeInteger(value.selectedAt) || value.selectedAt < 0) {
    throw new MigrationBlockedError("Backend authority record is malformed.");
  }
  return value;
}

export async function getBackendAuthority(store) {
  return backendAuthorityRecord(await store.get(migrationKeys.backendAuthority()));
}

function backendAuthorityPayload(backend, sourcePath, fields = {}) {
  return {
    migrationFormatVersion: MIGRATION_FORMAT_VERSION,
    backend,
    sourcePath,
    selectedAt: Date.now(),
    ...fields,
  };
}

function sourceDescriptor(info) {
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

function retentionStartedAt(checkpoint) {
  const value = checkpoint?.retentionStartedAt;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MigrationBlockedError(
      "Migration checkpoint has no valid retention start timestamp.",
      { retentionStartedAt: value },
    );
  }
  return value;
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

function statusFor(checkpoint, phase, comparisonFailures = 0, options = {}) {
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

function statusMatchesSource(status, sourcePath) {
  return typeof status?.sourcePath === "string"
    && resolve(status.sourcePath) === sourcePath;
}

function verifiedOfflineReady(status, sourcePath) {
  return status.phase === "offline-ready"
    && status.rollbackEligible === true
    && status.checkpoint?.verification?.status === "passed"
    && statusMatchesSource(status, sourcePath);
}

async function persistBackendAuthority(store, payload) {
  return store.transaction(async (transaction) => {
    const current = backendAuthorityRecord(
      await transaction.get(migrationKeys.backendAuthority()),
    );
    if (current !== undefined) {
      if (current.backend !== payload.backend || current.sourcePath !== payload.sourcePath) {
        throw new MigrationBlockedError(
          `Backend authority is already claimed by ${current.backend}.`,
          { backend: current.backend, sourcePath: current.sourcePath },
        );
      }
      return current;
    }
    await transaction.putImmutable(
      migrationKeys.backendAuthority(),
      payload,
      { kind: "migration-backend-authority" },
    );
    return payload;
  });
}

/**
 * Select RocksDB without relying on a stale config-time source existence check.
 * A fresh store claims permanent authority immediately; a verified migration
 * remains rollback-eligible until its first canonical RocksDB admission.
 */
export async function activateRocksBackend(store, { sourcePath } = {}) {
  const configuredSource = configuredSourcePath(sourcePath);
  const run = async () => {
    const existingAuthority = await getBackendAuthority(store);
    if (existingAuthority?.backend === "sqlite") {
      throw new MigrationBlockedError(
        "RocksDB activation is blocked because SQLite currently owns backend authority.",
        { backend: existingAuthority.backend, sourcePath: existingAuthority.sourcePath },
      );
    }
    const status = await getMigrationStatus(store);
    const sourceExists = existsSync(resolve(sourcePath));
    if (existingAuthority?.backend === "rocksdb") {
      const reconciledMigration = existingAuthority.reason === "migration-authority"
        && status.phase === "rocksdb-authority"
        && statusMatchesSource(status, configuredSource)
        && existingAuthority.sourcePath === configuredSource;
      if (sourceExists && !reconciledMigration) {
        if (existingAuthority.reason === "migration-authority"
          && existingAuthority.sourcePath !== configuredSource) {
          throw new MigrationSourceMismatchError(
            `RocksDB backend authority is bound to ${existingAuthority.sourcePath}, not configured source ${configuredSource}.`,
            { expected: existingAuthority.sourcePath, actual: configuredSource },
          );
        }
        throw new MigrationBlockedError(
          `Permanent RocksDB authority cannot reconcile existing SQLite source ${configuredSource}.`,
          {
            phase: status.phase,
            sourcePath: configuredSource,
            authoritySourcePath: existingAuthority.sourcePath,
            authorityReason: existingAuthority.reason,
          },
        );
      }
      return {
        backend: "rocksdb",
        mode: "authority",
        phase: status.phase,
        sourcePath: existingAuthority.sourcePath,
      };
    }

    if (status.phase === "rocksdb-authority") {
      if (sourceExists && !statusMatchesSource(status, configuredSource)) {
        throw new MigrationSourceMismatchError(
          `The RocksDB authority seal belongs to ${status.sourcePath}, not configured source ${configuredSource}.`,
          { expected: status.sourcePath, actual: configuredSource },
        );
      }
      const authority = await persistBackendAuthority(store, backendAuthorityPayload(
        "rocksdb",
        status.sourcePath ?? configuredSource,
        {
          reason: "migration-authority",
          sourceDatabaseId: status.checkpoint?.sourceDatabaseId,
        },
      ));
      return {
        backend: "rocksdb",
        mode: "authority",
        phase: status.phase,
        sourcePath: authority.sourcePath,
      };
    }

    if (sourceExists) {
      if (status.phase === "offline-ready" && !statusMatchesSource(status, configuredSource)) {
        throw new MigrationSourceMismatchError(
          `The verified migration is for ${status.sourcePath}, not configured source ${configuredSource}.`,
          { expected: status.sourcePath, actual: configuredSource },
        );
      }
      if (!verifiedOfflineReady(status, configuredSource)) {
        throw new MigrationBlockedError(
          `No verified migration permits RocksDB activation while SQLite source ${configuredSource} exists.`,
          { phase: status.phase, sourcePath: configuredSource },
        );
      }
      return {
        backend: "rocksdb",
        mode: "verified-cutover",
        phase: status.phase,
        sourcePath: configuredSource,
      };
    }

    if (status.phase !== "not-started") {
      throw new MigrationBlockedError(
        `RocksDB activation cannot treat a destination in ${status.phase} as a fresh installation.`,
        { phase: status.phase, sourcePath: configuredSource },
      );
    }
    const authority = await persistBackendAuthority(store, backendAuthorityPayload(
      "rocksdb",
      configuredSource,
      { reason: "fresh-install" },
    ));
    return {
      backend: "rocksdb",
      mode: "fresh-authority",
      phase: status.phase,
      sourcePath: authority.sourcePath,
    };
  };
  return typeof store.withExclusiveWrites === "function"
    ? store.withExclusiveWrites(run)
    : run();
}

/** Claim the supported pre-authority SQLite rollback path before opening it. */
export async function claimSqliteBackend(store, { sourcePath } = {}) {
  const configuredSource = configuredSourcePath(sourcePath);
  const run = async () => {
    const existingAuthority = await getBackendAuthority(store);
    const status = await getMigrationStatus(store);
    if (existingAuthority?.backend === "rocksdb" || status.phase === "rocksdb-authority") {
      throw new MigrationBlockedError(
        "SQLite cannot restart after RocksDB authority has been sealed.",
        { phase: status.phase, sourcePath: configuredSource },
      );
    }
    if (existingAuthority?.backend === "sqlite") {
      if (existingAuthority.sourcePath !== configuredSource) {
        throw new MigrationSourceMismatchError(
          "SQLite backend authority is already bound to another source.",
          { expected: existingAuthority.sourcePath, actual: configuredSource },
        );
      }
      return {
        backend: "sqlite",
        phase: status.phase,
        sourcePath: existingAuthority.sourcePath,
      };
    }
    const sqliteSelectionAllowed = status.phase === "not-started"
      || verifiedOfflineReady(status, configuredSource);
    if (!sqliteSelectionAllowed) {
      throw new MigrationBlockedError(
        `SQLite cannot open while offline migration is ${status.phase}.`,
        { phase: status.phase, sourcePath: configuredSource },
      );
    }
    if (status.phase !== "not-started" && !statusMatchesSource(status, configuredSource)) {
      throw new MigrationSourceMismatchError(
        "The RocksDB migration state belongs to another SQLite source.",
        { expected: status.sourcePath, actual: configuredSource },
      );
    }
    const authority = await persistBackendAuthority(store, backendAuthorityPayload(
      "sqlite",
      configuredSource,
      { reason: status.phase === "offline-ready" ? "pre-authority-rollback" : "sqlite-selection" },
    ));
    return {
      backend: "sqlite",
      phase: status.phase,
      sourcePath: authority.sourcePath,
    };
  };
  return typeof store.withExclusiveWrites === "function"
    ? store.withExclusiveWrites(run)
    : run();
}

/** Logical retention is safe only before migration starts or after RocksDB wins. */
export async function migrationRetentionGate(store) {
  const [authority, status] = await Promise.all([
    getBackendAuthority(store),
    getMigrationStatus(store),
  ]);
  const allowed = authority?.backend !== "sqlite"
    && (status.phase === "not-started" || status.phase === "rocksdb-authority");
  return { allowed, phase: status.phase, backend: authority?.backend };
}

function assertSameDatabase(checkpoint, info) {
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

async function persistState(store, checkpoint, status, options = {}) {
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

async function revalidateCheckpoint(store, source, checkpoint, info) {
  const through = checkpoint.lastStableSourceOrderingKey;
  if (through === 0) return;
  let cursor = 0;
  let count = 0;
  let last;
  const chunkCache = {};
  while (cursor < through) {
    const rows = source.readBatch(cursor, 1);
    if (rows.length === 0) break;
    let advanced = false;
    for (const row of rows) {
      if (row.sourceOrderingKey > through) break;
      advanced = true;
      cursor = row.sourceOrderingKey;
      last = row;
      count += 1;
      const expected = expectedMigratedRow(row, info, checkpoint);
      const storedSource = uncachedExactPayload(
        store,
        migrationKeys.source(info.databaseId, row.sourceOrderingKey),
      );
      if (storedSource !== undefined
        && storedSource.sourceRecordFingerprint !== expected.sourceRecord.sourceRecordFingerprint) {
        throw new MigrationSourceMismatchError(
          `A previously completed SQLite migration row changed at ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
      if (stableJson(storedSource) !== stableJson(expected.sourceRecord)) {
        throw new MigrationBlockedError(
          `Previously migrated destination record changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
      const manifest = uncachedExactPayload(store, manifestKeys.document(row.id, 1));
      let canonicalSource;
      try {
        canonicalSource = verifyCanonicalSource(store, manifest, chunkCache);
      } catch (error) {
        throw new MigrationBlockedError(
          `Previously migrated canonical document changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
          { cause: error },
        );
      }
      const expectedStatic = { ...expected.document };
      delete expectedStatic.text;
      const actualStatic = canonicalStaticDocument(manifest);
      if (stableJson(actualStatic) !== stableJson(expectedStatic)
        || canonicalSource.byteLength !== expected.sourceRecord.textByteLength
        || canonicalSource.contentHash !== expected.sourceRecord.textHash) {
        throw new MigrationBlockedError(
          `Previously migrated canonical document changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
    }
    if (!advanced) break;
  }
  if (count !== checkpoint.migratedCount || last?.sourceOrderingKey !== through) {
    throw new MigrationSourceMismatchError("A previously completed SQLite migration range changed.", {
      expected: {
        count: checkpoint.migratedCount,
        throughOrderingKey: through,
      },
      actual: {
        count,
        throughOrderingKey: last?.sourceOrderingKey ?? 0,
      },
    });
  }
}

function structuralMessage(message) {
  return {
    messageKey: identifier(message.messageKey, "structural message key"),
    messageIndex: nonNegativeInteger(message.messageIndex, "structural message index"),
    role: STRUCTURAL_ROLES.has(message.role) ? message.role : "unknown",
    createdAt: nonNegativeInteger(message.createdAt, "structural message timestamp"),
    text: typeof message.text === "string" ? message.text : "",
    questionScore: nonNegativeInteger(message.questionScore, "question score"),
    requestScore: nonNegativeInteger(message.requestScore, "request score"),
    correctionScore: nonNegativeInteger(message.correctionScore, "correction score"),
    answerScore: nonNegativeInteger(message.answerScore, "answer score"),
  };
}

function sourceKeys(source, info) {
  const provenance = source.provenance?.sourceMessages;
  if (provenance?.status === "available" && Array.isArray(provenance.keys)
    && provenance.keys.length > 0) {
    const keys = [...provenance.keys];
    return { sourceKey: keys[0], sourceMessageKeys: keys, sourceKeyStatus: "preserved" };
  }
  const sourceKey = `sqlite:${info.databaseId}:${source.sourceOrderingKey}`;
  return { sourceKey, sourceMessageKeys: [], sourceKeyStatus: "unavailable" };
}

function mappedSource(source, info) {
  for (const [field, value] of [
    ["id", source.id],
    ["sessionId", source.sessionId],
    ["project", source.project],
    ["kind", source.kind],
  ]) identifier(value, `SQLite document ${field}`);
  if (typeof source.text !== "string") {
    throw new TypeError(`SQLite document ${source.id} text must be a string.`);
  }
  nonNegativeInteger(source.createdAt, `SQLite document ${source.id} createdAt`);
  const keys = sourceKeys(source, info);
  const document = {
    documentId: source.id,
    version: 1,
    sourceKey: keys.sourceKey,
    sourceKeyStatus: keys.sourceKeyStatus,
    sessionId: source.sessionId,
    project: source.project,
    kind: source.kind,
    createdAt: source.createdAt,
    text: source.text,
    metadata: structuredClone(source.metadata),
    sourceMessageKeys: keys.sourceMessageKeys,
  };
  const structuralMessages = source.structuralMessages.map(structuralMessage);
  const sourceRecord = {
    migrationFormatVersion: MIGRATION_FORMAT_VERSION,
    sourceDatabaseId: info.databaseId,
    sourceOrderingKey: source.sourceOrderingKey,
    sourceRowId: source.sourceRowId,
    sourceRecordFingerprint: source.sourceRecordFingerprint,
    documentId: source.id,
    documentVersion: 1,
    sourceKey: keys.sourceKey,
    sourceKeyStatus: keys.sourceKeyStatus,
    sourceMessageKeys: structuredClone(keys.sourceMessageKeys),
    textByteLength: Buffer.byteLength(source.text, "utf8"),
    textHash: hashUtf8String(source.text),
    metadataJson: source.metadataJson,
    metadataParse: structuredClone(source.metadataParse),
    provenance: structuredClone(source.provenance),
    structuralMessages: structuredClone(source.structuralMessages),
  };
  return { document, structuralMessages, sourceRecord };
}

function expectedMigratedRow(source, info, checkpoint) {
  const mapped = mappedSource(source, info);
  const retention = retentionForAdmission(MIGRATION_RETENTION_POLICY, {
    kind: mapped.document.kind,
    now: retentionStartedAt(checkpoint),
  });
  return { ...mapped, retention };
}

function uncachedExactPayload(store, key) {
  const identity = stableJson(key);
  const page = store.scan(key, { limit: 2, fillCache: false });
  return page.find((record) => stableJson(record.key) === identity)?.payload;
}

function recallEvidenceHasher(documentId, kind) {
  return createHash("sha256").update(
    `[${ARCHIVED_EVIDENCE_LABEL}]\n\n# ${documentId} (${kind})\n\n`
      + "## Deterministic archived serialization\n",
  );
}

function expectedRecallEvidenceHash(source) {
  return updateUtf8String(
    recallEvidenceHasher(source.id, source.kind),
    source.text,
  ).digest("hex");
}

function canonicalStaticDocument(manifest) {
  return {
    documentId: manifest?.documentId,
    version: manifest?.version,
    sourceKey: manifest?.sourceKey,
    sourceKeyStatus: manifest?.sourceKeyStatus,
    sessionId: manifest?.sessionId,
    project: manifest?.project,
    kind: manifest?.kind,
    createdAt: manifest?.createdAt,
    metadata: manifest?.metadata,
    sourceMessageKeys: manifest?.sourceMessageKeys,
  };
}

/** Validate every canonical occurrence while retaining at most one physical chunk. */
function verifyCanonicalSource(store, manifest, chunkCache = {}) {
  if (!manifest || manifest.manifestFormatVersion !== MANIFEST_FORMAT_VERSION
    || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error("Canonical document manifest is missing or malformed.");
  }
  const content = createHash("sha256");
  const recall = recallEvidenceHasher(manifest.documentId, manifest.kind);
  let cursor = 0;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const reference = manifest.chunks[index];
    if (!reference || reference.ordinal !== index
      || reference.startByte !== cursor
      || !Number.isSafeInteger(reference.endByte) || reference.endByte < reference.startByte
      || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0
      || reference.byteLength !== reference.endByte - reference.startByte
      || typeof reference.chunkId !== "string") {
      throw new Error(`Canonical source chunk reference ${index} is malformed.`);
    }
    let bytes;
    let chunkHash;
    if (chunkCache.chunkId === reference.chunkId) {
      ({ bytes, chunkHash } = chunkCache);
    } else {
      const chunk = uncachedExactPayload(store, manifestKeys.chunk(reference.chunkId));
      if (!chunk || chunk.chunkFormatVersion !== CHUNK_FORMAT_VERSION
        || chunk.chunkId !== reference.chunkId
        || chunk.encoding !== "utf8"
        || typeof chunk.content !== "string") {
        throw new Error(`Canonical source chunk ${reference.chunkId} is missing or malformed.`);
      }
      bytes = Buffer.from(chunk.content, "utf8");
      chunkHash = hash(bytes);
      if (chunk.byteLength !== bytes.length
        || chunk.contentHash !== chunkHash
        || reference.chunkId !== `sha256:${chunkHash}`) {
        throw new Error(`Canonical source chunk ${reference.chunkId} failed integrity validation.`);
      }
      chunkCache.chunkId = reference.chunkId;
      chunkCache.bytes = bytes;
      chunkCache.chunkHash = chunkHash;
    }
    if (reference.byteLength !== bytes.length) {
      throw new Error(`Canonical source chunk ${reference.chunkId} failed occurrence validation.`);
    }
    content.update(bytes);
    recall.update(bytes);
    cursor = reference.endByte;
  }
  const contentHash = content.digest("hex");
  if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength !== cursor
    || manifest.contentHash !== contentHash) {
    throw new Error("Canonical source chunks do not match the document manifest.");
  }
  return {
    byteLength: cursor,
    contentHash,
    recallEvidenceHash: recall.digest("hex"),
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

function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "ERR_MIGRATION_DOCUMENT",
    message: error instanceof Error ? error.message : String(error),
  };
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

function currentSourceInfo(path) {
  const source = SqliteArchiveSource.open(path);
  try {
    return source.info();
  } finally {
    source.close();
  }
}

function assertSnapshotStillCurrent(source, snapshotInfo) {
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

function pushedDifference(differences, type, fields, options) {
  differences.push(createShadowDifference(type, fields, options));
}

function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) =>
    (left < right ? -1 : left > right ? 1 : 0)));
}

function incrementCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Hash and count every evaluated mismatch while retaining only bounded samples.
 * Pass/fail never depends on whether a mismatch fit in the sample budget.
 */
class MigrationDifferenceAccumulator {
  constructor({ allowlist = [], now = Date.now() } = {}) {
    this.allowlist = allowlist;
    this.now = now;
    this.hash = createHash("sha256");
    this.differenceCount = 0;
    this.failureCount = 0;
    this.differenceCounts = new Map();
    this.failureCounts = new Map();
    this.samples = [];
    this.sampleBytes = 0;
    this.finished = undefined;
  }

  push(...candidates) {
    if (this.finished !== undefined) {
      throw new TypeError("Migration differences cannot be added after finalization.");
    }
    for (const candidate of candidates) {
      const evaluated = applyDifferenceAllowlist(
        [candidate],
        this.allowlist,
        this.now,
      )[0];
      const serialized = stableJson(evaluated);
      this.hash.update(serialized);
      this.hash.update("\n");
      this.differenceCount += 1;
      incrementCount(this.differenceCounts, evaluated.type);
      if (!evaluated.allowed) {
        this.failureCount += 1;
        incrementCount(this.failureCounts, evaluated.type);
      }
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (this.samples.length < MIGRATION_COMPARISON_DETAIL_LIMIT
        && bytes <= MIGRATION_COMPARISON_DETAIL_BYTES - this.sampleBytes) {
        this.samples.push(evaluated);
        this.sampleBytes += bytes;
      }
    }
    return this.differenceCount;
  }

  finish() {
    this.finished ??= Object.freeze({
      differenceCount: this.differenceCount,
      failureCount: this.failureCount,
      differenceCounts: Object.freeze(sortedCounts(this.differenceCounts)),
      failureCounts: Object.freeze(sortedCounts(this.failureCounts)),
      comparisonHash: `sha256:${this.hash.digest("hex")}`,
      samples: Object.freeze([...this.samples]),
      sampledDifferenceCount: this.samples.length,
      sampledDifferenceBytes: this.sampleBytes,
      samplesTruncated: this.samples.length < this.differenceCount,
    });
    return this.finished;
  }
}

function* destinationSourceRecords(store, sourceId) {
  let after;
  while (true) {
    const page = store.scan(migrationKeys.sourcePrefix(sourceId), {
      limit: MIGRATION_VERIFICATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    yield* page;
    if (page.length < MIGRATION_VERIFICATION_PAGE_SIZE) break;
    after = page.at(-1).keyBytes;
  }
}

function* destinationCanonicalRecords(store) {
  let after;
  while (true) {
    const page = store.scan([KEYSPACE.DOCUMENT], {
      limit: MIGRATION_VERIFICATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    yield* page;
    if (page.length < MIGRATION_VERIFICATION_PAGE_SIZE) break;
    after = page.at(-1).keyBytes;
  }
}

function comparisonHistory(sourceId, value) {
  if (value === undefined) {
    return {
      migrationComparisonHistoryFormatVersion: MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION,
      sourceDatabaseId: sourceId,
      runs: [],
    };
  }
  if (!value || value.migrationComparisonHistoryFormatVersion
      !== MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION
    || value.sourceDatabaseId !== sourceId || !Array.isArray(value.runs)) {
    throw new MigrationBlockedError("Migration comparison history is malformed.", { sourceId });
  }
  const runs = value.runs.map((run) => {
    if (!run || typeof run.runId !== "string" || run.runId.length === 0
      || !Number.isSafeInteger(run.detectedAt) || run.detectedAt < 0
      || !Number.isSafeInteger(run.persistedDifferenceCount)
      || run.persistedDifferenceCount < 0
      || run.persistedDifferenceCount > MIGRATION_COMPARISON_DETAIL_LIMIT) {
      throw new MigrationBlockedError("Migration comparison history contains an invalid run.", {
        sourceId,
      });
    }
    return run;
  });
  if (runs.length > MIGRATION_COMPARISON_RUN_LIMIT + 1) {
    throw new MigrationBlockedError("Migration comparison history exceeds its bounded run limit.", {
      sourceId,
    });
  }
  return { ...value, runs };
}

function boundedComparisonDetails(differences, runId, detectedAt) {
  const records = [];
  let persistedBytes = 0;
  for (const difference of differences) {
    if (records.length >= MIGRATION_COMPARISON_DETAIL_LIMIT) break;
    const payload = { ...difference, runId, detectedAt };
    const bytes = Buffer.byteLength(stableJson(payload), "utf8");
    if (bytes > MIGRATION_COMPARISON_DETAIL_BYTES - persistedBytes) continue;
    records.push(payload);
    persistedBytes += bytes;
  }
  return { records, persistedBytes };
}

async function persistComparisonRun(store, sourceId, summary, comparison) {
  const runId = randomUUID();
  const detectedAt = Date.now();
  const historyKey = migrationKeys.comparisonHistory(sourceId);
  const checkpointKey = migrationKeys.checkpoint(sourceId);
  // Warm transaction point reads for rocksdb-js, then re-read inside the
  // optimistic transaction so concurrent comparison runs cannot orphan each
  // other's records outside the bounded history.
  await store.get(historyKey);
  await store.get(checkpointKey);
  const details = boundedComparisonDetails(comparison.samples, runId, detectedAt);
  const run = {
    runId,
    detectedAt,
    persistedDifferenceCount: details.records.length,
  };
  await store.transaction(async (transaction) => {
    const previousHistory = comparisonHistory(sourceId, await transaction.get(historyKey));
    const checkpoint = await transaction.get(checkpointKey);
    const candidates = [...previousHistory.runs, run];
    const recentIds = new Set(candidates
      .slice(-MIGRATION_COMPARISON_RUN_LIMIT)
      .map((candidate) => candidate.runId));
    const pinnedRunId = checkpoint?.verification?.runId;
    const retained = candidates.filter((candidate) =>
      recentIds.has(candidate.runId) || candidate.runId === pinnedRunId);
    const retainedIds = new Set(retained.map((candidate) => candidate.runId));
    const evicted = candidates.filter((candidate) => !retainedIds.has(candidate.runId));
    for (let index = 0; index < details.records.length; index += 1) {
      await transaction.put(migrationKeys.comparison(sourceId, runId, index), {
        ...details.records[index],
      }, { kind: "migration-comparison" });
    }
    await transaction.put(migrationKeys.comparisonRun(sourceId, runId), {
      migrationFormatVersion: MIGRATION_FORMAT_VERSION,
      runId,
      detectedAt,
      summary,
      comparisonHash: comparison.comparisonHash,
      differenceCount: comparison.differenceCount,
      failureCount: comparison.failureCount,
      differenceCounts: comparison.differenceCounts,
      failureCounts: comparison.failureCounts,
      persistedDifferenceCount: details.records.length,
      persistedDifferenceBytes: details.persistedBytes,
      detailsTruncated: details.records.length < comparison.differenceCount,
    }, { kind: "migration-comparison-run" });
    await transaction.put(historyKey, {
      migrationComparisonHistoryFormatVersion: MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION,
      sourceDatabaseId: sourceId,
      runs: retained,
      updatedAt: detectedAt,
    }, { kind: "migration-comparison-history" });
    for (const previous of evicted) {
      for (let index = 0; index < previous.persistedDifferenceCount; index += 1) {
        await transaction.remove(migrationKeys.comparison(sourceId, previous.runId, index));
      }
      await transaction.remove(migrationKeys.comparisonRun(sourceId, previous.runId));
    }
  });
  return {
    runId,
    detectedAt,
    comparisonHash: comparison.comparisonHash,
    differenceCount: comparison.differenceCount,
    failureCount: comparison.failureCount,
    persistedDifferenceCount: details.records.length,
    detailsTruncated: details.records.length < comparison.differenceCount,
  };
}

/** Persist sampled recall/search differences and surface non-allowlisted failures in status. */
export async function recordShadowDifferences(store, {
  sourceId,
  kind,
  differences,
  allowlist = [],
  now = Date.now(),
} = {}) {
  identifier(sourceId, "sourceId");
  identifier(kind, "comparison kind");
  if (!Array.isArray(differences)) throw new TypeError("differences must be an array.");
  const accumulator = new MigrationDifferenceAccumulator({ allowlist, now });
  for (const difference of differences) accumulator.push(difference);
  const comparison = accumulator.finish();
  const failures = comparison.failureCount;
  const currentStatus = await getMigrationStatus(store);
  const checkpoint = await store.get(migrationKeys.checkpoint(sourceId));
  if (!checkpoint) throw new MigrationBlockedError("No checkpoint exists for this comparison source.");
  const summary = {
    kind,
    status: failures === 0 ? "passed" : "failed",
    checked: comparison.differenceCount,
    failures,
  };
  const run = await persistComparisonRun(store, sourceId, summary, comparison);
  const status = statusFor(
    checkpoint,
    currentStatus.phase,
    Number(currentStatus.comparisonFailures ?? 0) + failures,
  );
  await persistState(store, checkpoint, status);
  return { ...summary, ...run };
}

/** Verify the complete canonical corpus; every working set and mismatch sample is bounded. */
async function verifyOfflineMigration(store, {
  sourcePath,
  sampleLimit,
  allowlist = [],
  artifactPath,
  now = Date.now(),
} = {}) {
  const currentStatus = await getMigrationStatus(store);
  if (currentStatus.phase === "rocksdb-authority") {
    throw new MigrationBlockedError(
      "The offline verification gate is sealed after the first RocksDB authority write.",
    );
  }
  const resolvedSourcePath = sourcePath ?? currentStatus.sourcePath;
  if (!resolvedSourcePath) throw new TypeError("Migration verification requires sourcePath.");
  if (sampleLimit !== undefined
    && (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 1_000_000)) {
    throw new RangeError("sampleLimit must be between 1 and 1000000.");
  }
  // The completed copy already binds the semantic corpus fingerprint. Open a
  // private read view without scanning every large source row a second time;
  // the exact live database/WAL/journal fingerprint below proves that corpus
  // is still the checkpointed one.
  const source = SqliteArchiveSource.open(resolvedSourcePath, { deferCorpusIdentity: true });
  try {
    const observedInfo = source.info();
    const checkpoint = await store.get(migrationKeys.checkpoint(observedInfo.databaseId));
    if (!checkpoint) throw new MigrationBlockedError("No checkpoint exists for this SQLite source.");
    if (checkpoint.completed !== true) {
      throw new MigrationBlockedError(
        "Offline verification cannot run until the SQLite copy is complete.",
      );
    }
    assertSameDatabase(checkpoint, observedInfo);
    if (stableJson(checkpoint.sourceFileFingerprint)
      !== stableJson(observedInfo.fileFingerprint)) {
      throw new MigrationSourceMismatchError("Migration source files changed after copy.", {
        expected: checkpoint.sourceFileFingerprint,
        actual: observedInfo.fileFingerprint,
      });
    }
    const info = Object.freeze({
      ...observedInfo,
      sourceFingerprint: checkpoint.sourceFingerprint,
      corpusFingerprint: checkpoint.sourceCorpusFingerprint,
    });
    const resolvedArtifact = artifactPath === undefined
      ? undefined
      : safeVerificationArtifactPath(store, info.path, artifactPath);

    const differences = new MigrationDifferenceAccumulator({ allowlist, now });
    let missingDocuments = 0;
    let cursor = 0;
    let checked = 0;
    let sampled = 0;
    const chunkCache = {};
    while (true) {
      const rows = source.readBatch(cursor, MIGRATION_VERIFICATION_PAGE_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.sourceOrderingKey;
        checked += 1;
        const expected = expectedMigratedRow(row, info, checkpoint);
        const storedSource = uncachedExactPayload(
          store,
          migrationKeys.source(info.databaseId, row.sourceOrderingKey),
        );
        const manifest = uncachedExactPayload(store, manifestKeys.document(row.id, 1));
        const options = { allowlist, now };
        if (storedSource === undefined || manifest === undefined) {
          missingDocuments += 1;
          pushedDifference(differences, "missing-canonical", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              sourceRecord: storedSource === undefined,
              canonicalDocument: manifest === undefined,
            },
            actual: null,
          }, options);
          continue;
        }

        if (stableJson(storedSource) !== stableJson(expected.sourceRecord)) {
          pushedDifference(differences, "source-record", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { hash: hash(stableJson(expected.sourceRecord)) },
            actual: { hash: hash(stableJson(storedSource)) },
          }, options);
        }
        if (storedSource.metadataJson !== row.metadataJson
          || stableJson(storedSource.metadataParse) !== stableJson(row.metadataParse)
          || stableJson(storedSource.provenance) !== stableJson(row.provenance)
          || storedSource.sourceRowId !== expected.sourceRecord.sourceRowId
          || storedSource.sourceKey !== expected.sourceRecord.sourceKey
          || storedSource.sourceKeyStatus !== expected.sourceRecord.sourceKeyStatus
          || stableJson(storedSource.sourceMessageKeys)
            !== stableJson(expected.sourceRecord.sourceMessageKeys)) {
          pushedDifference(differences, "provenance", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              metadataJsonHash: hash(row.metadataJson),
              provenanceHash: hash(stableJson(row.provenance)),
            },
            actual: {
              metadataJsonHash: hash(String(storedSource.metadataJson ?? "")),
              provenanceHash: hash(stableJson(storedSource.provenance ?? null)),
            },
          }, options);
        }

        let canonicalSource;
        try {
          canonicalSource = verifyCanonicalSource(store, manifest, chunkCache);
        } catch (error) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { readable: true },
            actual: { readable: false, error: serializedError(error) },
          }, options);
          continue;
        }
        if (expected.sourceRecord.textByteLength !== canonicalSource.byteLength
          || expected.sourceRecord.textHash !== canonicalSource.contentHash) {
          pushedDifference(differences, "text-bytes", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              byteLength: expected.sourceRecord.textByteLength,
              hash: expected.sourceRecord.textHash,
            },
            actual: {
              byteLength: canonicalSource.byteLength,
              hash: canonicalSource.contentHash,
            },
          }, options);
        }
        const expectedWithoutText = { ...expected.document };
        const actualWithoutText = canonicalStaticDocument(manifest);
        delete expectedWithoutText.text;
        if (stableJson(expectedWithoutText) !== stableJson(actualWithoutText)) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { hash: hash(stableJson(expectedWithoutText)) },
            actual: { hash: hash(stableJson(actualWithoutText)) },
          }, options);
        }
        if (manifest.retentionClass !== expected.retention.retentionClass
          || manifest.expiresAt !== expected.retention.expiresAt) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              retentionClass: expected.retention.retentionClass,
              expiresAt: expected.retention.expiresAt ?? null,
            },
            actual: {
              retentionClass: manifest?.retentionClass ?? null,
              expiresAt: manifest?.expiresAt ?? null,
            },
          }, options);
        }
        if (expected.retention.expiresAt !== undefined) {
          const expiryKey = manifestKeys.expiry(
            expected.retention.expiresAt,
            expected.retention.retentionClass,
            row.id,
            1,
          );
          const expiry = uncachedExactPayload(store, expiryKey);
          const expectedExpiry = {
            documentId: row.id,
            documentVersion: 1,
            retentionClass: expected.retention.retentionClass,
            expiresAt: expected.retention.expiresAt,
          };
          if (stableJson(expiry) !== stableJson(expectedExpiry)) {
            pushedDifference(differences, "canonical-document", {
              documentId: row.id,
              sourceOrderingKey: row.sourceOrderingKey,
              expected: { expiryHash: hash(stableJson(expectedExpiry)) },
              actual: { expiryHash: expiry === undefined ? null : hash(stableJson(expiry)) },
            }, options);
          }
        }
        if (stableJson(manifest?.structuralMessages ?? [])
          !== stableJson(expected.structuralMessages)) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { structuralMessagesHash: hash(stableJson(expected.structuralMessages)) },
            actual: { structuralMessagesHash: hash(stableJson(manifest?.structuralMessages ?? [])) },
          }, options);
        }

        if (sampleLimit === undefined || sampled < sampleLimit) {
          sampled += 1;
          const expectedHash = expectedRecallEvidenceHash(row);
          if (expectedHash !== canonicalSource.recallEvidenceHash) {
            pushedDifference(differences, "recall-evidence", {
              documentId: row.id,
              expected: { hash: expectedHash },
              actual: { hash: canonicalSource.recallEvidenceHash },
            }, options);
          }
        }
      }
    }

    for (const record of destinationSourceRecords(store, info.databaseId)) {
      const orderingKey = Number(record.key.at(-1));
      const expectedKey = Number.isSafeInteger(orderingKey) && orderingKey > 0
        ? migrationKeys.source(info.databaseId, orderingKey)
        : undefined;
      const keyIdentity = stableJson(record.key);
      const expectedKeyIdentity = expectedKey === undefined ? undefined : stableJson(expectedKey);
      const expectedDocumentId = expectedKey === undefined
        ? undefined
        : source.getDocumentIdByOrderingKey(orderingKey);
      if (expectedDocumentId === undefined
        || expectedDocumentId !== record.payload?.documentId
        || keyIdentity !== expectedKeyIdentity) {
        const extraId = record.payload?.documentId ?? `source-order:${String(orderingKey)}`;
        pushedDifference(differences, "extra-canonical", {
          documentId: extraId,
          sourceOrderingKey: Number.isSafeInteger(orderingKey) ? orderingKey : null,
          expected: null,
          actual: { sourceRecordHash: hash(stableJson(record.payload)) },
        }, { allowlist, now });
      }
    }

    for (const record of destinationCanonicalRecords(store)) {
      const documentId = record.key[1];
      const version = record.key[2];
      const expectedKey = typeof documentId === "string"
        ? manifestKeys.document(documentId, 1)
        : undefined;
      if (expectedKey !== undefined
        && stableJson(record.key) === stableJson(expectedKey)
        && source.hasDocumentId(documentId)) continue;
      const renderedDocumentId = String(documentId ?? "unknown-document");
      pushedDifference(differences, "extra-canonical", {
        documentId: renderedDocumentId,
        documentVersion: version,
        expected: null,
        actual: { canonicalManifestHash: hash(stableJson(record.payload)) },
      }, { allowlist, now });
    }

    // Do not certify a private snapshot after the live source advanced while
    // verification was reading it. A retry will compare the new coherent view.
    assertSnapshotStillCurrent(source, info);

    const comparison = differences.finish();
    const failureCount = (type) => comparison.failureCounts[type] ?? 0;
    const result = {
      status: comparison.failureCount === 0 ? "passed" : "failed",
      checked,
      missing: missingDocuments,
      extra: failureCount("extra-canonical"),
      provenanceDifferences: failureCount("provenance"),
      recallDifferences: failureCount("recall-evidence"),
      differences: comparison.differenceCount,
      failures: comparison.failureCount,
      differenceCounts: comparison.differenceCounts,
      failureCounts: comparison.failureCounts,
      comparisonHash: comparison.comparisonHash,
      sampledDifferences: comparison.sampledDifferenceCount,
      samplesTruncated: comparison.samplesTruncated,
    };
    const run = await persistComparisonRun(store, info.databaseId, result, comparison);
    const nextCheckpoint = {
      ...checkpoint,
      verification: {
        status: result.status,
        sourceFingerprint: info.sourceFingerprint,
        corpusFingerprint: info.corpusFingerprint,
        checked,
        failures: comparison.failureCount,
        comparisonHash: comparison.comparisonHash,
        runId: run.runId,
        verifiedAt: run.detectedAt,
      },
      updatedAt: Date.now(),
    };
    if (resolvedArtifact !== undefined) {
      writeVerificationArtifact(resolvedArtifact.target, `${JSON.stringify({
        migrationFormatVersion: MIGRATION_FORMAT_VERSION,
        source: sourceDescriptor(info),
        checkpoint: nextCheckpoint,
        verification: result,
        run,
        differences: comparison.samples,
      }, null, 2)}\n`);
      // Artifact publication is outside RocksDB. Recheck the live rollback
      // source after the filesystem write and before certifying offline-ready.
      assertSnapshotStillCurrent(source, info);
      result.artifactPath = resolvedArtifact.requested;
    }
    const status = statusFor(
      nextCheckpoint,
      comparison.failureCount === 0 ? "offline-ready" : "blocked",
      comparison.failureCount,
      { currentInfo: info },
    );
    await persistState(store, nextCheckpoint, status);
    return result;
  } finally {
    source.close();
  }
}

export async function verifyMigration(store, options = {}) {
  const run = () => verifyOfflineMigration(store, options);
  return typeof store.withExclusiveWrites === "function"
    ? store.withExclusiveWrites(run)
    : run();
}

/**
 * Gate daemon canonical admission during an offline migration. The first new
 * post-verification write carries an authority seal in the same RocksDB
 * transaction as the canonical acknowledgement.
 */
export async function prepareMigrationAdmission(store, {
  requestId,
  documentId,
} = {}) {
  identifier(requestId, "admission requestId");
  identifier(documentId, "admission documentId");
  const readGateState = async (view) => {
    const status = await getMigrationStatus(view);
    const persistedStatus = await view.get(migrationKeys.status());
    const persistedBackendAuthority = backendAuthorityRecord(
      await view.get(migrationKeys.backendAuthority()),
    );
    const sourceId = status.checkpoint?.sourceDatabaseId;
    const persistedCheckpoint = sourceId === undefined
      ? undefined
      : await view.get(migrationKeys.checkpoint(sourceId));
    return { status, persistedStatus, persistedCheckpoint, persistedBackendAuthority };
  };
  let gateState;
  if (typeof store.snapshot === "function") {
    // rocksdb-js optimistic transactions require point reads to be present in
    // the block cache. Warm every gate key before taking the coherent view.
    const warmStatus = await store.get(migrationKeys.status());
    await store.get(migrationKeys.backendAuthority());
    const warmSourceId = warmStatus?.checkpoint?.sourceDatabaseId;
    if (warmSourceId !== undefined) {
      await store.get(migrationKeys.checkpoint(warmSourceId));
      await store.get(migrationKeys.authority(warmSourceId));
    }
    gateState = await store.snapshot(readGateState);
  } else {
    gateState = await readGateState(store);
  }
  const {
    status,
    persistedStatus,
    persistedCheckpoint,
    persistedBackendAuthority,
  } = gateState;
  if (persistedBackendAuthority?.backend === "sqlite") {
    throw new MigrationBlockedError(
      "RocksDB admission is blocked while SQLite owns backend authority.",
      { phase: status.phase, sourcePath: persistedBackendAuthority.sourcePath },
    );
  }
  if (status.phase === "not-started") {
    // Bind the observed absence to the canonical transaction. Migration start
    // runs behind the store's exclusive-write barrier, but it can acquire that
    // barrier after this read and before commitCanonical acquires its shared
    // lease. The absence precondition makes that scheduling window fail closed.
    const directAuthority = persistedBackendAuthority?.backend === "rocksdb"
      ? persistedBackendAuthority
      : backendAuthorityPayload(
          "rocksdb",
          DIRECT_ROCKSDB_AUTHORITY_SOURCE,
          {
            reason: "direct-canonical-admission",
            requestId,
            documentId,
          },
        );
    const preservesFirstAdmission = persistedBackendAuthority?.backend === "rocksdb"
      && persistedBackendAuthority.reason === "direct-canonical-admission"
      && persistedBackendAuthority.requestId === requestId;
    return {
      transitions: persistedBackendAuthority?.backend !== "rocksdb" || preservesFirstAdmission
        ? [{
            key: migrationKeys.backendAuthority(),
            kind: "migration-backend-authority",
            previous: undefined,
            payload: directAuthority,
          }]
        : [],
      mustMatch: [],
      mustBeAbsent: persistedBackendAuthority?.backend === "rocksdb"
        ? []
        : [migrationKeys.status(), migrationKeys.backendAuthority()],
      sealsAuthority: persistedBackendAuthority?.backend !== "rocksdb",
    };
  }
  const checkpoint = status.checkpoint;
  if (!checkpoint?.sourceDatabaseId) {
    throw new MigrationBlockedError("Migration status has no source checkpoint.");
  }
  const authorityKey = migrationKeys.authority(checkpoint.sourceDatabaseId);
  if (status.phase === "rocksdb-authority") {
    const authorityWrite = checkpoint.authorityWrite;
    return authorityWrite?.requestId === requestId
      ? {
          transitions: [
            {
              key: authorityKey,
              kind: "migration-authority-write",
              previous: undefined,
              payload: authorityWrite,
            },
            ...(persistedBackendAuthority?.backend === "rocksdb" ? [{
              key: migrationKeys.backendAuthority(),
              kind: "migration-backend-authority",
              previous: undefined,
              payload: persistedBackendAuthority,
            }] : []),
          ],
          mustMatch: [],
          sealsAuthority: false,
        }
      : { transitions: [], mustMatch: [], sealsAuthority: false };
  }
  if (status.phase !== "offline-ready" || status.rollbackEligible !== true) {
    throw new MigrationBlockedError(
      `RocksDB admission is blocked while offline migration is ${status.phase}.`,
      { phase: status.phase },
    );
  }
  const authorityWrite = {
    migrationFormatVersion: MIGRATION_FORMAT_VERSION,
    sourceDatabaseId: checkpoint.sourceDatabaseId,
    sourceFingerprint: checkpoint.verification.sourceFingerprint,
    verificationRunId: checkpoint.verification.runId,
    requestId,
    documentId,
    sealedAt: Date.now(),
  };
  const backendAuthority = backendAuthorityPayload(
    "rocksdb",
    checkpoint.sourcePath,
    {
      reason: "migration-authority",
      sourceDatabaseId: checkpoint.sourceDatabaseId,
      requestId,
      selectedAt: authorityWrite.sealedAt,
    },
  );
  return {
    mustMatch: [
      {
        key: migrationKeys.status(),
        kind: "migration-status",
        payload: persistedStatus,
      },
      {
        key: migrationKeys.checkpoint(checkpoint.sourceDatabaseId),
        kind: "migration-checkpoint",
        payload: persistedCheckpoint,
      },
    ],
    transitions: [
      {
        key: authorityKey,
        kind: "migration-authority-write",
        previous: undefined,
        payload: authorityWrite,
      },
      {
        key: migrationKeys.backendAuthority(),
        kind: "migration-backend-authority",
        previous: undefined,
        payload: backendAuthority,
      },
    ],
    sealsAuthority: true,
  };
}

export function listMigrationDifferences(store, { sourceId, runId, limit = 1_000 } = {}) {
  positiveInteger(limit, "difference limit");
  const prefix = runId === undefined
    ? [MIGRATION_KEYSPACE, "comparison", identifier(sourceId, "sourceId")]
    : [MIGRATION_KEYSPACE, "comparison", identifier(sourceId, "sourceId"), identifier(runId, "runId")];
  return store.scan(prefix, { limit }).map((record) => record.payload);
}
