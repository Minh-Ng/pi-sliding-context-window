import { RETENTION_CLASSES } from "../../store/store-contract.js";
import {
  bumpGuard,
  guardKeys,
  warmGuard,
} from "../guards.js";
import {
  manifestKeys,
  retiredDocumentStatus,
} from "../manifests.js";
import { KEYSPACE } from "../keys.js";
import {
  advanceDerivedViewOutbox,
  derivedViewKeys,
  recordDerivedViewTombstone,
  resolveDocumentOrdinal,
} from "../derived-view.js";
import { isDocumentProtected } from "./protection.js";
import {
  DEFAULT_ACCESS_BUCKET_MS,
  RETENTION_FORMAT_VERSION,
  documentVersion,
  positiveInteger,
  requireStore,
  retentionKeys,
  timestamp,
} from "./shared.js";

/** Renew logical expiry using a generation that makes older queue entries stale. */
export async function renewDocumentExpiry(store, {
  documentId,
  version,
  retentionClass,
  expiresAt,
  now = Date.now(),
} = {}) {
  requireStore(store);
  const target = documentVersion(documentId, version);
  if (!RETENTION_CLASSES.includes(retentionClass)) throw new TypeError("retentionClass is invalid.");
  const expiry = timestamp(expiresAt, "expiresAt");
  const renewedAt = timestamp(now, "now");
  const documentGuard = guardKeys.document(documentId, version);
  const manifest = await store.get(manifestKeys.document(target.documentId, target.version));
  if (manifest === undefined) throw new Error(`Cannot renew missing document ${documentId}@${version}.`);
  await warmGuard(store, documentGuard);
  await store.get([KEYSPACE.SUPERSESSION, target.documentId, target.version]);
  await store.get(retentionKeys.expiryCurrent(documentId, version));
  await store.get(manifestKeys.documentHistory(documentId));
  return store.transaction(async (transaction) => {
    await bumpGuard(transaction, documentGuard);
    const supersession = transaction.scan([
      KEYSPACE.SUPERSESSION,
      target.documentId,
      target.version,
    ], { limit: 1 })[0]?.payload;
    if (supersession !== undefined) {
      throw new Error(`Cannot renew expired or superseded document ${documentId}@${version}.`);
    }
    if (retiredDocumentStatus(await transaction.get(manifestKeys.documentHistory(documentId)), version)) {
      throw new Error(`Cannot renew expired or superseded document ${documentId}@${version}.`);
    }
    const previous = await transaction.get(retentionKeys.expiryCurrent(documentId, version));
    const generation = (previous?.generation ?? 0) + 1;
    const current = Object.freeze({
      retentionFormatVersion: RETENTION_FORMAT_VERSION,
      documentId,
      documentVersion: version,
      retentionClass,
      expiresAt: expiry,
      generation,
      renewedAt,
    });
    await transaction.put(retentionKeys.expiryCurrent(documentId, version), current, {
      kind: "retention-expiry-current",
    });
    await transaction.putImmutable(
      retentionKeys.expiry(expiry, retentionClass, documentId, version, generation),
      current,
      { kind: "expiry" },
    );
    return current;
  });
}

/** Coarse access tracking: at most one immutable record per document/bucket. */
export async function recordDocumentAccess(store, {
  documentId,
  version,
  now = Date.now(),
  bucketMs = DEFAULT_ACCESS_BUCKET_MS,
} = {}) {
  requireStore(store);
  const accessedAt = timestamp(now, "now");
  const duration = positiveInteger(bucketMs, "bucketMs");
  const bucket = Math.floor(accessedAt / duration);
  const key = retentionKeys.access(documentId, version, bucket);
  await store.get(key);
  const result = await store.transaction(async (transaction) => {
    if (await transaction.get(key) !== undefined) return "unchanged";
    return transaction.putImmutable(key, {
      retentionFormatVersion: RETENTION_FORMAT_VERSION,
      documentId,
      documentVersion: version,
      bucket,
      accessedAt,
    }, { kind: "retention-access" });
  });
  return Object.freeze({ status: result, bucket });
}

export function expiryCandidate(record) {
  const payload = record.payload;
  if (!payload || typeof payload.documentId !== "string") return undefined;
  const key = record.key;
  return {
    record,
    documentId: payload.documentId,
    version: payload.documentVersion,
    retentionClass: payload.retentionClass,
    expiresAt: payload.expiresAt,
    generation: payload.generation ?? 0,
    legacy: key.length === 6,
  };
}

async function currentCandidate(view, candidate) {
  const current = await view.get(retentionKeys.expiryCurrent(candidate.documentId, candidate.version));
  if (current === undefined) return candidate.legacy;
  return current.generation === candidate.generation
    && current.expiresAt === candidate.expiresAt
    && current.retentionClass === candidate.retentionClass;
}

async function enqueueDeleteOutbox(transaction, candidate, now) {
  const sequence = await transaction.increment("outbox");
  // The counter allocates a unique key inside this transaction. A regular put
  // avoids a cold-cache point read that rocksdb-js optimistic transactions
  // cannot perform after restart while preserving append-only semantics.
  await transaction.put([KEYSPACE.OUTBOX, sequence], {
    operation: "delete",
    documentId: candidate.documentId,
    documentVersion: candidate.version,
    sourceVersion: candidate.version,
    admittedAt: now,
    sequence,
  }, { kind: "outbox" });
  const stateKey = derivedViewKeys.upgradeState();
  const state = await transaction.get(stateKey);
  await transaction.put(
    stateKey,
    advanceDerivedViewOutbox(state, sequence),
    { kind: "derived-view-upgrade-state" },
  );
  return sequence;
}

export async function beginExpiry(store, candidate, now, options = {}) {
  // The native optimistic transaction cannot perform a blocking first read
  // immediately after reopen. Warm every point-read key while range scans
  // remain protected by the transaction snapshot/conflict checks.
  await store.get(retentionKeys.expiryCurrent(candidate.documentId, candidate.version));
  await store.get(manifestKeys.document(candidate.documentId, candidate.version));
  await store.get([KEYSPACE.SUPERSESSION, candidate.documentId, candidate.version]);
  await store.get(retentionKeys.cleanup(candidate.documentId, candidate.version));
  await store.get(derivedViewKeys.upgradeState());
  const initialManifest = await store.get(manifestKeys.document(candidate.documentId, candidate.version));
  const initialCleanupManifest = await store.get(
    retentionKeys.cleanupManifest(candidate.documentId, candidate.version),
  );
  const ordinalManifest = initialManifest ?? initialCleanupManifest;
  const ordinalAssignment = ordinalManifest === undefined
    ? undefined
    : await resolveDocumentOrdinal(store, {
        project: ordinalManifest.project,
        documentId: candidate.documentId,
        version: candidate.version,
      });
  if (ordinalAssignment !== undefined) {
    await store.get(derivedViewKeys.tombstone(
      ordinalAssignment.project,
      ordinalAssignment.ordinal,
    ));
    await store.get(derivedViewKeys.active(ordinalAssignment.project));
  }
  if (typeof initialManifest?.subjectKey === "string" && initialManifest.subjectKey.length > 0) {
    await store.get(manifestKeys.subjectLive(initialManifest.project, initialManifest.subjectKey));
  }
  const documentGuard = guardKeys.document(candidate.documentId, candidate.version);
  const sessionGuard = initialManifest ? guardKeys.session(initialManifest.sessionId) : undefined;
  await warmGuard(store, documentGuard);
  if (sessionGuard) await warmGuard(store, sessionGuard);
  return store.transaction(async (transaction) => {
    await bumpGuard(transaction, documentGuard);
    if (sessionGuard) await bumpGuard(transaction, sessionGuard);
    const existing = transaction.scan([
      KEYSPACE.SUPERSESSION,
      candidate.documentId,
      candidate.version,
    ], { limit: 1 })[0]?.payload;
    if (existing !== undefined) {
      await recordDerivedViewTombstone(transaction, ordinalAssignment, existing);
      const cleanup = await transaction.get(retentionKeys.cleanup(candidate.documentId, candidate.version));
      if (cleanup?.deleteOutboxSequence !== undefined) {
        return Object.freeze({
          status: "already-tombstoned",
          tombstone: existing,
          manifest: cleanup.manifest ?? initialCleanupManifest ?? initialManifest,
          deleteOutboxSequence: cleanup.deleteOutboxSequence,
        });
      }
      const manifest = cleanup?.manifest
        ?? initialCleanupManifest
        ?? initialManifest;
      if (manifest === undefined) {
        if (candidate.record?.keyBytes !== undefined) {
          await transaction.remove(candidate.record.keyBytes);
        }
        return Object.freeze({ status: "missing", tombstone: existing });
      }
      const deleteOutboxSequence = await enqueueDeleteOutbox(transaction, candidate, now);
      await transaction.put(retentionKeys.cleanup(candidate.documentId, candidate.version), {
        retentionFormatVersion: RETENTION_FORMAT_VERSION,
        documentId: candidate.documentId,
        documentVersion: candidate.version,
        status: "tombstoned",
        tombstonedAt: cleanup?.tombstonedAt ?? now,
        project: manifest.project,
        deleteOutboxSequence,
      }, { kind: "retention-cleanup" });
      if (initialCleanupManifest === undefined) {
        await transaction.put(
          retentionKeys.cleanupManifest(candidate.documentId, candidate.version),
          manifest,
          { kind: "retention-cleanup-manifest" },
        );
      }
      return Object.freeze({
        status: "already-tombstoned",
        tombstone: existing,
        manifest,
        deleteOutboxSequence,
      });
    }
    if (!await currentCandidate(transaction, candidate)) {
      if (candidate.record?.keyBytes !== undefined) await transaction.remove(candidate.record.keyBytes);
      return Object.freeze({ status: "stale" });
    }
    const manifest = initialManifest;
    if (manifest === undefined) {
      if (candidate.record?.keyBytes !== undefined) await transaction.remove(candidate.record.keyBytes);
      return Object.freeze({ status: "missing" });
    }
    if (options.ignoreProtection !== true
      && await isDocumentProtected(transaction, manifest, { now })) {
      return Object.freeze({ status: "protected" });
    }
    const tombstone = Object.freeze({
      documentId: candidate.documentId,
      documentVersion: candidate.version,
      status: "expired",
      reason: typeof options.reason === "string" && options.reason.length > 0
        ? options.reason
        : options.forced === true
          ? `Emergency retention shortened eligible ephemeral payload before scheduled expiry at ${candidate.expiresAt}.`
          : `Retention class ${candidate.retentionClass} expired at ${candidate.expiresAt}.`,
      recordedAt: now,
    });
    await transaction.putImmutable(
      [KEYSPACE.SUPERSESSION, candidate.documentId, candidate.version],
      tombstone,
      { kind: "supersession" },
    );
    await recordDerivedViewTombstone(transaction, ordinalAssignment, tombstone);
    if (typeof manifest.subjectKey === "string" && manifest.subjectKey.length > 0) {
      const subjectKey = manifestKeys.subjectLive(manifest.project, manifest.subjectKey);
      const live = await transaction.get(subjectKey);
      if (live?.documentId === candidate.documentId
        && live?.documentVersion === candidate.version) {
        await transaction.remove(subjectKey);
      }
    }
    const deleteOutboxSequence = await enqueueDeleteOutbox(transaction, candidate, now);
    await transaction.put(retentionKeys.cleanup(candidate.documentId, candidate.version), {
      retentionFormatVersion: RETENTION_FORMAT_VERSION,
      documentId: candidate.documentId,
      documentVersion: candidate.version,
      status: "tombstoned",
      tombstonedAt: now,
      project: manifest.project,
      deleteOutboxSequence,
    }, { kind: "retention-cleanup" });
    await transaction.put(
      retentionKeys.cleanupManifest(candidate.documentId, candidate.version),
      manifest,
      { kind: "retention-cleanup-manifest" },
    );
    return Object.freeze({
      status: "tombstoned",
      manifest,
      tombstone,
      deleteOutboxSequence,
    });
  });
}
