import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hashJson } from "../eval/retrieval/schema.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../src/store/store-contract.js";
import {
  tokenizeBm25,
  tokenizeBm25Query,
} from "../src/rocksdb/index/tokenizer.js";
import { MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT } from "../src/rocksdb/index-preparation.js";
import { createArchiveBenchmarkArtifact } from "../bench/archive/artifact.js";
import { createArchiveBenchmarkFixture } from "../bench/archive/fixture.js";
import {
  ARCHIVE_RELEASE_RETENTION_FIXTURE,
  ARCHIVE_RELEASE_ARTIFACT_VERSION,
  ARCHIVE_RELEASE_SCHEMA_FINGERPRINT,
  createArchiveReleaseArtifact,
  validateArchiveReleaseRetentionArtifact,
  validateArchiveReleaseArtifact,
} from "../bench/archive/release-artifact.js";
import {
  ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  ARCHIVE_SYSTEM_PROBE_PLAN,
  ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT,
  ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT,
  archiveSystemProbeCounts,
  assertFrozenArchiveSystemProbePlan,
  createArchiveSystemProbeArtifact,
  validateArchiveSystemProbeArtifact,
} from "../bench/archive/system-artifact.js";
import {
  ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
  archiveSystemQueries,
  archiveSystemRecallExpectation,
  createArchiveSystemRecallProbe,
} from "../bench/archive/system-fixture.js";
import {
  archiveReleaseExitCode,
  parseArchiveReleaseArguments,
} from "../bench/archive/release-cli.js";
import {
  archiveSystemExitCode,
  parseArchiveSystemArguments,
} from "../bench/archive/system-cli.js";

const release = Object.freeze({
  storageSchemaVersion: STORE_SCHEMA_VERSION,
  storageSchemaFingerprint: SCHEMA_FINGERPRINT,
  protocolVersion: STORE_PROTOCOL_VERSION,
});

function environment(capturedAt = "2026-07-17T00:00:00.000Z") {
  return {
    capturedAt,
    node: { version: process.version, abi: process.versions.modules },
    operatingSystem: { platform: "test", release: "test", arch: "test" },
    cpu: { model: "fixture", count: 8 },
    totalMemoryBytes: 16 * 1_024 * 1_024 * 1_024,
    filesystem: {
      path: "/fixture",
      type: "fixture",
      blockSize: 4_096,
      totalBytes: 1_000_000_000,
      availableBytes: 500_000_000,
    },
    package: { name: "context-epoch-window", version: "0.1.0" },
    dependencyLockSha256: `sha256:${"a".repeat(64)}`,
    dependencies: { rocksdb: "2.4.0", typebox: "1.1.38" },
    git: { revision: "b".repeat(40), dirty: false },
  };
}

function observations(profile, scale) {
  const counts = archiveSystemProbeCounts(profile);
  const expectation = archiveSystemRecallExpectation(scale);
  const preflight = [];
  for (const route of ["exact", "bm25"]) {
    for (let index = 0; index < counts.preflightSamplesPerRoute; index += 1) {
      preflight.push({
        probeId: `${route}-${index}`,
        route,
        durationMs: route === "exact" ? 4 : 6,
        searchMode: route === "exact" ? "exact" : "lexical",
        matchType: route === "exact" ? "exact-symbol" : "bm25",
        searchStatus: "resolved",
        preflightHintCount: 1,
        preflightReturned: true,
      });
    }
  }
  return {
    corpus: {
      requestedCount: scale,
      putAcknowledgedCount: scale,
      transientRetryCount: 0,
      duplicateAcknowledgementCount: 0,
      countBefore: 0,
      countAfter: scale,
      indexedStatus: { outboxDepth: 0, backgroundErrorCount: 0 },
    },
    preflight: { samples: preflight },
    recall: {
      samples: Array.from({ length: counts.recallSamples }, (_, index) => ({
        probeId: `recall-${index}`,
        durationMs: 8,
        neighbors: 1,
        maxTokens: ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
        status: "resolved",
        documentId: expectation.documentId,
        expectedDocumentId: expectation.documentId,
        startByte: expectation.startByte,
        endByte: expectation.endByte,
        expectedStartByte: expectation.startByte,
        expectedEndByte: expectation.endByte,
        continuationCount: 2,
      })),
    },
    rss: {
      queriesWarmed: true,
      idleBeforeFirstSampleMs: profile === "official" ? 30_000 : 100,
      samples: Array.from({ length: counts.rssSamples }, (_, index) => ({
        observedAtMs: index * (profile === "official" ? 1_000 : 100),
        rssBytes: 200 * 1_024 * 1_024,
        outboxDepth: 0,
        backgroundErrorCount: 0,
      })),
    },
    backlog: {
      initialDepth: 0,
      writes: Array.from({ length: counts.backlogWrites }, (_, index) => ({
        documentId: `backlog-${index}`,
        payloadBytes: 1_024 * 1_024,
        ackStatus: "stored",
        transientRetryCount: 0,
        depthBeforeWrite: index,
        depthAfterAck: index + 1,
      })),
      finalDepth: 0,
      backgroundErrorCount: 0,
    },
    crashRecovery: {
      trials: Array.from({ length: counts.crashTrials }, (_, index) => ({
        documentId: `crash-${index}`,
        payloadBytes: 1_024 * 1_024,
        ackStatus: "stored",
        transientRetryCount: 0,
        depthAfterAck: 1,
        killSignal: "SIGKILL",
        exitSignal: "SIGKILL",
        restartReady: true,
        recoveredStatus: "resolved",
        recoveredDocumentId: `crash-${index}`,
        finalOutboxDepth: 0,
        backgroundErrorCount: 0,
        searchStatus: "resolved",
        searchDocumentId: `crash-${index}`,
      })),
    },
  };
}

function resign(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  artifact.artifactHash = hashJson(unsigned);
  return artifact;
}

function retentionArtifact(fixture) {
  const totalPayloadBytes = fixture.retentionRecords * fixture.retentionRecordBytes;
  return createArchiveBenchmarkArtifact({
    mode: "retention",
    environment: environment(),
    release,
    fixture,
    retention: {
      recordCount: fixture.retentionRecords,
      recordBytes: fixture.retentionRecordBytes,
      totalPayloadBytes,
      deletedCount: fixture.retentionRecords / 2,
      deletedPayloadBytes: totalPayloadBytes / 2,
      before: {
        directoryBytes: 1_200,
        totalSstBytes: 800,
        liveBlobBytes: 200,
        physicalDataBytes: 1_000,
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
    },
  });
}

test("system probe artifacts recompute all five gates from raw observations", () => {
  const scale = 24;
  const artifact = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: observations("development", scale),
  });
  assert.equal(artifact.schemaFingerprint, ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT);
  assert.equal(assertFrozenArchiveSystemProbePlan(), ARCHIVE_SYSTEM_PROBE_PLAN);
  assert.equal(hashJson(ARCHIVE_SYSTEM_PROBE_PLAN), ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT);
  assert.equal(artifact.planFingerprint, ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT);
  assert.match(artifact.corpusFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(artifact.scale, {
    profile: "development",
    logicalWindows: scale,
    releaseEligible: false,
    vectorsEnabled: false,
  });
  assert.equal(artifact.results.preflight.routes.exact.latencyMilliseconds.p95, 4);
  assert.equal(artifact.results.preflight.routes.bm25.latencyMilliseconds.p95, 6);
  assert.equal(artifact.results.recall.latencyMilliseconds.p95, 8);
  assert.equal(artifact.results.rss.maxBytes, 200 * 1_024 * 1_024);
  assert.equal(artifact.results.backlog.peakDepth, 8);
  assert.equal(artifact.results.crashRecovery.lostAcknowledgedWriteCount, 0);
  assert.equal(artifact.results.crashRecovery.allIndexesRecovered, true);
  assert.equal(artifact.outcome, "passed");
  assert.equal(Object.values(artifact.gates).every(({ status }) => status === "passed"), true);
  assert.equal(validateArchiveSystemProbeArtifact(artifact), artifact);
  assert.equal(Object.isFrozen(artifact.observations.preflight.samples[0]), true);
});

test("system BM25 diagnostics target the bounded indexable prefix", () => {
  const query = archiveSystemQueries(1).bm25;
  const analyzed = tokenizeBm25(createArchiveSystemRecallProbe(1).text);
  const indexedTerms = new Set(analyzed.map(({ term }) => term));
  const queryTerms = tokenizeBm25Query(query);
  assert.equal(query, ARCHIVE_SYSTEM_PROBE_PLAN.queries.bm25);
  assert.match(query, /\bEarlier\b/u);
  assert.ok(analyzed.length <= MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT);
  assert.ok(queryTerms.some((term) => indexedTerms.has(term)));
});

test("official system evidence is fixed at exactly one million windows", () => {
  const artifact = createArchiveSystemProbeArtifact({
    profile: "official",
    environment: environment(),
    release,
    observations: observations("official", ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE),
  });
  assert.deepEqual(artifact.scale, {
    profile: "official",
    logicalWindows: 1_000_000,
    releaseEligible: true,
    vectorsEnabled: false,
  });
  assert.equal(artifact.results.backlog.writeCount, 32);
  assert.equal(artifact.results.rss.sampleCount, 10);
  assert.equal(artifact.results.crashRecovery.trialCount, 10);
  assert.equal(validateArchiveSystemProbeArtifact(artifact), artifact);
  assert.throws(
    () => createArchiveSystemProbeArtifact({
      profile: "official",
      developmentScale: 32,
      environment: environment(),
      release,
      observations: observations("official", ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE),
    }),
    /must be omitted/u,
  );
});

test("system validation rejects forged summaries, gates, and fixture expectations", () => {
  const scale = 24;
  const artifact = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: observations("development", scale),
  });

  const forgedResult = structuredClone(artifact);
  forgedResult.results.backlog.peakDepth = 999;
  resign(forgedResult);
  assert.throws(
    () => validateArchiveSystemProbeArtifact(forgedResult),
    /results do not match raw observations/u,
  );

  const forgedGate = structuredClone(artifact);
  forgedGate.gates.steadyStateRss.maxBytes = 1;
  resign(forgedGate);
  assert.throws(
    () => validateArchiveSystemProbeArtifact(forgedGate),
    /gates do not match recomputed results/u,
  );

  const stalePlan = structuredClone(artifact);
  stalePlan.planFingerprint = `sha256:${"0".repeat(64)}`;
  resign(stalePlan);
  assert.throws(
    () => validateArchiveSystemProbeArtifact(stalePlan),
    /plan fingerprint is stale/u,
  );

  const staleCorpus = structuredClone(artifact);
  staleCorpus.corpusFingerprint = `sha256:${"0".repeat(64)}`;
  resign(staleCorpus);
  assert.throws(
    () => validateArchiveSystemProbeArtifact(staleCorpus),
    /corpus fingerprint is stale/u,
  );

  const wrongExpectation = observations("development", scale);
  wrongExpectation.recall.samples[0].expectedStartByte += 1;
  wrongExpectation.recall.samples[0].startByte += 1;
  const failed = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: wrongExpectation,
  });
  assert.equal(failed.results.recall.allCorrect, false);
  assert.equal(failed.gates.threeWindowRecallP95.status, "failed");
  assert.equal(failed.outcome, "failed");
});

test("system validation rejects missing raw trials and development evidence cannot aggregate", () => {
  const scale = 24;
  const raw = observations("development", scale);
  raw.crashRecovery.trials = [];
  assert.throws(
    () => createArchiveSystemProbeArtifact({
      profile: "development",
      developmentScale: scale,
      environment: environment(),
      release,
      observations: raw,
    }),
    /exactly 1 observations/u,
  );

  const development = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: observations("development", scale),
  });
  assert.throws(
    () => createArchiveReleaseArtifact({
      comparisonArtifacts: [{}, {}, {}],
      systemArtifact: development,
      retentionArtifact: {},
    }),
    /official one-million-window profile/u,
  );
});

test("RSS and backlog gates reject forged steady-state and non-overlapping ACK evidence", () => {
  const scale = 24;
  const badSchedule = observations("development", scale);
  badSchedule.rss.idleBeforeFirstSampleMs = 99;
  badSchedule.rss.samples[1].observedAtMs = 99;
  const rssFailed = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: badSchedule,
  });
  assert.equal(rssFailed.results.rss.scheduleValid, false);
  assert.equal(rssFailed.gates.steadyStateRss.status, "failed");

  const noOverlap = observations("development", scale);
  for (const write of noOverlap.backlog.writes) {
    write.depthBeforeWrite = 0;
    write.depthAfterAck = 1;
  }
  const backlogFailed = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: noOverlap,
  });
  assert.equal(backlogFailed.results.backlog.allAcknowledged, true);
  assert.equal(backlogFailed.results.backlog.overlappingStoredWriteCount, 0);
  assert.equal(backlogFailed.results.backlog.canonicalWritesUnblocked, false);
  assert.equal(backlogFailed.gates.indexingBacklogRecovery.status, "failed");

  const noIndexedRecovery = observations("development", scale);
  noIndexedRecovery.crashRecovery.trials[0].depthAfterAck = 0;
  noIndexedRecovery.crashRecovery.trials[0].searchStatus = "not-found";
  noIndexedRecovery.crashRecovery.trials[0].searchDocumentId = "missing";
  const crashFailed = createArchiveSystemProbeArtifact({
    profile: "development",
    developmentScale: scale,
    environment: environment(),
    release,
    observations: noIndexedRecovery,
  });
  assert.equal(crashFailed.results.crashRecovery.allTrialsHadActiveBacklog, false);
  assert.equal(crashFailed.results.crashRecovery.allIndexesRecovered, false);
  assert.equal(crashFailed.gates.acknowledgedWriteRecovery.status, "failed");
});

test("release aggregate validation fails closed without its hashed components", () => {
  const referenceOnly = {
    kind: "archive-benchmark-release",
    schemaVersion: ARCHIVE_RELEASE_ARTIFACT_VERSION,
    schemaFingerprint: ARCHIVE_RELEASE_SCHEMA_FINGERPRINT,
    generatedAt: "2026-07-17T00:00:00.000Z",
    provenance: {},
    components: {},
    gates: {},
    outcome: "passed",
    notes: [],
    artifactHash: `sha256:${"0".repeat(64)}`,
  };
  assert.throws(
    () => validateArchiveReleaseArtifact(referenceOnly),
    /component artifacts are required/u,
  );
});

test("release retention evidence is bound to the frozen byte-weighted fixture", () => {
  const official = retentionArtifact(ARCHIVE_RELEASE_RETENTION_FIXTURE);
  assert.equal(validateArchiveReleaseRetentionArtifact(official), official);
  const tiny = retentionArtifact(createArchiveBenchmarkFixture({
    retentionRecords: 8,
    retentionRecordBytes: 1_024,
  }));
  assert.throws(
    () => validateArchiveReleaseRetentionArtifact(tiny),
    /frozen retention fixture/u,
  );
});

test("release CLI exit policy and component loading fail closed", (t) => {
  assert.equal(archiveReleaseExitCode({
    outcome: "passed",
    gates: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `gate-${index}`,
      { status: "passed" },
    ])),
  }), 0);
  assert.equal(archiveReleaseExitCode({
    outcome: "failed",
    gates: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `gate-${index}`,
      { status: index === 0 ? "failed" : "passed" },
    ])),
  }), 1);
  assert.throws(
    () => parseArchiveReleaseArguments(["--comparison", "one.json"]),
    /exactly three/u,
  );

  const directory = mkdtempSync(join(tmpdir(), "archive-release-cli-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invalid = join(directory, "invalid.json");
  const aggregate = join(directory, "aggregate.json");
  const output = join(directory, "release.json");
  writeFileSync(invalid, "{}\n");
  writeFileSync(aggregate, `${JSON.stringify({
    kind: "archive-benchmark-release",
    schemaVersion: ARCHIVE_RELEASE_ARTIFACT_VERSION,
    schemaFingerprint: ARCHIVE_RELEASE_SCHEMA_FINGERPRINT,
    generatedAt: "2026-07-17T00:00:00.000Z",
    provenance: {},
    components: {},
    gates: {},
    outcome: "failed",
    notes: [],
    artifactHash: `sha256:${"0".repeat(64)}`,
  })}\n`);
  const cli = resolve("bench/archive/release-cli.js");
  const componentArgs = [
    "--comparison", invalid,
    "--comparison", invalid,
    "--comparison", invalid,
    "--system", invalid,
    "--retention", invalid,
  ];
  const failedComponent = spawnSync(process.execPath, [
    cli,
    ...componentArgs,
    "--output", output,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.notEqual(failedComponent.status, 0);
  assert.doesNotMatch(failedComponent.stderr, /8\/8 gates passed/u);

  const failedValidation = spawnSync(process.execPath, [
    cli,
    ...componentArgs,
    "--validate-artifact", aggregate,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.notEqual(failedValidation.status, 0);
  assert.doesNotMatch(failedValidation.stderr, /8\/8 gates passed/u);
});

test("system CLI keeps official and bounded development profiles explicit", () => {
  assert.deepEqual(parseArchiveSystemArguments(["--scale", "1000000"]), {
    profile: "official",
  });
  assert.deepEqual(parseArchiveSystemArguments(["--development-scale", "8"]), {
    profile: "development",
    developmentScale: 8,
  });
  assert.throws(
    () => parseArchiveSystemArguments(["--development-scale", "10001"]),
    /must not exceed 10000/u,
  );
  assert.throws(
    () => parseArchiveSystemArguments(["--scale", "100000"]),
    /exactly 1000000/u,
  );
  assert.equal(archiveSystemExitCode({
    outcome: "failed",
    gates: { steadyStateRss: { status: "failed" } },
  }), 1);
});
