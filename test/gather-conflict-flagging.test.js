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
import { detectPossibleConflicts, gatherArchive } from "../src/retrieval/gather.js";
import { formatGatherResults } from "../src/presentation.js";
import { estimateModelVisibleTokens } from "../src/session/model-token-budget.js";

const PROJECT = "/workspace/gather-conflicts";

function descriptor(overrides = {}) {
  return {
    ref: "ref",
    documentId: "doc",
    version: 1,
    subjectKey: undefined,
    supersedes: undefined,
    text: "",
    anchorKeys: new Set(),
    ...overrides,
  };
}

// Mirrors the real key format production strongAnchorKeys() builds
// (type::folded-value, gather.js), so this pins the actual contract between
// detectPossibleConflicts and its caller instead of an internally-consistent
// but disconnected stand-in.
const PATH_ANCHOR = "path::src/cache/redis-client.js";

test("detectPossibleConflicts: shared strong anchor + opposing decision cues flags both evidence refs", () => {
  const left = descriptor({
    ref: "left-ref",
    documentId: "left-doc",
    text: "We decided to use src/cache/redis-client.js for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const right = descriptor({
    ref: "right-ref",
    documentId: "right-doc",
    text: "Actually we rejected src/cache/redis-client.js instead of memcached for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const conflicts = detectPossibleConflicts([left, right]);
  assert.deepEqual(conflicts.get("left-ref"), ["right-ref"]);
  assert.deepEqual(conflicts.get("right-ref"), ["left-ref"]);
});

test("detectPossibleConflicts: shared subjectKey lineage alone (no anchor overlap) also flags the pair", () => {
  const left = descriptor({
    ref: "left-ref",
    documentId: "left-doc",
    subjectKey: "cache-library-choice",
    text: "We decided on this approach for the cache layer.",
  });
  const right = descriptor({
    ref: "right-ref",
    documentId: "right-doc",
    subjectKey: "cache-library-choice",
    text: "We rejected that approach instead for the cache layer.",
  });
  const conflicts = detectPossibleConflicts([left, right]);
  assert.deepEqual(conflicts.get("left-ref"), ["right-ref"]);
  assert.deepEqual(conflicts.get("right-ref"), ["left-ref"]);
});

test("detectPossibleConflicts: an explicit supersession link between the pair suppresses the flag", () => {
  const left = descriptor({
    ref: "left-ref",
    documentId: "left-doc",
    version: 1,
    text: "We decided to use src/cache/redis-client.js for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const right = descriptor({
    ref: "right-ref",
    documentId: "right-doc",
    version: 1,
    text: "We rejected src/cache/redis-client.js instead of memcached for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
    // Formally reconciled: right explicitly supersedes left.
    supersedes: { documentId: "left-doc", version: 1 },
  });
  const conflicts = detectPossibleConflicts([left, right]);
  assert.equal(conflicts.has("left-ref"), false);
  assert.equal(conflicts.has("right-ref"), false);
});

test("detectPossibleConflicts: an unrelated pair (no shared subject signal) is not flagged", () => {
  const left = descriptor({
    ref: "left-ref",
    documentId: "left-doc",
    text: "We decided to use src/cache/redis-client.js for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const right = descriptor({
    ref: "right-ref",
    documentId: "right-doc",
    text: "We rejected npm-package-foo instead of npm-package-bar for logging.",
    anchorKeys: new Set(["path::src/logging/writer.js"]),
  });
  const conflicts = detectPossibleConflicts([left, right]);
  assert.equal(conflicts.has("left-ref"), false);
  assert.equal(conflicts.has("right-ref"), false);
});

test("detectPossibleConflicts: shared subject signal without opposing cues is not flagged", () => {
  const left = descriptor({
    ref: "left-ref",
    documentId: "left-doc",
    text: "We decided to use src/cache/redis-client.js for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const right = descriptor({
    ref: "right-ref",
    documentId: "right-doc",
    text: "We also settled on src/cache/redis-client.js after review.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const conflicts = detectPossibleConflicts([left, right]);
  assert.equal(conflicts.has("left-ref"), false);
  assert.equal(conflicts.has("right-ref"), false);
});

test("detectPossibleConflicts: caps a single item's refs at 8 even when more than 8 others conflict with it", () => {
  // One affirming document sharing a path anchor with 11 reversal documents:
  // every reversal conflicts with the affirming one (and, transitively,
  // shares the same anchor and opposing cues with every other reversal too),
  // so the affirming item alone would collect 11 refs without the cap -- one
  // more than the store-contract-schema.js possiblyConflicting maxItems (8).
  const affirming = descriptor({
    ref: "affirm-ref",
    documentId: "affirm-doc",
    text: "We decided to use src/cache/redis-client.js for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  });
  const reversals = Array.from({ length: 11 }, (_, index) => descriptor({
    ref: `reverse-ref-${index}`,
    documentId: `reverse-doc-${index}`,
    text: "We rejected src/cache/redis-client.js instead of memcached for the cache layer.",
    anchorKeys: new Set([PATH_ANCHOR]),
  }));
  const conflicts = detectPossibleConflicts([affirming, ...reversals]);
  assert.equal(conflicts.get("affirm-ref").length, 8);
  // Every reversal only ever pairs against the single affirming item (two
  // reversals share no opposing cue with each other), so none of them hits
  // the cap themselves.
  for (const reversal of reversals) {
    assert.deepEqual(conflicts.get(reversal.ref), ["affirm-ref"]);
  }
});

function request(id, text, createdAt, sessionId = "session-main") {
  const sourceKey = `user:${id}`;
  return {
    idempotencyKey: `gather-conflict:${id}`,
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
  const directory = mkdtempSync(join(tmpdir(), "context-window-gather-conflicts-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const worker = new IndexWorker(store, {
    workerId: "gather-conflict-worker",
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
    query: "cache layer redis client",
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

test("gatherArchive flags a possibly-conflicting pair: an early decision and a later unformalized reversal sharing a subject", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("decide-cache", "We decided to use src/cache/redis-client.js for the cache layer.", 100);
  await admit("reverse-cache", "We rejected src/cache/redis-client.js instead of memcached for the cache layer.", 300);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest(), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.equal(gather.status, "resolved");
  const byDocumentId = new Map(gather.evidence.map((item) => [item.document.documentId, item]));
  const decide = byDocumentId.get("decide-cache");
  const reverse = byDocumentId.get("reverse-cache");
  assert.ok(decide, "expected the early-decision document to be gathered as evidence");
  assert.ok(reverse, "expected the later-reversal document to be gathered as evidence");
  assert.deepEqual(decide.possiblyConflicting, [reverse.locator]);
  assert.deepEqual(reverse.possiblyConflicting, [decide.locator]);
});

test("gatherArchive does not flag unrelated evidence sharing no subject signal", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("decide-cache", "We decided to use src/cache/redis-client.js for the cache layer.", 100);
  await admit("noise", "Unrelated historical note about the cache layer rollout schedule.", 200);
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest(), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.equal(gather.status, "resolved");
  for (const item of gather.evidence) {
    assert.equal(item.possiblyConflicting, undefined);
  }
});

test("gatherArchive caps possiblyConflicting at the schema's 8-item limit instead of throwing a ContractError", async (t) => {
  const { store, worker, admit } = await fixture(t);
  await admit("decide-cache", "We decided to use src/cache/redis-client.js for the cache layer.", 100);
  // 9 reversal documents all sharing the same path anchor and opposing
  // decision cues as the single affirming document above: without the
  // MAX_POSSIBLY_CONFLICTING_REFS cap in detectPossibleConflicts, the
  // affirming item's possiblyConflicting list grows to 9 refs, one more
  // than store-contract-schema.js's possiblyConflicting maxItems (8), and
  // assertStoreResult throws instead of returning a resolved packet. (Capped
  // at 9 documents, not the finding's 11, because store.gather's own request
  // `limit` field maxes at 10 -- 1 affirming + 9 reversal is the largest
  // anchor set this request shape can pull in one call.)
  for (let index = 0; index < 9; index += 1) {
    await admit(
      `reverse-cache-${index}`,
      `We rejected src/cache/redis-client.js instead of memcached for the cache layer (variant ${index}).`,
      200 + index,
    );
  }
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const gather = await gatherArchive(store, gatherRequest({
    limit: 10,
    maxEvidence: 10,
  }), {
    project: PROJECT,
    now: 1_000,
    semantic: { search: async () => [] },
  });

  assert.equal(gather.status, "resolved");
  const decide = gather.evidence.find((item) => item.document.documentId === "decide-cache");
  assert.ok(decide, "expected the affirming document to be gathered as evidence");
  assert.ok(decide.possiblyConflicting.length <= 8, "possiblyConflicting must respect the schema's maxItems: 8 cap");
  for (const item of gather.evidence) {
    if (item.possiblyConflicting !== undefined) {
      assert.ok(item.possiblyConflicting.length <= 8);
    }
  }
});

test("formatGatherResults renders a possibly-conflicting label within the token budget", () => {
  const framed = (id, createdAt, value) => ({
    id,
    documentId: id,
    kind: "turn",
    createdAt,
    modelVisibleFramed: true,
    text: `[Archived historical evidence]\n\n${JSON.stringify({
      format: "context-window.archived-evidence.v1",
      trust: "untrusted-archived-data",
      source: value,
    })}`,
  });
  const gather = {
    status: "resolved",
    mode: "hybrid",
    intent: "state",
    anchorCount: 2,
    candidateCount: 2,
    truncated: false,
    evidence: [
      {
        id: "r1",
        locator: "r1",
        relation: "anchor",
        anchorRank: 1,
        distance: 0,
        document: framed("decide-cache", 100, "decided on redis"),
        possiblyConflicting: ["r2"],
      },
      {
        id: "r2",
        locator: "r2",
        relation: "anchor",
        anchorRank: 2,
        distance: 0,
        document: framed("reverse-cache", 300, "rejected redis"),
        possiblyConflicting: ["r1"],
      },
    ],
  };

  const output = formatGatherResults(gather, 1_000);
  assert.match(output, /"possiblyConflicting":\["possibly conflicting with r2"\]/u);
  assert.match(output, /"possiblyConflicting":\["possibly conflicting with r1"\]/u);
  assert.ok(estimateModelVisibleTokens(output) <= 1_000);

  // A tight budget must still respect the overall cap; the conflict label is
  // no exception to formatGatherResults' existing per-record fitting.
  const bounded = formatGatherResults(gather, 90);
  assert.ok(estimateModelVisibleTokens(bounded) <= 90);
});
