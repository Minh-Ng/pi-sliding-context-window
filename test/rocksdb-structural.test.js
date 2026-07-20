import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_SESSION_LINEAGE_IDS } from "../src/store/store-contract.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import {
  createStructuralIndexHandler,
  lookupStructural,
  lookupStructuralAsync,
} from "../src/rocksdb/index/structural.js";
import { DECISION_KEYSPACE, lookupDecisionEvidence } from "../src/rocksdb/index/decisions.js";
import { readDocumentRange } from "../src/rocksdb/document-range.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

function request({
  id,
  sessionId = "session-current",
  project = "/project",
  kind = "turn",
  text,
  createdAt,
  sourceKey = `source:${id}`,
  metadata = {},
  structuralMessages,
}) {
  const value = {
    idempotencyKey: `request:${id}`,
    document: {
      documentId: id,
      version: 1,
      sourceKey,
      sessionId,
      project,
      kind,
      createdAt,
      text,
      metadata,
      sourceMessageKeys: [sourceKey],
    },
    retentionClass: "conversation-source",
  };
  if (structuralMessages !== undefined) value.structuralMessages = structuralMessages;
  return value;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const worker = new IndexWorker(store, { handlers: [createStructuralIndexHandler()] });
  return { store, worker };
}

test("structural handler resolves newest exact messages deterministically", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "turn-1",
    text: "Where is the drain code?\nIt is in reap.js.",
    createdAt: 1,
    structuralMessages: [
      { messageKey: "u1", messageIndex: 0, role: "user", createdAt: 1, text: "Where is the drain code?", questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
      { messageKey: "a1", messageIndex: 1, role: "assistant", createdAt: 1, text: "It is in reap.js.", questionScore: 0, requestScore: 0, correctionScore: 0, answerScore: 100 },
    ],
  }));
  await admitDocument(store, request({
    id: "turn-2",
    text: "Please implement the compactor.\nDone.",
    createdAt: 2,
    structuralMessages: [
      { messageKey: "u2", messageIndex: 0, role: "user", createdAt: 2, text: "Please implement the compactor.", questionScore: 10, requestScore: 100, correctionScore: 0, answerScore: 0 },
      { messageKey: "a2", messageIndex: 1, role: "assistant", createdAt: 2, text: "Done.", questionScore: 0, requestScore: 0, correctionScore: 0, answerScore: 100 },
    ],
  }));
  assert.equal((await worker.drain()).processed, 2);

  const latestRequest = lookupStructural(store, {
    relation: "latest-request",
    sessionId: "session-current",
    project: "/project",
  });
  assert.equal(latestRequest.status, "resolved");
  assert.equal(latestRequest.results[0].structural.messageKey, "u2");
  assert.equal(latestRequest.results[0].snippet, "Please implement the compactor.");

  const filteredQuestion = lookupStructural(store, {
    relation: "latest-question",
    query: "drain",
    sessionId: "session-current",
    project: "/project",
  });
  assert.equal(filteredQuestion.results[0].structural.messageKey, "u1");
});

test("ancestor and broader-scope structural hits remain explicitly ambiguous", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "ancestor-turn",
    sessionId: "session-parent",
    text: "Actually, use the RocksDB daemon.",
    createdAt: 1,
    structuralMessages: [
      { messageKey: "parent-u", messageIndex: 0, role: "user", createdAt: 1, text: "Actually, use the RocksDB daemon.", questionScore: 10, requestScore: 10, correctionScore: 100, answerScore: 0 },
    ],
  }));
  await worker.drain();
  const lineage = lookupStructural(store, {
    relation: "latest-correction",
    sessionIds: ["session-current", "session-parent"],
    project: "/project",
  });
  assert.equal(lineage.status, "ambiguous");
  assert.equal(lineage.results[0].structural.lineageDepth, 1);
  assert.equal(lookupStructural(store, {
    relation: "latest-correction",
    project: "/project",
    scope: "project",
  }).status, "ambiguous");
});

test("structural lookup rejects oversized lineage before index scans", () => {
  let scans = 0;
  const store = {
    scan() {
      scans += 1;
      return [];
    },
  };
  const sessionIds = Array.from(
    { length: MAX_SESSION_LINEAGE_IDS + 1 },
    (_, index) => `session-${index}`,
  );
  assert.throws(() => lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionIds,
  }), /at most 65 unique IDs/u);
  assert.throws(() => lookupDecisionEvidence(store, {
    project: "/project",
    sessionIds,
  }), /at most 65 unique IDs/u);
  assert.equal(scans, 0);
});

test("legacy turns are labeled fallback and can make a newer reference ambiguous", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "modern",
    text: "What is the schema?",
    createdAt: 1,
    structuralMessages: [
      { messageKey: "modern-u", messageIndex: 0, role: "user", createdAt: 1, text: "What is the schema?", questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
    ],
  }));
  await admitDocument(store, request({
    id: "legacy",
    text: "A newer imported turn without message annotations",
    createdAt: 2,
  }));
  await worker.drain();
  const mixed = lookupStructural(store, {
    relation: "latest-question",
    sessionId: "session-current",
    project: "/project",
  });
  assert.equal(mixed.status, "ambiguous");
  assert.equal(mixed.results[0].id, "modern");
  assert.equal(mixed.results[1].structural.legacy, true);

  const legacyOnly = lookupStructural(store, {
    relation: "latest-question",
    query: "imported",
    sessionId: "session-current",
    project: "/project",
  });
  assert.equal(legacyOnly.status, "legacy-fallback");
  assert.equal(legacyOnly.results[0].id, "legacy");
});

test("decision evidence is a verbatim excerpt linked to its source turn", async (t) => {
  const { store, worker } = await fixture(t);
  const excerpt = "Use a single Node daemon to own RocksDB.";
  await admitDocument(store, request({
    id: "decision-1",
    kind: "decision-candidate",
    text: excerpt,
    createdAt: 5,
    metadata: { sourceTurnId: "turn-source" },
  }));
  await worker.drain();
  const result = lookupStructural(store, {
    relation: "latest-decision",
    sessionId: "session-current",
    project: "/project",
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.results[0].snippet, excerpt);
  assert.equal(result.results[0].structural.sourceTurnId, "turn-source");
  assert.equal(result.results[0].structural.verbatim, true);
});

test("scope work is authorized before capping and missing lineage fails closed", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "eligible-old",
    project: "/project",
    text: "Where is eligible evidence?",
    createdAt: 1,
    structuralMessages: [
      { messageKey: "eligible-u", messageIndex: 0, role: "user", createdAt: 1, text: "Where is eligible evidence?", questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
    ],
  }));
  await admitDocument(store, request({
    id: "foreign-new",
    project: "/foreign",
    text: "Where is foreign evidence?",
    createdAt: 2,
    structuralMessages: [
      { messageKey: "foreign-u", messageIndex: 0, role: "user", createdAt: 2, text: "Where is foreign evidence?", questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
    ],
  }));
  await worker.drain();
  const scoped = lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
    scanLimit: 1,
  });
  assert.equal(scoped.results[0].id, "eligible-old");
  assert.throws(() => lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    scope: "session",
  }), /requires sessionId/u);
});

test("generation, supersession, and token boundaries constrain structural visibility", async (t) => {
  const { store, worker } = await fixture(t);
  for (const [index, [id, text]] of [["first", "Where is drain?"], ["second", "What brainstorm exists?"]].entries()) {
    await admitDocument(store, request({
      id,
      text,
      createdAt: index + 1,
      structuralMessages: [
        { messageKey: `${id}-u`, messageIndex: 0, role: "user", createdAt: index + 1, text, questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
      ],
    }));
  }
  await worker.drain();
  const published = store.scan(["meta", "published-index-generation"], { limit: 1 })[0].payload.generation;
  const existing = store.scan([
    "relation",
    "latest-question",
    "session",
    "/project",
    "session-current",
  ], { limit: 1 })[0].payload;
  await store.put([
    "relation",
    "latest-question",
    "session",
    "/project",
    "session-current",
    0,
    "unpublished",
    1,
    0,
  ], {
    ...existing,
    documentId: "unpublished",
    sourceKey: "unpublished-u",
    messageKey: "unpublished-u",
    text: "Where is unpublished evidence?",
    generation: published + 1,
    outboxSequence: 999,
  });
  assert.equal(lookupStructural(store, {
    relation: "latest-question",
    query: "unpublished",
    project: "/project",
    sessionId: "session-current",
  }).status, "not-found");
  assert.throws(() => lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
    generation: published + 1,
  }), /newer than published generation/u);
  assert.throws(() => lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
    scope: "sesion",
  }), /scope must be/u);
  assert.throws(() => lookupDecisionEvidence(store, {
    project: "/project",
    sessionId: "session-current",
    scope: "sesion",
  }), /scope must be/u);
  assert.deepEqual(lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
    generation: 1,
  }).results.map(({ id }) => id), ["first"]);
  assert.equal(lookupStructural(store, {
    relation: "latest-question",
    query: "rain",
    project: "/project",
    sessionId: "session-current",
  }).status, "not-found");
  await store.put(["supersession", "first", 1], { status: "superseded" });
  assert.equal(lookupStructural(store, {
    relation: "latest-question",
    query: "drain",
    project: "/project",
    sessionId: "session-current",
  }).status, "not-found");
});

test("modern answer-only turns do not masquerade as legacy questions", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "older-question",
    text: "What is retained?",
    createdAt: 1,
    structuralMessages: [
      { messageKey: "older-u", messageIndex: 0, role: "user", createdAt: 1, text: "What is retained?", questionScore: 100, requestScore: 10, correctionScore: 0, answerScore: 0 },
    ],
  }));
  await admitDocument(store, request({
    id: "newer-answer",
    text: "The exact source is retained.",
    createdAt: 2,
    structuralMessages: [
      { messageKey: "newer-a", messageIndex: 0, role: "assistant", createdAt: 2, text: "The exact source is retained.", questionScore: 0, requestScore: 0, correctionScore: 0, answerScore: 100 },
    ],
  }));
  await worker.drain();
  const result = lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.results.map(({ id }) => id), ["older-question"]);
});

test("decisions require a source turn and ancestor decisions remain ambiguous", async (t) => {
  const { store, worker } = await fixture(t);
  await admitDocument(store, request({
    id: "orphan-decision",
    kind: "decision-candidate",
    text: "Orphan evidence must not resolve.",
    createdAt: 1,
  }));
  await admitDocument(store, request({
    id: "parent-decision",
    sessionId: "session-parent",
    kind: "decision-candidate",
    text: "Use a source-linked daemon.",
    metadata: { sourceTurnId: "parent-turn" },
    createdAt: 2,
  }));
  await worker.drain();
  const result = lookupStructural(store, {
    relation: "latest-decision",
    project: "/project",
    sessionIds: ["session-current", "session-parent"],
  });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.results.map(({ id }) => id), ["parent-decision"]);
  assert.equal(result.results[0].structural.lineageDepth, 1);
});

test("unresolved structural messages scan source once and publish no coordinate-free postings", async (t) => {
  const { store } = await fixture(t);
  const present = "PRESENT_STRUCTURAL_MESSAGE";
  const text = `${present}\n${"x".repeat((1_024 * 1_024) - present.length - 1)}`;
  const structuralMessages = [
    {
      messageKey: "present-message",
      messageIndex: 0,
      role: "user",
      createdAt: 1,
      text: present,
      questionScore: 100,
      requestScore: 10,
      correctionScore: 0,
      answerScore: 0,
    },
    ...Array.from({ length: 99 }, (_, index) => ({
      messageKey: `absent-message-${index}`,
      messageIndex: index + 1,
      role: "user",
      createdAt: index + 2,
      text: `ABSENT_STRUCTURAL_MESSAGE_${index}`,
      questionScore: 100,
      requestScore: 10,
      correctionScore: 0,
      answerScore: 0,
    })),
  ];
  await admitDocument(store, request({
    id: "unresolved-structural",
    text,
    createdAt: 1,
    structuralMessages,
  }));

  const requestedRanges = [];
  const structural = createStructuralIndexHandler();
  const instrumented = Object.freeze({
    ...structural,
    async prepare(context) {
      return structural.prepare(Object.freeze({
        ...context,
        readSourceRange(startByte, endByte, options) {
          requestedRanges.push({ startByte, endByte });
          return context.readSourceRange(startByte, endByte, options);
        },
      }));
    },
  });
  const sourceSegmentBytes = 256 * 1_024;
  const worker = new IndexWorker(store, {
    workerId: "worker:unresolved-structural",
    sourceSegmentBytes,
    handlers: [instrumented],
  });
  const drained = await worker.drain({ throwOnError: true, maxDurationMs: 30_000 });

  assert.equal(drained.processed, 1);
  assert.equal(drained.publications[0].indexStatus, "skipped");
  assert.equal(drained.publications[0].skippedHandlers[0].limitKind, "unresolved structural messages");
  assert.equal(drained.publications[0].skippedHandlers[0].observed, 99);
  assert.equal(requestedRanges.length, Math.ceil(Buffer.byteLength(text, "utf8") / sourceSegmentBytes));
  assert.deepEqual(requestedRanges.map(({ startByte, endByte }) => endByte - startByte), [
    sourceSegmentBytes,
    sourceSegmentBytes,
    sourceSegmentBytes,
    sourceSegmentBytes,
  ]);
  assert.equal(store.scan([KEYSPACE.RELATION], { limit: 1 }).length, 0);
  assert.equal(store.scan(["index-preparation-status", "unresolved-structural", 1], { limit: 1 }).length, 1);
  assert.equal(lookupStructural(store, {
    relation: "latest-question",
    project: "/project",
    sessionId: "session-current",
  }).status, "not-found");

  const manifest = await store.get([KEYSPACE.DOCUMENT, "unresolved-structural", 1]);
  const recalled = await readDocumentRange(store, manifest, 0, manifest.byteLength);
  assert.equal(recalled.text, text);
});

test("structural posting fan-out is skipped before source reads or mutation construction", async (t) => {
  const { store } = await fixture(t);
  const structuralMessages = Array.from({ length: 626 }, (_, index) => ({
    messageKey: `fanout-message-${index}`,
    messageIndex: index,
    role: "user",
    createdAt: index + 1,
    text: `fanout${index}`,
    questionScore: 100,
    requestScore: 100,
    correctionScore: 100,
    answerScore: 100,
  }));
  await admitDocument(store, request({
    id: "structural-fanout",
    text: structuralMessages.map(({ text }) => text).join("\n"),
    createdAt: 1,
    structuralMessages,
  }));

  let sourceReads = 0;
  const structural = createStructuralIndexHandler();
  const instrumented = Object.freeze({
    ...structural,
    async prepare(context) {
      return structural.prepare(Object.freeze({
        ...context,
        readSourceRange(...args) {
          sourceReads += 1;
          return context.readSourceRange(...args);
        },
      }));
    },
  });
  const worker = new IndexWorker(store, {
    workerId: "worker:structural-fanout",
    handlers: [instrumented],
  });
  const drained = await worker.drain({ throwOnError: true, maxDurationMs: 30_000 });

  assert.equal(drained.processed, 1);
  assert.equal(drained.publications[0].indexStatus, "skipped");
  assert.equal(drained.publications[0].skippedHandlers[0].limitKind, "prepared structural mutations");
  assert.ok(drained.publications[0].skippedHandlers[0].limit <= 2_500);
  assert.ok(drained.publications[0].skippedHandlers[0].observed
    > drained.publications[0].skippedHandlers[0].limit);
  assert.equal(sourceReads, 0);
  assert.equal(store.scan([KEYSPACE.RELATION], { limit: 1 }).length, 0);
});

test("daemon structural and decision scans page and yield between bounded text batches", async () => {
  const text = `${"alpha ".repeat(10_000)}omega`;
  const structural = Array.from({ length: 130 }, (_, index) => ({
    keyBytes: Buffer.from(String(index).padStart(6, "0")),
    payload: {
      generation: 1,
      documentId: `structural-${index}`,
      documentVersion: 1,
      sessionId: "session",
      project: "/project",
      relation: "latest-question",
      relationConfidence: 100,
      outboxSequence: index,
      messageIndex: 0,
      legacy: false,
      textSharded: false,
      text,
    },
  }));
  const decisions = Array.from({ length: 130 }, (_, index) => ({
    keyBytes: Buffer.from(String(index).padStart(6, "0")),
    payload: {
      generation: 1,
      documentId: `decision-${index}`,
      documentVersion: 1,
      sessionId: "session",
      project: "/project",
      createdAt: index,
      outboxSequence: index,
      excerpt: text,
      verbatim: true,
    },
  }));
  const page = (records, options) => {
    const start = options.after === undefined
      ? 0
      : records.findIndex(({ keyBytes }) => Buffer.compare(keyBytes, options.after) > 0);
    if (start < 0) return [];
    return records.slice(start, start + options.limit);
  };
  const store = {
    scan(prefix, options = {}) {
      if (prefix[0] === KEYSPACE.META) return [{ payload: { generation: 1 } }];
      if (prefix[0] === KEYSPACE.SUPERSESSION) return [];
      if (prefix[0] === KEYSPACE.RELATION) return page(structural, options);
      if (prefix[0] === "decision") return page(decisions, options);
      return [];
    },
  };
  let yields = 0;
  const yieldControl = async () => {
    yields += 1;
    await new Promise((resolve) => setImmediate(resolve));
  };

  const structuralResult = await lookupStructuralAsync(store, {
    relation: "latest-question",
    query: "missing",
    scope: "all",
    scanLimit: structural.length,
  }, { yieldControl });
  assert.equal(structuralResult.status, "not-found");
  const structuralYields = yields;
  assert.ok(structuralYields >= 2, `structural scan yielded ${structuralYields} time(s)`);

  const decisionResult = await lookupStructuralAsync(store, {
    relation: "latest-decision",
    query: "missing",
    scope: "all",
    scanLimit: decisions.length,
  }, { yieldControl });
  assert.equal(decisionResult.status, "not-found");
  assert.ok(yields - structuralYields >= 2, `decision scan yielded ${yields - structuralYields} time(s)`);

  for (const relation of ["latest-question", "latest-decision"]) {
    let eventLoopTurnObserved = false;
    setImmediate(() => { eventLoopTurnObserved = true; });
    await lookupStructuralAsync(store, {
      relation,
      query: "missing",
      scope: "all",
      scanLimit: structural.length,
    });
    assert.equal(eventLoopTurnObserved, true, `${relation} did not yield to the event loop`);
  }
});

test("real RocksDB cooperative lookups preserve matches beyond two page boundaries", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-pages-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const recordCount = 130;
  const matchIndex = 128;
  await store.transaction(async (transaction) => {
    await transaction.put([KEYSPACE.META, "published-index-generation"], { generation: 1 }, {
      kind: "index-publication",
    });
    for (let index = 0; index < recordCount; index += 1) {
      const structuralPayload = {
        structuralIndexVersion: 1,
        relation: "latest-question",
        relationConfidence: 100,
        granularity: "message",
        legacy: false,
        project: "/project",
        sessionId: "session",
        documentId: `structural-${index}`,
        documentVersion: 1,
        documentKind: "turn",
        documentCreatedAt: index,
        messageKey: `message-${index}`,
        messageIndex: 0,
        role: "user",
        createdAt: index,
        text: index === matchIndex ? "boundaryneedle" : "other value",
        startByte: 0,
        endByte: index === matchIndex ? 14 : 11,
        generation: 1,
        outboxSequence: recordCount - index,
      };
      await transaction.put([
        KEYSPACE.RELATION,
        "latest-question",
        "session",
        "/project",
        "session",
        index,
        structuralPayload.documentId,
        1,
        0,
      ], structuralPayload, { kind: "structural-posting" });

      const decisionPayload = {
        decisionIndexVersion: 1,
        documentId: `decision-${index}`,
        documentVersion: 1,
        project: "/project",
        sessionId: "session",
        createdAt: index,
        generation: 1,
        outboxSequence: recordCount - index,
        sourceTurnId: `turn-${index}`,
        sourceMessageKeys: [`message-${index}`],
        excerpt: index === matchIndex ? "boundaryneedle" : "other value",
        verbatim: true,
      };
      await transaction.put([
        DECISION_KEYSPACE,
        "all",
        index,
        "/project",
        "session",
        decisionPayload.documentId,
        1,
        0,
      ], decisionPayload, { kind: "decision-evidence" });
      await transaction.put([
        DECISION_KEYSPACE,
        "session",
        "/project",
        "session",
        index,
        decisionPayload.documentId,
        1,
        0,
      ], decisionPayload, { kind: "decision-evidence" });
    }
  });

  const scanLimits = [];
  const observedStore = {
    scan(prefix, options) {
      if (prefix[0] === KEYSPACE.RELATION || prefix[0] === DECISION_KEYSPACE) {
        scanLimits.push(options.limit);
      }
      return store.scan(prefix, options);
    },
  };
  for (const relation of ["latest-question", "latest-decision"]) {
    const request = {
      relation,
      query: "boundaryneedle",
      scope: "all",
      limit: 1,
      scanLimit: recordCount,
    };
    const synchronous = lookupStructural(store, request);
    const cooperative = await lookupStructuralAsync(observedStore, request);
    assert.deepEqual(cooperative, synchronous);
    assert.equal(cooperative.results[0].id, `${relation === "latest-decision" ? "decision" : "structural"}-${matchIndex}`);

    const lineageRequest = {
      ...request,
      scope: "session",
      project: "/project",
      sessionIds: ["current", "session"],
    };
    const synchronousLineage = lookupStructural(store, lineageRequest);
    const cooperativeLineage = await lookupStructuralAsync(observedStore, lineageRequest);
    assert.deepEqual(cooperativeLineage, synchronousLineage);
    assert.equal(cooperativeLineage.results[0].structural.lineageDepth, 1);
  }
  assert.ok(scanLimits.length >= 6);
  assert.ok(scanLimits.every((limit) => limit <= 64), `observed scan limits: ${scanLimits.join(",")}`);
});
