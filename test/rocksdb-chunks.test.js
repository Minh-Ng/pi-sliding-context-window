import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContractError } from "../src/store-contract.js";
import {
  ChunkIntegrityError,
  contentHash,
  createChunkReferences,
  reconstructPhysicalChunks,
  splitPhysicalChunks,
  uniquePhysicalChunks,
} from "../src/rocksdb/chunks.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import {
  admitDocument,
  createToolResultManifest,
  createTurnManifest,
  deterministicManifestId,
  manifestKeys,
  prepareDocumentAdmission,
  readCanonicalDocument,
  reconstructDocumentText,
} from "../src/rocksdb/manifests.js";
import { ImmutableRecordConflictError, RocksStore } from "../src/rocksdb/store.js";
import {
  createSearchWindows,
  MAX_SEARCH_TOKENS_PER_DOCUMENT,
  sliceUtf8Bytes,
  tokenizeWithByteOffsets,
  windowForByteRange,
  windowsForByteRange,
} from "../src/rocksdb/windows.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function document(overrides = {}) {
  return {
    documentId: "doc-tool-1",
    version: 1,
    sourceKey: "toolResult:call-1",
    sessionId: "session-雪",
    project: "/workspace/example",
    kind: "tool-result",
    createdAt: 1_700_000_000_000,
    text: "REAP_DRAIN 🪨\n".repeat(12),
    metadata: {
      toolCallId: "call-1",
      parentTurnIds: ["turn-7"],
    },
    sourceMessageKeys: ["assistant:call-1", "toolResult:call-1"],
    sourceKeyStatus: "preserved",
    ...overrides,
  };
}

function putRequest(overrides = {}, requestOverrides = {}) {
  const request = {
    idempotencyKey: requestOverrides.idempotencyKey ?? "put:doc-tool-1:1",
    document: document(overrides),
    structuralMessages: requestOverrides.structuralMessages ?? [],
    retentionClass: requestOverrides.retentionClass ?? "conversation-source",
  };
  if (requestOverrides.expiresAt !== undefined) request.expiresAt = requestOverrides.expiresAt;
  if (requestOverrides.protect !== undefined) request.protect = requestOverrides.protect;
  return request;
}

function semanticPutRequest({
  documentId,
  version = 1,
  project = "/workspace/example",
  createdAt,
  text,
  subjectKey,
  supersedes,
}) {
  return putRequest({
    documentId,
    version,
    sourceKey: `source:${documentId}:${version}`,
    sourceMessageKeys: [`source:${documentId}:${version}`],
    sessionId: `session:${project}`,
    project,
    kind: "turn",
    createdAt,
    text,
    metadata: { turnId: `${documentId}:${version}` },
    ...(subjectKey === undefined ? {} : { subjectKey }),
    ...(supersedes === undefined ? {} : { supersedes }),
  }, { idempotencyKey: `put:${project}:${documentId}:${version}:${text}` });
}

function canonicalCounts(store) {
  return {
    documents: store.scan([KEYSPACE.DOCUMENT]).length,
    outbox: store.scan([KEYSPACE.OUTBOX]).length,
    supersessions: store.scan([KEYSPACE.SUPERSESSION]).length,
  };
}

test("physical chunks preserve every UTF-8 byte across scalar and line boundaries", () => {
  const text = "alpha🪨e\u0301\r\nbeta 雪\ngamma🙂delta\n".repeat(5);
  const chunks = splitPhysicalChunks(text, { maxChunkBytes: 19, minLineSplitBytes: 7 });
  assert.ok(chunks.length > 5);
  assert.equal(reconstructPhysicalChunks(chunks), text);
  assert.deepEqual(
    Buffer.concat(chunks.map(({ content }) => Buffer.from(content, "utf8"))),
    Buffer.from(text, "utf8"),
  );
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    assert.equal(chunk.ordinal, index);
    assert.equal(chunk.startByte, index === 0 ? 0 : chunks[index - 1].endByte);
    assert.equal(chunk.endByte - chunk.startByte, Buffer.byteLength(chunk.content, "utf8"));
    assert.equal(chunk.contentHash, contentHash(chunk.content));
    assert.equal(chunk.chunkId, `sha256:${chunk.contentHash}`);
  }

  assert.throws(
    () => splitPhysicalChunks("bad\ud800text", { maxChunkBytes: 8 }),
    /unpaired UTF-16 surrogates/u,
  );
  const corrupt = chunks.map((chunk) => ({ ...chunk }));
  corrupt[0].content = `x${corrupt[0].content}`;
  assert.throws(() => reconstructPhysicalChunks(corrupt), ChunkIntegrityError);
});

test("content addressing stores repeated physical payloads once without losing occurrences", () => {
  const text = "repeat\n".repeat(20);
  const chunks = splitPhysicalChunks(text, { maxChunkBytes: 7, minLineSplitBytes: 0 });
  const physical = uniquePhysicalChunks(chunks);
  const references = createChunkReferences(chunks);
  assert.equal(chunks.length, 20);
  assert.equal(physical.length, 1);
  assert.equal(references.length, 20);
  assert.equal(new Set(references.map(({ chunkId }) => chunkId)).size, 1);
  assert.equal(reconstructPhysicalChunks(chunks), text);

  const empty = splitPhysicalChunks("", { maxChunkBytes: 4 });
  assert.equal(empty.length, 1);
  assert.deepEqual(
    { startByte: empty[0].startByte, endByte: empty[0].endByte, content: empty[0].content },
    { startByte: 0, endByte: 0, content: "" },
  );
  assert.equal(reconstructPhysicalChunks(empty), "");
});

test("logical windows overlap by tokens and retain exact byte and chunk coordinates", () => {
  const text = "zero 🪨 one two three\nfour five six seven eight nine";
  const chunks = createChunkReferences(splitPhysicalChunks(text, {
    maxChunkBytes: 13,
    minLineSplitBytes: 0,
  }));
  const windows = createSearchWindows({
    text,
    documentId: "doc-window",
    documentVersion: 3,
    chunks,
    indexGeneration: 9,
  }, { windowTokens: 4, overlapTokens: 1 });
  assert.ok(windows.length > 2);
  assert.equal(windows[0].startByte, 0);
  assert.equal(windows.at(-1).endByte, Buffer.byteLength(text, "utf8"));
  assert.ok(windows[1].startByte < windows[0].endByte);
  assert.ok(windows.every((window) => window.chunkIds.length >= 1));
  assert.equal(windows.every((window) => window.indexGeneration === 9), true);

  const match = "three";
  const codeUnitStart = text.indexOf(match);
  const startByte = Buffer.byteLength(text.slice(0, codeUnitStart), "utf8");
  const endByte = startByte + Buffer.byteLength(match, "utf8");
  const containing = windowForByteRange(windows, startByte, endByte);
  assert.ok(containing.startByte <= startByte && containing.endByte >= endByte);
  assert.equal(sliceUtf8Bytes(text, startByte, endByte), match);
  assert.ok(windowsForByteRange(windows, startByte, endByte).length >= 1);
  assert.throws(() => sliceUtf8Bytes(text, 6, 7), /UTF-8 boundaries/u);

  const tokens = tokenizeWithByteOffsets(text);
  assert.equal(tokens.find(({ value }) => value === "🪨").endByte
    - tokens.find(({ value }) => value === "🪨").startByte, 4);
});

test("search token expansion is bounded per archival document", () => {
  const adversarial = "!".repeat(MAX_SEARCH_TOKENS_PER_DOCUMENT + 1);
  assert.throws(
    () => tokenizeWithByteOffsets(adversarial),
    (error) => error.code === "INVALID_REQUEST"
      && /split it into smaller archival documents/u.test(error.message),
  );
});

test("turn and tool manifests preserve ordered parent and source references", () => {
  const turn = createTurnManifest({
    sessionId: "s",
    project: "p",
    turnId: "t",
    sourceEventIds: ["e1", "e2", "e1"],
    createdAt: 10,
  });
  assert.deepEqual(turn.sourceEventIds, ["e1", "e2"]);
  const tool = createToolResultManifest({
    sessionId: "s",
    project: "p",
    toolCallId: "c",
    parentTurnIds: ["t", "t"],
    chunkIds: ["same", "same"],
    createdAt: 11,
  });
  assert.deepEqual(tool.parentTurnIds, ["t"]);
  assert.deepEqual(tool.chunkIds, ["same", "same"]);
  assert.ok(turn.manifestId.startsWith("turn:"));
  assert.ok(tool.manifestId.startsWith("tool-result:"));
});

test("admission prepares canonical manifests, physical chunks, windows, expiry, and outbox", () => {
  const request = putRequest({}, {
    expiresAt: 1_800_000_000_000,
    protect: true,
    structuralMessages: [{
      messageKey: "user:1",
      messageIndex: 0,
      role: "user",
      createdAt: 1,
      text: "How do we recall this?",
      questionScore: 90,
    }],
  });
  const prepared = prepareDocumentAdmission(request, {
    chunking: { maxChunkBytes: 20, minLineSplitBytes: 0 },
    windows: { windowTokens: 3, overlapTokens: 1 },
    indexGeneration: 4,
  });
  assert.equal(prepared.requestId, request.idempotencyKey);
  assert.equal(prepared.manifest.protectedAtAdmission, true);
  assert.equal(prepared.manifest.expiresAt, 1_800_000_000_000);
  assert.equal(prepared.manifest.structuralMessages.length, 1);
  assert.deepEqual(prepared.toolResultManifest.parentTurnIds, ["turn-7"]);
  assert.equal(prepared.toolResultManifest.chunkIds.length, prepared.chunks.length);
  assert.equal(prepared.records.filter(({ kind }) => kind === "physical-chunk").length,
    prepared.physicalChunks.length);
  assert.equal(prepared.records.filter(({ kind }) => kind === "expiry").length, 1);
  assert.ok(prepared.records.some(({ kind }) => kind === "document-manifest"));
  assert.ok(prepared.records.some(({ kind }) => kind === "tool-result-manifest"));
  assert.ok(prepared.records.some(({ kind }) => kind === "auxiliary-manifest-reference"));
  assert.deepEqual(prepared.manifest.auxiliaryManifestReference, {
    referenceVersion: 1,
    kind: "tool-result",
    manifestId: deterministicManifestId(
      "tool-result",
      request.document.project,
      request.document.sessionId,
      request.document.metadata.toolCallId,
    ),
    version: request.document.version,
  });
  assert.ok(prepared.records.some(({ kind }) => kind === "search-window"));
  assert.equal(prepared.outbox.payload.operation, "index");
  assert.equal(JSON.stringify(prepared.manifest).includes(request.document.text), false);
  assert.equal(JSON.stringify(prepared.sourceMessages).includes(request.document.text), false);
});

test("admission preserves ordered provenance and records documented absence without synthetic events", () => {
  const preserved = prepareDocumentAdmission(putRequest({
    kind: "turn",
    sourceKey: "message:primary",
    sourceKeyStatus: "preserved",
    sourceMessageKeys: ["message:b", "message:a", "message:b"],
  }));
  assert.deepEqual(preserved.manifest.sourceMessageKeys, ["message:b", "message:a", "message:b"]);
  assert.equal(preserved.manifest.sourceKeyStatus, "preserved");
  assert.deepEqual(preserved.sourceMessages.map(({ sourceKey }) => sourceKey), ["message:b", "message:a"]);
  assert.equal(preserved.records.filter(({ kind }) => kind === "source-message").length, 2);
  assert.deepEqual(
    preserved.turnManifest.sourceEventIds,
    preserved.sourceMessages.map(({ eventId }) => eventId),
  );

  const unavailable = prepareDocumentAdmission(putRequest({
    kind: "turn",
    sourceKey: "sqlite:internal:42",
    sourceKeyStatus: "unavailable",
    sourceMessageKeys: [],
  }));
  assert.equal(unavailable.manifest.sourceKeyStatus, "unavailable");
  assert.deepEqual(unavailable.manifest.sourceMessageKeys, []);
  assert.deepEqual(unavailable.sourceMessages, []);
  assert.equal(unavailable.turnManifest, undefined);
  assert.equal(unavailable.records.some(({ kind }) => kind === "source-message"), false);
  assert.equal(unavailable.records.some(({ kind }) => kind === "turn-manifest"), false);
  assert.throws(() => prepareDocumentAdmission(putRequest({
    sourceKeyStatus: "unavailable",
    sourceMessageKeys: ["synthetic:must-not-leak"],
  })), /cannot contain sourceMessageKeys/u);
});

test("RocksDB admission is atomic, idempotent, deduplicated, and exactly reconstructable", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "chunks-admission"));
  t.after(() => store.close());
  const text = "same-large-tool-payload 🪨\n".repeat(30);
  const firstRequest = putRequest({ text }, { idempotencyKey: "request:first" });
  const parameters = {
    chunking: { maxChunkBytes: Buffer.byteLength("same-large-tool-payload 🪨\n"), minLineSplitBytes: 0 },
    windows: { windowTokens: 8, overlapTokens: 2 },
  };

  const first = await admitDocument(store, firstRequest, parameters);
  const duplicate = await admitDocument(store, firstRequest, parameters);
  assert.equal(first.status, "stored");
  assert.equal(duplicate.status, "duplicate");
  const chunksAfterFirst = store.scan([KEYSPACE.CHUNK]);
  assert.equal(chunksAfterFirst.length, 1);
  assert.equal(chunksAfterFirst[0].payload.content, "same-large-tool-payload 🪨\n");

  const secondRequest = putRequest({
    documentId: "doc-tool-2",
    sourceKey: "toolResult:call-2",
    sourceMessageKeys: ["toolResult:call-2"],
    metadata: { toolCallId: "call-2", parentTurnIds: ["turn-8"] },
    text,
  }, { idempotencyKey: "request:second" });
  assert.equal((await admitDocument(store, secondRequest, parameters)).status, "stored");
  assert.equal(store.scan([KEYSPACE.CHUNK]).length, 1);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 2);

  const firstManifest = await store.get(manifestKeys.document("doc-tool-1", 1));
  assert.equal(Object.hasOwn(firstManifest, "text"), false);
  assert.equal(await reconstructDocumentText(store, firstManifest), text);
  assert.deepEqual(await readCanonicalDocument(store, "doc-tool-1", 1), firstRequest.document);
  assert.deepEqual(await readCanonicalDocument(store, "doc-tool-2", 1), secondRequest.document);

  const physicalKey = manifestKeys.chunk(firstManifest.chunks[0].chunkId);
  await store.remove(physicalKey);
  await assert.rejects(reconstructDocumentText(store, firstManifest), /is missing/u);
});

test("shared blob-backed chunks remain admissible after restart", async (t) => {
  const path = temporaryStorePath(t, "chunks-shared-blob-restart");
  let store = await RocksStore.open(path);
  t.after(() => store.close());
  const text = "shared blob payload 🪨\n".repeat(8_192);
  const parameters = {
    chunking: { maxChunkBytes: 256 * 1_024, minLineSplitBytes: 0 },
    windows: { windowTokens: 900, overlapTokens: 135 },
  };
  const first = putRequest({ text }, { idempotencyKey: "shared-blob:first" });
  await admitDocument(store, first, parameters);
  await store.flush();
  store.close();

  store = await RocksStore.open(path);
  const second = putRequest({
    documentId: "doc-tool-shared-after-restart",
    sourceKey: "toolResult:shared-after-restart",
    sourceMessageKeys: ["toolResult:shared-after-restart"],
    metadata: { toolCallId: "shared-after-restart", parentTurnIds: ["turn-after-restart"] },
    text,
  }, { idempotencyKey: "shared-blob:second" });
  assert.equal((await admitDocument(store, second, parameters)).status, "stored");
  assert.equal((await readCanonicalDocument(
    store,
    second.document.documentId,
    second.document.version,
  )).text, text);
  assert.equal(store.scan([KEYSPACE.CHUNK]).length, 1);
});

test("document versions are immutable and invalid admissions make no partial writes", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "chunks-conflict"));
  t.after(() => store.close());
  const request = putRequest({}, { idempotencyKey: "request:immutable" });
  await admitDocument(store, request, {
    chunking: { maxChunkBytes: 20, minLineSplitBytes: 0 },
    windows: { windowTokens: 4, overlapTokens: 1 },
  });
  assert.deepEqual(await store.get(manifestKeys.documentHistory("doc-tool-1")), {
    documentHistoryFormatVersion: 1,
    documentId: "doc-tool-1",
    project: request.document.project,
    highestAdmittedVersion: 1,
    retiredThrough: 0,
  });
  await assert.rejects(admitDocument(store, putRequest({
    text: "changed bytes",
  }, { idempotencyKey: "request:conflict" })), ImmutableRecordConflictError);
  assert.equal(await reconstructDocumentText(
    store,
    await store.get(manifestKeys.document("doc-tool-1", 1)),
  ), request.document.text);

  const count = store.scan([KEYSPACE.DOCUMENT]).length;
  const invalid = putRequest({}, { idempotencyKey: "request:invalid" });
  invalid.document.version = 0;
  assert.throws(() => prepareDocumentAdmission(invalid), ContractError);
  assert.equal(store.scan([KEYSPACE.DOCUMENT]).length, count);
});

test("pure admission preparation cannot bypass explicit supersession validation", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-pure-prepare"));
  t.after(() => store.close());
  const target = semanticPutRequest({
    documentId: "pure-prepare-target",
    createdAt: 100,
    text: "Original decision.",
    subjectKey: "decision:pure-prepare",
  });
  const replacement = semanticPutRequest({
    documentId: "pure-prepare-replacement",
    createdAt: 200,
    text: "Explicit correction.",
    subjectKey: "decision:pure-prepare",
    supersedes: { documentId: target.document.documentId, version: 1 },
  });
  await admitDocument(store, target);
  const before = canonicalCounts(store);

  await assert.rejects(async () => {
    const prepared = prepareDocumentAdmission(replacement);
    await store.commitCanonical(prepared);
  }, (error) => error instanceof TypeError
    && /requires store-aware validation; use admitDocument/u.test(error.message));

  assert.deepEqual(canonicalCounts(store), before);
  assert.equal(await store.get([KEYSPACE.SUPERSESSION, target.document.documentId, 1]), undefined);
  assert.equal(
    await store.get(manifestKeys.document(replacement.document.documentId, replacement.document.version)),
    undefined,
  );
  assert.equal((await admitDocument(store, replacement)).status, "stored");
});

test("explicit correction stores canonical provenance and hides its exact target atomically", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-supersession"));
  t.after(() => store.close());
  const target = semanticPutRequest({
    documentId: "tablet-decision-old",
    createdAt: 100,
    text: "Use one tablet for the archive.",
    subjectKey: "decision:tablet-layout",
  });
  const replacement = semanticPutRequest({
    documentId: "tablet-decision-new",
    createdAt: 200,
    text: "Correction: split the archive into project tablets.",
    subjectKey: "decision:tablet-layout",
    supersedes: { documentId: target.document.documentId, version: 1 },
  });
  await admitDocument(store, target);
  const stored = await admitDocument(store, replacement);
  assert.equal(stored.status, "stored");
  assert.deepEqual(
    await store.get([KEYSPACE.SUPERSESSION, target.document.documentId, 1]),
    {
      documentId: target.document.documentId,
      documentVersion: 1,
      status: "superseded",
      replacementDocumentId: replacement.document.documentId,
      replacementVersion: 1,
      project: replacement.document.project,
      subjectKey: replacement.document.subjectKey,
      supersessionType: "explicit",
      reason: `Explicitly replaced by immutable document ${replacement.document.documentId}@1.`,
      recordedAt: replacement.document.createdAt,
    },
  );
  assert.deepEqual(
    await readCanonicalDocument(store, replacement.document.documentId, 1),
    replacement.document,
  );
  assert.equal((await admitDocument(store, replacement)).status, "duplicate");
  assert.equal(store.scan([KEYSPACE.SUPERSESSION]).length, 1);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 2);
});

test("explicit supersession rejects invalid targets without partial canonical writes", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-invalid"));
  t.after(() => store.close());
  const subjectKey = "decision:invalid-targets";
  const target = semanticPutRequest({
    documentId: "valid-target",
    createdAt: 100,
    text: "Original decision.",
    subjectKey,
  });
  const future = semanticPutRequest({
    documentId: "future-target",
    createdAt: 500,
    text: "Future-dated decision.",
    subjectKey,
  });
  const foreign = semanticPutRequest({
    documentId: "foreign-target",
    project: "/workspace/foreign",
    createdAt: 100,
    text: "Foreign decision.",
    subjectKey,
  });
  await admitDocument(store, target);
  await admitDocument(store, future);
  await admitDocument(store, foreign);

  const failures = [
    {
      request: semanticPutRequest({
        documentId: "missing-replacement",
        createdAt: 200,
        text: "Missing target correction.",
        subjectKey,
        supersedes: { documentId: "does-not-exist", version: 1 },
      }),
      code: "NOT_FOUND",
    },
    {
      request: semanticPutRequest({
        documentId: "cross-project-replacement",
        createdAt: 200,
        text: "Cross-project correction.",
        subjectKey,
        supersedes: { documentId: foreign.document.documentId, version: 1 },
      }),
      code: "CONFLICT",
    },
    {
      request: semanticPutRequest({
        documentId: target.document.documentId,
        version: 2,
        createdAt: 200,
        text: "Explicit self correction.",
        subjectKey,
        supersedes: { documentId: target.document.documentId, version: 1 },
      }),
      code: "CONFLICT",
    },
    {
      request: semanticPutRequest({
        documentId: "forward-replacement",
        createdAt: 400,
        text: "Forward correction.",
        subjectKey,
        supersedes: { documentId: future.document.documentId, version: 1 },
      }),
      code: "CONFLICT",
    },
    {
      request: semanticPutRequest({
        documentId: "subject-drift-replacement",
        createdAt: 200,
        text: "Subject drift correction.",
        subjectKey: "decision:different-subject",
        supersedes: { documentId: target.document.documentId, version: 1 },
      }),
      code: "CONFLICT",
    },
  ];
  for (const { request, code } of failures) {
    const before = canonicalCounts(store);
    await assert.rejects(admitDocument(store, request), (error) => error.code === code);
    assert.deepEqual(canonicalCounts(store), before);
    assert.equal(
      await store.get(manifestKeys.document(request.document.documentId, request.document.version)),
      undefined,
    );
  }
  assert.equal(await store.get([KEYSPACE.SUPERSESSION, target.document.documentId, 1]), undefined);
});

test("caller admission options cannot inject unvalidated semantic supersession state", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-option-injection"));
  t.after(() => store.close());
  const foreign = semanticPutRequest({
    documentId: "injection-foreign-target",
    project: "/workspace/foreign",
    createdAt: 100,
    text: "Foreign decision.",
    subjectKey: "decision:injection",
  });
  await admitDocument(store, foreign);
  const foreignManifest = await store.get(manifestKeys.document(foreign.document.documentId, 1));
  const attempts = [
    {
      target: { documentId: "injection-missing-target", version: 1 },
      request: semanticPutRequest({
        documentId: "injection-missing-replacement",
        createdAt: 200,
        text: "Ordinary document must not replace a missing target.",
      }),
    },
    {
      target: { documentId: foreign.document.documentId, version: 1 },
      targetManifest: foreignManifest,
      request: semanticPutRequest({
        documentId: "injection-foreign-replacement",
        createdAt: 200,
        text: "Ordinary document must not replace a foreign target.",
      }),
    },
  ];

  for (const { target, targetManifest, request } of attempts) {
    const before = canonicalCounts(store);
    const semanticSupersession = {
      documentId: target.documentId,
      documentVersion: target.version,
      status: "superseded",
      replacementDocumentId: request.document.documentId,
      replacementVersion: request.document.version,
      project: request.document.project,
      supersessionType: "explicit",
      reason: "Caller-forged marker.",
      recordedAt: request.document.createdAt,
    };
    await assert.rejects(
      admitDocument(store, request, {
        semanticSupersession,
        ...(targetManifest === undefined ? {} : { semanticTargetManifest: targetManifest }),
      }),
      (error) => error instanceof TypeError && /reserved for validated internal use/u.test(error.message),
    );
    assert.deepEqual(canonicalCounts(store), before);
    assert.equal(await store.get([KEYSPACE.SUPERSESSION, target.documentId, target.version]), undefined);
    assert.equal(
      await store.get(manifestKeys.document(request.document.documentId, request.document.version)),
      undefined,
    );
  }
});

test("explicit supersession rejects cycles atomically while ordinary versioning remains unchanged", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-cycle"));
  t.after(() => store.close());
  const subjectKey = "decision:cycle";
  const a1 = semanticPutRequest({
    documentId: "cycle-a",
    createdAt: 100,
    text: "Decision A version one.",
    subjectKey,
  });
  const b1 = semanticPutRequest({
    documentId: "cycle-b",
    createdAt: 110,
    text: "Decision B version one.",
    subjectKey,
  });
  await admitDocument(store, a1);
  await admitDocument(store, b1);
  const b2 = semanticPutRequest({
    documentId: "cycle-b",
    version: 2,
    createdAt: 200,
    text: "Decision B supersedes A.",
    subjectKey,
    supersedes: { documentId: "cycle-a", version: 1 },
  });
  await admitDocument(store, b2);
  const before = canonicalCounts(store);
  const a2 = semanticPutRequest({
    documentId: "cycle-a",
    version: 2,
    createdAt: 300,
    text: "Decision A attempts to supersede B.",
    subjectKey,
    supersedes: { documentId: "cycle-b", version: 2 },
  });
  await assert.rejects(
    admitDocument(store, a2),
    (error) => error.code === "CONFLICT" && /cycle/u.test(error.message),
  );
  assert.deepEqual(canonicalCounts(store), before);
  assert.equal(await store.get(manifestKeys.document("cycle-a", 2)), undefined);

  const ordinaryV1 = semanticPutRequest({
    documentId: "ordinary-versioned",
    createdAt: 400,
    text: "Lexically close tablet decision.",
  });
  const ordinaryV2 = semanticPutRequest({
    documentId: "ordinary-versioned",
    version: 2,
    createdAt: 500,
    text: "Lexically close tablet decision updated.",
  });
  const unrelated = semanticPutRequest({
    documentId: "ordinary-neighbor",
    createdAt: 450,
    text: "Lexically close tablet decision.",
  });
  await admitDocument(store, ordinaryV1);
  await admitDocument(store, unrelated);
  await admitDocument(store, ordinaryV2);
  assert.equal(await store.get([KEYSPACE.SUPERSESSION, "ordinary-neighbor", 1]), undefined);
  const ordinaryMarker = await store.get([KEYSPACE.SUPERSESSION, "ordinary-versioned", 1]);
  assert.equal(ordinaryMarker.replacementVersion, 2);
  assert.equal(Object.hasOwn(ordinaryMarker, "replacementDocumentId"), false);
});

test("concurrent explicit replacements produce one atomic winner", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "semantic-race"));
  t.after(() => store.close());
  const target = semanticPutRequest({
    documentId: "race-target",
    createdAt: 100,
    text: "Race target.",
    subjectKey: "decision:race",
  });
  await admitDocument(store, target);
  const replacements = ["race-left", "race-right"].map((documentId, index) => semanticPutRequest({
    documentId,
    createdAt: 200 + index,
    text: `Replacement ${documentId}.`,
    subjectKey: "decision:race",
    supersedes: { documentId: target.document.documentId, version: 1 },
  }));
  const before = canonicalCounts(store);
  const settled = await Promise.allSettled(replacements.map((request) => admitDocument(store, request)));
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  const after = canonicalCounts(store);
  assert.equal(after.documents, before.documents + 1);
  assert.equal(after.outbox, before.outbox + 1);
  assert.equal(after.supersessions, before.supersessions + 1);
  const marker = await store.get([KEYSPACE.SUPERSESSION, target.document.documentId, 1]);
  const winner = replacements.find(({ document }) => document.documentId === marker.replacementDocumentId);
  assert.ok(winner);
  const loser = replacements.find(({ document }) => document.documentId !== marker.replacementDocumentId);
  assert.equal(await store.get(manifestKeys.document(loser.document.documentId, 1)), undefined);
});
