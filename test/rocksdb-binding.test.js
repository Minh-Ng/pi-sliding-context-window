import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RocksDatabase, versions } from "@harperfast/rocksdb-js";

const BINARY_OPTIONS = Object.freeze({ encoding: "binary", keyEncoding: "binary" });

function temporaryDatabase(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

test("the pinned native binding loads on the supported Node runtime", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.equal(major >= 24 || (major === 22 && minor >= 19), true);
  assert.equal(versions["rocksdb-js"], "2.4.0");
  assert.match(versions.rocksdb, /^\d+\.\d+\.\d+$/u);
});

test("transactions, binary ranges, properties, flush, compaction, and restart work", async (t) => {
  const path = temporaryDatabase(t, "rocksdb-binding");
  let database = RocksDatabase.open(path, { ...BINARY_OPTIONS, enableStats: true });
  assert.equal(database.isOpen(), true);
  assert.deepEqual(database.columns, ["default"]);

  const keys = [Buffer.from([1, 0]), Buffer.from([1, 1]), Buffer.from([2, 0])];
  await database.transaction(async (transaction) => {
    await transaction.put(keys[0], Buffer.from("zero"));
    await transaction.put(keys[1], Buffer.from("one"));
  });
  await assert.rejects(database.transaction(async (transaction) => {
    await transaction.put(keys[2], Buffer.from("rollback"));
    throw new Error("abort transaction");
  }), /abort transaction/u);

  const range = [...database.getRange({ start: Buffer.from([1]), end: Buffer.from([2]) })];
  assert.deepEqual(range.map(({ key }) => Buffer.from(key)), keys.slice(0, 2));
  assert.deepEqual(range.map(({ value }) => Buffer.from(value).toString()), ["zero", "one"]);
  assert.equal(await database.get(keys[2]), undefined);
  assert.equal(typeof database.getDBIntProperty("rocksdb.estimate-num-keys"), "number");
  assert.equal(typeof database.getDBProperty("rocksdb.levelstats"), "string");
  await database.flush();
  await database.compact({ start: Buffer.from([1]), end: Buffer.from([2]) });
  database.close();

  database = RocksDatabase.open(path, BINARY_OPTIONS);
  assert.equal(Buffer.from(await database.get(keys[1])).toString(), "one");
  database.close();
});

test("column families isolate values but are not used for canonical atomic writes", async (t) => {
  const path = temporaryDatabase(t, "rocksdb-columns");
  const primary = RocksDatabase.open(path, BINARY_OPTIONS);
  const secondary = RocksDatabase.open(path, { ...BINARY_OPTIONS, name: "binding-probe" });
  try {
    assert.deepEqual([...primary.columns].sort(), ["binding-probe", "default"]);
    await primary.put(Buffer.from("same-key"), Buffer.from("primary"));
    await secondary.put(Buffer.from("same-key"), Buffer.from("secondary"));
    assert.equal(Buffer.from(await primary.get(Buffer.from("same-key"))).toString(), "primary");
    assert.equal(Buffer.from(await secondary.get(Buffer.from("same-key"))).toString(), "secondary");
  } finally {
    secondary.close();
    primary.close();
  }
});

test("the binding can concurrently write one database from worker threads", async (t) => {
  const path = temporaryDatabase(t, "rocksdb-workers");
  const bindingUrl = import.meta.resolve("@harperfast/rocksdb-js");
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { RocksDatabase } from ${JSON.stringify(bindingUrl)};
    const database = RocksDatabase.open(workerData.path, { encoding: "binary", keyEncoding: "binary" });
    await database.put(Buffer.from([workerData.index]), Buffer.from(String(workerData.index)));
    database.close();
    parentPort.postMessage("ok");
  `;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  const writes = Array.from({ length: 4 }, (_, offset) => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      type: "module",
      workerData: { path, index: offset + 1 },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  }));
  assert.deepEqual(await Promise.all(writes), ["ok", "ok", "ok", "ok"]);

  const database = RocksDatabase.open(path, BINARY_OPTIONS);
  try {
    assert.equal([...database.getRange()].length, 4);
  } finally {
    database.close();
  }
});
