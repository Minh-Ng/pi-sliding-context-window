import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Archive } from "../src/archive/archive.js";
import { claimSqliteBackendAuthority } from "../src/archive/backend-authority.js";
import { loadConfig } from "../src/config.js";
import {
  ArchiveMigrationGuardError,
  ArchiveRecallError,
  DaemonArchive,
} from "../src/archive/daemon-archive.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { startMigration, verifyMigration } from "../src/migration/index.js";
import { formatRecalledDocument } from "../src/presentation.js";
import { estimateModelVisibleTokens } from "../src/session/model-token-budget.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { StoreClient } from "../src/store/store-client.js";
import {
  MAX_VISIBLE_SOURCE_KEYS,
  MAX_VISIBLE_SOURCE_KEY_BYTES,
  MAX_ACTIVE_HINT_MESSAGE_KEYS,
  MAX_PROTECTED_DOCUMENT_VERSIONS,
} from "../src/store/store-contract.js";

const FACADE_MODULE_URL = new URL("../src/archive/daemon-archive.js", import.meta.url).href;
const AUTHORITY_MODULE_URL = new URL("../src/archive/backend-authority.js", import.meta.url).href;

function fixture(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const storePath = join(directory, "archive.rocks");
  return {
    directory,
    storePath,
    socketPath: defaultSocketPath(storePath),
  };
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

test("facade version state is stateless and remembered locator lineage is byte-bounded", (t) => {
  const paths = fixture("context-window-facade-cache-");
  const archive = new DaemonArchive({
    storePath: paths.storePath,
    socketPath: paths.socketPath,
    project: "/project/facade-cache",
  });
  const daemonProcessId = archive.stats().processId;
  t.after(async () => {
    archive.close({ releaseProtection: false });
    await stopProcess(daemonProcessId);
    rmSync(paths.directory, { recursive: true, force: true });
  });

  assert.equal(Object.hasOwn(archive, "versionCache"), false);
  const nearMaximumLineage = Array.from(
    { length: 65 },
    (_, index) => `${index}:${"s".repeat(8_180)}`,
  );
  for (let index = 0; index < 3; index += 1) {
    archive.rememberLocatorSessionIds(`cw1.large-${index}`, nearMaximumLineage);
  }
  assert.equal(archive.locatorSessionIds.size, 1);
  assert.equal(archive.locatorSessionIdBytes <= 1 * 1_024 * 1_024, true);

  for (let index = 0; index < 5_000; index += 1) {
    archive.rememberLocatorSessionIds(`cw1.small-${index}`, ["session"]);
  }
  assert.equal(archive.locatorSessionIds.size <= 4_096, true);
  assert.equal(archive.locatorSessionIdBytes <= 1 * 1_024 * 1_024, true);
});

function syntheticProtectionFacade({
  failAtProtectCall,
  failAtReleaseCall,
  loseProtectResponseAtCall,
} = {}) {
  const archive = Object.create(DaemonArchive.prototype);
  archive.ownerId = "archive:synthetic";
  archive.protectionTtlMs = 60_000;
  archive.protectedSessionIds = new Set();
  archive.protectedDocumentIds = new Set();
  archive.protectionShardOwners = new Map();
  archive.protectionHandoffId = undefined;
  archive.closed = false;
  archive.locatorSessionIds = new Map();
  archive.locatorSessionIdBytes = 0;
  let bridgeCloseCalls = 0;
  archive.bridge = { close() { bridgeCloseCalls += 1; } };
  archive.documentVersions = (documentIds) => [...documentIds].map((documentId) => ({
    documentId,
    version: 1,
  }));
  const calls = [];
  const protectedByOwner = new Map();
  const sessionsByOwner = new Map();
  let protectCalls = 0;
  let releaseCalls = 0;
  archive.request = (operation, payload) => {
    calls.push({ operation, payload: structuredClone(payload) });
    if (operation === "store.protect") {
      protectCalls += 1;
      if (protectCalls === failAtProtectCall) throw new Error("synthetic protection failure");
      protectedByOwner.set(payload.ownerId, payload.documentVersions.map(({ documentId }) => documentId));
      sessionsByOwner.set(payload.ownerId, [...payload.sessionIds]);
      if (protectCalls === loseProtectResponseAtCall) {
        throw new Error("synthetic committed protection response loss");
      }
      return {
        ownerId: payload.ownerId,
        expiresAt: 61_000,
        protectedSessions: payload.sessionIds.length,
        protectedDocuments: payload.documentVersions.length,
      };
    }
    if (operation === "store.release-protection") {
      releaseCalls += 1;
      if (releaseCalls === failAtReleaseCall) throw new Error("synthetic release failure");
      const released = protectedByOwner.get(payload.ownerId)?.length ?? 0;
      protectedByOwner.delete(payload.ownerId);
      sessionsByOwner.delete(payload.ownerId);
      return { released };
    }
    throw new Error(`unexpected synthetic operation ${operation}`);
  };
  return {
    archive,
    calls,
    protectedByOwner,
    sessionsByOwner,
    bridgeCloseCalls: () => bridgeCloseCalls,
  };
}

test("facade shards protection deterministically without exceeding the wire cap", () => {
  const { archive, calls, protectedByOwner } = syntheticProtectionFacade();
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `checkpoint-${String(index).padStart(4, "0")}`,
  );

  const result = archive.setProtectedContext({
    sessionIds: ["session-main"],
    documentIds,
  });
  assert.equal(result, undefined, "setProtectedContext preserves its synchronous facade result");
  const initial = calls.filter(({ operation }) => operation === "store.protect");
  assert.deepEqual(initial.map(({ payload }) => payload.documentVersions.length), [1_000, 1]);
  assert.ok(initial.every(({ payload }) => (
    payload.documentVersions.length <= MAX_PROTECTED_DOCUMENT_VERSIONS
  )));
  assert.equal(new Set(initial.map(({ payload }) => payload.ownerId)).size, 2);
  assert.deepEqual(initial.map(({ payload }) => payload.sessionIds), [["session-main"], []]);
  assert.deepEqual(
    new Set([...protectedByOwner.values()].flat()),
    new Set(documentIds),
    "distinct shard owners keep every document protected",
  );

  const initialOwners = initial.map(({ payload }) => payload.ownerId);
  archive.refreshPolicyLease();
  const refreshed = calls.filter(({ operation }) => operation === "store.protect").slice(2);
  assert.deepEqual(refreshed.map(({ payload }) => payload.ownerId), initialOwners);
  assert.deepEqual(refreshed.map(({ payload }) => payload.documentVersions.length), [1_000, 1]);

  archive.setProtectedContext({
    sessionIds: ["session-main"],
    documentIds: documentIds.slice(0, MAX_PROTECTED_DOCUMENT_VERSIONS),
  });
  assert.equal(protectedByOwner.size, 1, "shrinking to the boundary releases the stale shard");
  assert.deepEqual(new Set([...protectedByOwner.values()].flat()), new Set(documentIds.slice(0, 1_000)));

  archive.setProtectedContext();
  assert.equal(protectedByOwner.size, 1, "the empty set retains the current owner heartbeat");
  assert.deepEqual([...protectedByOwner.values()], [[]]);
  assert.deepEqual(calls.at(-1).payload.documentVersions, []);
});

test("facade propagates a protection shard failure", () => {
  const { archive, calls, protectedByOwner } = syntheticProtectionFacade({ failAtProtectCall: 2 });
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `failure-${String(index).padStart(4, "0")}`,
  );
  assert.throws(
    () => archive.setProtectedContext({ documentIds }),
    /synthetic protection failure/u,
  );
  assert.equal(calls.filter(({ operation }) => operation === "store.protect").length, 2);
  assert.equal(
    archive.protectionShardOwners.get(archive.ownerId).length,
    2,
    "completed and uncertain shards remain tracked for cleanup after failure",
  );
  archive.releaseProtectionOwner(archive.ownerId);
  assert.equal(protectedByOwner.size, 0);
});

test("ambiguous protection commits remain tracked and close releases them", () => {
  const { archive, protectedByOwner } = syntheticProtectionFacade({
    loseProtectResponseAtCall: 2,
  });
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `ambiguous-${String(index).padStart(4, "0")}`,
  );
  assert.throws(
    () => archive.setProtectedContext({ documentIds }),
    /synthetic committed protection response loss/u,
  );
  assert.equal(protectedByOwner.size, 2);
  assert.equal(archive.protectionShardOwners.get(archive.ownerId).length, 2);
  archive.close();
  assert.equal(protectedByOwner.size, 0);
});

test("partial shard refresh retains old sessions until every new shard is protected", () => {
  const { archive, sessionsByOwner } = syntheticProtectionFacade({ failAtProtectCall: 4 });
  const originalDocumentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `partial-${String(index).padStart(4, "0")}`,
  );
  archive.syncProtection(
    archive.ownerId,
    new Set(["old-session"]),
    new Set(originalDocumentIds),
  );
  const changedDocumentIds = [...originalDocumentIds.slice(0, 1_000), "partial-2000"];
  assert.throws(
    () => archive.syncProtection(
      archive.ownerId,
      new Set(["new-session"]),
      new Set(changedDocumentIds),
    ),
    /synthetic protection failure/u,
  );
  assert.ok([...sessionsByOwner.values()].some((sessionIds) => (
    sessionIds.includes("old-session")
  )));
  assert.ok([...sessionsByOwner.values()].some((sessionIds) => (
    sessionIds.includes("new-session")
  )));
  archive.releaseProtectionOwner(archive.ownerId);
  assert.equal(sessionsByOwner.size, 0);
});

test("facade close retries failed temporary releases and clears every logical owner", () => {
  const { archive, calls, protectedByOwner, bridgeCloseCalls } = syntheticProtectionFacade({
    failAtReleaseCall: 1,
  });
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `close-${String(index).padStart(4, "0")}`,
  );
  archive.syncProtection(archive.ownerId, new Set(["session-main"]), new Set(documentIds));
  const temporaryOwner = `${archive.ownerId}:prune`;
  archive.syncProtection(temporaryOwner, new Set(), new Set(documentIds));
  assert.throws(
    () => archive.releaseProtectionOwner(temporaryOwner),
    /synthetic release failure/u,
  );
  assert.equal(archive.protectionShardOwners.has(temporaryOwner), true);

  archive.close();
  assert.equal(protectedByOwner.size, 0);
  assert.equal(archive.protectionShardOwners.size, 0);
  assert.equal(bridgeCloseCalls(), 1);
  assert.equal(
    calls.filter(({ operation }) => operation === "store.release-protection").length,
    5,
  );
});

test("multi-shard protection handoff can be released by a replacement facade", () => {
  const { archive, calls, protectedByOwner } = syntheticProtectionFacade();
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `handoff-${String(index).padStart(4, "0")}`,
  );
  archive.syncProtection(archive.ownerId, new Set(["session-main"]), new Set(documentIds));
  const physicalOwners = calls
    .filter(({ operation }) => operation === "store.protect")
    .map(({ payload }) => payload.ownerId);

  const handoffId = archive.close({ releaseProtection: false });
  assert.match(handoffId, /^protection-handoff:v1:/u);
  assert.equal(archive.close({ releaseProtection: false }), handoffId);
  assert.equal(protectedByOwner.size, 2, "handoff close must preserve every physical lease");

  const replacement = Object.create(DaemonArchive.prototype);
  replacement.ownerId = "archive:replacement";
  replacement.protectionShardOwners = new Map();
  replacement.request = archive.request;
  replacement.releaseProtectionOwner(handoffId);

  assert.equal(protectedByOwner.size, 0);
  assert.deepEqual(
    calls
      .filter(({ operation }) => operation === "store.release-protection")
      .map(({ payload }) => payload.ownerId),
    physicalOwners,
  );
});

test("failed close hands its remaining physical shards to a replacement facade", () => {
  const { archive, protectedByOwner } = syntheticProtectionFacade({ failAtReleaseCall: 1 });
  const documentIds = Array.from(
    { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
    (_, index) => `failed-close-${String(index).padStart(4, "0")}`,
  );
  archive.syncProtection(archive.ownerId, new Set(), new Set(documentIds));

  assert.throws(() => archive.close(), /synthetic release failure/u);
  assert.equal(protectedByOwner.size, 1);
  const handoffId = archive.close({ releaseProtection: false });
  assert.match(handoffId, /^protection-handoff:v1:/u);

  const replacement = Object.create(DaemonArchive.prototype);
  replacement.ownerId = "archive:failed-close-replacement";
  replacement.protectionShardOwners = new Map();
  replacement.request = archive.request;
  replacement.releaseProtectionOwner(handoffId);
  assert.equal(protectedByOwner.size, 0);
});

async function stopProcess(processId) {
  if (!processId || !processExists(processId)) return;
  process.kill(processId, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) {
    process.kill(processId, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createMigrationSource(path, id = "legacy-turn") {
  const source = new Archive(path);
  try {
    source.put({
      id,
      sessionId: "legacy-session",
      project: "/project/migration",
      kind: "turn",
      text: `SQLite history ${id}`,
      createdAt: 1,
      metadata: { sourceMessageKeys: [`user:1:${id}`] },
    });
  } finally {
    source.close();
  }
}

test("an existing SQLite source rejects an explicit fresh RocksDB cutover", async () => {
  const paths = fixture("context-window-cutover-guard-");
  const sourcePath = join(paths.directory, "archive.db");
  let daemonProcessId;
  createMigrationSource(sourcePath);
  try {
    assert.throws(() => new DaemonArchive({
      ...paths,
      project: "/project/migration",
      migrationSourcePath: sourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error instanceof ArchiveMigrationGuardError
      && error.code === "MIGRATION_REQUIRED"
      && error.details.phase === "not-started"
      && /no verified migration/iu.test(error.message));

    const client = new StoreClient({
      socketPath: paths.socketPath,
      project: "/project/migration",
      requestTimeoutMs: 5_000,
    });
    try {
      const status = await client.request("daemon.status", {});
      daemonProcessId = status.processId;
      assert.equal(status.migration.phase, "not-started");
      assert.equal(status.counts.documents, 0, "the rejected adapter cannot admit a first write");
    } finally {
      client.close();
    }
  } finally {
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("a SQLite source created after config loading still blocks fresh RocksDB activation", async () => {
  const paths = fixture("context-window-config-cutover-race-");
  const sourcePath = join(paths.directory, "archive.db");
  const config = loadConfig({
    cwd: paths.directory,
    projectTrusted: false,
    home: paths.directory,
    env: {
      CONTEXT_WINDOW_BACKEND: "rocksdb",
      CONTEXT_WINDOW_DB: sourcePath,
      CONTEXT_WINDOW_ROCKSDB: paths.storePath,
      CONTEXT_WINDOW_SOCKET: paths.socketPath,
    },
  });
  let daemonProcessId;
  assert.equal(config.rocksdbMigrationSourcePath, sourcePath);
  createMigrationSource(sourcePath, "late-sqlite-turn");
  try {
    assert.throws(() => new DaemonArchive({
      storePath: config.rocksdbPath,
      socketPath: config.socketPath,
      project: paths.directory,
      migrationSourcePath: config.dbPath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error instanceof ArchiveMigrationGuardError
      && error.code === "MIGRATION_REQUIRED"
      && error.details.phase === "not-started"
      && /no verified migration/iu.test(error.message));
    const client = new StoreClient({
      socketPath: paths.socketPath,
      project: paths.directory,
      requestTimeoutMs: 5_000,
    });
    try {
      const status = await client.request("daemon.status", {});
      daemonProcessId = status.processId;
      assert.equal(status.counts.documents, 0);
    } finally {
      client.close();
    }
  } finally {
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("the cutover guard binds the source and permits verified and authoritative destinations", async () => {
  const paths = fixture("context-window-verified-cutover-");
  const sourcePath = join(paths.directory, "archive.db");
  const otherSourcePath = join(paths.directory, "other.db");
  let archive;
  let daemonProcessId;
  createMigrationSource(sourcePath);
  createMigrationSource(otherSourcePath, "unrelated-turn");
  const store = await RocksStore.open(paths.storePath);
  try {
    await startMigration(store, { sourcePath, offline: true });
    const verification = await verifyMigration(store, { sourcePath });
    assert.equal(verification.status, "passed");
  } finally {
    store.close();
  }

  try {
    assert.throws(() => new DaemonArchive({
      ...paths,
      project: "/project/migration",
      migrationSourcePath: otherSourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error instanceof ArchiveMigrationGuardError
      && error.code === "MIGRATION_REQUIRED"
      && /not configured source/iu.test(error.message));

    archive = new DaemonArchive({
      ...paths,
      project: "/project/migration",
      migrationSourcePath: sourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    assert.equal(archive.request("migration.status", {}).phase, "offline-ready");
    assert.equal(archive.put({
      id: "first-rocksdb-only-turn",
      sessionId: "rocks-session",
      text: "First post-verification RocksDB write",
      createdAt: 2,
    }), "first-rocksdb-only-turn");
    assert.equal(archive.request("migration.status", {}).phase, "rocksdb-authority");
    archive.close();

    assert.throws(() => new DaemonArchive({
      ...paths,
      project: "/project/migration",
      migrationSourcePath: otherSourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error instanceof ArchiveMigrationGuardError
      && error.code === "MIGRATION_REQUIRED"
      && /not configured source/iu.test(error.message));

    assert.throws(() => claimSqliteBackendAuthority({
      storePath: paths.storePath,
      socketPath: paths.socketPath,
      sourcePath,
      project: "/project/migration",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error.code === "MIGRATION_BLOCKED" && /cannot restart/iu.test(error.message));
    const sqlite = new Archive(sourcePath);
    try {
      assert.equal(sqlite.get("first-rocksdb-only-turn"), undefined,
        "reopening the old SQLite file would fork the authoritative history");
    } finally {
      sqlite.close();
    }

    archive = new DaemonArchive({
      ...paths,
      project: "/project/migration",
      migrationSourcePath: sourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    assert.equal(archive.request("migration.status", {}).phase, "rocksdb-authority");
    assert.equal(archive.get("first-rocksdb-only-turn").text,
      "First post-verification RocksDB write");
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("verified pre-authority rollback claims SQLite until offline migration is rerun", async () => {
  const paths = fixture("context-window-pre-authority-rollback-");
  const sourcePath = join(paths.directory, "archive.db");
  const project = "/project/pre-authority-rollback";
  let archive;
  let daemonProcessId;
  createMigrationSource(sourcePath);
  const store = await RocksStore.open(paths.storePath);
  try {
    await startMigration(store, { sourcePath, offline: true });
    assert.equal((await verifyMigration(store, { sourcePath })).status, "passed");
  } finally {
    store.close();
  }

  try {
    const claim = claimSqliteBackendAuthority({
      storePath: paths.storePath,
      socketPath: paths.socketPath,
      sourcePath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    assert.equal(claim.backend, "sqlite");
    assert.equal(claim.phase, "offline-ready");
    const sqlite = new Archive(sourcePath);
    try {
      assert.equal(sqlite.get("legacy-turn").text, "SQLite history legacy-turn");
    } finally {
      sqlite.close();
    }
    assert.throws(() => new DaemonArchive({
      ...paths,
      project,
      migrationSourcePath: sourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error instanceof ArchiveMigrationGuardError
      && /SQLite currently owns backend authority/iu.test(error.message));

    const client = new StoreClient({ socketPath: paths.socketPath, project, requestTimeoutMs: 30_000 });
    try {
      daemonProcessId = (await client.request("daemon.status", {})).processId;
      assert.equal((await client.request("migration.start", { sourcePath, offline: true }))
        .status.phase, "offline-verification");
      assert.equal((await client.request("migration.verify", { sourcePath })).status, "passed");
    } finally {
      client.close();
    }

    archive = new DaemonArchive({
      ...paths,
      project,
      migrationSourcePath: sourcePath,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    assert.equal(archive.request("migration.status", {}).phase, "offline-ready");
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("synchronous facade preserves the legacy archive surface over a real daemon", async () => {
  const paths = fixture("context-window-daemon-archive-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/a",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    assert.throws(() => new DaemonArchive({
      storePath: join(paths.directory, "different.rocks"),
      socketPath: paths.socketPath,
      project: "/project/a",
      requestTimeoutMs: 5_000,
      daemonStartTimeoutMs: 1_000,
    }), /owns .*archive\.rocks, not .*different\.rocks/u);

    const document = {
      sessionId: "session-a",
      project: "/project/a",
      kind: "turn",
      text: [
        "[user] What did we decide about REAP_DRAIN?",
        "[assistant] We decided earlier that REAP_DRAIN uses the RocksDB archive.",
      ].join("\n\n"),
      createdAt: 123,
      metadata: {
        sourceMessageKeys: ["user:1::aaa", "assistant:2::bbb"],
        sourceFirstKey: "user:1::aaa",
        sourceLastKey: "assistant:2::bbb",
        sourceMessageCount: 2,
      },
    };
    const structuralMessages = [{
        messageKey: "user:1::aaa",
        messageIndex: 0,
        role: "user",
        createdAt: 123,
        text: "What did we decide about REAP_DRAIN?",
        questionScore: 100,
      }];
    const id = archive.put(document, { structuralMessages });
    assert.equal(
      archive.put(document, { structuralMessages }),
      id,
      "generated identity is stable across retries",
    );

    const recalled = archive.get(id);
    assert.equal(recalled.id, id);
    assert.equal(recalled.text, document.text);
    assert.deepEqual(recalled.provenance.sourceMessages, {
      status: "available",
      keys: ["user:1::aaa", "assistant:2::bbb"],
      firstKey: "user:1::aaa",
      lastKey: "assistant:2::bbb",
      count: 2,
    });

    const unavailableId = archive.put({
      id: "legacy-without-source-keys",
      sessionId: "session-a",
      text: "Legacy evidence with OLD_VANISHED_PHANTOM_RELIC.",
      createdAt: 124,
    });
    const unavailable = archive.get(unavailableId);
    assert.equal(unavailable.sourceKeyStatus, "unavailable");
    assert.deepEqual(unavailable.sourceMessageKeys, []);
    assert.equal(unavailable.provenance.sourceMessages.status, "legacy-unavailable");
    assert.equal(archive.put({
      id: unavailableId,
      sessionId: "session-a",
      text: "Replacement evidence with NEW_MODERN_ACTIVE_TOKEN.",
      createdAt: 125,
    }), unavailableId);
    assert.equal(archive.get(unavailableId).version, 2);
    assert.equal(archive.get(unavailableId).text, "Replacement evidence with NEW_MODERN_ACTIVE_TOKEN.");
    assert.equal(archive.search("OLD_VANISHED_PHANTOM_RELIC", {
      sessionId: "session-a",
      project: "/project/a",
    }).length, 0, "superseded versions are not searchable");

    const canonicalGet = archive.canonicalGet;
    archive.canonicalGet = () => { throw new Error("search fetched a full canonical document"); };
    const detailed = archive.searchDetailed("REAP_DRAIN RocksDB", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/a",
      scope: "session",
      limit: 3,
    });
    archive.canonicalGet = canonicalGet;
    assert.equal(detailed.status, "resolved");
    assert.equal(detailed.results[0].documentId, id);
    assert.equal(detailed.results[0].text, undefined);
    assert.equal(detailed.results[0].id, detailed.results[0].locator);
    assert.match(detailed.results[0].id, /^cw1\./u);
    assert.equal(Object.hasOwn(detailed.results[0], "margin"), true);
    assert.equal(Number.isFinite(detailed.results[0].margin), true);
    assert.equal(detailed.results[0].margin >= 0, true);
    const recalledSearchResult = archive.get(detailed.results[0].id);
    assert.equal(recalledSearchResult.version, 1);
    assert.equal(recalledSearchResult.recalledText, document.text);
    assert.match(recalledSearchResult.text, /ARCHIVED HISTORICAL EVIDENCE/u);
    assert.throws(
      () => archive.recall(detailed.results[0].id, { sessionIds: ["unrelated-session"] }),
      (error) => error instanceof ArchiveRecallError && error.status === "locator-invalid",
    );
    const projectDetailed = archive.searchDetailed("REAP_DRAIN RocksDB", {
      sessionId: "unrelated-session",
      sessionIds: ["unrelated-session"],
      project: "/project/a",
      scope: "project",
      limit: 3,
    });
    assert.equal(
      archive.recall(projectDetailed.results[0].id, { sessionIds: ["unrelated-session"] }).version,
      1,
    );

    assert.equal(archive.search("REAP_DRAIN", {
      sessionId: "session-a",
      project: "/project/a",
    })[0].documentId, id);
    const tooManyVisibleKeys = Array.from(
      { length: MAX_VISIBLE_SOURCE_KEYS + 1 },
      (_, index) => `visible-${index}`,
    );
    assert.throws(
      () => archive.search("REAP_DRAIN", {
        sessionId: "session-a",
        project: "/project/a",
        excludeVisibleSourceKeys: tooManyVisibleKeys,
      }),
      /at most 1000 items/u,
    );
    const oversizedVisibleKeyBytes = Array.from(
      { length: MAX_VISIBLE_SOURCE_KEYS },
      (_, index) => `${index}:${"v".repeat(Math.ceil(
        MAX_VISIBLE_SOURCE_KEY_BYTES / MAX_VISIBLE_SOURCE_KEYS,
      ))}`,
    );
    assert.throws(
      () => archive.preflight({
        messageKey: "user:visible-cap",
        message: "What happened earlier?",
        sessionId: "session-a",
        excludeVisibleSourceKeys: oversizedVisibleKeyBytes,
      }),
      /at most 1048576 UTF-8 bytes/u,
    );
    const structural = archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/a",
      scope: "session",
    });
    assert.equal(structural.mode, "structural");
    assert.ok(["resolved", "ambiguous"].includes(structural.status));
    const structuralMatch = structural.results.find((result) => result.documentId === id);
    assert.ok(structuralMatch);
    assert.equal(structuralMatch.structural.relation, "latest-question");
    assert.equal(structuralMatch.structural.granularity, "message");
    assert.equal(structuralMatch.structural.messageKey, "user:1::aaa");
    assert.equal(archive.count({
      sessionId: "session-a",
      project: "/project/a",
      scope: "session",
    }), 2);

    archive.put({
      id: "versioned-recall",
      sessionId: "session-a",
      text: "VERSION_ONE_EXACT archived source",
      createdAt: 200,
    });
    const versionOneResult = archive.search("VERSION_ONE_EXACT", {
      sessionId: "session-a",
      project: "/project/a",
    })[0];
    assert.equal(versionOneResult.documentId, "versioned-recall");
    archive.put({
      id: "versioned-recall",
      sessionId: "session-a",
      text: "VERSION_TWO_REPLACEMENT current source",
      createdAt: 201,
    });
    assert.throws(
      () => archive.get(versionOneResult.id),
      (error) => error instanceof ArchiveRecallError
        && error.status === "superseded"
        && error.version === 1,
      "an old locator must never substitute the latest document version",
    );
    assert.equal(archive.get("versioned-recall").version, 2);
    assert.equal(archive.get("versioned-recall").text, "VERSION_TWO_REPLACEMENT current source");

    archive.setProtectedContext({
      sessionIds: ["session-a"],
      documentIds: [id],
    });
    archive.refreshPolicyLease();
    const preflight = archive.preflight({
      messageKey: "user:3::ccc",
      message: "What did we decide earlier about REAP_DRAIN?",
      scope: "session",
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/a",
      excludeVisibleSourceKeys: [],
      hintBudgetTokens: 600,
      activeHintBudgetTokens: 640,
      activeMessageKeys: ["user:3::ccc"],
      hintSourceCooldownMs: 86_400_000,
      ephemeralAutoRetrievalDays: 7,
      conversationAutoRetrievalDays: 30,
      derivedAutoRetrievalDays: 30,
      epochId: "epoch-1",
      epochBudgetTokens: 1_000,
    });
    assert.equal(typeof preflight.modelVisibleText, "string");
    assert.ok(Array.isArray(preflight.hints));
    assert.throws(() => archive.preflight({
      messageKey: "user:active-key-cap",
      message: "What did we decide?",
      sessionId: "session-a",
      activeMessageKeys: Array.from(
        { length: MAX_ACTIVE_HINT_MESSAGE_KEYS + 1 },
        (_, index) => `user:${index}`,
      ),
    }), /at most 1000 items/u);
    assert.throws(() => archive.preflight({
      messageKey: "user:malformed-active-keys",
      message: "What did we decide?",
      sessionId: "session-a",
      activeMessageKeys: ["user:valid", null],
    }), /must be a string/u);
    assert.throws(() => archive.preflight({
      messageKey: "user:non-array-active-keys",
      message: "What did we decide?",
      sessionId: "session-a",
      activeMessageKeys: "user:not-an-array",
    }), /must be an array/u);
    assert.throws(() => archive.preflight({
      messageKey: "user:unknown-field",
      message: "What did we decide?",
      sessionId: "session-a",
      activeMessages: ["user:unknown-field"],
    }), /activeMessages is not an allowed field/u);
    assert.throws(() => archive.preflight({
      messageKey: "user:wrong-project-malformed-keys",
      message: "What did we decide?",
      sessionId: "session-a",
      project: "/different/project",
      activeMessageKeys: [null],
    }), /must be a string/u, "project mismatch must not bypass facade validation");
    for (const field of [
      "hintBudgetTokens",
      "activeHintBudgetTokens",
      "hintSourceCooldownMs",
      "ephemeralAutoRetrievalDays",
      "conversationAutoRetrievalDays",
      "derivedAutoRetrievalDays",
      "epochBudgetTokens",
    ]) {
      assert.throws(() => archive.preflight({
        messageKey: `user:wrong-project-negative-${field}`,
        message: "What did we decide?",
        sessionId: "session-a",
        project: "/different/project",
        [field]: -1,
      }), (error) => error?.code === "INVALID_REQUEST" && error.path === `$.${field}`,
      `wrong-project preflight must validate ${field}`);
    }
    assert.deepEqual(archive.removeHints(["user:3::ccc", "user:missing"], {
      sessionId: "session-a",
    }), { removed: 1, notFound: 1 });

    const prune = archive.prune({ force: true });
    assert.equal(prune.deletedDocuments, 0);
    assert.equal(typeof prune.totalAfter, "number");
    const reclaim = archive.reclaim();
    assert.ok(["reclaimed", "busy"].includes(reclaim.status));

    const stats = archive.stats();
    assert.equal(stats.backend, "rocksdb");
    assert.equal(stats.noRoutineSizeCap, true);
    assert.equal(stats.maxBytes, null);
    assert.equal(stats.retention.liveDocuments, 3);
    archive.releaseProtectionOwner("nonexistent-owner");
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("searchDetailed forwards the store's expired-match summary instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-expired-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/expired-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // The daemon's own store.search response already carries expiredMatches
    // (proven end-to-end in retrieval-search.test.js); this test isolates the
    // facade's own reshaping of that response, which previously rebuilt its
    // return object with a fixed key set and silently dropped the field.
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.search") return realRequest(operation, payload, options);
      return {
        mode: "lexical",
        status: "not-found",
        indexGeneration: 0,
        results: [],
        expiredMatches: { count: 2, retentionClasses: ["conversation-source"] },
      };
    };
    const detailed = archive.searchDetailed("EXPIRED_WIRING_ANCHOR", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/expired-wiring",
      scope: "session",
    });
    assert.deepEqual(detailed.expiredMatches, { count: 2, retentionClasses: ["conversation-source"] });

    const wrongProject = archive.searchDetailed("EXPIRED_WIRING_ANCHOR", {
      sessionId: "session-a",
      project: "/different/project",
    });
    assert.deepEqual(wrongProject.expiredMatches, { count: 0, retentionClasses: [] });
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("searchDetailed surfaces cross-encoder rerank provenance instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-rerank-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/rerank-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // The daemon's own store.search response can carry `reranked: true` on a
    // result the cross-encoder scored (proven end-to-end in
    // retrieval-search.test.js and relevance-feedback.test.js); this test
    // isolates the facade's own reshaping of that response, which built its
    // result objects from a fixed key set (matching the RM3 expandedTerms
    // provenance field, kept alongside it) and silently dropped `reranked`.
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.search") return realRequest(operation, payload, options);
      return {
        mode: "lexical",
        status: "resolved",
        indexGeneration: 0,
        expiredMatches: { count: 0, retentionClasses: [] },
        results: [
          {
            documentId: "reranked-doc",
            version: 1,
            kind: "note",
            score: 0.9,
            margin: 0.1,
            matchType: "lexical",
            historical: false,
            superseded: false,
            reranked: true,
            snippet: "reranked candidate",
            locator: "cw1.reranked-doc",
            source: { sessionId: "session-a" },
          },
          {
            documentId: "untouched-doc",
            version: 1,
            kind: "note",
            score: 0.5,
            margin: 0.1,
            matchType: "lexical",
            historical: false,
            superseded: false,
            snippet: "untouched candidate",
            locator: "cw1.untouched-doc",
            source: { sessionId: "session-a" },
          },
        ],
      };
    };
    const detailed = archive.searchDetailed("anything", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/rerank-wiring",
      scope: "session",
    });
    assert.equal(detailed.results[0].reranked, true);
    assert.equal(
      Object.hasOwn(detailed.results[1], "reranked"),
      false,
      "reranked is present only on the specific result the cross-encoder scored",
    );
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("searchDetailed forwards the workingSet ranking boost's anchor provenance instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-working-set-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/working-set-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // The daemon's own store.search response can carry `workingSetAnchors`
    // on a result applyWorkingSetBoost promoted (proven end-to-end in
    // retrieval-search.test.js); this test isolates the facade's own
    // reshaping of that response, which builds its result objects from a
    // fixed key set (matching the expandedTerms/reranked provenance fields,
    // kept alongside them) -- the exact place a provenance field can be
    // silently dropped even though the daemon itself already returned it.
    let forwardedWorkingSet;
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.search") return realRequest(operation, payload, options);
      forwardedWorkingSet = payload.workingSet;
      return {
        mode: "lexical",
        status: "resolved",
        indexGeneration: 0,
        expiredMatches: { count: 0, retentionClasses: [] },
        results: [
          {
            documentId: "boosted-doc",
            version: 1,
            kind: "note",
            score: 0.9,
            margin: 0.1,
            matchType: "lexical",
            historical: false,
            superseded: false,
            workingSetAnchors: ["PALLET_ROUTE_PLANNER"],
            snippet: "boosted candidate",
            locator: "cw1.boosted-doc",
            source: { sessionId: "session-a" },
          },
          {
            documentId: "untouched-doc",
            version: 1,
            kind: "note",
            score: 0.5,
            margin: 0.1,
            matchType: "lexical",
            historical: false,
            superseded: false,
            snippet: "untouched candidate",
            locator: "cw1.untouched-doc",
            source: { sessionId: "session-a" },
          },
        ],
      };
    };
    const detailed = archive.searchDetailed("anything", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/working-set-wiring",
      scope: "session",
      workingSet: ["PALLET_ROUTE_PLANNER"],
    });
    assert.deepEqual(forwardedWorkingSet, ["PALLET_ROUTE_PLANNER"]);
    assert.deepEqual(detailed.results[0].workingSetAnchors, ["PALLET_ROUTE_PLANNER"]);
    assert.equal(
      Object.hasOwn(detailed.results[1], "workingSetAnchors"),
      false,
      "workingSetAnchors is present only on the specific result the boost actually matched",
    );
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("gatherDetailed forwards the store's expired-match summary instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-gather-expired-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/gather-expired-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // gather.js already returns expiredMatches on store.gather (proven
    // end-to-end in retrieval-gather.test.js); this test isolates the
    // facade's own reshaping of that response, which previously rebuilt its
    // return object with a fixed key set and silently dropped the field.
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.gather") return realRequest(operation, payload, options);
      return {
        status: "not-found",
        mode: "lexical",
        intent: payload.intent ?? "auto",
        anchorCount: 0,
        candidateCount: 0,
        returnedTokens: 0,
        truncated: false,
        hasMore: false,
        evidence: [],
        expiredMatches: { count: 2, retentionClasses: ["conversation-source"] },
      };
    };
    const gathered = archive.gatherDetailed("EXPIRED_WIRING_ANCHOR", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/gather-expired-wiring",
      scope: "session",
    });
    assert.deepEqual(gathered.expiredMatches, { count: 2, retentionClasses: ["conversation-source"] });

    const wrongProject = archive.gatherDetailed("EXPIRED_WIRING_ANCHOR", {
      sessionId: "session-a",
      project: "/different/project",
    });
    assert.deepEqual(wrongProject.expiredMatches, { count: 0, retentionClasses: [] });
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("gatherDetailed forwards cross-encoder rerank provenance instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-gather-rerank-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/gather-rerank-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // gather.js already puts `reranked: true` on anchor evidence the
    // cross-encoder scored (proven end-to-end in retrieval-gather.test.js
    // and relevance-feedback.test.js); this test isolates the facade's own
    // reshaping of that response, which previously rebuilt each evidence
    // entry from a fixed key set and silently dropped `reranked`, so gather
    // provenance never reached clients even though search's equivalent
    // reshaping already forwarded it.
    const document = {
      documentId: "reranked-doc",
      version: 1,
      sessionId: "session-a",
      project: "/project/gather-rerank-wiring",
      kind: "note",
      createdAt: Date.now(),
      renderedText: "rendered anchor text",
      text: "raw anchor text",
      stalenessLabel: "current",
      chunks: [{ chunkId: "c1", ordinal: 0, startByte: 0, endByte: 4, text: "text" }],
      continuationLocators: [],
      sourceMessages: { status: "available", keys: [], totalKeys: 0, truncated: false },
    };
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.gather") return realRequest(operation, payload, options);
      return {
        status: "resolved",
        mode: "lexical",
        intent: payload.intent ?? "auto",
        anchorCount: 1,
        candidateCount: 1,
        returnedTokens: 0,
        truncated: false,
        hasMore: false,
        evidence: [
          {
            relation: "anchor",
            anchorRank: 1,
            distance: 0,
            locator: "cw1.reranked-doc",
            document,
            score: 0.9,
            retrievalMode: "lexical",
            reranked: true,
          },
          {
            relation: "before",
            anchorRank: 1,
            distance: 1,
            locator: "cw1.untouched-doc",
            document: { ...document, documentId: "untouched-doc" },
          },
        ],
        expiredMatches: { count: 0, retentionClasses: [] },
      };
    };
    const gathered = archive.gatherDetailed("RERANK_WIRING_ANCHOR", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/gather-rerank-wiring",
      scope: "session",
    });
    assert.equal(gathered.evidence[0].reranked, true);
    assert.equal(
      Object.hasOwn(gathered.evidence[1], "reranked"),
      false,
      "reranked is present only on evidence the cross-encoder scored, matching searchDetailed's forwarding",
    );
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("gatherDetailed forwards the workingSet ranking boost's anchor provenance instead of dropping it", async () => {
  const paths = fixture("context-window-daemon-gather-working-set-wiring-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/gather-working-set-wiring",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;

    // gather.js already puts `workingSetAnchors` on anchor evidence the
    // boost matched (proven end-to-end in retrieval-search.test.js); this
    // test isolates the facade's own reshaping of that response, matching
    // the reranked-forwarding regression test above for the same field.
    const document = {
      documentId: "boosted-doc",
      version: 1,
      sessionId: "session-a",
      project: "/project/gather-working-set-wiring",
      kind: "note",
      createdAt: Date.now(),
      renderedText: "rendered anchor text",
      text: "raw anchor text",
      stalenessLabel: "current",
      chunks: [{ chunkId: "c1", ordinal: 0, startByte: 0, endByte: 4, text: "text" }],
      continuationLocators: [],
      sourceMessages: { status: "available", keys: [], totalKeys: 0, truncated: false },
    };
    let forwardedWorkingSet;
    const realRequest = archive.request.bind(archive);
    archive.request = (operation, payload, options) => {
      if (operation !== "store.gather") return realRequest(operation, payload, options);
      forwardedWorkingSet = payload.workingSet;
      return {
        status: "resolved",
        mode: "lexical",
        intent: payload.intent ?? "auto",
        anchorCount: 1,
        candidateCount: 1,
        returnedTokens: 0,
        truncated: false,
        hasMore: false,
        evidence: [
          {
            relation: "anchor",
            anchorRank: 1,
            distance: 0,
            locator: "cw1.boosted-doc",
            document,
            score: 0.9,
            retrievalMode: "lexical",
            workingSetAnchors: ["PALLET_ROUTE_PLANNER"],
          },
          {
            relation: "before",
            anchorRank: 1,
            distance: 1,
            locator: "cw1.untouched-doc",
            document: { ...document, documentId: "untouched-doc" },
          },
        ],
        expiredMatches: { count: 0, retentionClasses: [] },
      };
    };
    const gathered = archive.gatherDetailed("WORKING_SET_WIRING_ANCHOR", {
      sessionId: "session-a",
      sessionIds: ["session-a"],
      project: "/project/gather-working-set-wiring",
      scope: "session",
      workingSet: ["PALLET_ROUTE_PLANNER"],
    });
    assert.deepEqual(forwardedWorkingSet, ["PALLET_ROUTE_PLANNER"]);
    assert.deepEqual(gathered.evidence[0].workingSetAnchors, ["PALLET_ROUTE_PLANNER"]);
    assert.equal(
      Object.hasOwn(gathered.evidence[1], "workingSetAnchors"),
      false,
      "workingSetAnchors is present only on evidence the boost actually matched, matching searchDetailed's forwarding",
    );
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("daemon facade gathers exact workflow successors in one bounded call", async () => {
  const paths = fixture("context-window-gather-facade-");
  const project = "/project/gather-facade";
  const sessionId = "session-gather-facade";
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    for (const [id, text, createdAt] of [
      ["workflow-anchor", "Reusable rollout procedure starts here.", 126],
      ["workflow-account", "Next switch to the service identity.", 127],
      ["workflow-verify", "Finally verify the published artifact.", 128],
    ]) {
      archive.put({ id, sessionId, project, kind: "turn", text, createdAt });
    }

    const gathered = archive.gatherDetailed("Reusable rollout procedure", {
      intent: "workflow",
      sessionIds: [sessionId],
      scope: "session",
      limit: 1,
      before: 0,
      after: 2,
      neighborhoodAnchors: 1,
      maxEvidence: 3,
      maxTokens: 1_000,
    });
    assert.equal(gathered.status, "resolved");
    assert.deepEqual(gathered.evidence.map(({ document }) => document.documentId), [
      "workflow-anchor",
      "workflow-account",
      "workflow-verify",
    ]);
    assert.match(gathered.evidence[1].document.recalledText, /service identity/u);
    assert.equal(typeof gathered.evidence[0].score, "number");
    assert.ok(gathered.evidence[0].score >= 0 && gathered.evidence[0].score <= 1);
    assert.equal(Object.hasOwn(gathered.evidence[1], "score"), false);
    assert.equal(Object.hasOwn(gathered.evidence[2], "score"), false);
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("real daemon exposes supersession and completes multi-wave redaction", async () => {
  const paths = fixture("context-window-redact-facade-");
  const project = "/project/redact-facade";
  const sessionId = "session-redact-facade";
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    const status = archive.request("daemon.status", {});
    daemonProcessId = status.processId;
    assert.ok(status.capabilities.includes("store.resolve-subject"));
    assert.ok(status.capabilities.includes("store.redact"));

    archive.put({
      id: "decision-before",
      sessionId,
      project,
      kind: "decision-candidate",
      text: "Use the original queue implementation.",
      createdAt: 100,
      subjectKey: "decision:queue-implementation",
    });
    assert.equal(
      archive.resolveSubject("decision:queue-implementation").documentId,
      "decision-before",
    );
    const replacement = archive.supersede({
      documentId: "decision-before",
      note: "Use the replacement queue implementation.",
    });
    assert.equal(replacement.superseded.documentId, "decision-before");
    assert.equal(
      archive.resolveSubject("decision:queue-implementation").documentId,
      replacement.documentId,
    );
    assert.equal(archive.get("decision-before"), undefined);

    for (let index = 1; index <= 3; index += 1) {
      archive.put({
        id: `redact-facade-${index}`,
        sessionId,
        project,
        kind: "turn",
        text: `Scoped redaction fixture ${index}.`,
        createdAt: 200 + index,
      });
    }
    const before = archive.count({ scope: "session", sessionId, project });
    const redacted = archive.redact({
      scope: "session",
      sessionId,
      confirm: sessionId,
      batchSize: 2,
    });
    assert.equal(redacted.status, "complete");
    assert.equal(redacted.tombstoned, before);
    assert.equal(redacted.alreadyTombstoned, 1);
    assert.equal(redacted.scanned, before + redacted.alreadyTombstoned);
    assert.equal(archive.count({ scope: "session", sessionId, project }), 0);
    for (let index = 1; index <= 3; index += 1) {
      assert.equal(archive.get(`redact-facade-${index}`), undefined);
    }
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("a direct StoreClient first write permanently claims RocksDB before SQLite can open", async () => {
  const paths = fixture("context-window-direct-client-authority-");
  const sourcePath = join(paths.directory, "archive.db");
  const project = "/project/direct-client-authority";
  let daemonProcessId;
  let bootstrap;
  try {
    bootstrap = new DaemonArchive({
      ...paths,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = bootstrap.stats().processId;
    bootstrap.close();
    bootstrap = undefined;

    const client = new StoreClient({ socketPath: paths.socketPath, project, requestTimeoutMs: 30_000 });
    try {
      const stored = await client.request("store.put", {
        idempotencyKey: "direct-client-authority-request",
        document: {
          documentId: "direct-client-authority-document",
          version: 1,
          sourceKey: "user:direct-client-authority",
          sourceMessageKeys: ["user:direct-client-authority"],
          sourceKeyStatus: "preserved",
          sessionId: "direct-client-authority-session",
          project,
          kind: "turn",
          createdAt: 1,
          text: "A protocol client cannot bypass durable backend authority.",
          metadata: {},
        },
        retentionClass: "conversation-source",
      });
      assert.equal(stored.status, "stored");
    } finally {
      client.close();
    }

    createMigrationSource(sourcePath);
    assert.throws(() => claimSqliteBackendAuthority({
      storePath: paths.storePath,
      socketPath: paths.socketPath,
      sourcePath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    }), (error) => error.code === "MIGRATION_BLOCKED" && /cannot restart/iu.test(error.message));
  } finally {
    try { bootstrap?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("saturated locator recall preserves the daemon's complete JSON frame", async () => {
  const paths = fixture("context-window-daemon-framed-recall-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/framed",
      recallMaxTokens: 3_000,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    archive.put({
      id: "saturated-framed-recall",
      sessionId: "framed-session",
      kind: "tool-result",
      text: `SATURATED_FRAME_TARGET ${"x".repeat(50_000)}`,
      createdAt: 1_000,
      metadata: { sourceMessageKey: "toolResult:1:framed:source" },
    });
    const result = archive.search("SATURATED_FRAME_TARGET", {
      sessionId: "framed-session",
      project: "/project/framed",
      scope: "session",
      limit: 1,
    })[0];
    assert.match(result.id, /^cw1\./u);

    const document = archive.get(result.id);
    assert.equal(document.modelVisibleFramed, true);
    assert.ok(estimateModelVisibleTokens(document.text) <= 3_000);
    const output = formatRecalledDocument(document, 3_000, result.id);
    assert.equal(output, document.text);
    const lines = output.split("\n");
    assert.equal(lines.length, 2);
    const envelope = JSON.parse(lines[1]);
    assert.equal(envelope.format, "context-window.archived-evidence.v1");
    assert.equal(envelope.trust, "untrusted-archived-data");
    assert.match(JSON.parse(envelope.bodyJson), /SATURATED_FRAME_TARGET/u);
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("an expired document identity is re-admitted at the next durable version", async () => {
  const paths = fixture("context-window-daemon-expired-readmission-");
  let archive;
  let daemonProcessId;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: "/project/readmission",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    assert.equal(archive.put({
      id: "repeat-id",
      sessionId: "readmission-session",
      kind: "tool-result",
      text: "first retained payload",
      createdAt: 1,
    }, {
      retentionClass: "ephemeral-payload",
      expiresAt: 2,
    }), "repeat-id");
    assert.equal(archive.get("repeat-id").version, 1);

    const pruned = archive.prune({ now: 3, force: true });
    assert.equal(pruned.deletedDocuments, 1);
    assert.equal(archive.get("repeat-id"), undefined);

    assert.equal(archive.put({
      id: "repeat-id",
      sessionId: "readmission-session",
      kind: "tool-result",
      text: "recreated payload",
      createdAt: 4,
    }, {
      retentionClass: "ephemeral-payload",
      expiresAt: 10_000,
    }), "repeat-id");
    assert.equal(archive.get("repeat-id").version, 2);
    assert.equal(archive.get("repeat-id").text, "recreated payload");
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

function racingFacadeWorker(workerData) {
  const source = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { DaemonArchive } = await import(workerData.moduleUrl);
      const barrier = new Int32Array(workerData.barrier);
      Atomics.add(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 10_000);
      const archive = new DaemonArchive({
        storePath: workerData.storePath,
        socketPath: workerData.socketPath,
        project: workerData.project,
        requestTimeoutMs: 30_000,
        daemonStartTimeoutMs: 20_000,
      });
      try {
        const id = archive.put({
          id: workerData.id,
          sessionId: workerData.sessionId,
          text: workerData.text,
          createdAt: workerData.createdAt,
        });
        parentPort.postMessage({ id, processId: archive.stats().processId });
      } finally {
        archive.close();
      }
    })().catch((error) => {
      parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
    });
  `;
  return new Worker(source, { eval: true, workerData });
}

function backendAuthorityRaceWorker(workerData) {
  const source = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const barrier = new Int32Array(workerData.barrier);
      Atomics.add(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 10_000);
      try {
        if (workerData.kind === "sqlite") {
          const { claimSqliteBackendAuthority } = await import(workerData.authorityModuleUrl);
          claimSqliteBackendAuthority(workerData.options);
        } else {
          const { DaemonArchive } = await import(workerData.facadeModuleUrl);
          const archive = new DaemonArchive({
            ...workerData.options,
            migrationSourcePath: workerData.sourcePath,
          });
          archive.close();
        }
        parentPort.postMessage({ kind: workerData.kind, outcome: "fulfilled" });
      } catch (error) {
        parentPort.postMessage({
          kind: workerData.kind,
          outcome: "rejected",
          code: error.code,
          message: error.message,
        });
      }
    })().catch((error) => {
      parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
    });
  `;
  return new Worker(source, { eval: true, workerData });
}

function workerResult(worker) {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (message) => {
      if (message.error) reject(new Error(message.error.message));
      else resolve(message);
    });
  });
}

test("simultaneous fresh SQLite and RocksDB adapters persist exactly one backend authority", async () => {
  const paths = fixture("context-window-backend-authority-race-");
  const sourcePath = join(paths.directory, "archive.db");
  const project = "/project/backend-authority-race";
  let daemonProcessId;
  try {
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const options = {
      ...paths,
      sourcePath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    };
    const results = await Promise.all([
      workerResult(backendAuthorityRaceWorker({
        kind: "sqlite",
        barrier,
        authorityModuleUrl: AUTHORITY_MODULE_URL,
        facadeModuleUrl: FACADE_MODULE_URL,
        sourcePath,
        options,
      })),
      workerResult(backendAuthorityRaceWorker({
        kind: "rocksdb",
        barrier,
        authorityModuleUrl: AUTHORITY_MODULE_URL,
        facadeModuleUrl: FACADE_MODULE_URL,
        sourcePath,
        options,
      })),
    ]);
    assert.equal(results.filter(({ outcome }) => outcome === "fulfilled").length, 1);
    assert.equal(results.filter(({ outcome }) => outcome === "rejected").length, 1);
    assert.ok(results.find(({ outcome }) => outcome === "rejected").code
      === (results.find(({ outcome }) => outcome === "rejected").kind === "rocksdb"
        ? "MIGRATION_REQUIRED"
        : "MIGRATION_BLOCKED"));

    const client = new StoreClient({ socketPath: paths.socketPath, project, requestTimeoutMs: 5_000 });
    try {
      daemonProcessId = (await client.request("daemon.status", {})).processId;
    } finally {
      client.close();
    }
  } finally {
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test("concurrent facades race safely and reconnect after daemon restart", async () => {
  const paths = fixture("context-window-daemon-race-");
  let archive;
  let daemonProcessId;
  try {
    const common = {
      moduleUrl: FACADE_MODULE_URL,
      ...paths,
      project: "/project/race",
      sessionId: "race-session",
    };
    const startupBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workers = [
      racingFacadeWorker({
        ...common,
        barrier: startupBarrier,
        id: "racing-a",
        text: "first independently archived document",
        createdAt: 1,
      }),
      racingFacadeWorker({
        ...common,
        barrier: startupBarrier,
        id: "racing-b",
        text: "second independently archived document",
        createdAt: 2,
      }),
    ];
    const results = await Promise.all(workers.map(workerResult));
    assert.deepEqual(new Set(results.map(({ id }) => id)), new Set(["racing-a", "racing-b"]));

    archive = new DaemonArchive({
      ...paths,
      project: "/project/race",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
    daemonProcessId = archive.stats().processId;
    assert.ok(results.some(({ processId }) => processId === daemonProcessId));
    assert.equal(archive.count({
      sessionId: "race-session",
      project: "/project/race",
    }), 2);

    const sameBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const sameResults = await Promise.all([
      racingFacadeWorker({
        ...common,
        barrier: sameBarrier,
        id: "racing-shared",
        text: "same-content idempotent race",
        createdAt: 3,
      }),
      racingFacadeWorker({
        ...common,
        barrier: sameBarrier,
        id: "racing-shared",
        text: "same-content idempotent race",
        createdAt: 3,
      }),
    ].map(workerResult));
    assert.deepEqual(sameResults.map(({ id }) => id), ["racing-shared", "racing-shared"]);
    assert.equal(archive.count({ sessionId: "race-session" }), 3);

    const updateBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const updateResults = await Promise.all([
      racingFacadeWorker({
        ...common,
        barrier: updateBarrier,
        id: "racing-shared",
        text: "different-content race left",
        createdAt: 4,
      }),
      racingFacadeWorker({
        ...common,
        barrier: updateBarrier,
        id: "racing-shared",
        text: "different-content race right",
        createdAt: 5,
      }),
    ].map(workerResult));
    assert.deepEqual(updateResults.map(({ id }) => id), ["racing-shared", "racing-shared"]);
    assert.equal(archive.count({ sessionId: "race-session" }), 3);
    assert.equal(archive.get("racing-shared").version, 3);
    assert.ok([
      "different-content race left",
      "different-content race right",
    ].includes(archive.get("racing-shared").text));

    await stopProcess(daemonProcessId);
    assert.equal(archive.get("racing-a").text, "first independently archived document");
    const restartedProcessId = archive.stats().processId;
    assert.notEqual(restartedProcessId, daemonProcessId);
    daemonProcessId = restartedProcessId;
    assert.equal(archive.get("racing-b").text, "second independently archived document");
    assert.equal(archive.get("racing-shared").version, 3);
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(daemonProcessId);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
  }
});
