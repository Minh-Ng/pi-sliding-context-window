import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { stableJson } from "./schema.js";

const MAX_SCAN_LIMIT = 100_000;
const DEFAULT_REWRITE_TRANSACTION_SIZE = 256;

function requireStore(store) {
  if (!store || typeof store.scan !== "function" || typeof store.transaction !== "function"
    || typeof store.compact !== "function" || typeof store.flush !== "function"
    || typeof store.withExclusiveWrites !== "function") {
    throw new TypeError("Compaction requires a writable RocksStore-compatible store.");
  }
  return store;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function payloadDigest(payload) {
  const bytes = Buffer.isBuffer(payload) || payload instanceof Uint8Array
    ? Buffer.from(payload)
    : Buffer.from(stableJson(payload), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function directoryBytes(path) {
  let total = 0;
  const visit = (entryPath) => {
    const stat = lstatSync(entryPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(entryPath)) visit(join(entryPath, entry));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  };
  visit(path);
  return total;
}

/** Physical metrics used to prove that compaction reclaimed bytes. */
export function physicalStoreMetrics(store) {
  requireStore(store);
  const properties = store.properties();
  const liveBlobBytes = store.database?.getDBIntProperty?.("rocksdb.live-blob-file-size") ?? 0;
  return Object.freeze({
    directoryBytes: directoryBytes(store.path),
    totalSstBytes: properties.totalSstBytes,
    liveBlobBytes,
    physicalDataBytes: properties.totalSstBytes + liveBlobBytes,
    liveDataBytes: properties.liveDataBytes,
    pendingCompactionBytes: properties.pendingCompactionBytes,
  });
}

/**
 * Rewrite every retained value in one bounded range into fresh blob files.
 *
 * RocksDB range compaction alone cannot drop a blob file that mixes deleted
 * and live values. This deterministic evacuation preserves logical bytes,
 * then makes the old mixed blob file wholly obsolete and reclaimable.
 */
export async function evacuateLiveValues(store, {
  prefix,
  transactionSize = DEFAULT_REWRITE_TRANSACTION_SIZE,
  maxRecords = MAX_SCAN_LIMIT,
} = {}) {
  requireStore(store);
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new TypeError("Blob evacuation requires a non-empty tuple prefix.");
  }
  const boundedMaximum = positiveInteger(maxRecords, "maxRecords", MAX_SCAN_LIMIT);
  const batchSize = positiveInteger(transactionSize, "transactionSize", 10_000);
  const records = store.scan(prefix, { limit: boundedMaximum });
  const expected = new Map();
  let rewritten = 0;
  let skippedConcurrent = 0;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const outcome = await store.withExclusiveWrites(async () => {
      // Large blob values cannot perform a cold read inside this binding's
      // optimistic transaction. Read the current bytes while writes are
      // excluded, then use one blind transactional rewrite of those bytes.
      const current = [];
      for (const record of batch) {
        const latest = await store.getRecord(record.keyBytes);
        if (latest === undefined) continue;
        current.push(latest);
      }
      await store.transaction(async (transaction) => {
        for (const record of current) {
          await transaction.put(record.keyBytes, record.payload, {
            kind: record.kind,
            recordVersion: record.recordVersion,
          });
        }
      });
      return current;
    });
    for (const record of outcome) {
      expected.set(record.keyBytes.toString("base64url"), payloadDigest(record.payload));
    }
    rewritten += outcome.length;
    skippedConcurrent += batch.length - outcome.length;
  }
  await store.flush();
  const verified = store.scan(prefix, { limit: boundedMaximum });
  let verifiedCount = 0;
  for (const record of verified) {
    const identity = record.keyBytes.toString("base64url");
    if (expected.get(identity) === payloadDigest(record.payload)) verifiedCount += 1;
  }
  const truncated = records.length === boundedMaximum
    && store.scan(prefix, { after: records.at(-1).keyBytes, limit: 1 }).length > 0;
  return Object.freeze({
    rewritten,
    verified: verifiedCount,
    skippedConcurrent,
    truncated,
  });
}

/** Evacuate live values, compact the affected range, and report byte evidence. */
export async function compactDeletionWave(store, {
  prefix,
  evacuate = true,
  transactionSize,
  maxRecords,
} = {}) {
  requireStore(store);
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new TypeError("Deletion-wave compaction requires a non-empty tuple prefix.");
  }
  const before = physicalStoreMetrics(store);
  const evacuation = evacuate
    ? await evacuateLiveValues(store, { prefix, transactionSize, maxRecords })
    : Object.freeze({ rewritten: 0, verified: 0, truncated: false });
  if (evacuation.truncated) {
    throw new RangeError("Blob evacuation reached its record bound; split the compaction range before retrying.");
  }
  await store.compact({ prefix });
  await store.flush();
  const after = physicalStoreMetrics(store);
  return Object.freeze({
    status: "complete",
    prefix: Object.freeze([...prefix]),
    evacuation,
    before,
    after,
    physicalDecreaseBytes: Math.max(0, before.directoryBytes - after.directoryBytes),
    physicalDataDecreaseBytes: Math.max(0, before.physicalDataBytes - after.physicalDataBytes),
  });
}
