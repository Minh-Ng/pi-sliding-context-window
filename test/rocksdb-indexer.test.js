import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_STORE_ERROR_MESSAGE_LENGTH } from "../src/store-contract.js";
import { createBm25IndexHandler, searchBm25 } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler, lookupExact } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import {
  IndexWorker,
  INDEX_WORKER_BOUNDARIES,
  MAX_INDEX_SOURCE_RANGE_BYTES,
} from "../src/rocksdb/indexer.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument, readCanonicalDocument } from "../src/rocksdb/manifests.js";
import {
  claimNextOutbox,
  cleanupPublishedStage,
  applyGenerationTablets,
  createGenerationPlan,
  listOutbox,
  outboxKeys,
  outboxMetrics,
  recoverOutbox,
  releaseOutboxClaim,
  stageGeneration,
} from "../src/rocksdb/outbox.js";
import { MAX_ROCKSDB_PERSISTED_KEY_BYTES, RocksStore } from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(sequence, overrides = {}) {
  return {
    idempotencyKey: `request:index:${sequence}`,
    retentionClass: "conversation-source",
    document: {
      documentId: `document-${sequence}`,
      version: 1,
      sourceKey: `user:${sequence}`,
      sessionId: "session-indexer",
      project: "/workspace/indexer",
      kind: "turn",
      createdAt: 1_700_000_000_000 + sequence,
      text: `exact-${sequence} first line\nsecond line 🪨`,
      metadata: { turnId: `turn-${sequence}` },
      sourceMessageKeys: [`user:${sequence}`],
      ...overrides,
    },
  };
}

async function admit(store, count) {
  for (let sequence = 1; sequence <= count; sequence += 1) {
    await admitDocument(store, request(sequence), {
      chunking: { maxChunkBytes: 16, minLineSplitBytes: 0 },
      windows: { windowTokens: 3, overlapTokens: 1 },
    });
  }
}

function exactHandler(id = "exact-test") {
  return {
    id,
    operations: ["index"],
    async prepare(context) {
      const source = await context.readSourceRange(0, context.manifest.byteLength);
      assert.equal(source.text, `exact-${context.outboxSequence} first line\nsecond line 🪨`);
      assert.ok(context.windows.length >= 2);
      return {
        metadata: { sourceHash: context.manifest.contentHash },
        mutations: [
          {
            type: "put",
            key: [KEYSPACE.EXACT, context.manifest.documentId, context.generation, "first"],
            kind: "exact-posting",
            payload: { term: `exact-${context.outboxSequence}`, ordinal: 0 },
          },
          {
            type: "put",
            key: [KEYSPACE.EXACT, context.manifest.documentId, context.generation, "second"],
            kind: "exact-posting",
            payload: { term: "second", ordinal: 1 },
          },
        ],
      };
    },
  };
}

test("outbox access is ordered and claims are atomic, leased, and observable", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-claims"));
  t.after(() => store.close());
  await admit(store, 3);

  assert.deepEqual((await listOutbox(store)).map(({ sequence }) => sequence), [1, 2, 3]);
  assert.equal((await listOutbox(store, { status: "pending" })).length, 3);
  const contenders = await Promise.all([
    claimNextOutbox(store, {
      workerId: "worker:first",
      now: 1_700_000_001_000,
      leaseMs: 100,
    }),
    claimNextOutbox(store, {
      workerId: "worker:second",
      now: 1_700_000_001_000,
      leaseMs: 100,
    }),
  ]);
  const first = contenders.find(({ status }) => status === "claimed");
  const concurrentBusy = contenders.find(({ status }) => status === "busy");
  assert.equal(first.status, "claimed");
  assert.equal(first.sequence, 1);
  assert.equal(first.generation, 1);
  assert.equal(concurrentBusy.sequence, 1);
  assert.equal(concurrentBusy.workerId, first.workerId);

  const busy = await claimNextOutbox(store, {
    workerId: "worker:third",
    now: 1_700_000_001_050,
    leaseMs: 100,
  });
  assert.deepEqual(
    { status: busy.status, sequence: busy.sequence, workerId: busy.workerId },
    { status: "busy", sequence: 1, workerId: first.workerId },
  );

  const reclaimed = await claimNextOutbox(store, {
    workerId: "worker:third",
    now: 1_700_000_001_101,
    leaseMs: 100,
  });
  assert.equal(reclaimed.status, "claimed");
  assert.equal(reclaimed.generation, first.generation);
  assert.notEqual(reclaimed.claimToken, first.claimToken);
  assert.equal(reclaimed.state.attempt, 2);
  assert.deepEqual(await releaseOutboxClaim(store, reclaimed, new Error("retry"), {
    now: 1_700_000_001_102,
  }), {
    status: "released",
    state: await store.get(outboxKeys.state(1)),
  });

  const metrics = await outboxMetrics(store, { now: 1_700_000_002_000 });
  assert.deepEqual(
    { depth: metrics.depth, pending: metrics.pending, processing: metrics.processing, processed: metrics.processed },
    { depth: 3, pending: 3, processing: 0, processed: 0 },
  );
  assert.equal(metrics.nextSequence, 1);
  assert.equal(metrics.oldestPendingAgeMs, 1_999);
});

test("outbox metrics derive exact large backlog depth without history scans", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-metrics-constant-work"));
  t.after(() => store.close());
  await store.put([KEYSPACE.META, KEYSPACE.COUNTER, "outbox"], 150_001, { kind: "counter" });
  await store.put(outboxKeys.cursor(), { nextSequence: 50_001, advancedAt: 10 }, {
    kind: "outbox-cursor",
  });
  await store.put(outboxKeys.entry(50_001), {
    sequence: 50_001,
    operation: "index",
    documentId: "large-backlog",
    documentVersion: 1,
    sourceVersion: 1,
    admittedAt: 20,
  }, { kind: "outbox" });
  const noScanView = {
    get: store.get.bind(store),
    getRecord: store.getRecord.bind(store),
    has: store.has.bind(store),
    transaction: store.transaction.bind(store),
    scan() { throw new Error("metrics must not scan outbox history"); },
  };
  const metrics = await outboxMetrics(noScanView, { now: 120 });
  assert.deepEqual({
    depth: metrics.depth,
    pending: metrics.pending,
    processing: metrics.processing,
    processed: metrics.processed,
    scanned: metrics.scanned,
    oldestPendingAgeMs: metrics.oldestPendingAgeMs,
  }, {
    depth: 100_001,
    pending: 100_001,
    processing: 0,
    processed: 50_000,
    scanned: 1,
    oldestPendingAgeMs: 100,
  });
});

test("worker drains bounded batches and publishes complete generations in order", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-drain"));
  t.after(() => store.close());
  await admit(store, 3);
  const worker = new IndexWorker(store, {
    workerId: "worker:bounded",
    handlers: [exactHandler()],
  });
  assert.deepEqual(worker.registeredHandlers(), ["exact-test"]);
  assert.throws(() => worker.registerHandler(exactHandler()), /already registered/u);

  const first = await worker.drain({ limit: 2 });
  assert.equal(first.processed, 2);
  assert.equal(first.terminal, "limit");
  assert.deepEqual(first.publications.map(({ outboxSequence, generation }) => [outboxSequence, generation]), [
    [1, 1],
    [2, 2],
  ]);
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 4);
  assert.deepEqual(
    { depth: (await worker.metrics()).depth, published: (await worker.metrics()).publishedGeneration },
    { depth: 1, published: 2 },
  );

  const second = await worker.drain({ limit: 2 });
  assert.equal(second.processed, 1);
  assert.equal(second.terminal, "idle");
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 6);
  assert.equal(store.scan([KEYSPACE.META, "index-generation"]).length, 3);
  assert.equal(store.scan([KEYSPACE.META, "index-stage"]).length, 0);
  assert.deepEqual((await listOutbox(store)).map(({ state }) => state.status), [
    "processed",
    "processed",
    "processed",
  ]);

  const compacted = await cleanupPublishedStage(store, 3, { retainPublications: 2 });
  assert.equal(compacted.prunedGeneration, 1);
  assert.equal(compacted.prunedSequence, 1);
  assert.equal(await store.get(outboxKeys.entry(1)), undefined);
  assert.equal(await store.get(outboxKeys.state(1)), undefined);
  assert.equal(await store.get(outboxKeys.generation(1)), undefined);
  assert.notEqual(await store.get(outboxKeys.entry(2)), undefined);
  assert.notEqual(await store.get(outboxKeys.generation(2)), undefined);
});

test("a claim left by process termination is replayed on restart", async (t) => {
  const path = temporaryStorePath(t, "indexer-restart");
  let store = await RocksStore.open(path);
  await admit(store, 1);
  const abandoned = await claimNextOutbox(store, {
    workerId: "worker:terminated",
    now: 1_700_000_003_000,
    leaseMs: 60_000,
  });
  assert.equal(abandoned.status, "claimed");
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const restarted = new IndexWorker(store, {
    workerId: "worker:restarted",
    handlers: [exactHandler()],
  });
  const result = await restarted.drain();
  assert.equal(result.processed, 1);
  assert.equal(result.publications[0].generation, abandoned.generation);
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 2);
  assert.equal((await store.get(outboxKeys.state(1))).status, "processed");
});

test("restart discards a legacy unpublished stage and rebuilds it from canonical data", async (t) => {
  const path = temporaryStorePath(t, "indexer-legacy-stage-restart");
  let store = await RocksStore.open(path);
  await admit(store, 1);
  const abandoned = await claimNextOutbox(store, {
    workerId: "worker:legacy-stage",
    now: 1_700_000_003_000,
    leaseMs: 60_000,
  });
  assert.equal(abandoned.status, "claimed");
  await store.put(outboxKeys.stage(abandoned.generation), {
    stageVersion: 1,
    generation: abandoned.generation,
    outboxSequence: abandoned.sequence,
    operation: abandoned.operation,
    documentId: abandoned.entry.payload.documentId,
    documentVersion: abandoned.entry.payload.documentVersion,
    sourceVersion: abandoned.entry.payload.sourceVersion,
    handlers: [{ id: "legacy-exact", mutationCount: 0, metadata: null }],
    mutationCount: 0,
    mutations: [],
    digest: "legacy-stage-digest",
  }, { kind: "index-stage" });
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const restarted = new IndexWorker(store, {
    workerId: "worker:legacy-stage-restarted",
    handlers: [exactHandler()],
  });
  const result = await restarted.drain({ throwOnError: true });
  assert.equal(result.processed, 1);
  assert.equal(result.publications[0].generation, abandoned.generation);
  assert.equal((await store.get(outboxKeys.state(1))).status, "processed");
  assert.equal((await store.get(outboxKeys.cursor())).nextSequence, 2);
  assert.equal(await store.get(outboxKeys.stage(abandoned.generation)), undefined);
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 2);
});

test("restart recovery applies publication-history compaction after an after-publish crash", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-recovery-compaction"));
  t.after(() => store.close());
  await admit(store, 3);
  let crashThirdPublication = true;
  const worker = new IndexWorker(store, {
    workerId: "worker:recovery-compaction",
    handlers: [exactHandler()],
    fault(boundary, { claim }) {
      if (crashThirdPublication && boundary === "after-publish" && claim.generation === 3) {
        crashThirdPublication = false;
        throw new Error("simulated crash after publication");
      }
    },
  });
  await assert.rejects(worker.drain({ throwOnError: true }), /simulated crash/u);
  assert.notEqual(await store.get(outboxKeys.stage(3)), undefined);

  const recovered = await recoverOutbox(store, { retainPublications: 2 });
  assert.equal(recovered.cleanedStages, 1);
  assert.equal(await store.get(outboxKeys.stage(3)), undefined);
  assert.equal(await store.get(outboxKeys.entry(1)), undefined);
  assert.equal(await store.get(outboxKeys.state(1)), undefined);
  assert.equal(await store.get(outboxKeys.generation(1)), undefined);
  assert.notEqual(await store.get(outboxKeys.entry(2)), undefined);
  assert.notEqual(await store.get(outboxKeys.generation(2)), undefined);
});

for (const boundary of INDEX_WORKER_BOUNDARIES) {
  test(`fault at ${boundary} leaves a complete or replayable generation`, async (t) => {
    const path = temporaryStorePath(t, `indexer-fault-${boundary}`);
    let store = await RocksStore.open(path);
    await admit(store, 1);
    let injected = false;
    const failing = new IndexWorker(store, {
      workerId: `worker:fault:${boundary}`,
      handlers: [exactHandler()],
      fault(point) {
        if (!injected && point === boundary) {
          injected = true;
          const error = new Error(`injected fault at ${point}`);
          error.code = "ERR_TEST_FAULT";
          throw error;
        }
      },
    });
    await assert.rejects(failing.processNext(), new RegExp(`injected fault at ${boundary}`, "u"));
    assert.equal(injected, true);

    const beforePostings = store.scan([KEYSPACE.EXACT]).length;
    const beforePublications = store.scan([KEYSPACE.META, "index-generation"]).length;
    assert.ok(beforePostings === 0 || beforePostings === 2);
    assert.equal(beforePublications === 1, beforePostings === 2);
    store.close();

    store = await RocksStore.open(path);
    t.after(() => store.close());
    const replay = new IndexWorker(store, {
      workerId: `worker:replay:${boundary}`,
      handlers: [exactHandler()],
    });
    const drained = await replay.drain();
    assert.equal(drained.errors.length, 0);
    assert.equal(store.scan([KEYSPACE.EXACT]).length, 2);
    assert.equal(store.scan([KEYSPACE.META, "index-generation"]).length, 1);
    assert.equal(store.scan([KEYSPACE.META, "index-stage"]).length, 0);
    assert.equal((await store.get(outboxKeys.state(1))).status, "processed");
    assert.equal((await replay.metrics()).depth, 0);
  });
}

test("handler failure and conflicting or protected writes never publish partial work", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-handler-failure"));
  t.after(() => store.close());
  await admit(store, 1);
  const worker = new IndexWorker(store, {
    workerId: "worker:handler-failure",
    handlers: [
      exactHandler("a-valid"),
      { id: "b-fails", prepare() { throw new Error(`handler exploded${"x".repeat(9_000)}`); } },
    ],
  });
  const failed = await worker.drain();
  assert.equal(failed.terminal, "error");
  assert.match(failed.errors[0].message, /handler exploded/u);
  assert.equal(failed.errors[0].message.length, MAX_STORE_ERROR_MESSAGE_LENGTH);
  assert.equal(
    (await store.get(outboxKeys.state(1))).lastError.message.length,
    MAX_STORE_ERROR_MESSAGE_LENGTH,
  );
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 0);
  assert.equal(store.scan([KEYSPACE.META, "index-generation"]).length, 0);

  worker.unregisterHandler("b-fails");
  worker.registerHandler({
    id: "b-protected",
    prepare() {
      return [{ type: "put", key: [KEYSPACE.DOCUMENT, "forbidden", 1], payload: { bad: true } }];
    },
  });
  const protectedResult = await worker.drain();
  assert.equal(protectedResult.terminal, "error");
  assert.match(protectedResult.errors[0].message, /protected keyspace document/u);
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 0);
  assert.equal(await store.get([KEYSPACE.DOCUMENT, "forbidden", 1]), undefined);

  worker.unregisterHandler("b-protected");
  const recovered = await worker.drain();
  assert.equal(recovered.processed, 1);
  assert.equal(store.scan([KEYSPACE.EXACT]).length, 2);
  assert.equal(store.scan([KEYSPACE.META, "index-generation"]).length, 1);
});

test("index loading pages every canonical window beyond the default scan limit", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-window-pages"));
  t.after(() => store.close());
  const text = `${Array.from({ length: 1_005 }, () => "ordinary").join(" ")} TAIL_WINDOW_SENTINEL`;
  await admitDocument(store, request(1, { text }), {
    windows: { windowTokens: 1, overlapTokens: 0 },
  });
  assert.ok(store.scan([KEYSPACE.WINDOW, "document-1", 1], { limit: 100_000 }).length > 1_000);

  const worker = new IndexWorker(store, {
    workerId: "worker:window-pages",
    windowPageSize: 97,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  const result = await lookupExact(store, {
    query: "TAIL_WINDOW_SENTINEL",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(result.results[0].documentId, "document-1");
  assert.ok(result.results[0].location.windowOrdinal > 1_000);
  const lexical = await searchBm25(store, {
    query: "TAIL_WINDOW_SENTINEL",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(lexical.results[0].documentId, "document-1");
  assert.ok(lexical.results[0].windowOrdinal > 1_000);
});

test("many-window preparation is durably skipped without blocking the ordered backlog", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-window-limit-skip"));
  t.after(() => store.close());
  const manyWindows = `${Array.from({ length: 4_097 }, (_, index) => `ordinary${index}`).join(" ")} OVERSIZED_WINDOW_TARGET`;
  await admitDocument(store, request(1, { text: manyWindows }), {
    windows: { windowTokens: 1, overlapTokens: 0 },
  });
  await admitDocument(store, request(2, { text: "NORMAL_BACKLOG_TARGET remains searchable" }));
  assert.ok(store.scan([KEYSPACE.WINDOW, "document-1", 1], { limit: 10_000 }).length > 4_096);
  const worker = new IndexWorker(store, {
    workerId: "worker:window-limit-skip",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler()],
  });
  const drained = await worker.drain({ limit: 2, maxDurationMs: 30_000, throwOnError: true });
  assert.equal(drained.processed, 2);
  assert.equal(drained.publications[0].indexStatus, "skipped");
  assert.equal(drained.publications[0].skippedHandlers[0].limitKind, "stored windows per document");
  assert.equal(drained.publications[1].indexStatus, "complete");
  assert.equal(store.scan(["index-preparation-status", "document-1", 1], { limit: 10 }).length, 1);
  assert.equal((await lookupExact(store, {
    query: "OVERSIZED_WINDOW_TARGET",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results.length, 0);
  assert.equal((await lookupExact(store, {
    query: "NORMAL_BACKLOG_TARGET",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results[0].documentId, "document-2");
  const metrics = await outboxMetrics(store);
  assert.equal(metrics.depth, 0);
  assert.equal(metrics.skippedDocuments, 1);
  assert.equal(metrics.skippedHandlers, 1);
});

test("BM25 unique-term overflow is terminal and does not block later outbox work", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-unique-term-limit-skip"));
  t.after(() => store.close());
  const uniqueTerms = Array.from(
    { length: 20_001 },
    (_, index) => `lexeme${index.toString(36).padStart(4, "0")}z`,
  ).join(" ");
  await admitDocument(store, request(1, { text: uniqueTerms }));
  await admitDocument(store, request(2, { text: "LATER_BM25_TARGET remains searchable" }));

  const worker = new IndexWorker(store, {
    workerId: "worker:unique-term-limit-skip",
    maxDrainMs: 30_000,
    handlers: [createBm25IndexHandler()],
  });
  const drained = await worker.drain({ limit: 2, maxDurationMs: 30_000, throwOnError: true });
  assert.equal(drained.processed, 2);
  assert.equal(drained.publications[0].indexStatus, "skipped");
  assert.equal(drained.publications[0].skippedHandlers[0].limitKind, "unique terms");
  assert.equal(drained.publications[1].indexStatus, "complete");
  assert.equal((await store.get(outboxKeys.state(1))).status, "processed");
  assert.equal((await searchBm25(store, {
    query: "LATER_BM25_TARGET",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results[0].documentId, "document-2");
  const metrics = await outboxMetrics(store);
  assert.equal(metrics.depth, 0);
  assert.equal(metrics.skippedDocuments, 1);
  assert.equal(metrics.skippedHandlers, 1);
});

test("oversized derived keys skip only their handlers and advance ordered tail work", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-derived-key-limit-skip"));
  t.after(() => store.close());
  const repeated = (character, length) => character.repeat(length);
  const withStructuralMessage = (candidate) => ({
    ...candidate,
    structuralMessages: [{
      messageKey: candidate.document.sourceKey,
      messageIndex: 0,
      role: "user",
      createdAt: candidate.document.createdAt,
      text: candidate.document.text,
      questionScore: 100,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  const bm25Boundary = request(1, {
    documentId: repeated("d", 600),
    sessionId: repeated("s", 600),
    project: repeated("p", 600),
    text: repeated("t", 128),
  });
  const exactBoundary = request(2, {
    documentId: repeated("e", 900),
    sessionId: repeated("i", 100),
    project: repeated("q", 900),
    text: `https://example.test/${repeated("a", 490)}`,
  });
  const structuralBoundary = withStructuralMessage(request(3, {
    documentId: repeated("f", 660),
    sessionId: repeated("j", 660),
    project: repeated("r", 660),
    text: "STRUCTURAL_BOUNDARY_TARGET asks why",
  }));
  const tail = request(4, { text: "TAIL_DERIVED_KEY_TARGET remains searchable" });
  for (const candidate of [bm25Boundary, exactBoundary, structuralBoundary, tail]) {
    await admitDocument(store, candidate);
  }

  const worker = new IndexWorker(store, {
    workerId: "worker:derived-key-limit-skip",
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
    ],
  });
  const drained = await worker.drain({
    limit: 4,
    maxDurationMs: 30_000,
    throwOnError: true,
  });
  assert.equal(drained.processed, 4);
  assert.deepEqual(
    drained.publications.map(({ indexStatus }) => indexStatus),
    ["partial", "partial", "partial", "complete"],
  );
  assert.deepEqual(
    drained.publications.map(({ skippedHandlers }) => skippedHandlers.map(({ id }) => id)),
    [
      ["bm25"],
      ["exact-postings-v1"],
      ["bm25", "structural-v1"],
      [],
    ],
  );
  for (const publication of drained.publications.slice(0, 3)) {
    for (const skipped of publication.skippedHandlers) {
      assert.equal(skipped.reason, "preparation-limit");
      assert.equal(skipped.limitKind, "persisted key bytes");
      assert.equal(skipped.limit, MAX_ROCKSDB_PERSISTED_KEY_BYTES);
      assert.ok(skipped.observed > skipped.limit);
    }
  }
  assert.equal(drained.publications[0].skippedHandlers[0].observed, 2_050);
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    assert.equal((await store.get(outboxKeys.state(sequence))).status, "processed");
  }
  for (const candidate of [bm25Boundary, exactBoundary, structuralBoundary]) {
    assert.equal(
      (await readCanonicalDocument(store, candidate.document.documentId, 1)).text,
      candidate.document.text,
    );
  }
  assert.equal((await lookupExact(store, {
    query: "TAIL_DERIVED_KEY_TARGET",
    project: tail.document.project,
    scope: "session",
    sessionId: tail.document.sessionId,
  })).results[0].documentId, tail.document.documentId);
  assert.equal((await searchBm25(store, {
    query: "TAIL_DERIVED_KEY_TARGET",
    project: tail.document.project,
    scope: "session",
    sessionId: tail.document.sessionId,
  })).results[0].documentId, tail.document.documentId);
  const metrics = await outboxMetrics(store);
  assert.equal(metrics.depth, 0);
  assert.equal(metrics.nextSequence, 5);
  assert.equal(metrics.skippedDocuments, 3);
  assert.equal(metrics.skippedHandlers, 4);
});

test("one multi-chunk lexical token is indexed through bounded deterministic source ranges", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-long-token-ranges"));
  t.after(() => store.close());
  const target = "TAIL_STREAM_TARGET";
  const text = `${"a".repeat((2 * 1_024 * 1_024) + 17)} ${target}`;
  await admitDocument(store, request(1, {
    text,
    metadata: { turnId: "x".repeat(8_193) },
  }), {
    chunking: { maxChunkBytes: 64 * 1_024, minLineSplitBytes: 0 },
  });
  assert.equal(store.scan([KEYSPACE.WINDOW, "document-1", 1], { limit: 10 }).length, 1);

  const requestedRanges = [];
  const instrument = (handler, id) => ({
    ...handler,
    id,
    async prepare(context) {
      return handler.prepare(Object.freeze({
        ...context,
        readSourceRange(startByte, endByte, options) {
          requestedRanges.push({ id, startByte, endByte });
          return context.readSourceRange(startByte, endByte, options);
        },
      }));
    },
  });
  const worker = new IndexWorker(store, {
    workerId: "worker:long-token-ranges",
    sourceSegmentBytes: 64 * 1_024,
    handlers: [
      instrument(createExactIndexHandler(), "bounded-exact"),
      instrument(createBm25IndexHandler(), "bounded-bm25"),
    ],
  });
  assert.equal((await worker.drain({ throwOnError: true, maxDurationMs: 30_000 })).processed, 1);
  assert.ok(requestedRanges.length > 32);
  assert.ok(requestedRanges.every(({ startByte, endByte }) =>
    endByte - startByte > 0 && endByte - startByte <= MAX_INDEX_SOURCE_RANGE_BYTES));
  assert.ok(requestedRanges.every(({ startByte, endByte }) => endByte - startByte < text.length));

  const exact = await lookupExact(store, {
    query: target,
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(exact.results[0].documentId, "document-1");
  assert.equal(exact.results[0].source.turnId, undefined);
  const lexical = await searchBm25(store, {
    query: target,
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(lexical.results[0].documentId, "document-1");
  assert.equal(lexical.results[0].source.turnId, undefined);
});

test("bounded index tablets resume after a mid-generation restart and publish once", async (t) => {
  const path = temporaryStorePath(t, "indexer-tablet-restart");
  const markers = Array.from({ length: 32 }, (_, index) => `TABLET_TOKEN_${String(index).padStart(3, "0")}`);
  let store = await RocksStore.open(path);
  await admitDocument(store, request(1, { text: markers.join(" ") }), {
    windows: { windowTokens: 4, overlapTokens: 0 },
  });
  const claim = await claimNextOutbox(store, {
    workerId: "worker:tablet-crash",
    now: 1_700_000_010_000,
    leaseMs: 60_000,
  });
  const preparing = new IndexWorker(store, {
    workerId: "worker:tablet-crash",
    handlers: [createExactIndexHandler()],
  });
  const results = await preparing.loadAndPrepare(claim);
  const plan = createGenerationPlan(claim, results, {
    atomicMaxMutations: 2,
    atomicMaxBytes: 2_048,
    tabletMaxMutations: 4,
    tabletMaxBytes: 64 * 1_024,
  });
  assert.equal(plan.mode, "tablets");
  assert.ok(plan.tabletCount > 2);
  await stageGeneration(store, claim, plan);
  await assert.rejects(applyGenerationTablets(store, claim, {
    afterTablet({ ordinal, mutationCount, mutationBytes }) {
      assert.equal(ordinal, 0);
      assert.ok(mutationCount <= 4);
      assert.ok(mutationBytes <= 64 * 1_024);
      throw new Error("simulated tablet crash");
    },
  }), /simulated tablet crash/u);
  assert.notEqual(await store.get(outboxKeys.stageApplied(claim.generation, 0)), undefined);
  assert.equal(await store.get(outboxKeys.stageReady(claim.generation)), undefined);
  assert.equal(await store.get([KEYSPACE.META, "published-index-generation"]), undefined);
  assert.equal((await lookupExact(store, {
    query: markers.at(-1),
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results.length, 0);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const restarted = new IndexWorker(store, {
    workerId: "worker:tablet-restarted",
    handlers: [createExactIndexHandler()],
  });
  const drained = await restarted.drain({ throwOnError: true });
  assert.equal(drained.processed, 1);
  assert.equal(drained.publications[0].publicationMode, "tablets");
  assert.equal(drained.publications[0].tabletCount, plan.tabletCount);
  assert.equal((await lookupExact(store, {
    query: markers.at(-1),
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results[0].documentId, "document-1");
  assert.equal(store.scan([KEYSPACE.META, "index-stage-tablet"], { limit: 100_000 }).length, 0);
  assert.equal(store.scan([KEYSPACE.META, "index-stage-applied"], { limit: 100_000 }).length, 0);
});

test("a changed handler plan replaces orphan tablets left before the stage header", async (t) => {
  const path = temporaryStorePath(t, "indexer-orphan-tablet-upgrade");
  const upgradeHandler = (format) => ({
    id: "upgrade-handler",
    operations: ["index"],
    prepare(context) {
      return Array.from({ length: 12 }, (_, ordinal) => ({
        type: "put",
        immutable: false,
        key: [KEYSPACE.EXACT, "upgrade", ordinal],
        payload: { format, generation: context.generation, ordinal },
      }));
    },
  });
  let store = await RocksStore.open(path);
  await admit(store, 1);
  const claim = await claimNextOutbox(store, {
    workerId: "worker:orphan-v1",
    now: 1_700_000_020_000,
    leaseMs: 60_000,
  });
  const firstWorker = new IndexWorker(store, {
    workerId: "worker:orphan-v1",
    handlers: [upgradeHandler("v1")],
  });
  const firstPlan = createGenerationPlan(claim, await firstWorker.loadAndPrepare(claim), {
    atomicMaxMutations: 2,
    atomicMaxBytes: 2_048,
    tabletMaxMutations: 2,
    tabletMaxBytes: 16 * 1_024,
  });
  await assert.rejects(stageGeneration(store, claim, firstPlan, {
    afterTablet({ ordinal }) {
      assert.equal(ordinal, 0);
      throw new Error("crash before stage header");
    },
  }), /crash before stage header/u);
  assert.equal(await store.get(outboxKeys.stage(claim.generation)), undefined);
  assert.equal(store.scan([KEYSPACE.META, "index-stage-tablet", claim.generation]).length, 1);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const upgraded = new IndexWorker(store, {
    workerId: "worker:orphan-v2",
    atomicMaxMutations: 2,
    atomicMaxBytes: 2_048,
    tabletMaxMutations: 2,
    tabletMaxBytes: 16 * 1_024,
    handlers: [upgradeHandler("v2")],
  });
  const drained = await upgraded.drain({ throwOnError: true });
  assert.equal(drained.processed, 1);
  assert.equal((await store.get([KEYSPACE.EXACT, "upgrade", 0])).format, "v2");
  assert.equal(store.scan([KEYSPACE.META, "index-stage-tablet", claim.generation]).length, 0);
});

test("same-version tablet rebuild keeps the last published exact and BM25 generation visible", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "indexer-same-version-mvcc"));
  t.after(() => store.close());
  const text = "MVCC_REBUILD_TOKEN remains searchable through a same-version repair";
  await admitDocument(store, request(1, { text }), {
    windows: { windowTokens: 4, overlapTokens: 0 },
  });
  let stopBeforeSecondPublish = false;
  const worker = new IndexWorker(store, {
    workerId: "worker:same-version-mvcc",
    atomicMaxMutations: 1,
    atomicMaxBytes: 1_024,
    tabletMaxMutations: 3,
    tabletMaxBytes: 64 * 1_024,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
    fault(boundary, { claim }) {
      if (stopBeforeSecondPublish && boundary === "before-publish" && claim.generation === 2) {
        throw new Error("pause same-version rebuild before publication");
      }
    },
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  await admitDocument(store, {
    ...request(1, { text }),
    idempotencyKey: "request:index:1:repair",
  }, {
    windows: { windowTokens: 4, overlapTokens: 0 },
  });
  stopBeforeSecondPublish = true;
  await assert.rejects(worker.processNext(), /pause same-version rebuild/u);
  assert.equal((await store.get([KEYSPACE.META, "published-index-generation"])).generation, 1);

  const exactBefore = await lookupExact(store, {
    query: "MVCC_REBUILD_TOKEN",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(exactBefore.results[0].location.generation, 1);
  const lexicalBefore = await searchBm25(store, {
    query: "same version repair",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  });
  assert.equal(lexicalBefore.results[0].location.generation, 1);

  stopBeforeSecondPublish = false;
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  assert.equal((await store.get([KEYSPACE.META, "published-index-generation"])).generation, 2);
  assert.equal((await lookupExact(store, {
    query: "MVCC_REBUILD_TOKEN",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results[0].location.generation, 2);
  assert.equal((await searchBm25(store, {
    query: "same version repair",
    project: "/workspace/indexer",
    scope: "session",
    sessionId: "session-indexer",
  })).results[0].location.generation, 2);
});
