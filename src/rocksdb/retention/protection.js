import {
  assertStoreRequest,
  assertStoreResult,
} from "../../store/store-contract.js";
import { hasActiveDocumentLease } from "../../retrieval/leases.js";
import {
  bumpGuard,
  guardKeys,
  warmGuard,
} from "../guards.js";
import {
  DOCUMENT_HISTORY_FORMAT_VERSION,
  manifestKeys,
  retiredDocumentStatus,
} from "../manifests.js";
import { KEYSPACE } from "../keys.js";
import {
  DEFAULT_RETENTION_WORK_LIMIT,
  MAX_SCAN_LIMIT,
  RETENTION_FORMAT_VERSION,
  SECONDARY_PROTECTION_SCAN_PAGE,
  identifier,
  positiveInteger,
  requireStore,
  retentionKeys,
  timestamp,
} from "./shared.js";

export async function pinDocument(store, {
  pinId,
  documentId,
  version,
  reason,
  now = Date.now(),
} = {}) {
  requireStore(store);
  const request = { pinId, documentId, version, reason };
  assertStoreRequest("store.pin", request);
  const recordedAt = timestamp(now, "now");
  const documentGuard = guardKeys.document(documentId, version);
  const manifest = await store.get(manifestKeys.document(documentId, version));
  if (manifest === undefined) {
    throw new Error(`Cannot pin missing document ${documentId}@${version}.`);
  }
  await warmGuard(store, documentGuard);
  await store.get(retentionKeys.pin(pinId));
  await store.get(manifestKeys.documentHistory(documentId));
  return store.transaction(async (transaction) => {
    await bumpGuard(transaction, documentGuard);
    const existing = await transaction.get(retentionKeys.pin(pinId));
    if (existing !== undefined) {
      const same = existing.documentId === documentId && existing.version === version
        && existing.reason === reason;
      if (!same) throw new Error(`Pin ${pinId} already protects a different target.`);
      return assertStoreResult("store.pin", { status: "already-pinned", pinId });
    }
    if (transaction.scan([KEYSPACE.SUPERSESSION, documentId, version], { limit: 1 }).length > 0) {
      throw new Error(`Cannot pin expired or superseded document ${documentId}@${version}.`);
    }
    if (retiredDocumentStatus(await transaction.get(manifestKeys.documentHistory(documentId)), version)) {
      throw new Error(`Cannot pin expired or superseded document ${documentId}@${version}.`);
    }
    const pin = Object.freeze({
      retentionFormatVersion: RETENTION_FORMAT_VERSION,
      pinId,
      documentId,
      version,
      reason,
      recordedAt,
    });
    await transaction.putImmutable(retentionKeys.pin(pinId), pin, { kind: "retention-pin" });
    await transaction.putImmutable(
      retentionKeys.pinDocument(documentId, version, pinId),
      { pinId, recordedAt },
      { kind: "retention-pin-document" },
    );
    return assertStoreResult("store.pin", { status: "pinned", pinId });
  });
}

export async function unpinDocument(store, { pinId } = {}) {
  requireStore(store);
  assertStoreRequest("store.unpin", { pinId });
  return store.transaction(async (transaction) => {
    const pin = await transaction.get(retentionKeys.pin(pinId));
    if (pin === undefined) {
      return assertStoreResult("store.unpin", { status: "not-found", pinId });
    }
    await transaction.remove(retentionKeys.pin(pinId));
    await transaction.remove(retentionKeys.pinDocument(pin.documentId, pin.version, pinId));
    return assertStoreResult("store.unpin", { status: "unpinned", pinId });
  });
}

function normalizeProtectionRequest(request, now, project) {
  assertStoreRequest("store.protect", request);
  const issuedAt = timestamp(now, "now");
  if (issuedAt > Number.MAX_SAFE_INTEGER - request.ttlMs) {
    throw new RangeError("Protection expiry overflows a safe integer.");
  }
  const sessions = [...new Set(request.sessionIds)];
  const targets = [];
  const seen = new Set();
  for (const target of request.documentVersions) {
    const identity = `${target.documentId}\0${target.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    targets.push({ documentId: target.documentId, version: target.version });
  }
  return Object.freeze({
    retentionFormatVersion: RETENTION_FORMAT_VERSION,
    ownerId: request.ownerId,
    ...(project === undefined ? {} : { project: identifier(project, "project") }),
    issuedAt,
    expiresAt: issuedAt + request.ttlMs,
    sessionIds: Object.freeze(sessions),
    documentVersions: Object.freeze(targets),
  });
}

function liveProtectionHistory(history, target) {
  if (history === undefined) return undefined;
  if (!history || history.documentHistoryFormatVersion !== DOCUMENT_HISTORY_FORMAT_VERSION
    || history.documentId !== target.documentId
    || typeof history.project !== "string" || history.project.length === 0
    || history.highestAdmittedVersion !== target.version
    || history.retiredThrough !== target.version - 1) {
    return null;
  }
  return Object.freeze({ project: history.project });
}

function invalidProtectionTarget(target) {
  const error = new Error(
    `Cannot protect missing, unauthorized, expired, or superseded document ${target.documentId}@${target.version}.`,
  );
  error.code = "UNAUTHORIZED";
  return error;
}

async function removeProtectionReferences(transaction, protection) {
  for (const sessionId of protection.sessionIds ?? []) {
    await transaction.remove(retentionKeys.protectionSession(
      sessionId,
      protection.ownerId,
      protection.project,
    ));
  }
  for (const target of protection.documentVersions ?? []) {
    await transaction.remove(retentionKeys.protectionDocument(
      target.documentId,
      target.version,
      protection.ownerId,
    ));
  }
  await transaction.remove(retentionKeys.protectionExpiry(
    protection.expiresAt,
    protection.ownerId,
  ));
}

function protectionCleanupProgress(protection) {
  const progress = protection?.cleanupProgress;
  return {
    sessionOffset: Number.isSafeInteger(progress?.sessionOffset) && progress.sessionOffset >= 0
      ? progress.sessionOffset
      : 0,
    documentOffset: Number.isSafeInteger(progress?.documentOffset) && progress.documentOffset >= 0
      ? progress.documentOffset
      : 0,
  };
}

async function cleanupExpiredProtectionBatch(store, record, now, workLimit) {
  const expiresAt = record.key.at(-2);
  const ownerId = record.key.at(-1);
  await store.get(retentionKeys.protection(ownerId));
  return store.transaction(async (transaction) => {
    const current = await transaction.get(retentionKeys.protection(ownerId));
    if (current === undefined || current.expiresAt !== expiresAt) {
      await transaction.remove(record.keyBytes);
      return Object.freeze({ work: 1, released: false, complete: true });
    }
    if (current.expiresAt > now) {
      return Object.freeze({ work: 0, released: false, complete: true });
    }

    let { sessionOffset, documentOffset } = protectionCleanupProgress(current);
    let work = 0;
    while (sessionOffset < (current.sessionIds?.length ?? 0) && work < workLimit) {
      await transaction.remove(retentionKeys.protectionSession(
        current.sessionIds[sessionOffset],
        current.ownerId,
        current.project,
      ));
      sessionOffset += 1;
      work += 1;
    }
    while (documentOffset < (current.documentVersions?.length ?? 0) && work < workLimit) {
      const target = current.documentVersions[documentOffset];
      await transaction.remove(retentionKeys.protectionDocument(
        target.documentId,
        target.version,
        current.ownerId,
      ));
      documentOffset += 1;
      work += 1;
    }

    const complete = sessionOffset >= (current.sessionIds?.length ?? 0)
      && documentOffset >= (current.documentVersions?.length ?? 0);
    if (complete) {
      await transaction.remove(retentionKeys.protectionExpiry(expiresAt, ownerId));
      await transaction.remove(retentionKeys.protection(ownerId));
      return Object.freeze({ work, released: true, complete: true });
    }
    await transaction.put(retentionKeys.protection(ownerId), {
      ...current,
      cleanupProgress: { sessionOffset, documentOffset },
    }, { kind: "retention-protection" });
    return Object.freeze({ work, released: false, complete: false });
  });
}

/** Create or heartbeat one owner-scoped active-context protection set. */
export async function protectEvidence(store, request, options = {}) {
  requireStore(store);
  const protection = normalizeProtectionRequest(
    request,
    options.now ?? Date.now(),
    options.project,
  );
  const guards = [
    ...protection.sessionIds.map((sessionId) => guardKeys.session(sessionId)),
    ...protection.documentVersions.map((target) => guardKeys.document(target.documentId, target.version)),
  ];
  for (const guard of guards) await warmGuard(store, guard);
  // Keep only the authorization field needed by the atomic recheck. A valid
  // request can name 1,000 manifests and each manifest can contain several
  // MiB of metadata; retaining the decoded payloads here would make memory
  // proportional to the complete protected corpus.
  const validatedTargets = new Map();
  for (const target of protection.documentVersions) {
    const manifestKey = manifestKeys.document(target.documentId, target.version);
    const exists = typeof store.hasKey === "function"
      ? await store.hasKey(manifestKey)
      : await store.has(manifestKey);
    const history = await store.get(manifestKeys.documentHistory(target.documentId));
    let summary = liveProtectionHistory(history, target);
    let ledgerBacked = true;
    // Schema-v1 archives normally have the compact ledger. Retain a bounded
    // compatibility path for legacy direct-library records that predate it.
    if (summary === undefined && exists) {
      const manifest = store.scan(manifestKey, { limit: 1, fillCache: false })[0]?.payload;
      summary = manifest === undefined ? null : { project: manifest.project };
      ledgerBacked = false;
    }
    if (!exists || summary === null
      || (protection.project !== undefined && summary?.project !== protection.project)) {
      throw invalidProtectionTarget(target);
    }
    validatedTargets.set(target, Object.freeze({
      ledgerBacked,
      project: summary.project,
    }));
    await store.get([KEYSPACE.SUPERSESSION, target.documentId, target.version]);
  }
  await store.get(retentionKeys.protection(protection.ownerId));
  return store.transaction(async (transaction) => {
    for (const guard of guards) await bumpGuard(transaction, guard);
    for (const target of protection.documentVersions) {
      const validated = validatedTargets.get(target);
      const supersession = transaction.scan([
        KEYSPACE.SUPERSESSION,
        target.documentId,
        target.version,
      ], { limit: 1 })[0]?.payload;
      const currentHistory = liveProtectionHistory(
        await transaction.get(manifestKeys.documentHistory(target.documentId)),
        target,
      );
      const historyIsCurrent = currentHistory === undefined
        ? validated?.ledgerBacked === false
        : currentHistory !== null && currentHistory.project === validated?.project;
      if (!validated || supersession !== undefined || !historyIsCurrent
        || (protection.project !== undefined && validated.project !== protection.project)) {
        throw invalidProtectionTarget(target);
      }
    }
    const previous = await transaction.get(retentionKeys.protection(protection.ownerId));
    if (previous !== undefined) await removeProtectionReferences(transaction, previous);
    await transaction.put(
      retentionKeys.protection(protection.ownerId),
      protection,
      { kind: "retention-protection" },
    );
    await transaction.put(
      retentionKeys.protectionExpiry(protection.expiresAt, protection.ownerId),
      { ownerId: protection.ownerId, expiresAt: protection.expiresAt },
      { kind: "retention-protection-expiry" },
    );
    for (const sessionId of protection.sessionIds) {
      await transaction.put(
        retentionKeys.protectionSession(sessionId, protection.ownerId, protection.project),
        { ownerId: protection.ownerId, expiresAt: protection.expiresAt },
        { kind: "retention-protection-session" },
      );
    }
    for (const target of protection.documentVersions) {
      await transaction.put(
        retentionKeys.protectionDocument(target.documentId, target.version, protection.ownerId),
        { ownerId: protection.ownerId, expiresAt: protection.expiresAt },
        { kind: "retention-protection-document" },
      );
    }
    return assertStoreResult("store.protect", {
      ownerId: protection.ownerId,
      expiresAt: protection.expiresAt,
      protectedSessions: protection.sessionIds.length,
      protectedDocuments: protection.documentVersions.length,
    });
  });
}

export async function releaseProtection(store, { ownerId } = {}) {
  requireStore(store);
  assertStoreRequest("store.release-protection", { ownerId });
  return store.transaction(async (transaction) => {
    const protection = await transaction.get(retentionKeys.protection(ownerId));
    if (protection === undefined) {
      return assertStoreResult("store.release-protection", { released: 0 });
    }
    await removeProtectionReferences(transaction, protection);
    await transaction.remove(retentionKeys.protection(ownerId));
    return assertStoreResult("store.release-protection", {
      released: protection.sessionIds.length + protection.documentVersions.length,
    });
  });
}

/** Reclaim expired owner heartbeats and all of their secondary references. */
export async function cleanupExpiredProtections(store, options = {}) {
  requireStore(store);
  const now = timestamp(options.now ?? Date.now(), "now");
  const limit = positiveInteger(options.limit ?? 1_000, "limit", MAX_SCAN_LIMIT);
  const workLimit = positiveInteger(
    options.workLimit ?? DEFAULT_RETENTION_WORK_LIMIT,
    "workLimit",
    MAX_SCAN_LIMIT,
  );
  const due = store.scan(retentionKeys.protectionExpiryPrefix(), { limit });
  let scanned = 0;
  let released = 0;
  let work = 0;
  let partial = false;
  for (const record of due) {
    const expiresAt = record.key.at(-2);
    if (!Number.isSafeInteger(expiresAt) || expiresAt > now) break;
    if (work >= workLimit) {
      partial = true;
      break;
    }
    scanned += 1;
    const cleaned = await cleanupExpiredProtectionBatch(
      store,
      record,
      now,
      workLimit - work,
    );
    work += cleaned.work;
    if (cleaned.released) released += 1;
    if (!cleaned.complete) {
      partial = true;
      break;
    }
  }
  return Object.freeze({
    scanned,
    released,
    work,
    more: partial || (due.length === limit && due.at(-1)?.key?.at(-2) <= now),
  });
}

function activeSecondary(view, prefix, now) {
  let after;
  for (;;) {
    let pageCount = 0;
    let lastKey;
    for (const { keyBytes, payload } of view.iterate(prefix, {
      limit: SECONDARY_PROTECTION_SCAN_PAGE,
      fillCache: false,
      ...(after === undefined ? {} : { after }),
    })) {
      pageCount += 1;
      lastKey = keyBytes;
      if (payload?.expiresAt > now) return true;
    }
    if (pageCount < SECONDARY_PROTECTION_SCAN_PAGE) return false;
    after = lastKey;
  }
}

export async function isDocumentProtected(view, manifest, options = {}) {
  const now = timestamp(options.now ?? Date.now(), "now");
  if (manifest.protectedAtAdmission === true) return true;
  if (view.scan(retentionKeys.pinDocumentPrefix(manifest.documentId, manifest.version), { limit: 1 }).length > 0) {
    return true;
  }
  if (activeSecondary(
    view,
    retentionKeys.protectionDocumentPrefix(manifest.documentId, manifest.version),
    now,
  )) return true;
  if (activeSecondary(
    view,
    retentionKeys.protectionSessionPrefix(manifest.sessionId, manifest.project),
    now,
  )) return true;
  // Preserve direct-library protections written before project-scoped daemon
  // authorization was introduced. The daemon never creates this legacy form.
  if (activeSecondary(view, retentionKeys.protectionSessionPrefix(manifest.sessionId), now)) return true;
  return hasActiveDocumentLease(view, manifest.documentId, manifest.version, { now });
}
