import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
  ARCHIVE_CHECKPOINT_PART_MAX_BYTES,
  ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES,
  ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
  createArchiveCheckpoint,
  inspectCheckpointManifest,
  reconstructCheckpointSource,
} from "../src/archive/archive-checkpoint.js";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  estimateModelVisibleTokens,
  modelVisiblePrefix,
} from "../src/session/model-token-budget.js";
import { contentHash } from "../src/rocksdb/chunks.js";
import { MAX_DOCUMENT_TEXT_BYTES } from "../src/store/store-contract.js";

class MemoryArchive {
  constructor(state = {}, { failAt, returnFalsyAt } = {}) {
    this.state = state;
    this.state.documents ??= new Map();
    this.state.putCalls ??= 0;
    this.state.writeOrder ??= [];
    this.failAt = failAt;
    this.returnFalsyAt = returnFalsyAt;
  }

  get(id) {
    const document = this.state.documents.get(id);
    return document === undefined ? undefined : structuredClone(document);
  }

  put(document) {
    this.state.putCalls += 1;
    if (this.state.putCalls === this.failAt) throw new Error("injected archive failure");
    if (this.state.putCalls === this.returnFalsyAt) return undefined;
    if (this.state.documents.has(document.id)) {
      throw new Error(`duplicate logical document ${document.id}`);
    }
    const stored = structuredClone(document);
    this.state.documents.set(document.id, stored);
    this.state.writeOrder.push({ id: document.id, kind: document.kind });
    return document.id;
  }
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(processId) {
  if (!processId || !processExists(processId)) return;
  process.kill(processId, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) process.kill(processId, "SIGKILL");
}

function checkpointOptions(archive, sources, overrides = {}) {
  return {
    archive,
    sessionId: "session-1",
    project: "/project",
    createdAt: 1_700_000_000_000,
    sources,
    ...overrides,
  };
}

function legacyHashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function seedLegacyDefaultCheckpoint(state, {
  text,
  project = "/project",
  sessionId = "session-1",
  sourceKey,
  kind,
}) {
  const hash = contentHash(text);
  const sourceIdentity = legacyHashParts([
    "archive-checkpoint-source-v1",
    project,
    sessionId,
    sourceKey,
    kind,
    hash,
  ]);
  const publicationId = `checkpoint-publication:${legacyHashParts([
    "archive-checkpoint-publication-v1",
    sourceIdentity,
  ])}`;
  const rootId = `checkpoint-root:${legacyHashParts([
    "archive-checkpoint-root-v1",
    sourceIdentity,
    publicationId,
  ])}`;
  const partHash = contentHash(text);
  const partId = `checkpoint-part:${legacyHashParts([
    "archive-checkpoint-part-v1",
    project,
    sessionId,
    rootId,
    partHash,
  ])}`;
  const byteCount = Buffer.byteLength(text, "utf8");
  const root = {
    checkpointFormatVersion: 1,
    recordType: "root",
    rootId,
    publicationId,
    sourceIdentity,
    sessionId,
    project,
    sourceKey,
    sourceKind: kind,
    encoding: "utf8",
    byteCount,
    hash,
    parts: [{
      id: partId,
      ordinal: 0,
      startByte: 0,
      endByte: byteCount,
      byteCount,
      hash: partHash,
    }],
  };
  state.documents.set(partId, {
    id: partId,
    text: `[context-window exact checkpoint part v1]\n${text}`,
  });
  state.documents.set(rootId, { id: rootId, text: JSON.stringify(root) });
  state.documents.set(publicationId, {
    id: publicationId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "publication",
      publicationId,
      sourceIdentities: [sourceIdentity],
      rootIds: [rootId],
    }),
  });
  return { publicationId, rootId };
}

test("multibyte sources split at UTF-8 boundaries and reconstruct exactly after restart", () => {
  const source = `${"a".repeat(ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES - 2)}🙂尾\n${"z".repeat(128)}`;
  const state = {};
  const firstProcess = new MemoryArchive(state);
  const result = createArchiveCheckpoint(checkpointOptions(firstProcess, [{
    text: source,
    sourceKey: "user:oversized:1",
    sourceMessageKeys: ["user:oversized:1", "assistant:oversized:2"],
    kind: "oversized-user",
    topic: "oversized UTF-8 boundary",
  }]));

  assert.equal(result.status, "stored");
  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0].hash, contentHash(source));
  assert.equal(result.roots[0].byteCount, Buffer.byteLength(source, "utf8"));
  assert.ok(result.roots[0].partCount >= 2);
  assert.equal(result.roots[0].publicationId, result.publicationId);
  assert.deepEqual(
    reconstructCheckpointSource(firstProcess, result.roots[0].rootId).root.sourceMessageKeys,
    ["user:oversized:1", "assistant:oversized:2"],
  );
  for (const document of state.documents.values()) {
    assert.deepEqual(
      document.metadata.sourceMessageKeys,
      ["user:oversized:1", "assistant:oversized:2"],
    );
  }
  assert.equal(state.writeOrder.at(-1).kind, "archive-checkpoint-publication");
  const firstRootWrite = state.writeOrder.findIndex(({ kind }) => kind === "archive-checkpoint-root");
  const lastPartWrite = state.writeOrder.findLastIndex(({ kind }) => kind === "archive-checkpoint-part");
  assert.ok(firstRootWrite > lastPartWrite);
  for (const document of state.documents.values()) {
    assert.ok(Buffer.byteLength(document.text, "utf8") <= MAX_DOCUMENT_TEXT_BYTES);
    if (document.kind === "archive-checkpoint-part") {
      assert.ok(Buffer.byteLength(document.text, "utf8") <= ARCHIVE_CHECKPOINT_PART_MAX_BYTES);
    }
  }

  const restartedProcess = new MemoryArchive(state);
  const recalled = reconstructCheckpointSource(restartedProcess, result.roots[0].rootId);
  assert.equal(recalled.text, source);
  assert.equal(Buffer.compare(Buffer.from(recalled.text), Buffer.from(source)), 0);
  assert.equal(recalled.root.hash, contentHash(source));
});

test("a real RocksDB daemon restart preserves exact checkpoint reconstruction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-checkpoint-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = `${directory}/project`;
  const createdAt = Date.now();
  const source = `real RocksDB restart\n${"é🙂".repeat(30_000)}\nexact tail`;
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      storePath,
      socketPath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    const first = createArchiveCheckpoint({
      archive,
      sessionId: "restart-session",
      project,
      createdAt: createdAt + 1,
      sources: [{
        text: source,
        sourceKey: "user:restart-source",
        sourceMessageKeys: ["user:restart-source", "assistant:restart-source"],
        kind: "oversized-user",
      }],
    });
    assert.equal(first.status, "stored");
    archive.close();
    archive = undefined;
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });

    archive = new DaemonArchive({
      storePath,
      socketPath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    const reconstructed = reconstructCheckpointSource(archive, first.roots[0].rootId);
    assert.equal(reconstructed.text, source);
    assert.deepEqual(
      reconstructed.root.sourceMessageKeys,
      ["user:restart-source", "assistant:restart-source"],
    );
    const retry = createArchiveCheckpoint({
      archive,
      sessionId: "restart-session",
      project,
      createdAt,
      sources: [{
        text: source,
        sourceKey: "user:restart-source",
        sourceMessageKeys: ["user:restart-source", "assistant:restart-source"],
        kind: "oversized-user",
      }],
    });
    assert.equal(retry.status, "stored");
    assert.deepEqual(retry.roots, first.roots);
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retry uses the same content addresses across timestamps without another logical write", () => {
  const state = {};
  const source = `same checkpoint ${"é".repeat(1_000)}`;
  const first = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(state), [{
    text: source,
    sourceKey: "message-key-1",
    kind: "oversized-user",
  }]));
  const writesAfterFirstAttempt = state.putCalls;
  const documentCount = state.documents.size;

  const retry = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(state), [{
    text: source,
    sourceKey: "message-key-1",
    kind: "oversized-user",
  }], { createdAt: 1_700_000_000_001 }));

  assert.equal(first.status, "stored");
  assert.equal(retry.status, "stored");
  assert.deepEqual(retry.roots, first.roots);
  assert.equal(state.putCalls, writesAfterFirstAttempt);
  assert.equal(state.documents.size, documentCount);
});

test("retry reuses a complete legacy default checkpoint without new logical documents", () => {
  const state = {};
  const archive = new MemoryArchive(state);
  const source = {
    text: "legacy-compatible exact source",
    sourceKey: "legacy-source-key",
    kind: "turn",
  };
  const legacy = seedLegacyDefaultCheckpoint(state, source);
  const documentCount = state.documents.size;
  assert.equal(reconstructCheckpointSource(archive, legacy.rootId).text, source.text);

  const retry = createArchiveCheckpoint(checkpointOptions(archive, [source]));

  assert.equal(retry.status, "stored");
  assert.equal(retry.publicationId, legacy.publicationId);
  assert.equal(retry.roots[0].rootId, legacy.rootId);
  assert.equal(state.putCalls, 0);
  assert.equal(state.documents.size, documentCount);
});

test("preview and catalog stay bounded and do not reveal raw middle content", () => {
  const sentinel = "MIDDLE_SENTINEL_coldNeighborTerm_47f3";
  const source = `Discuss primaryTabletKey and tablet routing.\n${"h".repeat(30_000)}${sentinel}${"t".repeat(30_000)}\nTail evidence.`;
  const result = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(), [{
    text: source,
    sourceKey: "message-key-preview",
    kind: "oversized-user",
    topic: sentinel,
  }], { previewTokens: ARCHIVE_CHECKPOINT_PREVIEW_TOKENS * 3 }));

  assert.equal(result.status, "stored");
  assert.ok(estimateModelVisibleTokens(result.preview) <= ARCHIVE_CHECKPOINT_PREVIEW_TOKENS);
  assert.ok(estimateModelVisibleTokens(result.catalog) <= ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS);
  assert.equal(result.preview.includes(sentinel), false);
  assert.equal(result.catalog.includes(sentinel), false);
  assert.equal(result.catalog.includes("coldNeighborTerm"), false);
  assert.match(result.catalog, new RegExp(result.roots[0].rootId, "u"));
  assert.match(result.catalog, new RegExp(result.roots[0].hash, "u"));
  assert.match(result.catalog, new RegExp(`bytes=${result.roots[0].byteCount}`, "u"));
  assert.match(result.catalog, /topic=/u);
  assert.match(result.catalog, /terms=/u);
});

test("catalog metadata follows the caller's effective smaller preview ranges", () => {
  const sentinel = "oldExcerptSentinelKey";
  const source = `Visible primaryTabletKey topic.\n${"plain ".repeat(70)}${sentinel} ${"plain ".repeat(3_000)}Tail evidence.`;
  // The former fixed 400-token planning excerpt allocated 280 tokens to its
  // head, so this placement proves the regression would have exposed it.
  assert.equal(modelVisiblePrefix(source, 280).includes(sentinel), true);

  const result = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(), [{
    text: source,
    sourceKey: "message-key-small-preview",
    kind: "oversized-user",
    topic: sentinel,
    terms: [sentinel],
  }], { previewTokens: 300 }));

  assert.equal(result.status, "stored");
  assert.ok(estimateModelVisibleTokens(result.preview) <= 300);
  assert.equal(result.preview.includes(sentinel), false);
  assert.equal(result.catalog.includes(sentinel), false);
  assert.equal(result.roots[0].topic.includes(sentinel), false);
  assert.equal(result.roots[0].terms.includes(sentinel), false);
});

test("publication metadata references bounded roots without duplicating their provenance", () => {
  const state = {};
  const sources = Array.from({ length: 3 }, (_, sourceIndex) => {
    const sourceMessageKeys = Array.from({ length: 85 }, (_, keyIndex) =>
      `key-${sourceIndex}-${keyIndex}-${"\\".repeat(4_070)}`);
    return {
      text: `source ${sourceIndex}`,
      sourceKey: sourceMessageKeys[0],
      sourceMessageKeys,
      kind: "turn",
    };
  });

  const result = createArchiveCheckpoint(checkpointOptions(
    new MemoryArchive(state),
    sources,
  ));

  assert.equal(result.status, "stored");
  assert.deepEqual(
    state.documents.get(result.publicationId).metadata.sourceMessageKeys,
    sources.map((source) => source.sourceKey),
  );
  assert.deepEqual(
    result.roots.map((root) =>
      JSON.parse(state.documents.get(root.rootId).text).sourceMessageKeys.length),
    [85, 85, 85],
  );
});

test("root identity fields cannot be deleted without invalidating reconstruction", () => {
  const state = {};
  const archive = new MemoryArchive(state);
  const result = createArchiveCheckpoint(checkpointOptions(archive, [{
    text: "identity-bound exact source",
    sourceKey: "undefined",
    kind: "turn",
  }]));
  assert.equal(result.status, "stored");

  const rootId = result.roots[0].rootId;
  const rootDocument = state.documents.get(rootId);
  const root = JSON.parse(rootDocument.text);
  delete root.sourceKey;
  rootDocument.text = JSON.stringify(root);

  assert.throws(
    () => reconstructCheckpointSource(archive, rootId),
    /source identity is malformed/u,
  );
});

test("layout commitment rejects internally consistent root arithmetic tampering", () => {
  const state = {};
  const archive = new MemoryArchive(state);
  const result = createArchiveCheckpoint(checkpointOptions(archive, [{
    text: "exact",
    sourceKey: "layout-bound-source",
    kind: "turn",
  }]));
  assert.equal(result.status, "stored");

  const rootId = result.roots[0].rootId;
  const rootDocument = state.documents.get(rootId);
  const root = JSON.parse(rootDocument.text);
  root.parts[0].endByte += 10;
  root.parts[0].byteCount += 10;
  root.byteCount += 10;
  rootDocument.text = JSON.stringify(root);

  assert.throws(
    () => inspectCheckpointManifest(archive, rootId),
    /part layout identity is invalid/u,
  );
  assert.throws(
    () => reconstructCheckpointSource(archive, rootId),
    /part layout identity is invalid/u,
  );
});

test("publication content address commits the ordered source layouts", () => {
  const state = {};
  const archive = new MemoryArchive(state);
  const result = createArchiveCheckpoint(checkpointOptions(archive, [{
    text: "publication-bound exact source",
    sourceKey: "publication-layout-source",
    kind: "turn",
  }]));
  assert.equal(result.status, "stored");

  const publicationDocument = state.documents.get(result.publicationId);
  const publication = JSON.parse(publicationDocument.text);
  publication.layoutIdentities[0] = "0".repeat(64);
  publicationDocument.text = JSON.stringify(publication);

  assert.throws(
    () => inspectCheckpointManifest(archive, result.roots[0].rootId),
    /publication content address is invalid/u,
  );
  assert.throws(
    () => reconstructCheckpointSource(archive, result.roots[0].rootId),
    /publication content address is invalid/u,
  );
});

for (const failure of [
  { name: "throwing part", options: { failAt: 2 }, sourceParts: 3 },
  { name: "falsy part", options: { returnFalsyAt: 2 }, sourceParts: 3 },
  { name: "throwing root", options: { failAt: 2 }, sourceParts: 1 },
  { name: "falsy root", options: { returnFalsyAt: 2 }, sourceParts: 1 },
]) {
  test(`${failure.name} write publishes no root or bounded success material`, () => {
    const state = {};
    const archive = new MemoryArchive(state, failure.options);
    const source = failure.sourceParts === 1
      ? "small root-failure source"
      : "x".repeat(ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES * 2 + 32);
    const result = createArchiveCheckpoint(checkpointOptions(archive, [{
      text: source,
      sourceKey: `failure-${failure.name}`,
      kind: "compaction-source",
    }]));

    assert.deepEqual(result, {
      status: "failed",
      code: "archive-checkpoint-failed",
      message: "Exact archive checkpoint could not be confirmed.",
    });
    assert.equal("roots" in result, false);
    assert.equal("preview" in result, false);
    assert.equal("catalog" in result, false);
    assert.equal(
      [...state.documents.values()].some((document) => document.kind === "archive-checkpoint-root"),
      false,
    );
  });
}

test("bounded catalog and preview failures occur before the first archive write", () => {
  for (const overrides of [{ catalogTokens: 1 }, { previewTokens: 1 }]) {
    const state = {};
    const result = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(state), [{
      text: "preflight bounded output",
      sourceKey: "bounded-preflight",
      kind: "compaction-source",
    }], overrides));
    assert.equal(result.status, "failed");
    assert.equal(state.putCalls, 0);
    assert.equal(state.documents.size, 0);
  }
});

test("a later source part failure occurs before any root write", () => {
  const state = {};
  const result = createArchiveCheckpoint(checkpointOptions(
    new MemoryArchive(state, { failAt: 2 }),
    [
      { text: "first source", sourceKey: "multi:first", kind: "compaction-source" },
      { text: "second source", sourceKey: "multi:second", kind: "compaction-source" },
    ],
  ));
  assert.equal(result.status, "failed");
  assert.equal(
    [...state.documents.values()].some((document) => document.kind === "archive-checkpoint-root"),
    false,
  );
});

for (const failure of [
  { name: "later root", options: { failAt: 4 } },
  { name: "throwing publication", options: { failAt: 5 } },
  { name: "falsy publication", options: { returnFalsyAt: 5 } },
]) {
  test(`${failure.name} failure leaves staged roots unusable`, () => {
    const state = {};
    const archive = new MemoryArchive(state, failure.options);
    const result = createArchiveCheckpoint(checkpointOptions(archive, [
      { text: "first source", sourceKey: `${failure.name}:first`, kind: "compaction-source" },
      { text: "second source", sourceKey: `${failure.name}:second`, kind: "compaction-source" },
    ]));
    assert.equal(result.status, "failed");
    assert.equal(
      [...state.documents.values()].some((document) =>
        document.kind === "archive-checkpoint-publication"),
      false,
    );
    const stagedRoots = [...state.documents.values()]
      .filter((document) => document.kind === "archive-checkpoint-root");
    assert.ok(stagedRoots.length > 0);
    for (const root of stagedRoots) {
      assert.throws(
        () => reconstructCheckpointSource(new MemoryArchive(state), root.id),
        /publication is missing/u,
      );
    }
  });
}

test("an uncovered previous summary is a separate exact source", () => {
  const previousSummary = "Earlier compacted reasoning with summaryOnlyKey.";
  const state = {};
  const result = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(state), [{
    text: "Current messages to summarize.",
    sourceKey: "compaction-span-1",
    kind: "compaction-source",
  }], { previousSummary }));

  assert.equal(result.status, "stored");
  assert.equal(result.roots.length, 2);
  assert.ok(result.roots.every((root) => result.catalog.includes(root.rootId)));
  assert.ok(result.roots.every((root) => root.publicationId === result.publicationId));
  const summaryRoot = result.roots.find((root) => root.kind === "archive-previous-summary");
  assert.ok(summaryRoot);
  assert.equal(reconstructCheckpointSource(new MemoryArchive(state), summaryRoot.rootId).text, previousSummary);

  const covered = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(), [{
    text: "Current messages to summarize.",
    sourceKey: "compaction-span-1",
    kind: "compaction-source",
  }], {
    previousSummary,
    previousSummaryCoveredByTrustedCatalog: true,
  }));
  assert.equal(covered.status, "stored");
  assert.equal(covered.roots.length, 1);
  assert.equal(covered.roots.some((root) => root.kind === "archive-previous-summary"), false);
});

test("malformed UTF-16 fails before any archive write", () => {
  const state = {};
  const result = createArchiveCheckpoint(checkpointOptions(new MemoryArchive(state), [{
    text: "unpaired \ud800 surrogate",
    sourceKey: "invalid-source",
  }]));
  assert.equal(result.status, "failed");
  assert.equal(state.putCalls, 0);
  assert.equal(state.documents.size, 0);
});
