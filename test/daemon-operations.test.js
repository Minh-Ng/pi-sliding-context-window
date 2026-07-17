import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_STORE_ERROR_MESSAGE_LENGTH } from "../src/store-contract.js";
import { createDaemonOperations, DaemonOperations } from "../src/daemon/operations.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { StoreClient } from "../src/store-client.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { admitDocument, manifestKeys } from "../src/rocksdb/manifests.js";
import { outboxKeys } from "../src/rocksdb/outbox.js";
import { encodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { retentionKeys } from "../src/rocksdb/retention.js";

async function runningRuntime(t, runtimeOptions = {}, daemonOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-operations-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = join(directory, "context-window.sock");
  let runtime;
  const names = [
    "store.put",
    "store.get",
    "store.search",
    "store.recall",
    "store.count",
    "store.preflight",
    "store.remove-hints",
    "store.protect",
    "store.release-protection",
    "store.pin",
    "store.unpin",
    "retention.run",
    "retention.status",
    "store.compact",
  ];
  const operationHandlers = Object.fromEntries(names.map((name) => [
    name,
    (payload, context) => runtime.handlers()[name](payload, context),
  ]));
  const daemon = await startStoreDaemon({
    ...daemonOptions,
    storePath,
    socketPath,
    operationHandlers,
    createStore: async (path) => {
      const store = await RocksStore.open(path);
      runtime = await createDaemonOperations(store, runtimeOptions);
      return store;
    },
    beforeStoreClose: () => runtime?.close(),
    statusProvider: () => runtime.status(),
  });
  t.after(async () => {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { socketPath, runtime, daemon, store: runtime.store };
}

test("daemon admission reports durable, retryable disk-low state", async (t) => {
  const { socketPath } = await runningRuntime(t, {
    maintenance: {
      criticalFreeBytes: 1_000,
      admissionReserveBytes: 0,
      readFreeBytes: () => 500,
    },
  });
  const project = "/workspace/disk-low";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  await assert.rejects(client.request("store.put", {
    idempotencyKey: "disk-low-put",
    document: document(project),
    retentionClass: "conversation-source",
  }, { retry: false }), (error) => error.code === "DISK_LOW" && error.retryable === true);
  const status = await client.request("daemon.status", {});
  assert.equal(status.retention.emergencyMode, true);
});

test("daemon admission reports oversized native keys as invalid requests", async (t) => {
  const { socketPath, store } = await runningRuntime(t);
  const project = "/workspace/oversized-native-key";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  const oversizedDocumentId = "d".repeat(8_192);

  await assert.rejects(client.request("store.put", {
    idempotencyKey: "oversized-native-key",
    document: {
      ...document(project),
      documentId: oversizedDocumentId,
    },
    retentionClass: "conversation-source",
  }, { retry: false }), (error) => {
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.retryable, false);
    assert.equal(error.details.boundary, "canonical key");
    assert.equal(error.details.actualBytes > error.details.maxBytes, true);
    return true;
  });
  assert.equal(store.scan([KEYSPACE.DOCUMENT]).length, 0);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 0);
});

test("a foreground index fault cannot turn a committed admission into an RPC failure", async (t) => {
  let faulted = false;
  const { socketPath, runtime, store } = await runningRuntime(t, {
    indexWorker: {
      fault(boundary, { claim }) {
        if (boundary !== "after-claim" || claim?.status !== "claimed" || faulted) return;
        faulted = true;
        throw new Error("injected foreground publication fault");
      },
    },
  });
  const project = "/workspace/foreground-index-fault";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());

  const result = await client.request("store.put", {
    idempotencyKey: "foreground-index-fault-put",
    document: document(project),
    retentionClass: "conversation-source",
  }, { retry: false });
  assert.equal(result.status, "stored");
  assert.equal(faulted, true);
  assert.ok(await store.get(manifestKeys.document(result.documentId, result.version)));

  let state;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await store.get(outboxKeys.state(result.outboxSequence));
    if (state?.status === "processed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(state?.status, "processed");
  assert.equal(runtime.backgroundErrors.some(
    ({ code, message }) => code === "INTERNAL"
      && /injected foreground publication fault/u.test(message),
  ), true);
});

test("daemon protection authorizes the complete set before one atomic write", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-protect-operation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const project = "/workspace/protect-operation";
  const foreignProject = "/workspace/protect-operation-foreign";
  const local = { ...document(project), documentId: "protect-local", sourceKey: "user:local" };
  const foreign = {
    ...document(foreignProject),
    documentId: "protect-foreign",
    sourceKey: "user:foreign",
  };
  for (const candidate of [local, foreign]) {
    await admitDocument(store, {
      idempotencyKey: `protect-operation:${candidate.documentId}`,
      document: candidate,
      retentionClass: "conversation-source",
    });
  }

  const operation = DaemonOperations.prototype.protect.bind({ store });
  await assert.rejects(operation({
    ownerId: "protect-owner",
    ttlMs: 60_000,
    sessionIds: [],
    documentVersions: [
      { documentId: local.documentId, version: 1 },
      { documentId: foreign.documentId, version: 1 },
    ],
  }, { project }), (error) => error.code === "UNAUTHORIZED");
  assert.equal(store.scan(retentionKeys.protection("probe").slice(0, -1)).length, 0);

  const protectedResult = await operation({
    ownerId: "protect-owner",
    ttlMs: 60_000,
    sessionIds: [],
    documentVersions: [{ documentId: local.documentId, version: 1 }],
  }, { project });
  assert.equal(protectedResult.ownerId, "protect-owner");
  assert.equal(protectedResult.protectedDocuments, 1);
});

test("store.count scans the compact session-reference index across pages", async () => {
  const project = "/workspace/count-pages";
  const references = Array.from({ length: 10_001 }, (_, index) => {
    const documentId = `document-${String(index).padStart(5, "0")}`;
    const key = [
      KEYSPACE.META,
      "session-document-reference",
      project,
      "session-count",
      documentId,
      1,
    ];
    return {
      key,
      keyBytes: encodeKey(key),
      payload: { documentId, documentVersion: 1, project, sessionId: "session-count" },
    };
  });
  const scans = [];
  let markerReads = 0;
  const store = {
    *iterate(prefix, options) {
      scans.push({ prefix, limit: options.limit });
      const records = options.after === undefined
        ? references
        : references.filter(({ keyBytes }) => Buffer.compare(keyBytes, options.after) > 0);
      yield* records.slice(0, options.limit);
    },
    async get(key) {
      markerReads += 1;
      return key[1] === "document-00000" ? { status: "expired" } : undefined;
    },
  };

  const result = await DaemonOperations.prototype.count.call(
    { store },
    { scope: "project" },
    { project },
  );
  assert.deepEqual(result, { count: 10_000 });
  assert.deepEqual(scans.map(({ prefix }) => prefix), [
    [KEYSPACE.META, "session-document-reference", project],
    [KEYSPACE.META, "session-document-reference", project],
  ]);
  assert.ok(scans.every(({ limit }) => limit === 10_000));
  assert.equal(markerReads, 10_001);
});

test("store.count excludes marked references regardless of encoded ID ordering", async () => {
  const project = "/workspace/count-key-order";
  const references = ["z", "aa", "bbb"].map((documentId) => {
    const key = [
      KEYSPACE.META,
      "session-document-reference",
      project,
      "session-count",
      documentId,
      1,
    ];
    return {
      key,
      keyBytes: encodeKey(key),
      payload: { documentId, documentVersion: 1, project, sessionId: "session-count" },
    };
  }).sort((left, right) => Buffer.compare(left.keyBytes, right.keyBytes));
  const store = {
    *iterate(_prefix, options) {
      yield* references.filter(({ keyBytes }) => options.after === undefined
        || Buffer.compare(keyBytes, options.after) > 0).slice(0, options.limit);
    },
    async get(key) {
      return key[1] === "aa" ? { status: "expired" } : undefined;
    },
  };

  const result = await DaemonOperations.prototype.count.call(
    { store },
    { scope: "project" },
    { project },
  );
  assert.deepEqual(result, { count: 2 });
});

function document(project, createdAt = 1_000) {
  return {
    documentId: "turn-1",
    version: 1,
    sourceKey: "user:1",
    sessionId: "session-1",
    project,
    kind: "turn",
    createdAt,
    text: "We decided REAP_DRAIN belongs in worker.ts.",
    metadata: { turnId: "turn-1" },
    sourceMessageKeys: ["user:1", "assistant:1"],
    sourceKeyStatus: "preserved",
  };
}

function largeDocument(project, documentId = "large-tool") {
  return {
    documentId,
    version: 1,
    sourceKey: `tool:${documentId}`,
    sessionId: "session-large",
    project,
    kind: "tool-result",
    createdAt: 2_000,
    text: `${"x".repeat(4_095)}\n`.repeat(1_280),
    metadata: { toolCallId: documentId },
    sourceMessageKeys: [`tool:${documentId}`],
    sourceKeyStatus: "preserved",
  };
}

test("large canonical puts return before indexing the admitted outbox entry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-large-put-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const project = "/workspace/large-put";
  const startedAt = performance.now();
  const result = await runtime.handlers()["store.put"]({
    idempotencyKey: "large-put",
    document: largeDocument(project),
    retentionClass: "ephemeral-payload",
  }, { project });
  const canonicalLatencyMs = performance.now() - startedAt;
  assert.equal(result.status, "stored");
  assert.notEqual((await store.get(outboxKeys.state(result.outboxSequence)))?.status, "processed");
  assert.equal(await store.get(["meta", "published-index-generation"]), undefined);
  assert.ok(canonicalLatencyMs < 1_000, `canonical admission took ${canonicalLatencyMs}ms`);
});

test("retryable background index faults re-arm without unrelated requests", async (t) => {
  let faulted = false;
  const { socketPath, runtime, store } = await runningRuntime(t, {
    indexWorker: {
      fault(boundary, { claim }) {
        if (boundary !== "after-claim" || claim?.status !== "claimed" || faulted) return;
        faulted = true;
        const error = new Error("injected retryable background publication fault");
        error.code = "STORE_BUSY";
        error.retryable = true;
        throw error;
      },
    },
  });
  const project = "/workspace/background-index-retry";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  const payload = {
    ...document(project),
    documentId: "background-index-retry",
    sourceKey: "tool:background-index-retry",
    kind: "tool-result",
    text: "retryable background payload ".repeat(3_000),
    metadata: { toolCallId: "background-index-retry" },
    sourceMessageKeys: ["tool:background-index-retry"],
  };

  const admitted = await client.request("store.put", {
    idempotencyKey: "background-index-retry-put",
    document: payload,
    retentionClass: "ephemeral-payload",
  }, { retry: false });
  assert.equal(admitted.status, "stored");

  let state;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    state = await store.get(outboxKeys.state(admitted.outboxSequence));
    if (state?.status === "processed"
      && runtime.idleDrainPromise === undefined
      && runtime.indexRetryTimer === undefined
      && runtime.indexRetryAttempt === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(faulted, true);
  assert.equal(state?.status, "processed");
  assert.equal(runtime.backgroundErrors.some(
    ({ code, message, retryable }) => code === "STORE_BUSY" && retryable === true
      && /injected retryable background publication fault/u.test(message),
  ), true);
  assert.equal(runtime.indexRetryTimer, undefined);
  assert.equal(runtime.indexRetryAttempt, 0);
});

test("shutdown cancels a pending background index retry", async (t) => {
  let attempts = 0;
  const { socketPath, runtime } = await runningRuntime(t, {
    indexWorker: {
      fault(boundary, { claim }) {
        if (boundary !== "after-claim" || claim?.status !== "claimed") return;
        attempts += 1;
        const error = new Error("persistent retryable background publication fault");
        error.code = "STORE_BUSY";
        error.retryable = true;
        throw error;
      },
    },
  });
  const project = "/workspace/background-index-retry-close";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  const payload = {
    ...document(project),
    documentId: "background-index-retry-close",
    sourceKey: "tool:background-index-retry-close",
    kind: "tool-result",
    text: "persistent background payload ".repeat(3_000),
    metadata: { toolCallId: "background-index-retry-close" },
    sourceMessageKeys: ["tool:background-index-retry-close"],
  };
  assert.equal((await client.request("store.put", {
    idempotencyKey: "background-index-retry-close-put",
    document: payload,
    retentionClass: "ephemeral-payload",
  }, { retry: false })).status, "stored");

  for (let attempt = 0; attempt < 200 && runtime.indexRetryTimer === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(runtime.indexRetryTimer !== undefined);
  const attemptsBeforeClose = attempts;
  await runtime.close();
  assert.equal(runtime.indexRetryTimer, undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, attemptsBeforeClose);
});

test("daemon ping remains responsive while a large background source is indexed", async (t) => {
  let markYielded;
  let releaseYield;
  let held = false;
  const yielded = new Promise((resolve) => { markYielded = resolve; });
  const gate = new Promise((resolve) => { releaseYield = resolve; });
  const { socketPath, runtime, store } = await runningRuntime(t, {
    indexWorker: {
      sourceSegmentBytes: 32 * 1_024,
      async yieldControl() {
        if (!held) {
          held = true;
          markYielded();
          await gate;
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
  });
  const project = "/workspace/index-responsive";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  assert.equal((await client.ping("ready")).nonce, "ready");
  await admitDocument(store, {
    idempotencyKey: "responsive-large-index",
    document: {
      ...largeDocument(project, "responsive-large-index"),
      text: `${"a".repeat(3 * 1_024 * 1_024)} RESPONSIVE_TAIL_TARGET`,
    },
    retentionClass: "ephemeral-payload",
  });
  runtime.scheduleIndexing();
  await Promise.race([
    yielded,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("background indexer did not reach a cooperative yield")),
      5_000,
    )),
  ]);
  try {
    const ping = await Promise.race([
      client.ping("during-index"),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("daemon ping was blocked by background indexing")),
        1_000,
      )),
    ]);
    assert.equal(ping.nonce, "during-index");
  } finally {
    releaseYield();
  }
});

test("startup does not synchronously prepare a large ordered head entry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-large-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "archive.rocks");
  let store = await RocksStore.open(path);
  const project = "/workspace/large-startup";
  const admitted = await admitDocument(store, {
    idempotencyKey: "large-startup",
    document: largeDocument(project, "large-startup"),
    retentionClass: "ephemeral-payload",
  });
  store.close();

  store = await RocksStore.open(path);
  const startedAt = performance.now();
  const runtime = await createDaemonOperations(store);
  const readinessLatencyMs = performance.now() - startedAt;
  assert.equal((await store.get(outboxKeys.state(admitted.outboxSequence)))?.status ?? "pending", "pending");
  assert.ok(readinessLatencyMs < 250, `startup readiness took ${readinessLatencyMs}ms`);
  await runtime.close();
  store.close();
});

test("a foreground startup index fault preserves readiness and retries in background", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-startup-index-fault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "archive.rocks");
  const project = "/workspace/startup-index-fault";
  let store = await RocksStore.open(path);
  const admitted = await admitDocument(store, {
    idempotencyKey: "startup-index-fault-put",
    document: document(project),
    retentionClass: "conversation-source",
  });
  store.close();

  let faulted = false;
  store = await RocksStore.open(path);
  const runtime = await createDaemonOperations(store, {
    indexWorker: {
      fault(boundary, { claim }) {
        if (boundary !== "after-claim" || claim?.status !== "claimed" || faulted) return;
        faulted = true;
        throw new Error("injected startup foreground publication fault");
      },
    },
  });
  assert.equal(faulted, true);
  assert.ok(await store.get(manifestKeys.document(admitted.documentId, admitted.version)));

  let state;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await store.get(outboxKeys.state(admitted.outboxSequence));
    if (state?.status === "processed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(state?.status, "processed");
  assert.equal(runtime.backgroundErrors.some(
    ({ code, message }) => code === "INTERNAL"
      && /injected startup foreground publication fault/u.test(message),
  ), true);
  await runtime.close();
  store.close();
});

test("remote shutdown drains claimed background indexing before closing RocksDB", async (t) => {
  let releaseClaim;
  let markClaimed;
  let blocked = false;
  const claimed = new Promise((resolve) => { markClaimed = resolve; });
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const { socketPath, runtime, daemon, store } = await runningRuntime(t, {
    indexWorker: {
      fault: async (boundary, { claim }) => {
        if (boundary !== "after-claim" || claim?.status !== "claimed" || blocked) return;
        blocked = true;
        markClaimed();
        await claimGate;
      },
    },
  }, { allowShutdown: true });
  const project = "/workspace/remote-shutdown";
  const client = new StoreClient({ socketPath, project });
  t.after(() => client.close());
  const backgroundDocument = {
    ...document(project),
    documentId: "shutdown-background",
    sourceKey: "tool:shutdown-background",
    kind: "tool-result",
    text: "background indexing payload ".repeat(3_000),
    metadata: { toolCallId: "shutdown-background" },
    sourceMessageKeys: ["tool:shutdown-background"],
  };

  const admission = await client.request("store.put", {
    idempotencyKey: "shutdown-background-put",
    document: backgroundDocument,
    retentionClass: "ephemeral-payload",
  }, { retry: false });
  assert.equal(admission.status, "stored");
  await claimed;

  assert.deepEqual(await client.request("daemon.shutdown", { reason: "lifecycle regression" }), {
    accepted: true,
  });
  for (let attempt = 0; attempt < 100 && !runtime.closed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(runtime.closed, true);
  assert.equal(store.isOpen(), true);

  releaseClaim();
  await daemon.close();
  assert.equal(store.isOpen(), false);
  assert.equal(runtime.closing instanceof Promise, true);
  assert.equal(runtime.backgroundErrors.some(({ message }) => /StoreClosedError|store is closed/iu.test(message)), false);
});

test("real daemon operations admit, index, search, recall, preflight, and enforce project scope", async (t) => {
  const { socketPath, runtime } = await runningRuntime(t);
  const project = "/workspace/project";
  const source = document(project, Date.now());
  const client = new StoreClient({ socketPath, project });
  const foreign = new StoreClient({ socketPath, project: "/workspace/foreign" });
  t.after(() => {
    client.close();
    foreign.close();
  });

  const stored = await client.request("store.put", {
    idempotencyKey: "daemon-operation-put-1",
    document: source,
    retentionClass: "conversation-source",
  }, { retry: false });
  assert.equal(stored.status, "stored");

  const found = await client.request("store.search", {
    query: "REAP_DRAIN",
    relation: null,
    scope: "session",
    sessionIds: ["session-1"],
    project,
    limit: 3,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  });
  assert.equal(found.status, "resolved");
  assert.equal(found.results[0].documentId, "turn-1");

  const recalled = await client.request("store.recall", {
    locator: found.results[0].locator,
    neighbors: 1,
    maxTokens: 100,
    sessionIds: ["session-1"],
  });
  assert.equal(recalled.status, "resolved");
  assert.equal(recalled.text, source.text);

  const wrongSession = await client.request("store.recall", {
    locator: found.results[0].locator,
    neighbors: 1,
    maxTokens: 100,
    sessionIds: ["session-2"],
  });
  assert.equal(wrongSession.status, "locator-invalid");

  const projectFound = await client.request("store.search", {
    query: "REAP_DRAIN",
    relation: null,
    scope: "project",
    sessionIds: [],
    project,
    limit: 3,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  });
  const projectRecalled = await client.request("store.recall", {
    locator: projectFound.results[0].locator,
    neighbors: 1,
    maxTokens: 100,
    sessionIds: ["session-2"],
  });
  assert.equal(projectRecalled.status, "resolved");

  const direct = await client.request("store.get", { documentId: "turn-1" });
  assert.equal(direct.status, "resolved");
  assert.equal(direct.document.text, source.text);
  assert.equal((await foreign.request("store.get", { documentId: "turn-1" })).status, "missing");
  await assert.rejects(foreign.request("store.put", {
    idempotencyKey: "foreign-put",
    document: source,
    retentionClass: "conversation-source",
  }, { retry: false }), (error) => error.code === "UNAUTHORIZED");

  const hint = await client.request("store.preflight", {
    messageKey: "user:2",
    message: "What did we decide about REAP_DRAIN?",
    scope: "session",
    sessionId: "session-1",
    sessionIds: ["session-1"],
    project,
    excludeVisibleSourceKeys: ["user:2"],
    hintBudgetTokens: 160,
    epochId: "epoch-1",
    epochBudgetTokens: 640,
  });
  assert.match(hint.modelVisibleText, /ARCHIVED HISTORICAL EVIDENCE/u);

  const removedHints = await client.request("store.remove-hints", {
    sessionId: "session-1",
    messageKeys: ["user:2", "user:missing"],
  });
  assert.deepEqual(removedHints, { removed: 1, notFound: 1 });
  const recreatedHint = await client.request("store.preflight", {
    messageKey: "user:2",
    message: "What did we decide about REAP_DRAIN?",
    scope: "session",
    sessionId: "session-1",
    sessionIds: ["session-1"],
    project,
    excludeVisibleSourceKeys: ["user:2"],
    hintBudgetTokens: 160,
    epochId: "epoch-1",
    epochBudgetTokens: 640,
  });
  assert.deepEqual(recreatedHint, { modelVisibleText: "", hints: [] });

  runtime.recordBackgroundError({ code: "STORE_BUSY", message: "injected background failure" });
  runtime.recordBackgroundError({ code: "DISK_LOW", message: "injected disk pressure" });
  runtime.recordBackgroundError(new Error("x".repeat(9_000)));
  const status = await client.request("daemon.status", {});
  assert.equal(status.ready, true);
  assert.equal(status.counts.documents, 1);
  assert.equal(status.outbox.depth, 0);
  assert.ok(status.index.generation >= 1);
  assert.deepEqual(status.backgroundErrors.slice(0, 2), [
    {
      code: "STORE_BUSY",
      message: "injected background failure",
      retryable: true,
    },
    {
      code: "DISK_LOW",
      message: "injected disk pressure",
      retryable: true,
    },
  ]);
  assert.equal(status.backgroundErrors[2].code, "INTERNAL");
  assert.equal(status.backgroundErrors[2].message.length, MAX_STORE_ERROR_MESSAGE_LENGTH);
  assert.match(status.backgroundErrors[2].message, /…$/u);
});

test("store.get reports ledger-retired exact versions without exposing them across projects", async (t) => {
  const { socketPath, runtime } = await runningRuntime(t);
  const project = "/workspace/retired-get";
  const client = new StoreClient({ socketPath, project });
  const foreign = new StoreClient({ socketPath, project: "/workspace/foreign" });
  t.after(() => {
    client.close();
    foreign.close();
  });
  await client.request("store.put", {
    idempotencyKey: "retired-get-put",
    document: document(project),
    retentionClass: "conversation-source",
  }, { retry: false });
  const foreignActive = await foreign.request("store.get", { documentId: "turn-1" });
  const foreignAbsent = await foreign.request("store.get", { documentId: "never-existed" });
  assert.deepEqual(foreignActive, {
    status: "missing",
    documentId: "turn-1",
    reason: "The requested archived document is unavailable.",
  });
  assert.deepEqual(foreignAbsent, {
    status: "missing",
    documentId: "never-existed",
    reason: "The requested archived document is unavailable.",
  });
  const historyKey = manifestKeys.documentHistory("turn-1");
  await runtime.store.put(historyKey, {
    ...(await runtime.store.get(historyKey)),
    retiredThrough: 1,
  }, { kind: "document-history" });
  await runtime.store.remove(manifestKeys.document("turn-1", 1));

  const retired = await client.request("store.get", { documentId: "turn-1", version: 1 });
  assert.equal(retired.status, "expired");
  assert.match(retired.reason, /retired by retention/u);
  assert.equal((await client.request("store.get", { documentId: "turn-1" })).status, "expired");
  assert.equal((await foreign.request("store.get", {
    documentId: "turn-1",
    version: 1,
  })).status, "missing");
});

test("automatic maintenance schedules background compaction while operator requests stay explicit", async (t) => {
  const { runtime } = await runningRuntime(t);
  let fullCompactions = 0;
  let flushes = 0;
  runtime.store.compact = async () => { fullCompactions += 1; };
  runtime.store.flush = async () => { flushes += 1; };

  const automatic = await runtime.compact({ reason: "deletion-wave" });
  assert.equal(automatic.status, "scheduled");
  assert.equal(fullCompactions, 0);
  assert.equal(flushes, 1);

  const operator = await runtime.compact({ reason: "operator" });
  assert.equal(operator.status, "complete");
  assert.equal(fullCompactions, 1);
  assert.equal(flushes, 2);
});
