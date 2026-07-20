import { randomUUID } from "node:crypto";
import { boundedStoreErrorMessage } from "../store/store-contract.js";
import { addDerivedReferences } from "./derived.js";
import {
  applyGenerationTablets,
  claimNextOutbox,
  cleanupPublishedStage,
  createGenerationPlan,
  DEFAULT_CLAIM_LEASE_MS,
  discardLegacyUnpublishedStage,
  outboxMetrics,
  publishGeneration,
  readStagedGeneration,
  recoverOutbox,
  releaseOutboxClaim,
  stageGeneration,
} from "./outbox.js";
import {
  manifestKeys,
} from "./manifests.js";
import { KEYSPACE } from "./keys.js";
import { readDocumentRange } from "./document-range.js";
import { MAX_PHYSICAL_CHUNK_BYTES } from "./chunks.js";
import {
  IndexPreparationLimitError,
  isPreparationLimit,
  MAX_DOCUMENT_STAGED_BYTES,
  MAX_DOCUMENT_STAGED_MUTATIONS,
  MAX_HANDLER_PREPARED_BYTES,
  MAX_HANDLER_PREPARED_MUTATIONS,
  MAX_HANDLER_STAGED_BYTES,
  MAX_HANDLER_STAGED_MUTATIONS,
  MAX_INDEX_WINDOWS_PER_DOCUMENT,
} from "./index-preparation.js";
import {
  assertPersistableKey,
  StoreKeySizeError,
} from "./store.js";

export const INDEX_WORKER_BOUNDARIES = Object.freeze([
  "before-claim",
  "after-claim",
  "before-load",
  "after-load",
  "before-handlers",
  "after-handlers",
  "before-stage",
  "after-stage",
  "before-tablets",
  "after-tablets",
  "before-publish",
  "after-publish",
  "before-cleanup",
  "after-cleanup",
]);

const DEFAULT_DRAIN_LIMIT = 64;
const DEFAULT_MAX_DRAIN_MS = 5_000;
const DEFAULT_WINDOW_PAGE_SIZE = 1_000;
export const DEFAULT_INDEX_SOURCE_SEGMENT_BYTES = 256 * 1_024;
export const MAX_INDEX_SOURCE_RANGE_BYTES = 512 * 1_024;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function freezeHandlerResult(id, output) {
  const result = Array.isArray(output) ? { mutations: output } : output;
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.mutations)) {
    throw new TypeError(`Index handler ${id} must return a mutation array or { mutations, metadata? }.`);
  }
  return Object.freeze({ id, mutations: result.mutations, metadata: result.metadata });
}

function preparedBytes(mutations, limit) {
  let bytes = 0;
  for (const mutation of mutations) {
    bytes += Buffer.byteLength(JSON.stringify(mutation), "utf8");
    if (bytes > limit) break;
  }
  return bytes;
}

function assertHandlerMutationKeys(handlerId, mutations) {
  for (const mutation of mutations) {
    const type = mutation?.type ?? (mutation && Object.hasOwn(mutation, "payload") ? "put" : undefined);
    if (type !== "put") continue;
    try {
      assertPersistableKey(mutation.key ?? mutation.keyParts, "derived index key");
    } catch (error) {
      if (!(error instanceof StoreKeySizeError)) throw error;
      throw new IndexPreparationLimitError(
        handlerId,
        "persisted key bytes",
        error.details.maxBytes,
        error.details.actualBytes,
      );
    }
  }
}

function skippedHandlerResult(claim, handlerId, error) {
  const details = error.details ?? {};
  const status = {
    indexPreparationStatusVersion: 1,
    status: "skipped",
    reason: "preparation-limit",
    code: error.code,
    handlerId,
    limitKind: details.limitKind ?? "unknown",
    limit: details.limit ?? 0,
    observed: details.observed ?? 0,
    documentId: claim.entry.payload.documentId,
    documentVersion: claim.entry.payload.documentVersion,
    generation: claim.generation,
    outboxSequence: claim.sequence,
  };
  const payload = Object.freeze({ ...status, statusRecordPersisted: true });
  const mutation = {
    type: "put",
    immutable: false,
    key: [
      "index-preparation-status",
      payload.documentId,
      payload.documentVersion,
      payload.generation,
      handlerId,
    ],
    kind: "index-preparation-status",
    payload,
  };
  const mutations = addDerivedReferences(
    [mutation],
    payload.documentId,
    payload.documentVersion,
  );
  try {
    assertHandlerMutationKeys(handlerId, mutations);
  } catch (statusError) {
    if (!isPreparationLimit(statusError)) throw statusError;
    return freezeHandlerResult(handlerId, {
      mutations: [],
      metadata: Object.freeze({ ...status, statusRecordPersisted: false }),
    });
  }
  return freezeHandlerResult(handlerId, {
    mutations,
    metadata: payload,
  });
}

function handlerDefinition(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("An index handler must be an object.");
  }
  const id = identifier(candidate.id, "handler.id");
  if (typeof candidate.prepare !== "function") {
    throw new TypeError(`Index handler ${id} requires a prepare function.`);
  }
  const operations = candidate.operations === undefined
    ? undefined
    : new Set(candidate.operations.map((operation, index) => identifier(operation, `handler.operations[${index}]`)));
  return Object.freeze({ id, operations, prepare: candidate.prepare });
}

function serializeError(error) {
  return Object.freeze({
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    message: boundedStoreErrorMessage(error),
  });
}

/**
 * Single-owner, ordered outbox worker. Handlers prepare side-effect-free
 * mutations from a read-only snapshot; only the publisher may write them.
 */
export class IndexWorker {
  constructor(store, options = {}) {
    if (!store || typeof store.get !== "function" || typeof store.scan !== "function"
      || typeof store.transaction !== "function") {
      throw new TypeError("IndexWorker requires a RocksStore-compatible store.");
    }
    this.store = store;
    this.workerId = options.workerId ?? `index-worker:${process.pid}:${randomUUID()}`;
    identifier(this.workerId, "workerId");
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS, "leaseMs");
    this.drainLimit = positiveInteger(options.drainLimit ?? DEFAULT_DRAIN_LIMIT, "drainLimit");
    this.maxDrainMs = positiveInteger(options.maxDrainMs ?? DEFAULT_MAX_DRAIN_MS, "maxDrainMs");
    this.windowPageSize = positiveInteger(
      options.windowPageSize ?? DEFAULT_WINDOW_PAGE_SIZE,
      "windowPageSize",
    );
    if (this.windowPageSize > 100_000) throw new RangeError("windowPageSize must not exceed 100000.");
    this.sourceSegmentBytes = positiveInteger(
      options.sourceSegmentBytes ?? DEFAULT_INDEX_SOURCE_SEGMENT_BYTES,
      "sourceSegmentBytes",
    );
    if (this.sourceSegmentBytes > MAX_INDEX_SOURCE_RANGE_BYTES / 2) {
      throw new RangeError(`sourceSegmentBytes must not exceed ${MAX_INDEX_SOURCE_RANGE_BYTES / 2}.`);
    }
    this.yieldControl = options.yieldControl ?? yieldToEventLoop;
    if (typeof this.yieldControl !== "function") {
      throw new TypeError("yieldControl must be a function.");
    }
    this.planOptions = Object.freeze({
      ...(options.atomicMaxMutations === undefined ? {} : { atomicMaxMutations: options.atomicMaxMutations }),
      ...(options.atomicMaxBytes === undefined ? {} : { atomicMaxBytes: options.atomicMaxBytes }),
      ...(options.tabletMaxMutations === undefined ? {} : { tabletMaxMutations: options.tabletMaxMutations }),
      ...(options.tabletMaxBytes === undefined ? {} : { tabletMaxBytes: options.tabletMaxBytes }),
      ...(options.publicationMaxMutations === undefined
        ? {}
        : { publicationMaxMutations: options.publicationMaxMutations }),
      ...(options.publicationMaxBytes === undefined
        ? {}
        : { publicationMaxBytes: options.publicationMaxBytes }),
    });
    this.clock = options.clock ?? Date.now;
    if (typeof this.clock !== "function") throw new TypeError("clock must be a function.");
    this.fault = options.fault;
    if (this.fault !== undefined && typeof this.fault !== "function") {
      throw new TypeError("fault must be a function.");
    }
    this.recoverOnStart = options.recoverOnStart !== false;
    this.initialized = false;
    this.handlers = new Map();
    for (const handler of options.handlers ?? []) this.registerHandler(handler);
  }

  registerHandler(candidate) {
    const handler = handlerDefinition(candidate);
    if (this.handlers.has(handler.id)) throw new TypeError(`Index handler ${handler.id} is already registered.`);
    this.handlers.set(handler.id, handler);
    return () => this.handlers.delete(handler.id);
  }

  unregisterHandler(id) {
    return this.handlers.delete(identifier(id, "handler id"));
  }

  registeredHandlers() {
    return Object.freeze([...this.handlers.keys()].sort());
  }

  async boundary(name, context = {}) {
    if (!INDEX_WORKER_BOUNDARIES.includes(name)) throw new TypeError(`Unknown worker boundary ${name}.`);
    if (this.fault) await this.fault(name, Object.freeze({ workerId: this.workerId, ...context }));
  }

  async initialize() {
    if (this.initialized) return Object.freeze({ recoveredClaims: 0, cleanedStages: 0, alreadyInitialized: true });
    const result = this.recoverOnStart
      ? await recoverOutbox(this.store, { now: this.clock() })
      : Object.freeze({ recoveredClaims: 0, cleanedStages: 0 });
    this.initialized = true;
    return result;
  }

  async loadAndPrepare(claim) {
    // Canonical records are immutable and this worker publishes generations
    // serially. A capability-limited view therefore gives handlers a stable
    // source without exposing write methods or holding a native transaction
    // across arbitrary asynchronous handler work.
    const view = Object.freeze({
      get: this.store.get.bind(this.store),
      getRecord: this.store.getRecord.bind(this.store),
      has: this.store.has.bind(this.store),
      scan: this.store.scan.bind(this.store),
    });
    await this.boundary("before-load", { claim });
    const manifest = await view.get(manifestKeys.document(
      claim.entry.payload.documentId,
      claim.entry.payload.documentVersion,
    ));
    if (manifest === undefined) {
      throw new Error(`Canonical document ${claim.entry.payload.documentId}@${claim.entry.payload.documentVersion} is missing.`);
    }
    if (manifest.version !== claim.entry.payload.sourceVersion) {
      throw new Error(`Canonical document ${manifest.documentId} does not match outbox source version.`);
    }
    const selected = [...this.handlers.values()]
      .filter((handler) => handler.operations === undefined || handler.operations.has(claim.operation))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (selected.length === 0) {
      throw new Error(`No index handler is registered for outbox operation ${claim.operation}.`);
    }
    for (const reference of manifest.chunks ?? []) {
      if (!Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0
        || reference.byteLength > MAX_PHYSICAL_CHUNK_BYTES) {
        throw new Error(
          `Canonical source chunk ${String(reference.chunkId)} exceeds the bounded indexing value size.`,
        );
      }
    }
    const windowPrefix = [
      KEYSPACE.WINDOW,
      manifest.documentId,
      manifest.version,
    ];
    const windows = [];
    let after;
    for (;;) {
      const page = view.scan(windowPrefix, {
        limit: this.windowPageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (windows.length + page.length > MAX_INDEX_WINDOWS_PER_DOCUMENT) {
        const error = new IndexPreparationLimitError(
          "all",
          "stored windows per document",
          MAX_INDEX_WINDOWS_PER_DOCUMENT,
          windows.length + page.length,
        );
        const handlerIds = selected.map(({ id }) => id);
        await this.boundary("after-load", { claim, manifest, windows, skipped: error.details });
        await this.boundary("before-handlers", { claim, handlerIds });
        const skipped = selected.map(({ id }) => skippedHandlerResult(claim, id, error));
        await this.boundary("after-handlers", { claim, handlerIds });
        return skipped;
      }
      windows.push(...page.map(({ payload }) => payload));
      if (page.length < this.windowPageSize) break;
      after = page.at(-1).keyBytes;
      await this.yieldControl();
    }
    await this.boundary("after-load", { claim, manifest, windows });

    const context = Object.freeze({
      view,
      generation: claim.generation,
      outboxSequence: claim.sequence,
      operation: claim.operation,
      outbox: claim.entry.payload,
      manifest,
      windows: Object.freeze(windows),
      sourceSegmentBytes: this.sourceSegmentBytes,
      readSourceRange: async (startByte, endByte, options = {}) => {
        if (!Number.isSafeInteger(startByte) || startByte < 0
          || !Number.isSafeInteger(endByte) || endByte < startByte) {
          throw new TypeError("Index source ranges require non-negative ordered byte offsets.");
        }
        if (endByte - startByte > MAX_INDEX_SOURCE_RANGE_BYTES) {
          throw new RangeError(
            `Index source range must not exceed ${MAX_INDEX_SOURCE_RANGE_BYTES} bytes.`,
          );
        }
        return readDocumentRange(view, manifest, startByte, endByte, options);
      },
      yieldControl: () => this.yieldControl(),
    });
    await this.boundary("before-handlers", { claim, handlerIds: selected.map(({ id }) => id) });
    const results = [];
    let documentStagedMutations = 0;
    let documentStagedBytes = 0;
    for (const handler of selected) {
      try {
        const output = await handler.prepare(context);
        const normalized = Array.isArray(output) ? { mutations: output } : output;
        if (!normalized || !Array.isArray(normalized.mutations)) {
          throw new TypeError(`Index handler ${handler.id} must return mutations.`);
        }
        if (normalized.mutations.length > MAX_HANDLER_PREPARED_MUTATIONS) {
          throw new IndexPreparationLimitError(
            handler.id,
            "prepared mutations",
            MAX_HANDLER_PREPARED_MUTATIONS,
            normalized.mutations.length,
          );
        }
        const bytes = preparedBytes(normalized.mutations, MAX_HANDLER_PREPARED_BYTES);
        if (bytes > MAX_HANDLER_PREPARED_BYTES) {
          throw new IndexPreparationLimitError(
            handler.id,
            "prepared mutation bytes",
            MAX_HANDLER_PREPARED_BYTES,
            bytes,
          );
        }
        assertHandlerMutationKeys(handler.id, normalized.mutations);
        const stagedMutations = claim.operation === "index"
          ? addDerivedReferences(normalized.mutations, manifest.documentId, manifest.version)
          : normalized.mutations;
        assertHandlerMutationKeys(handler.id, stagedMutations);
        if (stagedMutations.length > MAX_HANDLER_STAGED_MUTATIONS) {
          throw new IndexPreparationLimitError(
            handler.id,
            "staged mutations",
            MAX_HANDLER_STAGED_MUTATIONS,
            stagedMutations.length,
          );
        }
        const stagedBytes = preparedBytes(stagedMutations, MAX_HANDLER_STAGED_BYTES);
        if (stagedBytes > MAX_HANDLER_STAGED_BYTES) {
          throw new IndexPreparationLimitError(
            handler.id,
            "staged mutation bytes",
            MAX_HANDLER_STAGED_BYTES,
            stagedBytes,
          );
        }
        if (documentStagedMutations + stagedMutations.length > MAX_DOCUMENT_STAGED_MUTATIONS) {
          throw new IndexPreparationLimitError(
            handler.id,
            "document staged mutations",
            MAX_DOCUMENT_STAGED_MUTATIONS,
            documentStagedMutations + stagedMutations.length,
          );
        }
        if (documentStagedBytes + stagedBytes > MAX_DOCUMENT_STAGED_BYTES) {
          throw new IndexPreparationLimitError(
            handler.id,
            "document staged mutation bytes",
            MAX_DOCUMENT_STAGED_BYTES,
            documentStagedBytes + stagedBytes,
          );
        }
        results.push(freezeHandlerResult(handler.id, {
          ...normalized,
          mutations: stagedMutations,
        }));
        documentStagedMutations += stagedMutations.length;
        documentStagedBytes += stagedBytes;
      } catch (error) {
        if (!isPreparationLimit(error)) throw error;
        results.push(skippedHandlerResult(claim, handler.id, error));
      }
      await this.yieldControl();
    }
    await this.boundary("after-handlers", { claim, handlerIds: selected.map(({ id }) => id) });
    return results;
  }

  async processNext() {
    await this.initialize();
    await this.boundary("before-claim");
    let claim;
    try {
      claim = await claimNextOutbox(this.store, {
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        now: this.clock(),
      });
      await this.boundary("after-claim", { claim });
      if (claim.status !== "claimed") return claim;

      await discardLegacyUnpublishedStage(this.store, claim);
      let plan = await readStagedGeneration(this.store, claim);
      if (plan === undefined) {
        const results = await this.loadAndPrepare(claim);
        plan = createGenerationPlan(claim, results, this.planOptions);
        await this.boundary("before-stage", { claim, plan });
        await stageGeneration(this.store, claim, plan);
        await this.boundary("after-stage", { claim, plan });
      }

      await this.boundary("before-tablets", { claim, plan });
      const tablets = await applyGenerationTablets(this.store, claim);
      await this.boundary("after-tablets", { claim, plan, tablets });

      await this.boundary("before-publish", { claim, plan });
      const publication = await publishGeneration(this.store, claim, { now: this.clock() });
      await this.boundary("after-publish", { claim, publication });
      await this.boundary("before-cleanup", { claim, publication });
      await cleanupPublishedStage(this.store, claim.generation);
      await this.boundary("after-cleanup", { claim, publication });
      return Object.freeze({ status: "processed", claim, publication });
    } catch (error) {
      if (claim?.status === "claimed") {
        await releaseOutboxClaim(this.store, claim, error, { now: this.clock() });
      }
      throw error;
    }
  }

  /** Process a bounded number of entries and stop at idle, contention, error, or deadline. */
  async drain(options = {}) {
    await this.initialize();
    const limit = positiveInteger(options.limit ?? this.drainLimit, "limit");
    const maxDurationMs = positiveInteger(options.maxDurationMs ?? this.maxDrainMs, "maxDurationMs");
    const startedAt = this.clock();
    const publications = [];
    const errors = [];
    let terminal = "limit";
    while (publications.length < limit) {
      if (options.signal?.aborted) {
        terminal = "aborted";
        break;
      }
      if (this.clock() - startedAt >= maxDurationMs) {
        terminal = "deadline";
        break;
      }
      try {
        const result = await this.processNext();
        if (result.status !== "processed") {
          terminal = result.status;
          break;
        }
        publications.push(result.publication);
      } catch (error) {
        errors.push(serializeError(error));
        terminal = "error";
        if (options.throwOnError === true) throw error;
        break;
      }
    }
    return Object.freeze({
      processed: publications.length,
      terminal,
      publications: Object.freeze(publications),
      errors: Object.freeze(errors),
      elapsedMs: Math.max(0, this.clock() - startedAt),
    });
  }

  metrics(options = {}) {
    return outboxMetrics(this.store, { ...options, now: options.now ?? this.clock() });
  }
}
