import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RETRIEVAL_REGRESSION_FIXTURE } from "../eval/retrieval/fixtures.js";
import { runRetrievalEvaluation } from "../eval/retrieval/runner.js";
import { RETRIEVAL_BACKEND_API_VERSION } from "../eval/retrieval/schema.js";
import { scoreRetrievalSuite } from "../eval/retrieval/scoring.js";
import { createBm25IndexHandler, searchBm25 } from "../src/rocksdb/index/bm25.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import {
  DEFAULT_EXACT_SNIPPET_BYTES,
  buildExactIndexMutations,
  classifyExactValue,
  classifyWorkingSetAnchors,
  createExactIndexHandler,
  exactSnippet,
  extractExactAnchors,
  lookupExact,
  lookupExactAnchorDocuments,
  normalizeExactValue,
  planExactQuery,
} from "../src/rocksdb/index/exact.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function document(id, text, overrides = {}) {
  const sequence = overrides.sequence ?? 1;
  return {
    documentId: id,
    version: 1,
    sourceKey: overrides.sourceKey ?? `user:${id}`,
    sessionId: overrides.sessionId ?? "session-main",
    project: overrides.project ?? "/workspace/exact",
    kind: overrides.kind ?? "turn",
    createdAt: overrides.createdAt ?? sequence * 86_400_000,
    text,
    metadata: { turnId: `turn-${id}`, ...(overrides.metadata ?? {}) },
    sourceMessageKeys: overrides.sourceMessageKeys ?? [overrides.sourceKey ?? `user:${id}`],
  };
}

async function admit(store, candidate, options = {}) {
  return admitDocument(store, {
    idempotencyKey: `exact:${candidate.documentId}:${candidate.version}`,
    document: candidate,
    structuralMessages: options.structuralMessages ?? [],
    retentionClass: "conversation-source",
  }, {
    chunking: { maxChunkBytes: options.maxChunkBytes ?? 64, minLineSplitBytes: 0 },
    windows: { windowTokens: options.windowTokens ?? 8, overlapTokens: options.overlapTokens ?? 2 },
  });
}

async function indexPending(store, options = {}) {
  const worker = new IndexWorker(store, {
    workerId: options.workerId ?? "worker:exact-test",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(options.index)],
  });
  return worker.drain({ limit: options.limit ?? 1_000, maxDurationMs: 30_000, throwOnError: true });
}

test("extractor recognizes referent families with exact UTF-8 coordinates", () => {
  const text = "雪🙂 "
    + "'literal value' src/rocksdb/index/exact.js Namespace.member camelCase "
    + "REAP_DRAIN RESPONSE_CHANNEL_CLOSED 9f8e7d6a warm-harbor TypeError v1.2.3";
  const anchors = extractExactAnchors(text);
  const byValue = new Map(anchors.map((anchor) => [anchor.value, anchor]));
  assert.deepEqual(
    [...new Set(anchors.map(({ type }) => type))].sort(),
    ["commit", "dotted-name", "error", "path", "quoted-value", "symbol", "value"],
  );
  for (const value of [
    "literal value",
    "src/rocksdb/index/exact.js",
    "Namespace.member",
    "camelCase",
    "REAP_DRAIN",
    "RESPONSE_CHANNEL_CLOSED",
    "9f8e7d6a",
    "warm-harbor",
    "TypeError",
    "v1.2.3",
  ]) {
    const anchor = byValue.get(value);
    assert.ok(anchor, `missing ${value}`);
    assert.equal(Buffer.from(text).subarray(anchor.startByte, anchor.endByte).toString("utf8"), value);
  }
  assert.equal(byValue.get("REAP_DRAIN").type, "symbol");
  assert.equal(byValue.get("RESPONSE_CHANNEL_CLOSED").type, "error");
  assert.equal(byValue.get("9f8e7d6a").caseSensitive, false);
  assert.equal(normalizeExactValue("ＲＥＡＰ＿ＤＲＡＩＮ", { foldCase: true }), "reap_drain");
  assert.deepEqual(classifyExactValue("src/rocksdb/index/exact.js"), {
    type: "path",
    value: "src/rocksdb/index/exact.js",
  });
});

test("camel-case extraction rejects dense underscore candidates without backtracking", () => {
  // The old nested camel-case regexp explored exponentially many partitions
  // before its trailing word boundary failed against the underscore.
  const adversarial = `A${"aA".repeat(25)}_`;
  const startedAt = performance.now();
  const anchors = extractExactAnchors(`${adversarial} camelCase TypeError`);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 250, `exact extraction took ${elapsedMs.toFixed(1)} ms`);
  assert.deepEqual(
    anchors.filter(({ type }) => type === "symbol" || type === "error")
      .map(({ type, value }) => ({ type, value })),
    [
      { type: "symbol", value: "camelCase" },
      { type: "error", value: "TypeError" },
    ],
  );
  assert.deepEqual(classifyExactValue("camel-Case"), {
    type: "value",
    value: "camel-Case",
  });
});

test("dense exact anchors compute UTF-8 offsets in linear time", () => {
  const unit = "camelCase ";
  const text = unit.repeat(Math.ceil((256 * 1_024) / unit.length)).slice(0, 256 * 1_024);
  const startedAt = performance.now();
  const anchors = extractExactAnchors(text);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(anchors.length > 20_000);
  assert.ok(elapsedMs < 250, `dense exact extraction took ${elapsedMs.toFixed(1)} ms`);
});

test("exact offset mapping agrees with UTF-8 prefixes across randomized scalars", () => {
  const scalars = ["a", "é", "雪", "🙂"];
  let seed = 0x5eed1234;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  let text = "";
  const expectedStarts = [];
  for (let index = 0; index < 200; index += 1) {
    const prefixLength = 1 + (random() % 8);
    for (let offset = 0; offset < prefixLength; offset += 1) {
      text += scalars[random() % scalars.length];
    }
    text += " ";
    expectedStarts.push(Buffer.byteLength(text, "utf8"));
    text += `camelCase${index} `;
  }
  const symbols = extractExactAnchors(text)
    .filter(({ type, value }) => type === "symbol" && value.startsWith("camelCase"));
  assert.equal(symbols.length, expectedStarts.length);
  for (let index = 0; index < symbols.length; index += 1) {
    assert.equal(symbols[index].startByte, expectedStarts[index]);
    assert.equal(
      Buffer.from(text).subarray(symbols[index].startByte, symbols[index].endByte).toString("utf8"),
      `camelCase${index}`,
    );
  }
  assert.throws(() => extractExactAnchors("bad\ud800 camelCase"), /unpaired UTF-16 surrogates/u);
});

test("query planning preserves exact-looking input before broadening", () => {
  for (const [query, type] of [
    ["REAP_DRAIN", "symbol"],
    ["src/rocksdb/index/exact.js", "path"],
    ["RESPONSE_CHANNEL_CLOSED", "error"],
    ["9f8e7d6a", "commit"],
    ["warm-harbor", "value"],
    ['"literal value"', "quoted-value"],
  ]) {
    const plan = planExactQuery(query);
    assert.equal(plan.exactLooking, true);
    assert.equal(plan.preservedWhole, true);
    assert.equal(plan.requiresExactFirst, true);
    assert.equal(plan.broadeningAllowed, false);
    assert.equal(plan.anchors.length, 1);
    assert.equal(plan.anchors[0].type, type);
  }
  const prose = planExactQuery("Where did RESPONSE_CHANNEL_CLOSED happen?");
  assert.equal(prose.preservedWhole, false);
  assert.deepEqual(prose.anchors.map(({ value }) => value), ["RESPONSE_CHANNEL_CLOSED"]);
  assert.equal(planExactQuery("ordinary historical prose").broadeningAllowed, true);
});

test("handler emits deterministic, source-linked window postings without source copies", () => {
  const text = "prefix REAP_DRAIN middle REAP_DRAIN suffix";
  const manifest = {
    documentId: "doc",
    version: 1,
    project: "/workspace/exact",
    sessionId: "session-main",
    createdAt: 86_400_001,
    kind: "turn",
    sourceKey: "user:doc",
    sourceMessageKeys: ["user:doc"],
    metadata: { turnId: "turn-doc" },
  };
  const windows = [
    { ordinal: 0, startByte: 0, endByte: 25 },
    { ordinal: 1, startByte: 20, endByte: Buffer.byteLength(text) },
  ];
  const context = { generation: 7, text, manifest, windows };
  const first = buildExactIndexMutations(context, { bucketMs: 86_400_000 });
  const second = buildExactIndexMutations(context, { bucketMs: 86_400_000 });
  assert.deepEqual(first, second);
  assert.equal(first.metadata.anchorCount, 2);
  assert.equal(first.metadata.bucket, 1);
  assert.ok(first.mutations.length >= 2);
  assert.ok(first.mutations.every(({ key, payload }) => key[0] === KEYSPACE.EXACT
    && payload.documentId === "doc"
    && payload.sourceVersion === 1
    && payload.matches.length >= 1));
  assert.equal(JSON.stringify(first).includes(text), false);
});

test("lookup honors scope, visibility, newest buckets, work caps, and case fallback", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-lookup"));
  t.after(() => store.close());
  await admit(store, document("old", "REAP_DRAIN selected warm-harbor.", {
    sessionId: "session-main",
    createdAt: 86_400_000,
  }));
  await admit(store, document("new", "The REAP_DRAIN state is newer.", {
    sessionId: "session-main",
    createdAt: 3 * 86_400_000,
  }));
  await admit(store, document("other-session", "REAP_DRAIN belongs elsewhere.", {
    sessionId: "session-other",
    createdAt: 4 * 86_400_000,
  }));
  const drain = await indexPending(store);
  assert.equal(drain.processed, 3);

  const scoped = await lookupExact(store, {
    query: "REAP_DRAIN",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    limit: 3,
  });
  assert.deepEqual(scoped.results.map(({ documentId }) => documentId), ["new", "old"]);
  assert.equal(scoped.results[0].matchType, "exact-symbol");
  assert.equal(scoped.results[0].createdAt, 3 * 86_400_000);
  assert.equal(scoped.results[0].score, 0.9952);
  assert.deepEqual(scoped.results[0].matchedAnchors, ["REAP_DRAIN"]);
  assert.match(scoped.results[0].snippet, /REAP_DRAIN/u);
  assert.equal(scoped.results[0].source.messageKey, "user:new");
  assert.equal(scoped.results[0].explanation.mode, "exact");
  assert.equal(scoped.results[0].location.windowOrdinal >= 0, true);

  const project = await lookupExact(store, {
    query: "REAP_DRAIN",
    project: "/workspace/exact",
    scope: "project",
    limit: 3,
  });
  assert.deepEqual(project.results.map(({ documentId }) => documentId), ["other-session", "new", "old"]);

  const excluded = await lookupExact(store, {
    query: "REAP_DRAIN",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    excludeVisibleSourceKeys: ["user:new"],
    limit: 3,
  });
  assert.deepEqual(excluded.results.map(({ documentId }) => documentId), ["old"]);

  const folded = await lookupExact(store, {
    query: "WARM-HARBOR",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
  });
  assert.deepEqual(folded.results.map(({ documentId }) => documentId), ["old"]);
  assert.equal(folded.work.caseFallbackUsed, true);
  assert.equal(folded.results[0].createdAt, 86_400_000);
  assert.equal(folded.results[0].score, 0.9204);
  assert.deepEqual(folded.results[0].matchedAnchors, ["WARM-HARBOR"]);
  assert.equal(folded.results[0].explanation.caseMode, "folded");
  assert.equal(folded.results[0].explanation.matchedValue, "warm-harbor");

  const bounded = await lookupExact(store, {
    query: "REAP_DRAIN",
    project: "/workspace/exact",
    scope: "project",
    workLimit: 1,
    bucketLimit: 1,
  });
  assert.equal(bounded.work.postingsRead, 1);
  assert.equal(bounded.work.bucketsVisited, 1);
  assert.equal(bounded.work.truncated, true);
  assert.deepEqual(bounded.results.map(({ documentId }) => documentId), ["other-session"]);
});

test("classifyWorkingSetAnchors reuses classifyExactValue on each whole entry and dedups by identity", () => {
  const anchors = classifyWorkingSetAnchors([
    "src/rocksdb/index/exact.js",
    "REAP_DRAIN",
    "  REAP_DRAIN  ",
    "this is free-text prose, not an anchor",
    "",
    "warm-harbor",
  ]);
  assert.deepEqual(
    anchors.map(({ type, value }) => ({ type, value })),
    [
      { type: "path", value: "src/rocksdb/index/exact.js" },
      { type: "symbol", value: "REAP_DRAIN" },
      { type: "value", value: "warm-harbor" },
    ],
  );
  assert.equal(classifyWorkingSetAnchors(undefined).length, 0);
  assert.equal(classifyWorkingSetAnchors([]).length, 0);
  assert.equal(classifyWorkingSetAnchors([42, null, "   "]).length, 0);
  // Bounded: only the first maxEntries survive, mirroring the request
  // schema's own maxItems cap upstream.
  const many = Array.from({ length: 20 }, (_, index) => `ANCHOR_${index}`);
  assert.equal(classifyWorkingSetAnchors(many).length, 16);
  assert.equal(classifyWorkingSetAnchors(many, { maxEntries: 3 }).length, 3);
});

test("lookupExactAnchorDocuments finds documents whose postings intersect classified working-set anchors", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-working-set"));
  t.after(() => store.close());
  await admit(store, document("has-anchor", "Discusses REAP_DRAIN behavior at length.", {
    sessionId: "session-main",
    createdAt: 1_000,
  }));
  await admit(store, document("other", "An unrelated document about something else.", {
    sessionId: "session-main",
    createdAt: 2_000,
  }));
  await admit(store, document("other-session-anchor", "REAP_DRAIN also appears here.", {
    sessionId: "session-other",
    createdAt: 3_000,
  }));
  await indexPending(store);
  const published = await store.get([KEYSPACE.META, "published-index-generation"]);
  const generation = published?.generation ?? 0;

  const anchors = classifyWorkingSetAnchors(["REAP_DRAIN", "no-match-anchor-xyz"]);
  assert.equal(anchors.length, 2);

  const scoped = await lookupExactAnchorDocuments(store, {
    anchors,
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    generation,
  });
  assert.deepEqual([...scoped.matchesByDocument.keys()], ["has-anchor"]);
  assert.deepEqual([...scoped.matchesByDocument.get("has-anchor")], ["REAP_DRAIN"]);
  assert.equal(scoped.truncated, false);

  const projectScoped = await lookupExactAnchorDocuments(store, {
    anchors,
    project: "/workspace/exact",
    scope: "project",
    generation,
  });
  assert.deepEqual(
    [...projectScoped.matchesByDocument.keys()].sort(),
    ["has-anchor", "other-session-anchor"],
  );

  const noAnchors = await lookupExactAnchorDocuments(store, {
    anchors: [],
    project: "/workspace/exact",
    scope: "project",
    generation,
  });
  assert.equal(noAnchors.matchesByDocument.size, 0);
  assert.equal(noAnchors.truncated, false);

  const bounded = await lookupExactAnchorDocuments(store, {
    anchors,
    project: "/workspace/exact",
    scope: "project",
    generation,
    workLimit: 1,
  });
  assert.equal(bounded.truncated, true);

  await assert.rejects(
    lookupExactAnchorDocuments(store, { anchors, project: "/workspace/exact", scope: "project" }),
    /generation must be a non-negative safe integer/,
  );
});

test("lookupExactAnchorDocuments falls back to the folded keyspace only when the exact-case pass found nothing at all, mirroring lookupExact's own global case fallback", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-working-set-case-fallback"));
  t.after(() => store.close());
  await admit(store, document("exact-hit", "REAP_DRAIN appears exactly as written.", {
    sessionId: "session-main",
    createdAt: 1_000,
  }));
  await admit(store, document("folded-only", "warm-harbor only ever appears lowercase.", {
    sessionId: "session-main",
    createdAt: 2_000,
  }));
  await indexPending(store);
  const published = await store.get([KEYSPACE.META, "published-index-generation"]);
  const generation = published?.generation ?? 0;

  // WARM-HARBOR never appears in exact case anywhere in the store; scanned
  // alone, it must still be found via the folded fallback.
  const foldedOnly = await lookupExactAnchorDocuments(store, {
    anchors: classifyWorkingSetAnchors(["WARM-HARBOR"]),
    project: "/workspace/exact",
    scope: "project",
    generation,
  });
  assert.deepEqual([...foldedOnly.matchesByDocument.keys()], ["folded-only"]);

  // Once a different anchor in the same request already resolves an
  // exact-case match, the request has "found something" overall, so the
  // folded fallback (a global gate, exactly like lookupExact/scanCaseMode's
  // own candidates.size === 0 condition, not a per-anchor one) never runs --
  // WARM-HARBOR's case-mismatched document is not found this time.
  const withExactHit = await lookupExactAnchorDocuments(store, {
    anchors: classifyWorkingSetAnchors(["REAP_DRAIN", "WARM-HARBOR"]),
    project: "/workspace/exact",
    scope: "project",
    generation,
  });
  assert.deepEqual([...withExactHit.matchesByDocument.keys()], ["exact-hit"]);
});

test("exact lookup counts a tombstoned document with no live replacement as expired without exposing its content", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-expired-count"));
  t.after(() => store.close());
  await admit(store, document("expired-doc", "EXPIRED_EXACT_ANCHOR sensitive prior detail."));
  await indexPending(store);
  await store.put([KEYSPACE.SUPERSESSION, "expired-doc", 1], {
    documentId: "expired-doc",
    documentVersion: 1,
    status: "expired",
    reason: "Retention class conversation-source expired.",
    recordedAt: 2_000,
  });

  const result = await lookupExact(store, {
    query: "EXPIRED_EXACT_ANCHOR",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    limit: 3,
  });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.work.expiredMatches, { count: 1, retentionClasses: ["conversation-source"] });
  assert.equal(JSON.stringify(result).includes("sensitive prior detail"), false);
});

test("a version-bump supersession is not counted among exact expired matches", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-superseded-not-expired"));
  t.after(() => store.close());
  await admit(store, document("superseded-doc", "SUPERSEDED_EXACT_ANCHOR original wording."));
  await indexPending(store);
  // No further drain: the version-bump supersession marker on v1 is already
  // durable from admitDocument itself, but v1's own postings have not been
  // through an index cleanup pass yet, so the exact candidate loop must
  // classify the marker itself.
  await admit(store, { ...document("superseded-doc", "Replacement text without the old anchor."), version: 2 });

  const result = await lookupExact(store, {
    query: "SUPERSEDED_EXACT_ANCHOR",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    limit: 3,
  });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.work.expiredMatches, { count: 0, retentionClasses: [] });
});

test("exact and lexical passes sharing one map do not double-count the same expired document", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-shared-dedup"));
  t.after(() => store.close());
  await admit(store, document("shared-expired", "SHARED_EXPIRED_ANCHOR sensitive shared detail."));
  const worker = new IndexWorker(store, {
    workerId: "worker:exact-shared-dedup",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });
  await store.put([KEYSPACE.SUPERSESSION, "shared-expired", 1], {
    documentId: "shared-expired",
    documentVersion: 1,
    status: "expired",
    reason: "Retention class conversation-source expired.",
    recordedAt: 2_000,
  });

  const expiredRetentionClasses = new Map();
  const exact = await lookupExact(store, {
    query: "SHARED_EXPIRED_ANCHOR",
    project: "/workspace/exact",
    scope: "session",
    sessionId: "session-main",
    limit: 3,
    expiredRetentionClasses,
  });
  const lexical = await searchBm25(store, {
    query: "SHARED_EXPIRED_ANCHOR",
    project: "/workspace/exact",
    scope: "session",
    sessionIds: ["session-main"],
    excludeVisibleSourceKeys: [],
    limit: 3,
  }, { expiredRetentionClasses });
  assert.equal(exact.results.length, 0);
  assert.equal(lexical.results.length, 0);
  assert.deepEqual({ count: expiredRetentionClasses.size, retentionClasses: [...new Set(expiredRetentionClasses.values())] }, {
    count: 1,
    retentionClasses: ["conversation-source"],
  });
});

test("exact snippets stay UTF-8 safe and retain the match", () => {
  const text = `${"前🙂".repeat(50)}RESPONSE_CHANNEL_CLOSED${"後🪨".repeat(50)}`;
  const startByte = Buffer.byteLength(text.slice(0, text.indexOf("RESPONSE_CHANNEL_CLOSED")));
  const endByte = startByte + Buffer.byteLength("RESPONSE_CHANNEL_CLOSED");
  const snippet = exactSnippet(text, startByte, endByte, 96);
  assert.match(snippet, /RESPONSE_CHANNEL_CLOSED/u);
  assert.ok(Buffer.byteLength(snippet) <= 96);
  assert.doesNotThrow(() => Buffer.from(snippet, "utf8").toString("utf8"));
});

test("exact posting pressure keeps high-value anchors and reports a partial generation", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-ranked-partial"));
  t.after(() => store.close());
  const target = "RESPONSE_CHANNEL_CLOSED";
  const filler = Array.from(
    { length: 600 },
    (_, index) => `low-value-${String(index).padStart(4, "0")}`,
  );
  const candidate = document("ranked-partial", `${filler.join(" ")} ${target}`);
  await admit(store, candidate);
  const drained = await indexPending(store);
  assert.equal(drained.publications[0].indexStatus, "partial");
  const metadata = drained.publications[0].handlers[0].metadata;
  assert.equal(metadata.status, "partial");
  assert.equal(metadata.limitKind, "exact posting mutations");
  assert.ok(metadata.omittedMatchCount > 0);

  const result = await lookupExact(store, {
    query: target,
    project: candidate.project,
    scope: "session",
    sessionId: candidate.sessionId,
  });
  assert.equal(result.results[0].documentId, candidate.documentId);
});

test("exact snippet materialization never reads unrelated document chunks", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-range-only"));
  t.after(() => store.close());
  const text = `${"prefix-padding ".repeat(2_000)}REAP_DRAIN${" suffix-padding".repeat(2_000)}`;
  const candidate = document("range-only", text);
  await admit(store, candidate, { maxChunkBytes: 64, windowTokens: 8, overlapTokens: 0 });
  assert.equal((await indexPending(store)).processed, 1);
  const manifest = await store.get([KEYSPACE.DOCUMENT, candidate.documentId, candidate.version]);
  const codeUnitStart = text.indexOf("REAP_DRAIN");
  const matchStart = Buffer.byteLength(text.slice(0, codeUnitStart), "utf8");
  const matchEnd = matchStart + Buffer.byteLength("REAP_DRAIN", "utf8");
  const selectedStart = Math.max(0, matchStart - DEFAULT_EXACT_SNIPPET_BYTES);
  const selectedEnd = Math.min(
    manifest.byteLength,
    matchEnd + DEFAULT_EXACT_SNIPPET_BYTES,
  );
  const allowed = new Set(manifest.chunks
    .filter((reference) => reference.startByte < selectedEnd
      && reference.endByte > selectedStart)
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
              throw new Error(`exact snippet read unrelated chunk ${key[1]}`);
            }
          }
          return view.get(key, ...args);
        },
        scan: view.scan.bind(view),
      }));
    },
  };
  const result = await lookupExact(guarded, {
    query: "REAP_DRAIN",
    project: candidate.project,
    scope: "session",
    sessionId: candidate.sessionId,
    limit: 1,
  });
  assert.equal(result.results[0].documentId, candidate.documentId);
  assert.match(result.results[0].snippet, /REAP_DRAIN/u);
  assert.ok(chunkReads.size > 0);
  assert.ok([...chunkReads].every((chunkId) => allowed.has(chunkId)));
});

test("frozen exact evaluation reaches 100 percent Recall@3", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "exact-evaluation"));
  t.after(() => store.close());
  let prepared = false;
  const backend = {
    metadata: Object.freeze({
      id: "rocksdb-exact-test-adapter",
      version: "v1",
      apiVersion: RETRIEVAL_BACKEND_API_VERSION,
      capabilities: Object.freeze(["exact"]),
    }),
    async prepare(fixture) {
      assert.equal(prepared, false);
      for (const candidate of fixture.documents) {
        await admit(store, document(candidate.id, candidate.text, {
          sourceKey: candidate.metadata.sourceMessageKeys[0],
          sessionId: candidate.sessionId,
          project: candidate.project,
          kind: candidate.kind,
          createdAt: candidate.createdAt,
          metadata: candidate.metadata,
          sourceMessageKeys: candidate.metadata.sourceMessageKeys,
        }), {
          maxChunkBytes: 256,
          windowTokens: 48,
          overlapTokens: 8,
        });
      }
      const drained = await indexPending(store, { limit: fixture.documents.length });
      assert.equal(drained.processed, fixture.documents.length);
      prepared = true;
    },
    async search(request) {
      assert.equal(prepared, true);
      return lookupExact(store, request);
    },
  };

  const runs = await runRetrievalEvaluation({
    backend,
    fixture: RETRIEVAL_REGRESSION_FIXTURE,
    suites: ["exact"],
  });
  const scored = scoreRetrievalSuite(
    "exact",
    RETRIEVAL_REGRESSION_FIXTURE,
    runs.exact.observations,
  );
  assert.equal(scored.metrics.recallAt3, 1);
  assert.equal(scored.gate.status, "passed");
  assert.deepEqual(
    scored.cases.map(({ relevantRankAt3 }) => relevantRankAt3),
    [1, 1, 1, 1, 1],
  );
});
