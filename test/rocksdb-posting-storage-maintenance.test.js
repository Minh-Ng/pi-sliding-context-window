import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exactKeys } from "../src/rocksdb/index/exact.js";
import { bm25Keys } from "../src/rocksdb/index/bm25-keys.js";
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
import { encodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-posting-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
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
