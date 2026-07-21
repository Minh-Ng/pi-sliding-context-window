import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler, searchBm25 } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler, lookupExact } from "../src/rocksdb/index/exact.js";
import { createImportanceIndexHandler } from "../src/rocksdb/index/importance.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument, manifestKeys } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { DEFAULT_RETENTION_CLASS_BY_KIND } from "../src/daemon/retention-policy.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function factCandidateRequest(documentId, text, overrides = {}) {
  const sourceKey = overrides.sourceKey ?? `assistant:${documentId}`;
  return {
    idempotencyKey: `fact-candidate:${documentId}:1`,
    retentionClass: DEFAULT_RETENTION_CLASS_BY_KIND["fact-candidate"],
    structuralMessages: [],
    document: {
      documentId,
      version: 1,
      sourceKey,
      sourceMessageKeys: [sourceKey],
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/workspace/fact-candidate",
      kind: "fact-candidate",
      createdAt: overrides.createdAt ?? 100,
      text,
      metadata: {
        sourceTurnId: overrides.sourceTurnId ?? "turn-1",
        sourceMessageKeys: [sourceKey],
        sourceFirstKey: sourceKey,
        sourceLastKey: sourceKey,
        sourceMessageCount: 1,
        factAnchor: overrides.factAnchor,
      },
    },
  };
}

async function admitFactCandidate(store, documentId, text, overrides = {}) {
  return admitDocument(store, factCandidateRequest(documentId, text, overrides), {
    chunking: { maxChunkBytes: 256, minLineSplitBytes: 0 },
    windows: { windowTokens: 32, overlapTokens: 4 },
  });
}

test("a fact-candidate document indexes through the full generic pipeline with no special-casing", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "fact-candidate-generic"));
  t.after(() => store.close());
  const text = "[assistant] The build uses node v20.11.0 for this project.";
  await admitFactCandidate(store, "fact-1", text, {
    factAnchor: { type: "value", value: "v20.11.0" },
  });

  const worker = new IndexWorker(store, {
    workerId: "worker:fact-candidate-indexing",
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
      createImportanceIndexHandler(),
    ],
  });
  const drained = await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });
  assert.equal(drained.processed, 1, "indexing an unfamiliar kind does not error or get skipped");

  // The stored manifest kept the exact kind and the derived-evidence
  // retention class it was admitted with (no per-kind rewriting).
  const manifest = await store.get(manifestKeys.document("fact-1", 1));
  assert.equal(manifest.kind, "fact-candidate");
  assert.equal(manifest.retentionClass, "derived-evidence");

  // Lexically searchable via the ordinary BM25 path, same as any other kind.
  const lexical = await searchBm25(store, {
    query: "build",
    project: "/workspace/fact-candidate",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 3,
  });
  assert.ok(
    lexical.results.some((result) => result.documentId === "fact-1"),
    "fact-candidate text is indexed like any other document's text",
  );

  // The structured anchor stored in metadata is exactly the span the shared
  // exact.js classifier reported, so it is independently exact-lookup-able
  // by that same string with no drift between metadata and the index.
  const exact = await lookupExact(store, {
    query: "v20.11.0",
    project: "/workspace/fact-candidate",
    scope: "session",
    sessionId: "session-main",
    limit: 3,
  });
  assert.deepEqual(exact.results.map(({ documentId }) => documentId), ["fact-1"]);
  assert.equal(exact.results[0].kind, "fact-candidate");
});
