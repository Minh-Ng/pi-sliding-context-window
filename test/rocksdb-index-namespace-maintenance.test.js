import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  garbageCollectObsoleteIndexNamespaces,
  indexNamespaceKeys,
  inventoryIndexNamespaces,
} from "../src/rocksdb/index-namespace-maintenance.js";
import { auxiliaryOwnershipIndexKeys } from "../src/rocksdb/auxiliary-ownership.js";
import { derivedViewKeys } from "../src/rocksdb/derived-view.js";
import { BM25_INDEX_VERSION } from "../src/rocksdb/index/bm25-keys.js";
import { BM25_TOKENIZER_VERSION } from "../src/rocksdb/index/tokenizer.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-index-namespace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("index namespace inventory and report-only GC measure unreachable versioned roots", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const active = [
    KEYSPACE.POSTING,
    "bm25",
    BM25_INDEX_VERSION,
    BM25_TOKENIZER_VERSION,
    "term",
    "/workspace/index-gc",
    "active",
  ];
  const obsolete = [
    KEYSPACE.POSTING,
    "bm25",
    BM25_INDEX_VERSION - 1,
    BM25_TOKENIZER_VERSION,
    "term",
    "/workspace/index-gc",
    "obsolete",
  ];
  const unknown = [KEYSPACE.POSTING, "future-family", 1, 1, "record"];
  await store.put(active, { state: "active" }, { kind: "test-index-record" });
  await store.put(obsolete, { state: "obsolete" }, { kind: "test-index-record" });
  await store.put(unknown, { state: "unknown" }, { kind: "test-index-record" });

  const inventory = inventoryIndexNamespaces(store);
  assert.equal(inventory.find(({ version }) => version === BM25_INDEX_VERSION).active, true);
  const obsoleteInventory = inventory.find(({ version }) => version === BM25_INDEX_VERSION - 1);
  assert.equal(obsoleteInventory.active, false);
  assert.equal(obsoleteInventory.keyCount, 1);
  assert.ok(obsoleteInventory.totalBytes > 0);

  const report = await garbageCollectObsoleteIndexNamespaces(store, {
    reportOnly: true,
    limit: 100,
  });
  assert.equal(report.keyCount, 1);
  assert.equal(report.deletedKeys, 0);
  assert.ok(report.totalBytes > 0);
  assert.deepEqual(await store.get(obsolete), { state: "obsolete" });

  const deleted = await garbageCollectObsoleteIndexNamespaces(store, {
    reportOnly: false,
    limit: 100,
  });
  assert.equal(deleted.deletedKeys, 1);
  assert.equal(await store.get(obsolete), undefined);
  assert.deepEqual(await store.get(active), { state: "active" });
  assert.deepEqual(await store.get(unknown), { state: "unknown" });
});

test("namespace deletion fails closed when the active-reader manifest is stale", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const obsolete = [
    KEYSPACE.POSTING,
    "bm25",
    BM25_INDEX_VERSION - 1,
    BM25_TOKENIZER_VERSION,
    "term",
    "/workspace/index-gc",
    "obsolete",
  ];
  await store.put(obsolete, { state: "obsolete" }, { kind: "test-index-record" });
  await store.put(indexNamespaceKeys.manifest(), {
    manifestVersion: 1,
    active: [],
    fingerprint: "stale",
    updatedAt: 0,
  }, { kind: "active-index-namespace-manifest" });

  await assert.rejects(
    garbageCollectObsoleteIndexNamespaces(store, { reportOnly: false }),
    { code: "ERR_INDEX_NAMESPACE_MANIFEST" },
  );
  assert.deepEqual(await store.get(obsolete), { state: "obsolete" });
});

test("read-only inspection inventories a legacy store without running unrelated upgrades", async (t) => {
  const path = join(temporaryDirectory(t), "archive.rocks");
  let store = await RocksStore.open(path);
  const obsolete = [
    KEYSPACE.POSTING,
    "bm25",
    BM25_INDEX_VERSION - 1,
    BM25_TOKENIZER_VERSION,
    "term",
    "/workspace/index-gc",
    "obsolete",
  ];
  await store.put(obsolete, { state: "obsolete" }, { kind: "test-index-record" });
  await store.remove(auxiliaryOwnershipIndexKeys.state());
  await store.remove(derivedViewKeys.upgradeState());
  store.close();

  await assert.rejects(
    RocksStore.open(path, { readOnly: true }),
    /requires a writable auxiliary ownership upgrade/u,
  );
  store = await RocksStore.open(path, {
    readOnly: true,
    inspectionOnly: true,
    noBlockCache: true,
  });
  t.after(() => store.close());
  const inventory = inventoryIndexNamespaces(store);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].active, false);
  assert.equal(inventory[0].keyCount, 1);
});
