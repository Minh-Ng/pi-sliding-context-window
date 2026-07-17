import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_VISIBLE_SOURCE_KEYS } from "../src/store-contract.js";
import { RETRIEVAL_REGRESSION_FIXTURE } from "../eval/retrieval/fixtures.js";
import { scoreRetrievalSuite } from "../eval/retrieval/scoring.js";
import { createSqliteEvaluationBackend } from "../eval/retrieval/sqlite-backend.js";
import {
  bm25InverseDocumentFrequency,
  bm25Keys,
  createBm25IndexHandler,
  DEFAULT_BM25_SEARCH_LIMITS,
  readBm25Statistics,
  recomputeBm25Evidence,
  recomputeBm25Score,
  searchBm25,
} from "../src/rocksdb/index/bm25.js";
import {
  normalizeBm25Term,
  tokenizeBm25,
  tokenizeBm25Query,
} from "../src/rocksdb/index/tokenizer.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { runRetention } from "../src/rocksdb/retention.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-bm25-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(documentId, text, overrides = {}) {
  const version = overrides.version ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `bm25:${documentId}:${version}`,
    retentionClass: "conversation-source",
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    document: {
      documentId,
      version,
      sourceKey: overrides.sourceKey ?? `assistant:${documentId}`,
      sourceMessageKeys: overrides.sourceMessageKeys ?? [overrides.sourceKey ?? `assistant:${documentId}`],
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/fixture/project",
      kind: overrides.kind ?? "turn",
      createdAt: overrides.createdAt ?? 1_700_000_000_000,
      text,
      metadata: overrides.metadata ?? { turnId: `turn-${documentId}` },
    },
  };
}

async function admit(store, documentId, text, overrides) {
  return admitDocument(store, request(documentId, text, overrides), {
    windows: { windowTokens: 100, overlapTokens: 0 },
  });
}

test("tokenizer stems deterministic terms and retains original UTF-8 positions", () => {
  assert.equal(normalizeBm25Term("duplicated"), "duplic");
  assert.equal(normalizeBm25Term("duplicating"), "duplic");
  assert.equal(normalizeBm25Term("reconstruction"), "reconstruct");
  assert.equal(normalizeBm25Term("ＤＵＰＬＩＣＡＴＥＤ"), "duplic");
  assert.deepEqual(tokenizeBm25Query("Duplicated duplicating bytes"), ["duplic", "byte"]);

  const text = "Café 🪨 DUPLICATED/雪";
  const tokens = tokenizeBm25(text);
  assert.deepEqual(tokens.map(({ term, startByte, endByte }) => ({ term, startByte, endByte })), [
    { term: "café", startByte: 0, endByte: 5 },
    { term: "duplic", startByte: 11, endByte: 21 },
    { term: "雪", startByte: 22, endByte: 25 },
  ]);
  for (const token of tokens) {
    assert.equal(Buffer.from(text).subarray(token.startByte, token.endByte).toString(), token.surface);
  }
});

test("IndexWorker publishes complete BM25 generations with recomputable scores", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "generations"));
  t.after(() => store.close());
  await admit(store, "doc-cache", "Persisted historical hints preserve the provider cache prefix during reconstruction.", {
    createdAt: 100,
  });
  await admit(store, "doc-tools", "Immutable chunks prevent duplicated large tool result bytes.", {
    createdAt: 200,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:generations",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 2);

  const statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach", "duplic"],
  });
  assert.equal(statistics.generation, 2);
  assert.equal(statistics.corpus.documentCount, 2);
  assert.equal(statistics.terms.duplic.documentFrequency, 1);

  const response = await searchBm25(store, {
    query: "preserve reconstructed provider cache prefix",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 3,
  });
  assert.equal(response.results[0].documentId, "doc-cache");
  assert.match(response.results[0].snippet, /\[[^\]]+\]/u);
  assert.equal(response.results[0].matchType, "bm25");
  assert.equal(response.results[0].createdAt, 100);
  assert.equal(response.results[0].location.generation, 2);
  assert.equal(response.results[0].locator, null);
  assert.equal(response.results[0].score, recomputeBm25Score(response.results[0].explanation));
  assert.equal(response.results[0].rawScore, response.results[0].score);
  assert.deepEqual(response.results[0].matchedTerms, [
    "cach",
    "prefix",
    "preserv",
    "provid",
    "reconstruct",
  ]);
  assert.equal(response.results[0].termCoverage, 1);
  assert.equal(response.results[0].maxNormalizedIdf, 1);
  assert.ok(response.results[0].termIdf.every(({ normalizedIdf }) => normalizedIdf === 1));
  assert.deepEqual(
    {
      matchedTerms: response.results[0].matchedTerms,
      termCoverage: response.results[0].termCoverage,
      termIdf: response.results[0].termIdf,
      maxNormalizedIdf: response.results[0].maxNormalizedIdf,
    },
    recomputeBm25Evidence(response.results[0].explanation),
  );
  assert.equal(response.results[0].explanation.statisticsGeneration, 2);
  assert.ok(response.results[0].explanation.terms.every(({ positions }) => positions.length > 0));
  const boundedSnippet = await searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
  }, { maxSnippetCharacters: 16 });
  assert.ok(Array.from(boundedSnippet.results[0].snippet).length <= 16);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "session",
  }), /requires sessionId or sessionIds/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    excludeVisibleSourceKeys: "assistant:doc-cache",
  }), /excludeVisibleSourceKeys/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    excludeVisibleSourceKeys: Array.from(
      { length: MAX_VISIBLE_SOURCE_KEYS + 1 },
      (_, index) => `visible-${index}`,
    ),
  }), /at most 1000 items/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    generation: 1,
  }), /current published generation/u);

  const missingPosting = store.scan(bm25Keys.postingPrefix("/fixture/project", "cach"), { limit: 1 })[0];
  await store.remove(missingPosting.key);
  await admit(store, "doc-cache", "Persisted historical hints preserve the provider cache prefix during reconstruction.", {
    createdAt: 100,
    idempotencyKey: "bm25:doc-cache:repair",
  });
  assert.equal((await worker.drain()).processed, 1);
  assert.equal(store.scan(bm25Keys.postingPrefix("/fixture/project", "cach")).length, 1);
  assert.equal((await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach"],
  })).corpus.documentCount, 2);

  await admit(store, "doc-cache", "The replacement discusses only unrelated current runtime state.", {
    version: 2,
    createdAt: 300,
  });
  assert.equal((await worker.drain()).processed, 1);
  const afterReplacement = await searchBm25(store, {
    query: "provider cache prefix",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
  });
  assert.equal(afterReplacement.results.some(({ documentId }) => documentId === "doc-cache"), false);
  assert.equal((await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach"],
  })).corpus.documentCount, 2);
  assert.equal(store.scan(bm25Keys.postingPrefix("/fixture/project", "cach")).length, 0);

  await store.put([KEYSPACE.SUPERSESSION, "doc-tools", 1], { status: "superseded" });
  const superseded = await searchBm25(store, {
    query: "immutable chunks duplicated tool result",
    project: "/fixture/project",
    scope: "project",
  });
  assert.equal(superseded.results.some(({ documentId }) => documentId === "doc-tools"), false);
});

test("BM25 evidence identifies a single common query term without inflating its IDF", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "common-term-evidence"));
  t.after(() => store.close());
  await admit(store, "common-a", "shared alpha", { createdAt: 1 });
  await admit(store, "common-b", "shared beta", { createdAt: 2 });
  await admit(store, "common-c", "shared gamma", { createdAt: 3 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:common-term-evidence",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 3);

  const response = await searchBm25(store, {
    query: "shared",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
    limit: 1,
  });
  const result = response.results[0];
  const expectedIdf = bm25InverseDocumentFrequency(3, 3);
  const maximumIdf = bm25InverseDocumentFrequency(3, 1);
  assert.equal(result.documentId, "common-c");
  assert.equal(result.createdAt, 3);
  assert.equal(result.rawScore, recomputeBm25Score(result.explanation));
  assert.deepEqual(result.matchedTerms, ["share"]);
  assert.equal(result.termCoverage, 1);
  assert.deepEqual(result.termIdf, [{
    term: "share",
    idf: expectedIdf,
    normalizedIdf: expectedIdf / maximumIdf,
  }]);
  assert.equal(result.maxNormalizedIdf, expectedIdf / maximumIdf);
  assert.deepEqual(recomputeBm25Evidence(result.explanation), {
    matchedTerms: result.matchedTerms,
    termCoverage: result.termCoverage,
    termIdf: result.termIdf,
    maxNormalizedIdf: result.maxNormalizedIdf,
  });
});

test("BM25 evidence reports two distinctive terms and partial query coverage", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "distinctive-term-evidence"));
  t.after(() => store.close());
  await admit(store, "distinctive-target", "tablet compaction", { createdAt: 10 });
  await admit(store, "distinctive-other-a", "ordinary routing", { createdAt: 20 });
  await admit(store, "distinctive-other-b", "routine history", { createdAt: 30 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:distinctive-term-evidence",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 3);

  const response = await searchBm25(store, {
    query: "tablet compaction absent",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
    limit: 1,
  });
  const result = response.results[0];
  const distinctiveIdf = 0.9808292530117264;
  assert.equal(result.documentId, "distinctive-target");
  assert.equal(result.rawScore, recomputeBm25Score(result.explanation));
  assert.deepEqual(result.matchedTerms, ["compact", "tablet"]);
  assert.equal(result.termCoverage, 2 / 3);
  assert.deepEqual(result.termIdf, [
    { term: "compact", idf: distinctiveIdf, normalizedIdf: 1 },
    { term: "tablet", idf: distinctiveIdf, normalizedIdf: 1 },
  ]);
  assert.equal(result.maxNormalizedIdf, 1);
  assert.deepEqual(recomputeBm25Evidence(result.explanation), {
    matchedTerms: result.matchedTerms,
    termCoverage: 2 / 3,
    termIdf: result.termIdf,
    maxNormalizedIdf: 1,
  });
});

test("failed publication exposes neither postings nor partial generation statistics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "atomic-publication"));
  t.after(() => store.close());
  await admit(store, "doc-atomic", "Atomic generation statistics and postings publish together.");
  let injected = false;
  const failing = new IndexWorker(store, {
    workerId: "bm25:test:failing",
    handlers: [createBm25IndexHandler()],
    fault(boundary) {
      if (!injected && boundary === "before-publish") {
        injected = true;
        throw new Error("stop before BM25 publication");
      }
    },
  });
  await assert.rejects(failing.processNext(), /before BM25 publication/u);
  assert.equal(store.scan([KEYSPACE.POSTING, "bm25"]).length, 0);

  const restarted = new IndexWorker(store, {
    workerId: "bm25:test:restarted",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await restarted.drain()).processed, 1);
  assert.ok(store.scan([KEYSPACE.POSTING, "bm25"]).length > 0);
  const result = await searchBm25(store, {
    query: "atomic statistics postings",
    project: "/fixture/project",
    scope: "project",
  });
  assert.equal(result.results[0].documentId, "doc-atomic");
});

test("posting work is bounded and visible in search diagnostics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "bounded"));
  t.after(() => store.close());
  for (let index = 0; index < 4; index += 1) {
    await admit(store, `doc-${index}`, `shared term evidence number ${index}`, { createdAt: 100 + index });
  }
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:bounded",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  const response = await searchBm25(store, {
    query: "shared evidence",
    project: "/fixture/project",
    scope: "project",
    limit: 3,
  }, {
    maxPostingRecords: 1,
    maxWindowCandidates: 1,
  });
  assert.equal(response.work.postingRecordsRead, 1);
  assert.equal(response.work.windowCandidates, 1);
  assert.equal(response.work.truncated, true);
});

test("BM25 snippets never materialize an unbounded logical window", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "bounded-snippet-source"));
  t.after(() => store.close());
  const target = "SNIPPET_RANGE_TARGET";
  const text = `${target} ${"a".repeat(300_000)}`;
  await admitDocument(store, request("doc-bounded-snippet", text), {
    chunking: { maxChunkBytes: 4_096, minLineSplitBytes: 0 },
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:bounded-snippet-source",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  const manifest = await store.get([KEYSPACE.DOCUMENT, "doc-bounded-snippet", 1]);
  assert.equal(store.scan([KEYSPACE.WINDOW, "doc-bounded-snippet", 1], { limit: 10 }).length, 1);
  const contextBytes = DEFAULT_BM25_SEARCH_LIMITS.maxSnippetCharacters * 4;
  const allowedEnd = 2 * contextBytes;
  const allowed = new Set(manifest.chunks
    .filter((reference) => reference.startByte < allowedEnd && reference.endByte > 0)
    .map(({ chunkId }) => chunkId));
  const forbidden = new Set(manifest.chunks
    .map(({ chunkId }) => chunkId)
    .filter((chunkId) => !allowed.has(chunkId)));
  const chunkReads = new Set();
  assert.ok(forbidden.size > 0);
  const guarded = {
    snapshot(callback) {
      return store.snapshot((view) => callback({
        get(key, ...args) {
          if (key[0] === KEYSPACE.CHUNK) {
            chunkReads.add(key[1]);
            if (forbidden.has(key[1])) {
              throw new Error(`BM25 snippet read unrelated chunk ${key[1]}`);
            }
          }
          return view.get(key, ...args);
        },
        scan: view.scan.bind(view),
      }));
    },
  };
  const response = await searchBm25(guarded, {
    query: target,
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
  });
  assert.equal(response.results[0].documentId, "doc-bounded-snippet");
  assert.match(response.results[0].snippet, /SNIPPET_RANGE_TARGET/u);
  assert.ok(chunkReads.size > 0);
  assert.ok([...chunkReads].every((chunkId) => allowed.has(chunkId)));
});

test("session-scoped caps cannot be consumed by newer unauthorized sessions", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "session-cap"));
  t.after(() => store.close());
  await admit(store, "eligible", "shared lexical evidence", {
    sessionId: "session-eligible",
    createdAt: 100,
  });
  await admit(store, "ineligible", "shared lexical evidence", {
    sessionId: "session-other",
    createdAt: 200,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:session-cap",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  const response = await searchBm25(store, {
    query: "shared lexical evidence",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-eligible",
  }, { maxPostingRecords: 1 });
  assert.equal(response.work.postingRecordsRead, 1);
  assert.equal(response.results[0].documentId, "eligible");

  await admit(store, "adoc-newest", "shared lexical evidence", {
    sessionId: "session-eligible",
    createdAt: 300,
  });
  await worker.drain();
  const newestAcrossLineage = await searchBm25(store, {
    query: "shared lexical evidence",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-eligible", "session-other"],
  }, { maxPostingRecords: 1 });
  assert.equal(newestAcrossLineage.results[0].documentId, "adoc-newest");
  assert.equal(newestAcrossLineage.work.postingRecordsRead, 1);
  assert.equal(newestAcrossLineage.work.postingRecordsScanned, 2);
});

test("frozen lexical quality is no worse than the SQLite FTS5 baseline", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "lexical-quality"));
  t.after(() => store.close());
  for (const document of RETRIEVAL_REGRESSION_FIXTURE.documents) {
    const admission = {
      idempotencyKey: `fixture:${document.id}`,
      retentionClass: "conversation-source",
      document: {
        documentId: document.id,
        version: 1,
        sourceKey: document.metadata.sourceMessageKeys[0],
        sourceMessageKeys: document.metadata.sourceMessageKeys,
        sessionId: document.sessionId,
        project: document.project,
        kind: document.kind,
        createdAt: document.createdAt,
        text: document.text,
        metadata: document.metadata,
      },
    };
    await admitDocument(store, admission);
  }
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:quality",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ limit: 64 })).processed, RETRIEVAL_REGRESSION_FIXTURE.documents.length);

  const sqlite = createSqliteEvaluationBackend();
  t.after(() => sqlite.close());
  await sqlite.prepare(RETRIEVAL_REGRESSION_FIXTURE);
  const baselineObservations = [];
  const rocksObservations = [];
  for (const evaluationCase of RETRIEVAL_REGRESSION_FIXTURE.suites.lexical) {
    const request = {
      query: evaluationCase.query,
      project: "/fixture/project",
      sessionId: "session-main",
      sessionIds: ["session-main"],
      scope: evaluationCase.scope,
      limit: evaluationCase.limit,
      mode: "lexical",
    };
    const baseline = await sqlite.search(request);
    const rocks = await searchBm25(store, request);
    baselineObservations.push({ id: evaluationCase.id, results: baseline.results });
    rocksObservations.push({ id: evaluationCase.id, results: rocks.results });
  }
  const baseline = scoreRetrievalSuite(
    "lexical",
    RETRIEVAL_REGRESSION_FIXTURE,
    baselineObservations,
  ).metrics;
  const rocks = scoreRetrievalSuite(
    "lexical",
    RETRIEVAL_REGRESSION_FIXTURE,
    rocksObservations,
    { baseline },
  );
  assert.ok(rocks.metrics.recallAt3 >= baseline.recallAt3);
  assert.ok(rocks.metrics.meanReciprocalRank >= baseline.meanReciprocalRank);
  assert.equal(rocks.gate.status, "passed");
});

test("current statistics resolve through O(1) pointers without history scans", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "statistics-pointers"));
  t.after(() => store.close());
  await admit(store, "doc-stats", "current statistics pointer evidence");
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:statistics-pointers",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  let scans = 0;
  const observedView = {
    get: store.get.bind(store),
    scan(...arguments_) {
      scans += 1;
      return store.scan(...arguments_);
    },
  };
  const statistics = await readBm25Statistics(observedView, {
    project: "/fixture/project",
    terms: ["statist", "pointer"],
  });
  assert.equal(statistics.corpus.documentCount, 1);
  assert.equal(scans, 0);
});

test("expiring an old version preserves the newer BM25 pointer and final expiry clears statistics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "versioned-retention"));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:versioned-retention",
    handlers: [createBm25IndexHandler()],
  });
  await admit(store, "versioned", "oldterm historical evidence", {
    version: 1,
    createdAt: 10,
    expiresAt: 100,
  });
  await worker.drain();
  await admit(store, "versioned", "newterm replacement evidence", {
    version: 2,
    createdAt: 20,
    expiresAt: 1_000,
  });
  await worker.drain();

  await runRetention(store, { now: 200, force: false, batchSize: 10 });
  const current = await store.get(bm25Keys.current("/fixture/project", "versioned"));
  assert.equal(current.documentVersion, 2);
  assert.equal((await searchBm25(store, {
    query: "newterm",
    project: "/fixture/project",
    scope: "project",
  })).results[0].version, 2);
  let statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["oldterm", "newterm"],
  });
  assert.equal(statistics.corpus.documentCount, 1);
  assert.equal(statistics.terms.oldterm, undefined);
  assert.equal(statistics.terms.newterm.documentFrequency, 1);

  await runRetention(store, { now: 2_000, force: false, batchSize: 10 });
  statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["newterm"],
  });
  assert.equal(statistics.corpus.documentCount, 0);
  assert.equal(statistics.terms.newterm, undefined);
});
