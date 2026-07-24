import { encodeRecord, stableJson } from "./schema.js";
import { encodeKey, keyFor, KEYSPACE } from "./keys.js";
import {
  DERIVED_VIEW_FORMAT_VERSION,
  DERIVED_VIEW_LAYOUT,
  derivedViewKeys,
  verifyDerivedViewPage,
} from "./derived-view.js";
import {
  garbageCollectObsoleteIndexNamespaces,
} from "./index-namespace-maintenance.js";
import { bm25Keys } from "./index/bm25-keys.js";
import {
  exactKeys,
  normalizeExactValue,
} from "./index/exact.js";
import {
  encodePostingLocator,
  isPostingLocator,
  POSTING_LOCATOR_KIND,
} from "./index/posting-locator.js";
import {
  decodeBm25PostingBlock,
  decodeExactPostingBlock,
  encodeBm25PostingBlock,
  encodeExactPostingBlock,
  isPostingBlock,
} from "./index/posting-block.js";

export const POSTING_STORAGE_MIGRATION_VERSION = 2;
export const POSTING_STORAGE_PAGE_SIZE = 1_024;
export const DEFAULT_POSTING_ROLLBACK_GRACE_MS = 24 * 60 * 60 * 1_000;

const STATE_KEY = Object.freeze([KEYSPACE.META, "posting-storage-migration"]);
const MIGRATION_PHASES = new Set([
  "obsolete-namespaces",
  "bm25-session-locators",
  "bm25-canonical-blocks",
  "exact-folded-locators",
  "exact-canonical-blocks",
  "verify-cutover",
  "rollback-grace",
  "reverse-references",
  "complete",
]);
const VERIFICATION_COUNTERS = Object.freeze([
  "checked",
  "missingAssignments",
  "identityMismatches",
  "scopeMismatches",
  "retirementMismatches",
  "orphanLiveAssignments",
]);

export const postingStorageKeys = Object.freeze({
  state() {
    return [...STATE_KEY];
  },
});

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function matchIdentity(match) {
  return `${match.type}\0${match.value}\0${match.startByte}\0${match.endByte}`;
}

function bm25CanonicalKey(record) {
  const [
    ,
    ,
    ,
    ,
    family,
    project,
    ,
    term,
    bucket,
    createdAt,
    documentId,
    version,
    generation,
    windowOrdinal,
  ] = record.key;
  if (family !== "session-term") throw new TypeError("Expected a BM25 session posting.");
  return bm25Keys.posting(
    project,
    term,
    bucket,
    createdAt,
    documentId,
    version,
    generation,
    windowOrdinal,
  );
}

function encodedValueBytes(kind, payload) {
  return encodeRecord({ kind, payload }).length;
}

async function rewriteRecords(
  store,
  records,
  resolveRewrite,
  reportOnly,
  alreadyRewritten,
) {
  const rewrites = [];
  let unresolvedKeys = 0;
  for (const record of records) {
    if (alreadyRewritten(record.payload)) continue;
    const rewrite = await resolveRewrite(record);
    if (rewrite === undefined) {
      unresolvedKeys += 1;
      continue;
    }
    rewrites.push({ record, ...rewrite });
  }
  const measured = rewrites.reduce((summary, { record, kind, payload }) => {
    const nextBytes = encodedValueBytes(kind, payload);
    return {
      rewrittenKeys: summary.rewrittenKeys + 1,
      previousValueBytes: summary.previousValueBytes + record.storedValueBytes,
      nextValueBytes: summary.nextValueBytes + nextBytes,
      valueBytesSaved: summary.valueBytesSaved + Math.max(0, record.storedValueBytes - nextBytes),
    };
  }, {
    rewrittenKeys: 0,
    previousValueBytes: 0,
    nextValueBytes: 0,
    valueBytesSaved: 0,
  });
  if (!reportOnly) {
    for (let offset = 0; offset < rewrites.length; offset += 128) {
      const batch = rewrites.slice(offset, offset + 128);
      await store.transaction(async (transaction) => {
        for (const { record, kind, payload } of batch) {
          const current = await transaction.getRecord(record.keyBytes);
          if (current === undefined || alreadyRewritten(current.payload)) continue;
          if (stableJson(current.payload) !== stableJson(record.payload)) {
            throw new Error("Posting changed during storage migration.");
          }
          await transaction.put(record.keyBytes, payload, { kind });
        }
      });
    }
  }
  return { ...measured, unresolvedKeys };
}

/**
 * Replace duplicated per-session BM25 values with one binary locator to the
 * project posting. Mixed legacy and locator records remain readable.
 */
export async function rewriteBm25SessionPostingLocators(store, {
  reportOnly = true,
  limit = POSTING_STORAGE_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const page = store.scan(bm25Keys.sessionPostingRoot(), {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const measured = await rewriteRecords(store, page, async (record) => {
    const canonicalKey = bm25CanonicalKey(record);
    const canonical = await store.get(canonicalKey);
    if (canonical === undefined) {
      throw new Error("A BM25 session posting has no canonical project posting.");
    }
    if (stableJson(canonical) !== stableJson(record.payload)) {
      throw new Error("A BM25 session posting differs from its canonical project posting.");
    }
    return {
      kind: "bm25-session-posting-locator",
      payload: encodePostingLocator(
        POSTING_LOCATOR_KIND.BM25_SESSION,
        [encodeKey(canonicalKey)],
      ),
    };
  }, reportOnly, isPostingLocator);
  return Object.freeze({
    phase: "bm25-session-locators",
    reportOnly,
    scannedKeys: page.length,
    ...measured,
    complete: page.length < boundedLimit,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
  });
}

export async function rewriteBm25CanonicalPostingBlocks(store, {
  reportOnly = true,
  limit = POSTING_STORAGE_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const page = store.scan(bm25Keys.postingRoot(), {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const measured = await rewriteRecords(store, page, async (record) => ({
    kind: "bm25-posting-block",
    payload: encodeBm25PostingBlock(record.payload),
  }), reportOnly, isPostingBlock);
  return Object.freeze({
    phase: "bm25-canonical-blocks",
    reportOnly,
    scannedKeys: page.length,
    ...measured,
    complete: page.length < boundedLimit,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
  });
}

async function exactCanonicalTargets(store, record) {
  const posting = record.payload;
  if (!posting || posting.caseMode !== "folded" || !Array.isArray(posting.matches)) {
    throw new Error("A legacy folded exact posting is malformed.");
  }
  const uncovered = new Set(posting.matches.map(matchIdentity));
  const targets = new Map();
  const exactTerms = [...new Set(posting.matches.map(({ value }) => normalizeExactValue(value)))];
  for (const term of exactTerms) {
    const prefix = exactKeys.posting({
      project: posting.project,
      caseMode: "exact",
      term,
      bucket: posting.bucket,
      documentId: posting.documentId,
      version: posting.documentVersion,
      generation: posting.generation,
      windowOrdinal: posting.windowOrdinal,
    }).slice(0, -1);
    const candidates = store.scan(prefix, { limit: 1_024, fillCache: false });
    for (const candidate of candidates) {
      const canonical = isPostingBlock(candidate.payload)
        ? decodeExactPostingBlock(candidate.payload)
        : candidate.payload;
      if (!canonical || canonical.caseMode !== "exact"
        || canonical.bucket !== posting.bucket
        || canonical.documentId !== posting.documentId
        || canonical.documentVersion !== posting.documentVersion
        || canonical.generation !== posting.generation
        || canonical.windowOrdinal !== posting.windowOrdinal
        || !Array.isArray(canonical.matches)) {
        continue;
      }
      let referenced = false;
      for (const match of canonical.matches) {
        const identity = matchIdentity(match);
        if (!uncovered.has(identity)) continue;
        uncovered.delete(identity);
        referenced = true;
      }
      if (referenced) targets.set(candidate.keyBytes.toString("base64url"), candidate.keyBytes);
    }
  }
  if (uncovered.size > 0 || targets.size === 0) return undefined;
  return [...targets.values()];
}

/**
 * Replace folded exact posting copies with binary locators to canonical exact
 * postings. A locator may reference multiple case-distinct canonical groups.
 * Legacy folded records whose canonical partner was already removed remain
 * self-contained and readable; the migration reports them as unresolved
 * instead of discarding matches or blocking the rest of the cutover.
 */
export async function rewriteExactFoldedPostingLocators(store, {
  reportOnly = true,
  limit = POSTING_STORAGE_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const page = store.scan([KEYSPACE.EXACT], {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const folded = page.filter((record) => record.key[2] === "folded");
  const measured = await rewriteRecords(store, folded, async (record) => {
    const targets = await exactCanonicalTargets(store, record);
    if (targets === undefined) return undefined;
    return {
      kind: "exact-folded-posting-locator",
      payload: encodePostingLocator(
        POSTING_LOCATOR_KIND.EXACT_FOLDED,
        targets,
      ),
    };
  }, reportOnly, isPostingLocator);
  return Object.freeze({
    phase: "exact-folded-locators",
    reportOnly,
    scannedKeys: page.length,
    ...measured,
    complete: page.length < boundedLimit,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
  });
}

export async function rewriteExactCanonicalPostingBlocks(store, {
  reportOnly = true,
  limit = POSTING_STORAGE_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const page = store.scan([KEYSPACE.EXACT], {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const canonical = page.filter((record) => (
    record.key.length === 10
    && record.key[2] === "exact"
  ));
  const measured = await rewriteRecords(store, canonical, async (record) => ({
    kind: "exact-posting-block",
    payload: encodeExactPostingBlock(record.payload),
  }), reportOnly, isPostingBlock);
  return Object.freeze({
    phase: "exact-canonical-blocks",
    reportOnly,
    scannedKeys: page.length,
    ...measured,
    complete: page.length < boundedLimit,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
  });
}

function initialMigrationState(now, rollbackGraceMs) {
  return Object.freeze({
    migrationVersion: POSTING_STORAGE_MIGRATION_VERSION,
    status: "running",
    phase: "obsolete-namespaces",
    after: null,
    startedAt: now,
    updatedAt: now,
    rollbackGraceMs,
    scannedKeys: 0,
    rewrittenKeys: 0,
    unresolvedKeys: 0,
    deletedKeys: 0,
    logicalBytesSaved: 0,
  });
}

function assertMigrationState(value) {
  if (!value || value.migrationVersion !== POSTING_STORAGE_MIGRATION_VERSION
    || !["running", "grace", "complete"].includes(value.status)
    || !MIGRATION_PHASES.has(value.phase)
    || (value.after !== null && typeof value.after !== "string")
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("Posting storage migration state is malformed.");
  }
  if (value.verification !== undefined && (
    !value.verification || !Array.isArray(value.verification.samples)
    || VERIFICATION_COUNTERS.some((field) =>
      !Number.isSafeInteger(value.verification[field]) || value.verification[field] < 0)
    || !["documents", "assignments"].includes(value.verificationPhase)
    || !Number.isSafeInteger(value.verificationHighWatermark)
    || value.verificationHighWatermark < 0
  )) {
    throw new Error("Posting storage migration verification state is malformed.");
  }
  return value;
}

async function persistMigrationState(store, expected, next) {
  await store.get(STATE_KEY);
  return store.transaction(async (transaction) => {
    const current = await transaction.get(STATE_KEY);
    if (stableJson(current) !== stableJson(expected)) {
      throw new Error("Posting storage migration state changed concurrently.");
    }
    await transaction.put(STATE_KEY, next, { kind: "posting-storage-migration-state" });
    return next;
  });
}

function advancePage(state, result, nextPhase, now) {
  const complete = result.complete;
  return Object.freeze({
    ...state,
    phase: complete ? nextPhase : state.phase,
    after: complete ? null : result.nextAfter.toString("base64url"),
    updatedAt: now,
    scannedKeys: state.scannedKeys + result.scannedKeys,
    rewrittenKeys: state.rewrittenKeys + (result.rewrittenKeys ?? 0),
    unresolvedKeys: state.unresolvedKeys + (result.unresolvedKeys ?? 0),
    deletedKeys: state.deletedKeys + (result.deletedKeys ?? 0),
    logicalBytesSaved: state.logicalBytesSaved
      + (result.valueBytesSaved ?? 0)
      + (result.totalBytes ?? 0),
  });
}

function emptyCutoverVerification() {
  return Object.freeze({
    checked: 0,
    missingAssignments: 0,
    identityMismatches: 0,
    scopeMismatches: 0,
    retirementMismatches: 0,
    orphanLiveAssignments: 0,
    samples: Object.freeze([]),
  });
}

function mergeCutoverVerification(current, page) {
  const samples = [...current.samples];
  for (const sample of page.samples) {
    if (samples.length >= 10) break;
    samples.push(sample);
  }
  return Object.freeze({
    checked: current.checked + page.checked,
    missingAssignments: current.missingAssignments + page.missingAssignments,
    identityMismatches: current.identityMismatches + page.identityMismatches,
    scopeMismatches: current.scopeMismatches + page.scopeMismatches,
    retirementMismatches: current.retirementMismatches + page.retirementMismatches,
    orphanLiveAssignments: current.orphanLiveAssignments + page.orphanLiveAssignments,
    samples: Object.freeze(samples),
  });
}

function completeCutoverVerification(summary) {
  const mismatches = summary.missingAssignments
    + summary.identityMismatches
    + summary.scopeMismatches
    + summary.retirementMismatches
    + summary.orphanLiveAssignments;
  return Object.freeze({
    ...summary,
    ok: mismatches === 0,
    mismatches,
    truncated: false,
  });
}

async function publishQueryCutoverAfterVerification(
  store,
  verification,
  {
    now = Date.now(),
    rollbackGraceMs = DEFAULT_POSTING_ROLLBACK_GRACE_MS,
  } = {},
) {
  const verifiedAt = nonNegativeInteger(now, "now");
  const grace = nonNegativeInteger(rollbackGraceMs, "rollbackGraceMs");
  if (!verification.ok || verification.truncated) {
    const error = new Error("Posting query cutover requires a complete, mismatch-free derived-view verification.");
    error.code = "ERR_POSTING_CUTOVER_VERIFICATION";
    error.details = verification;
    throw error;
  }
  const marker = Object.freeze({
    cutoverVersion: POSTING_STORAGE_MIGRATION_VERSION,
    formatVersion: DERIVED_VIEW_FORMAT_VERSION,
    layout: DERIVED_VIEW_LAYOUT,
    verifiedAt,
    rollbackGraceUntil: verifiedAt + grace,
    checkedDocuments: verification.checked,
    verificationMismatches: verification.mismatches,
  });
  await store.put(derivedViewKeys.queryCutover(), marker, {
    kind: "posting-query-cutover",
  });
  return marker;
}

/**
 * Remove legacy document-to-derived-key references only after the verified
 * query cutover's rollback grace period has elapsed.
 */
export async function garbageCollectReverseCleanupReferences(store, {
  reportOnly = true,
  now = Date.now(),
  limit = POSTING_STORAGE_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const currentTime = nonNegativeInteger(now, "now");
  const cutover = await store.get(derivedViewKeys.queryCutover());
  if (!cutover || cutover.layout !== DERIVED_VIEW_LAYOUT
    || cutover.formatVersion !== DERIVED_VIEW_FORMAT_VERSION) {
    const error = new Error("Reverse-reference GC requires a verified posting query cutover.");
    error.code = "ERR_POSTING_CUTOVER_VERIFICATION";
    throw error;
  }
  if (!reportOnly && currentTime < cutover.rollbackGraceUntil) {
    return Object.freeze({
      phase: "rollback-grace",
      reportOnly,
      scannedKeys: 0,
      deletedKeys: 0,
      keyBytes: 0,
      valueBytes: 0,
      totalBytes: 0,
      complete: false,
      rollbackGraceUntil: cutover.rollbackGraceUntil,
    });
  }
  const page = store.scan([KEYSPACE.DERIVED, "document"], {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const measured = page.reduce((summary, record) => ({
    keyBytes: summary.keyBytes + record.keyBytes.length,
    valueBytes: summary.valueBytes + record.storedValueBytes,
    totalBytes: summary.totalBytes + record.keyBytes.length + record.storedValueBytes,
  }), { keyBytes: 0, valueBytes: 0, totalBytes: 0 });
  if (!reportOnly && page.length > 0) {
    for (let offset = 0; offset < page.length; offset += 256) {
      const batch = page.slice(offset, offset + 256);
      await store.transaction(async (transaction) => {
        const marker = await transaction.get(derivedViewKeys.queryCutover());
        if (stableJson(marker) !== stableJson(cutover)) {
          throw new Error("Posting query cutover changed during reverse-reference GC.");
        }
        for (const record of batch) await transaction.remove(record.keyBytes);
      });
    }
  }
  return Object.freeze({
    phase: "reverse-references",
    reportOnly,
    scannedKeys: page.length,
    deletedKeys: reportOnly ? 0 : page.length,
    ...measured,
    complete: page.length < boundedLimit,
    rollbackGraceUntil: cutover.rollbackGraceUntil,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
  });
}

/**
 * Advance one bounded, crash-resumable storage migration page. Mixed legacy
 * and locator records remain queryable throughout every phase.
 */
export async function runPostingStorageMaintenance(store, {
  now = Date.now(),
  limit = POSTING_STORAGE_PAGE_SIZE,
  rollbackGraceMs = DEFAULT_POSTING_ROLLBACK_GRACE_MS,
} = {}) {
  const currentTime = nonNegativeInteger(now, "now");
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const grace = nonNegativeInteger(rollbackGraceMs, "rollbackGraceMs");
  let state = await store.get(STATE_KEY);
  if (state === undefined) {
    state = initialMigrationState(currentTime, grace);
    await store.put(STATE_KEY, state, { kind: "posting-storage-migration-state" });
  } else {
    state = assertMigrationState(state);
  }
  if (state.status === "complete") return state;
  const after = state.after === null ? undefined : Buffer.from(state.after, "base64url");
  let next;
  if (state.phase === "obsolete-namespaces") {
    const result = await garbageCollectObsoleteIndexNamespaces(store, {
      reportOnly: false,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "bm25-session-locators", currentTime);
  } else if (state.phase === "bm25-session-locators") {
    const result = await rewriteBm25SessionPostingLocators(store, {
      reportOnly: false,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "bm25-canonical-blocks", currentTime);
  } else if (state.phase === "bm25-canonical-blocks") {
    const result = await rewriteBm25CanonicalPostingBlocks(store, {
      reportOnly: false,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "exact-folded-locators", currentTime);
  } else if (state.phase === "exact-folded-locators") {
    const result = await rewriteExactFoldedPostingLocators(store, {
      reportOnly: false,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "exact-canonical-blocks", currentTime);
  } else if (state.phase === "exact-canonical-blocks") {
    const result = await rewriteExactCanonicalPostingBlocks(store, {
      reportOnly: false,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "verify-cutover", currentTime);
  } else if (state.phase === "verify-cutover") {
    if (state.verification === undefined) {
      const outboxHighWatermark = await store.get(keyFor.counter("outbox")) ?? 0;
      next = Object.freeze({
        ...state,
        after: null,
        verificationPhase: "documents",
        verificationHighWatermark: nonNegativeInteger(
          outboxHighWatermark,
          "outbox high watermark",
        ),
        verification: emptyCutoverVerification(),
        updatedAt: currentTime,
      });
    } else {
      const verificationPhase = state.verificationPhase ?? "documents";
      const result = await verifyDerivedViewPage(store, {
        phase: verificationPhase,
        limit: boundedLimit,
        after,
      });
      const verification = mergeCutoverVerification(state.verification, result);
      if (!result.complete) {
        next = Object.freeze({
          ...state,
          after: result.nextAfter.toString("base64url"),
          verification,
          updatedAt: currentTime,
          scannedKeys: state.scannedKeys + result.scanned,
        });
      } else if (verificationPhase === "documents") {
        next = Object.freeze({
          ...state,
          after: null,
          verificationPhase: "assignments",
          verification,
          updatedAt: currentTime,
          scannedKeys: state.scannedKeys + result.scanned,
        });
      } else {
        const outboxHighWatermark = await store.get(keyFor.counter("outbox")) ?? 0;
        if (outboxHighWatermark !== state.verificationHighWatermark) {
          next = Object.freeze({
            ...state,
            after: null,
            verificationPhase: "documents",
            verificationHighWatermark: nonNegativeInteger(
              outboxHighWatermark,
              "outbox high watermark",
            ),
            verification: emptyCutoverVerification(),
            verificationRestarts: (state.verificationRestarts ?? 0) + 1,
            updatedAt: currentTime,
            scannedKeys: state.scannedKeys + result.scanned,
          });
        } else {
          const completedVerification = completeCutoverVerification(verification);
          const cutover = await publishQueryCutoverAfterVerification(
            store,
            completedVerification,
            {
              now: currentTime,
              rollbackGraceMs: state.rollbackGraceMs,
            },
          );
          next = Object.freeze({
            ...state,
            status: "grace",
            phase: "rollback-grace",
            after: null,
            verification: completedVerification,
            verifiedAt: cutover.verifiedAt,
            rollbackGraceUntil: cutover.rollbackGraceUntil,
            updatedAt: currentTime,
            scannedKeys: state.scannedKeys + result.scanned,
          });
        }
      }
    }
  } else if (state.phase === "rollback-grace") {
    if (currentTime < state.rollbackGraceUntil) return state;
    next = Object.freeze({
      ...state,
      status: "running",
      phase: "reverse-references",
      after: null,
      updatedAt: currentTime,
    });
  } else if (state.phase === "reverse-references") {
    const result = await garbageCollectReverseCleanupReferences(store, {
      reportOnly: false,
      now: currentTime,
      limit: boundedLimit,
      after,
    });
    next = advancePage(state, result, "complete", currentTime);
    if (next.phase === "complete") {
      next = Object.freeze({ ...next, status: "complete", completedAt: currentTime });
    }
  } else {
    throw new Error(`Unknown posting storage migration phase ${state.phase}.`);
  }
  return persistMigrationState(store, state, next);
}
