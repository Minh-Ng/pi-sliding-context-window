import { statfsSync } from "node:fs";
import {
  cleanupExpiredProtections,
  setEmergencyMode,
} from "../rocksdb/retention.js";
import { cleanupAbandonedHints } from "../retrieval/hints.js";
import { cleanupExpiredLeases } from "../retrieval/leases.js";
import {
  DEFAULT_POSTING_ROLLBACK_GRACE_MS,
  runPostingStorageMaintenance,
} from "../rocksdb/posting-storage-maintenance.js";

export const DEFAULT_MAINTENANCE_OPTIONS = Object.freeze({
  intervalMs: 60_000,
  retentionBatchSize: 256,
  maxRetentionWaves: 4,
  protectionCleanupLimit: 1_000,
  leaseCleanupLimit: 1_000,
  hintCleanupLimit: 1_000,
  postingStorageLimit: 10_000,
  postingRollbackGraceMs: DEFAULT_POSTING_ROLLBACK_GRACE_MS,
  compactionDeletedKeys: 10_000,
  compactionReclaimableBytes: 256 * 1024 * 1024,
  criticalFreeBytes: 2 * 1024 * 1024 * 1024,
  admissionReserveBytes: 64 * 1024 * 1024,
});

function nonNegativeInteger(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return number;
}

export function filesystemFreeBytes(path) {
  try {
    const value = statfsSync(path, { bigint: true });
    const freeBytes = Number(value.bavail * value.bsize);
    return Number.isSafeInteger(freeBytes) && freeBytes >= 0 ? freeBytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One daemon-wide, non-overlapping maintenance loop. Each tick performs a
 * bounded amount of logical cleanup and lets later ticks continue the cursor.
 */
export class DaemonMaintenance {
  constructor(store, {
    runRetention,
    compact,
    recordError = () => {},
    now = Date.now,
    readFreeBytes = filesystemFreeBytes,
    updateEmergencyMode = (request) => setEmergencyMode(store, request),
    cleanupProtections = cleanupExpiredProtections,
    cleanupLeases = cleanupExpiredLeases,
    cleanupHints = cleanupAbandonedHints,
    maintainPostingStorage = typeof store?.get === "function"
      ? runPostingStorageMaintenance
      : async () => ({ deletedKeys: 0 }),
    ...options
  } = {}) {
    if (!store || typeof store.properties !== "function" || typeof store.path !== "string") {
      throw new TypeError("Daemon maintenance requires a RocksStore-compatible store.");
    }
    if (typeof runRetention !== "function") throw new TypeError("runRetention is required.");
    if (typeof compact !== "function") throw new TypeError("compact is required.");
    for (const [callback, label] of [
      [recordError, "recordError"],
      [now, "now"],
      [readFreeBytes, "readFreeBytes"],
      [updateEmergencyMode, "updateEmergencyMode"],
      [cleanupProtections, "cleanupProtections"],
      [cleanupLeases, "cleanupLeases"],
      [cleanupHints, "cleanupHints"],
      [maintainPostingStorage, "maintainPostingStorage"],
    ]) {
      if (typeof callback !== "function") throw new TypeError(`${label} must be a function.`);
    }
    this.store = store;
    this.runRetention = runRetention;
    this.compact = compact;
    this.recordError = recordError;
    this.now = now;
    this.readFreeBytes = readFreeBytes;
    this.updateEmergencyMode = updateEmergencyMode;
    this.cleanupProtections = cleanupProtections;
    this.cleanupLeases = cleanupLeases;
    this.cleanupHints = cleanupHints;
    this.maintainPostingStorage = maintainPostingStorage;
    this.intervalMs = positiveInteger(
      options.intervalMs,
      DEFAULT_MAINTENANCE_OPTIONS.intervalMs,
      "maintenance intervalMs",
    );
    this.retentionBatchSize = positiveInteger(
      options.retentionBatchSize,
      DEFAULT_MAINTENANCE_OPTIONS.retentionBatchSize,
      "maintenance retentionBatchSize",
      100_000,
    );
    this.maxRetentionWaves = positiveInteger(
      options.maxRetentionWaves,
      DEFAULT_MAINTENANCE_OPTIONS.maxRetentionWaves,
      "maintenance maxRetentionWaves",
      100,
    );
    this.protectionCleanupLimit = positiveInteger(
      options.protectionCleanupLimit,
      DEFAULT_MAINTENANCE_OPTIONS.protectionCleanupLimit,
      "maintenance protectionCleanupLimit",
      100_000,
    );
    this.leaseCleanupLimit = positiveInteger(
      options.leaseCleanupLimit,
      DEFAULT_MAINTENANCE_OPTIONS.leaseCleanupLimit,
      "maintenance leaseCleanupLimit",
      100_000,
    );
    this.hintCleanupLimit = positiveInteger(
      options.hintCleanupLimit,
      DEFAULT_MAINTENANCE_OPTIONS.hintCleanupLimit,
      "maintenance hintCleanupLimit",
      100_000,
    );
    this.postingStorageLimit = positiveInteger(
      options.postingStorageLimit,
      DEFAULT_MAINTENANCE_OPTIONS.postingStorageLimit,
      "maintenance postingStorageLimit",
      100_000,
    );
    this.postingRollbackGraceMs = nonNegativeInteger(
      options.postingRollbackGraceMs,
      DEFAULT_MAINTENANCE_OPTIONS.postingRollbackGraceMs,
      "maintenance postingRollbackGraceMs",
    );
    this.compactionDeletedKeys = positiveInteger(
      options.compactionDeletedKeys,
      DEFAULT_MAINTENANCE_OPTIONS.compactionDeletedKeys,
      "maintenance compactionDeletedKeys",
    );
    this.compactionReclaimableBytes = positiveInteger(
      options.compactionReclaimableBytes,
      DEFAULT_MAINTENANCE_OPTIONS.compactionReclaimableBytes,
      "maintenance compactionReclaimableBytes",
    );
    this.criticalFreeBytes = nonNegativeInteger(
      options.criticalFreeBytes,
      DEFAULT_MAINTENANCE_OPTIONS.criticalFreeBytes,
      "maintenance criticalFreeBytes",
    );
    this.admissionReserveBytes = nonNegativeInteger(
      options.admissionReserveBytes,
      DEFAULT_MAINTENANCE_OPTIONS.admissionReserveBytes,
      "maintenance admissionReserveBytes",
    );
    this.running = undefined;
    this.timer = undefined;
    this.closed = false;
    this.lastEmergencyMode = undefined;
    this.lastFreeBytes = undefined;
    this.deletedKeysSinceCompaction = 0;
    this.pendingCompaction = undefined;
  }

  start() {
    if (this.closed) throw new Error("Closed daemon maintenance cannot be restarted.");
    if (this.timer) return this;
    this.timer = setInterval(() => { void this.trigger(); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  async initialize() {
    const now = nonNegativeInteger(this.now(), undefined, "maintenance clock");
    const disk = this.diskSnapshot();
    await this.synchronizeEmergencyMode(disk, now);
    await this.runAuxiliaryCleanup(now);
    this.start();
    return this;
  }

  trigger() {
    if (this.closed) return Promise.resolve(undefined);
    if (this.running) return this.running;
    let work;
    work = this.runOnce().catch((error) => {
      this.recordError(error);
      return Object.freeze({ status: "error" });
    }).finally(() => {
      if (this.running === work) this.running = undefined;
    });
    this.running = work;
    return work;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  diskSnapshot() {
    const freeBytes = this.readFreeBytes(this.store.path);
    const emergencyMode = this.criticalFreeBytes > 0
      && freeBytes !== undefined
      && freeBytes <= this.criticalFreeBytes;
    this.lastFreeBytes = freeBytes;
    return Object.freeze({ freeBytes, emergencyMode });
  }

  async synchronizeEmergencyMode(snapshot, now) {
    if (snapshot.freeBytes === undefined) return;
    if (snapshot.emergencyMode === this.lastEmergencyMode) return;
    await this.updateEmergencyMode({
      emergencyMode: snapshot.emergencyMode,
      freeBytes: snapshot.freeBytes,
      criticalFreeBytes: this.criticalFreeBytes,
      now,
    });
    this.lastEmergencyMode = snapshot.emergencyMode;
  }

  assertCanAdmit(estimatedWriteBytes = 0, observedFreeBytes) {
    const size = nonNegativeInteger(estimatedWriteBytes, 0, "estimatedWriteBytes");
    if (this.criticalFreeBytes === 0) return;
    const freeBytes = arguments.length > 1
      ? observedFreeBytes
      : this.readFreeBytes(this.store.path);
    if (freeBytes === undefined) return;
    this.lastFreeBytes = freeBytes;
    const reserve = Math.max(this.admissionReserveBytes, Math.min(Number.MAX_SAFE_INTEGER, size * 2));
    const requiredFreeBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.criticalFreeBytes + reserve,
    );
    if (freeBytes > requiredFreeBytes) return;
    const error = new Error("Archive write rejected because filesystem free space is critically low.");
    error.code = "DISK_LOW";
    error.details = {
      freeBytes,
      criticalFreeBytes: this.criticalFreeBytes,
      admissionReserveBytes: reserve,
    };
    throw error;
  }

  async checkAdmission(estimatedWriteBytes = 0) {
    const now = nonNegativeInteger(this.now(), undefined, "maintenance clock");
    const disk = this.diskSnapshot();
    await this.synchronizeEmergencyMode(disk, now);
    this.assertCanAdmit(estimatedWriteBytes, disk.freeBytes);
  }

  async runAuxiliaryCleanup(now) {
    const protections = await this.cleanupProtections(this.store, {
      now,
      limit: this.protectionCleanupLimit,
    });
    const leases = await this.cleanupLeases(this.store, {
      now,
      limit: this.leaseCleanupLimit,
    });
    const hints = await this.cleanupHints(this.store, {
      now,
      limit: this.hintCleanupLimit,
    });
    const postingStorage = await this.maintainPostingStorage(this.store, {
      now,
      limit: this.postingStorageLimit,
      rollbackGraceMs: this.postingRollbackGraceMs,
    });
    return Object.freeze({ protections, leases, hints, postingStorage });
  }

  async runOnce() {
    const now = nonNegativeInteger(this.now(), undefined, "maintenance clock");
    const disk = this.diskSnapshot();
    await this.synchronizeEmergencyMode(disk, now);
    const cleanup = await this.runAuxiliaryCleanup(now);
    let waves = 0;
    let tombstoned = 0;
    let deletedKeys = cleanup.postingStorage?.deletedKeys ?? 0;
    let retentionStatus = "complete";
    for (; waves < this.maxRetentionWaves; waves += 1) {
      const result = await this.runRetention({
        now,
        force: disk.emergencyMode,
        batchSize: this.retentionBatchSize,
      });
      tombstoned += result.tombstoned;
      deletedKeys += result.deletedKeys;
      retentionStatus = result.status;
      if (result.status !== "more-work") {
        waves += 1;
        break;
      }
    }
    this.deletedKeysSinceCompaction = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.deletedKeysSinceCompaction + deletedKeys,
    );
    const properties = this.store.properties();
    const reclaimableBytes = Math.max(
      0,
      Number(properties.totalSstBytes ?? 0) - Number(properties.liveDataBytes ?? 0),
    );
    if (this.pendingCompaction !== undefined) {
      const pendingBytes = Number(properties.pendingCompactionBytes ?? 0);
      const reclaimed = Number(properties.totalSstBytes ?? 0)
          < this.pendingCompaction.totalSstBytes
        || reclaimableBytes < this.pendingCompaction.reclaimableBytes
        || (this.pendingCompaction.pendingCompactionBytes > 0 && pendingBytes === 0);
      if (reclaimed) {
        this.deletedKeysSinceCompaction = Math.max(
          0,
          this.deletedKeysSinceCompaction - this.pendingCompaction.deletedKeys,
        );
        this.pendingCompaction = undefined;
      }
    }
    const compactForDeletionCount = this.deletedKeysSinceCompaction >= this.compactionDeletedKeys;
    const compactForReclaimableBytes = this.deletedKeysSinceCompaction > 0
      && reclaimableBytes >= this.compactionReclaimableBytes;
    let compaction;
    if (compactForDeletionCount || compactForReclaimableBytes) {
      compaction = await this.compact(disk.emergencyMode ? "disk-pressure" : "deletion-wave");
      // A maintenance "scheduled" response means only that immutable writes
      // were flushed so RocksDB's own workers can compact them. Keep the
      // deletion trigger armed until an operation reports actual completion;
      // otherwise one flush could permanently suppress reclamation retries.
      if (compaction?.status === "complete") {
        this.deletedKeysSinceCompaction = 0;
        this.pendingCompaction = undefined;
      } else if (compaction?.status === "scheduled") {
        const after = this.store.properties();
        const afterTotalSstBytes = Number(after.totalSstBytes ?? 0);
        const afterReclaimableBytes = Math.max(
          0,
          afterTotalSstBytes - Number(after.liveDataBytes ?? 0),
        );
        const beforePendingBytes = Number(properties.pendingCompactionBytes ?? 0);
        const afterPendingBytes = Number(after.pendingCompactionBytes ?? 0);
        const reclaimedDuringFlush = afterTotalSstBytes < Number(properties.totalSstBytes ?? 0)
          || afterReclaimableBytes < reclaimableBytes
          || (beforePendingBytes > 0 && afterPendingBytes === 0);
        if (reclaimedDuringFlush) {
          this.deletedKeysSinceCompaction = 0;
          this.pendingCompaction = undefined;
        } else if (this.pendingCompaction === undefined) {
          this.pendingCompaction = Object.freeze({
            deletedKeys: this.deletedKeysSinceCompaction,
            totalSstBytes: afterTotalSstBytes,
            reclaimableBytes: afterReclaimableBytes,
            pendingCompactionBytes: afterPendingBytes,
          });
        }
      }
      if (compaction?.status === "error") {
        const error = new Error(compaction.error ?? "Background compaction failed.");
        error.code = "INTERNAL";
        this.recordError(error);
      }
    }
    return Object.freeze({
      status: "complete",
      emergencyMode: disk.emergencyMode,
      waves,
      retentionStatus,
      tombstoned,
      deletedKeys,
      ...cleanup,
      ...(compaction === undefined ? {} : { compaction }),
    });
  }
}
