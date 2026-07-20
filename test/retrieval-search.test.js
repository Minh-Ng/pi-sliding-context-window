import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import {
  admitDocument,
  DOCUMENT_HISTORY_FORMAT_VERSION,
  manifestKeys,
  readCanonicalDocument,
} from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { decodeKey, encodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { verifyLocator } from "../src/retrieval/locator.js";
import { readLease } from "../src/retrieval/leases.js";
import { recallArchive } from "../src/retrieval/recall.js";
import { preflightArchive } from "../src/retrieval/preflight.js";
import {
  findStoredWindowForByteRange,
  normalizeModeScore,
  searchArchive,
} from "../src/retrieval/search.js";
import { normalizeBm25Term } from "../src/rocksdb/index/tokenizer.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

test("structural byte mapping pages beyond 100000 stored windows", () => {
  const finalOrdinal = 100_000;
  let scans = 0;
  const view = {
    scan(prefix, { limit, after }) {
      scans += 1;
      const previous = after === undefined ? -1 : Number(decodeKey(after).at(-1));
      const records = [];
      for (let ordinal = previous + 1;
        ordinal <= finalOrdinal && records.length < limit;
        ordinal += 1) {
        const key = [...prefix, ordinal];
        records.push({
          keyBytes: encodeKey(key),
          payload: {
            ordinal,
            startByte: ordinal * 10,
            endByte: ordinal * 10 + 10,
          },
        });
      }
      return records;
    },
  };
  const window = findStoredWindowForByteRange(
    view,
    "large-document",
    1,
    finalOrdinal * 10 + 2,
    finalOrdinal * 10 + 8,
  );
  assert.equal(window.ordinal, finalOrdinal);
  assert.equal(scans, 101);
});

function request(id, text, overrides = {}) {
  const version = overrides.version ?? 1;
  const sourceKey = overrides.sourceKey ?? `user:${id}:${version}`;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `search:${id}:${version}`,
    document: {
      documentId: id,
      version,
      sourceKey,
      ...(overrides.sourceKeyStatus === undefined
        ? {}
        : { sourceKeyStatus: overrides.sourceKeyStatus }),
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/workspace/search",
      kind: overrides.kind ?? "turn",
      createdAt: overrides.createdAt ?? version * 100,
      text,
      metadata: { turnId: `turn-${id}-${version}`, ...(overrides.metadata ?? {}) },
      sourceMessageKeys: overrides.sourceMessageKeys ?? [sourceKey],
      ...(overrides.subjectKey === undefined ? {} : { subjectKey: overrides.subjectKey }),
      ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
    },
    structuralMessages: overrides.structuralMessages ?? [{
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
  return admitDocument(store, request(id, text, overrides), {
    chunking: { maxChunkBytes: 48, minLineSplitBytes: 0 },
    windows: { windowTokens: 8, overlapTokens: 2 },
  });
}

async function fixture(t, name = "retrieval-search") {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `search-worker:${name}`,
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
    relation: overrides.relation ?? null,
    scope: overrides.scope ?? "session",
    sessionId: overrides.sessionId ?? "session-main",
    sessionIds: overrides.sessionIds,
    project: overrides.project ?? "/workspace/search",
    limit: overrides.limit ?? 3,
    excludeVisibleSourceKeys: overrides.excludeVisibleSourceKeys ?? [],
    hintBudgetTokens: overrides.hintBudgetTokens ?? 160,
    expansionPolicy: overrides.expansionPolicy,
  };
}

function preflightRequest(messageKey, message) {
  return {
    messageKey,
    message,
    scope: "session",
    sessionId: "session-main",
    sessionIds: ["session-main"],
    project: "/workspace/search",
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
    activeHintBudgetTokens: 640,
    activeMessageKeys: [messageKey],
    hintSourceCooldownMs: 0,
    ephemeralAutoRetrievalDays: 7,
    conversationAutoRetrievalDays: 30,
    derivedAutoRetrievalDays: 30,
  };
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

test("exact-first search returns a signed leased locator that recalls exact source", async (t) => {
  const { store, worker } = await fixture(t, "search-exact");
  await admit(store, "exact", "REAP_DRAIN prevents accepting new work during shutdown.");
  await admit(store, "other", "The ordinary shutdown path is described elsewhere.", { createdAt: 200 });
  await worker.drain();
  const secret = Buffer.alloc(32, 0x31);
  // Persist the injected secret on first search so tests can inspect claims.
  const response = await searchArchive(store, withoutUndefined(searchRequest("REAP_DRAIN")), {
    secret,
    now: 1_000,
    leaseMs: 30_000,
    ownerId: "message:1",
  });
  assert.equal(response.mode, "exact");
  assert.equal(response.status, "resolved");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].documentId, "exact");
  assert.equal(response.results[0].matchType, "exact-symbol");
  assert.equal(response.results[0].retrievalMode, "exact");
  assert.equal(response.results[0].rawScore, response.results[0].score);
  assert.equal(response.results[0].calibratedScore, response.results[0].score);
  assert.equal(response.results[0].createdAt, 100);
  assert.deepEqual(response.results[0].matchedAnchors, ["REAP_DRAIN"]);
  const claims = verifyLocator(response.results[0].locator, secret);
  assert.equal(claims.documentId, "exact");
  assert.equal(claims.indexGeneration, response.indexGeneration);
  assert.equal((await readLease(store, claims.leaseId)).ownerId, "message:1");
  const recalled = await recallArchive(store, {
    locator: response.results[0].locator,
    neighbors: 0,
    maxTokens: 100,
  }, {
    project: "/workspace/search",
    scope: "session",
    sessionIds: ["session-main"],
    secret,
    now: 2_000,
  });
  assert.equal(recalled.status, "resolved");
  assert.match(recalled.text, /REAP_DRAIN/u);
});

test("explicit correction is excluded at commit across exact, lexical, structural, and automatic retrieval", async (t) => {
  const { store, worker } = await fixture(t, "search-explicit-correction");
  const subjectKey = "decision:archive-tablets";
  const targetText = "CORRECTION_SHARED_ANCHOR OLD_TARGET_ONLY tablet routing uses one archive shard durable layout.";
  const replacementText = "CORRECTION_SHARED_ANCHOR NEW_REPLACEMENT_ONLY tablet routing uses project archive shards durable layout.";
  const neighborText = "Tablet routing uses one archive shard in a nearby durable layout.";
  await admit(store, "correction-target", targetText, { createdAt: 100, subjectKey });
  await admit(store, "correction-neighbor", neighborText, { createdAt: 150 });
  await worker.drain();

  const before = await searchArchive(
    store,
    withoutUndefined(searchRequest("CORRECTION_SHARED_ANCHOR", { limit: 10 })),
    { now: 1_000 },
  );
  assert.deepEqual(before.results.map(({ documentId }) => documentId), ["correction-target"]);

  await admit(store, "correction-replacement", replacementText, {
    createdAt: 200,
    subjectKey,
    supersedes: { documentId: "correction-target", version: 1 },
  });

  // The target disappears when the admission commits, before the replacement
  // outbox entry has been indexed.
  const immediateExact = await searchArchive(
    store,
    withoutUndefined(searchRequest("CORRECTION_SHARED_ANCHOR", { limit: 10 })),
    { now: 1_001 },
  );
  assert.equal(immediateExact.results.some(({ documentId }) => documentId === "correction-target"), false);
  const immediateLexical = await searchArchive(
    store,
    withoutUndefined(searchRequest("tablet routing archive durable layout", { limit: 10 })),
    { now: 1_002 },
  );
  assert.equal(immediateLexical.results.some(({ documentId }) => documentId === "correction-target"), false);
  assert.equal(immediateLexical.results.some(({ documentId }) => documentId === "correction-neighbor"), true);
  const immediateStructural = await searchArchive(
    store,
    withoutUndefined(searchRequest("", { relation: "latest-question", limit: 10 })),
    { now: 1_003 },
  );
  assert.equal(immediateStructural.results.some(({ documentId }) => documentId === "correction-target"), false);
  const immediateAutomatic = await preflightArchive(
    store,
    preflightRequest(
      "user:automatic-before-replacement-index",
      "Why did we decide on CORRECTION_SHARED_ANCHOR?",
    ),
    { now: 1_004, epochId: "epoch:automatic-before-replacement-index" },
  );
  assert.deepEqual(immediateAutomatic.hints, []);
  assert.equal(immediateAutomatic.modelVisibleText, "");
  assert.equal(immediateAutomatic.modelVisibleText.includes("OLD_TARGET_ONLY"), false);

  assert.equal(
    (await readCanonicalDocument(store, "correction-target", 1)).text,
    targetText,
    "the superseded canonical source remains available for audit",
  );

  await worker.drain();
  const exact = await searchArchive(
    store,
    withoutUndefined(searchRequest("CORRECTION_SHARED_ANCHOR", { limit: 10 })),
    { now: 1_010 },
  );
  assert.deepEqual(exact.results.map(({ documentId }) => documentId), ["correction-replacement"]);
  const lexical = await searchArchive(
    store,
    withoutUndefined(searchRequest("tablet routing archive durable layout", { limit: 10 })),
    { now: 1_011 },
  );
  assert.equal(lexical.results.some(({ documentId }) => documentId === "correction-target"), false);
  assert.equal(lexical.results.some(({ documentId }) => documentId === "correction-replacement"), true);
  assert.equal(lexical.results.some(({ documentId }) => documentId === "correction-neighbor"), true);
  const structural = await searchArchive(
    store,
    withoutUndefined(searchRequest("", { relation: "latest-question", limit: 10 })),
    { now: 1_012 },
  );
  assert.equal(structural.results.some(({ documentId }) => documentId === "correction-target"), false);
  assert.equal(structural.results.some(({ documentId }) => documentId === "correction-replacement"), true);
  assert.equal(structural.results.some(({ documentId }) => documentId === "correction-neighbor"), true);
  const automatic = await preflightArchive(
    store,
    preflightRequest(
      "user:automatic-after-replacement-index",
      "Why did we decide on CORRECTION_SHARED_ANCHOR?",
    ),
    { now: 1_013, epochId: "epoch:automatic-after-replacement-index" },
  );
  assert.deepEqual(automatic.hints.map(({ documentId }) => documentId), ["correction-replacement"]);
  assert.equal(automatic.hints[0].disclosureType, "historical-snippet");
  assert.match(automatic.modelVisibleText, /NEW_REPLACEMENT_ONLY/u);
  assert.doesNotMatch(automatic.modelVisibleText, /OLD_TARGET_ONLY|correction-target/u);
});

test("oversized semantic metadata is omitted at the search result boundary", async (t) => {
  const { store, worker } = await fixture(t, "search-semantic-identifier-cap");
  await admit(store, "semantic-cap", "REAP_DRAIN remains exact evidence.", {
    metadata: { turnId: "T".repeat(8_193) },
  });
  await worker.drain();
  const response = await searchArchive(store, withoutUndefined(searchRequest("REAP_DRAIN")), {
    now: 1_000,
  });
  assert.equal(response.status, "resolved");
  assert.equal(response.results[0].documentId, "semantic-cap");
  assert.equal(Object.hasOwn(response.results[0].source, "turnId"), false);
});

test("an exact miss broadens only afterward to lexical history", async (t) => {
  const { store, worker } = await fixture(t, "search-fallback");
  await admit(store, "history", "Historical provider cache reconstruction preserves stable prefixes.");
  await worker.drain();
  const response = await searchArchive(store, withoutUndefined(searchRequest(
    "Where did MISSING_SYMBOL historical provider cache reconstruction happen?",
  )), { now: 1_000 });
  assert.equal(response.mode, "hybrid");
  assert.equal(response.status, "resolved");
  assert.equal(response.results[0].documentId, "history");
  assert.equal(response.results[0].matchType, "bm25");
});

test("lexical scores use fixed calibration and preserve retrieval evidence", async (t) => {
  const { store, worker } = await fixture(t, "search-lexical");
  await admit(store, "first", "immutable physical chunks avoid duplicate payload storage", { createdAt: 100 });
  await admit(store, "second", "physical chunks store payload evidence efficiently", { createdAt: 200 });
  await worker.drain();
  const response = await searchArchive(store, withoutUndefined(searchRequest(
    "physical chunks payload storage",
    { limit: 3 },
  )), { now: 1_000 });
  assert.equal(response.mode, "lexical");
  assert.ok(response.results[0].score < 1);
  assert.equal(
    response.results[0].score,
    normalizeModeScore("lexical", response.results[0].rawScore),
  );
  assert.equal(response.results[0].calibratedScore, response.results[0].score);
  assert.equal(response.results[0].retrievalMode, "lexical");
  assert.equal(response.results[0].createdAt, 100);
  assert.ok(response.results[0].matchedTerms.length >= 2);
  assert.ok(response.results[0].termCoverage > 0);
  assert.ok(response.results[0].termIdf.length >= 2);
  assert.ok(response.results[0].maxNormalizedIdf > 0);
  assert.equal(new Set(response.results.map(({ documentId }) => documentId)).size, response.results.length);
  assert.ok(response.results.every(({ score }) => score >= 0 && score <= 1));
  assert.equal(normalizeModeScore("structural", 75), 0.75);
  assert.equal(normalizeModeScore("lexical", 3), 0.75);
  assert.equal(normalizeModeScore("lexical", 3, 3), normalizeModeScore("lexical", 3, 300));
  assert.ok(response.results[0].margin >= 0);

  const limited = await searchArchive(store, withoutUndefined(searchRequest(
    "physical chunks payload storage",
    { limit: 1 },
  )), { now: 1_001 });
  assert.equal(limited.results[0].documentId, response.results[0].documentId);
  assert.equal(limited.results[0].margin, response.results[0].margin);
});

test("structural and combined retrieval preserve ambiguity and deduplicate locations", async (t) => {
  const { store, worker } = await fixture(t, "search-structural");
  await admit(store, "question", "Where is STRUCTURAL_TARGET retained?");
  await worker.drain();
  const structural = await searchArchive(store, withoutUndefined(searchRequest("", {
    relation: "latest-question",
    scope: "project",
  })), { now: 1_000 });
  assert.equal(structural.mode, "structural");
  assert.equal(structural.status, "ambiguous");
  assert.equal(structural.results[0].documentId, "question");
  assert.equal(structural.results[0].matchType, "latest-question");

  const combined = await searchArchive(store, withoutUndefined(searchRequest("STRUCTURAL_TARGET", {
    relation: "latest-question",
  })), { now: 2_000 });
  assert.equal(combined.mode, "hybrid");
  assert.equal(combined.results.length, 1);
  assert.equal(combined.results[0].matchType, "exact-symbol");
});

test("structural byte coordinates avoid unrelated source chunks at query time", async (t) => {
  const { store, worker } = await fixture(t, "search-structural-range");
  const excerpt = "Where is STRUCTURAL_RANGE_TARGET retained?";
  const text = `${"prefix-padding ".repeat(2_000)}${excerpt}${" suffix-padding".repeat(2_000)}`;
  await admit(store, "structural-range", text, {
    structuralMessages: [{
      messageKey: "user:structural-range",
      messageIndex: 0,
      role: "user",
      createdAt: 100,
      text: excerpt,
      questionScore: 100,
      requestScore: 10,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  await worker.drain();
  const manifest = await store.get([KEYSPACE.DOCUMENT, "structural-range", 1]);
  const codeUnitStart = text.indexOf(excerpt);
  const startByte = Buffer.byteLength(text.slice(0, codeUnitStart), "utf8");
  const endByte = startByte + Buffer.byteLength(excerpt, "utf8");
  const allowed = new Set(manifest.chunks
    .filter((reference) => reference.startByte < endByte && reference.endByte > startByte)
    .map(({ chunkId }) => chunkId));
  const forbidden = new Set(manifest.chunks
    .map(({ chunkId }) => chunkId)
    .filter((chunkId) => !allowed.has(chunkId)));
  const chunkReads = new Set();
  assert.ok(forbidden.size > 0);
  const guarded = {
    get: store.get.bind(store),
    transaction: store.transaction.bind(store),
    snapshot(callback) {
      return store.snapshot((view) => callback({
        get(key, ...args) {
          if (key[0] === KEYSPACE.CHUNK) {
            chunkReads.add(key[1]);
            if (forbidden.has(key[1])) {
              throw new Error(`structural mapping read unrelated chunk ${key[1]}`);
            }
          }
          return view.get(key, ...args);
        },
        scan: view.scan.bind(view),
      }));
    },
  };
  const response = await searchArchive(guarded, withoutUndefined(searchRequest("", {
    relation: "latest-question",
  })), { now: 1_000 });
  assert.equal(response.status, "resolved");
  assert.equal(response.results[0].documentId, "structural-range");
  assert.match(response.results[0].snippet, /STRUCTURAL_RANGE_TARGET/u);
  assert.ok(chunkReads.size > 0);
  assert.ok([...chunkReads].every((chunkId) => allowed.has(chunkId)));
});

test("multi-window structural locators clip to the query window and recall immediately", async (t) => {
  const { store, worker } = await fixture(t, "search-structural-multi-window");
  const words = Array.from({ length: 80 }, (_, index) =>
    index === 53 ? "needlemiddle" : `ordinary${index}`);
  const text = words.join(" ");
  await admit(store, "structural-multi-window", text, {
    structuralMessages: [{
      messageKey: "user:structural-multi-window",
      messageIndex: 0,
      role: "user",
      createdAt: 100,
      text,
      questionScore: 100,
      requestScore: 10,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  await worker.drain();
  const secret = Buffer.alloc(32, 0x42);
  const response = await searchArchive(store, withoutUndefined(searchRequest("needlemiddle", {
    relation: "latest-question",
  })), {
    secret,
    now: 1_000,
    leaseMs: 30_000,
    ownerId: "message:structural-multi-window",
  });
  assert.equal(response.results[0].documentId, "structural-multi-window");
  assert.equal(response.results[0].matchType, "latest-question");
  assert.match(response.results[0].snippet, /needlemiddle/u);
  assert.notEqual(response.results[0].snippet, text);
  const claims = verifyLocator(response.results[0].locator, secret);
  const window = store.scan([
    KEYSPACE.WINDOW,
    "structural-multi-window",
    1,
    claims.windowOrdinal,
  ], { limit: 1 })[0].payload;
  assert.ok(claims.matchRange.startByte >= window.startByte);
  assert.ok(claims.matchRange.endByte <= window.endByte);
  const recalled = await recallArchive(store, {
    locator: response.results[0].locator,
    neighbors: 0,
    maxTokens: 100,
  }, {
    project: "/workspace/search",
    scope: "session",
    sessionIds: ["session-main"],
    secret,
    now: 2_000,
  });
  assert.equal(recalled.status, "resolved");
  assert.match(recalled.text, /needlemiddle/u);
});

test("bounded structural recall centers a query inside a large default window", async (t) => {
  const { store, worker } = await fixture(t, "search-structural-large-window");
  const target = "multilocatorneedle";
  const text = `${"pad ".repeat(100_000)}${target}${" tail".repeat(20_000)}`;
  await admitDocument(store, request("structural-large-window", text), {
    chunking: { maxChunkBytes: 64 * 1_024, minLineSplitBytes: 0 },
  });
  await worker.drain({ maxDurationMs: 30_000, throwOnError: true });
  const secret = Buffer.alloc(32, 0x43);
  const response = await searchArchive(store, withoutUndefined(searchRequest(target, {
    relation: "latest-question",
  })), {
    secret,
    now: 1_000,
    leaseMs: 30_000,
    ownerId: "message:structural-large-window",
  });
  assert.equal(response.status, "resolved");
  assert.match(response.results[0].snippet, /multilocatorneedle/u);
  const claims = verifyLocator(response.results[0].locator, secret);
  assert.equal(claims.matchRange.endByte - claims.matchRange.startByte, Buffer.byteLength(target));

  const recalled = await recallArchive(store, {
    locator: response.results[0].locator,
    neighbors: 0,
    maxTokens: 100,
  }, {
    project: "/workspace/search",
    scope: "session",
    sessionIds: ["session-main"],
    secret,
    now: 2_000,
  });
  assert.equal(recalled.status, "resolved");
  assert.match(recalled.text, /multilocatorneedle/u);
});

test("visibility, lineage, and project boundaries apply before result limits", async (t) => {
  const { store, worker } = await fixture(t, "search-scope");
  await admit(store, "current", "BOUNDARY_TERM visible evidence", { sourceKey: "user:visible", createdAt: 300 });
  await admit(store, "ancestor", "BOUNDARY_TERM ancestor evidence", {
    sessionId: "session-parent",
    createdAt: 200,
  });
  await admit(store, "sibling", "BOUNDARY_TERM sibling evidence", {
    sessionId: "session-sibling",
    createdAt: 400,
  });
  await admit(store, "foreign", "BOUNDARY_TERM foreign project evidence", {
    project: "/workspace/foreign",
    sessionId: "session-foreign",
    createdAt: 500,
  });
  await worker.drain();
  const lineage = await searchArchive(store, withoutUndefined(searchRequest("BOUNDARY_TERM", {
    sessionIds: ["session-main", "session-parent"],
    excludeVisibleSourceKeys: ["user:visible"],
    limit: 1,
  })), { now: 1_000 });
  assert.deepEqual(lineage.results.map(({ documentId }) => documentId), ["ancestor"]);

  const allAuthorized = await searchArchive(store, withoutUndefined(searchRequest("BOUNDARY_TERM", {
    scope: "all",
    sessionId: undefined,
    project: "/workspace/search",
    limit: 10,
  })), { now: 2_000 });
  assert.deepEqual(
    new Set(allAuthorized.results.map(({ documentId }) => documentId)),
    new Set(["current", "ancestor", "sibling"]),
  );
  assert.equal(allAuthorized.results.some(({ documentId }) => documentId === "foreign"), false);
});

test("new versions and tombstones cannot leak through exact-first retrieval", async (t) => {
  const { store, worker } = await fixture(t, "search-version");
  await admit(store, "versioned", "OLD_VERSION_SYMBOL historical evidence", { version: 1 });
  await worker.drain();
  await admit(store, "versioned", "Replacement contains unrelated current evidence", { version: 2 });
  assert.deepEqual(await store.get(["supersession", "versioned", 1]), {
    documentId: "versioned",
    documentVersion: 1,
    status: "superseded",
    replacementVersion: 2,
    reason: "Replaced by immutable document version 2.",
    recordedAt: (await store.get(["supersession", "versioned", 1])).recordedAt,
  });
  await worker.drain();
  const replaced = await searchArchive(store, withoutUndefined(searchRequest("OLD_VERSION_SYMBOL")), { now: 1_000 });
  assert.equal(replaced.status, "not-found");

  await admit(store, "tombstoned", "TOMBSTONE_SYMBOL should disappear");
  await worker.drain();
  await store.put(["supersession", "tombstoned", 1], {
    documentId: "tombstoned",
    documentVersion: 1,
    status: "expired",
    reason: "test expiry",
    recordedAt: 2_000,
  });
  const tombstoned = await searchArchive(store, withoutUndefined(searchRequest("TOMBSTONE_SYMBOL")), { now: 3_000 });
  assert.equal(tombstoned.status, "not-found");
});

test("a candidate tombstoned after collection is skipped instead of failing the search", async (t) => {
  const { store, worker } = await fixture(t, "search-retention-race");
  await admit(store, "race", "SEARCH_RETENTION_RACE historical evidence");
  await worker.drain();

  const originalSnapshot = store.snapshot.bind(store);
  let collected;
  const collectedPromise = new Promise((resolve) => { collected = resolve; });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let firstSnapshot = true;
  store.snapshot = async (callback) => {
    const result = await originalSnapshot(callback);
    if (firstSnapshot) {
      firstSnapshot = false;
      collected();
      await gate;
    }
    return result;
  };

  const pending = searchArchive(
    store,
    withoutUndefined(searchRequest("SEARCH_RETENTION_RACE")),
    { now: 1_000 },
  );
  await collectedPromise;
  await store.put(["supersession", "race", 1], {
    documentId: "race",
    documentVersion: 1,
    status: "expired",
    reason: "forced search-retention race",
    recordedAt: 1_001,
  });
  resume();

  const response = await pending;
  assert.equal(response.status, "not-found");
  assert.equal(response.results.length, 0);
  assert.equal(store.scan(["lease", "by-id"]).length, 0);
});

test("unavailable source identities never leak through exact or structural fallback", async (t) => {
  const { store, worker } = await fixture(t, "search-unavailable-source");
  await admit(store, "legacy", "LEGACY_SYNTHETIC_ANCHOR historical evidence", {
    sourceKey: "sqlite:internal-database-id:1",
    sourceKeyStatus: "unavailable",
    sourceMessageKeys: [],
    structuralMessages: [],
  });
  await worker.drain();

  const exact = await searchArchive(
    store,
    withoutUndefined(searchRequest("LEGACY_SYNTHETIC_ANCHOR")),
    { now: 1_000 },
  );
  assert.equal(Object.hasOwn(exact.results[0].source, "messageKey"), false);

  const structural = await searchArchive(store, withoutUndefined(searchRequest("", {
    relation: "latest-question",
  })), { now: 2_000 });
  assert.equal(Object.hasOwn(structural.results[0].source, "messageKey"), false);
});

test("no-result searches create no retrieval leases and malformed requests fail closed", async (t) => {
  const { store, worker } = await fixture(t, "search-negative");
  await admit(store, "known", "known historical information");
  await worker.drain();
  const before = store.scan(["lease", "by-id"]).length;
  const response = await searchArchive(store, withoutUndefined(searchRequest("UNSEEN_IDENTIFIER")), { now: 1_000 });
  assert.equal(response.status, "not-found");
  assert.equal(response.results.length, 0);
  assert.equal(store.scan(["lease", "by-id"]).length, before);
  await assert.rejects(searchArchive(store, withoutUndefined(searchRequest("known", {
    scope: "session",
    sessionId: undefined,
    sessionIds: [],
  }))), /requires sessionId or sessionIds/u);
  await assert.rejects(searchArchive(store, {
    ...withoutUndefined(searchRequest("known")),
    project: "",
  }), /at least 1 characters|project boundary/u);
});

test("search counts a tombstoned document with no live replacement as expired without exposing its content", async (t) => {
  const { store, worker } = await fixture(t, "search-expired-count");
  await admit(store, "expired-doc", "EXPIRED_COUNT_ANCHOR sensitive prior detail.");
  await worker.drain();
  await store.put([KEYSPACE.SUPERSESSION, "expired-doc", 1], {
    documentId: "expired-doc",
    documentVersion: 1,
    status: "expired",
    reason: "Retention class conversation-source expired.",
    recordedAt: 2_000,
  });

  const response = await searchArchive(
    store,
    withoutUndefined(searchRequest("EXPIRED_COUNT_ANCHOR")),
    { now: 3_000 },
  );
  assert.equal(response.status, "not-found");
  assert.equal(response.results.length, 0);
  assert.deepEqual(response.expiredMatches, { count: 1, retentionClasses: ["conversation-source"] });
  assert.equal(JSON.stringify(response).includes("sensitive prior detail"), false);
});

test("a version-bump supersession is not counted among expired matches", async (t) => {
  const { store, worker } = await fixture(t, "search-superseded-not-expired");
  await admit(store, "superseded-doc", "SUPERSEDED_ONLY_ANCHOR original wording.");
  await worker.drain();
  await admit(store, "superseded-doc", "Replacement text without the old anchor.", { version: 2 });
  // No further drain: the version-bump supersession marker on v1 is already
  // durable, but v1's own postings have not been through an index cleanup
  // pass yet, so the lexical candidate loop must classify the marker itself.
  const response = await searchArchive(
    store,
    withoutUndefined(searchRequest("SUPERSEDED_ONLY_ANCHOR")),
    { now: 1_000 },
  );
  assert.equal(response.status, "not-found");
  assert.deepEqual(response.expiredMatches, { count: 0, retentionClasses: [] });
});

test("a manifest missing with no tombstone marker yet is classified expired from document history", async (t) => {
  const { store, worker } = await fixture(t, "search-expired-history-fallback");
  await admit(store, "history-fallback", "HISTORY_FALLBACK_ANCHOR evidence removed by retention.");
  await worker.drain();
  // Simulate retention's canonical-cleanup phase completing before its
  // separate index-delete outbox pass, and before this document's tombstone
  // metadata was itself audited away — leaving only the durable ledger.
  await store.remove(manifestKeys.document("history-fallback", 1));
  await store.put(manifestKeys.documentHistory("history-fallback"), {
    documentHistoryFormatVersion: DOCUMENT_HISTORY_FORMAT_VERSION,
    documentId: "history-fallback",
    project: "/workspace/search",
    highestAdmittedVersion: 1,
    retiredThrough: 1,
  });

  const response = await searchArchive(
    store,
    withoutUndefined(searchRequest("HISTORY_FALLBACK_ANCHOR")),
    { now: 1_000 },
  );
  assert.equal(response.status, "not-found");
  assert.equal(response.results.length, 0);
  assert.deepEqual(response.expiredMatches, { count: 1, retentionClasses: ["conversation-source"] });
});

// System-side RM3/Bo1 query expansion fixture: "weak" matches only one of
// three query terms (low term coverage) but shares a rare, high-IDF term
// ("zephyrindex") with "expansion-target", which matches none of the literal
// query terms at all. The filler documents exist only to keep weak's other
// vocabulary words at a higher document frequency (lower IDF) than
// zephyrindex, so a deterministic IDF ranking always selects it.
async function seedExpansionFixture(store) {
  await admit(store, "weak", "gadget notes maintenance schedule zephyrindex updates important");
  await admit(store, "expansion-target", "zephyrindex rotation cadence review important", { createdAt: 150 });
  await admit(store, "filler-1", "maintenance notes for the archive process are important", { createdAt: 160 });
  await admit(store, "filler-2", "schedule updates happen every maintenance cycle", { createdAt: 170 });
  await admit(store, "filler-3", "important notes about schedule updates continue", { createdAt: 180 });
}

test("weak first-pass evidence gated behind allowExpansion pulls in RM3-expanded documents", async (t) => {
  const { store, worker } = await fixture(t, "search-rm3-expansion");
  await seedExpansionFixture(store);
  await worker.drain();
  const query = "gadget widget contraption";

  const baseline = await searchArchive(
    store,
    withoutUndefined(searchRequest(query, { limit: 10 })),
    { now: 1_000 },
  );
  assert.equal(baseline.mode, "lexical");
  assert.deepEqual(baseline.results.map(({ documentId }) => documentId), ["weak"]);
  assert.ok(baseline.results[0].termCoverage < 0.5, "only one of three query terms matched");
  assert.equal(baseline.results[0].expandedTerms.length, 0);

  const expanded = await searchArchive(
    store,
    withoutUndefined(searchRequest(query, { limit: 10 })),
    { now: 1_001, allowExpansion: true },
  );
  const target = expanded.results.find(({ documentId }) => documentId === "expansion-target");
  assert.ok(target !== undefined, "RM3 requery should surface a document sharing only expansion vocabulary");
  assert.ok(target.expandedTerms.includes(normalizeBm25Term("zephyrindex")));
  assert.ok(target.matchedTerms.includes(normalizeBm25Term("zephyrindex")));
  assert.equal(target.historical, true);
  assert.ok(target.locator);

  // expansionPolicy: "never" opts back out even when the caller allows it.
  const disabledByPolicy = await searchArchive(
    store,
    withoutUndefined(searchRequest(query, { limit: 10, expansionPolicy: "never" })),
    { now: 1_002, allowExpansion: true },
  );
  assert.equal(
    disabledByPolicy.results.some(({ documentId }) => documentId === "expansion-target"),
    false,
  );
});

test("RM3 expansion never fires when an exact anchor already resolved the query", async (t) => {
  const { store, worker } = await fixture(t, "search-rm3-exact-gate");
  await seedExpansionFixture(store);
  await admit(store, "exact-anchor", "EXACT_RM3_ANCHOR gadget notes", { createdAt: 190 });
  await worker.drain();

  const response = await searchArchive(
    store,
    withoutUndefined(searchRequest("EXACT_RM3_ANCHOR gadget widget contraption", { limit: 10 })),
    { now: 1_000, allowExpansion: true },
  );
  assert.equal(response.mode, "exact");
  assert.equal(response.results.some(({ documentId }) => documentId === "expansion-target"), false);
});

test("RM3 expansion never fires when first-pass lexical coverage is already strong", async (t) => {
  const { store, worker } = await fixture(t, "search-rm3-strong-gate");
  await seedExpansionFixture(store);
  await worker.drain();

  const response = await searchArchive(
    store,
    withoutUndefined(searchRequest("gadget", { limit: 10 })),
    { now: 1_000, allowExpansion: true },
  );
  assert.deepEqual(response.results.map(({ documentId }) => documentId), ["weak"]);
  assert.equal(response.results[0].termCoverage, 1);
  assert.equal(response.results.some(({ documentId }) => documentId === "expansion-target"), false);
});

test("automatic preflight never triggers RM3 expansion regardless of how weak the evidence is", async (t) => {
  const { store, worker } = await fixture(t, "search-rm3-preflight-gate");
  await seedExpansionFixture(store);
  await worker.drain();

  const hint = await preflightArchive(
    store,
    preflightRequest("user:rm3-preflight", "gadget widget contraption status?"),
    { now: 1_000, epochId: "epoch:rm3-preflight" },
  );
  assert.equal(hint.modelVisibleText.includes("expansion-target"), false);
  assert.equal(hint.modelVisibleText.includes("zephyrindex"), false);
  if (hint.diagnostics) {
    assert.equal(hint.diagnostics.candidate?.documentId === "expansion-target", false);
  }

  // The identical query, explicitly opted in through the store.search path
  // preflight never uses, does surface the expanded document — proving the
  // preflight run above was actually gated, not merely unlucky with ranking.
  const explicit = await searchArchive(
    store,
    withoutUndefined(searchRequest("gadget widget contraption status", { limit: 10 })),
    { now: 1_001, allowExpansion: true },
  );
  assert.ok(explicit.results.some(({ documentId }) => documentId === "expansion-target"));
});

test("RM3 expansion terms survive requery even when re-stemming the term would change it", async (t) => {
  // Porter stemming is not idempotent: normalizeBm25Term("universities") is
  // "univers", but normalizeBm25Term("univers") is "univ". If the requery
  // ever routed the selected expansion term back through the query-string
  // tokenizer/stemmer instead of matching postings by exact stemmed term,
  // this document (which shares no other vocabulary with the query) would
  // never surface, and no expandedTerms could ever legitimately name it.
  assert.equal(normalizeBm25Term("universities"), "univers");
  assert.equal(normalizeBm25Term(normalizeBm25Term("universities")), "univ");

  const { store, worker } = await fixture(t, "search-rm3-stem-roundtrip");
  await admit(store, "weak", "gadget notes maintenance schedule universities updates important");
  await admit(store, "expansion-target", "universities rotation cadence review important", { createdAt: 150 });
  await admit(store, "filler-1", "maintenance notes for the archive process are important", { createdAt: 160 });
  await admit(store, "filler-2", "schedule updates happen every maintenance cycle", { createdAt: 170 });
  await admit(store, "filler-3", "important notes about schedule updates continue", { createdAt: 180 });
  await worker.drain();

  const expanded = await searchArchive(
    store,
    withoutUndefined(searchRequest("gadget widget contraption", { limit: 10 })),
    { now: 1_001, allowExpansion: true },
  );
  const target = expanded.results.find(({ documentId }) => documentId === "expansion-target");
  assert.ok(target !== undefined, "a non-stem-stable expansion term must still surface its target document");
  assert.ok(target.expandedTerms.includes(normalizeBm25Term("universities")));
  assert.ok(target.matchedTerms.includes(normalizeBm25Term("universities")));
});

test("RM3 requery does not throw when the published generation advances between the first pass and the requery", async (t) => {
  const { store, worker } = await fixture(t, "search-rm3-generation-race");
  await seedExpansionFixture(store);
  await worker.drain();

  // Simulate the daemon's index worker publishing a new generation
  // concurrently with this explicit search: intercept store.snapshot to
  // admit and index an unrelated document strictly between the RM3
  // term-selection snapshot and the RM3 requery snapshot, so the requery
  // observes a generation newer than the one the first pass captured.
  let snapshotCalls = 0;
  let bumped = false;
  let suppressReentrancy = false;
  const realSnapshot = store.snapshot.bind(store);
  store.snapshot = async (fn) => {
    if (suppressReentrancy) return realSnapshot(fn);
    snapshotCalls += 1;
    const result = await realSnapshot(fn);
    if (snapshotCalls === 2 && !bumped) {
      bumped = true;
      suppressReentrancy = true;
      await admit(store, "concurrent-publish", "unrelated document admitted mid-search", { createdAt: 500 });
      await worker.drain();
      suppressReentrancy = false;
    }
    return result;
  };
  t.after(() => {
    store.snapshot = realSnapshot;
  });

  const expanded = await searchArchive(
    store,
    withoutUndefined(searchRequest("gadget widget contraption", { limit: 10 })),
    { now: 1_001, allowExpansion: true },
  );
  assert.equal(expanded.mode, "lexical");
  assert.ok(expanded.results.some(({ documentId }) => documentId === "expansion-target"));
});
