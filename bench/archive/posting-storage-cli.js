#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBm25IndexHandler, searchBm25 } from "../../src/rocksdb/index/bm25.js";
import { bm25Keys } from "../../src/rocksdb/index/bm25-keys.js";
import {
  exactKeys,
  createExactIndexHandler,
  lookupExact,
} from "../../src/rocksdb/index/exact.js";
import {
  decodeBm25PostingBlock,
  decodeExactPostingBlock,
  isPostingBlock,
} from "../../src/rocksdb/index/posting-block.js";
import {
  decodePostingLocator,
  isPostingLocator,
  POSTING_LOCATOR_KIND,
} from "../../src/rocksdb/index/posting-locator.js";
import { IndexWorker } from "../../src/rocksdb/indexer.js";
import { KEYSPACE } from "../../src/rocksdb/keys.js";
import { admitDocument } from "../../src/rocksdb/manifests.js";
import {
  rewriteBm25CanonicalPostingBlocks,
  rewriteBm25SessionPostingLocators,
  rewriteExactCanonicalPostingBlocks,
  rewriteExactFoldedPostingLocators,
} from "../../src/rocksdb/posting-storage-maintenance.js";
import { RocksStore } from "../../src/rocksdb/store.js";

const PROJECT = "/fixture/posting-storage";
const SESSION = "posting-storage-session";

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summary(samples) {
  return Object.freeze({
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maximumMs: Number(Math.max(...samples).toFixed(3)),
  });
}

function logicalPostingBytes(store) {
  const prefixes = [
    bm25Keys.postingRoot(),
    bm25Keys.sessionPostingRoot(),
    [KEYSPACE.EXACT],
  ];
  return prefixes.reduce((total, prefix) => total + store.scan(prefix, {
    limit: 100_000,
    fillCache: false,
  }).reduce((bytes, record) => bytes + record.storedValueBytes, 0), 0);
}

async function admitFixture(store, documents) {
  for (let index = 0; index < documents; index += 1) {
    await admitDocument(store, {
      idempotencyKey: `posting-storage:${index}`,
      retentionClass: "conversation-source",
      document: {
        documentId: `posting-storage-${index}`,
        version: 1,
        sourceKey: `assistant:posting-storage-${index}`,
        sourceMessageKeys: [`assistant:posting-storage-${index}`],
        sessionId: SESSION,
        project: PROJECT,
        kind: "turn",
        createdAt: 1_700_000_000_000 + index,
        text: `BenchSymbol${index} records UniqueSignal${index} for compact posting latency evidence.`,
        metadata: { turnId: `posting-storage-turn-${index}` },
      },
    }, {
      windows: { windowTokens: 100, overlapTokens: 0 },
    });
  }
  const worker = new IndexWorker(store, {
    workerId: "benchmark:posting-storage",
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  const drained = await worker.drain({
    limit: Math.max(64, documents + 1),
    maxDrainMs: 60_000,
    throwOnError: true,
  });
  assert.equal(drained.processed, documents);
}

async function expandLegacyLayout(store) {
  const canonicalBm25 = store.scan(bm25Keys.postingRoot(), { limit: 100_000 });
  for (const record of canonicalBm25) {
    const payload = isPostingBlock(record.payload)
      ? decodeBm25PostingBlock(record.payload)
      : record.payload;
    await store.put(record.keyBytes, payload, { kind: "bm25-posting" });
  }
  for (const record of store.scan(bm25Keys.sessionPostingRoot(), { limit: 100_000 })) {
    if (!isPostingLocator(record.payload)) continue;
    const locator = decodePostingLocator(
      record.payload,
      POSTING_LOCATOR_KIND.BM25_SESSION,
    );
    const payload = await store.get(locator.targets[0]);
    await store.put(record.keyBytes, payload, { kind: "bm25-session-posting" });
  }

  const exact = store.scan([KEYSPACE.EXACT], { limit: 100_000 });
  for (const record of exact) {
    if (record.key.length !== 10 || record.key[2] !== "exact") continue;
    const payload = isPostingBlock(record.payload)
      ? decodeExactPostingBlock(record.payload)
      : record.payload;
    await store.put(record.keyBytes, payload, { kind: "exact-posting" });
  }
  for (const record of exact) {
    if (record.key.length !== 10 || record.key[2] !== "folded"
      || !isPostingLocator(record.payload)) continue;
    const locator = decodePostingLocator(
      record.payload,
      POSTING_LOCATOR_KIND.EXACT_FOLDED,
    );
    const targets = [];
    for (const target of locator.targets) {
      const payload = await store.get(target);
      if (payload !== undefined) targets.push(payload);
    }
    if (targets.length === 0) continue;
    const first = targets[0];
    await store.put(record.keyBytes, {
      ...first,
      caseMode: "folded",
      normalizedTerm: record.key[3],
      matches: targets.flatMap(({ matches }) => matches),
    }, { kind: "exact-posting" });
  }
}

async function migrateCompactLayout(store) {
  await rewriteBm25SessionPostingLocators(store, { reportOnly: false, limit: 100_000 });
  await rewriteBm25CanonicalPostingBlocks(store, { reportOnly: false, limit: 100_000 });
  await rewriteExactFoldedPostingLocators(store, { reportOnly: false, limit: 100_000 });
  await rewriteExactCanonicalPostingBlocks(store, { reportOnly: false, limit: 100_000 });
}

async function stabilizePostingLayout(store) {
  await store.flush();
  await store.compact({ prefix: [KEYSPACE.POSTING] });
  await store.compact({ prefix: [KEYSPACE.EXACT] });
}

async function queryFixture(store, queryIndices, repetitions) {
  const samples = [];
  const identities = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const index of queryIndices) {
      const startedAt = performance.now();
      const exact = await lookupExact(store, {
        query: `BenchSymbol${index}`,
        project: PROJECT,
        scope: "project",
        limit: 3,
      });
      const lexical = await searchBm25(store, {
        query: `UniqueSignal${index}`,
        project: PROJECT,
        scope: "project",
        limit: 3,
      });
      samples.push(performance.now() - startedAt);
      identities.push([
        exact.results.map(({ documentId }) => documentId),
        lexical.results.map(({ documentId }) => documentId),
      ]);
    }
  }
  return { samples, identities };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: node bench/archive/posting-storage-cli.js [--documents N] [--repetitions N]\n",
    );
    return;
  }
  const documentsIndex = args.indexOf("--documents");
  const repetitionsIndex = args.indexOf("--repetitions");
  const documents = positiveInteger(
    documentsIndex < 0 ? 128 : args[documentsIndex + 1],
    "--documents",
  );
  const repetitions = positiveInteger(
    repetitionsIndex < 0 ? 20 : args[repetitionsIndex + 1],
    "--repetitions",
  );
  if (documents > 1_000) throw new RangeError("--documents must not exceed 1000.");
  const root = mkdtempSync(join(tmpdir(), "context-window-posting-benchmark-"));
  const store = await RocksStore.open(join(root, "archive.rocks"));
  try {
    await admitFixture(store, documents);
    await expandLegacyLayout(store);
    await stabilizePostingLayout(store);
    const queryIndices = Array.from(
      { length: Math.min(16, documents) },
      (_, index) => Math.floor(index * documents / Math.min(16, documents)),
    );
    await queryFixture(store, queryIndices, 1);
    const legacyBytes = logicalPostingBytes(store);
    const legacy = await queryFixture(store, queryIndices, repetitions);

    await migrateCompactLayout(store);
    await stabilizePostingLayout(store);
    await queryFixture(store, queryIndices, 1);
    const compactBytes = logicalPostingBytes(store);
    const compact = await queryFixture(store, queryIndices, repetitions);
    assert.deepEqual(compact.identities, legacy.identities);
    const legacyLatency = summary(legacy.samples);
    const compactLatency = summary(compact.samples);
    const sizeRatio = compactBytes / legacyBytes;
    const medianLatencyRatio = compactLatency.medianMs / legacyLatency.medianMs;
    const p95LatencyRatio = compactLatency.p95Ms / legacyLatency.p95Ms;
    const latencyTolerance = 1.1;

    const latencyPassed = medianLatencyRatio <= latencyTolerance
      && p95LatencyRatio <= latencyTolerance;
    process.stdout.write(`${JSON.stringify({
      fixture: { documents, repetitions, queriesPerRepetition: queryIndices.length },
      legacy: {
        logicalPostingValueBytes: legacyBytes,
        latency: legacyLatency,
      },
      compact: {
        logicalPostingValueBytes: compactBytes,
        latency: compactLatency,
      },
      comparison: {
        savedBytes: legacyBytes - compactBytes,
        sizeRatio: Number(sizeRatio.toFixed(4)),
        medianLatencyRatio: Number(medianLatencyRatio.toFixed(4)),
        p95LatencyRatio: Number(p95LatencyRatio.toFixed(4)),
        identicalResults: true,
      },
      gates: {
        size: sizeRatio < 1 ? "passed" : "failed",
        resultIdentity: "passed",
        latency: latencyPassed ? "passed" : "failed",
        latencyTolerance,
      },
    }, null, 2)}\n`);
    if (sizeRatio >= 1 || !latencyPassed) process.exitCode = 1;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
