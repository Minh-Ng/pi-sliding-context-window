import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { basename } from "node:path";
import { canonicalDocumentIdentityHash } from "../identity/document-identity.js";
import {
  admitDocument,
  manifestKeys,
  readCanonicalDocument,
  resolveLiveSubject,
  retiredDocumentStatus,
} from "../rocksdb/manifests.js";
import { encodeKey, KEYSPACE } from "../rocksdb/keys.js";
import { findDependentDocuments } from "../rocksdb/dependents.js";
import { supersessionChainView } from "../rocksdb/supersession-chain.js";
import { createExactIndexHandler } from "../rocksdb/index/exact.js";
import { createBm25IndexHandler } from "../rocksdb/index/bm25.js";
import { createStructuralIndexHandler } from "../rocksdb/index/structural.js";
import { createImportanceIndexHandler } from "../rocksdb/index/importance.js";
import { createNearDuplicateIndexHandler } from "../rocksdb/index/simhash.js";
import { IndexWorker } from "../rocksdb/indexer.js";
import { outboxKeys, outboxMetrics } from "../rocksdb/outbox.js";
import { purgeProjectRecordsUntilComplete } from "../rocksdb/project-purge.js";
import { scanStatusPrefix } from "../rocksdb/status-scan.js";
import { derivedViewStatus } from "../rocksdb/derived-view.js";
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
  tombstoneDocument,
  unpinDocument,
} from "../rocksdb/retention.js";
import { cleanupExpiredLeases } from "../retrieval/leases.js";
import { chronological, flagPossibleConflicts, gatherArchive } from "../retrieval/gather.js";
import { clearScopedHints, removeFrozenHint } from "../retrieval/hints.js";
import { recallArchive } from "../retrieval/recall.js";
import { normalizeRenderFormat } from "../retrieval/render.js";
import { preflightArchive } from "../retrieval/preflight.js";
import { searchArchive } from "../retrieval/search.js";
import { traverseArchive } from "../retrieval/traverse.js";
import { READ_SCOPE_ALL } from "./read-scope.js";
import { bm25Keys } from "../rocksdb/index/bm25-keys.js";
import { isArchiveEchoDocument } from "../rocksdb/index/echo.js";
import { LocatorError } from "../retrieval/locator.js";
import { LocalSemanticIndex } from "../semantic/index.js";
import { LocalReranker } from "../semantic/reranker.js";
import {
  recordRecalledLocator,
  recordShownResults,
  relevanceFeedbackEvents,
  relevanceFeedbackStats,
} from "../retrieval/relevance-feedback.js";
import {
  MAX_DIRECT_CHUNK_TABLE_ENTRIES,
  MAX_DIRECT_DOCUMENT_RESPONSE_BYTES,
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
  MAX_DIRECT_SOURCE_MESSAGE_KEYS,
  STORE_ERROR_CODES,
  assertStoreResult,
  boundedStoreErrorMessage,
} from "../store/store-contract.js";
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
const KIBIBYTE = 1_024;

function processMemoryStatus() {
  const memory = process.memoryUsage();
  const maxRssBytes = process.resourceUsage().maxRSS * KIBIBYTE;
  return Object.freeze({
    rssBytes: memory.rss,
    maxRssBytes: Math.max(memory.rss, maxRssBytes),
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  });
}

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

// The projects a connection may read from: its authenticated project plus any
// filesystem-verified pre-canonical aliases. Writes and every mutation ignore
// this widening and use context.project alone.
function readProjectsFor(context) {
  return Array.isArray(context.readProjects) && context.readProjects.length > 0
    ? context.readProjects
    : [context.project];
}

// Upper bound on enumerable project namespaces under a global-read grant.
const MAX_GLOBAL_READ_PROJECTS = 10_000;

// The operator-granted read ceiling, established daemon-side at handshake from
// the user-global settings file (src/daemon/read-scope.js). Only read
// operations consult it; the write target is always context.project. The
// per-request scope stays min(requested, granted): a project- or
// session-scoped request never widens even under a global grant.
function grantsAllProjects(context) {
  return context?.grantedReadScope === READ_SCOPE_ALL;
}

// Drops cross-encoder rerank provenance (see #searchAcrossProjects and
// #gatherAcrossProjects) from a single result/evidence entry that survived a
// cross-project merge, without mutating the original object other callers
// (relevance feedback, the per-project result the entry came from) still
// hold a reference to.
function stripRerankProvenance(entry) {
  if (entry.reranked === undefined) return entry;
  const { reranked, ...rest } = entry;
  return rest;
}

// Contract cap for a single gather evidence packet (store.gather result schema).
// A cross-project union pools per-project packets, so it must re-cap here.
const MAX_GATHER_EVIDENCE = 24;

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
        createImportanceIndexHandler(),
        createNearDuplicateIndexHandler(options.nearDuplicate),
      ],
    });
    this.semantic = new LocalSemanticIndex(store, {
      ...(options.semantic ?? {}),
      recordError: (error) => this.recordBackgroundError(error),
    });
    // Cross-encoder rerank for explicit search/gather (deferred task #2).
    // Unlike this.semantic, it has no initialize()/warm step: the worker
    // loads lazily on the first actual rerank() call (see LocalReranker), so
    // constructing it here never adds daemon-start latency.
    this.reranker = new LocalReranker({
      ...(options.reranker ?? {}),
      recordError: (error) => this.recordBackgroundError(error),
    });
    // Experimental recall packet format; "json-v1" unless explicitly opted in.
    this.renderFormat = normalizeRenderFormat(
      options.renderFormat ?? process.env.CONTEXT_WINDOW_RECALL_FORMAT,
    );
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
    this.semantic.initialize();
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
    await this.semantic.close();
    await this.reranker.close();
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
    // Archive-echo documents stay recallable but never enter the semantic
    // index either (see src/rocksdb/index/echo.js).
    if (!isArchiveEchoDocument(payload.document)) {
      this.semantic.enqueueDocument(result.documentId, result.version);
    }
    if (payload.document.supersedes !== undefined) {
      const dependents = await this.dependentsForSupersededTarget(
        payload.document.supersedes,
        context.project,
        result.documentId,
      );
      if (dependents !== undefined && dependents.count > 0) {
        return assertStoreResult("store.put", { ...result, dependents });
      }
    }
    return result;
  }

  // Surface-only invalidation cascade (ultracode task #36): once this
  // admission's `supersedes` pointer retires an older document, report
  // whether any later-admitted document already shows signs of referencing
  // it (see findDependentDocuments). Best-effort: a lookup fault here must
  // never turn a committed write into an apparent admission failure, so
  // failures are recorded and swallowed rather than thrown.
  async dependentsForSupersededTarget(target, project, replacementDocumentId) {
    try {
      const manifest = await this.store.get(manifestKeys.document(target.documentId, target.version));
      if (manifest === undefined || manifest.project !== project) return undefined;
      return this.store.snapshot((view) => findDependentDocuments(view, {
        documentId: manifest.documentId,
        version: manifest.version,
        project: manifest.project,
        sessionId: manifest.sessionId,
        createdAt: manifest.createdAt,
        subjectKey: manifest.subjectKey,
        sourceMessageKeys: manifest.sourceMessageKeys,
      }, { replacementDocumentId }));
    } catch (error) {
      this.recordBackgroundError(error);
      return undefined;
    }
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
        const failure = documentReadFailure(
          snapshotManifest,
          marker ?? snapshotRetired,
          payload.documentId,
          version,
        );
        // Surface-only invalidation cascade (ultracode task #36): recall of a
        // superseded document is exactly the moment a caller learns it was
        // stale, so this is where later-referencing documents (if any) get
        // surfaced. snapshotManifest is the target's own immutable record,
        // still readable here even though it is no longer live. Best-effort,
        // like the put() path's own lookup: a fault here (e.g. a legacy
        // manifest that fails the target-identity check) must not turn an
        // otherwise-graceful "superseded" response into an RPC error.
        if (failure.status === "superseded" && snapshotManifest !== undefined) {
          let extra = {};
          try {
            const dependents = await findDependentDocuments(view, {
              documentId: snapshotManifest.documentId,
              version: snapshotManifest.version,
              project: snapshotManifest.project,
              sessionId: snapshotManifest.sessionId,
              createdAt: snapshotManifest.createdAt,
              subjectKey: snapshotManifest.subjectKey,
              sourceMessageKeys: snapshotManifest.sourceMessageKeys,
            }, { replacementDocumentId: marker?.replacementDocumentId });
            if (dependents.count > 0) extra = { ...extra, dependents };
          } catch (error) {
            this.recordBackgroundError(error);
          }
          try {
            // Artifact-versioning chain view (ultracode task #38): same
            // best-effort surfacing as the dependents lookup above, for a
            // direct-by-id read of a document that is part of an explicit
            // subjectKey + supersedes chain.
            const chain = await supersessionChainView(view, snapshotManifest);
            if (chain !== undefined) extra = { ...extra, chain };
          } catch (error) {
            this.recordBackgroundError(error);
          }
          if (Object.keys(extra).length > 0) return { ...failure, ...extra };
        }
        return failure;
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
    // Explicit search may widen each candidate's excerpt to use its own
    // requested evidence budget; automatic preflight calls searchArchive
    // directly and never sets this, so frozen-hint bytes are unaffected.
    // scope=all reads every store project only under the operator-granted
    // ceiling; otherwise it keeps collapsing to project scope downstream.
    const readProjects = payload.scope === "all" && grantsAllProjects(context)
      ? this.#allStoreProjects(context)
      : readProjectsFor(context);
    // Dedup is a per-request opt-in on the explicit store.search surface
    // (payload.dedupe), never a daemon-forced default: two genuinely distinct
    // documents can share near-identical text, so collapsing near-dup clusters
    // must be something a caller asks for, not something applied unasked. The
    // automatic preflight path (preflightArchive) never sets this option
    // regardless, so frozen hints stay byte-identical.
    if (readProjects.length <= 1) {
      // Explicit search is the "gather evidence" path: rerank with recency
      // decay. Automatic preflight calls searchArchive directly and never sets
      // this, so frozen hints stay undecayed.
      return searchArchive(this.store, { ...payload, project: context.project }, {
        semantic: this.semantic,
        // Cross-encoder rerank of the lexical/semantic tier, explicit search
        // only (see src/retrieval/search.js rerankTierOne). preflightArchive's
        // internal searchArchive call never sets this, so frozen hints stay
        // byte-identical.
        ...(payload.rerank === false ? {} : { reranker: this.reranker }),
        // RM3/Bo1 query expansion is only ever available on this explicit
        // store.search path, never from preflightArchive's internal call to
        // searchArchive (it does not set this option).
        allowExpansion: true,
        dedupe: payload.dedupe === true,
        ...(payload.recordFeedback === false
          ? {}
          : { recordShownResults: (event) => this.recordRelevanceFeedback(event) }),
        applyImportancePrior: true,
        now,
        recencyDecay: true,
        expandSnippetsToBudget: true,
      });
    }
    return this.#searchAcrossProjects(payload, readProjects, context, now);
  }

  // Read-compatibility union over the authenticated project and its verified
  // aliases. Each per-project search authorizes and signs its own locators, so a
  // legacy-alias result stays authorized only for that alias on recall.
  async #searchAcrossProjects(payload, readProjects, context, now) {
    const limit = Number.isSafeInteger(payload.limit) && payload.limit > 0
      ? payload.limit
      : undefined;
    const byIdentity = new Map();
    const modes = new Set();
    let indexGeneration = 0;
    let expiredCount = 0;
    let truncated = false;
    const expiredRetentionClasses = new Set();
    for (const project of readProjects) {
      // Same query-time recency decay as the single-project path, so an
      // alias-widened search ranks consistently with the results it merges by
      // score against single-project search. Every alias also gets the same
      // dedupe opt-in as the single-project path, so the merged ranking does
      // not depend on which alias happened to answer.
      const result = await searchArchive(this.store, { ...payload, project }, {
        semantic: this.semantic,
        ...(payload.rerank === false ? {} : { reranker: this.reranker }),
        allowExpansion: true,
        applyImportancePrior: true,
        now,
        recencyDecay: true,
        dedupe: payload.dedupe === true,
        expandSnippetsToBudget: true,
      });
      modes.add(result.mode);
      indexGeneration = Math.max(indexGeneration, result.indexGeneration);
      // One capped leg caps the union: the merged ranking is drawn from that
      // leg's partial pool too.
      if (result.truncated === true) truncated = true;
      // Aggregate expired-but-matching evidence across the alias union so a
      // symlink-widened search still surfaces the aged-out counts a
      // single-project search would have reported.
      if (result.expiredMatches) {
        expiredCount += result.expiredMatches.count;
        for (const retentionClass of result.expiredMatches.retentionClasses ?? []) {
          expiredRetentionClasses.add(retentionClass);
        }
      }
      for (const entry of result.results) {
        const identity = `${entry.documentId}\0${entry.version}`;
        const current = byIdentity.get(identity);
        if (current === undefined || entry.score > current.entry.score) {
          byIdentity.set(identity, { entry, status: result.status });
        }
      }
    }
    const ranked = [...byIdentity.values()]
      .sort((left, right) => right.entry.score - left.entry.score
        || String(left.entry.documentId).localeCompare(String(right.entry.documentId)));
    const kept = limit === undefined ? ranked : ranked.slice(0, limit);
    // Each leg's own searchArchive call already ran the cross-encoder over
    // that project's own fused tier before this method ever sees its
    // results, but the union above re-sorts strictly by `score` -- a field
    // rerank never changes (src/semantic/reranker.js only ever reorders
    // array position) -- across every alias at once. So no candidate's
    // position in *this* merged, multi-alias ranking was ever decided by a
    // cross-encoder pass that could see its competing aliases: whichever
    // alias's leg happened to score highest wins purely on that score, the
    // same as it would with rerank disabled entirely. `reranked: true`
    // promises the cross-encoder scored this specific candidate (see
    // store-contract-schema.js's `reranked` field comment); strip it here so
    // that promise never outlives the single-project search it was actually
    // true for.
    const results = kept.map(({ entry }) => stripRerankProvenance(entry));
    // A structurally special status (ambiguous, or a legacy-fallback expansion)
    // is a per-project retrieval signal, not just an overall found/not-found
    // outcome. Surface it whenever a kept result actually carries it, so an
    // alias-widened search does not hide the ambiguity a single-project search
    // would have reported for that same result.
    const special = kept.find(({ status }) => status === "ambiguous")
      ?? kept.find(({ status }) => status === "legacy-fallback");
    const merged = assertStoreResult("store.search", {
      mode: modes.size === 1 ? [...modes][0] : "hybrid",
      status: results.length === 0 ? "not-found" : special?.status ?? "resolved",
      indexGeneration,
      results,
      ...(expiredCount > 0
        ? { expiredMatches: { count: expiredCount, retentionClasses: [...expiredRetentionClasses] } }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    });
    // Record implicit feedback on the final merged ranking, keyed by the
    // authenticated project. Locator fingerprints are content-only, so a later
    // recall (widened over the same aliases) joins back regardless of which
    // alias authorized it.
    if (payload.recordFeedback !== false) {
      await this.recordRelevanceFeedback({
        project: context.project,
        query: payload.query,
        mode: merged.mode,
        status: merged.status,
        results: merged.results,
        // Mirror search.js's own sessionIds derivation: the alias-merged path
        // builds its own feedback event rather than going through searchArchive's
        // recordShownResults hook, so it must compute this itself.
        sessionIds: payload.sessionIds ?? (payload.sessionId === undefined ? [] : [payload.sessionId]),
        now: Date.now(),
      });
    }
    return merged;
  }

  async gather(payload, context) {
    this.continueIndexing();
    const now = Date.now();
    const stageTimings = context.stageTimings ??= Object.create(null);
    const recordStageTiming = (stage, durationMs) => {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      stageTimings[stage] = (stageTimings[stage] ?? 0) + durationMs;
    };
    const maintenanceStartedAt = performance.now();
    try {
      await cleanupExpiredProtections(this.store, { now, limit: 1_000 });
      await cleanupExpiredLeases(this.store, { now, limit: 1_000 });
    } finally {
      recordStageTiming("maintenanceMs", performance.now() - maintenanceStartedAt);
    }
    // scope=all gathers across every store project only under the
    // operator-granted ceiling, mirroring store.search.
    const readProjects = payload.scope === "all" && grantsAllProjects(context)
      ? this.#allStoreProjects(context)
      : readProjectsFor(context);
    // Dedup is a per-request opt-in (payload.dedupe), same as store.search.
    if (readProjects.length <= 1) {
      // gatherArchive forwards its options object to searchArchive as-is
      // (src/retrieval/gather.js), so recencyDecay/now rerank gather's search
      // anchors the same way as the explicit search path above.
      return gatherArchive(this.store, payload, {
        project: context.project,
        semantic: this.semantic,
        // Forwarded into gather's internal searchArchive call the same way as
        // semantic above (src/retrieval/gather.js), so gather's anchors get
        // the same explicit-search-only rerank.
        reranker: this.reranker,
        renderFormat: this.renderFormat,
        applyImportancePrior: true,
        now,
        recencyDecay: true,
        dedupe: payload.dedupe === true,
        recordStageTiming,
      });
    }
    return this.#gatherAcrossProjects(payload, readProjects, now, recordStageTiming);
  }

  // Read-compatibility union for evidence packets. Each per-project gather is a
  // self-consistent search/traverse/recall over one namespace; pooling their
  // evidence lets a symlink-migrated repo's legacy docs compete for the shared
  // token budget instead of being hidden behind the canonical project's results.
  async #gatherAcrossProjects(payload, readProjects, now, recordStageTiming) {
    const maxTokens = Number.isSafeInteger(payload.maxTokens) && payload.maxTokens > 0
      ? payload.maxTokens
      : Infinity;
    const pooled = [];
    const modes = new Set();
    let intent;
    let anchorCount = 0;
    let candidateCount = 0;
    let truncated = false;
    // Each aliased project is a distinct namespace in the underlying store, so
    // summing per-project counts (unlike the single-project exact/lexical
    // dedup inside gather.js's own search call) never double-counts one
    // document.
    let expiredCount = 0;
    const expiredRetentionClasses = new Set();
    for (const project of readProjects) {
      const result = await gatherArchive(this.store, payload, {
        project,
        semantic: this.semantic,
        reranker: this.reranker,
        renderFormat: this.renderFormat,
        applyImportancePrior: true,
        now,
        recencyDecay: true,
        dedupe: payload.dedupe === true,
        recordStageTiming,
      });
      modes.add(result.mode);
      intent ??= result.intent;
      anchorCount += result.anchorCount;
      candidateCount += result.candidateCount;
      truncated ||= result.truncated;
      // Each leg's own gather call already ran the cross-encoder over that
      // project's own anchors before this method sees them, but the
      // anchorRank/distance interleave below (and the chronological re-sort
      // after budget selection) pools evidence across every alias without
      // any cross-encoder pass ever comparing one alias's anchors against
      // another's -- the same reasoning as #searchAcrossProjects's
      // stripRerankProvenance above, just against anchorRank/distance
      // instead of `score`. Strip the flag so it never implies the
      // presented cross-alias evidence order reflects a rerank decision
      // that was never actually made across aliases.
      pooled.push(...result.evidence.map(stripRerankProvenance));
      expiredCount += result.expiredMatches?.count ?? 0;
      for (const retentionClass of result.expiredMatches?.retentionClasses ?? []) {
        expiredRetentionClasses.add(retentionClass);
      }
    }
    // Interleave by anchor rank then distance so a legacy top anchor outranks a
    // canonical deep neighbor, then fill the shared token budget in that order.
    pooled.sort((left, right) => left.anchorRank - right.anchorRank
      || left.distance - right.distance);
    // The request's own maxEvidence (schema: required, 1..24) is always at least
    // as strict as the pooling ceiling; honor whichever is tighter so widening
    // over aliases never hands back more evidence than was asked for.
    const evidenceCap = Math.min(payload.maxEvidence, MAX_GATHER_EVIDENCE);
    const evidence = [];
    let returnedTokens = 0;
    for (const item of pooled) {
      if (evidence.length >= evidenceCap) {
        truncated = true;
        break;
      }
      const itemTokens = item.document?.returnedTokens ?? 0;
      if (evidence.length > 0 && returnedTokens + itemTokens > maxTokens) {
        truncated = true;
        continue;
      }
      evidence.push(item);
      returnedTokens += itemTokens;
    }
    // Each leg's own gatherArchive call already flagged possiblyConflicting
    // refs against that leg's own (pre-trim, single-project) evidence set.
    // Pooling and then trimming to the shared budget can drop one side of a
    // flagged pair, and never compares anchors across aliases at all -- so
    // re-run detection here over the final cross-project, post-trim set.
    // This is idempotent (flagPossibleConflicts overwrites or clears every
    // item's flag) and cheap: one more manifest snapshot read per surviving
    // item, bounded by the same evidenceCap as everything else here.
    const conflictStartedAt = performance.now();
    try {
      await flagPossibleConflicts(this.store, evidence);
    } finally {
      recordStageTiming("conflictMs", performance.now() - conflictStartedAt);
    }
    // Single-project gather returns evidence in chronological order (gather.js)
    // and the model-facing guidance asserts that ordering; re-sort after budget
    // selection so the alias-widened merge matches it instead of leaking the
    // anchorRank/distance pooling order used only to pick the budget.
    evidence.sort(chronological);
    return assertStoreResult("store.gather", {
      status: evidence.length > 0 ? "resolved" : "not-found",
      mode: modes.size === 1 ? [...modes][0] : "hybrid",
      intent: intent ?? payload.intent ?? "auto",
      anchorCount,
      candidateCount,
      returnedTokens,
      truncated,
      hasMore: truncated,
      evidence,
      expiredMatches: Object.freeze({
        count: expiredCount,
        retentionClasses: Object.freeze([...expiredRetentionClasses].sort()),
      }),
    });
  }

  // Every project namespace with indexed content, for connections whose
  // operator granted maxReadScope=all. The authenticated project and its
  // verified aliases always lead, so locator-authorization loops try them
  // first. Enumeration reads the single corpus-current pointer per project;
  // a project admitted but never yet indexed is not enumerable and stays
  // invisible to global reads until its first index publication.
  #allStoreProjects(context) {
    const projects = [...readProjectsFor(context)];
    const seen = new Set(projects);
    const records = this.store.scan(bm25Keys.corpusCurrentPrefix(), {
      limit: MAX_GLOBAL_READ_PROJECTS,
    });
    for (const record of records) {
      const project = record?.payload?.project;
      if (typeof project !== "string" || project.length === 0 || seen.has(project)) continue;
      seen.add(project);
      projects.push(project);
    }
    return projects;
  }

  async traverse(payload, context) {
    // Traversal and recall are reads with no scope parameter, so they take
    // the granted ceiling directly: a signed locator from a global search
    // must remain recallable, and each locator still authorizes exactly one
    // project.
    const readProjects = grantsAllProjects(context)
      ? this.#allStoreProjects(context)
      : readProjectsFor(context);
    // A locator authorizes exactly one project; a mismatched project throws
    // LocatorError. Try each alias until one authorizes, and only surface the
    // authorization failure when none does.
    let lastError;
    for (const project of readProjects) {
      try {
        return await traverseArchive(this.store, payload, { project });
      } catch (error) {
        if (!(error instanceof LocatorError)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  // Implicit relevance feedback is a local, replayable-from-nothing side log:
  // never let a feedback write turn a served search or recall into a failure.
  async recordRelevanceFeedback(event) {
    try {
      await recordShownResults(this.store, event);
    } catch (error) {
      this.recordBackgroundError(error);
    }
  }

  async recall(payload, context) {
    // Same granted-ceiling widening as traverse: the authenticated project
    // leads, and the loop below stops at the first project the signed
    // locator authorizes.
    const readProjects = grantsAllProjects(context)
      ? this.#allStoreProjects(context)
      : readProjectsFor(context);
    const sessionIds = payload.sessionIds ?? [];
    let result;
    for (const project of readProjects) {
      result = await recallArchive(this.store, payload, {
        project,
        sessionIds,
        renderFormat: this.renderFormat,
        recordBackgroundError: (error) => this.recordBackgroundError(error),
      });
      // A signed locator authorizes exactly one project; other projects report
      // it as invalid. Keep scanning aliases until one authorizes, and only fall
      // back to the invalid outcome when none does.
      if (result.status !== "locator-invalid") break;
    }
    // Join the recall back to the search that showed it, keyed by the
    // authenticated project (where the merged ranking was recorded).
    try {
      await recordRecalledLocator(this.store, {
        project: context.project,
        locator: payload.locator,
        status: result.status,
        now: Date.now(),
      });
    } catch (error) {
      this.recordBackgroundError(error);
    }
    return result;
  }

  feedbackStats(payload, context) {
    return relevanceFeedbackStats(this.store, {
      project: context.project,
      queryLimit: payload.queryLimit,
    });
  }

  feedbackEvents(payload, context) {
    return relevanceFeedbackEvents(this.store, {
      project: context.project,
      limit: payload.limit,
    });
  }

  async count(payload, context) {
    const sessionIds = new Set(payload.sessionIds
      ?? (payload.sessionId === undefined ? [] : [payload.sessionId]));
    const effectiveScope = payload.scope === "all" ? "project" : payload.scope;
    let count = 0;
    // Admission and migration write one compact project/session reference per
    // canonical version, and retention removes it only after tombstoning. Scan
    // that index instead of multi-MiB manifests; a marker point read excludes
    // versions during the interval before their reference cleanup completes.
    for (const project of readProjectsFor(context)) {
      const prefixes = effectiveScope === "session"
        ? [...sessionIds].map((sessionId) => manifestKeys.sessionDocumentReferencePrefix(
            project,
            sessionId,
          ))
        : [[KEYSPACE.META, "session-document-reference", project]];
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

  async resolveSubject(payload, context) {
    const live = await resolveLiveSubject(this.store, {
      project: context.project,
      subjectKey: payload.subjectKey,
    });
    if (live === undefined) {
      return { status: "not-found", subjectKey: payload.subjectKey };
    }
    return {
      status: "resolved",
      documentId: live.documentId,
      version: live.version,
      kind: live.kind,
      subjectKey: live.subjectKey,
    };
  }

  assertRedactConfirm(payload, context) {
    const confirm = payload.confirm;
    if (payload.scope === "project") {
      const projectBase = basename(context.project.replace(/[/\\]+$/u, "")) || context.project;
      if (confirm !== projectBase && confirm !== context.project) {
        throw codedError(
          "UNAUTHORIZED",
          `Redact confirmation must match the project basename (${projectBase}) or full project path.`,
        );
      }
      return;
    }
    const sessionIds = [...new Set(payload.sessionIds
      ?? (payload.sessionId === undefined ? [] : [payload.sessionId]))];
    if (sessionIds.length === 0) {
      throw codedError("UNAUTHORIZED", "Session redact requires sessionId or sessionIds.");
    }
    const ok = sessionIds.every((sessionId) => (
      sessionId === confirm
      || (confirm.length >= 4 && sessionId.endsWith(confirm))
    ));
    if (!ok) {
      throw codedError(
        "UNAUTHORIZED",
        "Redact confirmation must match a target session id or its trailing 4+ characters.",
      );
    }
  }

  async redact(payload, context) {
    this.assertRedactConfirm(payload, context);
    const result = await this.store.withSharedWrite(async () => {
      const gate = await migrationRetentionGate(this.store);
      if (!gate.allowed) {
        throw codedError("STORE_BUSY", "Archive redaction is blocked during migration.");
      }
      const now = Number.isSafeInteger(payload.now) ? payload.now : Date.now();
      const batchSize = payload.batchSize;
      const sessionIds = [...new Set(payload.sessionIds
        ?? (payload.sessionId === undefined ? [] : [payload.sessionId]))];
      const prefixes = (payload.scope === "session"
        ? sessionIds.map((sessionId) => manifestKeys.sessionDocumentReferencePrefix(
          context.project,
          sessionId,
        ))
        : [[KEYSPACE.META, "session-document-reference", context.project]])
        .sort((left, right) => Buffer.compare(encodeKey(left), encodeKey(right)));
      let after;
      const clearingHints = payload.cursor === "hints";
      if (!clearingHints && typeof payload.cursor === "string" && payload.cursor.length > 0) {
        after = Buffer.from(payload.cursor, "base64url");
      }
      let scanned = 0;
      let tombstoned = 0;
      let alreadyTombstoned = 0;
      let protectedCount = 0;
      let missing = 0;
      let hintsCleared = 0;
      let nextCursor;
      let moreWork = false;
      let lastProcessedKey;
      if (!clearingHints) {
        for (const prefix of prefixes) {
          for (const record of scanPages(this.store, prefix)) {
            const reference = record.payload;
            if (after !== undefined) {
              if (!record.keyBytes || Buffer.compare(record.keyBytes, after) <= 0) continue;
            }
            if (scanned >= batchSize) {
              moreWork = true;
              nextCursor = lastProcessedKey.toString("base64url");
              break;
            }
            scanned += 1;
            lastProcessedKey = record.keyBytes;
            const begun = await tombstoneDocument(this.store, {
              documentId: reference.documentId,
              version: reference.documentVersion,
              now,
              reason: `Explicit ${payload.scope} archive redaction.`,
              ignoreProtection: true,
            });
            if (begun.status === "tombstoned") {
              tombstoned += 1;
              if (begun.deleteOutboxSequence !== undefined) {
                await this.publishIndexDelete(begun.deleteOutboxSequence);
              }
            } else if (begun.status === "already-tombstoned") {
              alreadyTombstoned += 1;
              if (begun.deleteOutboxSequence !== undefined) {
                await this.publishIndexDelete(begun.deleteOutboxSequence);
              }
            } else if (begun.status === "protected") {
              protectedCount += 1;
            } else if (begun.status === "missing") {
              missing += 1;
            }
          }
          if (moreWork) break;
        }
      }
      if (!moreWork) {
        const cleared = await clearScopedHints(this.store, {
          project: context.project,
          ...(payload.scope === "session" ? { sessionIds } : {}),
          limit: batchSize,
        });
        hintsCleared += cleared.cleared;
        if (cleared.moreWork) {
          moreWork = true;
          nextCursor = "hints";
        }
      }
      return {
        status: moreWork ? "more-work" : "complete",
        scanned,
        tombstoned,
        alreadyTombstoned,
        protected: protectedCount,
        missing,
        hintsCleared,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    });
    // Retirement is per document, so records keyed by project rather than by
    // document -- BM25 corpus and per-term statistics, derived-view scope
    // membership, relation heads -- outlive it. Purge them once the last page
    // has retired and its index deletes have drained; purging earlier lets
    // pending outbox work rewrite the namespaces just reclaimed. The sweep
    // refuses to run while the project still has a live document.
    if (result.status === "complete" && payload.scope === "project") {
      await this.drainIndexUntilIdle();
      await purgeProjectRecordsUntilComplete(this.store, {
        project: context.project,
        now: Number.isSafeInteger(payload.now) ? payload.now : Date.now(),
      });
      // Vectors live outside the keyspaces the purge sweeps, so the sweep
      // alone leaves a redacted project's embeddings on disk. Optional by
      // construction: with no semantic index configured this is a no-op and
      // redaction behaves exactly as it did before.
      try {
        await this.semantic?.removeProject?.(context.project);
      } catch (error) {
        // The canonical purge has already committed. A stranded vector index
        // is a storage leak, not a correctness failure, so report it rather
        // than failing a redaction that already succeeded.
        this.recordBackgroundError(error);
      }
    }
    return result;
  }

  handlers() {
    return {
      "store.put": (payload, context) => this.put(payload, context),
      "store.get": (payload, context) => this.get(payload, context),
      "store.search": (payload, context) => this.search(payload, context),
      "store.gather": (payload, context) => this.gather(payload, context),
      "store.traverse": (payload, context) => this.traverse(payload, context),
      "store.recall": (payload, context) => this.recall(payload, context),
      "store.count": (payload, context) => this.count(payload, context),
      "store.preflight": (payload, context) => this.preflight(payload, context),
      "store.remove-hints": (payload, context) => this.removeHints(payload, context),
      "store.protect": (payload, context) => this.protect(payload, context),
      "store.release-protection": (payload, context) => this.releaseProtection(payload, context),
      "store.pin": (payload, context) => this.pin(payload, context),
      "store.unpin": (payload, context) => this.unpin(payload, context),
      "store.resolve-subject": (payload, context) => this.resolveSubject(payload, context),
      "store.redact": (payload, context) => this.redact(payload, context),
      "retention.run": (payload, context) => this.retention(payload, context),
      "retention.status": (_payload, context) => retentionStatus(this.store, { project: context.project }),
      "feedback.stats": (payload, context) => this.feedbackStats(payload, context),
      "feedback.events": (payload, context) => this.feedbackEvents(payload, context),
      "store.compact": (payload) => this.compact(payload),
    };
  }

  async status(project) {
    const [retention, outbox, derivedView] = await Promise.all([
      retentionStatus(this.store, project === undefined ? {} : { project }),
      outboxMetrics(this.store),
      derivedViewStatus(this.store, project === undefined ? {} : { project }),
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
      derivedView,
      memory: processMemoryStatus(),
      semantic: this.semantic.status(),
      reranker: this.reranker.status(),
      retention,
      rocksdb: this.store.properties(),
      filesystem: filesystemStatus(this.store.path, retention.emergencyMode),
    };
  }
}

export async function createDaemonOperations(store, options = {}) {
  return new DaemonOperations(store, options).initialize();
}
