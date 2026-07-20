import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { searchArchive } from "../src/retrieval/search.js";
import { recallArchive } from "../src/retrieval/recall.js";
import { createDaemonOperations } from "../src/daemon/operations.js";
import {
  documentRecallCount,
  feedbackKeys,
  locatorFingerprint,
  recordRecalledLocator,
  recordShownResults,
  relevanceFeedbackStats,
} from "../src/retrieval/relevance-feedback.js";

const PROJECT = "/workspace/feedback";
const SECRET = Buffer.alloc(32, 0x31);

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function putRequest(id, text, overrides = {}) {
  const version = overrides.version ?? 1;
  const sourceKey = `user:${id}:${version}`;
  return {
    idempotencyKey: `feedback:${id}:${version}`,
    document: {
      documentId: id,
      version,
      sourceKey,
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? PROJECT,
      kind: "turn",
      createdAt: overrides.createdAt ?? version * 100,
      text,
      metadata: { turnId: `turn-${id}` },
      sourceMessageKeys: [sourceKey],
    },
    structuralMessages: [{
      messageKey: sourceKey,
      messageIndex: 0,
      role: "user",
      createdAt: overrides.createdAt ?? version * 100,
      text,
      questionScore: 100,
      requestScore: 80,
      correctionScore: 0,
      answerScore: 0,
    }],
    retentionClass: "conversation-source",
  };
}

async function admit(store, id, text, overrides = {}) {
  return admitDocument(store, putRequest(id, text, overrides), {
    chunking: { maxChunkBytes: 48, minLineSplitBytes: 0 },
    windows: { windowTokens: 8, overlapTokens: 2 },
  });
}

async function fixture(t, name) {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `feedback-worker:${name}`,
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
    ],
  });
  return { store, worker };
}

function searchRequest(query, overrides = {}) {
  return {
    query,
    relation: null,
    scope: "session",
    sessionId: "session-main",
    project: PROJECT,
    limit: overrides.limit ?? 5,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  };
}

function recorder(store, extra = {}) {
  return { recordShownResults: (event) => recordShownResults(store, { ...event, ...extra }) };
}

test("search logs shown results and a later recall joins by locator fingerprint", async (t) => {
  const { store, worker } = await fixture(t, "join");
  await admit(store, "alpha", "the shutdown drain prevents accepting new work");
  await admit(store, "beta", "REAP_DRAIN prevents accepting work during shutdown", { createdAt: 200 });
  await worker.drain();

  const lexical = await searchArchive(store, searchRequest("shutdown drain"), {
    secret: SECRET,
    now: 1_000,
    ...recorder(store),
  });
  assert.equal(lexical.mode, "lexical");
  assert.ok(lexical.results.length >= 1);

  const exact = await searchArchive(store, searchRequest("REAP_DRAIN"), {
    secret: SECRET,
    now: 1_100,
    ...recorder(store),
  });
  assert.equal(exact.mode, "exact");
  assert.ok(exact.results.length >= 1);

  const events = store.scan(feedbackKeys.eventPrefix(PROJECT));
  assert.equal(events.length, 2);
  const lexicalEvent = events.find(({ payload }) => payload.queryKey === "shutdown drain").payload;
  assert.equal(lexicalEvent.shown.length, lexical.results.length);
  assert.equal(lexicalEvent.shown[0].retrievalMode, "lexical");
  assert.equal(
    lexicalEvent.shown[0].locatorFingerprint,
    locatorFingerprint(lexical.results[0].locator),
  );
  // Only ids/scores/fingerprints are stored, never snippet text.
  assert.equal(Object.hasOwn(lexicalEvent.shown[0], "snippet"), false);

  const recalled = await recallArchive(store, {
    locator: lexical.results[0].locator,
    neighbors: 0,
    maxTokens: 100,
  }, { project: PROJECT, sessionIds: ["session-main"], secret: SECRET, now: 2_000 });
  assert.equal(recalled.status, "resolved");

  const join = await recordRecalledLocator(store, {
    project: PROJECT,
    locator: lexical.results[0].locator,
    status: recalled.status,
    now: 2_000,
  });
  assert.deepEqual(join, { joined: true });
  // The durable per-document recall tally (read by the importance batch job)
  // increments on the resolved join, keyed by the recalled document/version,
  // and stays 0 for a document that was shown but never recalled.
  const recalledDocumentId = lexical.results[0].documentId;
  const shownOnlyDocumentId = exact.results[0].documentId;
  assert.equal(
    await documentRecallCount(store, { project: PROJECT, documentId: recalledDocumentId, version: 1 }),
    1,
  );
  assert.equal(
    await documentRecallCount(store, { project: PROJECT, documentId: shownOnlyDocumentId, version: 1 }),
    0,
  );

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.events, 2);
  assert.equal(stats.shownTotal, lexical.results.length + exact.results.length);
  assert.equal(stats.recalledTotal, 1);
  assert.equal(stats.byMode.lexical.recalled, 1);
  assert.equal(stats.byRank[0].recalled, 1);
  const lexicalQuery = stats.queries.find((entry) => entry.query === "shutdown drain");
  assert.equal(lexicalQuery.recalled, 1);
  const exactQuery = stats.queries.find((entry) => entry.query === "REAP_DRAIN");
  assert.equal(exactQuery.recalled, 0);

  // Recording the same recall again is idempotent.
  const again = await recordRecalledLocator(store, {
    project: PROJECT,
    locator: lexical.results[0].locator,
    status: "resolved",
    now: 3_000,
  });
  assert.deepEqual(again, { joined: true, alreadyRecorded: true });
  assert.equal((await relevanceFeedbackStats(store, { project: PROJECT })).recalledTotal, 1);
  // The idempotent re-join must not double-count the durable recall tally.
  assert.equal(
    await documentRecallCount(store, { project: PROJECT, documentId: recalledDocumentId, version: 1 }),
    1,
  );
});

test("recall of a locator never shown, or shown under another project, does not join", async (t) => {
  const { store, worker } = await fixture(t, "isolation");
  await admit(store, "alpha", "the shutdown drain prevents accepting new work");
  await worker.drain();

  const search = await searchArchive(store, searchRequest("shutdown drain"), {
    secret: SECRET,
    now: 1_000,
    ...recorder(store),
  });
  assert.ok(search.results.length >= 1);

  const unseen = await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.never-shown.locator",
    status: "resolved",
    now: 2_000,
  });
  assert.deepEqual(unseen, { joined: false });

  // Same real locator, different project boundary: the join namespace is scoped
  // per project, so it must not attribute a recall across projects.
  const crossProject = await recordRecalledLocator(store, {
    project: "/workspace/other",
    locator: search.results[0].locator,
    status: "resolved",
    now: 2_000,
  });
  assert.deepEqual(crossProject, { joined: false });

  assert.equal((await relevanceFeedbackStats(store, { project: PROJECT })).recalledTotal, 0);
});

test("the per-project event ring bounds retention and cleans up its locator index", async (t) => {
  const { store } = await fixture(t, "ring");
  const fingerprints = [];
  for (let index = 0; index < 5; index += 1) {
    const locator = `cw1.synthetic.${index}`;
    fingerprints.push(locatorFingerprint(locator));
    await recordShownResults(store, {
      project: PROJECT,
      query: `query-${index}`,
      mode: "lexical",
      status: "resolved",
      now: 1_000 + index,
      maxEvents: 3,
      results: [{
        documentId: `doc-${index}`,
        version: 1,
        retrievalMode: "lexical",
        calibratedScore: 0.5,
        rawScore: 1.2,
        locator,
      }],
    });
  }

  const events = store.scan(feedbackKeys.eventPrefix(PROJECT));
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(({ payload }) => payload.seq), [3, 4, 5]);
  // Evicted events (seq 1,2) also drop their locator index entries.
  assert.equal(await store.get(feedbackKeys.locator(PROJECT, fingerprints[0])), undefined);
  assert.equal(await store.get(feedbackKeys.locator(PROJECT, fingerprints[1])), undefined);
  assert.notEqual(await store.get(feedbackKeys.locator(PROJECT, fingerprints[4])), undefined);

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.events, 3);
  assert.equal(stats.shownTotal, 3);
});

test("daemon search and recall wiring records feedback and serves stats", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "daemon"));
  const runtime = await createDaemonOperations(store, {});
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const context = { project: PROJECT };

  await runtime.put(putRequest("alpha", "the shutdown drain prevents accepting new work"), context);
  await runtime.put(
    putRequest("beta", "REAP_DRAIN prevents accepting work during shutdown", { createdAt: 200 }),
    context,
  );
  await runtime.drainIndex({ throwOnError: true, limit: 1_000, maxDurationMs: 30_000 });

  const search = await runtime.search(searchRequest("shutdown drain"), context);
  assert.ok(search.results.length >= 1);

  const recalled = await runtime.recall({
    locator: search.results[0].locator,
    neighbors: 0,
    maxTokens: 100,
    sessionIds: ["session-main"],
  }, context);
  assert.equal(recalled.status, "resolved");

  const stats = await runtime.feedbackStats({}, context);
  assert.equal(stats.events, 1);
  assert.equal(stats.recalledTotal, 1);
  assert.equal(stats.queries[0].query, "shutdown drain");
  assert.equal(stats.queries[0].recalled, 1);
  assert.deepEqual(runtime.backgroundErrors, []);
});
