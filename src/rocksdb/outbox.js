import { createHash, randomUUID } from "node:crypto";
import { boundedStoreErrorMessage } from "../store/store-contract.js";
import { decodeKey, encodeKey, encodedKey, KEYSPACE } from "./keys.js";
import { decodeRecord, encodeRecord, stableJson } from "./schema.js";

export const OUTBOX_STATE_VERSION = 1;
export const INDEX_STAGE_VERSION = 2;
export const INDEX_GENERATION_VERSION = 1;
export const DEFAULT_CLAIM_LEASE_MS = 30_000;
export const DEFAULT_OUTBOX_SCAN_LIMIT = 100_000;
export const DEFAULT_PUBLICATION_HISTORY = 1_024;
export const DEFAULT_INDEX_TABLET_MAX_MUTATIONS = 256;
export const DEFAULT_INDEX_TABLET_MAX_BYTES = 512 * 1_024;
export const DEFAULT_INDEX_ATOMIC_MAX_MUTATIONS = 256;
export const DEFAULT_INDEX_ATOMIC_MAX_BYTES = 512 * 1_024;
export const DEFAULT_INDEX_PUBLICATION_MAX_MUTATIONS = 64;
export const DEFAULT_INDEX_PUBLICATION_MAX_BYTES = 256 * 1_024;

const OUTBOX_STATE_PREFIX = Object.freeze([KEYSPACE.META, "outbox-state"]);
const INDEX_STAGE_PREFIX = Object.freeze([KEYSPACE.META, "index-stage"]);
const INDEX_STAGE_TABLET_PREFIX = Object.freeze([KEYSPACE.META, "index-stage-tablet"]);
const INDEX_STAGE_APPLIED_PREFIX = Object.freeze([KEYSPACE.META, "index-stage-applied"]);
const INDEX_STAGE_READY_PREFIX = Object.freeze([KEYSPACE.META, "index-stage-ready"]);
const INDEX_GENERATION_PREFIX = Object.freeze([KEYSPACE.META, "index-generation"]);
const OUTBOX_CURSOR_KEY = Object.freeze([KEYSPACE.META, "outbox-cursor"]);
const PUBLISHED_GENERATION_KEY = Object.freeze([KEYSPACE.META, "published-index-generation"]);
const INDEX_PREPARATION_METRICS_KEY = Object.freeze([KEYSPACE.META, "index-preparation-metrics"]);

const PROTECTED_KEYSPACES = new Set([
  KEYSPACE.CHUNK,
  KEYSPACE.CHUNK_REFERENCE,
  KEYSPACE.DOCUMENT,
  KEYSPACE.EVENT,
  KEYSPACE.EVENT_REFERENCE,
  KEYSPACE.EXPIRY,
  KEYSPACE.IDEMPOTENCY,
  KEYSPACE.LEASE,
  KEYSPACE.META,
  KEYSPACE.OUTBOX,
  KEYSPACE.SUPERSESSION,
  KEYSPACE.WINDOW,
  "manifest",
]);

export class OutboxIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OutboxIntegrityError";
    this.code = "ERR_ROCKSDB_OUTBOX_INTEGRITY";
    this.details = details;
  }
}

export class OutboxClaimError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OutboxClaimError";
    this.code = "ERR_ROCKSDB_OUTBOX_CLAIM";
    this.details = details;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.scan !== "function"
    || typeof store.transaction !== "function") {
    throw new TypeError("A RocksStore-compatible store is required.");
  }
  return store;
}

function nowValue(value) {
  return nonNegativeInteger(value ?? Date.now(), "now");
}

function scanLimit(value) {
  const limit = value ?? DEFAULT_OUTBOX_SCAN_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_OUTBOX_SCAN_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${DEFAULT_OUTBOX_SCAN_LIMIT}.`);
  }
  return limit;
}

function stateKey(sequence) {
  return [...OUTBOX_STATE_PREFIX, positiveInteger(sequence, "sequence")];
}

function stageKey(generation) {
  return [...INDEX_STAGE_PREFIX, positiveInteger(generation, "generation")];
}

function generationKey(generation) {
  return [...INDEX_GENERATION_PREFIX, positiveInteger(generation, "generation")];
}

function stageTabletKey(generation, ordinal) {
  return [
    ...INDEX_STAGE_TABLET_PREFIX,
    positiveInteger(generation, "generation"),
    nonNegativeInteger(ordinal, "tablet ordinal"),
  ];
}

function stageAppliedKey(generation, ordinal) {
  return [
    ...INDEX_STAGE_APPLIED_PREFIX,
    positiveInteger(generation, "generation"),
    nonNegativeInteger(ordinal, "tablet ordinal"),
  ];
}

function stageReadyKey(generation) {
  return [...INDEX_STAGE_READY_PREFIX, positiveInteger(generation, "generation")];
}

export const outboxKeys = Object.freeze({
  entry(sequence) {
    return [KEYSPACE.OUTBOX, positiveInteger(sequence, "sequence")];
  },
  state: stateKey,
  stage: stageKey,
  stageTablet: stageTabletKey,
  stageApplied: stageAppliedKey,
  stageReady: stageReadyKey,
  generation: generationKey,
  cursor() {
    return [...OUTBOX_CURSOR_KEY];
  },
  publishedGeneration() {
    return [...PUBLISHED_GENERATION_KEY];
  },
});

function validateEntryRecord(record) {
  if (record === undefined) return undefined;
  const sequence = record.key?.[1];
  if (record.key?.length !== 2 || record.key[0] !== KEYSPACE.OUTBOX
    || !Number.isSafeInteger(sequence) || sequence <= 0
    || !record.payload || record.payload.sequence !== sequence) {
    throw new OutboxIntegrityError("An outbox record has inconsistent key and payload sequences.", {
      key: record.key,
    });
  }
  return Object.freeze({
    sequence,
    payload: record.payload,
  });
}

/** Read one immutable canonical outbox entry. */
export async function readOutboxEntry(view, sequence) {
  if (!view || typeof view.getRecord !== "function") {
    throw new TypeError("readOutboxEntry requires a store or transaction view.");
  }
  return validateEntryRecord(await view.getRecord(outboxKeys.entry(sequence)));
}

function normalizeState(state, sequence) {
  if (state === undefined) return Object.freeze({ sequence, status: "pending", attempt: 0 });
  if (!state || state.stateVersion !== OUTBOX_STATE_VERSION || state.sequence !== sequence
    || !["pending", "processing", "processed"].includes(state.status)) {
    throw new OutboxIntegrityError(`Outbox state ${sequence} is malformed.`, { sequence, state });
  }
  return state;
}

/** Return canonical outbox entries in sequence order with their processing state. */
export async function listOutbox(store, options = {}) {
  requireStore(store);
  const limit = scanLimit(options.limit);
  const records = store.scan([KEYSPACE.OUTBOX], { limit });
  const entries = [];
  for (const record of records) {
    const entry = validateEntryRecord(record);
    const state = normalizeState(await store.get(stateKey(entry.sequence)), entry.sequence);
    if (options.status !== undefined && state.status !== options.status) continue;
    entries.push(Object.freeze({ ...entry, state }));
  }
  return Object.freeze(entries);
}

/**
 * Return whether an ordered outbox sequence has durably published. The cursor
 * is the compact proof after bounded publication history removes its state.
 */
export async function isOutboxSequenceProcessed(view, sequence) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("isOutboxSequenceProcessed requires a store or transaction view.");
  }
  positiveInteger(sequence, "sequence");
  const state = normalizeState(await view.get(stateKey(sequence)), sequence);
  if (state.status === "processed") return true;
  return cursorSequence(await view.get(OUTBOX_CURSOR_KEY)) > sequence;
}

function outboxTimestamp(entry, state) {
  for (const candidate of [entry.payload.admittedAt, state.firstClaimedAt]) {
    if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
}

/** Compute bounded backlog and generation metrics for daemon status. */
export async function outboxMetrics(store, options = {}) {
  requireStore(store);
  const now = nowValue(options.now);
  const cursor = await store.get(OUTBOX_CURSOR_KEY);
  const published = await store.get(PUBLISHED_GENERATION_KEY);
  const preparation = await store.get(INDEX_PREPARATION_METRICS_KEY);
  const nextSequence = cursorSequence(cursor);
  const maximumSequence = await store.get([
    KEYSPACE.META,
    KEYSPACE.COUNTER,
    "outbox",
  ]) ?? 0;
  nonNegativeInteger(maximumSequence, "outbox counter");
  const depth = Math.max(0, maximumSequence - nextSequence + 1);
  let entry;
  let firstState;
  let oldestPendingAt;
  if (depth > 0) {
    entry = await readOutboxEntry(store, nextSequence);
    if (entry === undefined) {
      throw new OutboxIntegrityError(`Canonical outbox entry ${nextSequence} is missing before the durable tail.`, {
        nextSequence,
        maximumSequence,
      });
    }
    firstState = normalizeState(await store.get(stateKey(nextSequence)), nextSequence);
    oldestPendingAt = outboxTimestamp(entry, firstState);
  }
  const processing = firstState?.status === "processing" ? 1 : 0;
  return Object.freeze({
    depth,
    pending: depth - processing,
    processing,
    processed: Math.min(maximumSequence, nextSequence - 1),
    scanned: depth > 0 ? 1 : 0,
    truncated: false,
    nextSequence,
    oldestPendingAt: oldestPendingAt ?? null,
    oldestPendingAgeMs: oldestPendingAt === undefined ? null : Math.max(0, now - oldestPendingAt),
    publishedGeneration: published?.generation ?? 0,
    publishedOutboxSequence: published?.outboxSequence ?? 0,
    skippedDocuments: preparation?.skippedDocuments ?? 0,
    skippedHandlers: preparation?.skippedHandlers ?? 0,
    lastSkippedDocumentId: preparation?.lastSkippedDocumentId ?? null,
    lastSkippedGeneration: preparation?.lastSkippedGeneration ?? null,
  });
}

function cursorSequence(cursor) {
  if (cursor === undefined) return 1;
  if (!cursor || !Number.isSafeInteger(cursor.nextSequence) || cursor.nextSequence <= 0) {
    throw new OutboxIntegrityError("The durable outbox cursor is malformed.", { cursor });
  }
  return cursor.nextSequence;
}

/**
 * Atomically claim the first unprocessed entry. The durable cursor prevents a
 * later entry from being published before an earlier one.
 */
export async function claimNextOutbox(store, options = {}) {
  requireStore(store);
  const workerId = identifier(options.workerId, "workerId");
  const now = nowValue(options.now);
  const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS, "leaseMs");
  // Optimistic transaction reads in rocksdb-js are non-blocking. Warm the
  // three ordered-claim keys so restart recovery also works with a cold cache.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previewSequence = cursorSequence(await store.get(OUTBOX_CURSOR_KEY));
    await readOutboxEntry(store, previewSequence);
    await store.get(stateKey(previewSequence));
    await store.get([KEYSPACE.META, KEYSPACE.COUNTER, "index-generation"]);
    await store.get([KEYSPACE.META, KEYSPACE.COUNTER, "outbox"]);
    try {
      return await store.transaction(async (transaction) => {
        const sequence = cursorSequence(await transaction.get(OUTBOX_CURSOR_KEY));
        const entry = await readOutboxEntry(transaction, sequence);
        if (entry === undefined) {
          const maximumSequence = await transaction.get([
            KEYSPACE.META,
            KEYSPACE.COUNTER,
            "outbox",
          ]) ?? 0;
          if (maximumSequence >= sequence) {
            throw new OutboxIntegrityError(`Canonical outbox entry ${sequence} is missing before the durable tail.`, {
              sequence,
              maximumSequence,
            });
          }
          return Object.freeze({ status: "idle", nextSequence: sequence });
        }

        const state = normalizeState(await transaction.get(stateKey(sequence)), sequence);
        if (state.status === "processed") {
          throw new OutboxIntegrityError(`Processed outbox entry ${sequence} remains at the durable cursor.`);
        }
        if (state.status === "processing" && state.claimedUntil > now) {
          return Object.freeze({
            status: "busy",
            sequence,
            workerId: state.workerId,
            claimedUntil: state.claimedUntil,
          });
        }

        const generation = state.generation ?? await transaction.increment("index-generation");
        const claimToken = randomUUID();
        const claimed = Object.freeze({
          stateVersion: OUTBOX_STATE_VERSION,
          sequence,
          status: "processing",
          generation,
          operation: entry.payload.operation ?? "index",
          workerId,
          claimToken,
          attempt: (state.attempt ?? 0) + 1,
          firstClaimedAt: state.firstClaimedAt ?? now,
          claimedAt: now,
          claimedUntil: now + leaseMs,
          lastError: state.lastError,
        });
        await transaction.put(stateKey(sequence), claimed, { kind: "outbox-state" });
        return Object.freeze({
          status: "claimed",
          sequence,
          generation,
          operation: claimed.operation,
          claimToken,
          workerId,
          entry,
          state: claimed,
        });
      });
    } catch (error) {
      if (error?.message !== "Result incomplete: no blocking io" || attempt === 2) throw error;
    }
  }
  throw new OutboxIntegrityError("Outbox claim retry loop terminated unexpectedly.");
}

function validateClaim(claim) {
  if (!claim || claim.status !== "claimed") throw new TypeError("A claimed outbox entry is required.");
  positiveInteger(claim.sequence, "claim.sequence");
  positiveInteger(claim.generation, "claim.generation");
  identifier(claim.claimToken, "claim.claimToken");
  return claim;
}

function assertClaimOwner(state, claim) {
  if (state?.status !== "processing" || state.sequence !== claim.sequence
    || state.generation !== claim.generation || state.claimToken !== claim.claimToken) {
    throw new OutboxClaimError(`Outbox claim ${claim.sequence} is no longer owned by this worker.`, {
      sequence: claim.sequence,
      generation: claim.generation,
    });
  }
}

/** Extend a live claim without changing its identity or generation. */
export async function renewOutboxClaim(store, claim, options = {}) {
  requireStore(store);
  validateClaim(claim);
  const now = nowValue(options.now);
  const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS, "leaseMs");
  return store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    const renewed = { ...state, claimedUntil: now + leaseMs };
    await transaction.put(stateKey(claim.sequence), renewed, { kind: "outbox-state" });
    return Object.freeze(renewed);
  });
}

function errorDetails(error) {
  if (error === undefined) return undefined;
  const details = {
    name: typeof error?.name === "string" ? error.name : "Error",
    message: boundedStoreErrorMessage(error),
  };
  if (typeof error?.code === "string") details.code = error.code;
  return Object.freeze(details);
}

/** Release a failed claim for immediate ordered replay. */
export async function releaseOutboxClaim(store, claim, error, options = {}) {
  requireStore(store);
  validateClaim(claim);
  const now = nowValue(options.now);
  await store.get(stateKey(claim.sequence));
  return store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    if (state?.status === "processed") return Object.freeze({ status: "processed" });
    if (state?.claimToken !== claim.claimToken) return Object.freeze({ status: "lost" });
    assertClaimOwner(state, claim);
    const pending = {
      stateVersion: OUTBOX_STATE_VERSION,
      sequence: claim.sequence,
      status: "pending",
      generation: claim.generation,
      operation: state.operation,
      attempt: state.attempt,
      firstClaimedAt: state.firstClaimedAt,
      retryAt: now,
      lastError: errorDetails(error),
    };
    await transaction.put(stateKey(claim.sequence), pending, { kind: "outbox-state" });
    return Object.freeze({ status: "released", state: Object.freeze(pending) });
  });
}

function mutationKey(value) {
  const key = Array.isArray(value) ? encodeKey(value) : encodedKey(value);
  const [keyspace] = decodeKey(key);
  if (PROTECTED_KEYSPACES.has(keyspace)) {
    throw new OutboxIntegrityError(`Index handlers cannot mutate protected keyspace ${String(keyspace)}.`);
  }
  return key;
}

function kindForKey(key) {
  const [kind] = decodeKey(key);
  return typeof kind === "string" && kind.length > 0 ? kind : "derived-index";
}

function serializeMutation(candidate, label) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const type = candidate.type ?? (Object.hasOwn(candidate, "payload") ? "put" : undefined);
  const key = mutationKey(candidate.key ?? candidate.keyParts);
  const serialized = {
    type,
    key: key.toString("base64url"),
    stagePhase: candidate.stagePhase ?? (type === "remove" ? "cleanup" : "prepare"),
  };
  if (!["prepare", "publish", "cleanup"].includes(serialized.stagePhase)) {
    throw new TypeError(`${label}.stagePhase must be prepare, publish, or cleanup.`);
  }
  if (type === "remove") return serialized;
  if (type !== "put" || !Object.hasOwn(candidate, "payload")) {
    throw new TypeError(`${label} must be a put mutation with payload or a remove mutation.`);
  }
  serialized.immutable = candidate.immutable !== false;
  serialized.record = encodeRecord({
    kind: candidate.kind ?? kindForKey(key),
    payload: candidate.payload,
    recordVersion: candidate.recordVersion ?? 1,
  }).toString("base64url");
  return serialized;
}

function compareSerializedMutations(left, right) {
  const phaseOrder = { prepare: 0, publish: 1, cleanup: 2 };
  for (const [leftValue, rightValue] of [
    [left.key, right.key],
    [phaseOrder[left.stagePhase], phaseOrder[right.stagePhase]],
    [left.type, right.type],
    [String(left.record), String(right.record)],
  ]) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function boundedPlanOption(value, fallback, label) {
  return positiveInteger(value ?? fallback, label);
}

function serializedBytes(value) {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function tabletDigest(tablet) {
  const { digest, ...content } = tablet;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function createTablets(mutations, options) {
  const envelopeBytes = Math.min(8 * 1_024, Math.floor(options.maxBytes / 4));
  const mutationBudget = options.maxBytes - envelopeBytes;
  if (mutationBudget <= 0) throw new RangeError("tabletMaxBytes is too small for a tablet envelope.");
  const tablets = [];
  let current = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    const ordinal = tablets.length;
    const prepareCount = current.filter(({ stagePhase }) => stagePhase === "prepare").length;
    const cleanupCount = current.filter(({ stagePhase }) => stagePhase === "cleanup").length;
    const content = {
      stageVersion: INDEX_STAGE_VERSION,
      generation: options.generation,
      outboxSequence: options.outboxSequence,
      ordinal,
      mutationCount: current.length,
      prepareCount,
      cleanupCount,
      mutationBytes: currentBytes,
      mutations: current,
    };
    const tablet = Object.freeze({
      ...content,
      digest: createHash("sha256").update(stableJson(content)).digest("hex"),
    });
    if (serializedBytes(tablet) > options.maxBytes) {
      throw new OutboxIntegrityError(`Index tablet ${ordinal} exceeds its durable byte bound.`);
    }
    tablets.push(tablet);
    current = [];
    currentBytes = 0;
  };
  for (const mutation of mutations) {
    const bytes = serializedBytes(mutation);
    if (bytes > mutationBudget) {
      const error = new RangeError(
        `One index mutation requires ${bytes} bytes; tablet maximum is ${options.maxBytes}.`,
      );
      error.code = "ERR_INDEX_MUTATION_TOO_LARGE";
      throw error;
    }
    if (current.length >= options.maxMutations || currentBytes + bytes > mutationBudget) flush();
    current.push(mutation);
    currentBytes += bytes;
  }
  flush();
  return Object.freeze(tablets);
}

function normalizeMutations(handlerResults) {
  const serialized = [];
  for (const result of handlerResults) {
    for (let index = 0; index < result.mutations.length; index += 1) {
      serialized.push(serializeMutation(result.mutations[index], `${result.id}.mutations[${index}]`));
    }
  }
  serialized.sort(compareSerializedMutations);
  const unique = [];
  for (const mutation of serialized) {
    const previous = unique.at(-1);
    if (previous?.key !== mutation.key) {
      unique.push(mutation);
      continue;
    }
    if (stableJson(previous) === stableJson(mutation)) continue;
    const stagedCleanup = previous.stagePhase === "prepare"
      && previous.type === "put"
      && mutation.stagePhase === "cleanup"
      && mutation.type === "remove";
    if (!stagedCleanup) {
      throw new OutboxIntegrityError("Index handlers produced conflicting mutations for one derived key.", {
        key: mutation.key,
      });
    }
    unique.push(mutation);
  }
  return unique;
}

/** Build the deterministic, durable plan that separates staging from publication. */
export function createGenerationPlan(claim, handlerResults, options = {}) {
  validateClaim(claim);
  if (!Array.isArray(handlerResults)) throw new TypeError("handlerResults must be an array.");
  const handlers = handlerResults.map((result, index) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError(`handlerResults[${index}] must be an object.`);
    }
    const id = identifier(result.id, `handlerResults[${index}].id`);
    if (!Array.isArray(result.mutations)) {
      throw new TypeError(`handlerResults[${index}].mutations must be an array.`);
    }
    return {
      id,
      mutationCount: result.mutations.length,
      metadata: result.metadata ?? null,
    };
  }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const mutations = normalizeMutations(handlerResults);
  const mutationBytes = mutations.reduce((total, mutation) => total + serializedBytes(mutation), 0);
  const atomicMaxMutations = boundedPlanOption(
    options.atomicMaxMutations,
    DEFAULT_INDEX_ATOMIC_MAX_MUTATIONS,
    "atomicMaxMutations",
  );
  const atomicMaxBytes = boundedPlanOption(
    options.atomicMaxBytes,
    DEFAULT_INDEX_ATOMIC_MAX_BYTES,
    "atomicMaxBytes",
  );
  const base = {
    stageVersion: INDEX_STAGE_VERSION,
    generation: claim.generation,
    outboxSequence: claim.sequence,
    operation: claim.operation,
    documentId: claim.entry.payload.documentId,
    documentVersion: claim.entry.payload.documentVersion,
    sourceVersion: claim.entry.payload.sourceVersion,
    handlers,
    mutationCount: mutations.length,
    mutationBytes,
  };
  if (mutations.length <= atomicMaxMutations && mutationBytes <= atomicMaxBytes) {
    const content = { ...base, mode: "atomic", mutations };
    return Object.freeze({
      ...content,
      digest: createHash("sha256").update(stableJson(content)).digest("hex"),
    });
  }

  const publicationMutations = mutations.filter(({ stagePhase }) => stagePhase === "publish");
  const publicationBytes = publicationMutations.reduce(
    (total, mutation) => total + serializedBytes(mutation),
    0,
  );
  const publicationMaxMutations = boundedPlanOption(
    options.publicationMaxMutations,
    DEFAULT_INDEX_PUBLICATION_MAX_MUTATIONS,
    "publicationMaxMutations",
  );
  const publicationMaxBytes = boundedPlanOption(
    options.publicationMaxBytes,
    DEFAULT_INDEX_PUBLICATION_MAX_BYTES,
    "publicationMaxBytes",
  );
  if (publicationMutations.length > publicationMaxMutations || publicationBytes > publicationMaxBytes) {
    const error = new RangeError(
      `Atomic publication requires ${publicationMutations.length} mutations/${publicationBytes} bytes; `
      + `maximum is ${publicationMaxMutations}/${publicationMaxBytes}.`,
    );
    error.code = "ERR_INDEX_PUBLICATION_TOO_LARGE";
    throw error;
  }
  const tabletMaxMutations = boundedPlanOption(
    options.tabletMaxMutations,
    DEFAULT_INDEX_TABLET_MAX_MUTATIONS,
    "tabletMaxMutations",
  );
  const tabletMaxBytes = boundedPlanOption(
    options.tabletMaxBytes,
    DEFAULT_INDEX_TABLET_MAX_BYTES,
    "tabletMaxBytes",
  );
  const tablets = createTablets(
    mutations.filter(({ stagePhase }) => stagePhase !== "publish"),
    {
      generation: claim.generation,
      outboxSequence: claim.sequence,
      maxMutations: tabletMaxMutations,
      maxBytes: tabletMaxBytes,
    },
  );
  const content = {
    ...base,
    mode: "tablets",
    publicationMutations,
    publicationMutationCount: publicationMutations.length,
    publicationBytes,
    tabletMaxMutations,
    tabletMaxBytes,
    tabletCount: tablets.length,
    tabletsDigest: createHash("sha256")
      .update(tablets.map(({ digest: tabletHash }) => tabletHash).join("\n"))
      .digest("hex"),
    prepareMutationCount: tablets.reduce((total, { prepareCount }) => total + prepareCount, 0),
    cleanupMutationCount: tablets.reduce((total, { cleanupCount }) => total + cleanupCount, 0),
  };
  const digest = createHash("sha256").update(stableJson(content)).digest("hex");
  return Object.freeze({
    ...content,
    digest,
    tabletRecords: tablets,
  });
}

function validateStage(plan, claim) {
  if (!plan || plan.stageVersion !== INDEX_STAGE_VERSION || plan.generation !== claim.generation
    || plan.outboxSequence !== claim.sequence || typeof plan.digest !== "string") {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} has a malformed stage.`);
  }
  if (!["atomic", "tablets"].includes(plan.mode)) {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} has an unknown stage mode.`);
  }
  const { digest, tabletRecords: _tabletRecords, ...content } = plan;
  const actual = createHash("sha256").update(stableJson(content)).digest("hex");
  if (actual !== digest) {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} stage digest does not match.`);
  }
  return plan;
}

async function clearOrphanStageRecords(store, claim) {
  const prefixes = [
    [...INDEX_STAGE_TABLET_PREFIX, claim.generation],
    [...INDEX_STAGE_APPLIED_PREFIX, claim.generation],
  ];
  let removed = 0;
  for (const prefix of prefixes) {
    for (;;) {
      const page = store.scan(prefix, { limit: 256 });
      if (page.length === 0) break;
      for (const record of page) {
        await store.get(stateKey(claim.sequence));
        await store.transaction(async (transaction) => {
          const state = await transaction.get(stateKey(claim.sequence));
          assertClaimOwner(state, claim);
          await transaction.remove(record.keyBytes);
        });
        removed += 1;
      }
    }
  }
  await store.get(stateKey(claim.sequence));
  await store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    await transaction.remove(stageReadyKey(claim.generation));
  });
  return removed;
}

/**
 * Remove the pre-tablet stage format under the current claim. Version-one
 * stages were never visible before publication, so canonical replay is the
 * compatible upgrade path and avoids retrying an unreadable head forever.
 */
export async function discardLegacyUnpublishedStage(store, claim) {
  requireStore(store);
  validateClaim(claim);
  const legacy = await store.get(stageKey(claim.generation));
  if (legacy === undefined || legacy.stageVersion === INDEX_STAGE_VERSION) {
    return Object.freeze({ status: "unchanged", generation: claim.generation });
  }
  if (legacy.stageVersion !== 1 || legacy.generation !== claim.generation
    || legacy.outboxSequence !== claim.sequence) {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} has a malformed stage.`);
  }
  if (await store.has(generationKey(claim.generation))) {
    throw new OutboxIntegrityError(
      `Published generation ${claim.generation} cannot discard its legacy stage.`,
    );
  }

  const removedResidue = await clearOrphanStageRecords(store, claim);
  await store.get(stateKey(claim.sequence));
  await store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    // Stage records are immutable and this live claim excludes another worker.
    // Do not re-read a potentially blob-backed legacy plan inside rocksdb-js's
    // cache-only optimistic transaction.
    await transaction.remove(stageKey(claim.generation));
  });
  return Object.freeze({
    status: "discarded",
    generation: claim.generation,
    stageVersion: 1,
    removedResidue,
  });
}

/** Persist a complete handler plan while keeping every final mutation invisible. */
export async function stageGeneration(store, claim, plan, options = {}) {
  requireStore(store);
  validateClaim(claim);
  validateStage(plan, claim);
  for (const name of ["beforeTablet", "afterTablet"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new TypeError(`${name} must be a function.`);
    }
  }
  const existingHeader = await store.get(stageKey(claim.generation));
  if (existingHeader !== undefined) {
    const existing = validateStage(existingHeader, claim);
    if (existing.digest !== plan.digest) {
      throw new OutboxIntegrityError(`Index generation ${claim.generation} stage already has another plan.`);
    }
    return Object.freeze({ status: "unchanged", generation: claim.generation, digest: plan.digest });
  }
  if (plan.mode === "tablets") {
    if (!Array.isArray(plan.tabletRecords) || plan.tabletRecords.length !== plan.tabletCount) {
      throw new OutboxIntegrityError(`Index generation ${claim.generation} is missing tablet records.`);
    }
    await clearOrphanStageRecords(store, claim);
    const digests = [];
    for (let ordinal = 0; ordinal < plan.tabletRecords.length; ordinal += 1) {
      const tablet = validateTablet(plan.tabletRecords[ordinal], plan, claim, ordinal);
      digests.push(tablet.digest);
      if (options.beforeTablet) await options.beforeTablet({ ordinal, tablet });
      await store.get(stateKey(claim.sequence));
      await store.get(stageTabletKey(claim.generation, ordinal));
      await store.transaction(async (transaction) => {
        const state = await transaction.get(stateKey(claim.sequence));
        assertClaimOwner(state, claim);
        await transaction.putImmutable(stageTabletKey(claim.generation, ordinal), tablet, {
          kind: "index-stage-tablet",
        });
      });
      if (options.afterTablet) await options.afterTablet({ ordinal, tablet });
    }
    const aggregate = createHash("sha256").update(digests.join("\n")).digest("hex");
    if (aggregate !== plan.tabletsDigest) {
      throw new OutboxIntegrityError(`Index generation ${claim.generation} tablet digest set does not match.`);
    }
  }
  const { tabletRecords: _tabletRecords, ...header } = plan;
  await store.get(stateKey(claim.sequence));
  await store.get(stageKey(claim.generation));
  return store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    const result = await transaction.putImmutable(stageKey(claim.generation), header, { kind: "index-stage" });
    return Object.freeze({ status: result, generation: claim.generation, digest: plan.digest });
  });
}

/** Return and verify a staged plan for a claimed generation, if one exists. */
export async function readStagedGeneration(view, claim) {
  validateClaim(claim);
  const plan = await view.get(stageKey(claim.generation));
  return plan === undefined ? undefined : validateStage(plan, claim);
}

function validateTablet(tablet, plan, claim, ordinal) {
  if (!tablet || tablet.stageVersion !== INDEX_STAGE_VERSION
    || tablet.generation !== claim.generation || tablet.outboxSequence !== claim.sequence
    || tablet.ordinal !== ordinal || !Array.isArray(tablet.mutations)
    || tablet.mutationCount !== tablet.mutations.length
    || tablet.mutationCount > plan.tabletMaxMutations
    || tablet.mutationBytes > plan.tabletMaxBytes
    || typeof tablet.digest !== "string" || tabletDigest(tablet) !== tablet.digest) {
    throw new OutboxIntegrityError(
      `Index generation ${claim.generation} tablet ${ordinal} is malformed.`,
    );
  }
  const bytes = tablet.mutations.reduce((total, mutation) => total + serializedBytes(mutation), 0);
  const prepareCount = tablet.mutations.filter(({ stagePhase }) => stagePhase === "prepare").length;
  const cleanupCount = tablet.mutations.filter(({ stagePhase }) => stagePhase === "cleanup").length;
  if (bytes !== tablet.mutationBytes || prepareCount !== tablet.prepareCount
    || cleanupCount !== tablet.cleanupCount || prepareCount + cleanupCount !== tablet.mutationCount
    || tablet.mutations.some(({ stagePhase }) => stagePhase === "publish")) {
    throw new OutboxIntegrityError(
      `Index generation ${claim.generation} tablet ${ordinal} has inconsistent bounds.`,
    );
  }
  return tablet;
}

async function readStageTablet(view, claim, plan, ordinal) {
  const tablet = await view.get(stageTabletKey(claim.generation, ordinal));
  if (tablet === undefined) {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} tablet ${ordinal} is missing.`);
  }
  return validateTablet(tablet, plan, claim, ordinal);
}

function applySerializedMutation(transaction, mutation) {
  const key = Buffer.from(mutation.key, "base64url");
  mutationKey(key);
  if (mutation.type === "remove") return transaction.remove(key);
  if (mutation.type !== "put" || typeof mutation.record !== "string") {
    throw new OutboxIntegrityError("A staged index mutation is malformed.");
  }
  const decoded = decodeRecord(Buffer.from(mutation.record, "base64url"));
  const options = { kind: decoded.kind, recordVersion: decoded.recordVersion };
  return mutation.immutable
    ? transaction.putImmutable(key, decoded.payload, options)
    : transaction.put(key, decoded.payload, options);
}

/** Apply bounded pre-publication tablets and durably mark a complete generation ready. */
export async function applyGenerationTablets(store, claim, options = {}) {
  requireStore(store);
  validateClaim(claim);
  if (options.afterTablet !== undefined && typeof options.afterTablet !== "function") {
    throw new TypeError("afterTablet must be a function.");
  }
  const plan = await readStagedGeneration(store, claim);
  if (plan === undefined) {
    throw new OutboxIntegrityError(`Generation ${claim.generation} has no staged plan.`);
  }
  if (plan.mode === "atomic") {
    return Object.freeze({ status: "atomic", appliedTablets: 0, skippedTablets: 0 });
  }
  const ready = await store.get(stageReadyKey(claim.generation));
  if (ready?.stageDigest === plan.digest) {
    return Object.freeze({ status: "ready", appliedTablets: 0, skippedTablets: plan.tabletCount });
  }
  const digests = [];
  let appliedTablets = 0;
  let skippedTablets = 0;
  for (let ordinal = 0; ordinal < plan.tabletCount; ordinal += 1) {
    const tablet = await readStageTablet(store, claim, plan, ordinal);
    digests.push(tablet.digest);
    await store.get(stateKey(claim.sequence));
    await store.get(stageAppliedKey(claim.generation, ordinal));
    for (const mutation of tablet.mutations) {
      if (mutation.stagePhase === "prepare") {
        await store.getRecord(Buffer.from(mutation.key, "base64url"));
      }
    }
    const outcome = await store.transaction(async (transaction) => {
      const state = await transaction.get(stateKey(claim.sequence));
      assertClaimOwner(state, claim);
      const marker = await transaction.get(stageAppliedKey(claim.generation, ordinal));
      if (marker !== undefined) {
        if (marker.tabletDigest !== tablet.digest || marker.stageDigest !== plan.digest) {
          throw new OutboxIntegrityError(
            `Index generation ${claim.generation} tablet ${ordinal} applied marker conflicts.`,
          );
        }
        return "skipped";
      }
      for (const mutation of tablet.mutations) {
        if (mutation.stagePhase === "prepare") await applySerializedMutation(transaction, mutation);
      }
      await transaction.putImmutable(stageAppliedKey(claim.generation, ordinal), {
        generation: claim.generation,
        ordinal,
        tabletDigest: tablet.digest,
        stageDigest: plan.digest,
        mutationCount: tablet.prepareCount,
      }, { kind: "index-stage-applied" });
      return "applied";
    });
    if (outcome === "applied") appliedTablets += 1;
    else skippedTablets += 1;
    if (options.afterTablet) {
      await options.afterTablet(Object.freeze({
        generation: claim.generation,
        ordinal,
        outcome,
        mutationCount: tablet.prepareCount,
        mutationBytes: tablet.mutationBytes,
      }));
    }
  }
  const aggregate = createHash("sha256").update(digests.join("\n")).digest("hex");
  if (aggregate !== plan.tabletsDigest) {
    throw new OutboxIntegrityError(`Index generation ${claim.generation} staged tablets do not match the plan.`);
  }
  await store.get(stateKey(claim.sequence));
  await store.get(stageReadyKey(claim.generation));
  await store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    await transaction.putImmutable(stageReadyKey(claim.generation), {
      generation: claim.generation,
      outboxSequence: claim.sequence,
      stageDigest: plan.digest,
      tabletCount: plan.tabletCount,
      tabletsDigest: plan.tabletsDigest,
    }, { kind: "index-stage-ready" });
  });
  return Object.freeze({ status: "ready", appliedTablets, skippedTablets });
}

/**
 * Atomically apply every staged mutation, publish the generation, advance the
 * ordered cursor, and mark the outbox entry processed.
 */
export async function publishGeneration(store, claim, options = {}) {
  requireStore(store);
  validateClaim(claim);
  const publishedAt = nowValue(options.now);
  // As with ordered claims, warm every key read by the optimistic transaction.
  // This keeps publication reliable immediately after a daemon restart while
  // retaining the transaction's conflict checks and atomic commit.
  const previewPlan = await readStagedGeneration(store, claim);
  if (previewPlan === undefined) {
    throw new OutboxIntegrityError(`Generation ${claim.generation} has no staged plan.`);
  }
  await store.get(stateKey(claim.sequence));
  await store.get(OUTBOX_CURSOR_KEY);
  await store.get(PUBLISHED_GENERATION_KEY);
  await store.get(INDEX_PREPARATION_METRICS_KEY);
  await store.get(generationKey(claim.generation));
  if (previewPlan.mode === "tablets") await store.get(stageReadyKey(claim.generation));
  const publicationMutations = previewPlan.mode === "atomic"
    ? previewPlan.mutations
    : previewPlan.publicationMutations;
  for (const mutation of publicationMutations) {
    await store.getRecord(Buffer.from(mutation.key, "base64url"));
  }
  return store.transaction(async (transaction) => {
    const state = await transaction.get(stateKey(claim.sequence));
    assertClaimOwner(state, claim);
    const cursor = cursorSequence(await transaction.get(OUTBOX_CURSOR_KEY));
    if (cursor !== claim.sequence) {
      throw new OutboxIntegrityError(`Generation ${claim.generation} cannot publish out of outbox order.`, {
        expectedSequence: cursor,
        actualSequence: claim.sequence,
      });
    }
    const plan = await readStagedGeneration(transaction, claim);
    if (plan === undefined) throw new OutboxIntegrityError(`Generation ${claim.generation} has no staged plan.`);
    if (plan.mode === "tablets") {
      const ready = await transaction.get(stageReadyKey(claim.generation));
      if (ready?.stageDigest !== plan.digest || ready.tabletsDigest !== plan.tabletsDigest) {
        throw new OutboxIntegrityError(`Generation ${claim.generation} tablets are not ready to publish.`);
      }
    }
    const mutations = plan.mode === "atomic" ? plan.mutations : plan.publicationMutations;
    for (const mutation of mutations) await applySerializedMutation(transaction, mutation);

    const skippedHandlers = plan.handlers
      .filter(({ metadata }) => metadata?.status === "skipped")
      .map(({ id, metadata }) => Object.freeze({
        id,
        reason: metadata.reason,
        limitKind: metadata.limitKind,
        limit: metadata.limit,
        observed: metadata.observed,
      }));
    const partialHandlerCount = plan.handlers
      .filter(({ metadata }) => metadata?.status === "partial")
      .length;
    const indexStatus = skippedHandlers.length === plan.handlers.length
      ? "skipped"
      : (skippedHandlers.length > 0 || partialHandlerCount > 0 ? "partial" : "complete");

    const publication = Object.freeze({
      generationVersion: INDEX_GENERATION_VERSION,
      generation: claim.generation,
      outboxSequence: claim.sequence,
      operation: claim.operation,
      documentId: plan.documentId,
      documentVersion: plan.documentVersion,
      sourceVersion: plan.sourceVersion,
      handlers: plan.handlers,
      indexStatus,
      skippedHandlers,
      partialHandlerCount,
      mutationCount: plan.mutationCount,
      publicationMode: plan.mode,
      tabletCount: plan.mode === "tablets" ? plan.tabletCount : 0,
      stageDigest: plan.digest,
      publishedAt,
    });
    await transaction.putImmutable(generationKey(claim.generation), publication, {
      kind: "index-generation",
    });
    await transaction.put(PUBLISHED_GENERATION_KEY, {
      generation: claim.generation,
      outboxSequence: claim.sequence,
      indexStatus,
      skippedHandlerCount: skippedHandlers.length,
      partialHandlerCount,
      publishedAt,
    }, { kind: "published-index-generation" });
    if (skippedHandlers.length > 0) {
      const currentMetrics = await transaction.get(INDEX_PREPARATION_METRICS_KEY) ?? {
        skippedDocuments: 0,
        skippedHandlers: 0,
      };
      await transaction.put(INDEX_PREPARATION_METRICS_KEY, {
        skippedDocuments: currentMetrics.skippedDocuments + 1,
        skippedHandlers: currentMetrics.skippedHandlers + skippedHandlers.length,
        lastSkippedDocumentId: plan.documentId,
        lastSkippedGeneration: claim.generation,
        updatedAt: publishedAt,
      }, { kind: "index-preparation-metrics" });
    }
    await transaction.put(OUTBOX_CURSOR_KEY, {
      nextSequence: claim.sequence + 1,
      advancedAt: publishedAt,
    }, { kind: "outbox-cursor" });
    await transaction.put(stateKey(claim.sequence), {
      ...state,
      status: "processed",
      processedAt: publishedAt,
      mutationCount: plan.mutationCount,
      indexStatus,
      skippedHandlers,
      stageDigest: plan.digest,
      claimedUntil: undefined,
      claimToken: undefined,
      workerId: undefined,
      lastError: undefined,
    }, { kind: "outbox-state" });
    return publication;
  });
}

/** Remove a no-longer-needed stage after its generation is durably published. */
export async function cleanupPublishedStage(store, generation, options = {}) {
  requireStore(store);
  positiveInteger(generation, "generation");
  const retainPublications = positiveInteger(
    options.retainPublications ?? DEFAULT_PUBLICATION_HISTORY,
    "retainPublications",
  );
  const publication = await store.get(generationKey(generation));
  if (publication === undefined) return Object.freeze({ status: "unpublished", generation });
  const storedPlan = await store.get(stageKey(generation));
  if (storedPlan?.mode === "tablets") {
    const stageClaim = {
      generation,
      sequence: publication.outboxSequence,
    };
    const plan = validateStage(storedPlan, stageClaim);
    let ready = await store.get(stageReadyKey(generation));
    if (ready?.stageDigest !== plan.digest) {
      throw new OutboxIntegrityError(`Published generation ${generation} has no valid ready marker.`);
    }
    let ordinal = nonNegativeInteger(ready.cleanupOrdinal ?? 0, "cleanup ordinal");
    while (ordinal < plan.tabletCount) {
      const tablet = await readStageTablet(store, stageClaim, plan, ordinal);
      await store.get(stageReadyKey(generation));
      for (const mutation of tablet.mutations) {
        if (mutation.stagePhase === "cleanup") {
          await store.getRecord(Buffer.from(mutation.key, "base64url"));
        }
      }
      await store.transaction(async (transaction) => {
        const current = await transaction.get(stageReadyKey(generation));
        if (current?.stageDigest !== plan.digest || (current.cleanupOrdinal ?? 0) !== ordinal) {
          throw new OutboxIntegrityError(`Generation ${generation} cleanup progress changed concurrently.`);
        }
        for (const mutation of tablet.mutations) {
          if (mutation.stagePhase === "cleanup") await applySerializedMutation(transaction, mutation);
        }
        await transaction.remove(stageTabletKey(generation, ordinal));
        await transaction.remove(stageAppliedKey(generation, ordinal));
        await transaction.put(stageReadyKey(generation), {
          ...current,
          cleanupOrdinal: ordinal + 1,
        }, { kind: "index-stage-ready" });
      });
      ordinal += 1;
    }
  }
  return store.transaction(async (transaction) => {
    await transaction.remove(stageKey(generation));
    await transaction.remove(stageReadyKey(generation));
    const prunedGeneration = generation - retainPublications;
    const prunedSequence = publication.outboxSequence - retainPublications;
    if (prunedGeneration > 0) await transaction.remove(generationKey(prunedGeneration));
    if (prunedSequence > 0) {
      await transaction.remove(outboxKeys.entry(prunedSequence));
      await transaction.remove(stateKey(prunedSequence));
    }
    return Object.freeze({
      status: "removed",
      generation,
      prunedGeneration: prunedGeneration > 0 ? prunedGeneration : null,
      prunedSequence: prunedSequence > 0 ? prunedSequence : null,
    });
  });
}

/** Recover claims left by a terminated daemon and clean published stage residue. */
export async function recoverOutbox(store, options = {}) {
  requireStore(store);
  const now = nowValue(options.now);
  const limit = scanLimit(options.limit);
  const states = store.scan(OUTBOX_STATE_PREFIX, { limit });
  let recoveredClaims = 0;
  for (const record of states) {
    const sequence = record.key.at(-1);
    const state = normalizeState(record.payload, sequence);
    if (state.status !== "processing") continue;
    await store.transaction(async (transaction) => {
      const current = await transaction.get(stateKey(sequence));
      if (current?.status !== "processing") return;
      await transaction.put(stateKey(sequence), {
        ...current,
        status: "pending",
        retryAt: now,
        claimedUntil: undefined,
        claimToken: undefined,
        workerId: undefined,
        lastError: {
          name: "WorkerRestart",
          code: "ERR_INDEX_WORKER_RESTART",
          message: "The daemon restarted before this outbox entry was published.",
        },
      }, { kind: "outbox-state" });
      recoveredClaims += 1;
    });
  }

  const stages = store.scan(INDEX_STAGE_PREFIX, { limit });
  let cleanedStages = 0;
  for (const record of stages) {
    const generation = record.key.at(-1);
    if (await store.has(generationKey(generation))) {
      await cleanupPublishedStage(store, generation, {
        retainPublications: options.retainPublications ?? DEFAULT_PUBLICATION_HISTORY,
      });
      cleanedStages += 1;
    }
  }
  return Object.freeze({
    recoveredClaims,
    cleanedStages,
    truncated: states.length === limit || stages.length === limit,
  });
}
