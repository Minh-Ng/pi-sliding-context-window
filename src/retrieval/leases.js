import { randomUUID } from "node:crypto";
import {
  assertContract,
  LEASE_SCHEMA,
} from "../store/store-contract.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import {
  bumpGuard,
  guardKeys,
  warmGuard,
} from "../rocksdb/guards.js";

export const RETRIEVAL_LEASE_FORMAT_VERSION = 1;
export const DEFAULT_RETRIEVAL_LEASE_MS = 5 * 60 * 1_000;
export const MAX_RETRIEVAL_LEASE_MS = 60 * 60 * 1_000;

export class RetrievalLeaseTargetUnavailableError extends Error {
  constructor(documentId, documentVersion) {
    super(`Cannot lease expired or superseded document ${documentId}@${documentVersion}.`);
    this.name = "RetrievalLeaseTargetUnavailableError";
    this.code = "ERR_RETRIEVAL_LEASE_TARGET_UNAVAILABLE";
    this.documentId = documentId;
    this.documentVersion = documentVersion;
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer timestamp.`);
  }
  return value;
}

function requireStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.transaction !== "function") {
    throw new TypeError("Lease operations require a writable RocksStore-compatible store.");
  }
  return store;
}

function leaseRecord(lease) {
  assertContract(LEASE_SCHEMA, lease, { path: "lease", code: "INVALID_REQUEST" });
  return Object.freeze({
    leaseFormatVersion: RETRIEVAL_LEASE_FORMAT_VERSION,
    ...lease,
  });
}

function validateRecord(record, leaseId) {
  if (!record || record.leaseFormatVersion !== RETRIEVAL_LEASE_FORMAT_VERSION
    || record.leaseId !== leaseId) {
    throw new Error(`Retrieval lease ${leaseId} is malformed.`);
  }
  const { leaseFormatVersion: _format, ...lease } = record;
  assertContract(LEASE_SCHEMA, lease, { path: "lease", code: "INVALID_RESPONSE" });
  return record;
}

export const leaseKeys = Object.freeze({
  byId(leaseId) {
    return [KEYSPACE.LEASE, "by-id", identifier(leaseId, "leaseId")];
  },
  byExpiry(expiresAt, leaseId) {
    return [
      KEYSPACE.LEASE,
      "by-expiry",
      timestamp(expiresAt, "expiresAt"),
      identifier(leaseId, "leaseId"),
    ];
  },
  byExpiryPrefix() {
    return [KEYSPACE.LEASE, "by-expiry"];
  },
  byDocument(documentId, documentVersion, leaseId) {
    return [
      KEYSPACE.LEASE,
      "by-document",
      identifier(documentId, "documentId"),
      positiveInteger(documentVersion, "documentVersion"),
      identifier(leaseId, "leaseId"),
    ];
  },
  byDocumentPrefix(documentId, documentVersion) {
    return [
      KEYSPACE.LEASE,
      "by-document",
      identifier(documentId, "documentId"),
      positiveInteger(documentVersion, "documentVersion"),
    ];
  },
  byDocumentExpiry(documentId, documentVersion, expiresAt, leaseId) {
    return [
      KEYSPACE.LEASE,
      "document-expiry",
      identifier(documentId, "documentId"),
      positiveInteger(documentVersion, "documentVersion"),
      timestamp(expiresAt, "expiresAt"),
      identifier(leaseId, "leaseId"),
    ];
  },
  byDocumentExpiryPrefix(documentId, documentVersion) {
    return [
      KEYSPACE.LEASE,
      "document-expiry",
      identifier(documentId, "documentId"),
      positiveInteger(documentVersion, "documentVersion"),
    ];
  },
});

/** Create one durable, crash-expiring lease for an exact immutable version. */
export async function createRetrievalLease(store, {
  leaseId = randomUUID(),
  ownerId = "retrieval",
  documentId,
  documentVersion,
  now = Date.now(),
  ttlMs = DEFAULT_RETRIEVAL_LEASE_MS,
} = {}) {
  requireStore(store);
  const issuedAt = timestamp(now, "now");
  const duration = positiveInteger(ttlMs, "ttlMs", MAX_RETRIEVAL_LEASE_MS);
  if (issuedAt > Number.MAX_SAFE_INTEGER - duration) throw new RangeError("Lease expiry overflows a safe integer.");
  const lease = leaseRecord({
    leaseId: identifier(leaseId, "leaseId"),
    ownerId: identifier(ownerId, "ownerId"),
    kind: "retrieval",
    documentId: identifier(documentId, "documentId"),
    documentVersion: positiveInteger(documentVersion, "documentVersion"),
    issuedAt,
    expiresAt: issuedAt + duration,
  });
  const documentGuard = guardKeys.document(lease.documentId, lease.documentVersion);
  await warmGuard(store, documentGuard);
  await store.get(leaseKeys.byId(lease.leaseId));
  await store.get([KEYSPACE.SUPERSESSION, lease.documentId, lease.documentVersion]);
  return store.transaction(async (transaction) => {
    await bumpGuard(transaction, documentGuard);
    const existing = await transaction.get(leaseKeys.byId(lease.leaseId));
    if (existing !== undefined) {
      const validated = validateRecord(existing, lease.leaseId);
      const same = validated.ownerId === lease.ownerId
        && validated.documentId === lease.documentId
        && validated.documentVersion === lease.documentVersion
        && validated.issuedAt === lease.issuedAt
        && validated.expiresAt === lease.expiresAt;
      if (!same) throw new Error(`Retrieval lease ${lease.leaseId} already exists with different claims.`);
      return Object.freeze({ ...validated, duplicate: true });
    }
    if (transaction.scan([
      KEYSPACE.SUPERSESSION,
      lease.documentId,
      lease.documentVersion,
    ], { limit: 1 }).length > 0) {
      throw new RetrievalLeaseTargetUnavailableError(
        lease.documentId,
        lease.documentVersion,
      );
    }
    await transaction.putImmutable(leaseKeys.byId(lease.leaseId), lease, { kind: "retrieval-lease" });
    await transaction.putImmutable(
      leaseKeys.byExpiry(lease.expiresAt, lease.leaseId),
      { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
      { kind: "retrieval-lease-expiry" },
    );
    await transaction.putImmutable(
      leaseKeys.byDocumentExpiry(
        lease.documentId,
        lease.documentVersion,
        lease.expiresAt,
        lease.leaseId,
      ),
      { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
      { kind: "retrieval-lease-document-expiry" },
    );
    await transaction.putImmutable(
      leaseKeys.byDocument(lease.documentId, lease.documentVersion, lease.leaseId),
      { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
      { kind: "retrieval-lease-document" },
    );
    return Object.freeze({ ...lease, duplicate: false });
  });
}

export async function readLease(view, leaseId) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("readLease requires a RocksStore-compatible read view.");
  }
  const id = identifier(leaseId, "leaseId");
  const record = await view.get(leaseKeys.byId(id));
  return record === undefined ? undefined : validateRecord(record, id);
}

/** Validate lease existence, immutable target identity, and strict expiry. */
export async function validateRetrievalLease(view, {
  leaseId,
  documentId,
  documentVersion,
  now = Date.now(),
} = {}) {
  const id = identifier(leaseId, "leaseId");
  const lease = await readLease(view, id);
  if (lease === undefined) return Object.freeze({ status: "missing", leaseId: id });
  const checkedAt = timestamp(now, "now");
  if (lease.documentId !== documentId || lease.documentVersion !== documentVersion) {
    return Object.freeze({ status: "mismatch", lease });
  }
  if (checkedAt >= lease.expiresAt) return Object.freeze({ status: "expired", lease });
  return Object.freeze({ status: "active", lease });
}

export async function hasActiveDocumentLease(view, documentId, documentVersion, options = {}) {
  if (!view || typeof view.scan !== "function") {
    throw new TypeError("hasActiveDocumentLease requires a RocksStore-compatible read view.");
  }
  const now = timestamp(options.now ?? Date.now(), "now");
  const newest = view.scan(leaseKeys.byDocumentExpiryPrefix(documentId, documentVersion), {
    reverse: true,
    limit: 1,
  })[0]?.payload;
  return newest?.expiresAt > now;
}

/** Remove a lease and all of its secondary references. */
export async function releaseLeaseFromView(view, leaseId) {
  if (!view || typeof view.get !== "function" || typeof view.remove !== "function") {
    throw new TypeError("releaseLeaseFromView requires a writable store view.");
  }
  const id = identifier(leaseId, "leaseId");
  const lease = await view.get(leaseKeys.byId(id));
  if (lease === undefined) return Object.freeze({ status: "not-found", leaseId: id });
  const validated = validateRecord(lease, id);
  await view.remove(leaseKeys.byId(id));
  await view.remove(leaseKeys.byExpiry(validated.expiresAt, id));
  await view.remove(leaseKeys.byDocument(validated.documentId, validated.documentVersion, id));
  await view.remove(leaseKeys.byDocumentExpiry(
    validated.documentId,
    validated.documentVersion,
    validated.expiresAt,
    id,
  ));
  return Object.freeze({ status: "released", leaseId: id });
}

/** Remove a lease and all of its secondary references. */
export async function releaseLease(store, leaseId) {
  requireStore(store);
  const id = identifier(leaseId, "leaseId");
  await store.get(leaseKeys.byId(id));
  return store.transaction((transaction) => releaseLeaseFromView(transaction, id));
}

/** Bounded cleanup for naturally expired retrieval leases. */
export async function cleanupExpiredLeases(store, options = {}) {
  requireStore(store);
  const now = timestamp(options.now ?? Date.now(), "now");
  const limit = positiveInteger(options.limit ?? 1_000, "limit", 100_000);
  const due = store.scan(leaseKeys.byExpiryPrefix(), { limit });
  let scanned = 0;
  let released = 0;
  for (const { payload } of due) {
    if (!payload || payload.expiresAt > now) break;
    scanned += 1;
    const result = await releaseLease(store, payload.leaseId);
    if (result.status === "released") {
      released += 1;
    } else {
      await store.remove(leaseKeys.byExpiry(payload.expiresAt, payload.leaseId));
    }
  }
  const more = due.length === limit && due.at(-1)?.payload?.expiresAt <= now;
  return Object.freeze({ scanned, released, more });
}
