import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { searchArchive } from "../src/retrieval/search.js";
import { LocalSemanticIndex } from "../src/semantic/index.js";
import {
  decodeSemanticMetadata,
  encodeSemanticMetadata,
  SEMANTIC_METADATA_MAGIC,
} from "../src/semantic/metadata.js";
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

function semanticProjectDirectory(indexPath, fingerprint) {
  const root = join(indexPath, fingerprint);
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(projects.length, 1);
  return join(root, projects[0].name);
}

test("semantic metadata uses a compact byte-oriented document dictionary", () => {
  const repeatedText = "This exact canonical source text must not be duplicated in semantic metadata.";
  const legacyEntries = Array.from({ length: 64 }, (_, index) => ({
    label: String(index + 1),
    identity: `/workspace/semantic\0document-${index % 4}\0${1}\0${index * 100}\0${index * 100 + 90}`,
    documentId: `document-${index % 4}`,
    version: 1,
    kind: "turn",
    createdAt: 100,
    sessionId: "session-semantic",
    sourceMessageKeys: ["user:semantic"],
    windowOrdinal: index,
    startByte: index * 100,
    endByte: index * 100 + 90,
    text: repeatedText,
  }));
  const snapshot = {
    fingerprint: "semantic-fingerprint",
    project: "/workspace/semantic",
    dimensions: 384,
    entries: legacyEntries,
  };
  const encoded = encodeSemanticMetadata(snapshot);
  assert.equal(encoded.subarray(0, 8).toString("ascii"), SEMANTIC_METADATA_MAGIC);
  assert.equal(encoded.includes(Buffer.from(repeatedText, "utf8")), false);
  assert.ok(encoded.length < Buffer.byteLength(JSON.stringify(snapshot), "utf8") / 10);
  const decoded = decodeSemanticMetadata(encoded, {
    fingerprint: snapshot.fingerprint,
    project: snapshot.project,
    dimensions: snapshot.dimensions,
  });
  assert.equal(decoded.entries.length, legacyEntries.length);
  assert.equal(decoded.documents.length, 4);
  assert.deepEqual(decoded.entries[0], {
    label: "1",
    documentId: "document-0",
    version: 1,
    windowOrdinal: 0,
    startByte: 0,
    endByte: 90,
  });
});

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
  const projectDirectory = semanticProjectDirectory(options.indexPath, first.fingerprint);
  const metadataPath = join(projectDirectory, "metadata.bin");
  assert.equal(existsSync(metadataPath), true);
  assert.equal(existsSync(join(projectDirectory, "metadata.json")), false);
  assert.equal(
    readFileSync(metadataPath).includes(Buffer.from("The feline sleeps beside the radiator.", "utf8")),
    false,
  );
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

test("semantic labels remain unique when different documents use identical byte ranges", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  for (const [documentId, text] of [
    ["semantic-range-a", "one two three"],
    ["semantic-range-b", "four five six"],
  ]) {
    await admitDocument(store, {
      idempotencyKey: `${documentId}:1`,
      document: {
        documentId,
        version: 1,
        sourceKey: `user:${documentId}`,
        sourceMessageKeys: [`user:${documentId}`],
        sessionId: "session-semantic",
        project: "/workspace/semantic",
        kind: "turn",
        createdAt: 100,
        text,
        metadata: {},
      },
      retentionClass: "conversation-source",
    });
  }
  const errors = [];
  const semantic = new LocalSemanticIndex(store, {
    enabled: true,
    model: "test/model",
    revision: "test-revision",
    cachePath: join(directory, "models"),
    indexPath: join(directory, "index"),
    dimensions: 3,
    embedder: fakeEmbedder(),
    recordError: (error) => errors.push(error),
  });
  semantic.enqueueDocument("semantic-range-a", 1);
  semantic.enqueueDocument("semantic-range-b", 1);
  await semantic.flush();
  assert.deepEqual(errors, []);
  assert.equal(semantic.status().available, true);
  assert.equal(semantic.status().documents, 2);
  assert.equal(semantic.status().entries, 2);
  await semantic.close();
});

test("an inconsistent semantic snapshot rebuilds from empty canonical state", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  for (const [documentId, text] of [
    ["semantic-rebuild-a", "alpha semantic evidence"],
    ["semantic-rebuild-b", "beta semantic evidence"],
  ]) {
    await admitDocument(store, {
      idempotencyKey: `${documentId}:1`,
      document: {
        documentId,
        version: 1,
        sourceKey: `user:${documentId}`,
        sourceMessageKeys: [`user:${documentId}`],
        sessionId: "session-semantic",
        project: "/workspace/semantic",
        kind: "turn",
        createdAt: 100,
        text,
        metadata: {},
      },
      retentionClass: "conversation-source",
    });
  }
  const options = {
    enabled: true,
    model: "test/model",
    revision: "test-revision",
    cachePath: join(directory, "models"),
    indexPath: join(directory, "index"),
    dimensions: 3,
    embedder: fakeEmbedder(),
  };
  const first = new LocalSemanticIndex(store, options);
  first.enqueueDocument("semantic-rebuild-a", 1);
  first.enqueueDocument("semantic-rebuild-b", 1);
  await first.flush();
  const projectDirectory = semanticProjectDirectory(options.indexPath, first.fingerprint);
  const metadataPath = join(projectDirectory, "metadata.bin");
  const metadata = decodeSemanticMetadata(readFileSync(metadataPath), {
    fingerprint: first.fingerprint,
    project: "/workspace/semantic",
    dimensions: 3,
  });
  writeFileSync(metadataPath, encodeSemanticMetadata({
    fingerprint: first.fingerprint,
    project: "/workspace/semantic",
    dimensions: 3,
    entries: metadata.entries.slice(0, 1),
  }));
  await first.close();

  const rebuilt = new LocalSemanticIndex(store, options);
  assert.deepEqual(await rebuilt.search({
    query: "semantic evidence",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 3,
  }), []);
  assert.equal(rebuilt.status().entries, 0);
  assert.equal(rebuilt.status().documents, 0);
  rebuilt.enqueueDocument("semantic-rebuild-a", 1);
  rebuilt.enqueueDocument("semantic-rebuild-b", 1);
  await rebuilt.flush();
  assert.equal(rebuilt.status().entries, 2);
  assert.equal(rebuilt.status().documents, 2);
  await rebuilt.close();
});

test("semantic search stops canonical hydration at three times the requested limit", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  for (let index = 0; index < 10; index += 1) {
    const documentId = `semantic-hydration-${index}`;
    await admitDocument(store, {
      idempotencyKey: `${documentId}:1`,
      document: {
        documentId,
        version: 1,
        sourceKey: `user:${documentId}`,
        sourceMessageKeys: [`user:${documentId}`],
        sessionId: "session-semantic",
        project: "/workspace/semantic",
        kind: "turn",
        createdAt: 100 + index,
        text: `semantic hydration candidate ${index}`,
        metadata: {},
      },
      retentionClass: "conversation-source",
    });
  }
  const semantic = new LocalSemanticIndex(store, {
    enabled: true,
    model: "test/model",
    revision: "test-revision",
    cachePath: join(directory, "models"),
    indexPath: join(directory, "index"),
    dimensions: 3,
    candidates: 40,
    embedder: fakeEmbedder(),
  });
  for (let index = 0; index < 10; index += 1) {
    semantic.enqueueDocument(`semantic-hydration-${index}`, 1);
  }
  await semantic.flush();

  const originalSnapshot = store.snapshot.bind(store);
  let manifestReads = 0;
  store.snapshot = (callback) => originalSnapshot((view) => callback(new Proxy(view, {
    get(target, property) {
      if (property === "get") {
        return async (key) => {
          if (Array.isArray(key) && key[0] === KEYSPACE.DOCUMENT) manifestReads += 1;
          return target.get(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })));
  const results = await semantic.search({
    query: "semantic hydration candidate",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 1,
  });
  store.snapshot = originalSnapshot;

  assert.equal(results.length, 3);
  assert.equal(manifestReads, 3);
  await semantic.close();
});

test("semantic search preserves its hydration limit after pruning retired candidates", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  for (let index = 0; index < 45; index += 1) {
    const documentId = `semantic-retry-${String(index).padStart(2, "0")}`;
    await admitDocument(store, {
      idempotencyKey: `${documentId}:1`,
      document: {
        documentId,
        version: 1,
        sourceKey: `user:${documentId}`,
        sourceMessageKeys: [`user:${documentId}`],
        sessionId: "session-semantic",
        project: "/workspace/semantic",
        kind: "turn",
        createdAt: 100 + index,
        text: `semantic retry candidate ${index}`,
        metadata: {},
      },
      retentionClass: "conversation-source",
    });
  }
  const semantic = new LocalSemanticIndex(store, {
    enabled: true,
    model: "test/model",
    revision: "test-revision",
    cachePath: join(directory, "models"),
    indexPath: join(directory, "index"),
    dimensions: 3,
    candidates: 40,
    embedder: fakeEmbedder(),
  });
  for (let index = 0; index < 45; index += 1) {
    semantic.enqueueDocument(`semantic-retry-${String(index).padStart(2, "0")}`, 1);
  }
  await semantic.flush();
  const request = {
    query: "semantic retry candidate",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 1,
  };
  const initial = await semantic.search({ ...request, limit: 14 });
  assert.equal(initial.length, 40);
  for (const result of initial.slice(0, 38)) {
    await store.put([KEYSPACE.SUPERSESSION, result.documentId, 1], {
      documentId: result.documentId,
      documentVersion: 1,
      status: "expired",
      reason: "Semantic retry hydration test.",
      recordedAt: 1_000,
    });
  }

  const originalSnapshot = store.snapshot.bind(store);
  let chunkReads = 0;
  store.snapshot = (callback) => originalSnapshot((view) => callback(new Proxy(view, {
    get(target, property) {
      if (property === "get") {
        return async (key) => {
          if (Array.isArray(key) && key[0] === KEYSPACE.CHUNK) chunkReads += 1;
          return target.get(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })));
  const results = await semantic.search(request);
  store.snapshot = originalSnapshot;

  assert.equal(results.length, 3);
  assert.equal(chunkReads, 3);
  await semantic.close();
});

test("a legacy JSON semantic snapshot migrates to compact bytes without re-embedding", async (t) => {
  const directory = temporaryDirectory(t);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const text = "The feline sleeps beside the radiator.";
  await admitDocument(store, {
    idempotencyKey: "semantic:legacy:1",
    document: {
      documentId: "semantic-legacy",
      version: 1,
      sourceKey: "user:semantic-legacy",
      sourceMessageKeys: ["user:semantic-legacy"],
      sessionId: "session-semantic",
      project: "/workspace/semantic",
      kind: "turn",
      createdAt: 100,
      text,
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
  const first = new LocalSemanticIndex(store, options);
  first.enqueueDocument("semantic-legacy", 1);
  await first.flush();
  const projectDirectory = semanticProjectDirectory(options.indexPath, first.fingerprint);
  const metadataPath = join(projectDirectory, "metadata.bin");
  const decoded = decodeSemanticMetadata(readFileSync(metadataPath), {
    fingerprint: first.fingerprint,
    project: "/workspace/semantic",
    dimensions: 3,
  });
  const legacySnapshot = {
    formatVersion: 1,
    fingerprint: first.fingerprint,
    project: "/workspace/semantic",
    dimensions: 3,
    entries: decoded.entries.map((entry) => ({
      ...entry,
      identity: "legacy-identity",
      kind: "turn",
      createdAt: 100,
      sessionId: "session-semantic",
      sourceMessageKeys: ["user:semantic-legacy"],
      text,
    })),
    documents: decoded.documents,
  };
  const legacyMetadataPath = join(projectDirectory, "metadata.json");
  writeFileSync(legacyMetadataPath, JSON.stringify(legacySnapshot));
  unlinkSync(metadataPath);
  await first.close();

  const reloaded = new LocalSemanticIndex(store, options);
  const results = await reloaded.search({
    query: "house pet",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 3,
  });
  assert.equal(results[0].text, text);
  assert.equal(existsSync(metadataPath), true);
  assert.equal(existsSync(legacyMetadataPath), false);
  assert.equal(readFileSync(metadataPath).includes(Buffer.from(text, "utf8")), false);
  await reloaded.close();

  // Simulate a crash after metadata.bin was published but before the legacy
  // duplicate was removed. A valid binary load must finish that cleanup.
  writeFileSync(legacyMetadataPath, JSON.stringify(legacySnapshot));
  const recovered = new LocalSemanticIndex(store, options);
  assert.equal((await recovered.search({
    query: "house pet",
    project: "/workspace/semantic",
    effectiveScope: "session",
    sessionIds: ["session-semantic"],
    excludeVisibleSourceKeys: [],
    limit: 3,
  }))[0].text, text);
  assert.equal(existsSync(legacyMetadataPath), false);
  await recovered.close();
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
