import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RocksDatabase } from "@harperfast/rocksdb-js";
import {
  decodeKey,
  encodeKey,
  KEYSPACE,
  keyFor,
  prefixBounds,
} from "../src/rocksdb/keys.js";
import {
  CURRENT_SCHEMA,
  decodeRecord,
  encodeRecord,
  schemaMetadata,
  SCHEMA_FINGERPRINT,
} from "../src/rocksdb/schema.js";
import {
  IdempotencyConflictError,
  ImmutableRecordConflictError,
  MAX_ROCKSDB_KEY_BYTES,
  MAX_ROCKSDB_PERSISTED_KEY_BYTES,
  MAX_ROCKSDB_SCAN_BOUND_BYTES,
  RocksStore,
  StoreClosedError,
  StoreKeySizeError,
} from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

test("versioned keys round-trip hostile fields and produce bounded prefixes", () => {
  const parts = [
    KEYSPACE.EVENT,
    "project/with/slashes\0and-nul",
    "雪とemoji-🪨",
    Buffer.from([0, 0xff, 0x2f]),
    Number.MAX_SAFE_INTEGER,
    0xffff_ffff_ffff_ffffn,
    false,
    true,
    null,
  ];
  const encoded = encodeKey(parts);
  assert.deepEqual(decodeKey(encoded), parts);
  assert.deepEqual(decodeKey(encodeKey(["", "\0", "/"])), ["", "\0", "/"]);

  const { start, end } = prefixBounds([KEYSPACE.EVENT, "session"]);
  const child = encodeKey([KEYSPACE.EVENT, "session", "child"]);
  const sibling = encodeKey([KEYSPACE.EVENT, "sessions", "child"]);
  assert.equal(Buffer.compare(child, start) >= 0 && Buffer.compare(child, end) < 0, true);
  assert.equal(Buffer.compare(sibling, start) >= 0 && Buffer.compare(sibling, end) < 0, false);
  assert.throws(() => decodeKey(Buffer.from([99, 1])), /Unsupported key format/u);
  assert.throws(() => encodeKey(["x", -1]), /unsigned 64-bit/u);
});

test("record envelopes are deterministic, binary-safe, and checksummed", () => {
  const left = encodeRecord({ kind: "event", payload: { z: 1, a: [true, null] } });
  const right = encodeRecord({ kind: "event", payload: { a: [true, null], z: 1 } });
  assert.deepEqual(left, right);
  assert.deepEqual(decodeRecord(left).payload, { a: [true, null], z: 1 });

  const binary = Buffer.from([0, 0xff, 1, 2]);
  const decodedBinary = decodeRecord(encodeRecord({ kind: "chunk", payload: binary }));
  assert.equal(decodedBinary.encoding, "bytes");
  assert.deepEqual(decodedBinary.payload, binary);

  const corrupt = Buffer.from(left);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decodeRecord(corrupt), /checksum/u);
});

test("store initialization persists compatible schema metadata", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-schema");
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o755);
  let store = await RocksStore.open(path);
  assert.equal(lstatSync(path).mode & 0o777, 0o700);
  assert.equal(store.status().schema.fingerprint, SCHEMA_FINGERPRINT);
  assert.equal(store.status().bindingVersions["rocksdb-js"], "2.4.0");
  store.close();

  store = await RocksStore.open(path, { readOnly: true });
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.status().schema).filter(([key]) => key !== "createdAt")),
    { ...CURRENT_SCHEMA, fingerprint: SCHEMA_FINGERPRINT },
  );
  store.close();
  await assert.rejects(store.get(keyFor.schema()), StoreClosedError);
});

test("incompatible schema metadata fails closed", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-incompatible-schema");
  const store = await RocksStore.open(path);
  store.close();

  const database = RocksDatabase.open(path, { encoding: "binary", keyEncoding: "binary" });
  try {
    await database.put(
      encodeKey(keyFor.schema()),
      encodeRecord({
        kind: "schema",
        payload: { ...schemaMetadata(), schemaVersion: 999 },
      }),
    );
  } finally {
    database.close();
  }
  await assert.rejects(RocksStore.open(path), /schema version 999 is incompatible/u);
});

test("transactions roll back atomically and snapshots retain their first-read view", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-transactions");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  await store.put([KEYSPACE.DOCUMENT, "visible", 1], { revision: 1 });

  await assert.rejects(store.transaction(async (transaction) => {
    await transaction.put([KEYSPACE.DOCUMENT, "rolled-back", 1], { text: "no" });
    await transaction.put([KEYSPACE.DOCUMENT, "visible", 1], { revision: 99 });
    throw new Error("force rollback");
  }), /force rollback/u);
  assert.equal(await store.get([KEYSPACE.DOCUMENT, "rolled-back", 1]), undefined);
  assert.deepEqual(await store.get([KEYSPACE.DOCUMENT, "visible", 1]), { revision: 1 });

  const snapshot = await store.snapshot(async (view) => {
    const before = await view.get([KEYSPACE.DOCUMENT, "visible", 1]);
    await store.put([KEYSPACE.DOCUMENT, "visible", 1], { revision: 2 });
    const after = await view.get([KEYSPACE.DOCUMENT, "visible", 1]);
    await assert.rejects(view.put([KEYSPACE.DOCUMENT, "forbidden", 1], {}), /read-only/u);
    return { before, after };
  });
  assert.deepEqual(snapshot, { before: { revision: 1 }, after: { revision: 1 } });
  assert.deepEqual(await store.get([KEYSPACE.DOCUMENT, "visible", 1]), { revision: 2 });
});

test("key-only existence checks do not decode values or mistake descendants for records", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "rocksdb-key-only-has"));
  t.after(() => store.close());
  const parent = [KEYSPACE.DOCUMENT, "has-prefix"];
  const child = [...parent, 1];
  await store.put(child, { padding: "x".repeat(2 * 1_024 * 1_024) });

  assert.equal(await store.hasKey(parent), false);
  assert.equal(await store.hasKey(child), true);
  assert.equal(await store.has(child), true);
  await store.transaction(async (transaction) => {
    assert.equal(await transaction.hasKey(parent), false);
    assert.equal(await transaction.hasKey(child), true);
  });
});

test("nested shared writes complete before an already queued exclusive lease", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-shared-reentrancy");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  let enterNested;
  let outerEntered;
  const nestedGate = new Promise((resolve) => { enterNested = resolve; });
  const outerGate = new Promise((resolve) => { outerEntered = resolve; });
  const order = [];
  const outer = store.withSharedWrite(async () => {
    order.push("outer-entered");
    outerEntered();
    await nestedGate;
    await store.transaction((transaction) => transaction.put(
      [KEYSPACE.DOCUMENT, "nested-shared", 1],
      { admitted: true },
    ));
    order.push("nested-complete");
  });
  await outerGate;
  const exclusive = store.withExclusiveWrites(async () => {
    order.push("exclusive-entered");
  });
  enterNested();
  await Promise.race([
    Promise.all([outer, exclusive]),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("nested shared write deadlocked behind its own exclusive waiter")),
        2_000,
      );
      timer.unref();
    }),
  ]);
  assert.deepEqual(order, ["outer-entered", "nested-complete", "exclusive-entered"]);
  assert.deepEqual(await store.get([KEYSPACE.DOCUMENT, "nested-shared", 1]), { admitted: true });
});

test("detached work cannot reuse a released shared lease", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-expired-shared-lease");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  let startDetached;
  const detachedGate = new Promise((resolve) => { startDetached = resolve; });
  let detached;
  await store.withSharedWrite(() => {
    detached = detachedGate.then(() => store.transaction((transaction) => transaction.put(
      [KEYSPACE.DOCUMENT, "detached", 1],
      { admitted: true },
    )));
  });

  let releaseExclusive;
  let exclusiveEntered;
  const exclusiveGate = new Promise((resolve) => { releaseExclusive = resolve; });
  const entered = new Promise((resolve) => { exclusiveEntered = resolve; });
  const exclusive = store.withExclusiveWrites(async () => {
    exclusiveEntered();
    await exclusiveGate;
  });
  await entered;
  let detachedSettled = false;
  detached.finally(() => { detachedSettled = true; });
  startDetached();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detachedSettled, false, "detached work must queue behind the active exclusive lease");
  releaseExclusive();
  await Promise.all([exclusive, detached]);
  assert.deepEqual(await store.get([KEYSPACE.DOCUMENT, "detached", 1]), { admitted: true });
});

test("an already-started unawaited nested write retains the outer shared lease", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-unawaited-shared-descendant");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  let releaseNested;
  let nestedEntered;
  const nestedGate = new Promise((resolve) => { releaseNested = resolve; });
  const entered = new Promise((resolve) => { nestedEntered = resolve; });
  let nested;
  const outer = store.withSharedWrite(() => {
    nested = store.transaction(async (transaction) => {
      nestedEntered();
      await nestedGate;
      await transaction.put(
        [KEYSPACE.DOCUMENT, "unawaited-descendant", 1],
        { overlap: false },
      );
    });
  });
  await entered;

  let exclusiveEntered = false;
  const exclusive = store.withExclusiveWrites(() => {
    exclusiveEntered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exclusiveEntered, false, "exclusive work must wait for the in-flight descendant");

  releaseNested();
  await Promise.all([outer, nested, exclusive]);
  assert.equal(exclusiveEntered, true);
  assert.deepEqual(
    await store.get([KEYSPACE.DOCUMENT, "unawaited-descendant", 1]),
    { overlap: false },
  );
});

test("an already-started unawaited write retains the outer exclusive lease", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-unawaited-exclusive-descendant");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  let releaseNested;
  let nestedEntered;
  const nestedGate = new Promise((resolve) => { releaseNested = resolve; });
  const entered = new Promise((resolve) => { nestedEntered = resolve; });
  let nested;
  let secondExclusiveActive = false;
  let overlap = false;
  const first = store.withExclusiveWrites(() => {
    nested = store.transaction(async (transaction) => {
      nestedEntered();
      await nestedGate;
      overlap = secondExclusiveActive;
      await transaction.put(
        [KEYSPACE.DOCUMENT, "exclusive-descendant", 1],
        { overlap },
      );
    });
  });
  await entered;

  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const second = store.withExclusiveWrites(async () => {
    secondExclusiveActive = true;
    await secondGate;
    secondExclusiveActive = false;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondExclusiveActive, false, "the second exclusive lease must remain queued");

  releaseNested();
  await Promise.all([first, nested]);
  assert.equal(overlap, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondExclusiveActive, true);
  releaseSecond();
  await second;
  assert.deepEqual(
    await store.get([KEYSPACE.DOCUMENT, "exclusive-descendant", 1]),
    { overlap: false },
  );
});

test("transactions can cold-read blob-backed values after restart", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-transaction-blob-restart");
  const key = [KEYSPACE.DOCUMENT, "blob-backed", 1];
  const payload = { text: "transaction restart payload 🪨\n".repeat(32_768) };
  let store = await RocksStore.open(path);
  await store.put(key, payload, { kind: "document" });
  await store.flush();
  await store.compact({ prefix: [KEYSPACE.DOCUMENT] });
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  assert.deepEqual(
    await store.transaction((transaction) => transaction.get(key)),
    payload,
  );
  assert.deepEqual(
    await store.snapshot((snapshot) => snapshot.get(key)),
    payload,
  );
});

test("transactional immutable puts use blocking identity reads", async () => {
  let synchronousReads = 0;
  let synchronousWrites = 0;
  const transaction = {
    get() {
      throw new Error("Result incomplete: no blocking io");
    },
    getSync() {
      synchronousReads += 1;
      return undefined;
    },
    put() {
      throw new Error("transactional immutable writes must use the synchronous path");
    },
    putSync() {
      synchronousWrites += 1;
    },
  };
  const database = {
    isOpen: () => true,
    transaction: async (callback) => callback(transaction, 0),
  };
  const store = new RocksStore("/not-opened/transaction-sync-regression", database);

  assert.equal(
    await store.transaction((view) => view.putImmutable(
      [KEYSPACE.LEASE, "by-id", "cold-lease"],
      { leaseId: "cold-lease" },
    )),
    "inserted",
  );
  assert.equal(synchronousReads, 1);
  assert.equal(synchronousWrites, 1);
});

test("prefix scans preserve binary key order and enforce their cap", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-scans");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  for (const sequence of [3, 1, 2]) {
    await store.put([KEYSPACE.EVENT, "session", sequence], { sequence });
  }
  await store.put([KEYSPACE.EVENT, "other", 1], { sequence: 99 });

  assert.deepEqual(
    store.scan([KEYSPACE.EVENT, "session"]).map(({ payload }) => payload.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    store.scan([KEYSPACE.EVENT, "session"], { reverse: true, limit: 2 }).map(({ payload }) => payload.sequence),
    [3, 2],
  );
  assert.deepEqual(store.scan([KEYSPACE.EVENT], { limit: 0 }), []);
  assert.throws(() => store.scan([KEYSPACE.EVENT], { limit: 100_001 }), /Scan limit/u);

  await store.put([KEYSPACE.EVENT, "nested"], { sequence: 10 });
  await store.put([KEYSPACE.EVENT, "nested", "child"], { sequence: 11 });
  await store.put([KEYSPACE.EVENT, "nested", "child", 1], { sequence: 12 });
  const nested = store.scan([KEYSPACE.EVENT, "nested"], { limit: 1 });
  const nestedSecond = store.scan([KEYSPACE.EVENT, "nested"], {
    after: nested[0].keyBytes,
    limit: 1,
  });
  const nestedThird = store.scan([KEYSPACE.EVENT, "nested"], {
    after: nestedSecond[0].keyBytes,
    limit: 1,
  });
  assert.deepEqual(
    [...nested, ...nestedSecond, ...nestedThird].map(({ payload }) => payload.sequence),
    [10, 11, 12],
  );
  assert.throws(
    () => store.scan([KEYSPACE.EVENT, "nested"], { after: encodeKey([KEYSPACE.DOCUMENT, "outside"]) }),
    /inside the requested prefix/u,
  );
  assert.throws(
    () => store.scan([KEYSPACE.EVENT, "nested"], { after: nested[0].keyBytes, reverse: true }),
    /only supported for forward scans/u,
  );
  const reverseFirst = store.scan([KEYSPACE.EVENT, "nested"], {
    reverse: true,
    limit: 1,
  });
  const reverseSecond = store.scan([KEYSPACE.EVENT, "nested"], {
    reverse: true,
    before: reverseFirst[0].keyBytes,
    limit: 1,
  });
  const reverseThird = store.scan([KEYSPACE.EVENT, "nested"], {
    reverse: true,
    before: reverseSecond[0].keyBytes,
    limit: 1,
  });
  assert.deepEqual(
    [...reverseFirst, ...reverseSecond, ...reverseThird].map(({ payload }) => payload.sequence),
    [12, 11, 10],
  );
  assert.throws(
    () => store.scan([KEYSPACE.EVENT, "nested"], { before: reverseFirst[0].keyBytes }),
    /only supported for reverse scans/u,
  );
});

test("native key limits fail closed before exact, canonical, and prefix operations", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-native-key-limit");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  const oversizedField = "x".repeat(MAX_ROCKSDB_KEY_BYTES);
  const oversizedKey = [KEYSPACE.EVENT, oversizedField];
  const maximumKey = [KEYSPACE.EVENT, "m".repeat(4_080)];
  assert.equal(encodeKey(maximumKey).length, MAX_ROCKSDB_KEY_BYTES);
  assert.equal(await store.get(maximumKey), undefined);
  await store.remove(maximumKey);
  const assertKeyError = (
    error,
    boundary = "key",
    maxBytes = MAX_ROCKSDB_KEY_BYTES,
  ) => {
    assert.equal(error instanceof StoreKeySizeError, true);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.details.boundary, boundary);
    assert.equal(error.details.maxBytes, maxBytes);
    assert.equal(error.details.actualBytes > error.details.maxBytes, true);
    return true;
  };

  await assert.rejects(store.get(oversizedKey), (error) => assertKeyError(error));
  await assert.rejects(store.put(oversizedKey, { rejected: true }), (error) =>
    assertKeyError(error, "persisted key", MAX_ROCKSDB_PERSISTED_KEY_BYTES));
  await assert.rejects(store.putImmutable(oversizedKey, { rejected: true }), (error) =>
    assertKeyError(error, "persisted key", MAX_ROCKSDB_PERSISTED_KEY_BYTES));
  await assert.rejects(store.remove(oversizedKey), (error) => assertKeyError(error));
  assert.throws(
    () => store.scan(oversizedKey),
    (error) => assertKeyError(error, "scan prefix start"),
  );
  await assert.rejects(
    store.compact({ prefix: oversizedKey }),
    (error) => assertKeyError(error, "compaction prefix start"),
  );
  await assert.rejects(store.commitCanonical({
    requestId: "oversized-canonical-key",
    records: [{ key: oversizedKey, payload: { rejected: true } }],
  }), (error) => assertKeyError(error, "canonical key", MAX_ROCKSDB_PERSISTED_KEY_BYTES));
  await assert.rejects(store.commitCanonical({
    requestId: oversizedField,
    records: [{ key: [KEYSPACE.EVENT, "safe"], payload: { rejected: true } }],
  }), (error) =>
    assertKeyError(error, "canonical idempotency key", MAX_ROCKSDB_PERSISTED_KEY_BYTES));
  assert.equal(store.scan([KEYSPACE.EVENT]).length, 0);
});

test("scan bounds enforce the binding's shared key-buffer limit", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-native-scan-bound-limit");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  const largePrefix = [KEYSPACE.EVENT, "p".repeat(2_100)];
  const encodedPrefix = encodeKey(largePrefix);
  assert.equal(encodedPrefix.length < MAX_ROCKSDB_KEY_BYTES, true);
  assert.throws(() => store.scan(largePrefix), (error) => {
    assert.equal(error instanceof StoreKeySizeError, true);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.deepEqual(error.details, {
      actualBytes: encodedPrefix.length * 2,
      boundary: "scan bounds",
      maxBytes: MAX_ROCKSDB_SCAN_BOUND_BYTES,
    });
    return true;
  });

  const prefix = [KEYSPACE.EVENT, "after"];
  const after = encodeKey([...prefix, "a".repeat(4_050)]);
  assert.equal(after.length <= MAX_ROCKSDB_KEY_BYTES, true);
  assert.throws(() => store.scan(prefix, { after }), (error) => {
    assert.equal(error instanceof StoreKeySizeError, true);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.details.boundary, "scan bounds");
    assert.equal(error.details.actualBytes > MAX_ROCKSDB_SCAN_BOUND_BYTES, true);
    return true;
  });
});

test("canonical admission is atomic, immutable, and request-idempotent", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-canonical");
  const store = await RocksStore.open(path);
  t.after(() => store.close());
  const request = {
    requestId: "request/with\0delimiter",
    records: [
      { key: [KEYSPACE.EVENT, "project", "session", 1], kind: "event", payload: { text: "user text" } },
      { key: [KEYSPACE.DOCUMENT, "document-1", 1], kind: "document", payload: { events: [1] } },
    ],
  };

  const first = await store.commitCanonical(request);
  const duplicate = await store.commitCanonical({
    ...request,
    records: [...request.records].reverse(),
  });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.fingerprint, first.fingerprint);
  assert.equal(first.outboxSequence, 1);
  assert.equal(duplicate.outboxSequence, 1);
  assert.equal(store.scan([KEYSPACE.EVENT]).length, 1);
  assert.equal(store.scan([KEYSPACE.DOCUMENT]).length, 1);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 1);
  assert.equal(store.scan([KEYSPACE.OUTBOX])[0].payload.sequence, 1);
  assert.equal(store.scan([KEYSPACE.META, KEYSPACE.IDEMPOTENCY]).length, 1);

  await assert.rejects(store.commitCanonical({
    ...request,
    records: [{ ...request.records[0], payload: { text: "changed retry" } }],
  }), IdempotencyConflictError);
  await assert.rejects(store.commitCanonical({
    requestId: "another-request",
    records: [{ ...request.records[0], payload: { text: "mutated source" } }],
  }), ImmutableRecordConflictError);
});

test("acknowledged canonical writes survive an ungraceful process kill", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-kill-restart");
  const storeUrl = new URL("../src/rocksdb/store.js", import.meta.url).href;
  const source = `
    import { RocksStore } from ${JSON.stringify(storeUrl)};
    const store = await RocksStore.open(process.env.ROCKS_TEST_PATH);
    await store.commitCanonical({
      requestId: "crash-request",
      records: [{ key: ["event", "crash-session", 1], payload: { text: "durable" } }],
    });
    process.stdout.write("ACK\\n", () => {
      if (process.platform === "win32") process.abort();
      else process.kill(process.pid, "SIGKILL");
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ROCKS_TEST_PATH: path },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  assert.match(stdout, /ACK/u, stderr);
  assert.equal(code === null || code !== 0 || signal !== null, true);

  const store = await RocksStore.open(path);
  try {
    assert.deepEqual(await store.get([KEYSPACE.EVENT, "crash-session", 1]), { text: "durable" });
    assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 1);
    const retry = await store.commitCanonical({
      requestId: "crash-request",
      records: [{ key: [KEYSPACE.EVENT, "crash-session", 1], payload: { text: "durable" } }],
    });
    assert.equal(retry.duplicate, true);
  } finally {
    store.close();
  }
});

test("maintenance methods expose properties, flush, compact, and checkpoints", async (t) => {
  const path = temporaryStorePath(t, "rocksdb-maintenance");
  const checkpoint = `${path}-checkpoint`;
  t.after(() => rmSync(checkpoint, { recursive: true, force: true }));
  const store = await RocksStore.open(path, { enableStats: true, parallelismThreads: 2 });
  t.after(() => store.close());
  await store.put([KEYSPACE.CHUNK, "durable"], Buffer.from("chunk"));
  await store.flush();
  await store.compact({ prefix: [KEYSPACE.CHUNK] });
  const properties = store.properties();
  assert.equal(Number.isSafeInteger(properties.estimatedKeys), true);
  assert.equal(typeof properties.levelStats, "string");
  await store.createCheckpoint(checkpoint);

  const copy = await RocksStore.open(checkpoint, { readOnly: true });
  try {
    assert.deepEqual(await copy.get([KEYSPACE.CHUNK, "durable"]), Buffer.from("chunk"));
  } finally {
    copy.close();
  }
});
