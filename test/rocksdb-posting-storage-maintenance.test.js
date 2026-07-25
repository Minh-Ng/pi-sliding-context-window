import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonMaintenance } from "../src/daemon/maintenance.js";
import { exactKeys } from "../src/rocksdb/index/exact.js";
import { bm25Keys } from "../src/rocksdb/index/bm25-keys.js";
import {
  createBm25IndexHandler,
  searchBm25,
} from "../src/rocksdb/index/bm25.js";
import {
  decodePostingLocator,
  isPostingLocator,
  POSTING_LOCATOR_KIND,
} from "../src/rocksdb/index/posting-locator.js";
import {
  decodeBm25PostingBlock,
  decodeExactPostingBlock,
  isPostingBlock,
} from "../src/rocksdb/index/posting-block.js";
import {
  garbageCollectReverseCleanupReferences,
  runPostingStorageMaintenance,
  rewriteBm25CanonicalPostingBlocks,
  rewriteBm25SessionPostingLocators,
  rewriteExactCanonicalPostingBlocks,
  rewriteExactFoldedPostingLocators,
} from "../src/rocksdb/posting-storage-maintenance.js";
import { derivedKeys } from "../src/rocksdb/derived.js";
import { derivedViewKeys } from "../src/rocksdb/derived-view.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { encodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { retentionKeys, runRetention } from "../src/rocksdb/retention.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-posting-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function bm25PostingFixture({
  project = "/workspace/posting",
  sessionId = "session",
  documentId = "document",
} = {}) {
  const canonicalKey = bm25Keys.posting(
    project,
    "term",
    1,
    100,
    documentId,
    1,
    1,
    0,
  );
  const sessionKey = bm25Keys.sessionPosting(
    project,
    sessionId,
    "term",
    1,
    100,
    documentId,
    1,
    1,
    0,
  );
  return {
    canonicalKey,
    sessionKey,
    posting: {
      bm25PostingVersion: 3,
      tokenizerVersion: 4,
      generation: 1,
      project,
      term: "term",
      sessionId,
      documentId,
      documentVersion: 1,
      kind: "turn",
      createdAt: 100,
      bucket: 1,
      sourceMessageKeys: [`user:${documentId}`],
      turnId: null,
      window: {
        ordinal: 0,
        startByte: 0,
        endByte: 20,
        length: 20,
        weightedLength: 20,
        termFrequency: 1,
        weightedTermFrequency: 1,
        positionsEncoding: "delta-v1",
        positionDeltas: [3],
      },
    },
  };
}

test("BM25 session posting migration reports and rewrites duplicate values as binary locators", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const canonicalKey = bm25Keys.posting(
    "/workspace/posting",
    "term",
    1,
    100,
    "document",
    1,
    1,
    0,
  );
  const sessionKey = bm25Keys.sessionPosting(
    "/workspace/posting",
    "session",
    "term",
    1,
    100,
    "document",
    1,
    1,
    0,
  );
  const duplicate = {
    bm25PostingVersion: 3,
    tokenizerVersion: 4,
    generation: 1,
    project: "/workspace/posting",
    term: "term",
    sessionId: "session",
    documentId: "document",
    documentVersion: 1,
    kind: "turn",
    createdAt: 100,
    bucket: 1,
    sourceMessageKeys: ["user:document", `tool:${"x".repeat(2_000)}`],
    turnId: null,
    window: {
      ordinal: 0,
      startByte: 0,
      endByte: 20,
      length: 20,
      weightedLength: 20,
      termFrequency: 1,
      weightedTermFrequency: 1,
      positionsEncoding: "delta-v1",
      positionDeltas: [3],
    },
  };
  await store.put(canonicalKey, duplicate, { kind: "bm25-posting" });
  await store.put(sessionKey, duplicate, { kind: "bm25-session-posting" });

  const report = await rewriteBm25SessionPostingLocators(store, {
    reportOnly: true,
    limit: 100,
  });
  assert.equal(report.rewrittenKeys, 1);
  assert.ok(report.valueBytesSaved > 1_000);
  assert.equal(isPostingLocator(await store.get(sessionKey)), false);

  const migration = await rewriteBm25SessionPostingLocators(store, {
    reportOnly: false,
    limit: 100,
  });
  assert.equal(migration.rewrittenKeys, 1);
  const locator = decodePostingLocator(
    await store.get(sessionKey),
    POSTING_LOCATOR_KIND.BM25_SESSION,
  );
  assert.equal(locator.targets.length, 1);
  assert.deepEqual(await store.get(locator.targets[0]), duplicate);

  const blockReport = await rewriteBm25CanonicalPostingBlocks(store, {
    reportOnly: true,
    limit: 100,
  });
  assert.equal(blockReport.rewrittenKeys, 1);
  assert.ok(blockReport.valueBytesSaved > 100);
  await rewriteBm25CanonicalPostingBlocks(store, { reportOnly: false, limit: 100 });
  const block = await store.get(canonicalKey);
  assert.equal(isPostingBlock(block), true);
  assert.deepEqual(decodeBm25PostingBlock(block), duplicate);
});

test("BM25 session posting migration skips missing canonical postings only with durable retirement evidence", async (t) => {
  const cases = [
    {
      name: "supersession marker",
      prepare: (store, fixture) => store.put(
        [KEYSPACE.SUPERSESSION, fixture.posting.documentId, 1],
        {
          documentId: fixture.posting.documentId,
          documentVersion: 1,
          status: "expired",
          reason: "test retirement",
          recordedAt: 200,
        },
        { kind: "supersession" },
      ),
    },
    {
      name: "document history",
      prepare: (store, fixture) => store.put(
        [KEYSPACE.META, "document-history", fixture.posting.documentId],
        {
          documentHistoryFormatVersion: 1,
          documentId: fixture.posting.documentId,
          project: fixture.posting.project,
          highestAdmittedVersion: 1,
          retiredThrough: 1,
        },
        { kind: "document-history" },
      ),
    },
    {
      name: "ordinal tombstone",
      prepare: async (store, fixture) => {
        await store.put(
          derivedViewKeys.document(fixture.posting.project, fixture.posting.documentId, 1),
          {
            documentOrdinalFormatVersion: 1,
            project: fixture.posting.project,
            documentId: fixture.posting.documentId,
            documentVersion: 1,
            ordinal: 1,
          },
          { kind: "derived-view-document" },
        );
        await store.put(
          derivedViewKeys.tombstone(fixture.posting.project, 1),
          {
            documentOrdinalFormatVersion: 1,
            project: fixture.posting.project,
            ordinal: 1,
            documentId: fixture.posting.documentId,
            documentVersion: 1,
            status: "expired",
            recordedAt: 200,
          },
          { kind: "derived-view-tombstone" },
        );
      },
    },
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async (subtest) => {
      const store = await RocksStore.open(join(temporaryDirectory(subtest), "archive.rocks"));
      subtest.after(() => store.close());
      const fixture = bm25PostingFixture({
        project: `/workspace/${candidate.name.replaceAll(" ", "-")}`,
        documentId: `document-${candidate.name.replaceAll(" ", "-")}`,
      });
      await store.put(fixture.sessionKey, fixture.posting, { kind: "bm25-session-posting" });
      await candidate.prepare(store, fixture);

      const report = await rewriteBm25SessionPostingLocators(store, {
        reportOnly: true,
        limit: 100,
      });
      assert.equal(report.rewrittenKeys, 0);
      assert.equal(report.unresolvedKeys, 1);

      const migration = await rewriteBm25SessionPostingLocators(store, {
        reportOnly: false,
        limit: 100,
      });
      assert.equal(migration.rewrittenKeys, 0);
      assert.equal(migration.unresolvedKeys, 1);
      assert.deepEqual(await store.get(fixture.sessionKey), fixture.posting);
    });
  }
});

test("BM25 session posting migration still rejects missing live canonical postings", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const fixture = bm25PostingFixture({ documentId: "live-orphan" });
  await store.put(fixture.sessionKey, fixture.posting, { kind: "bm25-session-posting" });

  for (const reportOnly of [true, false]) {
    await assert.rejects(
      rewriteBm25SessionPostingLocators(store, { reportOnly, limit: 100 }),
      /A BM25 session posting has no canonical project posting/u,
    );
  }
  assert.deepEqual(await store.get(fixture.sessionKey), fixture.posting);
});

test("BM25 session posting migration does not create a locator when retention wins the rewrite race", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const fixture = bm25PostingFixture({ documentId: "retention-race" });
  await store.put(fixture.canonicalKey, fixture.posting, { kind: "bm25-posting" });
  await store.put(fixture.sessionKey, fixture.posting, { kind: "bm25-session-posting" });

  const originalTransaction = store.transaction.bind(store);
  store.transaction = async (...arguments_) => {
    store.transaction = originalTransaction;
    await store.remove(fixture.canonicalKey);
    await store.put(
      [KEYSPACE.SUPERSESSION, fixture.posting.documentId, 1],
      {
        documentId: fixture.posting.documentId,
        documentVersion: 1,
        status: "expired",
        reason: "retention won the migration race",
        recordedAt: 200,
      },
      { kind: "supersession" },
    );
    return originalTransaction(...arguments_);
  };

  const migration = await rewriteBm25SessionPostingLocators(store, {
    reportOnly: false,
    limit: 100,
  });
  assert.equal(migration.rewrittenKeys, 0);
  assert.equal(migration.unresolvedKeys, 1);
  assert.deepEqual(await store.get(fixture.sessionKey), fixture.posting);
});

test("BM25 session posting migration tolerates normal bounded retention between canonical and session cleanup", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const project = "/workspace/partial-retention";
  const sessionId = "partial-retention-session";
  const documentId = "partial-retention-document";
  const terms = Array.from(
    { length: 40 },
    (_, index) => `orphanterm${String(index).padStart(3, "0")}`,
  );
  await admitDocument(store, {
    idempotencyKey: "posting-storage:partial-retention",
    retentionClass: "conversation-source",
    expiresAt: 100,
    document: {
      documentId,
      version: 1,
      sourceKey: "assistant:partial-retention",
      sourceMessageKeys: ["assistant:partial-retention"],
      sessionId,
      project,
      kind: "turn",
      createdAt: 10,
      text: terms.join(" "),
      metadata: { turnId: "turn-partial-retention" },
    },
  }, {
    windows: { windowTokens: 100, overlapTokens: 0 },
  });
  const worker = new IndexWorker(store, {
    workerId: "posting-storage:partial-retention",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);

  const sessionRecords = store.scan(bm25Keys.sessionPostingRoot(), { limit: 1_000 });
  assert.ok(sessionRecords.length >= terms.length);
  for (const record of sessionRecords) {
    const locator = decodePostingLocator(record.payload, POSTING_LOCATOR_KIND.BM25_SESSION);
    const canonical = await store.get(locator.targets[0]);
    assert.equal(isPostingBlock(canonical), true);
    const legacyPosting = decodeBm25PostingBlock(canonical);
    await store.put(
      locator.targets[0],
      legacyPosting,
      { kind: "bm25-posting" },
    );
    await store.put(
      record.keyBytes,
      legacyPosting,
      { kind: "bm25-session-posting" },
    );
    await store.put(
      derivedKeys.reference(documentId, 1, record.keyBytes),
      {
        documentId,
        documentVersion: 1,
        targetKey: record.keyBytes.toString("base64url"),
      },
      { kind: "derived-document-reference" },
    );
    await store.put(
      derivedKeys.reference(documentId, 1, locator.targets[0]),
      {
        documentId,
        documentVersion: 1,
        targetKey: locator.targets[0].toString("base64url"),
      },
      { kind: "derived-document-reference" },
    );
  }

  const missingCanonical = async () => {
    const missing = [];
    for (const record of store.scan(bm25Keys.sessionPostingRoot(), { limit: 1_000 })) {
      if (isPostingLocator(record.payload) || record.payload?.documentId !== documentId) continue;
      const posting = record.payload;
      const canonicalKey = bm25Keys.posting(
        posting.project,
        posting.term,
        posting.bucket,
        posting.createdAt,
        posting.documentId,
        posting.documentVersion,
        posting.generation,
        posting.window.ordinal,
      );
      if (await store.get(canonicalKey) === undefined) missing.push(record);
    }
    return missing;
  };

  let partial = [];
  let lastRetention;
  for (let wave = 0; wave < 1_000 && partial.length === 0; wave += 1) {
    lastRetention = await runRetention(
      store,
      { now: 200, force: false, batchSize: 1 },
      { workLimit: 3 },
    );
    partial = await missingCanonical();
    if (lastRetention.status === "complete") break;
  }
  assert.ok(
    partial.length > 0,
    `retention must expose the partial derived-cleanup state: ${JSON.stringify({
      lastRetention,
      cleanup: await store.get(retentionKeys.cleanup(documentId, 1)),
      sessions: store.scan(bm25Keys.sessionPostingRoot(), { limit: 1_000 }).length,
      references: store.scan(derivedKeys.prefix(documentId, 1), { limit: 1_000 }).length,
    })}`,
  );
  assert.equal((await store.get([KEYSPACE.SUPERSESSION, documentId, 1])).status, "expired");
  assert.equal((await searchBm25(store, {
    query: terms[0],
    project,
    scope: "session",
    sessionId,
  })).results.length, 0);

  const migration = await rewriteBm25SessionPostingLocators(store, {
    reportOnly: false,
    limit: 1_000,
  });
  assert.ok(migration.unresolvedKeys >= partial.length);

  let retention;
  for (let wave = 0; wave < 10; wave += 1) {
    retention = await runRetention(
      store,
      { now: 200, force: false, batchSize: 100 },
      { workLimit: 100_000 },
    );
    if (retention.status === "complete") break;
  }
  assert.equal(retention.status, "complete");
  assert.equal(
    store.scan(bm25Keys.sessionPostingRoot(), { limit: 1_000 })
      .some(({ payload }) => payload?.documentId === documentId),
    false,
  );
  assert.equal(store.scan(derivedKeys.prefix(documentId, 1), { limit: 1 }).length, 0);
  assert.equal((await store.get(retentionKeys.cleanup(documentId, 1))).status, "complete");
});

test("daemon maintenance starts when a retired legacy BM25 session posting has already lost its canonical target", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const fixture = bm25PostingFixture({ documentId: "startup-retired-orphan" });
  await store.put(fixture.sessionKey, fixture.posting, { kind: "bm25-session-posting" });
  await store.put(
    [KEYSPACE.SUPERSESSION, fixture.posting.documentId, 1],
    {
      documentId: fixture.posting.documentId,
      documentVersion: 1,
      status: "expired",
      reason: "partial retention before daemon restart",
      recordedAt: 150,
    },
    { kind: "supersession" },
  );
  await store.put(
    [KEYSPACE.META, "posting-storage-migration"],
    {
      migrationVersion: 2,
      status: "running",
      phase: "bm25-session-locators",
      after: null,
      startedAt: 100,
      updatedAt: 100,
      rollbackGraceMs: 1_000,
      scannedKeys: 0,
      rewrittenKeys: 0,
      unresolvedKeys: 0,
      deletedKeys: 0,
      logicalBytesSaved: 0,
    },
    { kind: "posting-storage-migration-state" },
  );
  const maintenance = new DaemonMaintenance(store, {
    intervalMs: 1_000_000,
    postingStorageLimit: 100,
    criticalFreeBytes: 0,
    now: () => 200,
    readFreeBytes: () => 1_000_000,
    updateEmergencyMode: async () => {},
    cleanupProtections: async () => ({ scanned: 0, released: 0, more: false }),
    cleanupLeases: async () => ({ scanned: 0, removed: 0, more: false }),
    cleanupHints: async () => ({ scanned: 0, removed: 0, rescheduled: 0 }),
    runRetention: async () => ({
      status: "complete",
      scanned: 0,
      tombstoned: 0,
      deletedKeys: 0,
      protected: 0,
    }),
    compact: async () => ({ status: "complete" }),
  });
  t.after(() => maintenance.close());

  await assert.doesNotReject(maintenance.initialize());
  const state = await store.get([KEYSPACE.META, "posting-storage-migration"]);
  assert.equal(state.phase, "bm25-canonical-blocks");
  assert.equal(state.unresolvedKeys, 1);
  assert.deepEqual(await store.get(fixture.sessionKey), fixture.posting);
});

test("posting migration advances past full pages of retired BM25 orphans without recounting them", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const first = bm25PostingFixture({
    sessionId: "session-a",
    documentId: "paged-retired-orphan",
  });
  const second = bm25PostingFixture({
    sessionId: "session-b",
    documentId: "paged-retired-orphan",
  });
  await store.put(first.sessionKey, first.posting, { kind: "bm25-session-posting" });
  await store.put(second.sessionKey, second.posting, { kind: "bm25-session-posting" });
  await store.put(
    [KEYSPACE.SUPERSESSION, first.posting.documentId, 1],
    {
      documentId: first.posting.documentId,
      documentVersion: 1,
      status: "expired",
      reason: "paged migration test",
      recordedAt: 150,
    },
    { kind: "supersession" },
  );
  await store.put(
    [KEYSPACE.META, "posting-storage-migration"],
    {
      migrationVersion: 2,
      status: "running",
      phase: "bm25-session-locators",
      after: null,
      startedAt: 100,
      updatedAt: 100,
      rollbackGraceMs: 1_000,
      scannedKeys: 0,
      rewrittenKeys: 0,
      unresolvedKeys: 0,
      deletedKeys: 0,
      logicalBytesSaved: 0,
    },
    { kind: "posting-storage-migration-state" },
  );

  const firstPage = await runPostingStorageMaintenance(store, {
    now: 200,
    limit: 1,
    rollbackGraceMs: 1_000,
  });
  assert.equal(firstPage.phase, "bm25-session-locators");
  assert.equal(firstPage.scannedKeys, 1);
  assert.equal(firstPage.unresolvedKeys, 1);
  assert.notEqual(firstPage.after, null);

  const secondPage = await runPostingStorageMaintenance(store, {
    now: 201,
    limit: 1,
    rollbackGraceMs: 1_000,
  });
  assert.equal(secondPage.phase, "bm25-session-locators");
  assert.equal(secondPage.scannedKeys, 2);
  assert.equal(secondPage.unresolvedKeys, 2);
  assert.notEqual(secondPage.after, null);

  const completedPage = await runPostingStorageMaintenance(store, {
    now: 202,
    limit: 1,
    rollbackGraceMs: 1_000,
  });
  assert.equal(completedPage.phase, "bm25-canonical-blocks");
  assert.equal(completedPage.scannedKeys, 2);
  assert.equal(completedPage.unresolvedKeys, 2);
  assert.equal(completedPage.after, null);
});

test("folded exact migration traces case variants to canonical postings", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const common = {
    postingVersion: 1,
    generation: 1,
    sourceVersion: 1,
    project: "/workspace/posting",
    sessionId: "session",
    bucket: 1,
    createdAt: 100,
    documentId: "document",
    documentVersion: 1,
    documentKind: "turn",
    sourceKey: "user:document",
    sourceKeyStatus: "active",
    sourceMessageKeys: ["user:document"],
    turnId: null,
    windowOrdinal: 0,
    windowStartByte: 0,
    windowEndByte: 20,
    matches: [{
      type: "symbol",
      value: "PostingTarget",
      startByte: 0,
      endByte: 13,
      specificity: 0.94,
    }],
  };
  const canonicalKey = exactKeys.posting({
    project: common.project,
    caseMode: "exact",
    term: "PostingTarget",
    bucket: common.bucket,
    documentId: common.documentId,
    version: common.documentVersion,
    generation: common.generation,
    windowOrdinal: common.windowOrdinal,
  });
  const foldedKey = exactKeys.posting({
    project: common.project,
    caseMode: "folded",
    term: "postingtarget",
    bucket: common.bucket,
    documentId: common.documentId,
    version: common.documentVersion,
    generation: common.generation,
    windowOrdinal: common.windowOrdinal,
  });
  const orphanFoldedKey = exactKeys.posting({
    project: common.project,
    caseMode: "folded",
    term: "orphanedtarget",
    bucket: common.bucket,
    documentId: common.documentId,
    version: common.documentVersion,
    generation: common.generation,
    windowOrdinal: common.windowOrdinal,
  });
  await store.put(canonicalKey, {
    ...common,
    caseMode: "exact",
    normalizedTerm: "PostingTarget",
  }, { kind: "exact-posting" });
  await store.put(foldedKey, {
    ...common,
    caseMode: "folded",
    normalizedTerm: "postingtarget",
    duplicatedProvenance: "x".repeat(2_000),
  }, { kind: "exact-posting" });
  const orphanFolded = {
    ...common,
    caseMode: "folded",
    normalizedTerm: "orphanedtarget",
    matches: [{
      ...common.matches[0],
      value: "OrphanedTarget",
    }],
  };
  await store.put(orphanFoldedKey, orphanFolded, { kind: "exact-posting" });

  const report = await rewriteExactFoldedPostingLocators(store, {
    reportOnly: true,
    limit: 100,
  });
  assert.equal(report.rewrittenKeys, 1);
  assert.equal(report.unresolvedKeys, 1);
  assert.ok(report.valueBytesSaved > 1_000);

  await rewriteExactFoldedPostingLocators(store, { reportOnly: false, limit: 100 });
  const locator = decodePostingLocator(
    await store.get(foldedKey),
    POSTING_LOCATOR_KIND.EXACT_FOLDED,
  );
  assert.equal(locator.targets.length, 1);
  assert.deepEqual(locator.targets[0], (await store.getRecord(canonicalKey)).keyBytes);
  assert.deepEqual(await store.get(orphanFoldedKey), orphanFolded);

  const blockReport = await rewriteExactCanonicalPostingBlocks(store, {
    reportOnly: true,
    limit: 100,
  });
  assert.equal(blockReport.rewrittenKeys, 1);
  assert.ok(blockReport.valueBytesSaved > 100);
  await rewriteExactCanonicalPostingBlocks(store, { reportOnly: false, limit: 100 });
  const block = await store.get(canonicalKey);
  assert.equal(isPostingBlock(block), true);
  assert.deepEqual(decodeExactPostingBlock(block), {
    ...common,
    caseMode: "exact",
    normalizedTerm: "PostingTarget",
  });
});

test("verified storage migration observes rollback grace before removing reverse references", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  const target = [KEYSPACE.EXACT, "/workspace/posting", "exact", "target"];
  const reverse = derivedKeys.reference("document", 1, encodeKey(target));
  await store.put(target, {
    documentId: "document",
    documentVersion: 1,
  }, { kind: "test-derived-target" });
  await store.put(reverse, {
    documentId: "document",
    documentVersion: 1,
    targetKey: encodeKey(target).toString("base64url"),
  }, { kind: "derived-document-reference" });

  let state;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    state = await runPostingStorageMaintenance(store, {
      now: 1_000,
      limit: 100,
      rollbackGraceMs: 500,
    });
    if (state.phase === "rollback-grace") break;
  }
  assert.equal(state.phase, "rollback-grace");
  assert.equal((await store.get(derivedViewKeys.queryCutover())).rollbackGraceUntil, 1_500);
  assert.notEqual(await store.get(reverse), undefined);
  const grace = await garbageCollectReverseCleanupReferences(store, {
    reportOnly: false,
    now: 1_499,
    limit: 100,
  });
  assert.equal(grace.phase, "rollback-grace");
  assert.notEqual(await store.get(reverse), undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    state = await runPostingStorageMaintenance(store, {
      now: 1_500,
      limit: 100,
      rollbackGraceMs: 500,
    });
    if (state.status === "complete") break;
  }
  assert.equal(state.status, "complete");
  assert.equal(await store.get(reverse), undefined);
  // Canonical derived targets are deliberately retained and hidden through
  // tombstone/current overlays; only the cleanup-only reverse map disappears.
  assert.notEqual(await store.get(target), undefined);
});

test("cutover verification resumes across bounded document and assignment pages", async (t) => {
  const store = await RocksStore.open(join(temporaryDirectory(t), "archive.rocks"));
  t.after(() => store.close());
  for (let index = 1; index <= 3; index += 1) {
    await admitDocument(store, {
      idempotencyKey: `verification:${index}`,
      document: {
        documentId: `document-${index}`,
        version: 1,
        sourceKey: `user:${index}`,
        sessionId: "session",
        project: "/workspace/posting",
        kind: "turn",
        createdAt: index,
        text: `verification document ${index}`,
        metadata: {},
        sourceMessageKeys: [`user:${index}`],
      },
      retentionClass: "conversation-source",
    });
  }

  let state;
  let pagedDocuments = false;
  let pagedAssignments = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await runPostingStorageMaintenance(store, {
      now: 1_000,
      limit: 2,
      rollbackGraceMs: 500,
    });
    pagedDocuments ||= state.verificationPhase === "documents" && state.after !== null;
    pagedAssignments ||= state.verificationPhase === "assignments" && state.after !== null;
    if (state.phase === "rollback-grace") break;
  }
  assert.equal(state.phase, "rollback-grace");
  assert.equal(state.verification.checked, 3);
  assert.equal(state.verification.mismatches, 0);
  assert.equal(state.verification.truncated, false);
  assert.equal(pagedDocuments, true);
  assert.equal(pagedAssignments, true);
});
