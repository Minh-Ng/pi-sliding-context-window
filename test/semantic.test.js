import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { searchArchive } from "../src/retrieval/search.js";
import { LocalSemanticIndex } from "../src/semantic/index.js";
import { createSemanticSpans } from "../src/semantic/spans.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-semantic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeEmbedder() {
  return {
    async embed(texts) {
      const vectors = new Float32Array(texts.length * 3);
      for (let index = 0; index < texts.length; index += 1) {
        const text = texts[index].toLowerCase();
        const vector = text.includes("cat") || text.includes("feline") || text.includes("house pet")
          ? [1, 0, 0]
          : [0, 1, 0];
        vectors.set(vector, index * 3);
      }
      return { dimensions: 3, vectors };
    },
  };
}

test("semantic spans preserve exact UTF-8 coordinates with bounded overlap", () => {
  const text = "zero naïve two three four five six";
  const spans = createSemanticSpans(text, {
    baseStartByte: 10,
    windowOrdinal: 7,
    spanTokens: 4,
    overlapTokens: 1,
  });
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map(({ text: value }) => value), [
    "zero naïve two three",
    "three four five six",
  ]);
  for (const span of spans) {
    assert.equal(span.windowOrdinal, 7);
    assert.equal(Buffer.from(text, "utf8").subarray(
      span.startByte - 10,
      span.endByte - 10,
    ).toString("utf8"), span.text);
  }
});

test("local semantic index searches and reloads a project-scoped ANN snapshot", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  await admitDocument(store, {
    idempotencyKey: "semantic:cat:1",
    document: {
      documentId: "semantic-cat",
      version: 1,
      sourceKey: "user:semantic-cat",
      sourceMessageKeys: ["user:semantic-cat"],
      sessionId: "session-semantic",
      project: "/workspace/semantic",
      kind: "turn",
      createdAt: 100,
      text: "The feline sleeps beside the radiator.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  });
  const options = {
    enabled: true,
    model: "test/model",
    revision: "test-revision",
    cachePath: join(directory, "models"),
    indexPath: join(directory, "index"),
    dimensions: 3,
    embedder: fakeEmbedder(),
  };
  const request = {
    query: "house pet",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 3,
  };
  const first = new LocalSemanticIndex(store, options);
  first.enqueueDocument("semantic-cat", 1);
  await first.flush();
  assert.equal((await first.search(request))[0].documentId, "semantic-cat");
  const hybrid = await searchArchive(store, {
    query: "house pet",
    relation: null,
    scope: "session",
    sessionId: "session-semantic",
    project: "/workspace/semantic",
    limit: 3,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 0,
  }, { semantic: first, now: 1_000 });
  assert.equal(hybrid.mode, "hybrid");
  assert.equal(hybrid.results[0].retrievalMode, "semantic");
  assert.equal(hybrid.results[0].documentId, "semantic-cat");
  await first.close();

  const reloaded = new LocalSemanticIndex(store, { ...options, embedder: fakeEmbedder() });
  assert.equal((await reloaded.search(request))[0].documentId, "semantic-cat");
  await reloaded.close();
});
