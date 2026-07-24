#!/usr/bin/env node
import { resolve } from "node:path";
import {
  garbageCollectObsoleteIndexNamespaces,
  inventoryIndexNamespaces,
} from "../src/rocksdb/index-namespace-maintenance.js";
import { physicalStoreMetrics } from "../src/rocksdb/compaction.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { RocksStore } from "../src/rocksdb/store.js";

const USAGE = `Usage:
  context-window-index-maintenance inventory --store PATH
  context-window-index-maintenance gc --store PATH
  context-window-index-maintenance gc --store PATH --apply --offline [--compact]`;

function argument(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new TypeError(`${name} is required.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires a value.`);
  return value;
}

function totals(rows, active) {
  return rows.filter((row) => row.active === active).reduce((summary, row) => ({
    keyCount: summary.keyCount + row.keyCount,
    keyBytes: summary.keyBytes + row.keyBytes,
    valueBytes: summary.valueBytes + row.valueBytes,
    totalBytes: summary.totalBytes + row.totalBytes,
  }), { keyCount: 0, keyBytes: 0, valueBytes: 0, totalBytes: 0 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = args[0];
  if (!["inventory", "gc"].includes(command)) throw new TypeError(USAGE);
  const storePath = resolve(argument(args, "--store", { required: true }));
  const apply = args.includes("--apply");
  if (apply && command !== "gc") throw new TypeError("--apply is only valid with gc.");
  if (apply && !args.includes("--offline")) {
    throw new TypeError("--offline is required before deleting index namespaces.");
  }
  if (args.includes("--compact") && !apply) {
    throw new TypeError("--compact requires --apply.");
  }
  const store = await RocksStore.open(storePath, {
    readOnly: !apply,
    inspectionOnly: !apply,
    noBlockCache: true,
  });
  try {
    const beforePhysical = apply ? physicalStoreMetrics(store) : undefined;
    const rows = inventoryIndexNamespaces(store);
    const obsolete = totals(rows, false);
    let deletedKeys = 0;
    let logicalDeletedBytes = 0;
    if (apply) {
      let after;
      for (;;) {
        const result = await garbageCollectObsoleteIndexNamespaces(store, {
          reportOnly: false,
          limit: 100_000,
          after,
        });
        deletedKeys += result.deletedKeys;
        logicalDeletedBytes += result.totalBytes;
        if (result.complete) break;
        after = result.nextAfter;
      }
    }
    let compaction;
    if (args.includes("--compact")) {
      await store.compact({ prefix: [KEYSPACE.POSTING] });
      await store.flush();
      const afterPhysical = physicalStoreMetrics(store);
      compaction = {
        before: beforePhysical,
        after: afterPhysical,
        directoryDecreaseBytes: Math.max(
          0,
          beforePhysical.directoryBytes - afterPhysical.directoryBytes,
        ),
        physicalDataDecreaseBytes: Math.max(
          0,
          beforePhysical.physicalDataBytes - afterPhysical.physicalDataBytes,
        ),
      };
    }
    process.stdout.write(`${JSON.stringify({
      command,
      reportOnly: !apply,
      storePath,
      namespaces: rows,
      active: totals(rows, true),
      obsolete,
      deletedKeys,
      logicalDeletedBytes,
      ...(compaction === undefined ? {} : { compaction }),
    }, null, 2)}\n`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
