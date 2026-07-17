import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { canonicalDocumentIdentityHash } from "../document-identity.js";
import {
  admitDocument,
  manifestKeys,
  readCanonicalDocument,
  retiredDocumentStatus,
} from "../rocksdb/manifests.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { createExactIndexHandler } from "../rocksdb/index/exact.js";
import { createBm25IndexHandler } from "../rocksdb/index/bm25.js";
import { createStructuralIndexHandler } from "../rocksdb/index/structural.js";
import { IndexWorker } from "../rocksdb/indexer.js";
import { outboxKeys, outboxMetrics } from "../rocksdb/outbox.js";
import { scanStatusPrefix } from "../rocksdb/status-scan.js";
import {
  migrationRetentionGate,
  prepareMigrationAdmission,
} from "../migration/index.js";
import {
  pinDocument,
  cleanupExpiredProtections,
  protectEvidence,
  releaseProtection,
  retentionStatus,
  runRetention,
  unpinDocument,
} from "../rocksdb/retention.js";
import { cleanupExpiredLeases } from "../retrieval/leases.js";
import { removeFrozenHint } from "../retrieval/hints.js";
import { recallArchive } from "../retrieval/recall.js";
import { preflightArchive } from "../retrieval/preflight.js";
import { searchArchive } from "../retrieval/search.js";
import {
  MAX_DIRECT_CHUNK_TABLE_ENTRIES,
  MAX_DIRECT_DOCUMENT_RESPONSE_BYTES,
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
  MAX_DIRECT_SOURCE_MESSAGE_KEYS,
  STORE_ERROR_CODES,
  boundedStoreErrorMessage,
} from "../store-contract.js";
import { DaemonMaintenance } from "./maintenance.js";

const STATUS_SCAN_PAGE = 10_000;
const MAX_BACKGROUND_ERRORS = 100;
const BACKGROUND_ERROR_CODES = new Set(STORE_ERROR_CODES);
const INDEX_DRAIN_LIMIT = 1_000;
const INDEX_DRAIN_MS = 250;
const INDEX_RETRY_BASE_MS = 50;
const INDEX_RETRY_MAX_MS = 5_000;
const FOREGROUND_INDEX_MAX_BYTES = 64 * 1_024;
const STATUS_PROJECT_CHUNK_LIMIT = 10_000;
const STATUS_PROJECT_CHUNK_BYTES = 1 * 1_024 * 1_024;

function retryableBackgroundError(error) {
  return error?.retryable === true
    || error?.code === "STORE_BUSY"
    || error?.code === "DISK_LOW"
    || error?.code === "CONNECTION_CLOSED";
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function scopedIdentity(project, value) {
  const digest = createHash("sha256").update(project).digest("hex").slice(0, 24);
  return `project:${digest}:${value}`;
}

function* scanPages(store, prefix) {
  let after;
  while (true) {
    let pageRecords = 0;
    let lastKey;
    for (const record of store.iterate(prefix, {
      limit: STATUS_SCAN_PAGE,
      fillCache: false,
      ...(after === undefined ? {} : { after }),
    })) {
      pageRecords += 1;
      lastKey = record.keyBytes;
      yield record;
    }
    if (pageRecords < STATUS_SCAN_PAGE) return;
    after = lastKey;
  }
}

function latestManifest(store, documentId, version) {
  if (version !== undefined) {
    return store.get([KEYSPACE.DOCUMENT, documentId, version]);
  }
  return Promise.resolve(store.scan([KEYSPACE.DOCUMENT, documentId], {
    reverse: true,
    limit: 1,
  })[0]?.payload);
}

function supersession(store, documentId, version) {
  return store.scan([KEYSPACE.SUPERSESSION, documentId, version], { limit: 1 })[0]?.payload;
}

function documentReadFailure(manifest, marker, requestedId, requestedVersion) {
  if (marker?.status === "expired") {
    return {
      status: "expired",
      documentId: requestedId,
      ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
      reason: marker.reason,
    };
  }
  if (marker !== undefined) {
    return {
      status: "superseded",
      documentId: requestedId,
      ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
      reason: marker.reason,
    };
  }
  return {
    status: "missing",
    documentId: requestedId,
    ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
    reason: "The requested archived document is unavailable.",
  };
}

function directDocumentIdentity(manifest) {
  return {
    status: "resolved",
    materialization: "identity",
    document: {
      documentId: manifest.documentId,
      version: manifest.version,
      contentHash: manifest.contentHash,
      identityHash: canonicalDocumentIdentityHash(manifest),
      byteLength: manifest.byteLength,
    },
  };
}

function directChunkTable(manifest) {
  const sourceMessageKeys = manifest.sourceMessageKeys
    .slice(0, MAX_DIRECT_SOURCE_MESSAGE_KEYS);
  const chunkTable = manifest.chunks
    .slice(0, MAX_DIRECT_CHUNK_TABLE_ENTRIES)
    .map(({ chunkId, ordinal, startByte, endByte, byteLength }) => ({
      chunkId,
      ordinal,
      startByte,
      endByte,
      byteLength,
    }));
  const result = {
    status: "resolved",
    materialization: "chunk-table",
    document: {
      documentId: manifest.documentId,
      version: manifest.version,
      sourceKey: manifest.sourceKey,
      sourceKeyStatus: manifest.sourceKeyStatus ?? "preserved",
      sessionId: manifest.sessionId,
      project: manifest.project,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      contentHash: manifest.contentHash,
      byteLength: manifest.byteLength,
      sourceMessageKeys,
      sourceMessageKeyCount: manifest.sourceMessageKeys.length,
      sourceMessageKeysTruncated: sourceMessageKeys.length < manifest.sourceMessageKeys.length,
      chunkCount: manifest.chunks.length,
      chunkTable,
      chunkTableTruncated: chunkTable.length < manifest.chunks.length,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_DIRECT_DOCUMENT_RESPONSE_BYTES) {
    throw codedError("INTERNAL", "The bounded direct-document table exceeded its invariant.");
  }
  return result;
}

function fullDocumentStaticBytes(manifest) {
  return Buffer.byteLength(JSON.stringify({
    status: "resolved",
    document: {
      documentId: manifest.documentId,
      version: manifest.version,
      sourceKey: manifest.sourceKey,
      sourceKeyStatus: manifest.sourceKeyStatus,
      sessionId: manifest.sessionId,
      project: manifest.project,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      text: "",
      metadata: manifest.metadata,
      sourceMessageKeys: manifest.sourceMessageKeys,
    },
  }), "utf8");
}

function canMaterializeDirectDocument(manifest) {
  return manifest.byteLength <= MAX_DIRECT_DOCUMENT_SOURCE_BYTES
    && fullDocumentStaticBytes(manifest) <= MAX_DIRECT_DOCUMENT_RESPONSE_BYTES;
}

function filesystemStatus(path, emergencyMode) {
  try {
    const value = statfsSync(path, { bigint: true });
    const freeBytes = Number(value.bavail * value.bsize);
    return Number.isSafeInteger(freeBytes) && freeBytes >= 0
      ? { freeBytes, emergencyMode }
      : { emergencyMode };
  } catch {
    return { emergencyMode };
  }
}

/**
 * Store-owned operation runtime. It serializes outbox publication while normal
 * client requests remain concurrent, and it is the only layer exposed over IPC.
 */
export class DaemonOperations {
  constructor(store, options = {}) {
    this.store = store;
    this.admissionStore = Object.freeze({
      get: (...args) => this.store.get(...args),
      scan: (...args) => this.store.scan(...args),
      commitCanonical: (prepared) => this.commitCanonicalAdmission(prepared),
    });
    this.backgroundErrors = options.backgroundErrors ?? [];
    this.indexWorker = new IndexWorker(store, {
      ...(options.indexWorker ?? {}),
      handlers: [
        createExactIndexHandler(options.exact),
        createBm25IndexHandler(options.bm25),
        createStructuralIndexHandler(),
      ],
    });
    this.maintenance = new DaemonMaintenance(store, {
      ...(options.maintenance ?? {}),
      runRetention: (payload) => this.runRetentionWave(payload, {
        allowEmergencyShortening: true,
      }),
      compact: (reason) => this.compact({ reason }),
      recordError: (error) => this.recordBackgroundError(error),
    });
    this.drainPromise = undefined;
    this.idleDrainPromise = undefined;
    this.indexImmediate = undefined;
    this.indexRetryTimer = undefined;
    this.indexRetryAttempt = 0;
    this.closed = false;
    this.closing = undefined;
  }

  async initialize() {
    await this.indexWorker.initialize();
    // Recovery makes a bounded amount of progress before readiness. The last
    // fully published generation is always queryable while the remaining
    // ordered backlog drains in the background.
    if (await this.foregroundHeadEligible()) {
      try {
        await this.drainIndex({
          throwOnError: true,
          limit: 1,
          maxDurationMs: INDEX_DRAIN_MS,
        });
      } catch (error) {
        // This is only a readiness optimization over replayable derived work.
        // A transient handler fault must not make valid canonical data and the
        // last published generation unavailable after restart.
        this.recordBackgroundError(error);
      }
    }
    await this.maintenance.initialize();
    this.scheduleIndexing();
    return this;
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.#close();
    return this.closing;
  }

  async #close() {
    if (this.indexImmediate !== undefined) {
      clearImmediate(this.indexImmediate);
      this.indexImmediate = undefined;
    }
    if (this.indexRetryTimer !== undefined) {
      clearTimeout(this.indexRetryTimer);
      this.indexRetryTimer = undefined;
    }
    await this.maintenance.close();
    await this.idleDrainPromise?.catch(() => {});
    await this.drainPromise?.catch(() => {});
  }

  drainIndex(options = {}) {
    if (this.drainPromise) return this.drainPromise;
    const work = this.indexWorker.drain(options).then((result) => {
      for (const failure of result.errors ?? []) this.recordBackgroundError(failure);
      return result;
    });
    let wrapped;
    wrapped = work.finally(() => {
      if (this.drainPromise === wrapped) this.drainPromise = undefined;
    });
    this.drainPromise = wrapped;
    return wrapped;
  }

  recordBackgroundError(error) {
    const code = BACKGROUND_ERROR_CODES.has(error?.code) ? error.code : "INTERNAL";
    this.backgroundErrors.push({
      code,
      message: boundedStoreErrorMessage(error),
      retryable: code === "STORE_BUSY" || code === "DISK_LOW" || code === "CONNECTION_CLOSED",
    });
    if (this.backgroundErrors.length > MAX_BACKGROUND_ERRORS) {
      this.backgroundErrors.splice(0, this.backgroundErrors.length - MAX_BACKGROUND_ERRORS);
    }
  }

  continueIndexing() {
    if (this.closed || this.idleDrainPromise) return;
    let retryableFailure = false;
    const work = this.drainIndexUntilIdle().catch((error) => {
      this.recordBackgroundError(error);
      retryableFailure = retryableBackgroundError(error);
    }).then((result) => {
      if (!retryableFailure) this.indexRetryAttempt = 0;
      return result;
    });
    let wrapped;
    wrapped = work.finally(() => {
      if (this.idleDrainPromise === wrapped) this.idleDrainPromise = undefined;
      if (retryableFailure) this.scheduleIndexRetry();
    });
    this.idleDrainPromise = wrapped;
  }

  scheduleIndexRetry() {
    if (this.closed || this.indexRetryTimer !== undefined
      || this.indexImmediate !== undefined || this.idleDrainPromise) return;
    const delayMs = Math.min(
      INDEX_RETRY_MAX_MS,
      INDEX_RETRY_BASE_MS * (2 ** Math.min(this.indexRetryAttempt, 7)),
    );
    this.indexRetryAttempt += 1;
    this.indexRetryTimer = setTimeout(() => {
      this.indexRetryTimer = undefined;
      this.scheduleIndexing();
    }, delayMs);
    this.indexRetryTimer.unref?.();
  }

  scheduleIndexing() {
    if (this.closed || this.indexImmediate !== undefined || this.idleDrainPromise) return;
    if (this.indexRetryTimer !== undefined) {
      clearTimeout(this.indexRetryTimer);
      this.indexRetryTimer = undefined;
    }
    this.indexImmediate = setImmediate(() => {
      this.indexImmediate = undefined;
      this.continueIndexing();
    });
  }

  async foregroundHeadEligible() {
    const cursor = await this.store.get(outboxKeys.cursor());
    const sequence = cursor?.nextSequence ?? 1;
    const entry = await this.store.get(outboxKeys.entry(sequence));
    if (entry === undefined) return true;
    const manifest = await this.store.get(manifestKeys.document(
      entry.documentId,
      entry.documentVersion,
    ));
    if (manifest === undefined) return true;
    const structuralBytes = Buffer.byteLength(
      JSON.stringify(manifest.structuralMessages ?? []),
      "utf8",
    );
    return manifest.byteLength + structuralBytes <= FOREGROUND_INDEX_MAX_BYTES;
  }

  async drainIndexUntilIdle() {
    for (;;) {
      if (this.closed) return { processed: 0, terminal: "closed" };
      const result = await this.drainIndex({
        throwOnError: true,
        limit: INDEX_DRAIN_LIMIT,
        maxDurationMs: INDEX_DRAIN_MS,
      });
      if (result.terminal === "idle") return result;
      if (result.terminal === "limit" || (result.terminal === "deadline" && result.processed > 0)) {
        continue;
      }
      const error = new Error(`Index backlog did not drain to idle: ${result.terminal}.`);
      error.code = result.terminal === "busy" ? "STORE_BUSY" : "INTERNAL";
      throw error;
    }
  }

  async commitCanonicalAdmission(prepared) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const gate = await prepareMigrationAdmission(this.store, {
        requestId: prepared.requestId,
        documentId: prepared.manifest.documentId,
      });
      try {
        return await this.store.commitCanonical({
          ...prepared,
          // Gate checks are compare-only preconditions and intentionally do
          // not alter the canonical idempotency fingerprint.
          mustMatch: [...(prepared.mustMatch ?? []), ...(gate.mustMatch ?? [])],
          mustBeAbsent: [
            ...(prepared.mustBeAbsent ?? []),
            ...(gate.mustBeAbsent ?? []),
          ],
          // Preserve document-history and any future canonical transitions.
          transitions: [...(prepared.transitions ?? []), ...gate.transitions],
        });
      } catch (error) {
        // Re-evaluate either a concurrent first authority seal or a stale
        // not-started observation. The latter retry reaches the migration
        // phase error instead of exposing a generic precondition conflict.
        const staleNotStarted = (gate.mustBeAbsent?.length ?? 0) > 0
          && (error?.code === "CONFLICT" || error?.code === "SUPERSEDED");
        if ((!gate.sealsAuthority && !staleNotStarted) || attempt > 0) throw error;
      }
    }
    throw codedError("CONFLICT", "Migration authority admission did not converge.");
  }

  async put(payload, context) {
    if (payload.document.project !== context.project) {
      throw codedError("UNAUTHORIZED", "A client may only archive into its authenticated project.");
    }
    const admissionBytes = Buffer.byteLength(payload.document.text, "utf8")
      + Buffer.byteLength(JSON.stringify(payload.structuralMessages ?? []), "utf8");
    await this.maintenance.checkAdmission(admissionBytes);
    const result = await admitDocument(this.admissionStore, payload);
    // The WAL-backed canonical commit is the acknowledgement boundary. Search,
    // preflight, retention, and restart readiness use the last published
    // generation. Give this admission a bounded publication opportunity so a
    // normal put followed immediately by recall remains read-your-write, but do
    // not make the request wait for an arbitrarily large pre-existing backlog.
    try {
      await this.publishAdmissionIndex(result.outboxSequence, admissionBytes);
    } catch (error) {
      // Canonical WAL commit is the acknowledgement boundary. Indexing is
      // derived, replayable work, so a foreground publication fault must not
      // turn a committed write (or an atomic migration-authority seal) into an
      // apparent admission failure. Preserve the diagnostic and retry through
      // the ordered background worker.
      this.recordBackgroundError(error);
    } finally {
      this.scheduleIndexing();
    }
    return result;
  }

  async get(payload, context) {
    const manifest = await latestManifest(this.store, payload.documentId, payload.version);
    if (manifest !== undefined && manifest.project !== context.project) {
      // A foreign canonical identity must be indistinguishable from an absent
      // one. In particular, do not disclose its latest version or use a
      // project-specific reason when the caller omitted a version.
      return documentReadFailure(undefined, undefined, payload.documentId, payload.version);
    }
    const version = manifest?.version ?? payload.version;
    const history = await this.store.get(manifestKeys.documentHistory(payload.documentId));
    const retired = history?.project === context.project
      ? retiredDocumentStatus(history, version)
      : undefined;
    if (manifest === undefined || version === undefined) {
      const resolvedVersion = retired?.version ?? version;
      const marker = history?.project === context.project && resolvedVersion !== undefined
        ? supersession(this.store, payload.documentId, resolvedVersion)
        : undefined;
      return documentReadFailure(
        manifest,
        marker ?? retired,
        payload.documentId,
        resolvedVersion,
      );
    }
    await this.store.get(manifestKeys.document(manifest.documentId, manifest.version));
    await this.store.get([KEYSPACE.SUPERSESSION, manifest.documentId, manifest.version]);
    const materialize = payload.view !== "identity" && canMaterializeDirectDocument(manifest);
    if (materialize) {
      for (const chunkId of new Set(manifest.chunks.map(({ chunkId }) => chunkId))) {
        await this.store.get(manifestKeys.chunk(chunkId));
      }
    }
    return this.store.snapshot(async (view) => {
      const snapshotManifest = await view.get(manifestKeys.document(manifest.documentId, manifest.version));
      const marker = view.scan([
        KEYSPACE.SUPERSESSION,
        manifest.documentId,
        manifest.version,
      ], { limit: 1 })[0]?.payload;
      if (snapshotManifest === undefined
        || snapshotManifest.project !== context.project
        || marker !== undefined) {
        const snapshotHistory = await view.get(manifestKeys.documentHistory(payload.documentId));
        const snapshotRetired = snapshotHistory?.project === context.project
          ? retiredDocumentStatus(snapshotHistory, version)
          : undefined;
        return documentReadFailure(
          snapshotManifest,
          marker ?? snapshotRetired,
          payload.documentId,
          version,
        );
      }
      if (payload.view === "identity") return directDocumentIdentity(snapshotManifest);
      if (!canMaterializeDirectDocument(snapshotManifest)) return directChunkTable(snapshotManifest);
      const document = await readCanonicalDocument(view, manifest.documentId, manifest.version);
      if (document === undefined) {
        return documentReadFailure(undefined, undefined, payload.documentId, version);
      }
      const result = { status: "resolved", document };
      return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_DIRECT_DOCUMENT_RESPONSE_BYTES
        ? result
        : directChunkTable(snapshotManifest);
    });
  }

  async search(payload, context) {
    this.continueIndexing();
    const now = Date.now();
    await cleanupExpiredProtections(this.store, { now, limit: 1_000 });
    await cleanupExpiredLeases(this.store, { now, limit: 1_000 });
    return searchArchive(this.store, { ...payload, project: context.project });
  }

  recall(payload, context) {
    return recallArchive(this.store, payload, {
      project: context.project,
      sessionIds: payload.sessionIds ?? [],
    });
  }

  async count(payload, context) {
    const sessionIds = new Set(payload.sessionIds
      ?? (payload.sessionId === undefined ? [] : [payload.sessionId]));
    const effectiveScope = payload.scope === "all" ? "project" : payload.scope;
    const prefixes = effectiveScope === "session"
      ? [...sessionIds].map((sessionId) => manifestKeys.sessionDocumentReferencePrefix(
          context.project,
          sessionId,
        ))
      : [[KEYSPACE.META, "session-document-reference", context.project]];
    let count = 0;
    // Admission and migration write one compact project/session reference per
    // canonical version, and retention removes it only after tombstoning. Scan
    // that index instead of multi-MiB manifests; a marker point read excludes
    // versions during the interval before their reference cleanup completes.
    for (const prefix of prefixes) {
      for (const { payload: reference } of scanPages(this.store, prefix)) {
        const marker = await this.store.get([
          KEYSPACE.SUPERSESSION,
          reference.documentId,
          reference.documentVersion,
        ]);
        if (marker === undefined) count += 1;
      }
    }
    return { count };
  }

  async preflight(payload, context) {
    this.continueIndexing();
    const now = Date.now();
    await cleanupExpiredProtections(this.store, { now, limit: 1_000 });
    await cleanupExpiredLeases(this.store, { now, limit: 1_000 });
    const { epochId, epochBudgetTokens, ...request } = payload;
    return preflightArchive(this.store, { ...request, project: context.project }, {
      ...(epochId === undefined ? {} : { epochId }),
      ...(epochBudgetTokens === undefined ? {} : { epochBudgetTokens }),
    });
  }

  async removeHints(payload, context) {
    let removed = 0;
    let notFound = 0;
    for (const messageKey of new Set(payload.messageKeys)) {
      const result = await removeFrozenHint(this.store, {
        project: context.project,
        sessionId: payload.sessionId,
        messageKey,
      });
      if (result.status === "removed") removed += 1;
      else notFound += 1;
    }
    return { removed, notFound };
  }

  async authorizedManifest(documentId, version, context, action) {
    const manifest = await this.store.get([KEYSPACE.DOCUMENT, documentId, version]);
    if (manifest === undefined || manifest.project !== context.project) {
      throw codedError("UNAUTHORIZED", `A client may only ${action} documents in its authenticated project.`);
    }
    return manifest;
  }

  async pin(payload, context) {
    await this.authorizedManifest(payload.documentId, payload.version, context, "pin");
    const result = await pinDocument(this.store, {
      ...payload,
      pinId: scopedIdentity(context.project, payload.pinId),
    });
    return { ...result, pinId: payload.pinId };
  }

  async unpin(payload, context) {
    const result = await unpinDocument(this.store, {
      pinId: scopedIdentity(context.project, payload.pinId),
    });
    return { ...result, pinId: payload.pinId };
  }

  async protect(payload, context) {
    // protectEvidence authorizes the complete target set from compact durable
    // document ledgers before its single atomic transaction. Re-reading every
    // full manifest here would retain no extra safety and can force a valid
    // max-count request through several GiB of canonical metadata.
    const result = await protectEvidence(this.store, {
      ...payload,
      ownerId: scopedIdentity(context.project, payload.ownerId),
    }, { project: context.project });
    return { ...result, ownerId: payload.ownerId };
  }

  async releaseProtection(payload, context) {
    return releaseProtection(this.store, {
      ownerId: scopedIdentity(context.project, payload.ownerId),
    });
  }

  async compact(options = {}) {
    const before = this.store.properties().totalSstBytes;
    try {
      if (options.reason === "operator") {
        await this.store.compact();
      }
      await this.store.flush();
      return {
        // RocksDB's normal LSM workers reclaim routine deletion waves. A full
        // synchronous database compaction is reserved for an explicit operator
        // request because its I/O and temporary-space cost is unbounded.
        status: options.reason === "operator" ? "complete" : "scheduled",
        bytesBefore: before,
        bytesAfter: this.store.properties().totalSstBytes,
      };
    } catch (error) {
      return {
        status: "error",
        bytesBefore: before,
        bytesAfter: this.store.properties().totalSstBytes,
        error: boundedStoreErrorMessage(error),
      };
    }
  }

  async publishIndexSequence(sequence) {
    for (let wave = 0; wave < 4; wave += 1) {
      if ((await this.store.get(outboxKeys.state(sequence)))?.status === "processed") return true;
      await this.drainIndex({
        throwOnError: true,
        limit: INDEX_DRAIN_LIMIT,
        maxDurationMs: INDEX_DRAIN_MS,
      });
    }
    return (await this.store.get(outboxKeys.state(sequence)))?.status === "processed";
  }

  async publishAdmissionIndex(sequence, admissionBytes) {
    if (admissionBytes > FOREGROUND_INDEX_MAX_BYTES) return false;
    const cursor = await this.store.get(outboxKeys.cursor());
    // Never make a small admission wait behind an older large backlog item.
    // The ordered background worker will publish both after the canonical
    // acknowledgement has returned.
    if ((cursor?.nextSequence ?? 1) !== sequence) return false;
    return this.publishIndexSequence(sequence);
  }

  publishIndexDelete(sequence) {
    return this.publishIndexSequence(sequence);
  }

  async runRetentionWave(payload, options = {}) {
    // The outer shared lease prevents migration start or verification from
    // entering their exclusive phase between this status check and any of the
    // bounded logical-deletion transactions in the wave.
    return this.store.withSharedWrite(async () => {
      const gate = await migrationRetentionGate(this.store);
      if (!gate.allowed) {
        return {
          status: "blocked",
          scanned: 0,
          tombstoned: 0,
          deletedKeys: 0,
          protected: 0,
        };
      }
      return runRetention(this.store, payload, {
        ...options,
        publishIndexDelete: (sequence) => this.publishIndexDelete(sequence),
      });
    });
  }

  async retention(payload, context) {
    return this.runRetentionWave(payload, { project: context.project });
  }

  handlers() {
    return {
      "store.put": (payload, context) => this.put(payload, context),
      "store.get": (payload, context) => this.get(payload, context),
      "store.search": (payload, context) => this.search(payload, context),
      "store.recall": (payload, context) => this.recall(payload, context),
      "store.count": (payload, context) => this.count(payload, context),
      "store.preflight": (payload, context) => this.preflight(payload, context),
      "store.remove-hints": (payload, context) => this.removeHints(payload, context),
      "store.protect": (payload, context) => this.protect(payload, context),
      "store.release-protection": (payload, context) => this.releaseProtection(payload, context),
      "store.pin": (payload, context) => this.pin(payload, context),
      "store.unpin": (payload, context) => this.unpin(payload, context),
      "retention.run": (payload, context) => this.retention(payload, context),
      "retention.status": (_payload, context) => retentionStatus(this.store, { project: context.project }),
      "store.compact": (payload) => this.compact(payload),
    };
  }

  async status(project) {
    const [retention, outbox] = await Promise.all([
      retentionStatus(this.store, project === undefined ? {} : { project }),
      outboxMetrics(this.store),
    ]);
    let eventCount = 0;
    const eventScan = await scanStatusPrefix(this.store, [KEYSPACE.EVENT], ({ payload }) => {
      if (project === undefined || payload.project === project) eventCount += 1;
    });
    let chunkCount = 0;
    let chunkScan;
    let chunkIdsTruncated = false;
    if (project === undefined) {
      chunkScan = await scanStatusPrefix(this.store, [KEYSPACE.CHUNK], () => {
        chunkCount += 1;
      });
    } else {
      const chunkIds = new Set();
      let chunkIdBytes = 0;
      chunkScan = await scanStatusPrefix(this.store, [KEYSPACE.DOCUMENT], ({ payload }) => {
        if (payload.project !== project) return;
        for (const { chunkId } of payload.chunks) {
          if (chunkIds.has(chunkId)) continue;
          const bytes = Buffer.byteLength(chunkId, "utf8");
          if (chunkIds.size >= STATUS_PROJECT_CHUNK_LIMIT
            || chunkIdBytes + bytes > STATUS_PROJECT_CHUNK_BYTES) {
            chunkIdsTruncated = true;
            continue;
          }
          chunkIds.add(chunkId);
          chunkIdBytes += bytes;
        }
      });
      chunkCount = chunkIds.size;
    }
    const publication = await this.store.get([KEYSPACE.META, "published-index-generation"]);
    return {
      backgroundErrors: [...this.backgroundErrors],
      counts: {
        documents: retention.liveDocuments,
        events: eventCount,
        chunks: chunkCount,
        logicalBytes: retention.liveLogicalBytes,
        approximate: retention.approximate
          || eventScan.truncated
          || chunkScan.truncated
          || chunkIdsTruncated,
      },
      outbox: {
        depth: outbox.depth,
        skippedDocuments: outbox.skippedDocuments,
        skippedHandlers: outbox.skippedHandlers,
        ...(outbox.oldestPendingAgeMs === null
          ? {}
          : { oldestPendingAgeMs: outbox.oldestPendingAgeMs }),
      },
      index: { generation: publication?.generation ?? 0 },
      retention,
      rocksdb: this.store.properties(),
      filesystem: filesystemStatus(this.store.path, retention.emergencyMode),
    };
  }
}

export async function createDaemonOperations(store, options = {}) {
  return new DaemonOperations(store, options).initialize();
}
