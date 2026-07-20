import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { recallArchive } from "../src/retrieval/recall.js";
import { searchArchive } from "../src/retrieval/search.js";
import { traverseArchive } from "../src/retrieval/traverse.js";

function request(id, text, createdAt, overrides = {}) {
  const sourceKey = `user:${id}`;
  return {
    idempotencyKey: `traverse:${id}`,
    document: {
      documentId: id,
      version: 1,
      sourceKey,
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/workspace/traverse",
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
      questionScore: 100,
      requestScore: 80,
      correctionScore: 0,
      answerScore: 0,
    }],
    retentionClass: "conversation-source",
  };
}

async function admit(store, id, text, createdAt, overrides) {
  await admitDocument(store, request(id, text, createdAt, overrides), {
    chunking: { maxChunkBytes: 128, minLineSplitBytes: 0 },
    windows: { windowTokens: 16, overlapTokens: 2 },
  });
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-traverse-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const worker = new IndexWorker(store, {
    workerId: "traverse-worker",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  return { store, worker };
}

async function anchorLocator(store, worker) {
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });
  const search = await searchArchive(store, {
    query: "AIR_FRYER_ANCHOR",
    relation: null,
    scope: "session",
    sessionId: "session-main",
    sessionIds: ["session-main"],
    project: "/workspace/traverse",
    limit: 3,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 0,
  }, { now: 10_000 });
  assert.equal(search.results.length, 1);
  return search.results[0].locator;
}

test("bounded chronological traversal returns leased, recallable prior evidence", async (t) => {
  const { store, worker } = await fixture(t);
  await admit(store, "instant", "Earlier purchase was an INSTANT_POT_TARGET pressure cooker.", 100);
  await admit(store, "middle", "An unrelated middle event.", 200);
  await admit(store, "air", "Later purchase was the AIR_FRYER_ANCHOR appliance.", 300);
  await admit(store, "after", "A later countertop blender.", 400);
  await admit(store, "foreign", "Foreign-session evidence.", 250, { sessionId: "session-foreign" });
  const locator = await anchorLocator(store, worker);

  const before = await traverseArchive(store, {
    locator,
    direction: "before",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 2,
    scanLimit: 100,
  }, { project: "/workspace/traverse", now: 10_100 });

  assert.equal(before.status, "resolved");
  assert.equal(before.truncated, false);
  assert.equal(before.hasMore, false);
  assert.deepEqual(before.results.map(({ documentId }) => documentId), ["middle", "instant"]);
  assert.ok(before.scanned <= 5);
  assert.match(before.results[1].locator, /^cw1\./u);
  const claims = JSON.parse(Buffer.from(before.results[1].locator.split(".")[1], "base64url"));
  assert.equal(claims.sessionId, "session-main", JSON.stringify(claims));
  assert.doesNotMatch(before.results.map(({ snippet }) => snippet).join(" "), /Foreign-session/u);

  const recalled = await recallArchive(store, {
    locator: before.results[1].locator,
    neighbors: 0,
    maxTokens: 256,
    sessionIds: ["session-main"],
  }, { project: "/workspace/traverse", sessionIds: ["session-main"], now: 10_200 });
  assert.equal(recalled.status, "resolved", JSON.stringify(recalled));
  assert.match(recalled.text, /INSTANT_POT_TARGET/u);

  const after = await traverseArchive(store, {
    locator,
    direction: "after",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 1,
    scanLimit: 100,
  }, { project: "/workspace/traverse", now: 10_300 });
  assert.deepEqual(after.results.map(({ documentId }) => documentId), ["after"]);
});

test("chronological continuation reaches targets beyond 128 records without gaps", async (t) => {
  const { store, worker } = await fixture(t);
  for (let index = 0; index < 140; index += 1) {
    const text = index === 5 ? "DISTANT_TEMPORAL_TARGET generic prior purchase" : `Historical event ${index}.`;
    await admit(store, `history-${String(index).padStart(3, "0")}`, text, 100 + index);
  }
  await admit(store, "air", "AIR_FRYER_ANCHOR", 1_000);
  const locator = await anchorLocator(store, worker);

  const first = await traverseArchive(store, {
    locator,
    direction: "before",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 128,
    scanLimit: 1_000,
  }, { project: "/workspace/traverse", now: 10_100 });
  assert.equal(first.results.length, 128);
  assert.equal(first.hasMore, true);
  assert.equal(first.results.some(({ snippet }) => /DISTANT_TEMPORAL_TARGET/u.test(snippet)), false);

  const second = await traverseArchive(store, {
    locator: first.results.at(-1).locator,
    direction: "before",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 128,
    scanLimit: 1_000,
  }, { project: "/workspace/traverse", now: 10_200 });
  assert.equal(second.hasMore, false);
  assert.equal(second.results.some(({ snippet }) => /DISTANT_TEMPORAL_TARGET/u.test(snippet)), true);
});

test("traversal enforces locator authorization and reports bounded scans", async (t) => {
  const { store, worker } = await fixture(t);
  for (let index = 0; index < 8; index += 1) {
    await admit(store, `doc-${index}`, `Historical event ${index}.`, 100 + index);
  }
  await admit(store, "air", "AIR_FRYER_ANCHOR", 1_000);
  const locator = await anchorLocator(store, worker);

  const bounded = await traverseArchive(store, {
    locator,
    direction: "before",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 2,
    scanLimit: 3,
  }, { project: "/workspace/traverse", now: 10_100 });
  assert.equal(bounded.scanned, 3);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.hasMore, true);
  assert.ok(bounded.results.length <= 2);

  await assert.rejects(
    traverseArchive(store, {
      locator,
      direction: "before",
      scope: "session",
      sessionIds: ["session-main"],
      limit: 2,
      scanLimit: 10,
    }, { project: "/workspace/other", now: 10_100 }),
    /project|authorized/iu,
  );
});
