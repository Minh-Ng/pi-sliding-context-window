import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArchiveReleaseArguments } from "../bench/archive/release-cli.js";
import { main as releaseCliMain } from "../eval/release/cli.js";
import {
  RELEASE_RETRIEVAL_SUITES,
  createReleaseGateRunPlan,
  releaseGateArtifactPaths,
} from "../eval/retrieval/release-gate.js";
import {
  MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT,
  MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT,
  assertFrozenMigrationRehearsalContract,
  runMigrationRehearsal,
  validateMigrationRehearsalArtifact,
} from "../eval/release/migration-rehearsal.js";
import {
  RELEASE_REPORT_COMPONENTS,
  writeReleaseReport,
  validateReleaseReportArtifact,
} from "../eval/release/report.js";
import { repositoryRoot } from "../eval/retrieval/environment.js";
import {
  LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT,
  RELEASE_VERIFIER_COMMANDS,
  assertFrozenLocalAggregateEvidenceContract,
  formatLocalAggregateEvidenceDocument,
  runReleaseVerifiers,
  validateLocalAggregateEvidence,
  validateLocalAggregateEvidenceDocument,
  validateReleaseVerifierArtifact,
} from "../eval/release/verifiers.js";
import { hashJson } from "../eval/retrieval/schema.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../src/store-contract.js";

function testEnvironment() {
  return {
    capturedAt: "2026-07-17T12:00:00.000Z",
    node: { version: "v22.19.0", abi: "127" },
    operatingSystem: { platform: "test", release: "1", arch: "arm64" },
    cpu: { model: "fixture cpu", count: 8 },
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    filesystem: {
      path: "/fixture",
      type: "fixturefs",
      blockSize: 4096,
      totalBytes: 1024 * 1024 * 1024,
      availableBytes: 512 * 1024 * 1024,
    },
    package: { name: "context-epoch-window", version: "0.1.0" },
    dependencyLockSha256: `sha256:${"a".repeat(64)}`,
    dependencies: { rocksdb: "2.4.0", typebox: "1.1.38" },
    git: { revision: "f".repeat(40), dirty: false },
  };
}

function resign(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  artifact.artifactHash = hashJson(unsigned);
  return artifact;
}

function localAggregateEvidence() {
  return {
    versions: {
      localEvidenceSchema: 1,
      node: "22.19.0",
      pi: "0.80.6",
      rocksdb: "2.4.0",
    },
    hashes: {
      localEvidenceSchema: LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT,
      verifierArtifact: `sha256:${"b".repeat(64)}`,
    },
    counts: {
      testsPassed: 2,
      testsFailed: 0,
      modelRequests: 0,
      sessionFiles: 0,
    },
    durationsMilliseconds: {
      focusedTests: 12.5,
    },
    byteTotals: {
      logicalArchive: 0,
      physicalArchive: 0,
    },
    exitStatuses: {
      focusedTests: 0,
      typescript: 0,
    },
    gates: {
      offlinePiLaunch: "passed",
      aggregateEvidenceRedaction: "passed",
      fullCheck: "pending",
    },
  };
}

test("local aggregate evidence has a frozen schema and one canonical redacted document", () => {
  assert.equal(
    LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT,
    "sha256:f0f9dc220b318850b29505a507a4cbed98ba31cbb694a96cdc152d279ac62053",
  );
  assert.doesNotThrow(() => assertFrozenLocalAggregateEvidenceContract());

  const evidence = localAggregateEvidence();
  assert.equal(validateLocalAggregateEvidence(evidence), evidence);
  const document = formatLocalAggregateEvidenceDocument(evidence);
  assert.deepEqual(validateLocalAggregateEvidenceDocument(document), evidence);

  const committed = readFileSync(
    new URL("../docs/rocksdb-archive/evaluation-results.md", import.meta.url),
    "utf8",
  );
  const committedEvidence = validateLocalAggregateEvidenceDocument(committed);
  for (const result of Object.values(committedEvidence.gates)) {
    assert.equal(result, "passed");
  }
});

test("local aggregate evidence rejects sensitive categories without echoing their values", () => {
  const cases = [
    ["prompt text", (evidence, value) => { evidence.versions.promptText = value; }],
    ["recalled text", (evidence, value) => { evidence.versions.recallContent = value; }],
    ["environment value", (evidence, value) => { evidence.versions.environment = value; }],
    ["credential", (evidence, value) => { evidence.hashes.credential = value; }],
    ["username and home path", (evidence, value) => { evidence.versions.operator = value; }],
    ["absolute source path", (evidence, value) => { evidence.versions.sourcePath = value; }],
    ["session id", (evidence, value) => { evidence.versions.sessionId = value; }],
    ["raw database key", (evidence, value) => { evidence.hashes.rawDatabaseKey = value; }],
    ["unlabeled raw key", (evidence, value) => { evidence.hashes.key = value; }],
  ];
  const sensitiveValues = [
    "PRIVATE_PROMPT_TEXT",
    "PRIVATE_RECALLED_TEXT",
    "PRIVATE_ENVIRONMENT_VALUE",
    `sha256:${"c".repeat(64)}`,
    "/Users/private-operator",
    "/private/source/project/file.js",
    "018f47f2-5f04-7fa9-bf01-private-session",
    `sha256:${"d".repeat(64)}`,
    `sha256:${"e".repeat(64)}`,
  ];

  for (const [[label, mutate], value] of cases.map((entry, index) => [entry, sensitiveValues[index]])) {
    const evidence = localAggregateEvidence();
    mutate(evidence, value);
    assert.throws(
      () => validateLocalAggregateEvidence(evidence),
      (error) => {
        assert.match(error.message, /local aggregate evidence/iu, label);
        assert.equal(error.message.includes(value), false, label);
        return true;
      },
    );
  }

  const extraText = `${formatLocalAggregateEvidenceDocument(localAggregateEvidence())}PRIVATE_PROMPT_TEXT\n`;
  assert.throws(
    () => validateLocalAggregateEvidenceDocument(extraText),
    (error) => {
      assert.equal(error.message.includes("PRIVATE_PROMPT_TEXT"), false);
      return true;
    },
  );
});

test("migration release rehearsal proves rollback and the atomic authority boundary", async () => {
  assert.doesNotThrow(() => assertFrozenMigrationRehearsalContract());
  assert.match(MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT, /^sha256:[a-f0-9]{64}$/u);
  assert.match(MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT, /^sha256:[a-f0-9]{64}$/u);

  const directory = mkdtempSync(join(tmpdir(), "context-window-release-test-"));
  const artifactPath = join(directory, "migration-rehearsal.json");
  const verificationPath = join(directory, "migration-verification.json");
  try {
    const artifact = await runMigrationRehearsal({
      outputPath: artifactPath,
      verificationOutputPath: verificationPath,
      environment: testEnvironment(),
    });
    assert.equal(artifact.outcome, "passed");
    assert.deepEqual(artifact.release, {
      storageSchemaFingerprint: SCHEMA_FINGERPRINT,
      storageSchemaVersion: STORE_SCHEMA_VERSION,
      protocolVersion: STORE_PROTOCOL_VERSION,
    });
    assert.equal(artifact.phases.afterCopy.phase, "offline-verification");
    assert.equal(artifact.phases.afterVerification.rollbackEligible, true);
    assert.equal(artifact.phases.afterRollbackRead.rollbackEligible, true);
    assert.equal(artifact.phases.afterAuthority.rollbackEligible, false);
    assert.equal(artifact.phases.afterRestart.phase, "rocksdb-authority");
    assert.equal(artifact.authority.retryStatus, "duplicate");
    assert.equal(artifact.assertions.length, 11);
    assert.equal(
      validateMigrationRehearsalArtifact(artifact, {
        verificationArtifactPath: verificationPath,
      }),
      artifact,
    );
    assert.deepEqual(JSON.parse(readFileSync(artifactPath, "utf8")), artifact);

    const forgedBoundary = resign(structuredClone(artifact));
    forgedBoundary.phases.afterAuthority.rollbackEligible = true;
    resign(forgedBoundary);
    assert.throws(
      () => validateMigrationRehearsalArtifact(forgedBoundary),
      /phase or rollback boundary is invalid/u,
    );

    writeFileSync(verificationPath, "{}\n");
    assert.throws(
      () => validateMigrationRehearsalArtifact(artifact, {
        verificationArtifactPath: verificationPath,
      }),
      /does not match the rehearsal evidence/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release verifier evidence covers the frozen command set and rejects forged success", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-verifiers-test-"));
  const artifactPath = join(directory, "verifiers.json");
  try {
    const invocations = [];
    const artifact = runReleaseVerifiers({
      outputPath: artifactPath,
      environment: testEnvironment(),
      runner(command, args, options) {
        invocations.push({ command, args, cwd: options.cwd });
        return { status: args.at(-1) === "test:migration" ? 1 : 0, signal: null };
      },
    });
    assert.equal(artifact.outcome, "failed");
    assert.deepEqual(
      invocations.map(({ command, args }) => ({ command, args })),
      RELEASE_VERIFIER_COMMANDS.map(({ command, args }) => ({ command, args: [...args] })),
    );
    assert.equal(validateReleaseVerifierArtifact(artifact), artifact);
    assert.deepEqual(JSON.parse(readFileSync(artifactPath, "utf8")), artifact);

    const forged = structuredClone(artifact);
    forged.results[2].status = "passed";
    forged.outcome = "passed";
    resign(forged);
    assert.throws(
      () => validateReleaseVerifierArtifact(forged),
      /artifact hash|outcome|status/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("final report is a valid failed artifact when evidence is missing and binds source bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-report-test-"));
  const reportPath = join(directory, "release-report.json");
  try {
    const report = writeReleaseReport({
      evidenceDirectory: directory,
      outputPath: reportPath,
      environment: testEnvironment(),
    });
    assert.equal(report.outcome, "failed");
    assert.equal(report.gates.artifactsValid.status, "failed");
    assert.equal(report.gates.cleanRevision.status, "failed");
    assert.deepEqual(
      Object.values(report.components).map(({ status }) => status),
      RELEASE_REPORT_COMPONENTS.map(() => "missing"),
    );
    assert.equal(
      validateReleaseReportArtifact(report, { evidenceDirectory: directory }),
      report,
    );
    assert.throws(
      () => validateReleaseReportArtifact(report),
      /evidenceDirectory is required/u,
    );
    assert.throws(
      () => releaseCliMain(["--validate-artifact", reportPath]),
      /--evidence-dir is required/u,
    );
    assert.throws(
      () => releaseCliMain([
        "--evidence-dir", directory,
        "--output", reportPath,
        "--allow-partial",
      ]),
      /unknown argument: --allow-partial/u,
    );

    const forgedPass = structuredClone(report);
    for (const result of Object.values(forgedPass.gates)) result.status = "passed";
    forgedPass.blockers = [];
    forgedPass.outcome = "passed";
    resign(forgedPass);
    assert.throws(
      () => validateReleaseReportArtifact(forgedPass, { evidenceDirectory: directory }),
      /does not match the referenced evidence files/u,
    );

    const baselinePath = join(directory, "retrieval", "sqlite-baseline.json");
    mkdirSync(join(directory, "retrieval"));
    writeFileSync(baselinePath, "{}\n");
    assert.throws(
      () => validateReleaseReportArtifact(report, { evidenceDirectory: directory }),
      /does not match the referenced evidence files/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default retrieval command produces the report suite and leaves hints separate", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["eval:retrieval"],
    "node eval/retrieval/release-gate.js",
  );
  assert.match(packageJson.scripts["eval:hints"], /--suite hints/u);
  assert.deepEqual(RELEASE_RETRIEVAL_SUITES, ["exact", "lexical", "structural", "chunks"]);
  const plan = releaseGateArtifactPaths({ directory: "/release-evidence/retrieval" });
  assert.equal(plan.baselineArtifact, "/release-evidence/retrieval/sqlite-baseline.json");
  assert.equal(plan.rocksArtifact, "/release-evidence/retrieval/rocksdb-evaluation.json");
  const runPlan = createReleaseGateRunPlan([], {
    directory: "/release-evidence/retrieval",
  });
  assert.deepEqual(runPlan.selectedSuites, RELEASE_RETRIEVAL_SUITES);
  assert.deepEqual(runPlan.baselineArguments, [
    "--backend", "sqlite",
    "--suite", "lexical",
    "--output", runPlan.baselineArtifact,
    "--require-all",
  ]);
  assert.deepEqual(
    runPlan.rocksArguments.slice(-4),
    ["--baseline-artifact", runPlan.baselineArtifact, "--output", runPlan.rocksArtifact],
  );
  assert.equal(
    runPlan.rocksArguments[runPlan.rocksArguments.indexOf("--suite") + 1],
    RELEASE_RETRIEVAL_SUITES.join(","),
  );
});

test("release retrieval commands produce canonical paths and a baseline-bound report input", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retrieval-release-test-"));
  const retrievalDirectory = join(directory, "retrieval");
  const reportPath = join(directory, "release-report.json");
  const run = (args) => spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const retrieval = run([
      join(repositoryRoot, "eval/retrieval/release-gate.js"),
      "--artifact-directory", retrievalDirectory,
    ]);
    assert.equal(retrieval.status, 0, retrieval.stderr);
    const hints = run([
      join(repositoryRoot, "eval/retrieval/cli.js"),
      "--backend", "eval/retrieval/rocksdb-backend.js",
      "--suite", "hints",
      "--output", join(retrievalDirectory, "rocksdb-hints.json"),
      "--require-all",
    ]);
    assert.equal(hints.status, 0, hints.stderr);

    const baselineArtifact = JSON.parse(readFileSync(
      join(retrievalDirectory, "sqlite-baseline.json"),
      "utf8",
    ));
    const retrievalArtifact = JSON.parse(readFileSync(
      join(retrievalDirectory, "rocksdb-evaluation.json"),
      "utf8",
    ));
    assert.deepEqual(retrievalArtifact.selectedSuites, RELEASE_RETRIEVAL_SUITES);
    assert.equal(
      retrievalArtifact.results.lexical.baseline.artifactHash,
      baselineArtifact.artifactHash,
    );

    const report = writeReleaseReport({
      evidenceDirectory: directory,
      outputPath: reportPath,
    });
    for (const id of ["sqliteBaseline", "rocksdbRetrieval", "rocksdbHints"]) {
      assert.equal(report.components[id].status, "valid");
    }
    for (const gateName of [
      "sqliteBaseline",
      "exactRetrieval",
      "lexicalRetrieval",
      "structuralRetrieval",
      "chunkRecall",
      "automaticHints",
      "lexicalBaselineBinding",
    ]) {
      assert.equal(report.gates[gateName].status, "passed", gateName);
    }
    assert.equal(report.outcome, "failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("performance aggregate validation requires every raw component and has no partial mode", () => {
  const parsed = parseArchiveReleaseArguments([
    "--validate-artifact", "archive-release.json",
    "--comparison", "archive-10000.json",
    "--comparison", "archive-100000.json",
    "--comparison", "archive-1000000.json",
    "--system", "archive-system-1000000.json",
    "--retention", "archive-retention.json",
  ]);
  assert.deepEqual(parsed.comparisons, [
    "archive-10000.json",
    "archive-100000.json",
    "archive-1000000.json",
  ]);
  assert.equal(parsed.system, "archive-system-1000000.json");
  assert.equal(parsed.retention, "archive-retention.json");
  assert.throws(
    () => parseArchiveReleaseArguments(["--validate-artifact", "archive-release.json"]),
    /exactly three --comparison/u,
  );
  assert.throws(
    () => parseArchiveReleaseArguments([
      "--comparison", "a",
      "--comparison", "b",
      "--comparison", "c",
      "--system", "system",
      "--retention", "retention",
      "--output", "release",
      "--allow-partial",
    ]),
    /unknown argument: --allow-partial/u,
  );
});
