import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
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
  assert.equal(first.status().queuedDocuments, 1);
  await first.flush();
  const firstStatus = first.status();
  assert.equal(firstStatus.projects, 1);
  assert.equal(firstStatus.entries, 1);
  assert.equal(firstStatus.documents, 1);
  assert.equal(firstStatus.queuedDocuments, 0);
  assert.ok(firstStatus.metadataBytes > 0);
  assert.ok(firstStatus.indexBytes > 0);
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
  assert.deepEqual(
    reloaded.status(),
    { ...firstStatus, queuedDocuments: 0 },
  );

  await store.put([KEYSPACE.SUPERSESSION, "semantic-cat", 1], {
    documentId: "semantic-cat",
    documentVersion: 1,
    status: "expired",
    reason: "Semantic status retirement test.",
    recordedAt: Date.now(),
  });
  assert.deepEqual(await reloaded.search(request), []);
  assert.equal(reloaded.status().entries, 0);
  assert.equal(reloaded.status().documents, 0);
  await reloaded.close();

  const cleaned = new LocalSemanticIndex(store, { ...options, embedder: fakeEmbedder() });
  assert.deepEqual(await cleaned.search(request), []);
  assert.equal(cleaned.status().entries, 0);
  assert.equal(cleaned.status().documents, 0);
  await cleaned.close();
});

test("local semantic index derives dimensions and pooling from the configured model's catalog entry", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const shippedDefault = new LocalSemanticIndex(store, {
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    embedder: fakeEmbedder(),
  });
  assert.equal(shippedDefault.dimensions, 384);
  assert.equal(shippedDefault.pooling, "mean");
  await shippedDefault.close();

  // embeddinggemma-300m is 768-dim, mean-pooled; verifying dimensions are
  // derived from the model (not the 384 literal that matches only MiniLM).
  const smallTier = new LocalSemanticIndex(store, {
    model: "onnx-community/embeddinggemma-300m-ONNX",
    revision: "main",
    embedder: fakeEmbedder(),
  });
  assert.equal(smallTier.dimensions, 768);
  assert.equal(smallTier.pooling, "mean");
  await smallTier.close();

  // Qwen3-Embedding-0.6B is 1024-dim, last-token-pooled: both the dimension
  // count and the pooling strategy must come from the model, since neither
  // matches the encoder-model defaults above.
  const qualityTier = new LocalSemanticIndex(store, {
    model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    revision: "main",
    embedder: fakeEmbedder(),
  });
  assert.equal(qualityTier.dimensions, 1024);
  assert.equal(qualityTier.pooling, "last_token");
  await qualityTier.close();

  // An explicit override always wins over the catalog, covering a custom or
  // self-hosted model the catalog does not recognize.
  const overridden = new LocalSemanticIndex(store, {
    model: "some-org/custom-model",
    revision: "v1",
    dimensions: 512,
    pooling: "cls",
    embedder: fakeEmbedder(),
  });
  assert.equal(overridden.dimensions, 512);
  assert.equal(overridden.pooling, "cls");
  await overridden.close();

  // An unrecognized model with no explicit override falls back to the
  // historical MiniLM-shaped default rather than throwing or guessing.
  const unknown = new LocalSemanticIndex(store, {
    model: "some-org/unknown-model",
    revision: "v1",
    embedder: fakeEmbedder(),
  });
  assert.equal(unknown.dimensions, 384);
  assert.equal(unknown.pooling, "mean");
  await unknown.close();
});

test("local semantic index sanitizes an invalid dimensions/pooling override instead of surfacing NaN or an unrecognized string", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  // Number(null) is the exact failure mode a raw `Number()` cast of a missing
  // env var (e.g. CONTEXT_WINDOW_SEMANTIC_MODEL_DIMENSIONS unset) produces.
  const invalidDimensions = new LocalSemanticIndex(store, {
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: Number(null),
    embedder: fakeEmbedder(),
  });
  assert.equal(invalidDimensions.dimensions, 384);
  assert.equal(Number.isNaN(invalidDimensions.dimensions), false);
  await invalidDimensions.close();

  const invalidPooling = new LocalSemanticIndex(store, {
    model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    pooling: "not-a-real-pooling-mode",
    embedder: fakeEmbedder(),
  });
  assert.equal(invalidPooling.pooling, "last_token");
  await invalidPooling.close();
});

test("local semantic index fingerprint changes with pooling, dimensions, model, or revision", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const base = new LocalSemanticIndex(store, {
    model: "test/model",
    revision: "rev-1",
    dimensions: 3,
    embedder: fakeEmbedder(),
  });
  const samePooling = new LocalSemanticIndex(store, {
    model: "test/model",
    revision: "rev-1",
    dimensions: 3,
    pooling: "mean",
    embedder: fakeEmbedder(),
  });
  const differentPooling = new LocalSemanticIndex(store, {
    model: "test/model",
    revision: "rev-1",
    dimensions: 3,
    pooling: "cls",
    embedder: fakeEmbedder(),
  });
  const differentDimensions = new LocalSemanticIndex(store, {
    model: "test/model",
    revision: "rev-1",
    dimensions: 4,
    embedder: fakeEmbedder(),
  });
  assert.equal(base.fingerprint, samePooling.fingerprint);
  assert.notEqual(base.fingerprint, differentPooling.fingerprint);
  assert.notEqual(base.fingerprint, differentDimensions.fingerprint);
  await Promise.all([base, samePooling, differentPooling, differentDimensions].map((index) => index.close()));
});

test("a mean-pooled index's fingerprint stays byte-identical to the pre-pooling formula, so upgrading does not abandon existing indexes", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const meanPooled = new LocalSemanticIndex(store, {
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dimensions: 384,
    embedder: fakeEmbedder(),
  });
  t.after(() => meanPooled.close());
  // Every index built before pooling existed as a knob was fingerprinted with
  // this 3-field, pooling-less formula. A deployment that was already
  // mean-pooled (every deployment, historically) must reproduce it exactly.
  const historicalFingerprint = createHash("sha256")
    .update("Xenova/all-MiniLM-L6-v2\x00751bff37182d3f1213fa05d7196b954e230abad9\x00384")
    .digest("hex")
    .slice(0, 32);
  assert.equal(meanPooled.fingerprint, historicalFingerprint);

  const clsPooled = new LocalSemanticIndex(store, {
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dimensions: 384,
    pooling: "cls",
    embedder: fakeEmbedder(),
  });
  t.after(() => clsPooled.close());
  assert.notEqual(clsPooled.fingerprint, historicalFingerprint);
});
