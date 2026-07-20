import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES,
  ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
  ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT,
  archiveWarmupOperationCount,
  assertFrozenArchiveBenchmarkPlan,
  benchmarkDocumentAt,
  createArchiveBenchmarkArtifact,
  createArchiveBenchmarkFixture,
  runArchiveBenchmark,
  summarizeLatency,
  validateArchiveBenchmarkArtifact,
} from "../bench/archive/index.js";
import {
  archiveBenchmarkExitCode,
  parseArchiveBenchmarkArguments,
} from "../bench/archive/cli.js";
import { collectEvaluationEnvironment } from "../eval/retrieval/environment.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../src/store/store-contract.js";

function syntheticBaselineScenarios(fixture) {
  const scenarios = {};
  for (const clients of [1, 8]) {
    for (const workload of ["canonical", "tool-10kib", "tool-1mib"]) {
      const operationCount = workload === "canonical"
        ? Math.max(fixture.logicalWindows, clients)
        : Math.max(fixture.largeSamples, clients);
      const bytesPerOperation = workload === "tool-1mib"
        ? 1024 * 1024
        : workload === "tool-10kib"
          ? 10 * 1024
          : 160;
      const samples = Array(operationCount).fill(1);
      const payloadBytes = operationCount * bytesPerOperation;
      const wallMilliseconds = operationCount;
      scenarios[`sqlite.${workload}.clients-${clients}`] = {
        backend: "sqlite",
        workload,
        clients,
        executionModel: "synthetic validator fixture",
        operationCount,
        warmupOperationCount: archiveWarmupOperationCount(workload, clients),
        payloadBytes,
        busyRetryCount: 0,
        wallMilliseconds,
        operationsPerSecond: operationCount / (wallMilliseconds / 1_000),
        payloadBytesPerSecond: payloadBytes / (wallMilliseconds / 1_000),
        latencyMilliseconds: { samples, summary: summarizeLatency(samples) },
      };
    }
  }
  return scenarios;
}

test("archive benchmark fixture freezes order and deterministic payload profiles", () => {
  assert.equal(assertFrozenArchiveBenchmarkPlan().schemaVersion, 1);
  assert.match(ARCHIVE_BENCHMARK_PLAN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/u);
  assert.match(ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT, /^sha256:[a-f0-9]{64}$/u);

  const quick = createArchiveBenchmarkFixture({
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  const same = createArchiveBenchmarkFixture({
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  assert.equal(quick.orderFingerprint, same.orderFingerprint);
  assert.equal(benchmarkDocumentAt(6, { count: 8 }).payloadBytes, 10 * 1024);
  assert.equal(benchmarkDocumentAt(7, { count: 8 }).payloadBytes, 1024 * 1024);

  const official = createArchiveBenchmarkFixture({
    scale: 10_000,
    count: 10_000,
    largeSamples: ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  assert.equal(official.officialScale, true);
  assert.equal(benchmarkDocumentAt(999, { count: 10_000, officialScale: true }).profile, "tool-10kib");
  assert.equal(benchmarkDocumentAt(9_999, { count: 10_000, officialScale: true }).profile, "tool-1mib");
});

test("archive benchmark artifacts recompute gates and reject modifications", () => {
  const fixture = createArchiveBenchmarkFixture({
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  const artifact = createArchiveBenchmarkArtifact({
    mode: "baseline",
    environment: collectEvaluationEnvironment(),
    fixture,
    release: {
      storageSchemaVersion: STORE_SCHEMA_VERSION,
      storageSchemaFingerprint: SCHEMA_FINGERPRINT,
      protocolVersion: STORE_PROTOCOL_VERSION,
    },
    scenarios: syntheticBaselineScenarios(fixture),
    notes: ["synthetic validator fixture"],
  });
  assert.equal(artifact.outcome, "not-measured");
  assert.equal(artifact.gates.canonicalAppendP95.status, "not-measured");
  assert.equal(validateArchiveBenchmarkArtifact(artifact), artifact);
  const forgedSuccess = structuredClone(artifact);
  forgedSuccess.outcome = "passed";
  assert.equal(archiveBenchmarkExitCode(forgedSuccess), 2);

  const changedFixture = structuredClone(fixture);
  changedFixture.orderFingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(() => createArchiveBenchmarkArtifact({
    mode: "baseline",
    environment: collectEvaluationEnvironment(),
    fixture: changedFixture,
    release: artifact.release,
    scenarios: syntheticBaselineScenarios(changedFixture),
  }), /ordering does not match/u);

  const changedGate = structuredClone(artifact);
  changedGate.gates.canonicalAppendP95.status = "passed";
  assert.throws(() => validateArchiveBenchmarkArtifact(changedGate), /gates do not match/u);

  const staleSchema = structuredClone(artifact);
  staleSchema.schemaFingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateArchiveBenchmarkArtifact(staleSchema), /schema fingerprint is stale/u);

  const extraContent = structuredClone(artifact);
  extraContent.unhashedInjectedField = { claim: "not covered by artifactHash" };
  assert.throws(
    () => validateArchiveBenchmarkArtifact(extraContent),
    /content outside its artifact hash/u,
  );
});

test("retention artifacts reject forged physical reclamation measurements", () => {
  const fixture = createArchiveBenchmarkFixture({
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  const retention = {
    recordCount: 8,
    recordBytes: 1024,
    totalPayloadBytes: 8192,
    deletedCount: 4,
    deletedPayloadBytes: 4096,
    before: {
      directoryBytes: 1200,
      totalSstBytes: 800,
      liveBlobBytes: 200,
      physicalDataBytes: 1000,
    },
    after: {
      directoryBytes: 700,
      totalSstBytes: 450,
      liveBlobBytes: 50,
      physicalDataBytes: 500,
    },
    physicalDecreaseBytes: 500,
    physicalDecreaseRatio: 0.5,
    liveDataFileDecreaseBytes: 500,
    liveDataFileDecreaseRatio: 0.5,
    retainedReadable: true,
    deletedAbsent: true,
  };
  const artifact = createArchiveBenchmarkArtifact({
    mode: "retention",
    environment: collectEvaluationEnvironment(),
    fixture,
    release: {
      storageSchemaVersion: STORE_SCHEMA_VERSION,
      storageSchemaFingerprint: SCHEMA_FINGERPRINT,
      protocolVersion: STORE_PROTOCOL_VERSION,
    },
    retention,
  });
  assert.equal(validateArchiveBenchmarkArtifact(artifact), artifact);

  const forged = structuredClone(artifact);
  forged.retention.physicalDecreaseRatio = 0.9;
  assert.throws(
    () => validateArchiveBenchmarkArtifact(forged),
    /physicalDecreaseRatio does not match/u,
  );

  const forgedPhysicalTotal = structuredClone(artifact);
  forgedPhysicalTotal.retention.after.physicalDataBytes = 450;
  assert.throws(
    () => validateArchiveBenchmarkArtifact(forgedPhysicalTotal),
    /physicalDataBytes must equal/u,
  );

  const forgedFixtureScope = {
    ...retention,
    recordCount: 2,
    recordBytes: 1,
    totalPayloadBytes: 2,
    deletedCount: 1,
    deletedPayloadBytes: 1,
  };
  assert.throws(
    () => createArchiveBenchmarkArtifact({
      mode: "retention",
      environment: collectEvaluationEnvironment(),
      fixture,
      release: artifact.release,
      retention: forgedFixtureScope,
    }),
    /recordCount does not match the frozen fixture/u,
  );
});

test("archive benchmark CLI arguments keep official scales and modes explicit", () => {
  assert.deepEqual(
    parseArchiveBenchmarkArguments(["--baseline", "--count=12", "--large-samples", "2"]),
    {
      mode: "baseline",
      scale: "quick",
      count: 12,
      largeSamples: 2,
      retentionRecords: 64,
      retentionRecordBytes: 64 * 1024,
      allowPartial: false,
    },
  );
  assert.equal(parseArchiveBenchmarkArguments(["--allow-partial"]).allowPartial, true);
  assert.equal(parseArchiveBenchmarkArguments(["--scale", "10000"]).count, 10_000);
  assert.equal(
    parseArchiveBenchmarkArguments(["--scale", "10000"]).largeSamples,
    ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES,
  );
  assert.throws(
    () => parseArchiveBenchmarkArguments(["--baseline", "--retention"]),
    /mutually exclusive/u,
  );
  assert.throws(
    () => parseArchiveBenchmarkArguments(["--scale", "10000", "--count", "8"]),
    /cannot be combined/u,
  );
  assert.throws(
    () => parseArchiveBenchmarkArguments(["--scale", "10000", "--large-samples", "8"]),
    /official scales require/u,
  );
});

test("comparison benchmark exercises both stores without overstating unmeasured gates", async () => {
  const artifact = await runArchiveBenchmark({
    mode: "comparison",
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 1024,
  });
  validateArchiveBenchmarkArtifact(artifact);
  assert.equal(Object.keys(artifact.scenarios).length, 12);
  assert.equal(artifact.scenarios["sqlite.canonical.clients-1"].operationCount, 8);
  assert.equal(artifact.scenarios["rocksdb.canonical.clients-8"].operationCount, 8);
  assert.notEqual(artifact.gates.canonicalAppendP95.status, "not-measured");
  assert.notEqual(artifact.gates.largeToolIngestThroughput.status, "not-measured");
  assert.equal(artifact.gates.warmPreflightP95.status, "not-measured");
  assert.notEqual(artifact.outcome, "passed");
  assert.equal(archiveBenchmarkExitCode(artifact), artifact.outcome === "failed" ? 1 : 2);
  assert.equal(
    archiveBenchmarkExitCode(artifact, { allowPartial: true }),
    artifact.outcome === "failed" ? 1 : 0,
  );
});

test("retention benchmark verifies keys and reports physical reclamation truthfully", async () => {
  const artifact = await runArchiveBenchmark({
    mode: "retention",
    count: 8,
    largeSamples: 1,
    retentionRecords: 8,
    retentionRecordBytes: 8 * 1024,
  });
  validateArchiveBenchmarkArtifact(artifact);
  assert.equal(artifact.retention.deletedCount, 4);
  assert.equal(artifact.retention.deletedPayloadBytes * 2, artifact.retention.totalPayloadBytes);
  assert.equal(artifact.retention.retainedReadable, true);
  assert.equal(artifact.retention.deletedAbsent, true);
  assert.notEqual(artifact.gates.retentionCompaction.status, "not-measured");
  assert.equal(artifact.gates.retentionCompaction.scope.includes("Physical reclamation only"), true);
});

test("baseline CLI emits and validates a metadata-complete JSON artifact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-benchmark-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "baseline.json");
  const cli = resolve("bench/archive/cli.js");
  const run = spawnSync(process.execPath, [
    cli,
    "--baseline",
    "--count",
    "8",
    "--large-samples",
    "1",
    "--allow-partial",
    "--output",
    output,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /baseline not-measured/u);
  const artifact = JSON.parse(readFileSync(output, "utf8"));
  validateArchiveBenchmarkArtifact(artifact);
  assert.equal(artifact.environment.git.revision.length > 0, true);
  assert.match(artifact.environment.dependencyLockSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.parse(run.stdout).artifactHash, artifact.artifactHash);

  const strictValidate = spawnSync(process.execPath, [cli, "--validate-artifact", output], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(strictValidate.status, 2, strictValidate.stderr);
  assert.match(strictValidate.stderr, /baseline not-measured/u);

  const developmentValidate = spawnSync(process.execPath, [
    cli,
    "--validate-artifact",
    output,
    "--allow-partial",
  ], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(developmentValidate.status, 0, developmentValidate.stderr);
  assert.match(developmentValidate.stderr, /baseline not-measured/u);
});
