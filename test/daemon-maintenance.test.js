import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { DaemonMaintenance } from "../src/daemon/maintenance.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  normalizeArchiveRetentionPolicy,
  retentionForAdmission,
  retentionPolicyFromDays,
} from "../src/daemon/retention-policy.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function fakeStore(properties = {}) {
  return {
    path: "/fake/archive.rocks",
    properties: () => ({
      totalSstBytes: 1_000,
      liveDataBytes: 900,
      ...properties,
    }),
  };
}

async function stopProcess(processId) {
  if (!processId) return;
  try { process.kill(processId, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(processId, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(processId, "SIGKILL"); } catch {}
}

test("archive retention policy assigns explicit expiries and keeps manual evidence durable", () => {
  const policy = normalizeArchiveRetentionPolicy();
  assert.deepEqual(retentionForAdmission(policy, { kind: "tool-result", now: 1_000 }), {
    retentionClass: "ephemeral-payload",
    expiresAt: 1_000 + (14 * DAY_MS),
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "turn", now: 1_000 }), {
    retentionClass: "conversation-source",
    expiresAt: 1_000 + (90 * DAY_MS),
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "decision-candidate", now: 1_000 }), {
    retentionClass: "derived-evidence",
    expiresAt: 1_000 + (30 * DAY_MS),
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "fact-candidate", now: 1_000 }), {
    retentionClass: "derived-evidence",
    expiresAt: 1_000 + (30 * DAY_MS),
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "manual", now: 1_000 }), {
    retentionClass: "durable-evidence",
  });
});

test("archive retention policy accepts class, kind, and zero-day durability overrides", () => {
  const policy = normalizeArchiveRetentionPolicy({
    classByKind: { transcript: "active-evidence" },
    lifetimeMsByClass: { "active-evidence": 5_000 },
    lifetimeMsByKind: { transcript: 2_000, turn: null },
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "transcript", now: 100 }), {
    retentionClass: "active-evidence",
    expiresAt: 2_100,
  });
  assert.deepEqual(retentionForAdmission(policy, { kind: "turn", now: 100 }), {
    retentionClass: "conversation-source",
  });
  assert.deepEqual(retentionForAdmission(policy, {
    kind: "manual",
    retentionClass: "ephemeral-payload",
    expiresAt: 123,
    now: 100,
  }), { retentionClass: "ephemeral-payload", expiresAt: 123 });

  const fromDays = normalizeArchiveRetentionPolicy(retentionPolicyFromDays({
    ephemeralRetentionDays: 1,
    conversationRetentionDays: 0,
    derivedRetentionDays: 2,
  }));
  assert.equal(fromDays.lifetimeMsByClass["ephemeral-payload"], DAY_MS);
  assert.equal(fromDays.lifetimeMsByClass["conversation-source"], null);
  assert.equal(fromDays.lifetimeMsByClass["derived-evidence"], 2 * DAY_MS);
});

test("daemon archive admissions persist configured expiry while manual archives remain durable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-admission-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  let archive;
  let processId;
  try {
    archive = new DaemonArchive({
      storePath,
      socketPath,
      project: "/retention/project",
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
      retentionPolicy: { lifetimeMsByKind: { turn: 1_000 } },
    });
    processId = archive.stats().processId;
    archive.put({
      id: "expires",
      sessionId: "session",
      kind: "turn",
      text: "ordinary expiring conversation",
      createdAt: 1_000,
    });
    archive.put({
      id: "durable",
      sessionId: "session",
      kind: "manual",
      text: "explicit durable archive",
      createdAt: 1_000,
    });
    assert.equal(archive.count({ scope: "all" }), 2);
    const result = archive.prune({ now: 2_000, batchSize: 10 });
    assert.equal(result.deletedDocuments, 1);
    assert.equal(archive.get("expires"), undefined);
    assert.equal(archive.get("durable").text, "explicit durable archive");
    assert.equal(archive.count({ scope: "all" }), 1);
  } finally {
    try { archive?.close(); } catch {}
    await stopProcess(processId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maintenance startup and ticks are bounded, non-overlapping, and compact deletion waves", async () => {
  const calls = { retention: 0, protections: 0, leases: 0, hints: 0, emergency: [], compact: [] };
  let releaseRetention;
  const blockedRetention = new Promise((resolve) => { releaseRetention = resolve; });
  const maintenance = new DaemonMaintenance(fakeStore({ liveDataBytes: 100 }), {
    intervalMs: 1_000_000,
    retentionBatchSize: 2,
    maxRetentionWaves: 2,
    compactionDeletedKeys: 3,
    compactionReclaimableBytes: 10_000,
    criticalFreeBytes: 1_000,
    admissionReserveBytes: 100,
    now: () => 2_000,
    readFreeBytes: () => 500,
    updateEmergencyMode: async (request) => { calls.emergency.push(request); },
    cleanupProtections: async (_store, options) => {
      calls.protections += 1;
      assert.deepEqual(options, { now: 2_000, limit: 1_000 });
      return { scanned: 0, released: 0, more: false };
    },
    cleanupLeases: async () => {
      calls.leases += 1;
      return { scanned: 0, removed: 0, more: false };
    },
    cleanupHints: async () => {
      calls.hints += 1;
      return { scanned: 0, removed: 0, rescheduled: 0 };
    },
    runRetention: async (request) => {
      calls.retention += 1;
      assert.deepEqual(request, { now: 2_000, force: true, batchSize: 2 });
      if (calls.retention === 1) await blockedRetention;
      return calls.retention === 1
        ? { status: "more-work", tombstoned: 1, deletedKeys: 2 }
        : { status: "complete", tombstoned: 1, deletedKeys: 1 };
    },
    compact: async (reason) => {
      calls.compact.push(reason);
      return { status: "complete", bytesBefore: 1_000, bytesAfter: 500 };
    },
  });
  await maintenance.initialize();
  assert.equal(maintenance.timer.hasRef(), false);
  assert.deepEqual(calls.emergency.map(({ emergencyMode }) => emergencyMode), [true]);
  assert.deepEqual([calls.protections, calls.leases, calls.hints], [1, 1, 1]);

  const first = maintenance.trigger();
  const second = maintenance.trigger();
  assert.equal(first, second);
  releaseRetention();
  const result = await first;
  assert.equal(result.waves, 2);
  assert.equal(result.tombstoned, 2);
  assert.equal(result.deletedKeys, 3);
  assert.deepEqual(calls.compact, ["disk-pressure"]);
  assert.equal(calls.retention, 2);
  assert.deepEqual([calls.protections, calls.leases, calls.hints], [2, 2, 2]);
  await maintenance.close();
  assert.equal(maintenance.timer, undefined);
});

test("a flush-only compaction schedule keeps the deletion trigger armed", async () => {
  let retentionRuns = 0;
  let compactionAttempts = 0;
  const maintenance = new DaemonMaintenance(fakeStore(), {
    intervalMs: 1_000_000,
    compactionDeletedKeys: 1,
    criticalFreeBytes: 0,
    readFreeBytes: () => 10_000,
    updateEmergencyMode: async () => {},
    cleanupProtections: async () => ({}),
    cleanupLeases: async () => ({}),
    cleanupHints: async () => ({}),
    runRetention: async () => ({
      status: "complete",
      tombstoned: 0,
      deletedKeys: retentionRuns++ === 0 ? 1 : 0,
    }),
    compact: async () => {
      compactionAttempts += 1;
      return { status: "scheduled", bytesBefore: 1_000, bytesAfter: 1_000 };
    },
  });
  await maintenance.runOnce();
  await maintenance.runOnce();
  assert.equal(compactionAttempts, 2);
  assert.equal(maintenance.deletedKeysSinceCompaction, 1);
});

test("observed background reclamation clears the scheduled deletion trigger", async () => {
  const properties = {
    totalSstBytes: 1_000,
    liveDataBytes: 900,
    pendingCompactionBytes: 100,
  };
  let retentionRuns = 0;
  let compactionAttempts = 0;
  const maintenance = new DaemonMaintenance(fakeStore(properties), {
    intervalMs: 1_000_000,
    compactionDeletedKeys: 1,
    criticalFreeBytes: 0,
    readFreeBytes: () => 10_000,
    updateEmergencyMode: async () => {},
    cleanupProtections: async () => ({}),
    cleanupLeases: async () => ({}),
    cleanupHints: async () => ({}),
    runRetention: async () => ({
      status: "complete",
      tombstoned: 0,
      deletedKeys: retentionRuns++ === 0 ? 1 : 0,
    }),
    compact: async () => {
      compactionAttempts += 1;
      return { status: "scheduled", bytesBefore: 1_000, bytesAfter: 1_000 };
    },
  });
  await maintenance.runOnce();
  assert.equal(compactionAttempts, 1);
  properties.totalSstBytes = 800;
  properties.liveDataBytes = 780;
  properties.pendingCompactionBytes = 0;
  await maintenance.runOnce();
  assert.equal(compactionAttempts, 1);
  assert.equal(maintenance.deletedKeysSinceCompaction, 0);
  assert.equal(maintenance.pendingCompaction, undefined);
});

test("reclamation completed during flush does not leave a pending trigger", async () => {
  const properties = {
    totalSstBytes: 1_000,
    liveDataBytes: 900,
    pendingCompactionBytes: 100,
  };
  let retentionRuns = 0;
  let compactionAttempts = 0;
  const maintenance = new DaemonMaintenance(fakeStore(properties), {
    intervalMs: 1_000_000,
    compactionDeletedKeys: 1,
    criticalFreeBytes: 0,
    readFreeBytes: () => 10_000,
    updateEmergencyMode: async () => {},
    cleanupProtections: async () => ({}),
    cleanupLeases: async () => ({}),
    cleanupHints: async () => ({}),
    runRetention: async () => ({
      status: "complete",
      tombstoned: 0,
      deletedKeys: retentionRuns++ === 0 ? 1 : 0,
    }),
    compact: async () => {
      compactionAttempts += 1;
      properties.totalSstBytes = 800;
      properties.liveDataBytes = 780;
      properties.pendingCompactionBytes = 0;
      return { status: "scheduled", bytesBefore: 1_000, bytesAfter: 800 };
    },
  });
  await maintenance.runOnce();
  await maintenance.runOnce();
  assert.equal(compactionAttempts, 1);
  assert.equal(maintenance.deletedKeysSinceCompaction, 0);
  assert.equal(maintenance.pendingCompaction, undefined);
});

test("maintenance admission guard returns retryable disk-low and background failures remain retryable", async () => {
  const errors = [];
  let attempts = 0;
  const maintenance = new DaemonMaintenance(fakeStore(), {
    intervalMs: 1_000_000,
    criticalFreeBytes: 1_000,
    admissionReserveBytes: 100,
    readFreeBytes: () => 1_150,
    cleanupProtections: async () => ({}),
    cleanupLeases: async () => ({}),
    cleanupHints: async () => ({}),
    updateEmergencyMode: async () => {},
    recordError: (error) => errors.push(error),
    runRetention: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("temporary maintenance failure"), {
        code: "STORE_BUSY",
      });
      return { status: "complete", tombstoned: 0, deletedKeys: 0 };
    },
    compact: async () => ({ status: "complete" }),
  });
  assert.throws(
    () => maintenance.assertCanAdmit(100),
    (error) => error.code === "DISK_LOW" && error.details.freeBytes === 1_150,
  );
  assert.doesNotThrow(() => maintenance.assertCanAdmit(10));
  assert.equal((await maintenance.trigger()).status, "error");
  assert.equal(errors.length, 1);
  assert.equal((await maintenance.trigger()).status, "complete");
  assert.equal(attempts, 2);
  await maintenance.close();
});

test("a zero disk threshold clears durable emergency mode during startup", async () => {
  const updates = [];
  const maintenance = new DaemonMaintenance(fakeStore(), {
    intervalMs: 1_000_000,
    criticalFreeBytes: 0,
    readFreeBytes: () => 500,
    updateEmergencyMode: async (request) => { updates.push(request); },
    cleanupProtections: async () => ({}),
    cleanupLeases: async () => ({}),
    cleanupHints: async () => ({}),
    runRetention: async () => ({ status: "complete", tombstoned: 0, deletedKeys: 0 }),
    compact: async () => ({ status: "complete" }),
  });
  await maintenance.initialize();
  assert.deepEqual(updates.map(({ emergencyMode, criticalFreeBytes }) => ({
    emergencyMode,
    criticalFreeBytes,
  })), [{ emergencyMode: false, criticalFreeBytes: 0 }]);
  assert.doesNotThrow(() => maintenance.assertCanAdmit(Number.MAX_SAFE_INTEGER));
  await maintenance.close();
});
