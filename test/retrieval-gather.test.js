import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { gatherArchive } from "../src/retrieval/gather.js";

const PROJECT = "/workspace/gather";

function request(id, text, createdAt, sessionId = "session-main") {
  const sourceKey = `user:${id}`;
  return {
    idempotencyKey: `gather:${id}`,
    document: {
      documentId: id,
      version: 1,
      sourceKey,
      sessionId,
      project: PROJECT,
      kind: "turn",
      createdAt,
      text,
      metadata: { turnId: `turn-${id}` },
      sourceMessageKeys: [sourceKey],
    },
    structuralMessages: [{
      messageKey: sourceKey,
      messageIndex: 0,
      role: "user",
      createdAt,
      text,
      questionScore: 80,
      requestScore: 80,
      correctionScore: 0,
      answerScore: 0,
    }],
    retentionClass: "conversation-source",
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-gather-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const worker = new IndexWorker(store, {
    workerId: "gather-worker",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  const admit = async (id, text, createdAt, sessionId) => {
    await admitDocument(store, request(id, text, createdAt, sessionId), {
      chunking: { maxChunkBytes: 128, minLineSplitBytes: 0 },
      windows: { windowTokens: 16, overlapTokens: 2 },
    });
  };
  return { store, worker, admit };
}

function gatherRequest(overrides = {}) {
  return {
    query: "River gauge reading units change now",
    intent: "state",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 5,
    before: 0,
    after: 0,
    neighborhoodAnchors: 2,
    maxEvidence: 8,
    maxTokens: 2_000,
    excludeVisibleSourceKeys: [],
    ...overrides,
  };
}

test("state gather forces hybrid broadening and materializes distinct dated values", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("old-state", "River gauge reading was exactly 24 units.", 100);
  await admit("noise", "Unrelated historical equipment note.", 200);
  await admit("new-state", "River gauge reading is close to 30 units now.", 300);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  let semanticCalls = 0;
  const gather = await gatherArchive(store, gatherRequest(), {
    project: PROJECT,
    now: 1_000,
    semantic: {
      search: async () => {
        semanticCalls += 1;
        return [];
      },
    },
  });

  assert.equal(semanticCalls, 1);
  assert.equal(gather.status, "resolved");
  assert.equal(gather.mode, "hybrid");
  assert.deepEqual(gather.evidence.map(({ document }) => document.documentId), [
    "old-state",
    "new-state",
  ]);
  assert.match(gather.evidence[0].document.text, /exactly 24/u);
  assert.match(gather.evidence[1].document.text, /close to 30/u);
  assert.ok(gather.returnedTokens <= 2_000);
  assert.ok(gather.evidence.every(({ document }) => document.sourceMessages.status === "available"));
});

test("workflow gather follows bounded successors on the anchor branch", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("anchor", "Prior deployment workflow starts by preparing the artifact.", 100);
  await admit("account", "Before publishing, switch to the service account.", 110);
  await admit("verify", "Then publish the tag and verify the registry.", 120);
  await admit("sibling", "Use a personal account instead.", 115, "session-sibling");
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "Prior deployment workflow",
    intent: "workflow",
    scope: "project",
    sessionIds: [],
    limit: 1,
    before: 0,
    after: 2,
    neighborhoodAnchors: 1,
    maxEvidence: 3,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.deepEqual(gather.evidence.map(({ document }) => document.documentId), [
    "anchor",
    "account",
    "verify",
  ]);
  assert.deepEqual(gather.evidence.map(({ relation }) => relation), ["anchor", "after", "after"]);
  assert.doesNotMatch(gather.evidence.map(({ document }) => document.text).join("\n"), /personal account/u);
});

test("gather reports continuation and obeys aggregate evidence bounds", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("anchor", "Reusable migration procedure anchor.", 100);
  await admit("step-1", "First continuation detail.", 110);
  await admit("step-2", "Second continuation detail.", 120);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "Reusable migration procedure anchor",
    intent: "workflow",
    limit: 1,
    before: 0,
    after: 1,
    neighborhoodAnchors: 1,
    maxEvidence: 2,
    maxTokens: 128,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.equal(gather.truncated, true);
  assert.equal(gather.hasMore, true);
  assert.equal(gather.evidence.length, 2);
  assert.ok(gather.returnedTokens <= 128);
  assert.deepEqual(gather.evidence.map(({ document }) => document.documentId), ["anchor", "step-1"]);
});

test("gather carries a search-ranked score only on anchor evidence, never on traversal neighbors", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("anchor", "Reusable migration procedure anchor.", 100);
  await admit("step-1", "First continuation detail.", 110);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "Reusable migration procedure anchor",
    intent: "workflow",
    limit: 1,
    before: 0,
    after: 1,
    neighborhoodAnchors: 1,
    maxEvidence: 2,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.deepEqual(gather.evidence.map(({ relation }) => relation), ["anchor", "after"]);
  const [anchor, after] = gather.evidence;
  assert.equal(typeof anchor.score, "number");
  assert.ok(anchor.score >= 0 && anchor.score <= 1);
  assert.equal(anchor.retrievalMode, "lexical");
  assert.equal(Object.hasOwn(after, "score"), false);
  assert.equal(Object.hasOwn(after, "retrievalMode"), false);
});

// Same RM3 fixture shape as test/retrieval-search.test.js's
// seedExpansionFixture, except the first-pass lexical anchor ("primary")
// matches every query term (full coverage) instead of just one: gather never
// sets options.allowExpansion on its own (RM3 stays off for gather by
// default, unlike explicit search), so this fixture must isolate
// searchEffort's own wide-vs-normal wiring rather than the weak-evidence
// threshold retrieval-search.test.js already covers.
async function seedGatherExpansionFixture(admit) {
  await admit("primary", "gadget widget contraption zephyrindex updates important", 100);
  await admit("expansion-target", "zephyrindex rotation cadence review important", 150);
  await admit("filler-1", "maintenance notes for the archive process are important", 160);
  await admit("filler-2", "schedule updates happen every maintenance cycle", 170);
  await admit("filler-3", "important notes about schedule updates continue", 180);
}

test("gather never runs RM3 expansion by default, even with strong first-pass evidence", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await seedGatherExpansionFixture(admit);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "gadget widget contraption",
    intent: "state",
    limit: 10,
    maxEvidence: 10,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.deepEqual(gather.evidence.map(({ document }) => document.documentId), ["primary"]);
});

test("gather's searchEffort: wide grants its internal search call the RM3 expansion opt-in it never grants by default", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await seedGatherExpansionFixture(admit);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "gadget widget contraption",
    intent: "state",
    limit: 10,
    maxEvidence: 10,
    searchEffort: "wide",
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  // The RM3 requery's literalTerms (e.g. "important"/"updates") also widen the
  // underlying BM25 query itself, so filler documents sharing that vocabulary
  // legitimately join the result too; the assertion that matters here is that
  // the expansion-only target -- absent above with the identical fixture and
  // request minus searchEffort -- is now reachable at all.
  assert.ok(
    gather.evidence.some(({ document }) => document.documentId === "expansion-target"),
    "searchEffort: wide must surface the RM3-expansion-only document",
  );
  assert.ok(gather.evidence.some(({ document }) => document.documentId === "primary"));
});

test("gather forwards workingSet through to its internal search call and surfaces boosted-anchor provenance", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("anchor", "Reusable migration procedure PALLET_ROUTE_PLANNER anchor.", 100);
  await admit("step-1", "First continuation detail.", 110);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "Reusable migration procedure anchor",
    workingSet: ["PALLET_ROUTE_PLANNER"],
    intent: "workflow",
    limit: 1,
    before: 0,
    after: 1,
    neighborhoodAnchors: 1,
    maxEvidence: 2,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.deepEqual(gather.evidence.map(({ relation }) => relation), ["anchor", "after"]);
  const [anchor, after] = gather.evidence;
  // The anchor's own document carries the working-set anchor's exact
  // posting, so the boost's provenance survives gather's own evidence
  // shaping; the chronological "after" neighbor is never a ranked hit (see
  // the score/retrievalMode test above) and never carries it either.
  assert.deepEqual(anchor.workingSetAnchors, ["PALLET_ROUTE_PLANNER"]);
  assert.equal(Object.hasOwn(after, "workingSetAnchors"), false);
});

// Same wiring regression as the workingSet test above, for sessionContext
// (ultracode task #32).
test("gather forwards sessionContext through to its internal search call and surfaces boosted-anchor provenance", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("anchor", "Reusable migration procedure PALLET_INVENTORY_TRACKER anchor.", 100);
  await admit("step-1", "First continuation detail.", 110);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "Reusable migration procedure anchor",
    sessionContext: ["PALLET_INVENTORY_TRACKER"],
    intent: "workflow",
    limit: 1,
    before: 0,
    after: 1,
    neighborhoodAnchors: 1,
    maxEvidence: 2,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.deepEqual(gather.evidence.map(({ relation }) => relation), ["anchor", "after"]);
  const [anchor, after] = gather.evidence;
  assert.ok(anchor.sessionContextTerms.length > 0);
  assert.equal(Object.hasOwn(after, "sessionContextTerms"), false);
});

test("gather surfaces a tombstoned document with no live replacement as an expired-match count, never its content", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("expired-doc", "GATHER_EXPIRED_ANCHOR sensitive prior detail.", 100);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });
  await store.put([KEYSPACE.SUPERSESSION, "expired-doc", 1], {
    documentId: "expired-doc",
    documentVersion: 1,
    status: "expired",
    reason: "Retention class conversation-source expired.",
    recordedAt: 2_000,
  });

  const gather = await gatherArchive(store, gatherRequest({
    query: "GATHER_EXPIRED_ANCHOR",
    scope: "session",
    sessionIds: ["session-main"],
  }), {
    project: PROJECT,
    now: 3_000,
  });

  assert.equal(gather.status, "not-found");
  assert.equal(gather.evidence.length, 0);
  assert.deepEqual(gather.expiredMatches, { count: 1, retentionClasses: ["conversation-source"] });
  assert.equal(JSON.stringify(gather).includes("sensitive prior detail"), false);
});

test("gather omits an expiredMatches count when nothing expired", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("only-doc", "GATHER_LIVE_ANCHOR still current detail.", 100);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    query: "GATHER_LIVE_ANCHOR",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 1,
    neighborhoodAnchors: 1,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.equal(gather.status, "resolved");
  assert.deepEqual(gather.expiredMatches, { count: 0, retentionClasses: [] });
});
