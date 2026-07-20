import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { createNearDuplicateIndexHandler, simhashKeys } from "../src/rocksdb/index/simhash.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { searchArchive } from "../src/retrieval/search.js";

const PROJECT = "/workspace/dedup";
const SESSION = "session-dedup";

function temporaryStorePath(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-dedup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

async function fixture(t) {
  const store = await RocksStore.open(temporaryStorePath(t));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: "dedup-worker",
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
      createNearDuplicateIndexHandler(),
    ],
  });
  return { store, worker };
}

async function admit(store, documentId, text, createdAt) {
  return admitDocument(store, {
    idempotencyKey: `dedup:${documentId}`,
    document: {
      documentId,
      version: 1,
      sourceKey: `tool:${documentId}`,
      sessionId: SESSION,
      project: PROJECT,
      kind: "tool-result",
      createdAt,
      text,
      metadata: { turnId: `turn-${documentId}` },
      sourceMessageKeys: [`tool:${documentId}`],
    },
    structuralMessages: [{
      messageKey: `tool:${documentId}`,
      messageIndex: 0,
      role: "tool",
      createdAt,
      text,
      questionScore: 0,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 100,
    }],
    retentionClass: "conversation-source",
  }, {
    chunking: { maxChunkBytes: 4_096, minLineSplitBytes: 0 },
    windows: { windowTokens: 64, overlapTokens: 8 },
  });
}

function searchRequest(overrides = {}) {
  return {
    query: "checkout billing integration deterministic",
    relation: null,
    scope: "session",
    sessionId: SESSION,
    sessionIds: [SESSION],
    project: PROJECT,
    limit: 10,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
    ...overrides,
  };
}

const SUITE_BODY = Array.from({ length: 40 }, (_, index) => (
  `PASS src/module${index}/handler.spec.ts checkout billing integration assertion verified deterministic`
)).join("\n");
const RERUN_ALPHA = `${SUITE_BODY}\nRun completed in 8.21 seconds with 312 assertions.`;
const RERUN_BETA = `${SUITE_BODY}\nRun completed in 9.07 seconds with 312 assertions.`;
const DISTINCT_GAMMA = `checkout billing integration assertion deterministic\n${
  Array.from({ length: 40 }, (_, index) => (
    `FAIL src/other${index}/thing.spec.ts database migration ledger backfill invoice tenant rollback`
  )).join("\n")
}`;

test("explicit search collapses near-duplicate tool output onto one representative", async (t) => {
  const { store, worker } = await fixture(t);
  await admit(store, "rerun-alpha", RERUN_ALPHA, 100);
  await admit(store, "rerun-beta", RERUN_BETA, 200);
  await admit(store, "distinct-gamma", DISTINCT_GAMMA, 300);
  await worker.drain();

  // The derived signature is persisted as a versioned, replayable record.
  const signature = await store.snapshot((view) => view.get(
    simhashKeys.signature(PROJECT, "rerun-alpha", 1),
  ));
  assert.equal(signature.status, "complete");
  assert.match(signature.simhash, /^[0-9a-f]{16}$/u);

  const deduped = await searchArchive(store, searchRequest(), { now: 1_000, dedupe: true });
  const ids = deduped.results.map(({ documentId }) => documentId).sort();
  assert.deepEqual(ids, ["distinct-gamma", "rerun-alpha"]);
  const representative = deduped.results.find(({ documentId }) => documentId === "rerun-alpha");
  assert.equal(representative.nearDuplicates, 1);
  const distinct = deduped.results.find(({ documentId }) => documentId === "distinct-gamma");
  assert.equal(Object.hasOwn(distinct, "nearDuplicates"), false);
});

test("the automatic path (no dedupe opt-in) is unchanged and returns every near-duplicate", async (t) => {
  const { store, worker } = await fixture(t);
  await admit(store, "rerun-alpha", RERUN_ALPHA, 100);
  await admit(store, "rerun-beta", RERUN_BETA, 200);
  await admit(store, "distinct-gamma", DISTINCT_GAMMA, 300);
  await worker.drain();

  const plain = await searchArchive(store, searchRequest(), { now: 1_000 });
  const ids = plain.results.map(({ documentId }) => documentId).sort();
  assert.deepEqual(ids, ["distinct-gamma", "rerun-alpha", "rerun-beta"]);
  assert.ok(plain.results.every((result) => !Object.hasOwn(result, "nearDuplicates")));
});

test("dedup also collapses a semantic-broadened candidate against a lexical one, not just lexical-vs-lexical", async (t) => {
  const { store, worker } = await fixture(t);
  // Both documents share identical content, so they carry the same "complete"
  // near-duplicate signature once indexed, regardless of how each is later
  // discovered by search.
  await admit(store, "rerun-alpha", RERUN_ALPHA, 100);
  await admit(store, "rerun-beta", RERUN_BETA, 200);
  await worker.drain();

  // Exclude rerun-beta's own source key so the lexical/exact/structural passes
  // never surface it directly; only the fake semantic stub below does. This
  // reproduces the case a dedup pass running before semantic broadening could
  // never see: a same-cluster candidate that only exists once the semantic
  // pass has already run.
  const fakeSemantic = {
    search: async () => [{
      documentId: "rerun-beta",
      version: 1,
      kind: "tool-result",
      createdAt: 200,
      project: PROJECT,
      sessionId: SESSION,
      sourceMessageKeys: ["tool:rerun-beta"],
      windowOrdinal: 0,
      startByte: 0,
      endByte: Buffer.byteLength(RERUN_BETA, "utf8"),
      text: RERUN_BETA,
      score: 0.9,
    }],
  };
  const deduped = await searchArchive(store, searchRequest({
    excludeVisibleSourceKeys: ["tool:rerun-beta"],
    semanticPolicy: "always",
  }), { now: 1_000, dedupe: true, semantic: fakeSemantic });

  // Whichever of the two wins the post-fusion ranking (mode priority is tied
  // between lexical and semantic, so it comes down to normalized score) ends
  // up as the sole representative; the point under test is that exactly one
  // survives at all, proving the two candidates were compared for clustering
  // after semantic broadening ran, not before.
  assert.equal(deduped.results.length, 1);
  assert.equal(deduped.results[0].nearDuplicates, 1);
});
