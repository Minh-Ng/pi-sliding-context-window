import { performance } from "node:perf_hooks";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Archive } from "../../src/archive/archive.js";
import { compactDeletionWave } from "../../src/rocksdb/compaction.js";
import { KEYSPACE } from "../../src/rocksdb/keys.js";
import { admitDocument } from "../../src/rocksdb/manifests.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { RocksStore } from "../../src/rocksdb/store.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store/store-contract.js";
import { collectEvaluationEnvironment } from "../../eval/retrieval/environment.js";
import {
  createArchiveBenchmarkArtifact,
  summarizeLatency,
  validateArchiveBenchmarkArtifact,
} from "./artifact.js";
import {
  ARCHIVE_BENCHMARK_CLIENT_COUNTS,
  ARCHIVE_BENCHMARK_SEED,
  archiveWarmupOperationCount,
  benchmarkDocumentAt,
  createArchiveBenchmarkFixture,
} from "./fixture.js";

const SQLITE_BENCHMARK_RETENTION = Object.freeze({
  maxBytes: 8 * 1024 * 1024 * 1024 * 1024,
  targetBytes: 6 * 1024 * 1024 * 1024 * 1024,
  recentProtectionMs: 0,
  minimumTurnsPerSession: 0,
});

export function archiveScenarioName(backend, workload, clients) {
  return `${backend}.${workload}.clients-${clients}`;
}

function workloadProfile(workload) {
  if (workload === "tool-10kib") return "tool-10kib";
  if (workload === "tool-1mib") return "tool-1mib";
  return undefined;
}

function operationCount(fixture, workload, clients) {
  return workload === "canonical"
    ? Math.max(fixture.logicalWindows, clients)
    : Math.max(fixture.largeSamples, clients);
}

function scenarioDocument(index, count, fixture, workload) {
  return benchmarkDocumentAt(index, {
    count,
    seed: fixture.seed,
    officialScale: workload === "canonical" && fixture.officialScale,
    profile: workloadProfile(workload),
  });
}

function warmupDocument(index, count, fixture, workload, clients) {
  const document = benchmarkDocumentAt(index, {
    count,
    seed: fixture.seed,
    officialScale: false,
    profile: workloadProfile(workload) ?? "short",
  });
  return {
    ...document,
    id: `warmup-${workload}-${clients}-${index}`,
    sessionId: `warmup-session-${index % clients}`,
  };
}

function rocksAdmission(document, idempotencyKey) {
  const sourceKey = `benchmark:${document.id}`;
  return {
    idempotencyKey,
    document: {
      documentId: document.id,
      version: 1,
      sourceKey,
      sessionId: document.sessionId,
      project: document.project,
      kind: document.kind,
      createdAt: document.createdAt,
      text: document.text,
      metadata: document.metadata,
      sourceMessageKeys: [sourceKey],
      sourceKeyStatus: "preserved",
    },
    structuralMessages: [],
    retentionClass: document.kind === "tool-result"
      ? "ephemeral-payload"
      : "conversation-source",
  };
}

function createScenario({
  backend,
  workload,
  clients,
  executionModel,
  samples,
  payloadBytes,
  wallMilliseconds,
  busyRetryCount = 0,
  warmupOperationCount: completedWarmups,
}) {
  return Object.freeze({
    backend,
    workload,
    clients,
    executionModel,
    operationCount: samples.length,
    warmupOperationCount: completedWarmups,
    payloadBytes,
    busyRetryCount,
    wallMilliseconds,
    operationsPerSecond: samples.length / (wallMilliseconds / 1_000),
    payloadBytesPerSecond: payloadBytes / (wallMilliseconds / 1_000),
    latencyMilliseconds: Object.freeze({
      samples: Object.freeze(samples),
      summary: summarizeLatency(samples),
    }),
  });
}

function temporaryRoot(label) {
  return mkdtempSync(join(tmpdir(), `context-window-${label}-`));
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`SQLite benchmark worker exited with code ${code} before ${type}`));
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

async function runSqliteScenario({ fixture, workload, clients }) {
  const root = temporaryRoot("sqlite-benchmark");
  const path = join(root, "archive.sqlite");
  const archives = [];
  try {
    if (clients > 1) {
      const workers = [];
      try {
        // Archive performs schema and policy setup in its constructor. Open the
        // connections serially, then start their measured writes together.
        for (let clientIndex = 0; clientIndex < clients; clientIndex += 1) {
          const worker = new Worker(new URL("./sqlite-worker.js", import.meta.url), {
            workerData: {
              clientIndex,
              clients,
              fixture,
              path,
              retention: SQLITE_BENCHMARK_RETENTION,
              workload,
            },
          });
          workers.push(worker);
          await waitForWorkerMessage(worker, "ready");
        }
        const results = workers.map((worker) => waitForWorkerMessage(worker, "result"));
        const wallStartedAt = performance.now();
        for (const worker of workers) worker.postMessage({ type: "start" });
        const workerResults = await Promise.all(results);
        const wallMilliseconds = performance.now() - wallStartedAt;
        const count = operationCount(fixture, workload, clients);
        const samples = Array(count);
        let payloadBytes = 0;
        let busyRetryCount = 0;
        for (const result of workerResults) {
          payloadBytes += result.payloadBytes;
          busyRetryCount += result.busyRetryCount;
          for (const [index, milliseconds] of result.samples) samples[index] = milliseconds;
        }
        if (samples.some((value) => value === undefined)) {
          throw new Error("SQLite workers did not return every benchmark sample");
        }
        return createScenario({
          backend: "sqlite",
          workload,
          clients,
          executionModel: "eight concurrent worker-thread clients with independent Archive connections",
          samples,
          payloadBytes,
          wallMilliseconds,
          busyRetryCount,
          warmupOperationCount: archiveWarmupOperationCount(workload, clients),
        });
      } finally {
        await Promise.allSettled(workers.map((worker) => worker.terminate()));
      }
    }
    for (let index = 0; index < clients; index += 1) {
      archives.push(new Archive(path, { retention: SQLITE_BENCHMARK_RETENTION }));
    }
    const warmups = archiveWarmupOperationCount(workload, clients);
    for (let index = 0; index < warmups; index += 1) {
      const document = warmupDocument(index, warmups, fixture, workload, clients);
      const stored = archives[index % clients].put(document, { deferPrune: true });
      if (stored !== document.id) throw new Error(`SQLite did not acknowledge warmup ${document.id}`);
    }
    const count = operationCount(fixture, workload, clients);
    const prepared = workload === "canonical"
      ? undefined
      : Array.from({ length: count }, (_, index) => scenarioDocument(index, count, fixture, workload));
    const samples = Array(count);
    let payloadBytes = 0;
    const wallStartedAt = performance.now();
    for (let index = 0; index < count; index += 1) {
      const document = prepared?.[index] ?? scenarioDocument(index, count, fixture, workload);
      payloadBytes += document.payloadBytes;
      const startedAt = performance.now();
      const stored = archives[index % clients].put(document, { deferPrune: true });
      samples[index] = performance.now() - startedAt;
      if (stored !== document.id) throw new Error(`SQLite did not acknowledge ${document.id}`);
    }
    const wallMilliseconds = performance.now() - wallStartedAt;
    return createScenario({
      backend: "sqlite",
      workload,
      clients,
      executionModel: clients === 1
        ? "single synchronous Archive connection"
        : "eight concurrent worker-thread clients with independent Archive connections",
      samples,
      payloadBytes,
      wallMilliseconds,
      busyRetryCount: 0,
      warmupOperationCount: warmups,
    });
  } finally {
    for (const archive of archives.reverse()) archive.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function runRocksScenario({ fixture, workload, clients }) {
  const root = temporaryRoot("rocksdb-benchmark");
  const path = join(root, "archive.rocks");
  let store;
  try {
    store = await RocksStore.open(path, { parallelismThreads: Math.min(8, clients) });
    const warmups = archiveWarmupOperationCount(workload, clients);
    for (let index = 0; index < warmups; index += 1) {
      const document = warmupDocument(index, warmups, fixture, workload, clients);
      const result = await admitDocument(
        store,
        rocksAdmission(document, `benchmark:warmup:${workload}:${clients}:${index}`),
      );
      if (result.status !== "stored" || result.documentId !== document.id) {
        throw new Error(`RocksDB did not acknowledge warmup ${document.id}`);
      }
    }
    const count = operationCount(fixture, workload, clients);
    const prepared = workload === "canonical"
      ? undefined
      : Array.from({ length: count }, (_, index) => scenarioDocument(index, count, fixture, workload));
    const samples = Array(count);
    const payloadSizes = Array(count);
    const busyRetries = Array(count).fill(0);
    const wallStartedAt = performance.now();
    await Promise.all(Array.from({ length: clients }, async (_, clientIndex) => {
      for (let index = clientIndex; index < count; index += clients) {
        const document = prepared?.[index] ?? scenarioDocument(index, count, fixture, workload);
        payloadSizes[index] = document.payloadBytes;
        const startedAt = performance.now();
        const request = rocksAdmission(
          document,
          `benchmark:${workload}:${clients}:${index}`,
        );
        let result;
        for (let attempt = 0; ; attempt += 1) {
          try {
            result = await admitDocument(store, request);
            break;
          } catch (error) {
            if (!/busy/i.test(error instanceof Error ? error.message : String(error)) || attempt >= 99) throw error;
            busyRetries[index] += 1;
            await new Promise((resolve) => setTimeout(resolve, Math.min(5, attempt + 1)));
          }
        }
        samples[index] = performance.now() - startedAt;
        if (result?.status !== "stored" || result.documentId !== document.id) {
          throw new Error(`RocksDB returned an invalid acknowledgement for ${document.id}`);
        }
      }
    }));
    const wallMilliseconds = performance.now() - wallStartedAt;
    await store.flush();
    return createScenario({
      backend: "rocksdb",
      workload,
      clients,
      executionModel: clients === 1
        ? "single production document-admission client on the process-owned RocksStore"
        : "eight concurrent logical clients using production document admission on the process-owned RocksStore",
      samples,
      payloadBytes: payloadSizes.reduce((total, value) => total + value, 0),
      wallMilliseconds,
      busyRetryCount: busyRetries.reduce((total, value) => total + value, 0),
      warmupOperationCount: warmups,
    });
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function directoryBytes(path) {
  let total = 0;
  const visit = (entryPath) => {
    const stat = lstatSync(entryPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(entryPath)) visit(join(entryPath, entry));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  };
  visit(path);
  return total;
}

function deterministicBinary(size, seed) {
  const payload = Buffer.allocUnsafe(size);
  let value = seed >>> 0 || 1;
  for (let offset = 0; offset < size; offset += 4) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const remaining = Math.min(4, size - offset);
    for (let byte = 0; byte < remaining; byte += 1) {
      payload[offset + byte] = (value >>> (byte * 8)) & 0xff;
    }
  }
  return payload;
}

function physicalProperties(store, root) {
  const properties = store.properties();
  const liveBlobBytes = store.database.getDBIntProperty("rocksdb.live-blob-file-size") ?? 0;
  return {
    directoryBytes: directoryBytes(root),
    totalSstBytes: properties.totalSstBytes,
    liveBlobBytes,
    physicalDataBytes: properties.totalSstBytes + liveBlobBytes,
    liveDataBytes: properties.liveDataBytes,
  };
}

async function runRetentionProbe(fixture) {
  const root = temporaryRoot("rocksdb-retention-benchmark");
  const path = join(root, "archive.rocks");
  let store;
  try {
    store = await RocksStore.open(path, { parallelismThreads: 2 });
    for (let index = 0; index < fixture.retentionRecords; index += 1) {
      await store.putImmutable(
        [KEYSPACE.CHUNK, "retention-benchmark", index],
        deterministicBinary(fixture.retentionRecordBytes, fixture.seed ^ (index + 1)),
        { kind: "chunk" },
      );
    }
    await store.flush();
    await store.compact({ prefix: [KEYSPACE.CHUNK, "retention-benchmark"] });
    await store.flush();
    const before = physicalProperties(store, root);

    for (let index = 0; index < fixture.retentionRecords; index += 2) {
      await store.remove([KEYSPACE.CHUNK, "retention-benchmark", index]);
    }
    await store.flush();
    await compactDeletionWave(store, {
      prefix: [KEYSPACE.CHUNK, "retention-benchmark"],
    });
    const after = physicalProperties(store, root);

    let retainedReadable = true;
    let deletedAbsent = true;
    for (let index = 0; index < fixture.retentionRecords; index += 1) {
      const value = await store.get([KEYSPACE.CHUNK, "retention-benchmark", index]);
      if (index % 2 === 0) deletedAbsent &&= value === undefined;
      else retainedReadable &&= Buffer.isBuffer(value) && value.length === fixture.retentionRecordBytes;
    }
    // The release gate is specifically SST plus live blob bytes. RocksDB may
    // create new MANIFEST/LOG files during a successful compaction, so whole
    // directory size is diagnostic rather than the reclamation denominator.
    const physicalDecreaseBytes = Math.max(0, before.physicalDataBytes - after.physicalDataBytes);
    const liveDataFileDecreaseBytes = Math.max(0, before.physicalDataBytes - after.physicalDataBytes);
    return Object.freeze({
      recordCount: fixture.retentionRecords,
      recordBytes: fixture.retentionRecordBytes,
      totalPayloadBytes: fixture.retentionRecords * fixture.retentionRecordBytes,
      deletedCount: fixture.retentionRecords / 2,
      deletedPayloadBytes: (fixture.retentionRecords / 2) * fixture.retentionRecordBytes,
      before,
      after,
      physicalDecreaseBytes,
      physicalDecreaseRatio: before.physicalDataBytes === 0
        ? 0
        : physicalDecreaseBytes / before.physicalDataBytes,
      liveDataFileDecreaseBytes,
      liveDataFileDecreaseRatio: before.physicalDataBytes === 0
        ? 0
        : liveDataFileDecreaseBytes / before.physicalDataBytes,
      retainedReadable,
      deletedAbsent,
    });
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runArchiveBenchmark({
  mode = "comparison",
  count = 100,
  scale = "quick",
  seed = ARCHIVE_BENCHMARK_SEED,
  largeSamples = 8,
  retentionRecords = 64,
  retentionRecordBytes = 64 * 1024,
  environment,
} = {}) {
  const fixture = createArchiveBenchmarkFixture({
    count,
    scale,
    seed,
    largeSamples,
    retentionRecords,
    retentionRecordBytes,
  });
  const scenarios = {};
  let retention = null;
  const notes = [];
  if (mode === "retention") {
    retention = await runRetentionProbe(fixture);
    notes.push("This mode measures physical RocksDB deletion and compaction only; semantic retention races are not exercised.");
  } else {
    for (const clients of ARCHIVE_BENCHMARK_CLIENT_COUNTS) {
      for (const workload of ["canonical", "tool-10kib", "tool-1mib"]) {
        const sqlite = await runSqliteScenario({ fixture, workload, clients });
        scenarios[archiveScenarioName("sqlite", workload, clients)] = sqlite;
        if (mode === "comparison") {
          const rocksdb = await runRocksScenario({ fixture, workload, clients });
          scenarios[archiveScenarioName("rocksdb", workload, clients)] = rocksdb;
        }
      }
    }
    notes.push("SQLite eight-client results use eight worker threads with independent Archive connections to exercise real lock contention.");
    notes.push("RocksDB results use the production canonical document-admission path, including chunking, manifests, references, history transition, and durable outbox enqueue.");
    notes.push("RocksDB eight-client results use concurrent logical client loops against the single process-owned store.");
    if (mode === "baseline") {
      notes.push("Baseline mode records SQLite metrics and intentionally does not score relative RocksDB gates.");
    }
  }

  const artifact = createArchiveBenchmarkArtifact({
    mode,
    environment: environment ?? collectEvaluationEnvironment(),
    fixture,
    release: {
      storageSchemaVersion: STORE_SCHEMA_VERSION,
      storageSchemaFingerprint: SCHEMA_FINGERPRINT,
      protocolVersion: STORE_PROTOCOL_VERSION,
    },
    scenarios,
    retention,
    notes,
  });
  validateArchiveBenchmarkArtifact(artifact);
  return artifact;
}
