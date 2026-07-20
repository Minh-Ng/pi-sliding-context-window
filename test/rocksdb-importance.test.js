import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import {
  createImportanceIndexHandler,
  documentImportancePrior,
  importancePriorMultiplier,
  importanceSignals,
  IMPORTANCE_INDEX_VERSION,
  IMPORTANCE_KEYSPACE,
  IMPORTANCE_PRIOR_MAX_MULTIPLIER,
} from "../src/rocksdb/index/importance.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { manifestKeys } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { searchArchive } from "../src/retrieval/search.js";
import {
  documentRecallCount,
  recordRecalledLocator,
  recordShownResults,
} from "../src/retrieval/relevance-feedback.js";
import { assertStoreResult } from "../src/store/store-contract.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(id, text, overrides = {}) {
  const version = overrides.version ?? 1;
  const sourceKey = overrides.sourceKey ?? `user:${id}:${version}`;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `importance:${id}:${version}`,
    ...(overrides.protect === undefined ? {} : { protect: overrides.protect }),
    document: {
      documentId: id,
      version,
      sourceKey,
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/workspace/importance",
      kind: overrides.kind ?? "turn",
      createdAt: overrides.createdAt ?? version * 100,
      text,
      metadata: { turnId: `turn-${id}-${version}`, ...(overrides.metadata ?? {}) },
      sourceMessageKeys: overrides.sourceMessageKeys ?? [sourceKey],
      ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
    },
    structuralMessages: overrides.structuralMessages ?? [],
    retentionClass: "conversation-source",
  };
}

async function admit(store, id, text, overrides = {}) {
  return admitDocument(store, request(id, text, overrides), {
    chunking: { maxChunkBytes: 256, minLineSplitBytes: 0 },
    windows: { windowTokens: 32, overlapTokens: 4 },
  });
}

async function fixture(t, name) {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `importance-worker:${name}`,
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
      createImportanceIndexHandler(),
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
    sessionIds: ["session-main"],
    project: "/workspace/importance",
    limit: overrides.limit ?? 10,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  };
}

test("importancePriorMultiplier is neutral, bounded, monotonic, and deterministic", () => {
  assert.equal(importancePriorMultiplier({}), 1);
  assert.equal(importancePriorMultiplier({ isDecision: false, isPinned: false }), 1);

  const decision = importancePriorMultiplier({ isDecision: true });
  const pinned = importancePriorMultiplier({ isPinned: true });
  const both = importancePriorMultiplier({ isDecision: true, isPinned: true });
  assert.ok(decision > 1, "a decision boosts the prior");
  assert.equal(decision, pinned, "decision and pin carry equal weight");
  assert.ok(both > decision, "combined signals boost more than one");

  // Count signals scale monotonically and never below the neutral multiplier.
  const noRefs = importancePriorMultiplier({ referencedByCount: 0 });
  const someRefs = importancePriorMultiplier({ referencedByCount: 4 });
  const manyRefs = importancePriorMultiplier({ referencedByCount: 40 });
  assert.equal(noRefs, 1);
  assert.ok(someRefs > noRefs);
  assert.ok(manyRefs >= someRefs);

  // The multiplier can never exceed the documented cap, even when every signal
  // is saturated, so the prior cannot overrule a strong relevance gap.
  const saturated = importancePriorMultiplier({
    isDecision: true,
    isPinned: true,
    referencedByCount: 1_000_000,
    recallCount: 1_000_000,
  });
  assert.equal(saturated, IMPORTANCE_PRIOR_MAX_MULTIPLIER);
  assert.ok(saturated <= IMPORTANCE_PRIOR_MAX_MULTIPLIER);

  // Deterministic: identical signals always produce identical multipliers.
  assert.equal(
    importancePriorMultiplier({ isDecision: true, referencedByCount: 3 }),
    importancePriorMultiplier({ isDecision: true, referencedByCount: 3 }),
  );
  // Malformed/negative counts are treated as zero rather than penalizing.
  assert.equal(importancePriorMultiplier({ referencedByCount: -5, recallCount: NaN }), 1);
});

test("importanceSignals reads only intrinsic manifest facts", () => {
  assert.deepEqual(
    importanceSignals({ kind: "turn", protectedAtAdmission: false, sourceMessageKeys: ["a"] }),
    { isDecision: false, isPinned: false, referencedByCount: 1, recallCount: 0 },
  );
  assert.deepEqual(
    importanceSignals({
      kind: "decision-candidate",
      protectedAtAdmission: true,
      sourceMessageKeys: ["a", "b", "c"],
    }),
    { isDecision: true, isPinned: true, referencedByCount: 3, recallCount: 0 },
  );
  assert.equal(importanceSignals({ kind: "turn" }).referencedByCount, 0);
});

test("the index worker stores one versioned importance record per document", async (t) => {
  const { store, worker } = await fixture(t, "record");
  await admit(store, "plain-turn", "a plain conversational turn with ordinary content");
  await admit(store, "curated-decision", "a curated decision candidate record", {
    kind: "decision-candidate",
    createdAt: 200,
  });
  await admit(store, "pinned-turn", "a pinned protected turn kept for the long term", {
    protect: true,
    createdAt: 300,
  });
  await admit(store, "multi-source", "a turn synthesized from several source messages", {
    createdAt: 400,
    sourceMessageKeys: ["user:multi:a", "user:multi:b", "user:multi:c"],
  });
  const drained = await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });
  assert.equal(drained.processed, 4);

  const expectations = {
    "plain-turn": { isDecision: false, isPinned: false, referencedByCount: 1 },
    "curated-decision": { isDecision: true, isPinned: false, referencedByCount: 1 },
    "pinned-turn": { isDecision: false, isPinned: true, referencedByCount: 1 },
    "multi-source": { isDecision: false, isPinned: false, referencedByCount: 3 },
  };
  for (const [documentId, expected] of Object.entries(expectations)) {
    const record = await store.get([IMPORTANCE_KEYSPACE, documentId, 1]);
    assert.ok(record !== undefined, `${documentId} has an importance record`);
    assert.equal(record.importanceIndexVersion, IMPORTANCE_INDEX_VERSION);
    assert.equal(record.documentId, documentId);
    assert.equal(record.documentVersion, 1);
    assert.equal(record.isDecision, expected.isDecision);
    assert.equal(record.isPinned, expected.isPinned);
    assert.equal(record.referencedByCount, expected.referencedByCount);
    assert.equal(record.recallCount, 0);
    assert.equal(record.prior, importancePriorMultiplier(expected));

    // The intrinsic half of the signal set (isDecision/isPinned/provenance
    // breadth) is a pure function of the canonical manifest; none of these
    // fixtures has a supersession chain or a recall, so it equals the full
    // stored signal set here too.
    const manifest = await store.get(manifestKeys.document(documentId, 1));
    assert.deepEqual(
      { ...importanceSignals(manifest) },
      { isDecision: expected.isDecision, isPinned: expected.isPinned, referencedByCount: expected.referencedByCount, recallCount: 0 },
    );
  }

  // The decision and pin priors are strictly higher than the plain turn's.
  assert.ok((await store.get([IMPORTANCE_KEYSPACE, "curated-decision", 1])).prior
    > (await store.get([IMPORTANCE_KEYSPACE, "plain-turn", 1])).prior);
  assert.ok((await store.get([IMPORTANCE_KEYSPACE, "pinned-turn", 1])).prior
    > (await store.get([IMPORTANCE_KEYSPACE, "plain-turn", 1])).prior);
});

test("documentImportancePrior reads the stored multiplier and defaults to neutral", async (t) => {
  const { store, worker } = await fixture(t, "prior-read");
  await admit(store, "decided", "an indexed decision candidate", { kind: "decision-candidate" });
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const stored = await store.get([IMPORTANCE_KEYSPACE, "decided", 1]);
  assert.equal(await documentImportancePrior(store, { documentId: "decided", version: 1 }), stored.prior);
  // No record → neutral 1.0, never a penalty.
  assert.equal(await documentImportancePrior(store, { documentId: "absent", version: 1 }), 1);
});

test("documentImportancePrior re-reads the live recall counter instead of the stale stored record", async (t) => {
  // A document is indexed exactly once, at admission, before any search or
  // recall of it could have happened, so the importance record's own
  // recallCount is permanently stuck at 0 and there is no reindex path that
  // would ever refresh it. Ranking must not trust that stale value — it must
  // re-read the durable per-document recall counter live, so a recall that
  // happens after admission still moves the prior without a reindex.
  const project = "/workspace/importance";
  const { store, worker } = await fixture(t, "live-recall");
  await admit(store, "recalled-doc", "a document that will be shown then recalled by search");
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const storedBefore = await store.get([IMPORTANCE_KEYSPACE, "recalled-doc", 1]);
  const before = await documentImportancePrior(store, { documentId: "recalled-doc", version: 1, project });
  assert.equal(before, storedBefore.prior, "no recall has happened yet, so the live read matches the stored prior");

  const search = await searchArchive(store, searchRequest("document shown then recalled"), {
    secret: Buffer.alloc(32, 0x42),
    now: 1_000,
    recordShownResults: (event) => recordShownResults(store, event),
  });
  const shown = search.results.find(({ documentId }) => documentId === "recalled-doc");
  assert.ok(shown !== undefined, "the fixture document must be a shown search result");

  const join = await recordRecalledLocator(store, {
    project,
    locator: shown.locator,
    status: "resolved",
    now: 2_000,
  });
  assert.deepEqual(join, { joined: true });
  assert.equal(
    await documentRecallCount(store, { project, documentId: "recalled-doc", version: 1 }),
    1,
    "the durable recall counter increments on the resolved join",
  );

  // The importance-v1 record itself was written once at admission, strictly
  // before the recall above, so it is stuck at recallCount 0 — this is the
  // actual stored value the batch job wrote and never rewrites.
  const stored = await store.get([IMPORTANCE_KEYSPACE, "recalled-doc", 1]);
  assert.equal(stored.recallCount, 0);

  // A project-scoped read re-derives the prior from the live counter, so it
  // rises even though nothing was reindexed.
  const after = await documentImportancePrior(store, { documentId: "recalled-doc", version: 1, project });
  assert.ok(after > before, "the prior must increase once the live recall counter is non-zero");
  assert.equal(after, importancePriorMultiplier({ ...stored, recallCount: 1 }));

  // Without a project boundary (legacy call shape), the stale stored value is
  // used as a fallback instead of throwing.
  const legacy = await documentImportancePrior(store, { documentId: "recalled-doc", version: 1 });
  assert.equal(legacy, before);
});

test("the prior reorders a lexical near-tie only for explicit search", async (t) => {
  const { store, worker } = await fixture(t, "near-tie");
  // Identical text produces identical BM25 scores regardless of pin status —
  // admission pinning carries no BM25F field-weight tier of its own (unlike
  // `kind: "decision-candidate"`, which resolveFieldRanges in bm25.js treats
  // as the boosted "structural" field tier) — so the only ranking difference
  // here is the query-independent importance prior.
  const text = "the reranking prior signal appears in this ranking sample sentence about priors";
  await admit(store, "aaa-plain", text);
  await admit(store, "zzz-pinned", text, { protect: true, createdAt: 200 });
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const baseline = await searchArchive(store, searchRequest("reranking prior signal"), { now: 1_000 });
  assert.deepEqual(
    baseline.results.map(({ documentId }) => documentId),
    ["aaa-plain", "zzz-pinned"],
    "without the prior the tie breaks on document id",
  );

  const reranked = await searchArchive(
    store,
    searchRequest("reranking prior signal"),
    { now: 2_000, applyImportancePrior: true },
  );
  assert.deepEqual(
    reranked.results.map(({ documentId }) => documentId),
    ["zzz-pinned", "aaa-plain"],
    "the pinned-document prior overtakes the tie for explicit search",
  );
  assert.equal(reranked.results[0].retrievalMode, "lexical");
});

test("explicit supersession chains contribute to referencedByCount", async (t) => {
  const { store, worker } = await fixture(t, "chain-depth");
  await admit(store, "root-decision", "the root decision before any revision", {
    kind: "decision-candidate",
    createdAt: 100,
  });
  await admit(store, "revised-decision", "the first revision of the decision", {
    createdAt: 200,
    supersedes: { documentId: "root-decision", version: 1 },
  });
  await admit(store, "latest-decision", "the second revision of the decision", {
    createdAt: 300,
    supersedes: { documentId: "revised-decision", version: 1 },
  });
  const drained = await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });
  assert.equal(drained.processed, 3);

  // root-decision is never itself the source of a supersedes edge, so its
  // referencedByCount is just provenance breadth (one source message).
  const root = await store.get([IMPORTANCE_KEYSPACE, "root-decision", 1]);
  assert.equal(root.referencedByCount, 1);
  // revised-decision's own manifest.supersedes chain walks back one hop.
  const revised = await store.get([IMPORTANCE_KEYSPACE, "revised-decision", 1]);
  assert.equal(revised.referencedByCount, 1 + 1);
  // latest-decision walks back two hops (to revised-decision, then root-decision).
  const latest = await store.get([IMPORTANCE_KEYSPACE, "latest-decision", 1]);
  assert.equal(latest.referencedByCount, 1 + 2);
});

test("the prior reorders unequal-score candidates without a negative-margin contract violation", async (t) => {
  const { store, worker } = await fixture(t, "unequal-reorder");
  // Distinct texts give distinct (non-tied) BM25 scores. "weak-pinned" scores
  // lower than "strong" but within the prior's bounded reach, so the prior
  // promotes it above a genuinely higher-scoring candidate — the one case
  // where the fused-list invariant "next same-mode candidate has a
  // non-higher normalizedScore" no longer holds. assertStoreResult inside
  // searchArchive would throw ContractError if margin (normalizedScore type,
  // minimum 0) went negative here.
  //
  // This uses admission pinning plus a saturated referencedByCount rather
  // than `kind: "decision-candidate"` deliberately: that kind is also the
  // BM25F structural field-weight tier (bm25.js resolveFieldRanges), which
  // would inflate the baseline lexical score itself and defeat the "genuine,
  // non-tied relevance gap" premise this test needs at baseline.
  await admit(store, "strong", "signalrankingterm appears here with a couple filler words nearby for context");
  await admit(
    store,
    "weak-pinned",
    "signalrankingterm appears here with a couple filler words nearby for context and extra",
    {
      protect: true,
      createdAt: 200,
      sourceMessageKeys: Array.from({ length: 32 }, (_, index) => `extra:${index}`),
    },
  );
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const baseline = await searchArchive(store, searchRequest("signalrankingterm"), { now: 1_000 });
  assert.ok(
    baseline.results[0].score > baseline.results[1].score,
    "the baseline ranking is a genuine (non-tied) relevance gap",
  );
  assert.equal(baseline.results[0].documentId, "strong");

  const reranked = await searchArchive(
    store,
    searchRequest("signalrankingterm"),
    { now: 2_000, applyImportancePrior: true },
  );
  assert.equal(
    reranked.results[0].documentId,
    "weak-pinned",
    "the prior promotes the lower-scoring candidate ahead of the higher-scoring one",
  );
  for (const result of reranked.results) {
    assert.ok(result.margin >= 0, `margin must stay non-negative, got ${result.margin}`);
  }
  // The result object that failed contract validation before the fix; re-run
  // the same validation searchArchive already applies internally so a
  // regression here fails this test instead of only manifesting downstream.
  assert.doesNotThrow(() => assertStoreResult("store.search", reranked));
});

test("the prior cannot overrule a strong relevance gap", async (t) => {
  const { store, worker } = await fixture(t, "strong-gap");
  const token = "signalrankingterm";
  await admit(store, "strong-plain", `${`${token} `.repeat(12)}closing filler words`);
  await admit(
    store,
    "weak-decision",
    `${token} ${"unrelated filler context words about other topics ".repeat(6)}`,
    { kind: "decision-candidate", protect: true, createdAt: 200 },
  );
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const reranked = await searchArchive(
    store,
    searchRequest(token),
    { now: 1_000, applyImportancePrior: true },
  );
  assert.equal(
    reranked.results[0].documentId,
    "strong-plain",
    "a strong BM25 lead survives even the maximum importance prior",
  );
  assert.ok(
    reranked.results.some(({ documentId }) => documentId === "weak-decision"),
    "the weaker decision candidate is still returned, just not promoted",
  );
});
