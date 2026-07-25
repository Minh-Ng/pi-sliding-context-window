import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactDeletionWave, evacuateLiveValues } from "../src/rocksdb/compaction.js";
import {
  auxiliaryOwnershipIndexKeys,
  ensureAuxiliaryOwnershipIndex,
} from "../src/rocksdb/auxiliary-ownership.js";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler, lookupExact } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler, lookupStructural } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { bumpGuard, guardKeys } from "../src/rocksdb/guards.js";
import { cleanupPublishedStage, outboxKeys } from "../src/rocksdb/outbox.js";
import {
  admitDocument,
  deterministicManifestId,
  manifestKeys,
  readCanonicalDocument,
} from "../src/rocksdb/manifests.js";
import {
  cleanupExpiredTombstoneMetadata,
  cleanupExpiredProtections,
  DEFAULT_TOMBSTONE_AUDIT_MS,
  isDocumentProtected,
  pinDocument,
  protectEvidence,
  recordDocumentAccess,
  releaseProtection,
  renewDocumentExpiry,
  retentionKeys,
  retentionStatus,
  runRetention,
  setEmergencyMode,
  unpinDocument,
} from "../src/rocksdb/retention.js";
import {
  MAX_ROCKSDB_PERSISTED_KEY_BYTES,
  RocksStore,
  StoreKeySizeError,
} from "../src/rocksdb/store.js";
import { keyFor, KEYSPACE } from "../src/rocksdb/keys.js";
import {
  createRetrievalLease,
  hasActiveDocumentLease,
  leaseKeys,
} from "../src/retrieval/leases.js";
import {
  documentRecallCount,
  recallCounterName,
  recordRecalledLocator,
  recordShownResults,
} from "../src/retrieval/relevance-feedback.js";
import { MAX_PROTECTED_DOCUMENT_VERSIONS } from "../src/store/store-contract.js";

const protectMemoryFixture = new URL("../test-support/protect-memory-child.js", import.meta.url);
const MAX_PROTECT_RSS_BYTES = 256 * 1_024 * 1_024;

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function document(id, overrides = {}) {
  return {
    documentId: id,
    version: overrides.version ?? 1,
    sourceKey: overrides.sourceKey ?? `user:${id}`,
    sessionId: overrides.sessionId ?? "session-main",
    project: overrides.project ?? "/workspace/retention",
    kind: overrides.kind ?? "turn",
    createdAt: overrides.createdAt ?? 10,
    text: overrides.text ?? `Where is RETAIN_${id.toUpperCase()} evidence?`,
    metadata: { turnId: `turn-${id}`, ...(overrides.metadata ?? {}) },
    sourceMessageKeys: overrides.sourceMessageKeys ?? [overrides.sourceKey ?? `user:${id}`],
  };
}

async function admit(store, candidate, expiresAt, options = {}) {
  const request = {
    idempotencyKey: options.idempotencyKey
      ?? `retention:${candidate.documentId}:${candidate.version}`,
    document: candidate,
    structuralMessages: options.structuralMessages ?? [{
      messageKey: candidate.sourceKey,
      messageIndex: 0,
      role: "user",
      createdAt: candidate.createdAt,
      text: candidate.text,
      questionScore: 100,
      requestScore: 10,
      correctionScore: 0,
      answerScore: 0,
    }],
    retentionClass: options.retentionClass ?? "conversation-source",
    expiresAt,
  };
  if (options.protect !== undefined) request.protect = options.protect;
  return admitDocument(store, request, {
    chunking: { maxChunkBytes: options.maxChunkBytes ?? 32, minLineSplitBytes: 0 },
    windows: { windowTokens: options.windowTokens ?? 5, overlapTokens: 1 },
  });
}

async function indexAll(store) {
  const worker = new IndexWorker(store, {
    workerId: "retention-indexer",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createStructuralIndexHandler()],
  });
  return worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });
}

function retentionRequest(now, overrides = {}) {
  return { now, force: false, batchSize: 100, ...overrides };
}

test("expiry tombstones first and removes canonical plus derived records", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-expiry"));
  t.after(() => store.close());
  const candidate = document("expired", { text: "Where is RETAIN_EXPIRED evidence?" });
  await admit(store, candidate, 100);
  await indexAll(store);
  assert.equal((await lookupExact(store, {
    query: "RETAIN_EXPIRED",
    project: candidate.project,
    scope: "session",
    sessionId: candidate.sessionId,
  })).results.length, 1);

  const result = await runRetention(store, retentionRequest(200));
  assert.equal(result.tombstoned, 1);
  assert.ok(result.deletedKeys > 0);
  assert.equal(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
  const tombstone = await store.get(["supersession", candidate.documentId, 1]);
  assert.equal(tombstone.status, "expired");
  assert.match(tombstone.reason, /conversation-source/u);
  await assert.rejects(admitDocument(store, {
    idempotencyKey: "retention:expired:resurrection-before-tombstone-gc",
    document: { ...candidate, text: "resurrected before tombstone GC" },
    structuralMessages: [],
    retentionClass: "conversation-source",
  }), (error) => error.code === "EXPIRED");
  assert.equal(store.scan(["exact"]).some(({ payload }) => payload.documentId === candidate.documentId), false);
  assert.equal(store.scan(["relation"]).some(({ payload }) => payload.documentId === candidate.documentId), false);
  assert.equal(store.scan([KEYSPACE.EVENT]).length, 0);
  assert.equal(store.scan([KEYSPACE.EVENT_REFERENCE]).length, 0);
  assert.equal(lookupStructural(store, {
    relation: "latest-question",
    project: candidate.project,
    sessionId: candidate.sessionId,
  }).status, "not-found");
  assert.deepEqual(await runRetention(store, retentionRequest(200)), {
    status: "complete",
    scanned: 0,
    tombstoned: 0,
    deletedKeys: 0,
    protected: 0,
  });
});

test("retention deletes the durable recall counter alongside the canonical document", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-recall-counter"));
  t.after(() => store.close());
  const candidate = document("recalled");
  await admit(store, candidate, 100);
  await indexAll(store);

  // Reproduce the durable per-document recall tally the way relevance
  // feedback's join records it (see relevance-feedback.test.js): a shown
  // result, then a resolved recall of that shown locator.
  const locator = "cw1.retention-recall-counter.fixture";
  await recordShownResults(store, {
    project: candidate.project,
    query: "RETAIN_RECALLED",
    mode: "lexical",
    status: "resolved",
    results: [{
      documentId: candidate.documentId,
      version: 1,
      locator,
      retrievalMode: "lexical",
      score: 1,
      rawScore: 1,
    }],
    now: 50,
  });
  await recordRecalledLocator(store, { project: candidate.project, locator, status: "resolved", now: 60 });

  const counterKey = keyFor.counter(recallCounterName(candidate.project, candidate.documentId, 1));
  assert.equal(
    await documentRecallCount(store, { project: candidate.project, documentId: candidate.documentId, version: 1 }),
    1,
  );
  assert.notEqual(await store.get(counterKey), undefined);

  await runRetention(store, retentionRequest(200));
  assert.equal(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
  // The durable recall counter is a plain local counter, not a registered
  // derived reference, so it must be deleted explicitly alongside the
  // canonical document — otherwise dead per-document counter keys
  // accumulate unboundedly across retention cycles.
  assert.equal(await store.get(counterKey), undefined);
});

test("retention defers canonical deletion when bounded index publication is incomplete", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-index-backlog"));
  t.after(() => store.close());
  const candidate = document("index-backlog");
  await admit(store, candidate, 100);
  await indexAll(store);

  const partial = await runRetention(store, retentionRequest(200), {
    publishIndexDelete: async () => false,
  });
  assert.equal(partial.status, "more-work");
  assert.equal(partial.tombstoned, 1);
  assert.notEqual(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
  assert.equal((await lookupExact(store, {
    query: "RETAIN_INDEX-BACKLOG",
    project: candidate.project,
    scope: "session",
    sessionId: candidate.sessionId,
  })).results.length, 0);

  const resumed = await runRetention(store, retentionRequest(200));
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.tombstoned, 0);
  assert.ok(resumed.deletedKeys > 0);
  assert.equal(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
});

test("retention resumes canonical cleanup after delete publication history is pruned", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-pruned-delete-state"));
  t.after(() => store.close());
  const candidate = document("pruned-delete-state", {
    text: Array.from({ length: 80 }, (_, ordinal) => `RETAIN_PRUNED_${ordinal}`).join(" "),
  });
  await admit(store, candidate, 100, { windowTokens: 2 });
  await indexAll(store);

  const partial = await runRetention(store, retentionRequest(200), { workLimit: 3 });
  assert.equal(partial.status, "more-work");
  assert.equal(partial.tombstoned, 1);
  assert.notEqual(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
  const cleanup = await store.get(retentionKeys.cleanup(candidate.documentId, 1));
  const deleteSequence = cleanup.deleteOutboxSequence;
  assert.equal((await store.get(outboxKeys.state(deleteSequence))).status, "processed");

  const later = document("later-publication");
  await admit(store, later, 10_000);
  const indexed = await indexAll(store);
  const laterPublication = indexed.publications.at(-1);
  await cleanupPublishedStage(store, laterPublication.generation, { retainPublications: 1 });
  assert.equal(await store.get(outboxKeys.state(deleteSequence)), undefined);
  assert.ok((await store.get(outboxKeys.cursor())).nextSequence > deleteSequence);

  const resumed = await runRetention(store, retentionRequest(200), { workLimit: 64 });
  assert.ok(resumed.deletedKeys > 0);
  let result = resumed;
  for (let wave = 0; result.status !== "complete" && wave < 20; wave += 1) {
    result = await runRetention(store, retentionRequest(200), { workLimit: 64 });
  }
  assert.equal(result.status, "complete");
  assert.equal(await readCanonicalDocument(store, candidate.documentId, 1), undefined);
});

test("terminal tombstone GC keeps one durable ledger and rejects retired-version resurrection", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-history-ledger"));
  t.after(() => store.close());
  const candidate = document("history-ledger");
  await admit(store, candidate, 100);
  await admit(store, candidate, 100, {
    idempotencyKey: "retention:history-ledger:reindex",
  });
  assert.equal(store.scan(
    manifestKeys.documentAdmissionReferencePrefix(candidate.documentId, 1),
  ).length, 2);
  await runRetention(store, retentionRequest(200));
  assert.equal(store.scan(
    manifestKeys.documentAdmissionReferencePrefix(candidate.documentId, 1),
  ).length, 0);
  assert.equal(await store.get([KEYSPACE.META, KEYSPACE.IDEMPOTENCY,
    "retention:history-ledger:reindex"]), undefined);

  const historyKey = manifestKeys.documentHistory(candidate.documentId);
  assert.deepEqual(await store.get(historyKey), {
    documentHistoryFormatVersion: 1,
    documentId: candidate.documentId,
    project: candidate.project,
    highestAdmittedVersion: 1,
    retiredThrough: 1,
  });
  const cleanup = await store.get(retentionKeys.cleanup(candidate.documentId, 1));
  assert.equal(cleanup.status, "complete");

  const terminal = await cleanupExpiredTombstoneMetadata(store, {
    now: 200 + DEFAULT_TOMBSTONE_AUDIT_MS,
    workLimit: 5,
  });
  assert.equal(terminal.removed, 1);
  assert.equal(await store.get([KEYSPACE.SUPERSESSION, candidate.documentId, 1]), undefined);
  assert.equal(await store.get(retentionKeys.cleanup(candidate.documentId, 1)), undefined);
  assert.equal(store.scan(retentionKeys.auditExpiryPrefix()).length, 0);
  assert.equal((await store.get(historyKey)).retiredThrough, 1);

  await assert.rejects(admitDocument(store, {
    idempotencyKey: "retention:history-ledger:resurrection",
    document: { ...candidate, text: "resurrected bytes" },
    structuralMessages: [],
    retentionClass: "conversation-source",
  }), (error) => error.code === "EXPIRED");
});

test("content-addressed chunks remain until their final manifest reference expires", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-shared-chunk"));
  t.after(() => store.close());
  const text = "identical shared physical chunk";
  const first = document("first", { text });
  const second = document("second", { text, sessionId: "session-second" });
  await admit(store, first, 100, { maxChunkBytes: 128 });
  await admit(store, second, 1_000, { maxChunkBytes: 128 });
  const manifest = await store.get(manifestKeys.document(first.documentId, 1));
  const chunkId = manifest.chunks[0].chunkId;
  assert.equal(store.scan(manifestKeys.chunkReferencePrefix(chunkId)).length, 2);

  await runRetention(store, retentionRequest(200));
  assert.ok(await store.get(manifestKeys.chunk(chunkId)));
  assert.equal(store.scan(manifestKeys.chunkReferencePrefix(chunkId)).length, 1);
  assert.equal((await readCanonicalDocument(store, second.documentId, 1)).text, text);

  await runRetention(store, retentionRequest(2_000));
  assert.equal(await store.get(manifestKeys.chunk(chunkId)), undefined);
  assert.equal(store.scan(manifestKeys.chunkReferencePrefix(chunkId)).length, 0);
});

test("shared tool metadata remains until its final owning document expires", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-shared-tool-manifest"));
  t.after(() => store.close());
  const shared = {
    kind: "tool-result",
    sessionId: "shared-tool-session",
    project: "/workspace/shared-tool",
    createdAt: 10,
    text: "same body",
    metadata: { toolCallId: "shared-call", parentTurnIds: ["shared-turn"] },
  };
  const first = document("shared-tool-first", {
    ...shared,
    sourceKey: "tool:first",
  });
  const second = document("shared-tool-second", {
    ...shared,
    sourceKey: "tool:second",
  });
  await admit(store, first, 100);
  await admit(store, second, 10_000);
  await indexAll(store);

  const manifestId = deterministicManifestId(
    "tool-result",
    shared.project,
    shared.sessionId,
    shared.metadata.toolCallId,
  );
  const sharedKey = manifestKeys.toolResult(manifestId, 1);
  const referencePrefix = manifestKeys.auxiliaryManifestReferencePrefix(
    "tool-result",
    manifestId,
    1,
  );
  assert.notEqual(await store.get(sharedKey), undefined);
  assert.equal(store.scan(referencePrefix).length, 2);

  assert.equal((await runRetention(store, retentionRequest(200))).status, "complete");
  assert.equal(await readCanonicalDocument(store, first.documentId, 1), undefined);
  assert.notEqual(await readCanonicalDocument(store, second.documentId, 1), undefined);
  assert.notEqual(await store.get(sharedKey), undefined);
  assert.equal(store.scan(referencePrefix).length, 1);

  assert.equal((await runRetention(store, retentionRequest(10_000))).status, "complete");
  assert.equal(await readCanonicalDocument(store, second.documentId, 1), undefined);
  assert.equal(await store.get(sharedKey), undefined);
  assert.equal(store.scan(referencePrefix).length, 0);
});

test("managed owner expiry preserves metadata still owned by a legacy manifest", async (t) => {
  const path = temporaryStorePath(t, "retention-mixed-owner-version");
  let store = await RocksStore.open(path);
  t.after(() => store.close());
  const shared = {
    kind: "tool-result",
    sessionId: "mixed-owner-session",
    project: "/workspace/mixed-owner",
    createdAt: 10,
    text: "mixed owner body",
    metadata: { toolCallId: "mixed-owner-call", parentTurnIds: ["mixed-owner-turn"] },
  };
  const legacy = document("mixed-owner-legacy", {
    ...shared,
    sourceKey: "tool:mixed-owner-legacy",
  });
  await admit(store, legacy, 10_000);

  const legacyKey = manifestKeys.document(legacy.documentId, 1);
  const current = await store.get(legacyKey);
  const { auxiliaryManifestReference, ...legacyManifest } = current;
  const legacyReferenceKey = manifestKeys.auxiliaryManifestReference(
    auxiliaryManifestReference.kind,
    auxiliaryManifestReference.manifestId,
    auxiliaryManifestReference.version,
    legacy.documentId,
    1,
  );
  await store.transaction(async (transaction) => {
    await transaction.put(legacyKey, legacyManifest, { kind: "legacy-document-fixture" });
    await transaction.remove(legacyReferenceKey);
    await transaction.remove(guardKeys.auxiliaryManifest(
      auxiliaryManifestReference.kind,
      auxiliaryManifestReference.manifestId,
      auxiliaryManifestReference.version,
    ));
    // A pre-owner-index store has no completion marker. Reopening must backfill
    // its legacy owner before any current admission or retention can run.
    await transaction.remove(auxiliaryOwnershipIndexKeys.state());
  });

  store.close();
  store = await RocksStore.open(path);

  const managed = document("mixed-owner-managed", {
    ...shared,
    sourceKey: "tool:mixed-owner-managed",
  });
  await admit(store, managed, 100);
  const sharedKey = manifestKeys.toolResult(auxiliaryManifestReference.manifestId, 1);
  const referencePrefix = manifestKeys.auxiliaryManifestReferencePrefix(
    "tool-result",
    auxiliaryManifestReference.manifestId,
    1,
  );
  assert.equal(store.scan(referencePrefix).length, 2);

  assert.equal((await runRetention(store, retentionRequest(200))).status, "complete");
  assert.equal(await readCanonicalDocument(store, managed.documentId, 1), undefined);
  assert.notEqual(await readCanonicalDocument(store, legacy.documentId, 1), undefined);
  assert.notEqual(await store.get(sharedKey), undefined);
  assert.equal(store.scan(referencePrefix).length, 1);

  assert.equal((await runRetention(store, retentionRequest(10_000))).status, "complete");
  assert.equal(await readCanonicalDocument(store, legacy.documentId, 1), undefined);
  assert.equal(await store.get(sharedKey), undefined);
  assert.equal(store.scan(referencePrefix).length, 0);
});

test("legacy turn ownership backfill resumes after a committed page", async (t) => {
  const path = temporaryStorePath(t, "retention-owner-backfill-resume");
  let store = await RocksStore.open(path);
  t.after(() => store.close());
  const fixtures = [];
  for (let index = 0; index < 65; index += 1) {
    const candidate = document(`legacy-turn-${String(index).padStart(2, "0")}`, {
      metadata: { turnId: `legacy-turn-id-${index}` },
    });
    await admit(store, candidate, index === 0 ? 100 : 100_000);
    const documentKey = manifestKeys.document(candidate.documentId, 1);
    const current = await store.get(documentKey);
    const { auxiliaryManifestReference, ...legacyManifest } = current;
    fixtures.push({ candidate, documentKey, legacyManifest, auxiliaryManifestReference });
  }
  await store.transaction(async (transaction) => {
    for (const fixture of fixtures) {
      const reference = fixture.auxiliaryManifestReference;
      await transaction.put(fixture.documentKey, fixture.legacyManifest, {
        kind: "legacy-document-fixture",
      });
      await transaction.remove(manifestKeys.auxiliaryManifestReference(
        reference.kind,
        reference.manifestId,
        reference.version,
        fixture.candidate.documentId,
        1,
      ));
      await transaction.remove(guardKeys.auxiliaryManifest(
        reference.kind,
        reference.manifestId,
        reference.version,
      ));
    }
    await transaction.remove(auxiliaryOwnershipIndexKeys.state());
  });

  const originalTransaction = store.transaction.bind(store);
  let interrupted = false;
  store.transaction = async (...arguments_) => {
    const result = await originalTransaction(...arguments_);
    const state = await store.get(auxiliaryOwnershipIndexKeys.state());
    if (!interrupted && state?.status === "indexing" && state.indexedOwners === 64) {
      interrupted = true;
      throw new Error("simulated owner-index upgrade crash");
    }
    return result;
  };
  try {
    await assert.rejects(
      ensureAuxiliaryOwnershipIndex(store),
      /simulated owner-index upgrade crash/u,
    );
  } finally {
    store.transaction = originalTransaction;
  }
  assert.equal(interrupted, true);
  assert.equal((await store.get(auxiliaryOwnershipIndexKeys.state())).indexedOwners, 64);

  store.close();
  store = await RocksStore.open(path);
  assert.deepEqual(await store.get(auxiliaryOwnershipIndexKeys.state()), {
    formatVersion: 1,
    status: "complete",
    after: null,
    indexedOwners: 65,
  });
  for (const fixture of fixtures) {
    const reference = fixture.auxiliaryManifestReference;
    assert.notEqual(await store.get(manifestKeys.auxiliaryManifestReference(
      reference.kind,
      reference.manifestId,
      reference.version,
      fixture.candidate.documentId,
      1,
    )), undefined);
  }

  const first = fixtures[0];
  assert.equal((await runRetention(store, retentionRequest(200))).status, "complete");
  assert.equal(await store.get(manifestKeys.turn(
    first.auxiliaryManifestReference.manifestId,
    first.auxiliaryManifestReference.version,
  )), undefined);
});

test("shared source-message identities remain until their final document expires", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-shared-source"));
  t.after(() => store.close());
  const sourceKey = "user:shared-source";
  const first = document("source-first", { sourceKey, sourceMessageKeys: [sourceKey] });
  const second = document("source-second", { sourceKey, sourceMessageKeys: [sourceKey] });
  await admit(store, first, 100);
  await admit(store, second, 1_000);
  const eventKey = manifestKeys.sourceMessage(first.project, first.sessionId, sourceKey);
  const references = manifestKeys.sourceMessageReferencePrefix(first.project, first.sessionId, sourceKey);
  assert.notEqual(await store.get(eventKey), undefined);
  assert.equal(store.scan(references).length, 2);

  await runRetention(store, retentionRequest(200));
  assert.notEqual(await store.get(eventKey), undefined);
  assert.equal(store.scan(references).length, 1);

  await runRetention(store, retentionRequest(2_000));
  assert.equal(await store.get(eventKey), undefined);
  assert.equal(store.scan(references).length, 0);
});

test("admission rejects lifecycle-unsafe keys before retention across restart", async (t) => {
  const path = temporaryStorePath(t, "retention-lifecycle-key-limit");
  let store = await RocksStore.open(path);
  t.after(() => store.close());
  const unsafeSourceKey = `user:${"x".repeat(4_000)}`;
  const unsafe = document("unsafe-source-key", {
    sourceKey: unsafeSourceKey,
    sourceMessageKeys: [unsafeSourceKey],
  });

  await assert.rejects(admit(store, unsafe, 100), (error) => {
    assert.equal(error instanceof StoreKeySizeError, true);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.details.boundary, "canonical key");
    assert.equal(error.details.maxBytes, MAX_ROCKSDB_PERSISTED_KEY_BYTES);
    return true;
  });
  assert.equal(store.scan([KEYSPACE.DOCUMENT]).length, 0);
  assert.equal(store.scan([KEYSPACE.EVENT]).length, 0);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 0);

  const safeSourceKey = `user:${"s".repeat(1_800)}`;
  const safe = document("safe-source-key", {
    sourceKey: safeSourceKey,
    sourceMessageKeys: [safeSourceKey],
  });
  await admit(store, safe, 100);
  await store.flush();
  store.close();

  store = await RocksStore.open(path);
  const retained = await runRetention(store, retentionRequest(200));
  assert.equal(retained.status, "complete");
  assert.equal(retained.tombstoned, 1);
  assert.equal(await readCanonicalDocument(store, safe.documentId, 1), undefined);
});

test("reference indexes authoritatively reclaim chunks and events beyond 10k legacy manifests", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-authoritative-references"));
  t.after(() => store.close());
  const sourceKey = "user:authoritative-reference";
  const candidate = document("legacy-expiring", {
    text: "legacy shared physical chunk",
    sourceKey,
    sourceMessageKeys: [sourceKey],
  });
  await admit(store, candidate, 100, { maxChunkBytes: 128 });
  const manifest = await store.get(manifestKeys.document(candidate.documentId, 1));
  const chunkId = manifest.chunks[0].chunkId;
  const eventKey = manifestKeys.sourceMessage(
    candidate.project,
    candidate.sessionId,
    sourceKey,
  );
  await store.transaction(async (transaction) => {
    for (let index = 0; index < 10_001; index += 1) {
      const documentId = `filler-${String(index).padStart(5, "0")}`;
      await transaction.put(manifestKeys.document(documentId, 1), {
        documentId,
        version: 1,
        chunks: [],
      }, { kind: "legacy-document-fixture" });
    }
    await transaction.put(manifestKeys.document("zz-legacy-reference", 1), {
      documentId: "zz-legacy-reference",
      version: 1,
      project: candidate.project,
      sessionId: candidate.sessionId,
      chunks: [{ chunkId }],
      sourceMessageKeys: [sourceKey],
    }, { kind: "legacy-document-fixture" });
  });

  await runRetention(store, retentionRequest(200));
  assert.equal(await store.get(manifestKeys.chunk(chunkId)), undefined);
  assert.equal(store.scan(manifestKeys.chunkReferencePrefix(chunkId)).length, 0);
  assert.equal(await store.get(eventKey), undefined);
  assert.equal(store.scan(manifestKeys.sourceMessageReferencePrefix(
    candidate.project,
    candidate.sessionId,
    sourceKey,
  )).length, 0);
});

test("pins, retrieval leases, session heartbeats, and admission protection win cleanup", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-protection"));
  t.after(() => store.close());
  const pinned = document("pinned");
  const leased = document("leased");
  const session = document("session", { sessionId: "session-protected" });
  const admitted = document("admitted");
  for (const candidate of [pinned, leased, session]) await admit(store, candidate, 100);
  await admit(store, admitted, 100, { protect: true });
  await pinDocument(store, {
    pinId: "pin-1",
    documentId: pinned.documentId,
    version: 1,
    reason: "durable user selection",
    now: 10,
  });
  await createRetrievalLease(store, {
    leaseId: "lease-1",
    documentId: leased.documentId,
    documentVersion: 1,
    now: 10,
    ttlMs: 1_000,
  });
  await protectEvidence(store, {
    ownerId: "client-1",
    sessionIds: [session.sessionId],
    documentVersions: [],
    ttlMs: 1_000,
  }, { now: 10 });

  const protectedRun = await runRetention(store, retentionRequest(200));
  assert.equal(protectedRun.protected, 4);
  for (const candidate of [pinned, leased, session, admitted]) {
    assert.ok(await store.get(manifestKeys.document(candidate.documentId, 1)));
  }
  assert.deepEqual(await pinDocument(store, {
    pinId: "pin-1",
    documentId: pinned.documentId,
    version: 1,
    reason: "durable user selection",
    now: 20,
  }), { status: "already-pinned", pinId: "pin-1" });
  assert.deepEqual(await unpinDocument(store, { pinId: "pin-1" }), {
    status: "unpinned",
    pinId: "pin-1",
  });
  assert.deepEqual(await releaseProtection(store, { ownerId: "client-1" }), { released: 1 });

  const afterExpiry = await runRetention(store, retentionRequest(2_000));
  assert.equal(afterExpiry.tombstoned, 3);
  assert.ok(await store.get(manifestKeys.document(admitted.documentId, 1)));
});

test("retention controls handle blob-backed manifests after restart", async (t) => {
  const path = temporaryStorePath(t, "retention-blob-manifest-restart");
  let store = await RocksStore.open(path);
  t.after(() => store.close());
  const candidate = document("blob-manifest-restart", {
    text: "BLOB_RETENTION_CONTROL ".repeat(16_384),
  });
  await admit(store, candidate, 1_000, {
    maxChunkBytes: 512 * 1_024,
    windowTokens: 1_000_000,
  });
  await store.flush();
  store.close();

  store = await RocksStore.open(path);
  assert.deepEqual(await pinDocument(store, {
    pinId: "blob-manifest-pin",
    documentId: candidate.documentId,
    version: 1,
    reason: "restart safety",
    now: 10,
  }), { status: "pinned", pinId: "blob-manifest-pin" });
  assert.equal((await protectEvidence(store, {
    ownerId: "blob-manifest-owner",
    sessionIds: [],
    documentVersions: [{ documentId: candidate.documentId, version: 1 }],
    ttlMs: 1_000,
  }, { now: 10, project: candidate.project })).protectedDocuments, 1);
  assert.equal((await renewDocumentExpiry(store, {
    documentId: candidate.documentId,
    version: 1,
    retentionClass: "conversation-source",
    expiresAt: 2_000,
    now: 20,
  })).expiresAt, 2_000);
});

test("protection is all-or-nothing when any requested document is invalid", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-protection-atomic"));
  t.after(() => store.close());
  const candidate = document("protection-atomic");
  await admit(store, candidate, 1_000);

  await assert.rejects(protectEvidence(store, {
    ownerId: "protection-atomic-owner",
    ttlMs: 1_000,
    sessionIds: [candidate.sessionId],
    documentVersions: [
      { documentId: candidate.documentId, version: 1 },
      { documentId: "missing-protection-target", version: 1 },
    ],
  }, { now: 10, project: candidate.project }), /Cannot protect missing/iu);

  assert.equal(await store.get(retentionKeys.protection("protection-atomic-owner")), undefined);
  assert.equal(store.scan(retentionKeys.protectionExpiryPrefix()).length, 0);
  assert.equal(store.scan(retentionKeys.protectionSessionPrefix(
    candidate.sessionId,
    candidate.project,
  )).length, 0);
  assert.equal(store.scan(retentionKeys.protectionDocumentPrefix(
    candidate.documentId,
    1,
  )).length, 0);
});

test("retirement between protection preflight and commit aborts every reference", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-protection-race"));
  t.after(() => store.close());
  const candidate = document("protection-race");
  await admit(store, candidate, 100);
  const transaction = store.transaction.bind(store);
  let injected = false;
  store.transaction = async (callback, options) => {
    if (!injected) {
      injected = true;
      await runRetention(store, retentionRequest(200));
    }
    return transaction(callback, options);
  };

  try {
    await assert.rejects(protectEvidence(store, {
      ownerId: "protection-race-owner",
      ttlMs: 1_000,
      sessionIds: [candidate.sessionId],
      documentVersions: [{ documentId: candidate.documentId, version: 1 }],
    }, { now: 10, project: candidate.project }), /Cannot protect missing/iu);
  } finally {
    store.transaction = transaction;
  }

  assert.equal(injected, true);
  assert.equal(await store.get(retentionKeys.protection("protection-race-owner")), undefined);
  assert.equal(store.scan(retentionKeys.protectionExpiryPrefix()).length, 0);
  assert.equal(store.scan(retentionKeys.protectionSessionPrefix(
    candidate.sessionId,
    candidate.project,
  )).length, 0);
  assert.equal(store.scan(retentionKeys.protectionDocumentPrefix(
    candidate.documentId,
    1,
  )).length, 0);
});

test("more than 10k secondary protection references stream without scan materialization", async () => {
  const referenceCount = 10_001;
  const manifest = {
    documentId: "popular-protection-document",
    version: 1,
    sessionId: "popular-protection-session",
    project: "/workspace/popular-protection",
  };
  const createView = (activeIndex) => {
    const iterateCalls = [];
    return {
      iterateCalls,
      scan(prefix) {
        const protectionScan = prefix.some((part) => typeof part === "string"
          && part.startsWith("protection-"));
        assert.equal(protectionScan, false, "secondary protections must not use array scans");
        return [];
      },
      *iterate(prefix, options) {
        assert.equal(prefix.some((part) => typeof part === "string"
          && part.startsWith("protection-")), true);
        assert.equal(options.fillCache, false);
        iterateCalls.push({ prefix, limit: options.limit });
        const start = options.after === undefined ? 0 : options.after.readUInt32BE(0) + 1;
        const end = Math.min(referenceCount, start + options.limit);
        for (let index = start; index < end; index += 1) {
          const keyBytes = Buffer.allocUnsafe(4);
          keyBytes.writeUInt32BE(index);
          yield {
            keyBytes,
            payload: { expiresAt: index === activeIndex ? 200 : 50 },
          };
        }
      },
    };
  };

  const active = createView(referenceCount - 1);
  assert.equal(await isDocumentProtected(active, manifest, { now: 100 }), true);
  assert.equal(active.iterateCalls.length, 2);

  const stale = createView(-1);
  assert.equal(await isDocumentProtected(stale, manifest, { now: 100 }), false);
  assert.equal(stale.iterateCalls.length, 6);
  assert.ok(stale.iterateCalls.every(({ limit }) => limit === 10_000));
});

test("max-count metadata-heavy protection stays below the daemon RSS gate", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-protect-memory-"));
  const storePath = join(directory, "archive.rocks");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (mode) => spawnSync(
    process.execPath,
    ["--expose-gc", protectMemoryFixture.pathname, mode, storePath],
    { encoding: "utf8", maxBuffer: 1 * 1_024 * 1_024, timeout: 120_000 },
  );

  const setup = run("setup");
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const measured = run("measure");
  assert.equal(measured.status, 0, measured.stderr || measured.stdout);
  const result = JSON.parse(measured.stdout);
  assert.equal(result.protectedDocuments, MAX_PROTECTED_DOCUMENT_VERSIONS);
  assert.equal(result.persistedDocuments, MAX_PROTECTED_DOCUMENT_VERSIONS);
  assert.ok(
    result.peakRss < MAX_PROTECT_RSS_BYTES,
    `peak RSS ${result.peakRss} exceeded ${MAX_PROTECT_RSS_BYTES}: ${JSON.stringify(result)}`,
  );
  t.diagnostic(`max-count protection RSS ${JSON.stringify(result)}`);
});

test("retention reclaims crashed-client protections and expired search leases", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-expired-heartbeats"));
  t.after(() => store.close());
  const protectedCandidate = document("crashed-protection");
  const leasedCandidate = document("expired-search-leases");
  await admit(store, protectedCandidate, 100);
  await admit(store, leasedCandidate, 1_000);
  for (let index = 0; index < 10; index += 1) {
    await protectEvidence(store, {
      ownerId: `crashed-owner-${index}`,
      ttlMs: 10,
      sessionIds: [protectedCandidate.sessionId],
      documentVersions: [{ documentId: protectedCandidate.documentId, version: 1 }],
    }, { now: 1, project: protectedCandidate.project });
    await createRetrievalLease(store, {
      ownerId: `search-${index}`,
      documentId: leasedCandidate.documentId,
      documentVersion: 1,
      now: 1,
      ttlMs: 10,
    });
  }
  assert.equal(store.scan(retentionKeys.protectionExpiryPrefix()).length, 10);
  assert.equal(store.scan(["lease", "by-id"]).length, 10);

  await runRetention(store, retentionRequest(100));
  assert.equal(store.scan(retentionKeys.protectionExpiryPrefix()).length, 0);
  assert.equal(store.scan(retentionKeys.protectionDocumentPrefix(
    protectedCandidate.documentId,
    1,
  )).length, 0);
  assert.equal(store.scan(retentionKeys.protectionSessionPrefix(
    protectedCandidate.sessionId,
    protectedCandidate.project,
  )).length, 0);
  assert.equal(store.scan(["lease", "by-id"]).length, 0);
  assert.equal(store.scan(["lease", "by-expiry"]).length, 0);
  assert.equal(store.scan(["lease", "by-document"]).length, 0);
  assert.equal(store.scan(["lease", "document-expiry"]).length, 0);
  assert.equal(await store.get(manifestKeys.document(protectedCandidate.documentId, 1)), undefined);
  assert.notEqual(await store.get(manifestKeys.document(leasedCandidate.documentId, 1)), undefined);
});

test("expiry generations make stale queue entries harmless", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-renew"));
  t.after(() => store.close());
  const candidate = document("renewed");
  await admit(store, candidate, 100);
  const renewal = await renewDocumentExpiry(store, {
    documentId: candidate.documentId,
    version: 1,
    retentionClass: "conversation-source",
    expiresAt: 1_000,
    now: 50,
  });
  assert.equal(renewal.generation, 1);
  const early = await runRetention(store, retentionRequest(200));
  assert.equal(early.tombstoned, 0);
  assert.ok(await store.get(manifestKeys.document(candidate.documentId, 1)));
  const due = await runRetention(store, retentionRequest(1_000));
  assert.equal(due.tombstoned, 1);
  assert.equal(await store.get(manifestKeys.document(candidate.documentId, 1)), undefined);
});

test("expiry renewal cannot acknowledge a document after tombstoning begins", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-renew-race"));
  t.after(() => store.close());
  const candidate = document("renew-race");
  await admit(store, candidate, 100);
  await indexAll(store);

  let tombstoned;
  const tombstonedPromise = new Promise((resolve) => { tombstoned = resolve; });
  let resumePublication;
  const publicationGate = new Promise((resolve) => { resumePublication = resolve; });
  const expiry = runRetention(store, retentionRequest(200), {
    async publishIndexDelete() {
      tombstoned();
      await publicationGate;
      const worker = new IndexWorker(store, {
        workerId: "retention-renew-race-delete",
        handlers: [createBm25IndexHandler()],
      });
      await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });
    },
  });
  await tombstonedPromise;

  await assert.rejects(renewDocumentExpiry(store, {
    documentId: candidate.documentId,
    version: 1,
    retentionClass: "conversation-source",
    expiresAt: 10_000,
    now: 201,
  }), /expired or superseded/u);
  assert.equal((await store.get(["supersession", candidate.documentId, 1])).status, "expired");

  resumePublication();
  await expiry;
  assert.equal(await store.get(retentionKeys.expiryCurrent(candidate.documentId, 1)), undefined);
});

test("bounded cleanup resumes after reopen without duplicating tombstones", async (t) => {
  const path = temporaryStorePath(t, "retention-resume");
  let store = await RocksStore.open(path);
  for (const id of ["one", "two"]) await admit(store, document(id), 100);
  const first = await runRetention(store, retentionRequest(200, { batchSize: 1 }));
  assert.equal(first.status, "more-work");
  assert.equal(first.tombstoned, 1);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const second = await runRetention(store, retentionRequest(200, { batchSize: 1 }));
  assert.equal(second.tombstoned, 1);
  assert.equal(store.scan(["supersession"]).length, 2);
  assert.equal((await retentionStatus(store, { now: 200 })).liveDocuments, 0);
});

test("a 5 MiB document cleanup is work-bounded and resumes across waves", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-large-document"));
  t.after(() => store.close());
  const line = `${"x".repeat(4_095)}\n`;
  const candidate = document("five-megabytes", { text: line.repeat(1_280) });
  assert.equal(Buffer.byteLength(candidate.text, "utf8"), 5 * 1024 * 1024);
  await admit(store, candidate, 100, {
    maxChunkBytes: 4_096,
    windowTokens: 10_000,
    structuralMessages: [],
  });
  await indexAll(store);
  const manifest = await store.get(manifestKeys.document(candidate.documentId, 1));
  const referencePrefix = manifestKeys.chunkReferencePrefix(manifest.chunks[0].chunkId);
  const referencesBefore = store.scan(referencePrefix, { limit: 100_000 }).length;
  assert.equal(referencesBefore, 1_280);

  const first = await runRetention(store, retentionRequest(200), { workLimit: 64 });
  const referencesAfterFirst = store.scan(referencePrefix, { limit: 100_000 }).length;
  assert.equal(first.status, "more-work");
  assert.equal(first.tombstoned, 1);
  assert.ok(first.deletedKeys <= 64);
  assert.ok(referencesAfterFirst > 0);
  assert.ok(referencesAfterFirst < referencesBefore);
  assert.equal(store.scan([KEYSPACE.EXPIRY]).length, 1);

  let final = first;
  let waves = 1;
  while (final.status !== "complete" && waves < 64) {
    final = await runRetention(store, retentionRequest(200), { workLimit: 64 });
    waves += 1;
  }
  assert.equal(final.status, "complete");
  assert.ok(waves > 1);
  assert.equal(store.scan(referencePrefix, { limit: 100_000 }).length, 0);
  assert.equal(await store.get(manifestKeys.chunk(manifest.chunks[0].chunkId)), undefined);
});

test("expired protection cleanup bounds one owner with 10k references", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-protection-work-limit"));
  t.after(() => store.close());
  const ownerId = "expired-owner-with-many-references";
  const sessionIds = Array.from({ length: 10_000 }, (_, index) => `session-${index}`);
  const protection = {
    retentionFormatVersion: 1,
    ownerId,
    issuedAt: 1,
    expiresAt: 10,
    sessionIds,
    documentVersions: [],
  };
  await store.transaction(async (transaction) => {
    await transaction.put(retentionKeys.protection(ownerId), protection, {
      kind: "retention-protection",
    });
    await transaction.put(retentionKeys.protectionExpiry(10, ownerId), {
      ownerId,
      expiresAt: 10,
    }, { kind: "retention-protection-expiry" });
    for (const sessionId of sessionIds) {
      await transaction.put(retentionKeys.protectionSession(sessionId, ownerId), {
        ownerId,
        expiresAt: 10,
      }, { kind: "retention-protection-session" });
    }
  });

  const first = await cleanupExpiredProtections(store, {
    now: 20,
    limit: 10,
    workLimit: 37,
  });
  assert.deepEqual(first, { scanned: 1, released: 0, work: 37, more: true });
  const sessionReferencePrefix = retentionKeys.protectionSession("probe", ownerId).slice(0, -2);
  assert.equal(store.scan(sessionReferencePrefix, {
    limit: 100_000,
  }).length, 9_963);
  assert.notEqual(await store.get(retentionKeys.protection(ownerId)), undefined);

  const completed = await cleanupExpiredProtections(store, {
    now: 20,
    limit: 10,
    workLimit: 100_000,
  });
  assert.deepEqual(completed, { scanned: 1, released: 1, work: 9_963, more: false });
  assert.equal(await store.get(retentionKeys.protection(ownerId)), undefined);
  assert.equal(store.scan(retentionKeys.protectionExpiryPrefix()).length, 0);
});

test("force shortens only unprotected ephemeral tool payloads while processing due work", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-force-policy"));
  t.after(() => store.close());
  const dueSource = document("due-source");
  const eligible = document("eligible-payload", {
    kind: "tool-result",
    metadata: { toolCallId: "eligible-call" },
  });
  const pinned = document("pinned-payload", {
    kind: "tool-result",
    metadata: { toolCallId: "pinned-call" },
  });
  const sourceTurn = document("ephemeral-source-turn");
  const durable = document("durable-future", {
    kind: "tool-result",
    metadata: { toolCallId: "durable-call" },
  });
  const active = document("active-future", {
    kind: "tool-result",
    metadata: { toolCallId: "active-call" },
  });
  await admit(store, dueSource, 50, { retentionClass: "conversation-source" });
  for (const candidate of [eligible, pinned, sourceTurn]) {
    await admit(store, candidate, 10_000, { retentionClass: "ephemeral-payload" });
  }
  await admit(store, durable, 10_000, { retentionClass: "durable-evidence" });
  await admit(store, active, 10_000, { retentionClass: "active-evidence" });
  await pinDocument(store, {
    pinId: "force-policy-pin",
    documentId: pinned.documentId,
    version: 1,
    reason: "must survive emergency shortening",
    now: 20,
  });

  const forced = await runRetention(
    store,
    retentionRequest(100, { force: true }),
    { allowEmergencyShortening: true },
  );
  assert.equal(forced.tombstoned, 2);
  assert.equal(await store.get(manifestKeys.document(dueSource.documentId, 1)), undefined);
  assert.equal(await store.get(manifestKeys.document(eligible.documentId, 1)), undefined);
  for (const candidate of [pinned, sourceTurn, durable, active]) {
    assert.notEqual(await store.get(manifestKeys.document(candidate.documentId, 1)), undefined);
  }
  assert.match(
    (await store.get([KEYSPACE.SUPERSESSION, eligible.documentId, 1])).reason,
    /Emergency retention shortened eligible ephemeral payload/u,
  );
  assert.equal(await store.get([KEYSPACE.SUPERSESSION, sourceTurn.documentId, 1]), undefined);
});

test("bounded emergency cleanup resumes normally after disk pressure clears and the store reopens", async (t) => {
  const path = temporaryStorePath(t, "retention-emergency-resume");
  let store = await RocksStore.open(path);
  const candidate = document("emergency-resume", {
    kind: "tool-result",
    metadata: { toolCallId: "emergency-resume-call" },
    text: Array.from(
      { length: 80 },
      (_, ordinal) => `EMERGENCY_RESUME_${ordinal}`,
    ).join(" "),
  });
  await admit(store, candidate, 10_000, {
    retentionClass: "ephemeral-payload",
    windowTokens: 2,
  });
  await indexAll(store);

  const partial = await runRetention(
    store,
    retentionRequest(100, { force: true, batchSize: 1 }),
    { allowEmergencyShortening: true, workLimit: 3 },
  );
  assert.equal(partial.status, "more-work");
  assert.equal(partial.tombstoned, 1);
  assert.equal(
    (await store.get([KEYSPACE.SUPERSESSION, candidate.documentId, 1])).status,
    "expired",
  );
  const immediate = await store.get(retentionKeys.expiryCurrent(candidate.documentId, 1));
  assert.equal(immediate.expiresAt, 100);
  assert.equal(immediate.retentionClass, "ephemeral-payload");
  assert.notEqual(await store.get(retentionKeys.expiry(
    100,
    "ephemeral-payload",
    candidate.documentId,
    1,
    immediate.generation,
  )), undefined);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  let resumed;
  for (let wave = 0; wave < 100; wave += 1) {
    resumed = await runRetention(
      store,
      retentionRequest(101, { batchSize: 1 }),
      { workLimit: 3 },
    );
    if (resumed.status === "complete") break;
  }
  assert.equal(resumed.status, "complete");
  assert.equal(
    (await store.get(retentionKeys.cleanup(candidate.documentId, 1))).status,
    "complete",
  );
  assert.equal(await store.get(manifestKeys.document(candidate.documentId, 1)), undefined);
  assert.equal(await store.get(retentionKeys.cleanupManifest(candidate.documentId, 1)), undefined);
  assert.equal(
    store.scan([KEYSPACE.EXPIRY])
      .some(({ payload }) =>
        payload?.documentId === candidate.documentId
        && payload.expiresAt <= 101),
    false,
  );
});

test("public force runs due cleanup without shortening configured lifetimes", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-public-force"));
  t.after(() => store.close());
  const due = document("public-force-due");
  const future = document("public-force-future", {
    kind: "tool-result",
    metadata: { toolCallId: "public-force-call" },
  });
  await admit(store, due, 50, { retentionClass: "conversation-source" });
  await admit(store, future, 10_000, { retentionClass: "ephemeral-payload" });

  const result = await runRetention(store, retentionRequest(100, { force: true }));

  assert.equal(result.tombstoned, 1);
  assert.equal(await store.get(manifestKeys.document(due.documentId, 1)), undefined);
  assert.notEqual(await store.get(manifestKeys.document(future.documentId, 1)), undefined);
});

test("a future-only expiry bucket completes without persisting a scan cursor", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-future-bucket"));
  t.after(() => store.close());
  await admit(store, document("future-only"), 7_200_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await runRetention(store, retentionRequest(100)), {
      status: "complete",
      scanned: 0,
      tombstoned: 0,
      deletedKeys: 0,
      protected: 0,
    });
    assert.equal(await store.get(retentionKeys.scanCursor("*", "*")), undefined);
  }
});

test("cleanup resumes after reopen when a bounded wave removed the canonical manifest", async (t) => {
  const path = temporaryStorePath(t, "retention-interrupted-cleanup");
  let store = await RocksStore.open(path);
  const candidate = document("interrupted");
  await admit(store, candidate, 100);
  const targetKey = manifestKeys.document(candidate.documentId, 1);
  for (let wave = 0; wave < 20 && await store.get(targetKey) !== undefined; wave += 1) {
    const partial = await runRetention(store, retentionRequest(200), { workLimit: 3 });
    assert.equal(partial.status, "more-work");
  }
  assert.equal(await store.get(targetKey), undefined);
  const partial = await store.get(retentionKeys.cleanup(candidate.documentId, 1));
  const cleanupManifest = await store.get(retentionKeys.cleanupManifest(candidate.documentId, 1));
  assert.equal(partial.status, "tombstoned");
  assert.equal(cleanupManifest.documentId, candidate.documentId);
  assert.equal(store.scan(["expiry"]).length, 1);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  let resumed;
  for (let wave = 0; wave < 20; wave += 1) {
    resumed = await runRetention(store, retentionRequest(200), { workLimit: 3 });
    if (resumed.status === "complete") break;
  }
  assert.equal(resumed.status, "complete");
  assert.equal((await store.get(retentionKeys.cleanup(candidate.documentId, 1))).status, "complete");
  assert.equal(await store.get(retentionKeys.cleanupManifest(candidate.documentId, 1)), undefined);
  assert.equal(store.scan(["expiry"]).length, 0);
  assert.equal(store.scan(manifestKeys.chunkReferencePrefix(
    cleanupManifest.chunks[0].chunkId,
  )).length, 0);
});

test("a concurrent pin and expiry serialize to one valid outcome", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-pin-race"));
  t.after(() => store.close());
  for (let index = 0; index < 8; index += 1) {
    const candidate = document(`pin-race-${index}`);
    await admit(store, candidate, 100);
    const [pin, expiry] = await Promise.allSettled([
      pinDocument(store, {
        pinId: `pin-race-${index}`,
        documentId: candidate.documentId,
        version: 1,
        reason: "concurrency regression",
        now: 200,
      }),
      runRetention(store, retentionRequest(200, { batchSize: 1 })),
    ]);
    assert.equal(expiry.status, "fulfilled");
    if (pin.status === "fulfilled") {
      assert.ok(await store.get(manifestKeys.document(candidate.documentId, 1)));
      assert.equal(await store.get(["supersession", candidate.documentId, 1]), undefined);
    } else {
      assert.match(pin.reason.message, /expired|superseded/u);
      assert.equal(await store.get(manifestKeys.document(candidate.documentId, 1)), undefined);
      assert.equal((await store.get(["supersession", candidate.documentId, 1])).status, "expired");
    }
  }
});

test("shared chunk admission and final-reference deletion serialize safely", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-admission-race"));
  t.after(() => store.close());
  for (let index = 0; index < 8; index += 1) {
    const text = `shared admission race payload ${index}`;
    const expiring = document(`old-shared-${index}`, { text });
    const admitted = document(`new-shared-${index}`, { text, sessionId: `new-session-${index}` });
    await admit(store, expiring, 100, { maxChunkBytes: 128 });
    const [admission, expiry] = await Promise.allSettled([
      admit(store, admitted, 10_000, { maxChunkBytes: 128 }),
      runRetention(store, retentionRequest(200, { batchSize: 1 })),
    ]);
    assert.equal(admission.status, "fulfilled");
    assert.equal(expiry.status, "fulfilled");
    assert.equal((await readCanonicalDocument(store, admitted.documentId, 1)).text, text);
  }
});

test("shared chunk admission restores payload deleted after its durable pre-read", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-admission-pre-read-race"));
  t.after(() => store.close());
  const text = "shared payload deleted between admission classification and commit";
  const expiring = document("old-pre-read-shared", { text });
  const admitted = document("new-pre-read-shared", {
    text,
    sessionId: "new-pre-read-session",
    sourceKey: "user:new-pre-read-shared",
  });
  await admit(store, expiring, 100, { maxChunkBytes: 128 });

  const oldManifest = await store.get(manifestKeys.document(expiring.documentId, 1));
  const [{ chunkId }] = oldManifest.chunks;
  const chunkKey = manifestKeys.chunk(chunkId);
  const oldReferenceKey = manifestKeys.chunkReference(chunkId, expiring.documentId, 1, 0);
  const originalTransaction = store.database.transaction.bind(store.database);
  let armed = true;
  store.database.transaction = (callback, options) => originalTransaction(async (...arguments_) => {
    const result = await callback(...arguments_);
    if (armed) {
      armed = false;
      await store.transaction(async (transaction) => {
        const guard = guardKeys.chunk(chunkId);
        await bumpGuard(transaction, guard);
        await transaction.remove(oldReferenceKey);
        await transaction.remove(chunkKey);
        await transaction.remove(guard);
      });
    }
    return result;
  }, options);

  try {
    const result = await admit(store, admitted, 10_000, { maxChunkBytes: 128 });
    assert.equal(result.status, "stored");
  } finally {
    store.database.transaction = originalTransaction;
  }

  assert.equal(armed, false);
  assert.ok(await store.get(chunkKey));
  assert.ok(await store.get(manifestKeys.chunkReference(chunkId, admitted.documentId, 1, 0)));
  assert.equal((await readCanonicalDocument(store, admitted.documentId, 1)).text, text);
});

test("a protected head entry does not starve later expiry work", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-starvation"));
  t.after(() => store.close());
  const protectedCandidate = document("a-protected-head");
  const actionable = document("z-actionable-tail");
  await admit(store, protectedCandidate, 100);
  await admit(store, actionable, 101);
  await pinDocument(store, {
    pinId: "head-pin",
    documentId: protectedCandidate.documentId,
    version: 1,
    reason: "must survive",
    now: 50,
  });
  const result = await runRetention(store, retentionRequest(200, { batchSize: 1 }));
  assert.equal(result.protected, 1);
  assert.equal(result.tombstoned, 1);
  assert.ok(await store.get(manifestKeys.document(protectedCandidate.documentId, 1)));
  assert.equal(await store.get(manifestKeys.document(actionable.documentId, 1)), undefined);
});

test("active lease lookup is not hidden behind more than one scan page of expired entries", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-lease-page"));
  t.after(() => store.close());
  const documentId = "lease-page-document";
  await store.transaction(async (transaction) => {
    for (let index = 0; index < 10_001; index += 1) {
      await transaction.put(
        leaseKeys.byDocumentExpiry(documentId, 1, 1_000 + index, `expired-${index}`),
        { leaseId: `expired-${index}`, expiresAt: 1_000 + index },
        { kind: "retrieval-lease-document-expiry" },
      );
    }
    await transaction.put(
      leaseKeys.byDocumentExpiry(documentId, 1, 50_000, "active"),
      { leaseId: "active", expiresAt: 50_000 },
      { kind: "retrieval-lease-document-expiry" },
    );
  });
  assert.equal(await hasActiveDocumentLease(store, documentId, 1, { now: 20_000 }), true);
});

test("coarse access and disk-low status remain bounded and durable", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-status"));
  t.after(() => store.close());
  const candidate = document("status");
  await admit(store, candidate, 10_000);
  assert.equal((await recordDocumentAccess(store, {
    documentId: candidate.documentId,
    version: 1,
    now: 100,
    bucketMs: 1_000,
  })).status, "inserted");
  assert.equal((await recordDocumentAccess(store, {
    documentId: candidate.documentId,
    version: 1,
    now: 999,
    bucketMs: 1_000,
  })).status, "unchanged");
  assert.equal(store.scan([...retentionKeys.access(candidate.documentId, 1, 0).slice(0, -1)]).length, 1);
  await setEmergencyMode(store, {
    emergencyMode: true,
    freeBytes: 100,
    criticalFreeBytes: 1_000,
    now: 200,
  });
  const status = await retentionStatus(store, { now: 200 });
  assert.equal(status.liveDocuments, 1);
  assert.equal(status.emergencyMode, true);
  assert.equal(status.cleanupBacklog, 0);
});

test("document expiry removes every coarse access bucket", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-access-cleanup"));
  t.after(() => store.close());
  const candidate = document("access-cleanup");
  await admit(store, candidate, 100);
  for (const now of [1, 1_001, 2_001]) {
    await recordDocumentAccess(store, {
      documentId: candidate.documentId,
      version: 1,
      now,
      bucketMs: 1_000,
    });
  }
  assert.equal(store.scan(retentionKeys.accessPrefix(candidate.documentId, 1)).length, 3);
  await runRetention(store, retentionRequest(200));
  assert.equal(store.scan(retentionKeys.accessPrefix(candidate.documentId, 1)).length, 0);
});

test("live-value evacuation makes partial blob deletion physically reclaimable", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-compaction"));
  t.after(() => store.close());
  const prefix = ["chunk", "evacuation-test"];
  for (let index = 0; index < 8; index += 1) {
    await store.putImmutable([...prefix, index], Buffer.alloc(32 * 1024, index + 1), { kind: "chunk" });
  }
  await store.flush();
  await store.compact({ prefix });
  await store.flush();
  for (let index = 0; index < 8; index += 2) await store.remove([...prefix, index]);
  await store.flush();
  const result = await compactDeletionWave(store, { prefix, transactionSize: 2 });
  assert.equal(result.evacuation.rewritten, 4);
  assert.equal(result.evacuation.verified, 4);
  assert.ok(result.after.physicalDataBytes < result.before.physicalDataBytes);
  for (let index = 0; index < 8; index += 1) {
    const payload = await store.get([...prefix, index]);
    if (index % 2 === 0) assert.equal(payload, undefined);
    else assert.equal(payload.length, 32 * 1024);
  }
});

test("live-value evacuation cannot resurrect deletes or overwrite newer values", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retention-compaction-race"));
  t.after(() => store.close());
  const prefix = ["chunk", "evacuation-race"];
  const deletedKey = [...prefix, "deleted"];
  const updatedKey = [...prefix, "updated"];
  await store.put(deletedKey, Buffer.alloc(32 * 1024, 1), { kind: "chunk" });
  await store.put(updatedKey, Buffer.alloc(32 * 1024, 2), { kind: "chunk" });
  await store.flush();

  const deletingEvacuation = evacuateLiveValues(store, { prefix, transactionSize: 1 });
  const deletion = store.remove(deletedKey);
  await Promise.all([deletingEvacuation, deletion]);
  assert.equal(await store.get(deletedKey), undefined);

  const replacement = Buffer.alloc(32 * 1024, 9);
  const updatingEvacuation = evacuateLiveValues(store, { prefix, transactionSize: 1 });
  const update = store.put(updatedKey, replacement, { kind: "chunk" });
  await Promise.all([updatingEvacuation, update]);
  assert.deepEqual(await store.get(updatedKey), replacement);
});
