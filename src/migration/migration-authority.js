import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  MIGRATION_FORMAT_VERSION,
  MigrationBlockedError,
  MigrationSourceMismatchError,
  backendAuthorityRecord,
  getMigrationStatus,
  identifier,
  migrationKeys,
  statusMatchesSource,
} from "./migration-shared.js";

// Status/authority transitions: offline-ready gating, rollback claims, and
// rocksdb-authority sealing. This is the fail-closed backend authority state
// machine; its semantics must not change across the split.

const DIRECT_ROCKSDB_AUTHORITY_SOURCE = "rocksdb://direct-canonical-admission";

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
