import { hashJson } from "../../eval/retrieval/schema.js";
import { validateEvaluationEnvironment } from "../../eval/retrieval/environment.js";
import {
  ARCHIVE_BENCHMARK_CLIENT_COUNTS,
  ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
  archiveWarmupOperationCount,
  createArchiveBenchmarkFixture,
} from "./fixture.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store/store-contract.js";

export const ARCHIVE_BENCHMARK_ARTIFACT_VERSION = 1;
export const ARCHIVE_BENCHMARK_MODES = Object.freeze(["baseline", "comparison", "retention"]);
export const ARCHIVE_BENCHMARK_GATE_NAMES = Object.freeze([
  "canonicalAppendP95",
  "largeToolIngestThroughput",
  "warmPreflightP95",
  "threeWindowRecallP95",
  "steadyStateRss",
  "indexingBacklogRecovery",
  "acknowledgedWriteRecovery",
  "retentionCompaction",
]);

const ARTIFACT_DESCRIPTOR = Object.freeze({
  artifactVersion: ARCHIVE_BENCHMARK_ARTIFACT_VERSION,
  modes: ARCHIVE_BENCHMARK_MODES,
  gateNames: ARCHIVE_BENCHMARK_GATE_NAMES,
  clientCounts: ARCHIVE_BENCHMARK_CLIENT_COUNTS,
  scenarioWorkloads: ["canonical", "tool-10kib", "tool-1mib"],
  scenarioMetrics: ["warmupOperationCount", "wallMilliseconds", "latencyMilliseconds", "operationsPerSecond", "payloadBytesPerSecond", "busyRetryCount"],
  rocksScenarioAdmission: "production canonical document admission with chunks, manifests, references, history, and outbox",
  retentionPhysicalBytes: "directory bytes, with current SST plus blob bytes recorded as a diagnostic",
  retentionFixtureBinding: "record count and record bytes must exactly match the frozen fixture",
  requiredScenarios: Object.freeze({ baseline: 6, comparison: 12, retention: 0 }),
  gateStatuses: ["passed", "failed", "not-measured"],
  outcomes: ["passed", "failed", "partial", "not-measured"],
});

export const ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT =
  "sha256:8c0a976da0100c2b9290decc048098edb7734d6de655b4c7aaa814a06436f285";

function finiteNonNegative(value, path) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${path} must be a non-negative finite number`);
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer`);
}

function approximatelyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 8;
}

export function summarizeLatency(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("latency samples must be a non-empty array");
  }
  for (const [index, sample] of samples.entries()) finiteNonNegative(sample, `latency samples[${index}]`);
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (value) => ordered[Math.max(0, Math.ceil(value * ordered.length) - 1)];
  const sum = samples.reduce((total, value) => total + value, 0);
  return Object.freeze({
    sampleCount: samples.length,
    min: ordered[0],
    mean: sum / samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1),
  });
}

function validateScenario(name, scenario) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new TypeError(`scenario ${name} must be an object`);
  }
  if (!new Set(["sqlite", "rocksdb"]).has(scenario.backend)) {
    throw new TypeError(`scenario ${name}.backend is invalid`);
  }
  if (!new Set(["canonical", "tool-10kib", "tool-1mib"]).has(scenario.workload)) {
    throw new TypeError(`scenario ${name}.workload is invalid`);
  }
  if (!ARCHIVE_BENCHMARK_CLIENT_COUNTS.includes(scenario.clients)) {
    throw new TypeError(`scenario ${name}.clients is invalid`);
  }
  if (name !== scenarioName(scenario.backend, scenario.workload, scenario.clients)) {
    throw new Error(`scenario ${name} does not match its backend, workload, and client metadata`);
  }
  if (typeof scenario.executionModel !== "string" || scenario.executionModel.length === 0) {
    throw new TypeError(`scenario ${name}.executionModel must be a non-empty string`);
  }
  positiveInteger(scenario.operationCount, `scenario ${name}.operationCount`);
  positiveInteger(scenario.warmupOperationCount, `scenario ${name}.warmupOperationCount`);
  positiveInteger(scenario.payloadBytes, `scenario ${name}.payloadBytes`);
  if (!Number.isSafeInteger(scenario.busyRetryCount) || scenario.busyRetryCount < 0) {
    throw new TypeError(`scenario ${name}.busyRetryCount must be a non-negative integer`);
  }
  finiteNonNegative(scenario.wallMilliseconds, `scenario ${name}.wallMilliseconds`);
  if (scenario.wallMilliseconds === 0) throw new TypeError(`scenario ${name}.wallMilliseconds must be positive`);
  finiteNonNegative(scenario.operationsPerSecond, `scenario ${name}.operationsPerSecond`);
  finiteNonNegative(scenario.payloadBytesPerSecond, `scenario ${name}.payloadBytesPerSecond`);
  if (!Array.isArray(scenario.latencyMilliseconds?.samples)
    || scenario.latencyMilliseconds.samples.length !== scenario.operationCount) {
    throw new TypeError(`scenario ${name} latency samples must match operationCount`);
  }
  const recomputed = summarizeLatency(scenario.latencyMilliseconds.samples);
  if (JSON.stringify(recomputed) !== JSON.stringify(scenario.latencyMilliseconds.summary)) {
    throw new Error(`scenario ${name} latency summary does not match raw samples`);
  }
  const operationsPerSecond = scenario.operationCount / (scenario.wallMilliseconds / 1_000);
  const payloadBytesPerSecond = scenario.payloadBytes / (scenario.wallMilliseconds / 1_000);
  if (operationsPerSecond !== scenario.operationsPerSecond
    || payloadBytesPerSecond !== scenario.payloadBytesPerSecond) {
    throw new Error(`scenario ${name} throughput does not match operation totals`);
  }
}

function scenarioName(backend, workload, clients) {
  return `${backend}.${workload}.clients-${clients}`;
}

function notMeasured(reason) {
  return { status: "not-measured", reason };
}

function canonicalAppendGate(mode, scenarios) {
  if (mode !== "comparison") {
    return notMeasured("A RocksDB-to-SQLite comparison is not present in this mode.");
  }
  const comparisons = [];
  for (const clients of ARCHIVE_BENCHMARK_CLIENT_COUNTS) {
    const sqlite = scenarios[scenarioName("sqlite", "canonical", clients)];
    const rocksdb = scenarios[scenarioName("rocksdb", "canonical", clients)];
    if (!sqlite || !rocksdb) return notMeasured(`Canonical append scenarios are missing for ${clients} client(s).`);
    const sqliteP95 = sqlite.latencyMilliseconds.summary.p95;
    const rocksdbP95 = rocksdb.latencyMilliseconds.summary.p95;
    comparisons.push({
      clients,
      sqliteP95Milliseconds: sqliteP95,
      rocksdbP95Milliseconds: rocksdbP95,
      ratio: sqliteP95 === 0 ? null : rocksdbP95 / sqliteP95,
      passed: rocksdbP95 <= sqliteP95,
    });
  }
  return {
    status: comparisons.every(({ passed }) => passed) ? "passed" : "failed",
    requirement: "RocksDB canonical append p95 is no slower than SQLite at one and eight clients.",
    comparisons,
  };
}

function largeToolGate(mode, scenarios) {
  if (mode !== "comparison") {
    return notMeasured("A RocksDB-to-SQLite comparison is not present in this mode.");
  }
  const comparisons = [];
  for (const workload of ["tool-10kib", "tool-1mib"]) {
    for (const clients of ARCHIVE_BENCHMARK_CLIENT_COUNTS) {
      const sqlite = scenarios[scenarioName("sqlite", workload, clients)];
      const rocksdb = scenarios[scenarioName("rocksdb", workload, clients)];
      if (!sqlite || !rocksdb) return notMeasured(`${workload} scenarios are missing for ${clients} client(s).`);
      const ratio = rocksdb.payloadBytesPerSecond / sqlite.payloadBytesPerSecond;
      comparisons.push({
        workload,
        clients,
        sqliteBytesPerSecond: sqlite.payloadBytesPerSecond,
        rocksdbBytesPerSecond: rocksdb.payloadBytesPerSecond,
        ratio,
        passed: ratio >= 1.5,
      });
    }
  }
  return {
    status: comparisons.every(({ passed }) => passed) ? "passed" : "failed",
    requirement: "RocksDB large-tool ingest throughput is at least 1.5 times SQLite.",
    comparisons,
  };
}

function validateRetention(retention, fixture) {
  if (!retention || typeof retention !== "object" || Array.isArray(retention)) {
    throw new TypeError("retention result must be an object");
  }
  positiveInteger(retention.recordCount, "retention.recordCount");
  positiveInteger(retention.recordBytes, "retention.recordBytes");
  if (!fixture || retention.recordCount !== fixture.retentionRecords) {
    throw new Error("retention.recordCount does not match the frozen fixture");
  }
  if (retention.recordBytes !== fixture.retentionRecordBytes) {
    throw new Error("retention.recordBytes does not match the frozen fixture");
  }
  const expectedPayloadBytes = fixture.retentionRecords * fixture.retentionRecordBytes;
  if (retention.totalPayloadBytes !== expectedPayloadBytes) {
    throw new Error("retention.totalPayloadBytes does not match the frozen fixture");
  }
  if (retention.deletedCount !== fixture.retentionRecords / 2) {
    throw new Error("retention.deletedCount does not match the frozen fixture");
  }
  if (retention.deletedPayloadBytes !== expectedPayloadBytes / 2) {
    throw new Error("retention.deletedPayloadBytes does not match the frozen fixture");
  }
  if (retention.deletedCount * 2 !== retention.recordCount) {
    throw new Error("retention must delete exactly half the records");
  }
  if (retention.deletedPayloadBytes * 2 !== retention.totalPayloadBytes) {
    throw new Error("retention must delete exactly half the payload bytes");
  }
  for (const path of [
    "before.directoryBytes",
    "before.totalSstBytes",
    "before.liveBlobBytes",
    "before.physicalDataBytes",
    "after.directoryBytes",
    "after.totalSstBytes",
    "after.liveBlobBytes",
    "after.physicalDataBytes",
    "physicalDecreaseBytes",
    "physicalDecreaseRatio",
    "liveDataFileDecreaseBytes",
    "liveDataFileDecreaseRatio",
  ]) {
    const value = path.split(".").reduce((current, field) => current?.[field], retention);
    finiteNonNegative(value, `retention.${path}`);
  }
  const physicalDataBytes = {};
  for (const phase of ["before", "after"]) {
    const measurement = retention[phase];
    const expectedPhysicalDataBytes = measurement.totalSstBytes + measurement.liveBlobBytes;
    physicalDataBytes[phase] = expectedPhysicalDataBytes;
    if (measurement.physicalDataBytes !== expectedPhysicalDataBytes) {
      throw new Error(
        `retention.${phase}.physicalDataBytes must equal totalSstBytes plus liveBlobBytes`,
      );
    }
  }
  const expectedDecreaseBytes = Math.max(
    0,
    physicalDataBytes.before - physicalDataBytes.after,
  );
  if (retention.physicalDecreaseBytes !== expectedDecreaseBytes) {
    throw new Error("retention.physicalDecreaseBytes does not match the before/after measurements");
  }
  if (retention.liveDataFileDecreaseBytes !== expectedDecreaseBytes) {
    throw new Error("retention.liveDataFileDecreaseBytes does not match the before/after measurements");
  }
  const expectedDecreaseRatio = physicalDataBytes.before === 0
    ? 0
    : expectedDecreaseBytes / physicalDataBytes.before;
  if (!approximatelyEqual(retention.physicalDecreaseRatio, expectedDecreaseRatio)) {
    throw new Error("retention.physicalDecreaseRatio does not match the before/after measurements");
  }
  if (!approximatelyEqual(retention.liveDataFileDecreaseRatio, expectedDecreaseRatio)) {
    throw new Error("retention.liveDataFileDecreaseRatio does not match the before/after measurements");
  }
  if (typeof retention.retainedReadable !== "boolean" || typeof retention.deletedAbsent !== "boolean") {
    throw new TypeError("retention key verification fields must be booleans");
  }
  return {
    physicalDecreaseBytes: expectedDecreaseBytes,
    physicalDecreaseRatio: expectedDecreaseRatio,
    liveDataFileDecreaseBytes: expectedDecreaseBytes,
    liveDataFileDecreaseRatio: expectedDecreaseRatio,
  };
}

function retentionGate(mode, retention, fixture) {
  if (mode !== "retention") {
    return notMeasured("Controlled deletion and manual compaction run only in retention mode.");
  }
  const measurements = validateRetention(retention, fixture);
  const passed = retention.retainedReadable
    && retention.deletedAbsent
    && measurements.physicalDecreaseRatio >= 0.2;
  return {
    status: passed ? "passed" : "failed",
    requirement: "Deleting 50 percent of byte-weighted data and compacting materially decreases physical SST plus live blob bytes without losing retained keys.",
    scope: "Physical reclamation only; semantic expiry, pins, and retrieval leases are not measured.",
    physicalDecreaseRatio: measurements.physicalDecreaseRatio,
    liveDataFileDecreaseRatio: measurements.liveDataFileDecreaseRatio,
    retainedReadable: retention.retainedReadable,
    deletedAbsent: retention.deletedAbsent,
  };
}

export function scoreArchiveBenchmark({ mode, scenarios, retention = null, fixture }) {
  const gates = {
    canonicalAppendP95: canonicalAppendGate(mode, scenarios),
    largeToolIngestThroughput: largeToolGate(mode, scenarios),
    warmPreflightP95: notMeasured("Exact and BM25 retrieval indexes are outside this append benchmark."),
    threeWindowRecallP95: notMeasured("Recall materialization is outside this append benchmark."),
    steadyStateRss: notMeasured("The daemon is not held at steady state in this benchmark."),
    indexingBacklogRecovery: notMeasured("No asynchronous index worker is exercised by this benchmark."),
    acknowledgedWriteRecovery: notMeasured("Crash-and-restart durability is covered by fault-injection tests, not this timing run."),
    retentionCompaction: retentionGate(mode, retention, fixture),
  };
  const statuses = Object.values(gates).map(({ status }) => status);
  const measured = statuses.filter((status) => status !== "not-measured");
  const outcome = measured.includes("failed")
    ? "failed"
    : statuses.every((status) => status === "passed")
      ? "passed"
      : measured.length === 0
        ? "not-measured"
        : "partial";
  return { gates, outcome };
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new TypeError("fixture must be an object");
  }
  if (fixture.planFingerprint !== ARCHIVE_BENCHMARK_PLAN_FINGERPRINT) {
    throw new Error("archive benchmark fixture plan fingerprint is stale");
  }
  if (typeof fixture.fixtureId !== "string" || fixture.fixtureId.length === 0) {
    throw new TypeError("fixture.fixtureId must be a non-empty string");
  }
  positiveInteger(fixture.logicalWindows, "fixture.logicalWindows");
  if (!/^sha256:[a-f0-9]{64}$/.test(fixture.orderFingerprint)) {
    throw new TypeError("fixture.orderFingerprint must be a SHA-256 fingerprint");
  }
  const expected = createArchiveBenchmarkFixture({
    count: fixture.logicalWindows,
    scale: fixture.scale,
    seed: fixture.seed,
    largeSamples: fixture.largeSamples,
    retentionRecords: fixture.retentionRecords,
    retentionRecordBytes: fixture.retentionRecordBytes,
  });
  if (hashJson(fixture) !== hashJson(expected)) {
    throw new Error("archive benchmark fixture metadata or ordering does not match the frozen plan");
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createArchiveBenchmarkArtifact({
  mode,
  environment,
  fixture,
  release,
  scenarios = {},
  retention = null,
  notes = [],
}) {
  if (!ARCHIVE_BENCHMARK_MODES.includes(mode)) throw new TypeError("mode is invalid");
  validateEvaluationEnvironment(environment);
  validateFixture(fixture);
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new TypeError("release metadata must be an object");
  }
  for (const field of ["storageSchemaFingerprint", "storageSchemaVersion", "protocolVersion"]) {
    if (release[field] === undefined || release[field] === null || release[field] === "") {
      throw new TypeError(`release.${field} is required`);
    }
  }
  if (release.storageSchemaVersion !== STORE_SCHEMA_VERSION
    || release.storageSchemaFingerprint !== SCHEMA_FINGERPRINT
    || release.protocolVersion !== STORE_PROTOCOL_VERSION) {
    throw new Error("release metadata does not match the current storage schema and protocol");
  }
  if (!scenarios || typeof scenarios !== "object" || Array.isArray(scenarios)) {
    throw new TypeError("scenarios must be an object");
  }
  for (const [name, scenario] of Object.entries(scenarios)) validateScenario(name, scenario);
  const expectedBackends = mode === "baseline" ? ["sqlite"] : ["sqlite", "rocksdb"];
  const expectedScenarioNames = mode === "retention"
    ? []
    : expectedBackends
      .flatMap((backend) => ARCHIVE_BENCHMARK_CLIENT_COUNTS.flatMap((clients) =>
        ["canonical", "tool-10kib", "tool-1mib"].map((workload) => scenarioName(backend, workload, clients))));
  const actualScenarioNames = Object.keys(scenarios).sort();
  const sortedExpectedScenarioNames = expectedScenarioNames.sort();
  if (!same(actualScenarioNames, sortedExpectedScenarioNames)) {
    throw new Error(`${mode} artifact scenarios are missing, extra, or misnamed`);
  }
  for (const scenario of Object.values(scenarios)) {
    const expectedCount = scenario.workload === "canonical"
      ? Math.max(fixture.logicalWindows, scenario.clients)
      : Math.max(fixture.largeSamples, scenario.clients);
    if (scenario.operationCount !== expectedCount) {
      throw new Error(`${scenarioName(scenario.backend, scenario.workload, scenario.clients)} operationCount does not match the fixture`);
    }
    if (scenario.warmupOperationCount !== archiveWarmupOperationCount(
      scenario.workload,
      scenario.clients,
    )) {
      throw new Error(`${scenarioName(scenario.backend, scenario.workload, scenario.clients)} warmupOperationCount does not match the frozen plan`);
    }
  }
  if (mode === "retention") validateRetention(retention, fixture);
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    throw new TypeError("notes must be an array of strings");
  }
  const scored = scoreArchiveBenchmark({ mode, scenarios, retention, fixture });
  const artifact = {
    kind: "archive-benchmark",
    schemaVersion: ARCHIVE_BENCHMARK_ARTIFACT_VERSION,
    schemaFingerprint: ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT,
    generatedAt: environment.capturedAt,
    mode,
    environment,
    release,
    fixture,
    scenarios,
    retention,
    notes,
    gates: scored.gates,
    outcome: scored.outcome,
  };
  return Object.freeze({ ...artifact, artifactHash: hashJson(artifact) });
}

export function validateArchiveBenchmarkArtifact(artifact) {
  if (!artifact || artifact.kind !== "archive-benchmark"
    || artifact.schemaVersion !== ARCHIVE_BENCHMARK_ARTIFACT_VERSION) {
    throw new TypeError("artifact must be an archive-benchmark v1 artifact");
  }
  if (artifact.schemaFingerprint !== ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT) {
    throw new Error("archive benchmark artifact schema fingerprint is stale");
  }
  const rebuilt = createArchiveBenchmarkArtifact({
    mode: artifact.mode,
    environment: artifact.environment,
    fixture: artifact.fixture,
    release: artifact.release,
    scenarios: artifact.scenarios,
    retention: artifact.retention,
    notes: artifact.notes,
  });
  if (!same(artifact.gates, rebuilt.gates) || artifact.outcome !== rebuilt.outcome) {
    throw new Error("archive benchmark gates do not match recomputed results");
  }
  if (artifact.artifactHash !== rebuilt.artifactHash) {
    throw new Error("archive benchmark artifact hash does not match its canonical content");
  }
  const { artifactHash: _artifactHash, ...submittedContent } = artifact;
  if (artifact.artifactHash !== hashJson(submittedContent)) {
    throw new Error("archive benchmark artifact contains content outside its artifact hash");
  }
  return artifact;
}

export { ARTIFACT_DESCRIPTOR as ARCHIVE_BENCHMARK_ARTIFACT_DESCRIPTOR };
