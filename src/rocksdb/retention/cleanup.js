import {
  assertStoreRequest,
  assertStoreResult,
} from "../../store/store-contract.js";
import { cleanupExpiredLeases } from "../../retrieval/leases.js";
import { recallCounterName } from "../../retrieval/relevance-feedback.js";
import { createBm25IndexHandler } from "../index/bm25.js";
import { createExactIndexHandler } from "../index/exact.js";
import { createStructuralIndexHandler } from "../index/structural.js";
import { createImportanceIndexHandler } from "../index/importance.js";
import { createNearDuplicateIndexHandler } from "../index/simhash.js";
import { IndexWorker } from "../indexer.js";
import { derivedKeys } from "../derived.js";
import { KEYSPACE, keyFor } from "../keys.js";
import {
  bumpGuard,
  guardKeys,
  warmGuard,
} from "../guards.js";
import {
  auxiliaryManifestIdentityForDocument,
  manifestKeys,
  retiredDocumentHistory,
  retiredDocumentStatus,
} from "../manifests.js";
import { isOutboxSequenceProcessed } from "../outbox.js";
import {
  scanStatusPrefix,
  statusRecordStoredBytes,
} from "../status-scan.js";
import { cleanupExpiredProtections } from "./protection.js";
import { beginExpiry, expiryCandidate } from "./expiry.js";
import { forceEligibleEphemeral } from "./emergency.js";
import {
  DEFAULT_RETENTION_WORK_LIMIT,
  DEFAULT_TOMBSTONE_AUDIT_MS,
  MAX_SCAN_LIMIT,
  RETENTION_FORMAT_VERSION,
  positiveInteger,
  requireStore,
  retentionKeys,
  timestamp,
} from "./shared.js";

function createRetentionIndexWorker(store) {
  return new IndexWorker(store, {
    workerId: `retention-index:${process.pid}`,
    maxDrainMs: 60_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
      createImportanceIndexHandler(),
      createNearDuplicateIndexHandler(),
    ],
  });
}

async function publishDelete(store, sequence, options, state) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("A tombstoned document is missing its index-delete outbox sequence.");
  }
  if (typeof options.publishIndexDelete === "function") {
    if (await options.publishIndexDelete(sequence) === false) return false;
  } else {
    state.worker ??= createRetentionIndexWorker(store);
    for (let wave = 0; wave < 100; wave += 1) {
      if (await isOutboxSequenceProcessed(store, sequence)) return true;
      const result = await state.worker.drain({
        limit: 1_000,
        maxDurationMs: 60_000,
        throwOnError: true,
      });
      if (result.terminal !== "limit" && result.processed === 0) break;
    }
  }
  return isOutboxSequenceProcessed(store, sequence);
}

const CLEANUP_PHASES = Object.freeze([
  "windows",
  "derived",
  "source-messages",
  "access",
  "kind-manifest",
  "document",
  "session-reference",
  "chunks",
  "admission-references",
  "expiry",
]);

function canonicalCleanupProgress(cleanup) {
  const progress = cleanup?.cleanupProgress;
  const phase = CLEANUP_PHASES.includes(progress?.phase) ? progress.phase : CLEANUP_PHASES[0];
  return Object.freeze({
    phase,
    sourceOffset: Number.isSafeInteger(progress?.sourceOffset) && progress.sourceOffset >= 0
      ? progress.sourceOffset
      : 0,
    chunkOffset: Number.isSafeInteger(progress?.chunkOffset) && progress.chunkOffset >= 0
      ? progress.chunkOffset
      : 0,
  });
}

function sameCleanupProgress(left, right) {
  return left.phase === right.phase
    && left.sourceOffset === right.sourceOffset
    && left.chunkOffset === right.chunkOffset;
}

function nextCleanupProgress(phase, progress = {}) {
  return {
    phase,
    sourceOffset: progress.sourceOffset ?? 0,
    chunkOffset: progress.chunkOffset ?? 0,
  };
}

async function updateCleanupRecord(transaction, cleanupKey, current, progress, deleted) {
  await transaction.put(cleanupKey, {
    ...current,
    cleanupProgress: progress,
    deletedKeys: (current.deletedKeys ?? 0) + deleted,
  }, { kind: "retention-cleanup" });
}

async function cleanupPrefixPhase(store, cleanupKey, expected, prefix, nextPhase, workLimit) {
  const records = store.scan(prefix, { limit: workLimit });
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current?.status === "complete") return { complete: true, work: 0, deleted: 0 };
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    for (const record of records) await transaction.remove(record.keyBytes);
    const progress = records.length < workLimit ? nextCleanupProgress(nextPhase) : expected;
    await updateCleanupRecord(transaction, cleanupKey, current, progress, records.length);
    return { work: records.length, deleted: records.length, progressed: true };
  });
}

async function cleanupDerivedPhase(store, cleanupKey, candidate, expected, workLimit) {
  if (workLimit < 2) return { work: 0, deleted: 0, progressed: false };
  const referenceLimit = Math.max(1, Math.floor(workLimit / 2));
  const references = store.scan(derivedKeys.prefix(candidate.documentId, candidate.version), {
    limit: referenceLimit,
  });
  const targets = await Promise.all(references.map(({ payload }) =>
    typeof payload?.targetKey === "string"
      ? store.getRecord(Buffer.from(payload.targetKey, "base64url"))
      : undefined));
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    let deleted = 0;
    for (const target of targets) {
      if (target === undefined) continue;
      const record = transaction.scan(target.key, { limit: 1 })[0];
      if (record === undefined || !record.keyBytes.equals(target.keyBytes)) continue;
      const version = record?.payload?.documentVersion ?? record?.payload?.version;
      if (record?.payload?.documentId === candidate.documentId && version === candidate.version) {
        await transaction.remove(target.keyBytes);
        deleted += 1;
      }
    }
    for (const reference of references) {
      await transaction.remove(reference.keyBytes);
      deleted += 1;
    }
    const progress = references.length < referenceLimit
      ? nextCleanupProgress("source-messages")
      : expected;
    await updateCleanupRecord(transaction, cleanupKey, current, progress, deleted);
    return { work: deleted, deleted, progressed: true };
  });
}

async function cleanupSourceMessagesPhase(store, cleanupKey, manifest, expected, workLimit) {
  if (workLimit < 3) return { work: 0, deleted: 0, progressed: false };
  const sourceKeys = [...new Set(manifest.sourceMessageKeys ?? [])];
  const count = Math.min(sourceKeys.length - expected.sourceOffset, Math.floor(workLimit / 3));
  if (count <= 0) {
    await store.get(cleanupKey);
    return store.transaction(async (transaction) => {
      const current = await transaction.get(cleanupKey);
      if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
        return { stale: true, work: 0, deleted: 0 };
      }
      await updateCleanupRecord(
        transaction,
        cleanupKey,
        current,
        nextCleanupProgress("access"),
        0,
      );
      return { work: 0, deleted: 0, progressed: true };
    });
  }
  const selected = sourceKeys.slice(expected.sourceOffset, expected.sourceOffset + count);
  const entries = selected.map((sourceKey) => ({
    sourceKey,
    guard: guardKeys.sourceMessage(manifest.project, manifest.sessionId, sourceKey),
    referenceKey: manifestKeys.sourceMessageReference(
      manifest.project,
      manifest.sessionId,
      sourceKey,
      manifest.documentId,
      manifest.version,
    ),
    eventKey: manifestKeys.sourceMessage(manifest.project, manifest.sessionId, sourceKey),
  }));
  for (const entry of entries) {
    await warmGuard(store, entry.guard);
    await store.get(entry.referenceKey);
    await store.get(entry.eventKey);
  }
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    let deleted = 0;
    for (const entry of entries) {
      await bumpGuard(transaction, entry.guard);
      if (await transaction.get(entry.referenceKey) !== undefined) {
        await transaction.remove(entry.referenceKey);
        deleted += 1;
      }
      const remaining = transaction.scan(
        manifestKeys.sourceMessageReferencePrefix(
          manifest.project,
          manifest.sessionId,
          entry.sourceKey,
        ),
        { limit: 1 },
      );
      if (remaining.length === 0 && await transaction.get(entry.eventKey) !== undefined) {
        await transaction.remove(entry.eventKey);
        deleted += 1;
      }
      if (remaining.length === 0) {
        await transaction.remove(entry.guard);
        deleted += 1;
      }
    }
    const sourceOffset = expected.sourceOffset + entries.length;
    const progress = sourceOffset >= sourceKeys.length
      ? nextCleanupProgress("access")
      : nextCleanupProgress("source-messages", { sourceOffset });
    await updateCleanupRecord(transaction, cleanupKey, current, progress, deleted);
    return { work: entries.length * 3, deleted, progressed: true };
  });
}

async function cleanupKindManifestPhase(store, cleanupKey, manifest, expected, workLimit) {
  const identity = auxiliaryManifestIdentityForDocument(manifest);
  if (identity === undefined) {
    // Other document kinds have no shared turn/tool payload to remove.
    await store.get(cleanupKey);
    return store.transaction(async (transaction) => {
      const current = await transaction.get(cleanupKey);
      if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
        return { stale: true, work: 0, deleted: 0 };
      }
      await updateCleanupRecord(
        transaction,
        cleanupKey,
        current,
        nextCleanupProgress("document"),
        0,
      );
      return { work: 0, deleted: 0, progressed: true };
    });
  }
  // Removing the owner, payload, and guard can require three deletes when the
  // retiring document is the final owner.
  if (workLimit < 3) return { work: 0, deleted: 0, progressed: false };
  const referenceKey = manifestKeys.auxiliaryManifestReference(
    identity.kind,
    identity.manifestId,
    identity.version,
    manifest.documentId,
    manifest.version,
  );
  const referencePrefix = manifestKeys.auxiliaryManifestReferencePrefix(
    identity.kind,
    identity.manifestId,
    identity.version,
  );
  const guard = guardKeys.auxiliaryManifest(identity.kind, identity.manifestId, identity.version);
  const referenceExists = await store.get(referenceKey) !== undefined;
  if (!identity.managed && !referenceExists) {
    // A malformed post-upgrade fixture can still lack an indexed owner. Keep
    // the older conservative behavior instead of deleting shared metadata.
    await store.get(cleanupKey);
    return store.transaction(async (transaction) => {
      const current = await transaction.get(cleanupKey);
      if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
        return { stale: true, work: 0, deleted: 0 };
      }
      await updateCleanupRecord(transaction, cleanupKey, current, nextCleanupProgress("document"), 0);
      return { work: 0, deleted: 0, progressed: true };
    });
  }
  await store.get(identity.key);
  await warmGuard(store, guard);
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    await bumpGuard(transaction, guard);
    let deleted = 0;
    if (referenceExists && await transaction.get(referenceKey) !== undefined) {
      await transaction.remove(referenceKey);
      deleted += 1;
    }
    if (transaction.scan(referencePrefix, { limit: 1 }).length === 0) {
      if (await transaction.get(identity.key) !== undefined) {
        await transaction.remove(identity.key);
        deleted += 1;
      }
      await transaction.remove(guard);
      deleted += 1;
    }
    await updateCleanupRecord(
      transaction,
      cleanupKey,
      current,
      nextCleanupProgress("document"),
      deleted,
    );
    return { work: 3, deleted, progressed: true };
  });
}

async function cleanupPointPhase(
  store,
  cleanupKey,
  expected,
  key,
  nextPhase,
  guard,
  workLimit,
  { removeGuard = false, extraKeys = [] } = {},
) {
  const requiredWork = Number(key !== undefined) + Number(guard !== undefined && removeGuard)
    + extraKeys.length;
  if (workLimit < Math.max(1, requiredWork)) {
    return { work: 0, deleted: 0, progressed: false };
  }
  const exists = key !== undefined && await store.has(key);
  const extraExists = await Promise.all(extraKeys.map((extraKey) => store.has(extraKey)));
  if (guard !== undefined) await warmGuard(store, guard);
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    if (guard !== undefined) await bumpGuard(transaction, guard);
    if (exists) await transaction.remove(key);
    let deleted = Number(exists);
    for (const [index, extraKey] of extraKeys.entries()) {
      if (!extraExists[index]) continue;
      await transaction.remove(extraKey);
      deleted += 1;
    }
    if (guard !== undefined && removeGuard) {
      await transaction.remove(guard);
      deleted += 1;
    }
    await updateCleanupRecord(
      transaction,
      cleanupKey,
      current,
      nextCleanupProgress(nextPhase),
      deleted,
    );
    return { work: deleted, deleted, progressed: true };
  });
}

async function cleanupSessionReferencePhase(store, cleanupKey, manifest, expected, workLimit) {
  if (workLimit < 2) return { work: 0, deleted: 0, progressed: false };
  const referenceKey = manifestKeys.sessionDocumentReference(
    manifest.project,
    manifest.sessionId,
    manifest.documentId,
    manifest.version,
  );
  const referencePrefix = manifestKeys.sessionDocumentReferencePrefix(
    manifest.project,
    manifest.sessionId,
  );
  const sessionGuard = guardKeys.session(manifest.sessionId);
  await store.get(referenceKey);
  await store.get(cleanupKey);
  await warmGuard(store, sessionGuard);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    await bumpGuard(transaction, sessionGuard);
    let deleted = 0;
    if (await transaction.get(referenceKey) !== undefined) {
      await transaction.remove(referenceKey);
      deleted += 1;
    }
    // Reference indexes are authoritative only for manifests admitted with
    // this schema. Older stores retain their conservative session guard.
    if ((manifest.referenceIndexVersion === 1 || manifest.admissionRequestId !== undefined)
      && transaction.scan(referencePrefix, { limit: 1 }).length === 0) {
      await transaction.remove(sessionGuard);
      deleted += 1;
    }
    await updateCleanupRecord(
      transaction,
      cleanupKey,
      current,
      nextCleanupProgress("chunks"),
      deleted,
    );
    return { work: 2, deleted, progressed: true };
  });
}

async function cleanupChunksPhase(store, cleanupKey, manifest, expected, workLimit) {
  if (workLimit < 3) return { work: 0, deleted: 0, progressed: false };
  const count = Math.min(manifest.chunks.length - expected.chunkOffset, Math.floor(workLimit / 3));
  if (count <= 0) {
    await store.get(cleanupKey);
    return store.transaction(async (transaction) => {
      const current = await transaction.get(cleanupKey);
      if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
        return { stale: true, work: 0, deleted: 0 };
      }
      await updateCleanupRecord(
        transaction,
        cleanupKey,
        current,
        nextCleanupProgress("admission-references"),
        0,
      );
      return { work: 0, deleted: 0, progressed: true };
    });
  }
  const references = manifest.chunks.slice(expected.chunkOffset, expected.chunkOffset + count);
  const entries = references.map((reference) => ({
    reference,
    guard: guardKeys.chunk(reference.chunkId),
    referenceKey: manifestKeys.chunkReference(
      reference.chunkId,
      manifest.documentId,
      manifest.version,
      reference.ordinal,
    ),
    chunkKey: manifestKeys.chunk(reference.chunkId),
  }));
  const guards = [...new Map(entries.map((entry) => [entry.reference.chunkId, entry.guard])).values()];
  const uniqueEntries = [...new Map(
    entries.map((value) => [value.reference.chunkId, value]),
  ).values()];
  for (const guard of guards) await warmGuard(store, guard);
  for (const entry of entries) await store.get(entry.referenceKey);
  for (const entry of uniqueEntries) {
    entry.chunkExists = await store.has(entry.chunkKey);
  }
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    for (const guard of guards) await bumpGuard(transaction, guard);
    let deleted = 0;
    for (const entry of entries) {
      if (await transaction.get(entry.referenceKey) !== undefined) {
        await transaction.remove(entry.referenceKey);
        deleted += 1;
      }
    }
    for (const entry of uniqueEntries) {
      const remaining = transaction.scan(
        manifestKeys.chunkReferencePrefix(entry.reference.chunkId),
        { limit: 1 },
      );
      if (remaining.length === 0 && entry.chunkExists) {
        await transaction.remove(entry.chunkKey);
        deleted += 1;
      }
      if (remaining.length === 0) {
        await transaction.remove(entry.guard);
        deleted += 1;
      }
    }
    const chunkOffset = expected.chunkOffset + entries.length;
    const progress = chunkOffset >= manifest.chunks.length
      ? nextCleanupProgress("admission-references")
      : nextCleanupProgress("chunks", { chunkOffset });
    await updateCleanupRecord(transaction, cleanupKey, current, progress, deleted);
    return { work: entries.length * 3, deleted, progressed: true };
  });
}

async function cleanupAdmissionReferencesPhase(
  store,
  cleanupKey,
  manifest,
  expected,
  workLimit,
) {
  if (workLimit < 2) return { work: 0, deleted: 0, progressed: false };
  const referenceLimit = Math.max(1, Math.floor(workLimit / 2));
  const references = store.scan(
    manifestKeys.documentAdmissionReferencePrefix(manifest.documentId, manifest.version),
    { limit: referenceLimit },
  );
  const entries = [];
  for (const reference of references) {
    const requestId = reference.payload?.requestId;
    const idempotencyKey = typeof requestId === "string" && requestId.length > 0
      ? keyFor.idempotency(requestId)
      : undefined;
    entries.push({
      reference,
      idempotencyKey,
      markerExists: idempotencyKey === undefined ? false : await store.has(idempotencyKey),
    });
  }
  const legacyKey = references.length === 0 && manifest.admissionRequestId !== undefined
    ? keyFor.idempotency(manifest.admissionRequestId)
    : undefined;
  const legacyMarkerExists = legacyKey === undefined ? false : await store.has(legacyKey);
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    let deleted = 0;
    for (const entry of entries) {
      if (entry.markerExists) {
        await transaction.remove(entry.idempotencyKey);
        deleted += 1;
      }
      await transaction.remove(entry.reference.keyBytes);
      deleted += 1;
    }
    if (legacyMarkerExists) {
      // Compatibility with manifests written before admission references were
      // separated from immutable document identity.
      await transaction.remove(legacyKey);
      deleted += 1;
    }
    const progress = entries.length < referenceLimit
      ? nextCleanupProgress("expiry")
      : expected;
    await updateCleanupRecord(transaction, cleanupKey, current, progress, deleted);
    return { work: Math.max(2, entries.length * 2), deleted, progressed: true };
  });
}

async function completeCanonicalCleanup(
  store,
  cleanupKey,
  candidate,
  manifest,
  expected,
  workLimit,
  now,
) {
  if (workLimit < 3) return { work: 0, deleted: 0, progressed: false };
  const currentKey = retentionKeys.expiryCurrent(candidate.documentId, candidate.version);
  const cleanupManifestKey = retentionKeys.cleanupManifest(candidate.documentId, candidate.version);
  const historyKey = manifestKeys.documentHistory(candidate.documentId);
  await store.get(candidate.record.keyBytes);
  await store.get(currentKey);
  const hadCleanupManifest = await store.has(cleanupManifestKey);
  await store.get(historyKey);
  await store.get(cleanupKey);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(cleanupKey);
    if (current?.status === "complete") return { complete: true, work: 0, deleted: 0 };
    if (current === undefined || !sameCleanupProgress(canonicalCleanupProgress(current), expected)) {
      return { stale: true, work: 0, deleted: 0 };
    }
    let deleted = 0;
    if (await transaction.get(candidate.record.keyBytes) !== undefined) {
      await transaction.remove(candidate.record.keyBytes);
      deleted += 1;
    }
    if (await transaction.get(currentKey) !== undefined) {
      await transaction.remove(currentKey);
      deleted += 1;
    }
    if (hadCleanupManifest) {
      await transaction.remove(cleanupManifestKey);
      deleted += 1;
    }
    const latestVersion = transaction.scan([KEYSPACE.DOCUMENT, candidate.documentId], {
      reverse: true,
      limit: 1,
    })[0]?.payload?.version ?? manifest.version;
    const history = retiredDocumentHistory(
      await transaction.get(historyKey),
      manifest,
      latestVersion,
    );
    await transaction.put(historyKey, history, { kind: "document-history" });
    if (now > Number.MAX_SAFE_INTEGER - DEFAULT_TOMBSTONE_AUDIT_MS) {
      throw new RangeError("Tombstone audit expiry exceeds the safe timestamp range.");
    }
    const auditExpiresAt = now + DEFAULT_TOMBSTONE_AUDIT_MS;
    await transaction.put(cleanupKey, {
      retentionFormatVersion: RETENTION_FORMAT_VERSION,
      documentId: candidate.documentId,
      documentVersion: candidate.version,
      status: "complete",
      project: manifest.project,
      completedAt: now,
      auditExpiresAt,
      deletedKeys: (current.deletedKeys ?? 0) + deleted,
    }, { kind: "retention-cleanup" });
    await transaction.put(
      retentionKeys.auditExpiry(auditExpiresAt, candidate.documentId, candidate.version),
      {
        documentId: candidate.documentId,
        documentVersion: candidate.version,
        project: manifest.project,
        auditExpiresAt,
      },
      { kind: "retention-audit-expiry" },
    );
    return { complete: true, work: deleted, deleted, progressed: true };
  });
}

async function cleanupCanonicalDocument(store, candidate, manifest, workLimit, now) {
  const cleanupKey = retentionKeys.cleanup(candidate.documentId, candidate.version);
  let work = 0;
  let deleted = 0;
  // Empty phases can advance without consuming work. The cap prevents corrupt
  // progress records from creating an unbounded loop.
  for (let stepCount = 0; stepCount < 32 && work < workLimit; stepCount += 1) {
    const cleanup = await store.get(cleanupKey);
    if (cleanup?.status === "complete") return { complete: true, work, deleted };
    if (cleanup === undefined) return { complete: false, work, deleted };
    const progress = canonicalCleanupProgress(cleanup);
    const remaining = workLimit - work;
    let step;
    if (progress.phase === "windows") {
      step = await cleanupPrefixPhase(
        store,
        cleanupKey,
        progress,
        [KEYSPACE.WINDOW, candidate.documentId, candidate.version],
        "derived",
        remaining,
      );
    } else if (progress.phase === "derived") {
      step = await cleanupDerivedPhase(store, cleanupKey, candidate, progress, remaining);
    } else if (progress.phase === "source-messages") {
      step = await cleanupSourceMessagesPhase(store, cleanupKey, manifest, progress, remaining);
    } else if (progress.phase === "access") {
      step = await cleanupPrefixPhase(
        store,
        cleanupKey,
        progress,
        retentionKeys.accessPrefix(candidate.documentId, candidate.version),
        "kind-manifest",
        remaining,
      );
    } else if (progress.phase === "kind-manifest") {
      step = await cleanupKindManifestPhase(
        store,
        cleanupKey,
        manifest,
        progress,
        remaining,
      );
    } else if (progress.phase === "document") {
      step = await cleanupPointPhase(
        store,
        cleanupKey,
        progress,
        manifestKeys.document(candidate.documentId, candidate.version),
        "session-reference",
        guardKeys.document(candidate.documentId, candidate.version),
        remaining,
        {
          removeGuard: true,
          // The durable per-document recall counter (relevance-feedback.js)
          // is a plain local counter, not a registered derived reference, so
          // it is not reachable from the "derived" phase's scan; delete it
          // here instead, alongside the canonical record it is keyed to.
          extraKeys: [keyFor.counter(recallCounterName(
            manifest.project,
            candidate.documentId,
            candidate.version,
          ))],
        },
      );
    } else if (progress.phase === "session-reference") {
      step = await cleanupSessionReferencePhase(store, cleanupKey, manifest, progress, remaining);
    } else if (progress.phase === "chunks") {
      step = await cleanupChunksPhase(store, cleanupKey, manifest, progress, remaining);
    } else if (progress.phase === "admission-references") {
      step = await cleanupAdmissionReferencesPhase(
        store,
        cleanupKey,
        manifest,
        progress,
        remaining,
      );
    } else {
      step = await completeCanonicalCleanup(
        store,
        cleanupKey,
        candidate,
        manifest,
        progress,
        remaining,
        now,
      );
    }
    if (step.stale) continue;
    work += step.work;
    deleted += step.deleted;
    if (step.complete) return { complete: true, work, deleted };
    if (!step.progressed) break;
  }
  return { complete: false, work, deleted };
}

/** Reclaim compact expired/superseded status after its finite audit horizon. */
export async function cleanupExpiredTombstoneMetadata(store, options = {}) {
  requireStore(store);
  const now = timestamp(options.now ?? Date.now(), "now");
  const limit = positiveInteger(options.limit ?? 1_000, "limit", MAX_SCAN_LIMIT);
  const workLimit = positiveInteger(
    options.workLimit ?? DEFAULT_RETENTION_WORK_LIMIT,
    "workLimit",
    MAX_SCAN_LIMIT,
  );
  const due = store.scan(retentionKeys.auditExpiryPrefix(), { limit });
  let scanned = 0;
  let removed = 0;
  let deletedKeys = 0;
  const maximumWorkPerRecord = 5;
  for (const record of due) {
    const auditExpiresAt = record.key.at(-3);
    if (!Number.isSafeInteger(auditExpiresAt) || auditExpiresAt > now) break;
    if ((scanned + 1) * maximumWorkPerRecord > workLimit) break;
    const { documentId, documentVersion } = record.payload;
    const cleanupKey = retentionKeys.cleanup(documentId, documentVersion);
    const supersessionKey = [KEYSPACE.SUPERSESSION, documentId, documentVersion];
    const guardKey = guardKeys.document(documentId, documentVersion);
    const historyKey = manifestKeys.documentHistory(documentId);
    await store.get(cleanupKey);
    await store.get(supersessionKey);
    await store.get(guardKey);
    await store.get(historyKey);
    const initialCleanup = await store.get(cleanupKey);
    const idempotencyKey = initialCleanup?.admissionRequestId === undefined
      ? undefined
      : keyFor.idempotency(initialCleanup.admissionRequestId);
    if (idempotencyKey !== undefined) await store.get(idempotencyKey);
    const deleted = await store.transaction(async (transaction) => {
      const queued = await transaction.get(record.keyBytes);
      const cleanup = await transaction.get(cleanupKey);
      if (queued?.auditExpiresAt !== auditExpiresAt) return 0;
      if (cleanup !== undefined
        && (cleanup.status !== "complete" || cleanup.auditExpiresAt !== auditExpiresAt)) {
        await transaction.remove(record.keyBytes);
        return 1;
      }
      let history = await transaction.get(historyKey);
      if (retiredDocumentStatus(history, documentVersion) === undefined) {
        const latest = transaction.scan([KEYSPACE.DOCUMENT, documentId], {
          reverse: true,
          limit: 1,
        })[0]?.payload;
        const project = cleanup?.project ?? queued.project;
        if (typeof project !== "string" || project.length === 0) return 0;
        history = retiredDocumentHistory(history, {
          documentId,
          version: documentVersion,
          project,
        }, latest?.version ?? documentVersion);
        await transaction.put(historyKey, history, { kind: "document-history" });
      }
      let count = 0;
      for (const key of [supersessionKey, cleanupKey, idempotencyKey, guardKey, record.keyBytes]) {
        if (key === undefined) continue;
        if (await transaction.get(key) === undefined) continue;
        await transaction.remove(key);
        count += 1;
      }
      return count;
    });
    scanned += 1;
    deletedKeys += deleted;
    removed += 1;
  }
  return Object.freeze({
    scanned,
    removed,
    deletedKeys,
    work: scanned * maximumWorkPerRecord,
    more: (scanned * maximumWorkPerRecord >= workLimit)
      || (due.length === limit && due.at(-1)?.key?.at(-3) <= now),
  });
}

/** Run one bounded semantic-expiry wave. */
export async function runRetention(store, request, options = {}) {
  requireStore(store);
  assertStoreRequest("retention.run", request);
  const workLimit = positiveInteger(
    options.workLimit ?? DEFAULT_RETENTION_WORK_LIMIT,
    "workLimit",
    MAX_SCAN_LIMIT,
  );
  if (workLimit < 3) throw new RangeError("workLimit must be at least 3.");
  const protectionCleanup = await cleanupExpiredProtections(store, {
    now: request.now,
    limit: Math.min(request.batchSize, workLimit),
    workLimit,
  });
  let maintenanceWork = protectionCleanup.work;
  let leaseCleanup = { scanned: 0, released: 0, more: false };
  const leaseLimit = Math.floor((workLimit - maintenanceWork) / 4);
  if (leaseLimit > 0) {
    leaseCleanup = await cleanupExpiredLeases(store, {
      now: request.now,
      limit: leaseLimit,
    });
    // One lease owns four durable records. Reserve the full amount even when
    // cleanup discovers a stale expiry pointer and removes fewer keys.
    maintenanceWork += leaseCleanup.scanned * 4;
  }
  let metadataCleanup = {
    scanned: 0,
    removed: 0,
    deletedKeys: 0,
    work: 0,
    more: false,
  };
  const metadataWorkLimit = workLimit - maintenanceWork;
  if (metadataWorkLimit >= 5) {
    metadataCleanup = await cleanupExpiredTombstoneMetadata(store, {
      now: request.now,
      limit: Math.min(request.batchSize, Math.floor(metadataWorkLimit / 5)),
      workLimit: metadataWorkLimit,
    });
    maintenanceWork += metadataCleanup.work;
  }
  const canonicalWorkLimit = workLimit - maintenanceWork;
  const cursorKey = retentionKeys.scanCursor(options.project ?? "*", request.class ?? "*");
  if (canonicalWorkLimit < 3) {
    return assertStoreResult("retention.run", {
      status: "more-work",
      scanned: 0,
      tombstoned: 0,
      deletedKeys: metadataCleanup.deletedKeys,
      protected: 0,
    });
  }
  const cursorRecord = await store.get(cursorKey);
  const after = typeof cursorRecord?.after === "string"
    ? Buffer.from(cursorRecord.after, "base64url")
    : undefined;
  const pageSize = Math.min(10_000, Math.max(256, request.batchSize * 8));
  let records = store.scan([KEYSPACE.EXPIRY], {
    limit: pageSize,
    ...(after === undefined ? {} : { after }),
  });
  if (records.length === 0 && after !== undefined) {
    await store.remove(cursorKey);
    records = store.scan([KEYSPACE.EXPIRY], { limit: pageSize });
  }
  let tombstoned = 0;
  let deletedKeys = metadataCleanup.deletedKeys;
  let protectedCount = 0;
  let scanned = 0;
  let actionable = 0;
  let cursor = 0;
  let lastScannedKey;
  let reachedFutureBucket = false;
  let partialCleanup = false;
  let workExhausted = false;
  let cleanupWork = 0;
  const indexState = {};
  // A public force request asks the worker to make progress immediately; it
  // does not authorize shortening configured lifetimes. Only the daemon's
  // disk-pressure maintenance path may opt into that destructive policy.
  const allowEmergencyShortening = options.allowEmergencyShortening === true;
  const nowBucket = Math.floor(request.now / 3_600_000);
  for (; cursor < records.length; cursor += 1) {
    const record = records[cursor];
    if (record.key[1] > nowBucket && !allowEmergencyShortening) {
      reachedFutureBucket = true;
      break;
    }
    const candidate = expiryCandidate(record);
    if (!candidate || (request.class !== undefined && candidate.retentionClass !== request.class)) {
      lastScannedKey = record.keyBytes;
      continue;
    }
    const forced = candidate.expiresAt > request.now && allowEmergencyShortening;
    if (candidate.expiresAt > request.now && !forced) {
      lastScannedKey = record.keyBytes;
      continue;
    }
    let policyManifest;
    let cleanup;
    if (forced || options.project !== undefined) {
      policyManifest = await store.get(manifestKeys.document(candidate.documentId, candidate.version));
      cleanup = policyManifest === undefined
        ? await store.get(retentionKeys.cleanup(candidate.documentId, candidate.version))
        : undefined;
      if (policyManifest === undefined && cleanup !== undefined) {
        policyManifest = cleanup.manifest ?? await store.get(
          retentionKeys.cleanupManifest(candidate.documentId, candidate.version),
        );
      }
    }
    if (options.project !== undefined
      && (policyManifest?.project ?? cleanup?.project) !== options.project) {
      lastScannedKey = record.keyBytes;
      continue;
    }
    if (forced && !forceEligibleEphemeral(candidate, policyManifest)) {
      lastScannedKey = record.keyBytes;
      continue;
    }
    scanned += 1;
    const begun = await beginExpiry(store, candidate, request.now, { forced });
    if (begun.status === "protected") {
      protectedCount += 1;
      lastScannedKey = record.keyBytes;
      continue;
    }
    if (begun.status === "stale" || begun.status === "missing") {
      lastScannedKey = record.keyBytes;
      continue;
    }
    actionable += 1;
    let manifest = begun.manifest;
    if (manifest === undefined) {
      manifest = await store.get(manifestKeys.document(candidate.documentId, candidate.version));
    }
    if (begun.status === "tombstoned") tombstoned += 1;
    if (!await publishDelete(store, begun.deleteOutboxSequence, options, indexState)) {
      // The semantic tombstone is already durable, so search cannot expose the
      // version as live. Preserve canonical bytes until a later bounded wave
      // publishes the ordered index delete.
      partialCleanup = true;
      break;
    }
    if (manifest !== undefined) {
      const cleanup = await cleanupCanonicalDocument(
        store,
        candidate,
        manifest,
        canonicalWorkLimit - cleanupWork,
        request.now,
      );
      cleanupWork += cleanup.work;
      deletedKeys += cleanup.deleted;
      if (!cleanup.complete) {
        partialCleanup = true;
        break;
      }
    } else if (await store.has(candidate.record.keyBytes)) {
      await store.remove(candidate.record.keyBytes);
      cleanupWork += 1;
      deletedKeys += 1;
    }
    lastScannedKey = record.keyBytes;
    if (actionable >= request.batchSize) {
      cursor += 1;
      break;
    }
    if (canonicalWorkLimit - cleanupWork < 3) {
      workExhausted = true;
      cursor += 1;
      break;
    }
  }
  const maintenanceMore = protectionCleanup.more || leaseCleanup.more || metadataCleanup.more;
  const bounded = maintenanceMore || partialCleanup || workExhausted || (!reachedFutureBucket
    && (cursor < records.length || records.length === pageSize));
  if (bounded && lastScannedKey !== undefined) {
    await store.put(cursorKey, {
      after: lastScannedKey.toString("base64url"),
      updatedAt: Date.now(),
    }, { kind: "retention-scan-cursor" });
  } else {
    await store.remove(cursorKey);
  }
  return assertStoreResult("retention.run", {
    status: bounded
      ? "more-work"
      : (actionable === 0 && protectedCount > 0 ? "blocked" : "complete"),
    scanned,
    tombstoned,
    deletedKeys,
    protected: protectedCount,
  });
}

async function targetProject(store, documentId, version) {
  const manifest = await store.getRecord(manifestKeys.document(documentId, version));
  if (manifest?.payload?.project) {
    return {
      project: manifest.payload.project,
      storedBytes: statusRecordStoredBytes(manifest),
    };
  }
  const cleanup = await store.getRecord(retentionKeys.cleanup(documentId, version));
  return {
    project: cleanup?.payload?.project ?? cleanup?.payload?.manifest?.project,
    storedBytes: (manifest === undefined ? 0 : statusRecordStoredBytes(manifest))
      + (cleanup === undefined ? 0 : statusRecordStoredBytes(cleanup)),
  };
}

async function countStatusRecords(store, prefix, {
  project,
  target,
  matches = () => true,
} = {}) {
  let count = 0;
  const scan = await scanStatusPrefix(store, prefix, async (record) => {
    if (!matches(record.payload)) return 0;
    if (project === undefined) {
      count += 1;
      return 0;
    }
    const identity = target?.(record.payload);
    if (!identity) return 0;
    const owner = await targetProject(store, identity.documentId, identity.version);
    if (owner.project === project) count += 1;
    return owner.storedBytes;
  });
  return Object.freeze({ count, truncated: scan.truncated });
}

export async function retentionStatus(store, options = {}) {
  requireStore(store);
  const now = timestamp(options.now ?? Date.now(), "now");
  let liveDocuments = 0;
  let liveLogicalBytes = 0;
  const manifests = await scanStatusPrefix(store, [KEYSPACE.DOCUMENT], ({ payload }) => {
    if (options.project === undefined || payload.project === options.project) {
      liveDocuments += 1;
      liveLogicalBytes += payload.byteLength ?? 0;
    }
  });
  const supersessions = await countStatusRecords(
    store,
    [KEYSPACE.SUPERSESSION],
    {
      project: options.project,
      target: (payload) => payload && ({
        documentId: payload.documentId,
        version: payload.documentVersion,
      }),
      matches: (payload) => payload?.status === "expired",
    },
  );
  const expiry = await countStatusRecords(
    store,
    [KEYSPACE.EXPIRY],
    {
      project: options.project,
      target: (payload) => payload && ({
        documentId: payload.documentId,
        version: payload.documentVersion,
      }),
      matches: (payload) => payload?.expiresAt <= now,
    },
  );
  const pins = await countStatusRecords(
    store,
    retentionKeys.pinPrefix(),
    {
      project: options.project,
      target: (payload) => payload && ({ documentId: payload.documentId, version: payload.version }),
    },
  );
  const leases = await countStatusRecords(
    store,
    [KEYSPACE.LEASE, "by-id"],
    {
      project: options.project,
      target: (payload) => payload && ({
        documentId: payload.documentId,
        version: payload.documentVersion,
      }),
      matches: (payload) => payload?.expiresAt > now,
    },
  );
  const emergency = await store.get(retentionKeys.emergency());
  return assertStoreResult("retention.status", {
    liveDocuments,
    liveLogicalBytes,
    pins: pins.count,
    leases: leases.count,
    expiredVersions: supersessions.count,
    cleanupBacklog: expiry.count,
    emergencyMode: emergency?.emergencyMode === true,
    approximate: manifests.truncated
      || supersessions.truncated
      || expiry.truncated
      || pins.truncated
      || leases.truncated,
  });
}
