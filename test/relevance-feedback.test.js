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
  // searchRequest() scopes to sessionId "session-main"; that session id must
  // reach the stored event so reformulation-chain analysis can key on it.
  assert.deepEqual(lexicalEvent.sessionIds, ["session-main"]);
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

test("a zero-recall search followed by a differently-worded search that resolves is a reformulation chain", async (t) => {
  const { store } = await fixture(t, "chain-detected");
  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    sessionIds: ["session-chain"],
    now: 1_000,
    results: [{
      documentId: "doc-foo",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.chain.foo",
    }],
  }); // shown, never recalled: a below-the-fold-candidate miss.

  await recordShownResults(store, {
    project: PROJECT,
    query: "bar",
    sessionIds: ["session-chain"],
    now: 1_001,
    results: [{
      documentId: "doc-bar",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.chain.bar",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.chain.bar",
    status: "resolved",
    now: 1_002,
  });

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.chainCount, 1);
  assert.equal(stats.chainRate, 1 / 2);
  assert.deepEqual(stats.chains, [{
    sessionId: "session-chain",
    missQueryKey: "foo",
    missSeq: 1,
    hitQueryKey: "bar",
    hitSeq: 2,
  }]);
  assert.deepEqual(new Set(stats.chainQueryKeys), new Set(["foo", "bar"]));
});

test("a same-queryKey retry that eventually resolves is not a reformulation chain", async (t) => {
  const { store } = await fixture(t, "chain-retry");
  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    sessionIds: ["session-retry"],
    now: 1_000,
    results: [{
      documentId: "doc-foo-1",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.retry.foo-1",
    }],
  }); // shown, never recalled.

  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    sessionIds: ["session-retry"],
    now: 1_001,
    results: [{
      documentId: "doc-foo-2",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.retry.foo-2",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.retry.foo-2",
    status: "resolved",
    now: 1_002,
  });

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.chainCount, 0);
  assert.deepEqual(stats.chains, []);
  assert.deepEqual(stats.chainQueryKeys, []);
});

test("a miss in one session and a hit in another session are not linked into a chain", async (t) => {
  const { store } = await fixture(t, "chain-cross-session");
  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    sessionIds: ["session-a"],
    now: 1_000,
    results: [{
      documentId: "doc-foo",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.cross.foo",
    }],
  }); // shown, never recalled, in session-a.

  await recordShownResults(store, {
    project: PROJECT,
    query: "bar",
    sessionIds: ["session-b"],
    now: 1_001,
    results: [{
      documentId: "doc-bar",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.cross.bar",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.cross.bar",
    status: "resolved",
    now: 1_002,
  }); // resolved, but in session-b: a different conversation than the miss.

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.chainCount, 0);
  assert.deepEqual(stats.chains, []);
  assert.deepEqual(stats.chainQueryKeys, []);
});

test("a search recorded with no session id never participates in a chain", async (t) => {
  const { store } = await fixture(t, "chain-no-session");
  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    now: 1_000, // no sessionIds supplied: fails closed rather than joining by chance.
    results: [{
      documentId: "doc-foo",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.nosession.foo",
    }],
  });
  await recordShownResults(store, {
    project: PROJECT,
    query: "bar",
    now: 1_001,
    results: [{
      documentId: "doc-bar",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.nosession.bar",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.nosession.bar",
    status: "resolved",
    now: 1_002,
  });

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.chainCount, 0);
});

test("a multi-id session lineage counts one reformulation chain, not one per shared session id", async (t) => {
  // Resumed/forked sessions report every ancestor id (pi.ts ancestorSessionIds,
  // permitted up to 65 ids by the store.search request contract), so a miss and
  // its resolving hit routinely share more than one session id. That must still
  // be a single chain, not one per shared id.
  const { store } = await fixture(t, "chain-multi-session-lineage");
  await recordShownResults(store, {
    project: PROJECT,
    query: "foo",
    sessionIds: ["session-root", "session-fork-1", "session-fork-2"],
    now: 1_000,
    results: [{
      documentId: "doc-foo",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.multi.foo",
    }],
  }); // shown, never recalled, under a 3-id session lineage.

  await recordShownResults(store, {
    project: PROJECT,
    query: "bar",
    sessionIds: ["session-root", "session-fork-1", "session-fork-2"],
    now: 1_001,
    results: [{
      documentId: "doc-bar",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.multi.bar",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.multi.bar",
    status: "resolved",
    now: 1_002,
  });

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  // Before the dedupe fix this counted once per shared session id (3), pushing
  // chainRate past the normalizedScore max of 1 and failing store-contract
  // validation outright.
  assert.equal(stats.chainCount, 1);
  assert.equal(stats.chains.length, 1);
  assert.equal(stats.chains[0].missSeq, 1);
  assert.equal(stats.chains[0].hitSeq, 2);
  assert.ok(stats.chainRate <= 1);
});

test("a miss resolved via one session of a lineage stays closed in a sibling session, not re-chained by a later hit", async (t) => {
  // Reproduces a split-lineage double count: a miss recorded under
  // [session-root, session-fork] resolves via a hit that only carries
  // session-root. That must close the miss in session-fork too, or a later
  // hit that does carry session-fork re-resolves the same miss under a new
  // hitSeq, inflating chainCount past one chain per miss (and chainRate past
  // the normalizedScore max of 1, which used to throw a ContractError out of
  // relevanceFeedbackStats).
  const { store } = await fixture(t, "chain-lineage-split");
  for (const [query, locator] of [
    ["foo", "cw1.split.foo"],
    ["baz", "cw1.split.baz"],
    ["qux", "cw1.split.qux"],
  ]) {
    await recordShownResults(store, {
      project: PROJECT,
      query,
      sessionIds: ["session-root", "session-fork"],
      now: 1_000,
      results: [{
        documentId: `doc-${query}`,
        version: 1,
        retrievalMode: "lexical",
        calibratedScore: 0.5,
        rawScore: 1.2,
        locator,
      }],
    }); // shown, never recalled, under a 2-id session lineage.
  }

  await recordShownResults(store, {
    project: PROJECT,
    query: "bar",
    sessionIds: ["session-root"],
    now: 1_003,
    results: [{
      documentId: "doc-bar",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.split.bar",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.split.bar",
    status: "resolved",
    now: 1_004,
  }); // resolves in session-root only: must close the miss in session-fork too.

  await recordShownResults(store, {
    project: PROJECT,
    query: "quux",
    sessionIds: ["session-root", "session-fork"],
    now: 1_005,
    results: [{
      documentId: "doc-quux",
      version: 1,
      retrievalMode: "lexical",
      calibratedScore: 0.5,
      rawScore: 1.2,
      locator: "cw1.split.quux",
    }],
  });
  await recordRecalledLocator(store, {
    project: PROJECT,
    locator: "cw1.split.quux",
    status: "resolved",
    now: 1_006,
  }); // resolves in both ids: must not re-chain the misses hit1 already closed.

  const stats = await relevanceFeedbackStats(store, { project: PROJECT });
  assert.equal(stats.events, 5);
  assert.equal(stats.chainCount, 3);
  assert.equal(stats.chains.length, 3);
  assert.deepEqual(
    stats.chains.map((chain) => `${chain.missSeq}:${chain.hitSeq}`).sort(),
    ["1:4", "2:4", "3:4"],
  );
  assert.ok(stats.chainRate <= 1);
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
