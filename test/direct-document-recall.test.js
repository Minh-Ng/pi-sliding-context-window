import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Archive } from "../src/archive/archive.js";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { DaemonOperations } from "../src/daemon/operations.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { canonicalDocumentIdentityHash } from "../src/identity/document-identity.js";
import {
  createChunkReferences,
  splitPhysicalChunks,
} from "../src/rocksdb/chunks.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { createDocumentManifest } from "../src/rocksdb/manifests.js";
import { readDocumentRange } from "../src/rocksdb/document-range.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { startMigration } from "../src/migration/index.js";
import { StoreClient } from "../src/store/store-client.js";
import {
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
  assertStoreRequest,
  assertStoreResult,
} from "../src/store/store-contract.js";

function canonicalDocument(text, overrides = {}) {
  return {
    documentId: "large-single-token",
    version: 1,
    sourceKey: "tool:1",
    sourceKeyStatus: "preserved",
    sourceMessageKeys: ["tool:1"],
    sessionId: "session-large",
    project: "/project/direct-bounds",
    kind: "tool-result",
    createdAt: 1,
    text,
    metadata: { sourceMessageKey: "tool:1", toolName: "fixture" },
    ...overrides,
  };
}

function manifestFor(document) {
  const chunks = splitPhysicalChunks(document.text);
  return createDocumentManifest(document, {
    chunks: createChunkReferences(chunks),
    retentionClass: "ephemeral-payload",
  });
}

function fixture(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const storePath = join(directory, "archive.rocks");
  return {
    directory,
    storePath,
    socketPath: defaultSocketPath(storePath),
  };
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
  if (processExists(processId)) {
    process.kill(processId, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("identity reads compare a full document with a migration-compatible manifest", () => {
  const document = canonicalDocument("migration-compatible source");
  const manifest = manifestFor(document);
  assert.equal(canonicalDocumentIdentityHash(manifest), canonicalDocumentIdentityHash(document));
  assert.notEqual(
    canonicalDocumentIdentityHash(manifest),
    canonicalDocumentIdentityHash({ ...document, text: `${document.text}!` }),
  );
  assert.notEqual(
    canonicalDocumentIdentityHash(manifest),
    canonicalDocumentIdentityHash({ ...document, metadata: { changed: true } }),
  );
});

test("direct-read contracts distinguish identity and bounded chunk-table results", () => {
  const document = canonicalDocument("contract source");
  const manifest = manifestFor(document);
  const identityRequest = { documentId: document.documentId, view: "identity" };
  assert.equal(assertStoreRequest("store.get", identityRequest), identityRequest);

  const identity = {
    status: "resolved",
    materialization: "identity",
    document: {
      documentId: document.documentId,
      version: 1,
      contentHash: manifest.contentHash,
      identityHash: canonicalDocumentIdentityHash(manifest),
      byteLength: manifest.byteLength,
    },
  };
  assert.equal(assertStoreResult("store.get", identity), identity);

  const table = {
    status: "resolved",
    materialization: "chunk-table",
    document: {
      documentId: document.documentId,
      version: 1,
      sourceKey: document.sourceKey,
      sourceKeyStatus: "preserved",
      sessionId: document.sessionId,
      project: document.project,
      kind: document.kind,
      createdAt: document.createdAt,
      contentHash: manifest.contentHash,
      byteLength: manifest.byteLength,
      sourceMessageKeys: ["tool:1"],
      sourceMessageKeyCount: 1,
      sourceMessageKeysTruncated: false,
      chunkCount: 1,
      chunkTable: [manifest.chunks[0]],
      chunkTableTruncated: false,
    },
  };
  assert.equal(assertStoreResult("store.get", table), table);
});

test("oversized direct reads never fetch or reconstruct physical chunks", async () => {
  const source = "X".repeat(MAX_DIRECT_DOCUMENT_SOURCE_BYTES + 1);
  const manifest = manifestFor(canonicalDocument(source));
  let chunkReads = 0;
  const read = async (key) => {
    if (key[0] === KEYSPACE.CHUNK) {
      chunkReads += 1;
      throw new Error("oversized direct read attempted physical chunk materialization");
    }
    if (key[0] === KEYSPACE.DOCUMENT) return manifest;
    return undefined;
  };
  const view = {
    get: read,
    scan: () => [],
  };
  const store = {
    get: read,
    scan(prefix) {
      return prefix[0] === KEYSPACE.DOCUMENT
        ? [{ payload: manifest }]
        : [];
    },
    snapshot: (callback) => callback(view),
  };

  const result = await DaemonOperations.prototype.get.call(
    { store },
    { documentId: manifest.documentId },
    { project: manifest.project },
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.materialization, "chunk-table");
  assert.equal(result.document.byteLength, Buffer.byteLength(source));
  assert.equal(result.document.chunkCount, manifest.chunks.length);
  assert.equal(result.document.chunkTable.length, manifest.chunks.length);
  assert.equal(chunkReads, 0);
});

test("range reads validate every repeated content-addressed occurrence", async () => {
  const chunks = splitPhysicalChunks("AB", { maxChunkBytes: 4, minLineSplitBytes: 0 });
  const references = createChunkReferences(chunks);
  const manifest = {
    ...manifestFor(canonicalDocument("AB")),
    byteLength: 3,
    chunks: [
      references[0],
      {
        ...references[0],
        ordinal: 1,
        startByte: 2,
        endByte: 3,
        byteLength: 1,
      },
    ],
  };
  const physical = chunks[0];
  const view = {
    get: async (key) => key[0] === KEYSPACE.CHUNK
      ? {
          chunkId: physical.chunkId,
          contentHash: physical.contentHash,
          encoding: physical.encoding,
          byteLength: physical.byteLength,
          content: physical.content,
        }
      : undefined,
  };
  await assert.rejects(
    readDocumentRange(view, manifest, 0, 3),
    /failed integrity validation/u,
  );
});

test("bounded direct reads work for manifests produced by SQLite migration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-direct-migration-"));
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceText = "M".repeat(MAX_DIRECT_DOCUMENT_SOURCE_BYTES + 1);
  const source = new Archive(sourcePath);
  try {
    source.put({
      id: "migrated-large-single-token",
      sessionId: "migration-session",
      project: "/project/direct-migration",
      kind: "tool-result",
      createdAt: 2,
      text: sourceText,
      metadata: { sourceMessageKey: "tool:migrated" },
    });
  } finally {
    source.close();
  }

  const store = await RocksStore.open(storePath);
  t.after(() => store.close());
  const migration = await startMigration(store, { sourcePath, offline: true });
  assert.equal(migration.status.failedCount, 0);
  const result = await DaemonOperations.prototype.get.call(
    { store },
    { documentId: "migrated-large-single-token" },
    { project: "/project/direct-migration" },
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.materialization, "chunk-table");
  assert.equal(result.document.byteLength, Buffer.byteLength(sourceText));
});

test("single-token direct recall stays frame-bounded and preserves put version semantics", async () => {
  const paths = fixture("context-window-direct-bounds-");
  let archive;
  let processId;
  const source = "Z".repeat(MAX_DIRECT_DOCUMENT_SOURCE_BYTES + 1);
  const document = canonicalDocument(source);
  const publicDocument = {
    id: document.documentId,
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    text: document.text,
    metadata: document.metadata,
  };
  try {
    archive = new DaemonArchive({
      ...paths,
      project: document.project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    processId = archive.stats().processId;
    assert.equal(archive.put(publicDocument), document.documentId);
    assert.equal(archive.put(publicDocument), document.documentId, "an identical large retry stays idempotent");
    assert.equal(archive.canonicalHead(document.documentId).version, 1);

    const boundedClient = new StoreClient({
      socketPath: paths.socketPath,
      project: document.project,
      maxFrameBytes: 64 * 1_024,
      requestTimeoutMs: 10_000,
    });
    try {
      const response = await boundedClient.request("store.get", {
        documentId: document.documentId,
      });
      assert.equal(response.materialization, "chunk-table");
      assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 64 * 1_024);
      assert.equal(response.document.chunkCount, 17);
    } finally {
      boundedClient.close();
    }

    const recalled = archive.get(document.documentId);
    assert.equal(recalled.materialization, "chunk-table");
    assert.equal(recalled.sourceTextAvailable, false);
    assert.equal(recalled.byteLength, Buffer.byteLength(source));
    assert.match(recalled.text, /Chunk table \(17 of 17 occurrence\(s\)\)/u);
    assert.equal(recalled.text.includes(source), false);

    const changed = { ...publicDocument, text: `${source.slice(0, -1)}Y` };
    assert.equal(archive.put(changed), document.documentId);
    assert.equal(archive.canonicalHead(document.documentId).version, 2);
    assert.equal(archive.get(document.documentId).materialization, "chunk-table");
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(processId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});
