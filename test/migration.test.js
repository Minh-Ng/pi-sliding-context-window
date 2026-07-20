import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Archive } from "../src/archive/archive.js";
import {
  MIGRATION_COMPARISON_DETAIL_BYTES,
  MIGRATION_COMPARISON_DETAIL_LIMIT,
  MIGRATION_COMPARISON_RUN_LIMIT,
  MIGRATION_VERIFICATION_PAGE_SIZE,
  MigrationSourceMismatchError,
  SqliteArchiveSource,
  activateRocksBackend,
  applyDifferenceAllowlist,
  compareRecallEvidence,
  compareSearchResults,
  claimSqliteBackend,
  createShadowDifference,
  getBackendAuthority,
  getMigrationStatus,
  inspectSqliteArchive,
  listMigrationDifferences,
  migrationKeys,
  prepareMigrationAdmission,
  readMigratedDocument,
  recordShadowDifferences,
  startMigration,
  verifyMigration,
} from "../src/migration/index.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { derivedKeys } from "../src/rocksdb/derived.js";
import { encodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { manifestKeys, prepareDocumentAdmission } from "../src/rocksdb/manifests.js";
import { stableJson } from "../src/rocksdb/schema.js";
import { DEFAULT_RETENTION_LIFETIMES_MS } from "../src/daemon/retention-policy.js";
import { outboxKeys } from "../src/rocksdb/outbox.js";
import { renewDocumentExpiry } from "../src/rocksdb/retention.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryDirectory(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sourceSnapshot(path) {
  const directory = dirname(path);
  const name = basename(path);
  return Object.fromEntries(readdirSync(directory)
    .filter((entry) => entry === name || entry.startsWith(`${name}-`))
    .sort()
    .map((entry) => {
      const bytes = readFileSync(join(directory, entry));
      return [entry, {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }];
    }));
}

function createSource(path) {
  const archive = new Archive(path);
  archive.put({
    id: "sourced-turn",
    sessionId: "session-child",
    project: "/workspace/project",
    kind: "turn",
    createdAt: 10,
    text: "[user] Find REAP_DRAIN 🪨\n[assistant] It is in worker.ts.",
    metadata: {
      sourceMessageKeys: ["user:1::aaa", "assistant:2::bbb"],
      sourceFirstKey: "user:1::aaa",
      sourceLastKey: "assistant:2::bbb",
      sourceMessageCount: 2,
      turnId: "turn-1",
    },
  }, {
    deferPrune: true,
    structuralMessages: [{
      messageKey: "user:1::aaa",
      messageIndex: 0,
      role: "user",
      createdAt: 10,
      text: "Find REAP_DRAIN 🪨",
      questionScore: 100,
      requestScore: 80,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  archive.put({
    id: "legacy-turn",
    sessionId: "session-old",
    project: "/workspace/project",
    kind: "turn",
    createdAt: 20,
    text: "legacy text with NUL \u0000 and 雪",
    metadata: { startKey: "user:old", messageCount: 1 },
  }, { deferPrune: true });
  archive.put({
    id: "malformed-turn",
    sessionId: "session-old",
    project: "/workspace/project",
    kind: "turn",
    createdAt: 30,
    text: "malformed metadata remains recallable",
  }, { deferPrune: true });
  archive.db.prepare(
    "UPDATE documents SET metadata_json = ? WHERE id = 'malformed-turn'",
  ).run("{broken");
  archive.put({
    id: "tool-result",
    sessionId: "session-child",
    project: "/workspace/project",
    kind: "tool-result",
    createdAt: 40,
    text: "tool bytes\r\nsecond line",
    metadata: {
      sourceMessageKey: "toolResult:4:call-7:ccc",
      toolCallId: "call-7",
      toolName: "read",
    },
  }, { deferPrune: true });
  archive.close();
}

function appendSourceDocuments(path, count) {
  const database = new DatabaseSync(path);
  const insert = database.prepare(`
    INSERT INTO documents(id, session_id, project, kind, created_at, text, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(6, "0");
      insert.run(
        `bulk-${suffix}`,
        "session-bulk",
        "/workspace/project",
        "turn",
        100 + index,
        `bounded migration verification row ${suffix}`,
        "{}",
      );
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("SQLite inspection is strictly read-only and preserves stable order and provenance", (t) => {
  const directory = temporaryDirectory(t, "migration-source");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const before = sourceSnapshot(sourcePath);

  const info = inspectSqliteArchive(sourcePath);
  assert.equal(info.documentCount, 4);
  assert.equal(info.orderingMode, "document-order");
  assert.match(info.sourceFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(info.schemaFingerprint, /^[a-f0-9]{64}$/u);

  const source = SqliteArchiveSource.open(sourcePath);
  try {
    const rows = source.readBatch(0, 100);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map(({ sourceOrderingKey }) => sourceOrderingKey),
      [...rows.map(({ sourceOrderingKey }) => sourceOrderingKey)].sort((a, b) => a - b),
    );
    assert.equal(rows.find(({ id }) => id === "sourced-turn").structuralMessages.length, 1);
    assert.equal(
      rows.find(({ id }) => id === "malformed-turn").metadataParse.status,
      "malformed-json",
    );
    assert.equal(
      rows.find(({ id }) => id === "malformed-turn").provenance.sourceMessages.status,
      "metadata-invalid",
    );
    const fingerprintRow = rows.find(({ id }) => id === "sourced-turn");
    const rawFingerprintFields = {
      sourceFormatVersion: fingerprintRow.sourceFormatVersion,
      sourceOrderingKey: fingerprintRow.sourceOrderingKey,
      sourceRowId: fingerprintRow.sourceRowId,
      metadataJson: fingerprintRow.metadataJson,
      structuralMessages: fingerprintRow.structuralMessages,
      id: fingerprintRow.id,
      sessionId: fingerprintRow.sessionId,
      project: fingerprintRow.project,
      kind: fingerprintRow.kind,
      createdAt: fingerprintRow.createdAt,
      text: fingerprintRow.text,
    };
    assert.equal(
      fingerprintRow.sourceRecordFingerprint,
      createHash("sha256").update(stableJson(rawFingerprintFields)).digest("hex"),
    );
  } finally {
    source.close();
  }
  assert.deepEqual(sourceSnapshot(sourcePath), before);
});

test("an active WAL is read through a coherent private snapshot without changing source files", (t) => {
  const directory = temporaryDirectory(t, "migration-active-wal");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const writer = new DatabaseSync(sourcePath);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  writer.prepare("UPDATE documents SET text = text || ' committed-in-wal' WHERE id = ?")
    .run("legacy-turn");
  assert.ok(existsSync(`${sourcePath}-wal`));
  const before = sourceSnapshot(sourcePath);

  const source = SqliteArchiveSource.open(sourcePath);
  try {
    assert.equal(source.info().readMode, "private-wal-snapshot");
    assert.match(source.readBatch(0, 100).find(({ id }) => id === "legacy-turn").text,
      /committed-in-wal$/u);
  } finally {
    source.close();
  }
  assert.deepEqual(sourceSnapshot(sourcePath), before);
});

test("offline migration rejects a pre-populated RocksDB destination", async (t) => {
  const directory = temporaryDirectory(t, "migration-fresh-destination");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  await store.put([KEYSPACE.DOCUMENT, "already-rocks", 1], {
    documentId: "already-rocks",
    version: 1,
  }, { kind: "document-manifest" });
  await assert.rejects(startMigration(store, { sourcePath, offline: true }),
    (error) => error.code === "MIGRATION_BLOCKED" && /fresh RocksDB destination/iu.test(error.message));
});

test("fresh SQLite and RocksDB activation serialize to one durable backend authority", async (t) => {
  const directory = temporaryDirectory(t, "migration-backend-authority-race");
  const sourcePath = join(directory, "archive.db");
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const [sqlite, rocks] = await Promise.allSettled([
    claimSqliteBackend(store, { sourcePath }),
    activateRocksBackend(store, { sourcePath }),
  ]);
  assert.equal(sqlite.status, "fulfilled");
  assert.equal(sqlite.value.backend, "sqlite");
  assert.equal(rocks.status, "rejected");
  assert.equal(rocks.reason.code, "MIGRATION_BLOCKED");
  assert.equal((await getBackendAuthority(store)).backend, "sqlite");

  createSource(sourcePath);
  await startMigration(store, { sourcePath, offline: true });
  assert.equal(await getBackendAuthority(store), undefined,
    "offline migration atomically clears the matching SQLite claim");
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  assert.equal((await activateRocksBackend(store, { sourcePath })).mode, "verified-cutover");
});

test("SQLite cannot reopen while an offline migration is incomplete", async (t) => {
  const directory = temporaryDirectory(t, "migration-sqlite-mid-copy");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  await claimSqliteBackend(store, { sourcePath });
  const partial = await startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 1,
    maxBatches: 1,
  });
  assert.equal(partial.status.phase, "offline-copy");
  assert.equal(await getBackendAuthority(store), undefined);
  await assert.rejects(
    claimSqliteBackend(store, { sourcePath }),
    (error) => error.code === "MIGRATION_BLOCKED" && /offline migration is offline-copy/iu.test(error.message),
  );
  assert.equal(await getBackendAuthority(store), undefined);
});

test("a durable SQLite rollback claim remains reopenable after source drift", async (t) => {
  const directory = temporaryDirectory(t, "migration-sqlite-rollback-reopen");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  await startMigration(store, { sourcePath, offline: true });
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  assert.equal((await claimSqliteBackend(store, { sourcePath })).backend, "sqlite");
  const sqlite = new Archive(sourcePath);
  try {
    sqlite.put({
      id: "rollback-only-turn",
      sessionId: "rollback-session",
      project: "/workspace/project",
      kind: "turn",
      createdAt: 50,
      text: "This row requires migration revalidation.",
      metadata: {},
    }, { deferPrune: true });
  } finally {
    sqlite.close();
  }
  assert.equal((await getMigrationStatus(store)).phase, "blocked");
  assert.equal((await claimSqliteBackend(store, { sourcePath })).backend, "sqlite");

  const rerun = await startMigration(store, { sourcePath, offline: true });
  assert.equal(rerun.status.phase, "offline-verification");
  assert.equal(rerun.status.migratedCount, 5);
  assert.equal(await getBackendAuthority(store), undefined);
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
});

test("a direct first canonical admission atomically claims permanent RocksDB authority", async (t) => {
  const directory = temporaryDirectory(t, "migration-direct-authority");
  const sourcePath = join(directory, "archive.db");
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const project = "/workspace/direct-authority";
  const request = {
    idempotencyKey: "direct-authority-request",
    document: {
      documentId: "direct-authority-document",
      version: 1,
      sourceKey: "user:direct-authority",
      sourceMessageKeys: ["user:direct-authority"],
      sourceKeyStatus: "preserved",
      sessionId: "direct-authority-session",
      project,
      kind: "turn",
      createdAt: Date.now(),
      text: "The direct admission and backend claim share one transaction.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  };

  const admission = prepareDocumentAdmission(request);
  const commit = async () => {
    const gate = await prepareMigrationAdmission(store, {
      requestId: admission.requestId,
      documentId: admission.manifest.documentId,
    });
    return store.commitCanonical({
      ...admission,
      mustMatch: [...(admission.mustMatch ?? []), ...(gate.mustMatch ?? [])],
      mustBeAbsent: [...(admission.mustBeAbsent ?? []), ...(gate.mustBeAbsent ?? [])],
      transitions: [...(admission.transitions ?? []), ...gate.transitions],
    });
  };
  const first = await commit();
  const duplicate = await commit();
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true,
    "the authority transition must preserve the first request fingerprint");
  const authority = await getBackendAuthority(store);
  assert.equal(authority.backend, "rocksdb");
  assert.equal(authority.reason, "direct-canonical-admission");
  assert.equal(authority.requestId, request.idempotencyKey);
  await assert.rejects(claimSqliteBackend(store, { sourcePath }),
    (error) => error.code === "MIGRATION_BLOCKED" && /cannot restart/iu.test(error.message));
  createSource(sourcePath);
  await assert.rejects(activateRocksBackend(store, { sourcePath }),
    (error) => error.code === "MIGRATION_BLOCKED" && /cannot reconcile existing SQLite source/iu.test(error.message));
  await assert.rejects(startMigration(store, { sourcePath, offline: true }),
    (error) => error.code === "MIGRATION_BLOCKED" && /authority/iu.test(error.message));
});

test("first verified RocksDB admission makes SQLite restart permanently unavailable", async (t) => {
  const directory = temporaryDirectory(t, "migration-backend-authority-seal");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  await claimSqliteBackend(store, { sourcePath });
  await startMigration(store, { sourcePath, offline: true });
  await verifyMigration(store, { sourcePath });
  const project = "/workspace/project";
  await runtime.put({
    idempotencyKey: "durable-backend-authority",
    document: {
      documentId: "durable-backend-authority-document",
      version: 1,
      sourceKey: "user:durable-backend-authority",
      sourceMessageKeys: ["user:durable-backend-authority"],
      sourceKeyStatus: "preserved",
      sessionId: "authority-session",
      project,
      kind: "turn",
      createdAt: Date.now(),
      text: "RocksDB remains authoritative after this acknowledgement.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  }, { project });

  const authority = await getBackendAuthority(store);
  assert.equal(authority.backend, "rocksdb");
  assert.equal(authority.reason, "migration-authority");
  await assert.rejects(claimSqliteBackend(store, { sourcePath }),
    (error) => error.code === "MIGRATION_BLOCKED" && /cannot restart/iu.test(error.message));
});

test("verified pre-authority destinations block retention until RocksDB authority", async (t) => {
  const directory = temporaryDirectory(t, "migration-retention-gate");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const migrated = await startMigration(store, { sourcePath, offline: true });
  await verifyMigration(store, { sourcePath });
  const future = migrated.status.checkpoint.retentionStartedAt + 365 * 24 * 60 * 60 * 1_000;
  const blocked = await runtime.retention({ now: future, force: true, batchSize: 1_000 }, {
    project: "/workspace/project",
  });
  assert.deepEqual(blocked, {
    status: "blocked",
    scanned: 0,
    tombstoned: 0,
    deletedKeys: 0,
    protected: 0,
  });
  assert.notEqual(await store.get(manifestKeys.document("tool-result", 1)), undefined);
  assert.equal((await getMigrationStatus(store)).phase, "offline-ready");
});

test("verification's exclusive lease cannot interleave a retention wave", async (t) => {
  const directory = temporaryDirectory(t, "migration-verification-retention-race");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const originalGet = store.get.bind(store);
  let releaseVerification;
  let signalPaused;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  let intercepted = false;
  store.get = async (key) => {
    const value = await originalGet(key);
    if (!intercepted && Array.isArray(key)
      && key[0] === "migration" && key[1] === "checkpoint") {
      intercepted = true;
      signalPaused();
      await new Promise((resolve) => { releaseVerification = resolve; });
    }
    return value;
  };

  try {
    const verification = verifyMigration(store, { sourcePath });
    await paused;
    let retentionSettled = false;
    const future = migrated.status.checkpoint.retentionStartedAt + 365 * 24 * 60 * 60 * 1_000;
    const retention = runtime.retention({ now: future, force: true, batchSize: 1_000 }, {
      project: "/workspace/project",
    }).finally(() => { retentionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(retentionSettled, false, "retention waits behind verification's exclusive lease");
    releaseVerification();
    assert.equal((await verification).status, "passed");
    assert.equal((await retention).status, "blocked");
    assert.notEqual(await store.get(manifestKeys.document("tool-result", 1)), undefined);
  } finally {
    releaseVerification?.();
    store.get = originalGet;
  }
});

test("a canonical admission paused after not-started cannot cross migration start", async (t) => {
  const directory = temporaryDirectory(t, "migration-admission-start-race");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  let releaseCommit;
  const commitReleased = new Promise((resolve) => { releaseCommit = resolve; });
  let admissionPaused;
  const paused = new Promise((resolve) => { admissionPaused = resolve; });
  const commitCanonical = store.commitCanonical.bind(store);
  let pauseNextCommit = true;
  store.commitCanonical = async (prepared) => {
    if (pauseNextCommit) {
      pauseNextCommit = false;
      admissionPaused();
      await commitReleased;
    }
    return commitCanonical(prepared);
  };

  const documentId = "paused-before-migration-start";
  const admission = runtime.put({
    idempotencyKey: "paused-before-migration-start-request",
    document: {
      documentId,
      version: 1,
      sourceKey: "user:paused-before-migration",
      sourceMessageKeys: ["user:paused-before-migration"],
      sourceKeyStatus: "preserved",
      sessionId: "paused-admission-session",
      project: "/workspace/project",
      kind: "turn",
      createdAt: Date.now(),
      text: "This write must not cross the offline migration start boundary.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  }, { project: "/workspace/project" });

  try {
    await paused;
    const migrated = await startMigration(store, { sourcePath, offline: true });
    assert.equal(migrated.status.phase, "offline-verification");
    releaseCommit();
    await assert.rejects(admission,
      (error) => error.code === "MIGRATION_BLOCKED" && /offline-verification/iu.test(error.message));
    assert.equal(await store.get(manifestKeys.document(documentId, 1)), undefined);
    assert.equal((await getMigrationStatus(store)).phase, "offline-verification");
  } finally {
    releaseCommit();
    await runtime.close();
    store.close();
  }
});

test("an interrupted batch replays idempotently and resumes without source mutation", async (t) => {
  const directory = temporaryDirectory(t, "migration-resume");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  createSource(sourcePath);
  const before = sourceSnapshot(sourcePath);
  let store = await RocksStore.open(storePath);

  await assert.rejects(startMigration(store, { sourcePath }),
    (error) => error instanceof TypeError && /offline: true/iu.test(error.message));
  await assert.rejects(startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 3,
    faultInjector: ({ boundary }) => boundary === "after-document-commit",
  }), (error) => error.code === "ERR_MIGRATION_INTERRUPTED");
  const interruptedStatus = await getMigrationStatus(store);
  assert.equal(interruptedStatus.migratedCount, 0);
  const retentionStartedAt = interruptedStatus.checkpoint.retentionStartedAt;
  assert.ok(Number.isSafeInteger(retentionStartedAt));
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 1);
  store.close();

  store = await RocksStore.open(storePath);
  t.after(() => store.close());
  const resumed = await startMigration(store, { sourcePath, offline: true, batchSize: 2 });
  assert.equal(resumed.status.phase, "offline-verification");
  assert.equal(resumed.status.migratedCount, 4);
  assert.equal(resumed.status.failedCount, 0);
  assert.equal(resumed.status.checkpoint.retentionStartedAt, retentionStartedAt);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 4);

  const source = SqliteArchiveSource.open(sourcePath);
  const rows = source.readBatch(0, 100);
  const info = source.info();
  source.close();
  const sourced = rows.find(({ id }) => id === "sourced-turn");
  const legacy = rows.find(({ id }) => id === "legacy-turn");
  const malformed = rows.find(({ id }) => id === "malformed-turn");
  assert.equal(
    (await readMigratedDocument(store, info.databaseId, sourced.sourceOrderingKey)).text,
    sourced.text,
  );
  assert.equal(
    (await store.get(manifestKeys.document("sourced-turn", 1))).sourceKey,
    "user:1::aaa",
  );
  const legacyManifest = await store.get(manifestKeys.document("legacy-turn", 1));
  assert.match(legacyManifest.sourceKey, /^sqlite:/u);
  assert.equal(legacyManifest.sourceKeyStatus, "unavailable");
  assert.deepEqual(legacyManifest.sourceMessageKeys, []);
  assert.equal(legacyManifest.retentionClass, "conversation-source");
  assert.equal(
    legacyManifest.expiresAt,
    retentionStartedAt + DEFAULT_RETENTION_LIFETIMES_MS["conversation-source"],
  );
  const toolManifest = await store.get(manifestKeys.document("tool-result", 1));
  assert.equal(toolManifest.retentionClass, "ephemeral-payload");
  assert.equal(
    toolManifest.expiresAt,
    retentionStartedAt + DEFAULT_RETENTION_LIFETIMES_MS["ephemeral-payload"],
  );
  assert.deepEqual(await store.get(manifestKeys.expiry(
    toolManifest.expiresAt,
    toolManifest.retentionClass,
    "tool-result",
    1,
  )), {
    documentId: "tool-result",
    documentVersion: 1,
    retentionClass: "ephemeral-payload",
    expiresAt: toolManifest.expiresAt,
  });
  assert.equal(
    (await readMigratedDocument(store, info.databaseId, malformed.sourceOrderingKey))
      .provenance.sourceMessages.status,
    "metadata-invalid",
  );

  const verification = await verifyMigration(store, { sourcePath });
  assert.equal(verification.status, "passed");
  assert.equal(verification.checked, 4);
  assert.equal(verification.missing, 0);
  assert.equal(verification.extra, 0);
  assert.equal(verification.provenanceDifferences, 0);
  assert.equal(verification.recallDifferences, 0);
  assert.equal(verification.differences, 0);
  assert.equal(verification.failures, 0);
  assert.equal(verification.sampledDifferences, 0);
  assert.equal(verification.samplesTruncated, false);
  assert.match(verification.comparisonHash, /^sha256:[a-f0-9]{64}$/u);
  const outboxCount = store.scan([KEYSPACE.OUTBOX]).length;
  assert.equal((await startMigration(store, { sourcePath, offline: true })).status.migratedCount, 4);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, outboxCount);
  assert.deepEqual(sourceSnapshot(sourcePath), before);
});

test("an acknowledged migration checkpoint survives SIGKILL and resumes exactly once", async (t) => {
  const directory = temporaryDirectory(t, "migration-checkpoint-sigkill");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  createSource(sourcePath);
  const storeUrl = new URL("../src/rocksdb/store.js", import.meta.url).href;
  const migrationUrl = new URL("../src/migration/index.js", import.meta.url).href;
  const childSource = `
    import { RocksStore } from ${JSON.stringify(storeUrl)};
    import { startMigration } from ${JSON.stringify(migrationUrl)};
    const store = await RocksStore.open(process.env.MIGRATION_STORE_PATH);
    await startMigration(store, {
      sourcePath: process.env.MIGRATION_SOURCE_PATH,
      offline: true,
      batchSize: 1,
      faultInjector: async ({ boundary }) => {
        if (boundary !== "after-checkpoint") return false;
        await new Promise((resolve) => process.stdout.write("CHECKPOINT_ACK\\n", resolve));
        if (process.platform === "win32") process.abort();
        else process.kill(process.pid, "SIGKILL");
        return false;
      },
    });
  `;
  const killed = await runProcess(process.execPath, ["--input-type=module", "-e", childSource], {
    env: {
      ...process.env,
      MIGRATION_STORE_PATH: storePath,
      MIGRATION_SOURCE_PATH: sourcePath,
    },
  });
  assert.match(killed.stdout, /CHECKPOINT_ACK/u, killed.stderr);
  assert.equal(killed.status === null || killed.status !== 0 || killed.signal !== null, true);

  const store = await RocksStore.open(storePath);
  t.after(() => store.close());
  const checkpointed = await getMigrationStatus(store);
  assert.equal(checkpointed.phase, "offline-copy");
  assert.equal(checkpointed.migratedCount, 1);
  const resumed = await startMigration(store, { sourcePath, offline: true, batchSize: 1 });
  assert.equal(resumed.status.phase, "offline-verification");
  assert.equal(resumed.status.migratedCount, 4);
  assert.equal(store.scan([KEYSPACE.OUTBOX]).length, 4);
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
});

test("a successful retry atomically reclaims its resolved migration failure", async (t) => {
  const directory = temporaryDirectory(t, "migration-failure-retirement");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const source = SqliteArchiveSource.open(sourcePath);
  const info = source.info();
  const first = source.readBatch(0, 1)[0];
  source.close();
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const commitCanonical = store.commitCanonical.bind(store);
  let injected = false;
  store.commitCanonical = async (admission) => {
    if (!injected) {
      injected = true;
      throw new Error("injected retryable migration failure");
    }
    return commitCanonical(admission);
  };

  await assert.rejects(
    startMigration(store, { sourcePath, offline: true }),
    (error) => error.code === "MIGRATION_BLOCKED",
  );
  const failureKey = migrationKeys.failure(info.databaseId, first.sourceOrderingKey);
  assert.equal((await store.get(failureKey)).attempts, 1);
  assert.equal((await getMigrationStatus(store)).failedCount, 1);

  store.commitCanonical = commitCanonical;
  const resumed = await startMigration(store, { sourcePath, offline: true });
  assert.equal(resumed.status.failedCount, 0);
  assert.equal(await store.get(failureKey), undefined);
});

test("resume revalidates every completed row, not only the last batch", async (t) => {
  const directory = temporaryDirectory(t, "migration-revalidate");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const first = await startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 1,
    maxBatches: 3,
  });
  assert.equal(first.status.phase, "offline-copy");
  assert.equal(first.status.migratedCount, 3);

  const source = SqliteArchiveSource.open(sourcePath);
  const changedId = source.readBatch(0, 1)[0].id;
  source.close();
  assert.notEqual(changedId, first.status.checkpoint.lastBatch.lastDocumentId);
  const writer = new DatabaseSync(sourcePath);
  writer.prepare("UPDATE documents SET text = text || ' changed' WHERE id = ?").run(changedId);
  writer.close();

  await assert.rejects(
    startMigration(store, { sourcePath, offline: true, batchSize: 2 }),
    (error) => error instanceof MigrationSourceMismatchError
      && /previously completed.*changed/iu.test(error.message),
  );
  assert.equal((await getMigrationStatus(store)).migratedCount, 3);
});

test("a source change during copy cannot produce a stale completed checkpoint", async (t) => {
  const directory = temporaryDirectory(t, "migration-source-race");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  let changed = false;

  await assert.rejects(startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 2,
    faultInjector: ({ boundary }) => {
      if (changed || boundary !== "after-document-commit") return false;
      changed = true;
      const writer = new DatabaseSync(sourcePath);
      writer.prepare("UPDATE documents SET text = text || ' raced' WHERE id = ?")
        .run("legacy-turn");
      writer.close();
      return false;
    },
  }), (error) => error instanceof MigrationSourceMismatchError
    && /source corpus changed/iu.test(error.message));

  const status = await getMigrationStatus(store);
  assert.equal(status.phase, "offline-copy");
  assert.equal(status.checkpoint.completed, false);
});

test("resume accepts newly appended source rows after revalidating the completed prefix", async (t) => {
  const directory = temporaryDirectory(t, "migration-source-append");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const partial = await startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 2,
    maxBatches: 1,
  });
  assert.equal(partial.status.migratedCount, 2);

  const archive = new Archive(sourcePath);
  archive.put({
    id: "appended-turn",
    sessionId: "session-new",
    project: "/workspace/project",
    kind: "turn",
    createdAt: 50,
    text: "appended while historical copy was paused",
    metadata: {
      sourceMessageKeys: ["user:appended"],
      sourceFirstKey: "user:appended",
      sourceLastKey: "user:appended",
      sourceMessageCount: 1,
    },
  }, { deferPrune: true });
  archive.close();

  const resumed = await startMigration(store, { sourcePath, offline: true, batchSize: 2 });
  assert.equal(resumed.status.phase, "offline-verification");
  assert.equal(resumed.status.migratedCount, 5);
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
});

test("migration preserves duplicate ordered source keys and documents unavailable provenance", async (t) => {
  const directory = temporaryDirectory(t, "migration-source-keys");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const database = new DatabaseSync(sourcePath);
  const metadata = JSON.parse(database.prepare(
    "SELECT metadata_json FROM documents WHERE id = ?",
  ).get("sourced-turn").metadata_json);
  metadata.sourceMessageKeys = ["user:1::aaa", "user:1::aaa", "assistant:2::bbb"];
  metadata.sourceMessageCount = metadata.sourceMessageKeys.length;
  metadata.sourceFirstKey = metadata.sourceMessageKeys[0];
  metadata.sourceLastKey = metadata.sourceMessageKeys.at(-1);
  database.prepare("UPDATE documents SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(metadata), "sourced-turn");
  database.close();
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const migrated = await startMigration(store, { sourcePath, offline: true });
  const manifest = await store.get(manifestKeys.document("sourced-turn", 1));
  assert.equal(manifest.sourceKeyStatus, "preserved");
  assert.deepEqual(manifest.sourceMessageKeys, metadata.sourceMessageKeys);
  const source = SqliteArchiveSource.open(sourcePath);
  const row = source.readBatch(0, 100).find(({ id }) => id === "sourced-turn");
  source.close();
  const sourceRecord = await store.get(migrationKeys.source(
    migrated.status.checkpoint.sourceDatabaseId,
    row.sourceOrderingKey,
  ));
  assert.deepEqual(sourceRecord.sourceMessageKeys, metadata.sourceMessageKeys);
  assert.equal(sourceRecord.sourceKeyStatus, "preserved");
});

test("canonical retirement also reclaims its document-owned SQLite provenance", async (t) => {
  const directory = temporaryDirectory(t, "migration-provenance-retirement");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    store.close();
  });
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const sourceId = migrated.status.checkpoint.sourceDatabaseId;
  const source = SqliteArchiveSource.open(sourcePath);
  const row = source.readBatch(0, 100).find(({ id }) => id === "legacy-turn");
  source.close();
  const sourceRecordKey = migrationKeys.source(sourceId, row.sourceOrderingKey);
  const sourceReferenceKey = derivedKeys.reference(
    row.id,
    1,
    encodeKey(sourceRecordKey),
  );
  assert.notEqual(await store.get(sourceRecordKey), undefined);
  assert.notEqual(await store.get(sourceReferenceKey), undefined);
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");

  runtime = await createDaemonOperations(store);
  await runtime.put({
    idempotencyKey: "migration-provenance-authority",
    document: {
      documentId: "post-migration-authority",
      version: 1,
      sourceKey: "user:post-migration-authority",
      sourceMessageKeys: ["user:post-migration-authority"],
      sourceKeyStatus: "preserved",
      sessionId: "session-authority",
      project: "/workspace/project",
      kind: "turn",
      createdAt: 50,
      text: "seal RocksDB authority before provenance retirement",
      metadata: {},
    },
    retentionClass: "conversation-source",
  }, { project: "/workspace/project" });
  assert.equal((await getMigrationStatus(store)).phase, "rocksdb-authority");

  await renewDocumentExpiry(store, {
    documentId: row.id,
    version: 1,
    retentionClass: "conversation-source",
    expiresAt: 100,
    now: 50,
  });
  for (let wave = 0; wave < 20 && await store.get(sourceRecordKey) !== undefined; wave += 1) {
    await runtime.runRetentionWave({ now: 200, force: false, batchSize: 1 });
  }
  assert.equal(await store.get(manifestKeys.document(row.id, 1)), undefined);
  assert.equal(await store.get(sourceRecordKey), undefined);
  assert.equal(await store.get(sourceReferenceKey), undefined);
  assert.equal((await getMigrationStatus(store)).phase, "rocksdb-authority");
});

test("shadow comparisons separate recall, rank, location, and score-mode differences", () => {
  const evidence = {
    id: "doc-1",
    sessionId: "s",
    project: "p",
    kind: "turn",
    createdAt: 1,
    text: "exact evidence",
    metadata: {},
    provenance: { archive: { id: "doc-1", kind: "turn" } },
  };
  assert.deepEqual(compareRecallEvidence(
    evidence,
    { ...evidence, locator: "opaque", score: 99, presentation: { truncated: true } },
  ), []);
  assert.equal(compareRecallEvidence(evidence, { ...evidence, text: "changed" })[0].type,
    "recall-evidence");

  const differences = compareSearchResults({
    mode: "lexical",
    results: [
      { id: "a", startByte: 10, endByte: 20 },
      { id: "b", startByte: 30, endByte: 40 },
    ],
  }, {
    mode: "hybrid",
    results: [
      { id: "b", startByte: 31, endByte: 40 },
      { id: "a", startByte: 10, endByte: 20 },
      { id: "c", startByte: 0, endByte: 1 },
    ],
  });
  assert.deepEqual(new Set(differences.map(({ type }) => type)), new Set([
    "search-rank",
    "search-snippet-location",
    "search-score-mode",
    "search-candidate-extra",
  ]));

  const expiresAt = Date.now() + 60_000;
  const allowed = applyDifferenceAllowlist(differences, [{
    type: "search-rank",
    rationale: "temporary ranking calibration",
    expiresAt,
  }]);
  assert.ok(allowed.filter(({ type }) => type === "search-rank").every(({ allowed: value }) => value));
  const canonical = createShadowDifference("missing-canonical", { documentId: "a" }, {
    allowlist: [{
      type: "missing-canonical",
      documentId: "a",
      rationale: "must never apply",
      expiresAt,
    }],
  });
  assert.equal(canonical.allowed, false);
});

test("verification persists structured failures and exposes them in status", async (t) => {
  const directory = temporaryDirectory(t, "migration-differences");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const sampled = await recordShadowDifferences(store, {
    sourceId: migrated.status.checkpoint.sourceDatabaseId,
    kind: "search",
    differences: [createShadowDifference("search-rank", {
      documentId: "sourced-turn",
      expected: { rank: 0 },
      actual: { rank: 1 },
    })],
  });
  assert.equal(sampled.failures, 1);
  await store.remove(manifestKeys.document("legacy-turn", 1));

  const verification = await verifyMigration(store, { sourcePath });
  assert.equal(verification.status, "failed");
  assert.equal(verification.missing, 1);
  const differences = listMigrationDifferences(store, {
    sourceId: migrated.status.checkpoint.sourceDatabaseId,
  });
  assert.ok(differences.some((difference) => difference.type === "missing-canonical"
    && difference.documentId === "legacy-turn"
    && difference.allowed === false));
  const status = await getMigrationStatus(store);
  assert.equal(status.phase, "blocked");
  assert.equal(status.rollbackEligible, false);
  assert.ok(status.comparisonFailures > 0);
});

test("comparison metadata keeps a bounded audit window and pins the verification run", async (t) => {
  const directory = temporaryDirectory(t, "migration-comparison-retirement");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const sourceId = migrated.status.checkpoint.sourceDatabaseId;
  await verifyMigration(store, { sourcePath });
  const verificationRunId = (await getMigrationStatus(store)).checkpoint.verification.runId;

  for (let index = 0; index < MIGRATION_COMPARISON_RUN_LIMIT + 2; index += 1) {
    await recordShadowDifferences(store, {
      sourceId,
      kind: "search",
      differences: [createShadowDifference("search-rank", {
        documentId: `bounded-${index}`,
        expected: { rank: 0 },
        actual: { rank: 1 },
      })],
    });
  }
  const many = Array.from({ length: MIGRATION_COMPARISON_DETAIL_LIMIT + 5 }, (_, index) =>
    createShadowDifference("search-rank", {
      documentId: `detail-${index}`,
      expected: { rank: 0 },
      actual: { rank: index + 1 },
    }));
  const latest = await recordShadowDifferences(store, {
    sourceId,
    kind: "search",
    differences: many,
  });

  const history = await store.get(migrationKeys.comparisonHistory(sourceId));
  assert.equal(history.runs.length, MIGRATION_COMPARISON_RUN_LIMIT + 1);
  assert.ok(history.runs.some(({ runId }) => runId === verificationRunId));
  assert.ok(history.runs.some(({ runId }) => runId === latest.runId));
  assert.notEqual(await store.get(migrationKeys.comparisonRun(sourceId, verificationRunId)), undefined);
  assert.equal(
    listMigrationDifferences(store, { sourceId, runId: latest.runId }).length,
    MIGRATION_COMPARISON_DETAIL_LIMIT,
  );
  const latestRun = await store.get(migrationKeys.comparisonRun(sourceId, latest.runId));
  assert.equal(latestRun.differenceCount, many.length);
  assert.equal(latestRun.persistedDifferenceCount, MIGRATION_COMPARISON_DETAIL_LIMIT);
  assert.equal(latestRun.detailsTruncated, true);

  const byteBounded = await recordShadowDifferences(store, {
    sourceId,
    kind: "search",
    differences: [
      createShadowDifference("search-rank", {
        documentId: "oversized-detail",
        expected: { evidence: "x".repeat(MIGRATION_COMPARISON_DETAIL_BYTES + 1) },
        actual: { rank: 1 },
      }),
      createShadowDifference("search-rank", {
        documentId: "retained-small-detail",
        expected: { rank: 0 },
        actual: { rank: 1 },
      }),
    ],
  });
  const byteBoundedRun = await store.get(migrationKeys.comparisonRun(
    sourceId,
    byteBounded.runId,
  ));
  assert.ok(byteBoundedRun.persistedDifferenceBytes <= MIGRATION_COMPARISON_DETAIL_BYTES);
  assert.equal(byteBoundedRun.detailsTruncated, true);
  assert.deepEqual(
    listMigrationDifferences(store, { sourceId, runId: byteBounded.runId })
      .map(({ documentId }) => documentId),
    ["retained-small-detail"],
  );
  assert.equal(
    store.scan(["migration", "comparison-run", sourceId]).length,
    MIGRATION_COMPARISON_RUN_LIMIT + 1,
  );
  assert.ok(store.scan(["migration", "comparison", sourceId]).length
    <= MIGRATION_COMPARISON_DETAIL_LIMIT + MIGRATION_COMPARISON_RUN_LIMIT - 1);
});

test("comparison accounting deterministically includes allowed and disallowed differences", async (t) => {
  const directory = temporaryDirectory(t, "migration-comparison-accounting");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const sourceId = migrated.status.checkpoint.sourceDatabaseId;
  const now = 1_000;
  const differences = [
    createShadowDifference("search-rank", {
      documentId: "allowed-rank",
      expected: { rank: 0 },
      actual: { rank: 1 },
    }),
    createShadowDifference("search-rank", {
      documentId: "failed-rank",
      expected: { rank: 0 },
      actual: { rank: 2 },
    }),
  ];
  const options = {
    sourceId,
    kind: "search",
    differences,
    allowlist: [{
      type: "search-rank",
      documentId: "allowed-rank",
      rationale: "temporary rank calibration",
      expiresAt: now + 1_000,
    }],
    now,
  };
  const first = await recordShadowDifferences(store, options);
  const second = await recordShadowDifferences(store, options);
  assert.equal(first.differenceCount, 2);
  assert.equal(first.failureCount, 1);
  assert.equal(second.comparisonHash, first.comparisonHash);

  const run = await store.get(migrationKeys.comparisonRun(sourceId, first.runId));
  assert.deepEqual(run.differenceCounts, { "search-rank": 2 });
  assert.deepEqual(run.failureCounts, { "search-rank": 1 });
  assert.deepEqual(
    listMigrationDifferences(store, { sourceId, runId: first.runId })
      .map(({ documentId, allowed }) => ({ documentId, allowed })),
    [
      { documentId: "allowed-rank", allowed: true },
      { documentId: "failed-rank", allowed: false },
    ],
  );
});

test("verification detects full provenance tampering and source records in untracked buckets", async (t) => {
  const directory = temporaryDirectory(t, "migration-adversarial-verifier");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const sourceId = migrated.status.checkpoint.sourceDatabaseId;
  const source = SqliteArchiveSource.open(sourcePath);
  const row = source.readBatch(0, 1)[0];
  source.close();
  const key = migrationKeys.source(sourceId, row.sourceOrderingKey);
  const sourceRecord = await store.get(key);
  await store.put(key, {
    ...sourceRecord,
    sourceRowId: sourceRecord.sourceRowId + 1,
    sourceKey: "tampered-source-key",
    sourceKeyStatus: sourceRecord.sourceKeyStatus === "preserved" ? "unavailable" : "preserved",
  }, { kind: "sqlite-source-document" });
  await store.put([
    "migration",
    "source",
    sourceId,
    999,
    row.sourceOrderingKey,
  ], sourceRecord, { kind: "sqlite-source-document" });

  const verification = await verifyMigration(store, { sourcePath });
  assert.equal(verification.status, "failed");
  assert.equal(verification.extra, 1);
  assert.equal(verification.provenanceDifferences, 1);
  const differences = listMigrationDifferences(store, { sourceId });
  assert.ok(differences.some(({ type }) => type === "source-record"));
  assert.ok(differences.some(({ type }) => type === "provenance"));
  assert.ok(differences.some(({ type }) => type === "extra-canonical"));
});

test("verification streams multi-page corpora and hashes mismatches beyond bounded samples", async (t) => {
  const directory = temporaryDirectory(t, "migration-streaming-verifier");
  const sourcePath = join(directory, "archive.db");
  const artifactPath = join(directory, "verification.json");
  createSource(sourcePath);
  appendSourceDocuments(sourcePath, (MIGRATION_VERIFICATION_PAGE_SIZE * 1_024) + 17);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: MIGRATION_VERIFICATION_PAGE_SIZE,
  });
  const rogueCount = MIGRATION_COMPARISON_DETAIL_LIMIT + 44;
  await store.transaction(async (transaction) => {
    for (let index = 0; index < rogueCount; index += 1) {
      const documentId = `rogue-${String(index).padStart(4, "0")}`;
      await transaction.put(manifestKeys.document(documentId, 1), {
        documentId,
        version: 1,
        rogue: true,
      }, { kind: "document-manifest" });
    }
  });

  const verifyWithPageTrace = async (options = {}) => {
    const originalScan = store.scan;
    const pageSizes = [];
    store.scan = function tracedScan(prefix, scanOptions) {
      const page = originalScan.call(this, prefix, scanOptions);
      if (prefix.length === 1 && prefix[0] === KEYSPACE.DOCUMENT
        || (prefix.length === 3 && prefix[0] === "migration" && prefix[1] === "source")) {
        assert.equal(scanOptions.limit, MIGRATION_VERIFICATION_PAGE_SIZE);
        pageSizes.push(page.length);
      }
      return page;
    };
    try {
      return {
        result: await verifyMigration(store, { sourcePath, now: 1_000, ...options }),
        pageSizes,
      };
    } finally {
      store.scan = originalScan;
    }
  };

  const first = await verifyWithPageTrace({ artifactPath });
  assert.equal(first.result.status, "failed");
  assert.equal(first.result.checked, (MIGRATION_VERIFICATION_PAGE_SIZE * 1_024) + 21);
  assert.equal(first.result.extra, rogueCount);
  assert.equal(first.result.differences, rogueCount);
  assert.equal(first.result.failures, rogueCount);
  assert.deepEqual(first.result.differenceCounts, { "extra-canonical": rogueCount });
  assert.deepEqual(first.result.failureCounts, { "extra-canonical": rogueCount });
  assert.equal(first.result.sampledDifferences, MIGRATION_COMPARISON_DETAIL_LIMIT);
  assert.equal(first.result.samplesTruncated, true);
  assert.ok(first.pageSizes.length >= 6);
  assert.ok(first.pageSizes.every((size) => size <= MIGRATION_VERIFICATION_PAGE_SIZE));

  const status = await getMigrationStatus(store);
  const persistedRun = await store.get(migrationKeys.comparisonRun(
    migrated.status.checkpoint.sourceDatabaseId,
    status.checkpoint.verification.runId,
  ));
  assert.equal(persistedRun.differenceCount, rogueCount);
  assert.equal(persistedRun.failureCount, rogueCount);
  assert.equal(persistedRun.persistedDifferenceCount, MIGRATION_COMPARISON_DETAIL_LIMIT);
  assert.equal(persistedRun.detailsTruncated, true);
  assert.equal(persistedRun.comparisonHash, first.result.comparisonHash);

  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.verification.differences, rogueCount);
  assert.equal(artifact.verification.failures, rogueCount);
  assert.equal(artifact.differences.length, MIGRATION_COMPARISON_DETAIL_LIMIT);
  assert.equal(artifact.run.comparisonHash, first.result.comparisonHash);
  assert.ok(readFileSync(artifactPath).length < MIGRATION_COMPARISON_DETAIL_BYTES + 200_000);

  const second = await verifyWithPageTrace();
  assert.equal(second.result.comparisonHash, first.result.comparisonHash);
  assert.deepEqual(second.result.differenceCounts, first.result.differenceCounts);
  assert.deepEqual(second.result.failureCounts, first.result.failureCounts);
});

test("verification artifacts cannot alias SQLite rollback or RocksDB store files", async (t) => {
  const directory = temporaryDirectory(t, "migration-artifact-paths");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  createSource(sourcePath);
  const store = await RocksStore.open(storePath);
  t.after(() => store.close());
  await startMigration(store, { sourcePath, offline: true });
  const before = sourceSnapshot(sourcePath);

  const sourceHardlink = join(directory, "source-hardlink.db");
  const sourceSymlink = join(directory, "source-symlink.db");
  const sourceParentSymlink = join(directory, "source-parent-link");
  linkSync(sourcePath, sourceHardlink);
  symlinkSync(sourcePath, sourceSymlink);
  symlinkSync(dirname(sourcePath), sourceParentSymlink, "dir");
  const storeFile = readdirSync(storePath, { withFileTypes: true })
    .find((entry) => entry.isFile());
  assert.ok(storeFile);
  const storeHardlink = join(directory, "store-hardlink");
  linkSync(join(storePath, storeFile.name), storeHardlink);

  for (const artifactPath of [
    sourcePath,
    `${sourcePath}-wal`,
    `${sourcePath}-shm`,
    `${sourcePath}-journal`,
    sourceHardlink,
    sourceSymlink,
    join(sourceParentSymlink, basename(sourcePath)),
    join(storePath, "verification.json"),
    storeHardlink,
  ]) {
    await assert.rejects(
      verifyMigration(store, { sourcePath, artifactPath }),
      (error) => error.code === "MIGRATION_BLOCKED" && /artifact/iu.test(error.message),
    );
    assert.equal((await getMigrationStatus(store)).phase, "offline-verification");
    assert.deepEqual(sourceSnapshot(sourcePath), before);
  }

  const validArtifact = join(directory, "evidence", "verification.json");
  const verified = await verifyMigration(store, { sourcePath, artifactPath: validArtifact });
  assert.equal(verified.status, "passed");
  assert.equal(verified.artifactPath, validArtifact);
  assert.deepEqual(sourceSnapshot(sourcePath), before);
});

test("near-cap migration start, resume, and verification stay below the 256 MiB RSS gate", async (t) => {
  const directory = temporaryDirectory(t, "migration-verification-rss");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  const migrationUrl = new URL("../src/migration/index.js", import.meta.url).href;
  const storeUrl = new URL("../src/rocksdb/store.js", import.meta.url).href;
  const contractUrl = new URL("../src/store/store-contract.js", import.meta.url).href;
  const setupSource = `
    import { DatabaseSync } from "node:sqlite";
    import { MAX_DOCUMENT_TEXT_BYTES } from ${JSON.stringify(contractUrl)};
    const database = new DatabaseSync(process.env.MIGRATION_SOURCE_PATH);
    database.exec(\`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    \`);
    const insert = database.prepare(\`
      INSERT INTO documents(id, session_id, project, kind, created_at, text, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    \`);
    const text = "x".repeat(MAX_DOCUMENT_TEXT_BYTES - 1_024);
    database.exec("BEGIN IMMEDIATE;");
    for (let index = 0; index < 5; index += 1) {
      insert.run(
        \`near-cap-\${index}\`,
        "near-cap-session",
        "/workspace/project",
        "turn",
        index + 1,
        text,
        "{}",
      );
    }
    database.exec("COMMIT;");
    database.close();
  `;
  const environment = {
    ...process.env,
    MIGRATION_SOURCE_PATH: sourcePath,
    MIGRATION_STORE_PATH: storePath,
  };
  const setup = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", setupSource],
    { env: environment },
  );
  assert.equal(setup.status, 0, setup.stderr);

  const migrationSource = `
    import { RocksStore } from ${JSON.stringify(storeUrl)};
    import { startMigration } from ${JSON.stringify(migrationUrl)};
    const store = await RocksStore.open(process.env.MIGRATION_STORE_PATH);
    globalThis.gc();
    const baselineRss = process.memoryUsage.rss();
    const result = await startMigration(store, {
      sourcePath: process.env.MIGRATION_SOURCE_PATH,
      offline: true,
      batchSize: 1,
      ...(process.env.MIGRATION_MAX_BATCHES === undefined
        ? {}
        : { maxBatches: Number(process.env.MIGRATION_MAX_BATCHES) }),
    });
    globalThis.gc();
    const finalRss = process.memoryUsage.rss();
    const peakRss = process.resourceUsage().maxRSS * 1_024;
    store.close();
    process.stdout.write(JSON.stringify({
      phase: result.status.phase,
      migratedCount: result.status.migratedCount,
      baselineRss,
      finalRss,
      peakRss,
      headroomBytes: (256 * 1_024 * 1_024) - peakRss,
    }));
  `;
  const initial = await runProcess(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", migrationSource],
    { env: { ...environment, MIGRATION_MAX_BATCHES: "1" } },
  );
  assert.equal(initial.status, 0, initial.stderr);
  const initialMetrics = JSON.parse(initial.stdout);
  assert.equal(initialMetrics.phase, "offline-copy");
  assert.equal(initialMetrics.migratedCount, 1);
  assert.ok(initialMetrics.peakRss < 256 * 1_024 * 1_024, JSON.stringify(initialMetrics));

  const resumed = await runProcess(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", migrationSource],
    { env: environment },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumeMetrics = JSON.parse(resumed.stdout);
  assert.equal(resumeMetrics.phase, "offline-verification");
  assert.equal(resumeMetrics.migratedCount, 5);
  assert.ok(resumeMetrics.peakRss < 256 * 1_024 * 1_024, JSON.stringify(resumeMetrics));

  const verificationSource = `
    import { RocksStore } from ${JSON.stringify(storeUrl)};
    import { verifyMigration } from ${JSON.stringify(migrationUrl)};
    const store = await RocksStore.open(process.env.MIGRATION_STORE_PATH);
    globalThis.gc();
    const baselineRss = process.memoryUsage.rss();
    const result = await verifyMigration(store, {
      sourcePath: process.env.MIGRATION_SOURCE_PATH,
      sampleLimit: 1,
    });
    globalThis.gc();
    const finalRss = process.memoryUsage.rss();
    const peakRss = process.resourceUsage().maxRSS * 1_024;
    store.close();
    process.stdout.write(JSON.stringify({
      status: result.status,
      checked: result.checked,
      baselineRss,
      finalRss,
      peakRss,
      headroomBytes: (256 * 1_024 * 1_024) - peakRss,
    }));
  `;
  const verified = await runProcess(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", verificationSource],
    { env: environment },
  );
  assert.equal(verified.status, 0, verified.stderr);
  const metrics = JSON.parse(verified.stdout);
  assert.equal(metrics.status, "passed");
  assert.equal(metrics.checked, 5);
  assert.ok(metrics.peakRss < 256 * 1_024 * 1_024, JSON.stringify(metrics));
  assert.ok(metrics.headroomBytes > 0, JSON.stringify(metrics));
  t.diagnostic(`near-cap initial RSS ${JSON.stringify(initialMetrics)}`);
  t.diagnostic(`near-cap resume RSS ${JSON.stringify(resumeMetrics)}`);
  t.diagnostic(`near-cap verification RSS ${JSON.stringify(metrics)}`);
});

test("verification rejects an unexpected canonical document without a migration source record", async (t) => {
  const directory = temporaryDirectory(t, "migration-extra-canonical");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const migrated = await startMigration(store, { sourcePath, offline: true });
  const rogue = prepareDocumentAdmission({
    idempotencyKey: "rogue-during-offline-verification",
    document: {
      documentId: "rogue-canonical",
      version: 1,
      sourceKey: "user:rogue-canonical",
      sourceMessageKeys: ["user:rogue-canonical"],
      sourceKeyStatus: "preserved",
      sessionId: "rogue-session",
      project: "/workspace/project",
      kind: "turn",
      createdAt: migrated.status.checkpoint.retentionStartedAt,
      text: "This canonical document has no SQLite source row.",
      metadata: {},
    },
    retentionClass: "conversation-source",
    expiresAt: migrated.status.checkpoint.retentionStartedAt
      + DEFAULT_RETENTION_LIFETIMES_MS["conversation-source"],
  });
  await store.commitCanonical(rogue);

  const verification = await verifyMigration(store, { sourcePath });
  assert.equal(verification.status, "failed");
  assert.equal(verification.extra, 1);
  assert.equal((await getMigrationStatus(store)).phase, "blocked");
  const sourceId = migrated.status.checkpoint.sourceDatabaseId;
  assert.ok(listMigrationDifferences(store, { sourceId })
    .some((difference) => difference.type === "extra-canonical"
      && difference.documentId === "rogue-canonical"));
});

test("a stale offline-ready authority gate cannot seal after verification is reset", async (t) => {
  const directory = temporaryDirectory(t, "migration-stale-authority-gate");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  await startMigration(store, { sourcePath, offline: true });
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");

  const request = {
    idempotencyKey: "stale-authority-admission",
    document: {
      documentId: "stale-authority-document",
      version: 1,
      sourceKey: "user:stale-authority",
      sourceMessageKeys: ["user:stale-authority"],
      sourceKeyStatus: "preserved",
      sessionId: "stale-authority-session",
      project: "/workspace/project",
      kind: "turn",
      createdAt: Date.now(),
      text: "This write must not cross a reset verification gate.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  };
  const gate = await prepareMigrationAdmission(store, {
    requestId: request.idempotencyKey,
    documentId: request.document.documentId,
  });
  assert.equal(gate.sealsAuthority, true);

  const rerun = await startMigration(store, { sourcePath, offline: true });
  assert.equal(rerun.status.phase, "offline-verification");
  assert.equal(rerun.status.checkpoint.verification, undefined);
  const admission = prepareDocumentAdmission(request);
  await assert.rejects(store.commitCanonical({
    ...admission,
    mustMatch: gate.mustMatch,
    transitions: [...admission.transitions, ...gate.transitions],
  }), (error) => error.code === "CONFLICT");
  assert.equal(await store.get(manifestKeys.document(request.document.documentId, 1)), undefined);
  assert.equal((await getMigrationStatus(store)).phase, "offline-verification");
});

test("offline rollback remains available only for a verified, untouched SQLite source", async (t) => {
  const directory = temporaryDirectory(t, "migration-rollback-status");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());
  const before = sourceSnapshot(sourcePath);
  await startMigration(store, { sourcePath, offline: true });
  const awaitingVerification = await getMigrationStatus(store);
  assert.equal(awaitingVerification.phase, "offline-verification");
  assert.equal(awaitingVerification.rollbackEligible, false);
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  assert.equal((await getMigrationStatus(store)).rollbackEligible, true);
  assert.deepEqual(sourceSnapshot(sourcePath), before);

  const rollback = new Archive(sourcePath);
  assert.equal(rollback.get("sourced-turn").text,
    "[user] Find REAP_DRAIN 🪨\n[assistant] It is in worker.ts.");
  rollback.close();
  renameSync(sourcePath, `${sourcePath}.original`);
  createSource(sourcePath);
  const replaced = await getMigrationStatus(store);
  assert.equal(replaced.phase, "blocked");
  assert.equal(replaced.rollbackEligible, false);
  rmSync(sourcePath, { force: true });
  assert.equal((await getMigrationStatus(store)).rollbackEligible, false);
});

test("daemon admission is blocked until verification and atomically seals the first RocksDB write", async (t) => {
  const directory = temporaryDirectory(t, "migration-admission-gate");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const before = sourceSnapshot(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const project = "/workspace/project";
  const request = {
    idempotencyKey: "first-rocks-authority-write",
    document: {
      documentId: "post-migration-turn",
      version: 1,
      sourceKey: "user:post-migration",
      sourceMessageKeys: ["user:post-migration"],
      sourceKeyStatus: "preserved",
      sessionId: "session-new",
      project,
      kind: "turn",
      createdAt: 60,
      text: "first RocksDB authority write",
      metadata: {},
    },
    retentionClass: "conversation-source",
  };

  await startMigration(store, {
    sourcePath,
    offline: true,
    batchSize: 1,
    maxBatches: 1,
  });
  await assert.rejects(runtime.put(request, { project }),
    (error) => error.code === "MIGRATION_BLOCKED");
  await startMigration(store, { sourcePath, offline: true });
  assert.equal((await getMigrationStatus(store)).phase, "offline-verification");
  await assert.rejects(runtime.put(request, { project }),
    (error) => error.code === "MIGRATION_BLOCKED");

  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  const ready = await getMigrationStatus(store);
  assert.equal(ready.phase, "offline-ready");
  assert.equal(ready.rollbackEligible, true);
  assert.equal((await runtime.put(request, { project })).status, "stored");
  const sealed = await getMigrationStatus(store);
  assert.equal(sealed.phase, "rocksdb-authority");
  assert.equal(sealed.rollbackEligible, false);
  assert.equal(sealed.checkpoint.authorityWrite.requestId, request.idempotencyKey);
  assert.equal((await runtime.put(request, { project })).status, "duplicate");
  await assert.rejects(verifyMigration(store, { sourcePath }),
    (error) => error.code === "MIGRATION_BLOCKED");
  assert.equal((await getMigrationStatus(store)).phase, "rocksdb-authority");
  assert.deepEqual(sourceSnapshot(sourcePath), before);
});

test("an index fault after the authority commit still acknowledges and replays the write", async (t) => {
  const directory = temporaryDirectory(t, "migration-authority-index-fault");
  const sourcePath = join(directory, "archive.db");
  createSource(sourcePath);
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const documentId = "authority-index-fault-document";
  let faulted = false;
  const runtime = await createDaemonOperations(store, {
    indexWorker: {
      fault(boundary, { claim }) {
        if (boundary !== "after-claim" || claim?.status !== "claimed" || faulted
          || claim.entry?.payload?.documentId !== documentId) return;
        faulted = true;
        throw new Error("injected authority publication fault");
      },
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  await startMigration(store, { sourcePath, offline: true });
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  await runtime.drainIndexUntilIdle();

  const project = "/workspace/project";
  const result = await runtime.put({
    idempotencyKey: "authority-index-fault-put",
    document: {
      documentId,
      version: 1,
      sourceKey: "user:authority-index-fault",
      sourceMessageKeys: ["user:authority-index-fault"],
      sourceKeyStatus: "preserved",
      sessionId: "authority-index-fault-session",
      project,
      kind: "turn",
      createdAt: 70,
      text: "Authority and canonical bytes commit before replayable index publication.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  }, { project });
  assert.equal(result.status, "stored");
  assert.equal(faulted, true);
  assert.equal((await getMigrationStatus(store)).phase, "rocksdb-authority");

  let outboxState;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    outboxState = await store.get(outboxKeys.state(result.outboxSequence));
    if (outboxState?.status === "processed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(outboxState?.status, "processed");
  assert.equal(runtime.backgroundErrors.some(({ message }) =>
    /injected authority publication fault/u.test(message)), true);
});

test("the acknowledged first RocksDB authority write survives SIGKILL atomically", async (t) => {
  const directory = temporaryDirectory(t, "migration-authority-sigkill");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  createSource(sourcePath);
  let store = await RocksStore.open(storePath);
  await startMigration(store, { sourcePath, offline: true });
  assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  store.close();

  const request = {
    idempotencyKey: "sigkill-authority-write",
    document: {
      documentId: "sigkill-authority-document",
      version: 1,
      sourceKey: "user:sigkill-authority",
      sourceMessageKeys: ["user:sigkill-authority"],
      sourceKeyStatus: "preserved",
      sessionId: "sigkill-authority-session",
      project: "/workspace/project",
      kind: "turn",
      createdAt: Date.now(),
      text: "The canonical document and authority seal share one acknowledgement boundary.",
      metadata: {},
    },
    retentionClass: "conversation-source",
  };
  const storeUrl = new URL("../src/rocksdb/store.js", import.meta.url).href;
  const operationsUrl = new URL("../src/daemon/operations.js", import.meta.url).href;
  const childSource = `
    import { RocksStore } from ${JSON.stringify(storeUrl)};
    import { createDaemonOperations } from ${JSON.stringify(operationsUrl)};
    const request = ${JSON.stringify(request)};
    const store = await RocksStore.open(process.env.MIGRATION_STORE_PATH);
    const runtime = await createDaemonOperations(store);
    await runtime.put(request, { project: request.document.project });
    await new Promise((resolve) => process.stdout.write("AUTHORITY_ACK\\n", resolve));
    if (process.platform === "win32") process.abort();
    else process.kill(process.pid, "SIGKILL");
  `;
  const killed = await runProcess(process.execPath, ["--input-type=module", "-e", childSource], {
    env: { ...process.env, MIGRATION_STORE_PATH: storePath },
  });
  assert.match(killed.stdout, /AUTHORITY_ACK/u, killed.stderr);
  assert.equal(killed.status === null || killed.status !== 0 || killed.signal !== null, true);

  store = await RocksStore.open(storePath);
  const runtime = await createDaemonOperations(store);
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const status = await getMigrationStatus(store);
  assert.equal(status.phase, "rocksdb-authority");
  assert.equal(status.checkpoint.authorityWrite.requestId, request.idempotencyKey);
  assert.equal(
    (await store.get(manifestKeys.document(request.document.documentId, 1))).documentId,
    request.document.documentId,
  );
  assert.equal((await runtime.put(request, { project: request.document.project })).status, "duplicate");
  assert.equal(store.scan([KEYSPACE.DOCUMENT, request.document.documentId]).length, 1);
});

test("migration CLI emits JSON for start, status, verify, and an artifact", (t) => {
  const directory = temporaryDirectory(t, "migration-cli");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  const artifactPath = join(directory, "verification.json");
  createSource(sourcePath);
  const cli = join(process.cwd(), "bin", "context-window-migrate.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };

  const started = run(
    "start", "--store", storePath, "--source", sourcePath, "--offline", "--batch-size", "2",
  );
  assert.equal(started.accepted, true);
  assert.equal(started.status.phase, "offline-verification");
  assert.equal(run("status", "--store", storePath).migratedCount, 4);
  const verified = run(
    "verify",
    "--store", storePath,
    "--source", sourcePath,
    "--artifact", artifactPath,
  );
  assert.equal(verified.status, "passed");
  assert.equal(verified.artifactPath, artifactPath);
  assert.ok(existsSync(artifactPath));
  assert.equal(JSON.parse(readFileSync(artifactPath, "utf8")).differences.length, 0);
  assert.equal(run("status", "--store", storePath).phase, "offline-ready");
});

test("migration CLI uses daemon RPC when the daemon owns RocksDB", async (t) => {
  const directory = temporaryDirectory(t, "migration-cli-daemon");
  const sourcePath = join(directory, "archive.db");
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  t.after(() => rmSync(socketPath, { force: true }));
  const artifactPath = join(directory, "remote-verification.json");
  createSource(sourcePath);
  const daemon = await startStoreDaemon({
    storePath,
    socketPath,
    createStore: (path) => RocksStore.open(path),
    operationHandlers: {
      "migration.status": (_payload, { store }) => getMigrationStatus(store),
      "migration.start": (payload, { store }) => startMigration(store, payload),
      "migration.verify": (payload, { store }) => verifyMigration(store, payload),
    },
  });
  t.after(() => daemon.close());
  const cli = join(process.cwd(), "bin", "context-window-migrate.js");
  const run = async (...args) => {
    const result = await runProcess(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };

  const started = await run("start", "--socket", socketPath, "--source", sourcePath,
    "--offline", "--batch-size", "2");
  assert.equal(started.status.phase, "offline-verification");
  assert.equal((await run("status", "--socket", socketPath)).migratedCount, 4);
  const verified = await run("verify", "--socket", socketPath, "--source", sourcePath,
    "--artifact", artifactPath);
  assert.equal(verified.status, "passed");
  assert.equal(verified.artifactPath, artifactPath);
  assert.equal((await run("status", "--socket", socketPath)).phase, "offline-ready");
});
