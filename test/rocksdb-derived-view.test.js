import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DERIVED_VIEW_LAYOUT,
  derivedViewKeys,
  derivedViewStatus,
  ensureDerivedView,
  isDocumentOrdinalLive,
  resolveDocumentOrdinal,
  verifyDerivedView,
} from "../src/rocksdb/derived-view.js";
import { keyFor, KEYSPACE } from "../src/rocksdb/keys.js";
import {
  admitDocument,
  prepareDocumentAdmission,
} from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(version, idempotencyKey = `ordinal:${version}`) {
  const documentId = "ordinal-document";
  const sourceKey = `user:${documentId}:${version}`;
  return {
    idempotencyKey,
    document: {
      documentId,
      version,
      sourceKey,
      sessionId: "ordinal-session",
      project: "/workspace/ordinals",
      kind: "turn",
      createdAt: 1_700_000_000_000 + version,
      text: `stable ordinal version ${version}`,
      metadata: { turnId: `ordinal-turn-${version}` },
      sourceMessageKeys: [sourceKey],
    },
    structuralMessages: [],
    retentionClass: "conversation-source",
  };
}

test("canonical admission assigns one stable ordinal and tombstones replaced versions", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "derived-view-admission"));
  t.after(() => store.close());

  const firstResult = await admitDocument(store, request(1));
  const reindexResult = await admitDocument(store, request(1, "ordinal:1:reindex"));
  await admitDocument(store, request(2));
  assert.equal(firstResult.status, "stored");
  assert.equal(reindexResult.status, "stored");

  const first = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  const second = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 2,
  });
  assert.equal(first.ordinal, 1);
  assert.equal(second.ordinal, 2);
  assert.equal(await isDocumentOrdinalLive(store, first), false);
  assert.equal(await isDocumentOrdinalLive(store, second), true);
  assert.deepEqual(
    await store.get(derivedViewKeys.ordinal(first.ordinal)),
    first,
  );
  assert.deepEqual(
    await store.get(derivedViewKeys.sessionDocument(
      second.project,
      second.sessionId,
      second.ordinal,
    )),
    second,
  );
  assert.equal(await store.get(keyFor.counter("document-ordinal")), 2);

  const status = await derivedViewStatus(store, { project: "/workspace/ordinals" });
  assert.equal(status.layout, DERIVED_VIEW_LAYOUT);
  assert.equal(status.admittedDocuments, 2);
  assert.equal(status.tombstonedDocuments, 1);
  assert.equal(status.liveDocuments, 1);
  assert.equal(status.ordinalHighWatermark, 2);
  assert.deepEqual(await verifyDerivedView(store, {
    project: "/workspace/ordinals",
  }), {
    ok: true,
    checked: 2,
    mismatches: 0,
    missingAssignments: 0,
    identityMismatches: 0,
    scopeMismatches: 0,
    retirementMismatches: 0,
    orphanLiveAssignments: 0,
    truncated: false,
    samples: [],
  });
});

test("legacy derived-view upgrade backfills ordinals and retirement overlays", async (t) => {
  const path = temporaryStorePath(t, "derived-view-backfill");
  let store = await RocksStore.open(path);
  await admitDocument(store, request(1));
  await admitDocument(store, request(2));

  const derivedRecords = store.scan([KEYSPACE.META, "derived-view"], { limit: 100_000 });
  await store.transaction(async (transaction) => {
    for (const record of derivedRecords) await transaction.remove(record.keyBytes);
    await transaction.remove(keyFor.counter("document-ordinal"));
  });

  const originalTransaction = store.transaction.bind(store);
  let interrupted = false;
  store.transaction = async (...arguments_) => {
    const result = await originalTransaction(...arguments_);
    const state = await store.get(derivedViewKeys.upgradeState());
    if (!interrupted && state?.status === "indexing" && state.after !== null) {
      interrupted = true;
      throw new Error("simulated derived-view upgrade crash");
    }
    return result;
  };
  await assert.rejects(
    ensureDerivedView(store),
    /simulated derived-view upgrade crash/u,
  );
  store.transaction = originalTransaction;
  assert.equal(interrupted, true);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const first = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  const second = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 2,
  });
  assert.equal(first.ordinal, 1);
  assert.equal(second.ordinal, 2);
  assert.equal(await isDocumentOrdinalLive(store, first), false);
  assert.equal(await isDocumentOrdinalLive(store, second), true);
  assert.deepEqual(await store.get(derivedViewKeys.upgradeState()), {
    formatVersion: 1,
    status: "complete",
    phase: "complete",
    after: null,
    indexedDocuments: 2,
    tombstonedDocuments: 1,
    outboxHighWatermark: 2,
    retirementHighWatermark: 2,
  });
});

test("ordinal metadata does not change canonical retry fingerprints across upgrade", async (t) => {
  const path = temporaryStorePath(t, "derived-view-idempotency");
  let store = await RocksStore.open(path);
  const prepared = prepareDocumentAdmission(request(1));
  const { derivedView: _derivedView, ...legacyPrepared } = prepared;
  const legacy = await store.commitCanonical(legacyPrepared);
  assert.equal(legacy.duplicate, false);
  assert.equal(
    (await store.get(derivedViewKeys.upgradeState())).outboxHighWatermark,
    0,
  );
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const retry = await admitDocument(store, request(1));
  assert.equal(retry.status, "duplicate");
  assert.equal(
    (await store.get(derivedViewKeys.upgradeState())).outboxHighWatermark,
    1,
  );
  assert.equal((await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  })).ordinal, 1);
});

test("outbox drift reconciles a retirement committed by an older daemon", async (t) => {
  const path = temporaryStorePath(t, "derived-view-retirement-drift");
  let store = await RocksStore.open(path);
  await admitDocument(store, request(1));
  const marker = {
    documentId: "ordinal-document",
    documentVersion: 1,
    status: "expired",
    reason: "simulated legacy retention",
    recordedAt: 1_700_000_000_100,
  };
  await store.transaction(async (transaction) => {
    await transaction.putImmutable(
      [KEYSPACE.SUPERSESSION, "ordinal-document", 1],
      marker,
      { kind: "supersession" },
    );
    await transaction.remove([KEYSPACE.DOCUMENT, "ordinal-document", 1]);
    const sequence = await transaction.increment("outbox");
    await transaction.put([KEYSPACE.OUTBOX, sequence], {
      operation: "delete",
      documentId: "ordinal-document",
      documentVersion: 1,
      sourceVersion: 1,
      admittedAt: marker.recordedAt,
      sequence,
    }, { kind: "outbox" });
  });
  assert.equal((await derivedViewStatus(store, {
    project: "/workspace/ordinals",
  })).liveDocuments, 1);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const assignment = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  assert.equal(await isDocumentOrdinalLive(store, assignment), false);
  assert.equal((await derivedViewStatus(store, {
    project: "/workspace/ordinals",
  })).liveDocuments, 0);
  assert.equal(
    (await store.get(derivedViewKeys.upgradeState())).retirementHighWatermark,
    2,
  );
});

test("outbox drift tombstones an older-daemon supersession whose manifest survives", async (t) => {
  const path = temporaryStorePath(t, "derived-view-surviving-supersession");
  let store = await RocksStore.open(path);
  await admitDocument(store, request(1));
  const marker = {
    documentId: "ordinal-document",
    documentVersion: 1,
    status: "superseded",
    replacementVersion: 2,
    reason: "simulated legacy supersession",
    recordedAt: 1_700_000_000_100,
  };
  await store.transaction(async (transaction) => {
    await transaction.putImmutable(
      [KEYSPACE.SUPERSESSION, "ordinal-document", 1],
      marker,
      { kind: "supersession" },
    );
    const sequence = await transaction.increment("outbox");
    await transaction.put([KEYSPACE.OUTBOX, sequence], {
      operation: "index",
      documentId: "ordinal-document",
      documentVersion: 2,
      sourceVersion: 2,
      admittedAt: marker.recordedAt,
      sequence,
    }, { kind: "outbox" });
  });
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const assignment = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  assert.equal(await isDocumentOrdinalLive(store, assignment), false);
  assert.equal((await derivedViewStatus(store, {
    project: "/workspace/ordinals",
  })).liveDocuments, 0);
  assert.equal((await verifyDerivedView(store, {
    project: "/workspace/ordinals",
  })).retirementMismatches, 0);
});

test("outbox drift assigns a tombstoned retired-only ordinal after legacy cleanup", async (t) => {
  const path = temporaryStorePath(t, "derived-view-cleaned-legacy-admission");
  let store = await RocksStore.open(path);
  const prepared = prepareDocumentAdmission(request(1));
  const { derivedView: _derivedView, ...legacyPrepared } = prepared;
  await store.commitCanonical(legacyPrepared);
  const marker = {
    documentId: "ordinal-document",
    documentVersion: 1,
    status: "expired",
    reason: "simulated legacy cleanup",
    recordedAt: 1_700_000_000_100,
  };
  await store.transaction(async (transaction) => {
    for (const record of legacyPrepared.records) await transaction.remove(record.key);
    await transaction.putImmutable(
      [KEYSPACE.SUPERSESSION, "ordinal-document", 1],
      marker,
      { kind: "supersession" },
    );
    const sequence = await transaction.increment("outbox");
    await transaction.put([KEYSPACE.OUTBOX, sequence], {
      operation: "delete",
      documentId: "ordinal-document",
      documentVersion: 1,
      sourceVersion: 1,
      admittedAt: marker.recordedAt,
      sequence,
    }, { kind: "outbox" });
  });
  assert.equal(await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  }), undefined);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const assignment = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  assert.equal(assignment.retiredOnly, true);
  assert.equal(assignment.sessionId, undefined);
  assert.equal(await isDocumentOrdinalLive(store, assignment), false);
  assert.deepEqual(
    await store.get(derivedViewKeys.projectDocument(
      assignment.project,
      assignment.ordinal,
    )),
    assignment,
  );
  assert.equal(
    await store.get(derivedViewKeys.sessionDocument(
      assignment.project,
      "ordinal-session",
      assignment.ordinal,
    )),
    undefined,
  );
  assert.deepEqual(await derivedViewStatus(store, {
    project: "/workspace/ordinals",
  }), {
    formatVersion: 1,
    upgradeStatus: "complete",
    project: "/workspace/ordinals",
    activeEpoch: 1,
    admittedDocuments: 1,
    layout: DERIVED_VIEW_LAYOUT,
    ordinalHighWatermark: 1,
    runs: [],
    tombstoneGeneration: 1,
    tombstonedDocuments: 1,
    updatedAt: marker.recordedAt,
    liveDocuments: 0,
  });
});

test("retired document history restores an ordinal after detailed markers are reclaimed", async (t) => {
  const path = temporaryStorePath(t, "derived-view-retired-history");
  let store = await RocksStore.open(path);
  const prepared = prepareDocumentAdmission(request(1));
  const { derivedView: _derivedView, ...legacyPrepared } = prepared;
  await store.commitCanonical(legacyPrepared);
  const historyKey = [
    KEYSPACE.META,
    "document-history",
    "ordinal-document",
  ];
  await store.transaction(async (transaction) => {
    for (const record of legacyPrepared.records) await transaction.remove(record.key);
    const history = await transaction.get(historyKey);
    await transaction.put(historyKey, {
      ...history,
      retiredThrough: 1,
    }, { kind: "document-history" });
    const sequence = await transaction.increment("outbox");
    await transaction.put([KEYSPACE.OUTBOX, sequence], {
      operation: "delete",
      documentId: "ordinal-document",
      documentVersion: 1,
      sourceVersion: 1,
      admittedAt: 1_700_000_000_100,
      sequence,
    }, { kind: "outbox" });
  });
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  const assignment = await resolveDocumentOrdinal(store, {
    project: "/workspace/ordinals",
    documentId: "ordinal-document",
    version: 1,
  });
  assert.equal(assignment.retiredOnly, true);
  assert.equal(await isDocumentOrdinalLive(store, assignment), false);
  const tombstone = await store.get(derivedViewKeys.tombstone(
    assignment.project,
    assignment.ordinal,
  ));
  assert.equal(tombstone.status, "expired");
  assert.equal(tombstone.recordedAt, 0);
});

test("retired-history reconciliation resumes within a multi-page version range", async (t) => {
  const path = temporaryStorePath(t, "derived-view-retired-history-resume");
  let store = await RocksStore.open(path);
  await store.put([
    KEYSPACE.META,
    "document-history",
    "retired-range",
  ], {
    documentHistoryFormatVersion: 1,
    documentId: "retired-range",
    project: "/workspace/ordinals",
    highestAdmittedVersion: 20,
    retiredThrough: 20,
  }, { kind: "document-history" });
  await store.transaction(async (transaction) => {
    const sequence = await transaction.increment("outbox");
    await transaction.put([KEYSPACE.OUTBOX, sequence], {
      operation: "delete",
      documentId: "retired-range",
      documentVersion: 20,
      sourceVersion: 20,
      admittedAt: 1_700_000_000_100,
      sequence,
    }, { kind: "outbox" });
  });

  const originalTransaction = store.transaction.bind(store);
  let interrupted = false;
  store.transaction = async (...arguments_) => {
    const result = await originalTransaction(...arguments_);
    const state = await store.get(derivedViewKeys.upgradeState());
    if (!interrupted
      && state?.phase === "retired-histories"
      && state.historyVersion === 8) {
      interrupted = true;
      throw new Error("simulated retired-history reconciliation crash");
    }
    return result;
  };
  await assert.rejects(
    ensureDerivedView(store),
    /simulated retired-history reconciliation crash/u,
  );
  store.transaction = originalTransaction;
  assert.equal(interrupted, true);
  store.close();

  store = await RocksStore.open(path);
  t.after(() => store.close());
  for (let version = 1; version <= 20; version += 1) {
    const assignment = await resolveDocumentOrdinal(store, {
      project: "/workspace/ordinals",
      documentId: "retired-range",
      version,
    });
    assert.equal(assignment.retiredOnly, true);
    assert.equal(await isDocumentOrdinalLive(store, assignment), false);
  }
  const status = await derivedViewStatus(store, {
    project: "/workspace/ordinals",
  });
  assert.equal(status.admittedDocuments, 20);
  assert.equal(status.tombstonedDocuments, 20);
  assert.equal(status.liveDocuments, 0);
});
