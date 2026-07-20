import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateArchiveBenchmarkArtifact } from "../../bench/archive/artifact.js";
import { validateArchiveReleaseArtifact } from "../../bench/archive/release-artifact.js";
import { validateArchiveSystemProbeArtifact } from "../../bench/archive/system-artifact.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store/store-contract.js";
import { validateRetrievalArtifact } from "../retrieval/artifact.js";
import {
  collectEvaluationEnvironment,
  validateEvaluationEnvironment,
} from "../retrieval/environment.js";
import { RETRIEVAL_REGRESSION_FIXTURE } from "../retrieval/fixtures.js";
import { canonicalJson, hashJson, sha256 } from "../retrieval/schema.js";
import { validateMigrationRehearsalArtifact } from "./migration-rehearsal.js";
import { validateReleaseVerifierArtifact } from "./verifiers.js";

export const RELEASE_REPORT_ARTIFACT_VERSION = 1;

export const RELEASE_REPORT_COMPONENTS = Object.freeze([
  Object.freeze({ id: "verifiers", relativePath: "verification/verifiers.json" }),
  Object.freeze({ id: "sqliteBaseline", relativePath: "retrieval/sqlite-baseline.json" }),
  Object.freeze({ id: "rocksdbRetrieval", relativePath: "retrieval/rocksdb-evaluation.json" }),
  Object.freeze({ id: "rocksdbHints", relativePath: "retrieval/rocksdb-hints.json" }),
  Object.freeze({ id: "comparison10000", relativePath: "bench/archive-10000.json" }),
  Object.freeze({ id: "comparison100000", relativePath: "bench/archive-100000.json" }),
  Object.freeze({ id: "comparison1000000", relativePath: "bench/archive-1000000.json" }),
  Object.freeze({ id: "system1000000", relativePath: "bench/archive-system-1000000.json" }),
  Object.freeze({ id: "retention", relativePath: "bench/archive-retention.json" }),
  Object.freeze({ id: "performance", relativePath: "bench/archive-release.json" }),
  Object.freeze({ id: "migrationRehearsal", relativePath: "migration/migration-rehearsal.json" }),
  Object.freeze({ id: "migrationVerification", relativePath: "migration/migration-verification.json" }),
]);

export const RELEASE_REPORT_GATE_NAMES = Object.freeze([
  "artifactsValid",
  "cleanRevision",
  "sharedIdentity",
  "verifiers",
  "sqliteBaseline",
  "exactRetrieval",
  "lexicalRetrieval",
  "structuralRetrieval",
  "chunkRecall",
  "automaticHints",
  "lexicalBaselineBinding",
  "performance",
  "migrationRollback",
  "releaseMetadata",
]);

const REPORT_DESCRIPTOR = Object.freeze({
  artifactVersion: RELEASE_REPORT_ARTIFACT_VERSION,
  kind: "rocksdb-archive-release-report",
  components: RELEASE_REPORT_COMPONENTS,
  gateNames: RELEASE_REPORT_GATE_NAMES,
  gateStatuses: Object.freeze(["passed", "failed"]),
  outcomes: Object.freeze(["passed", "failed"]),
  sharedIdentityFields: Object.freeze([
    "gitRevision",
    "dependencyLockSha256",
    "nodeVersion",
    "nodeAbi",
    "rocksdbVersion",
    "typeboxVersion",
  ]),
});

// Deliberately frozen. Component or final-gate edits require explicit review.
export const RELEASE_REPORT_SCHEMA_FINGERPRINT =
  "sha256:b3c031ec7623570e8f7f46a16917047e57c7e798b4d1ab7e5dca2ab4de4fc765";

export function assertFrozenReleaseReportContract() {
  const fingerprint = hashJson(REPORT_DESCRIPTOR);
  if (fingerprint !== RELEASE_REPORT_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Frozen release report schema fingerprint mismatch: expected ${RELEASE_REPORT_SCHEMA_FINGERPRINT}, got ${fingerprint}`,
    );
  }
}

function artifactHash(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  return hashJson(unsigned);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function identityFromEnvironment(environment) {
  return Object.freeze({
    gitRevision: environment.git.revision,
    dependencyLockSha256: environment.dependencyLockSha256,
    nodeVersion: environment.node.version,
    nodeAbi: environment.node.abi,
    rocksdbVersion: environment.dependencies.rocksdb,
    typeboxVersion: environment.dependencies.typebox,
  });
}

function expectedReleaseMetadata() {
  return Object.freeze({
    storageSchemaFingerprint: SCHEMA_FINGERPRINT,
    storageSchemaVersion: STORE_SCHEMA_VERSION,
    protocolVersion: STORE_PROTOCOL_VERSION,
  });
}

function performanceProvenanceMatches(provenance, environment, release) {
  return provenance?.gitRevision === environment.git.revision
    && provenance?.dependencyLockSha256 === environment.dependencyLockSha256
    && provenance?.storageSchemaVersion === release.storageSchemaVersion
    && provenance?.storageSchemaFingerprint === release.storageSchemaFingerprint
    && provenance?.protocolVersion === release.protocolVersion;
}

function gate(requirement, passed, detail) {
  return Object.freeze({
    status: passed ? "passed" : "failed",
    requirement,
    detail,
  });
}

function readComponent(evidenceDirectory, definition) {
  const path = join(evidenceDirectory, definition.relativePath);
  const state = {
    definition,
    path,
    artifact: undefined,
    status: "missing",
    error: "required evidence file is missing",
  };
  if (!existsSync(path)) return state;
  const bytes = readFileSync(path);
  state.bytes = bytes.length;
  state.contentSha256 = sha256(bytes);
  try {
    state.artifact = JSON.parse(bytes.toString("utf8"));
    state.status = "loaded";
    state.error = null;
  } catch (error) {
    state.status = "invalid";
    state.error = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  return state;
}

function validateComponent(state, validator) {
  if (state.status !== "loaded") return;
  try {
    validator(state.artifact);
    state.status = "valid";
    state.error = null;
  } catch (error) {
    state.status = "invalid";
    state.error = error instanceof Error ? error.message : String(error);
  }
}

function componentReference(state) {
  const reference = {
    id: state.definition.id,
    relativePath: state.definition.relativePath,
    status: state.status,
    error: state.error,
  };
  if (state.bytes !== undefined) {
    reference.bytes = state.bytes;
    reference.contentSha256 = state.contentSha256;
  }
  if (state.artifact && typeof state.artifact === "object") {
    reference.kind = state.artifact.kind ?? null;
    reference.artifactHash = state.artifact.artifactHash ?? null;
  }
  return Object.freeze(reference);
}

function selectedSuitesAre(artifact, suites) {
  return same(artifact?.selectedSuites, suites);
}

function passedSuite(artifact, suite) {
  return artifact?.results?.[suite]?.scored?.gate?.status === "passed";
}

function componentArtifacts(states, ids) {
  return ids
    .map((id) => states[id])
    .filter(({ status }) => status === "valid")
    .map(({ artifact }) => artifact);
}

function assembleReleaseReport({ evidenceDirectory, environment }) {
  assertFrozenReleaseReportContract();
  validateEvaluationEnvironment(environment);
  const states = Object.fromEntries(RELEASE_REPORT_COMPONENTS.map((definition) => [
    definition.id,
    readComponent(evidenceDirectory, definition),
  ]));

  validateComponent(states.verifiers, validateReleaseVerifierArtifact);
  for (const id of ["sqliteBaseline", "rocksdbRetrieval", "rocksdbHints"]) {
    validateComponent(states[id], (artifact) => {
      validateRetrievalArtifact(artifact, RETRIEVAL_REGRESSION_FIXTURE);
    });
  }
  for (const id of ["comparison10000", "comparison100000", "comparison1000000", "retention"]) {
    validateComponent(states[id], validateArchiveBenchmarkArtifact);
  }
  validateComponent(states.system1000000, validateArchiveSystemProbeArtifact);
  const performanceBundleIds = [
    "comparison10000",
    "comparison100000",
    "comparison1000000",
    "system1000000",
    "retention",
  ];
  if (performanceBundleIds.every((id) => states[id].status === "valid")) {
    validateComponent(states.performance, (artifact) => {
      validateArchiveReleaseArtifact(artifact, {
        comparisonArtifacts: [
          states.comparison10000.artifact,
          states.comparison100000.artifact,
          states.comparison1000000.artifact,
        ],
        systemArtifact: states.system1000000.artifact,
        retentionArtifact: states.retention.artifact,
      });
    });
  } else if (states.performance.status === "loaded") {
    states.performance.status = "invalid";
    states.performance.error = "one or more raw performance component artifacts are invalid";
  }
  if (states.migrationVerification.status === "loaded") {
    validateComponent(states.migrationRehearsal, (artifact) => {
      validateMigrationRehearsalArtifact(artifact, {
        verificationArtifactPath: states.migrationVerification.path,
      });
    });
    if (states.migrationRehearsal.status === "valid") {
      states.migrationVerification.status = "valid";
      states.migrationVerification.error = null;
    } else {
      states.migrationVerification.status = "invalid";
      states.migrationVerification.error = "migration rehearsal did not validate this parity artifact";
    }
  } else if (states.migrationRehearsal.status === "loaded") {
    states.migrationRehearsal.status = "invalid";
    states.migrationRehearsal.error = "migration verification artifact is missing or invalid";
  }

  const invalidComponents = RELEASE_REPORT_COMPONENTS
    .map(({ id }) => states[id])
    .filter(({ status }) => status !== "valid")
    .map(({ definition, status, error }) => `${definition.id}:${status}:${error}`);

  const environmentComponentIds = [
    "verifiers",
    "sqliteBaseline",
    "rocksdbRetrieval",
    "rocksdbHints",
    "comparison10000",
    "comparison100000",
    "comparison1000000",
    "system1000000",
    "retention",
    "migrationRehearsal",
  ];
  const evidenceArtifacts = componentArtifacts(states, environmentComponentIds);
  const dirtyArtifacts = evidenceArtifacts
    .filter(({ environment: componentEnvironment }) => componentEnvironment?.git?.dirty !== false)
    .map(({ kind }) => kind);
  const allEnvironmentArtifactsValid = evidenceArtifacts.length === environmentComponentIds.length;
  const currentIdentity = identityFromEnvironment(environment);
  const mismatchedIdentities = evidenceArtifacts
    .filter(({ environment: componentEnvironment }) =>
      !same(identityFromEnvironment(componentEnvironment), currentIdentity))
    .map(({ kind }) => kind);

  const baseline = states.sqliteBaseline.artifact;
  const retrieval = states.rocksdbRetrieval.artifact;
  const hints = states.rocksdbHints.artifact;
  const performance = states.performance.artifact;
  const migration = states.migrationRehearsal.artifact;
  const verifiers = states.verifiers.artifact;

  const baselineShape = states.sqliteBaseline.status === "valid"
    && baseline.kind === "retrieval-evaluation"
    && baseline.backend?.id === "sqlite-fts5-baseline"
    && selectedSuitesAre(baseline, ["lexical"])
    && passedSuite(baseline, "lexical")
    && baseline.outcome === "passed";
  const retrievalShape = states.rocksdbRetrieval.status === "valid"
    && retrieval.kind === "retrieval-evaluation"
    && retrieval.backend?.id === "rocksdb-archive"
    && selectedSuitesAre(retrieval, ["exact", "lexical", "structural", "chunks"]);
  const hintShape = states.rocksdbHints.status === "valid"
    && hints.kind === "retrieval-evaluation"
    && hints.backend?.id === "rocksdb-archive"
    && selectedSuitesAre(hints, ["hints"]);
  const expectedRelease = expectedReleaseMetadata();
  const releaseArtifacts = componentArtifacts(states, [
    "comparison10000",
    "comparison100000",
    "comparison1000000",
    "system1000000",
    "retention",
    "migrationRehearsal",
  ]);
  const releaseMetadataPassed = releaseArtifacts.length === 6
    && releaseArtifacts.every(({ release }) => same(release, expectedRelease))
    && states.performance.status === "valid"
    && performanceProvenanceMatches(performance.provenance, environment, expectedRelease);

  const gates = Object.freeze({
    artifactsValid: gate(
      "Every required source artifact exists and passes its native validator.",
      invalidComponents.length === 0,
      invalidComponents.length === 0 ? "all required artifacts validated" : invalidComponents,
    ),
    cleanRevision: gate(
      "The report and every evidence artifact were captured from a clean worktree.",
      environment.git.dirty === false
        && allEnvironmentArtifactsValid
        && dirtyArtifacts.length === 0,
      environment.git.dirty !== false
        ? `report environment git.dirty=${String(environment.git.dirty)}`
        : !allEnvironmentArtifactsValid
          ? "one or more component environments are unavailable because evidence is invalid"
          : dirtyArtifacts.length === 0
            ? "report and component environments are clean"
            : `dirty component kinds: ${dirtyArtifacts.join(", ")}`,
    ),
    sharedIdentity: gate(
      "All evidence uses the report revision, dependency lock, Node ABI, and dependency versions.",
      environment.git.revision !== "unavailable"
        && allEnvironmentArtifactsValid
        && mismatchedIdentities.length === 0,
      !allEnvironmentArtifactsValid
        ? "one or more component identities are unavailable because evidence is invalid"
        : mismatchedIdentities.length === 0
          ? currentIdentity
          : `identity mismatch: ${mismatchedIdentities.join(", ")}`,
    ),
    verifiers: gate(
      "Every frozen release verifier command passed.",
      states.verifiers.status === "valid" && verifiers.outcome === "passed",
      states.verifiers.status === "valid" ? verifiers.outcome : states.verifiers.error,
    ),
    sqliteBaseline: gate(
      "The SQLite lexical baseline is a complete passing frozen-suite artifact.",
      baselineShape,
      baselineShape ? baseline.artifactHash : states.sqliteBaseline.error ?? "baseline shape or gate failed",
    ),
    exactRetrieval: gate(
      "RocksDB exact-anchor retrieval passes the frozen suite.",
      retrievalShape && passedSuite(retrieval, "exact"),
      retrievalShape ? retrieval.results.exact.scored.gate.status : states.rocksdbRetrieval.error ?? "retrieval artifact shape failed",
    ),
    lexicalRetrieval: gate(
      "RocksDB lexical retrieval is no worse than the bound SQLite baseline.",
      retrievalShape && passedSuite(retrieval, "lexical"),
      retrievalShape ? retrieval.results.lexical.scored.gate.status : states.rocksdbRetrieval.error ?? "retrieval artifact shape failed",
    ),
    structuralRetrieval: gate(
      "RocksDB structural resolution passes the frozen suite.",
      retrievalShape && passedSuite(retrieval, "structural"),
      retrievalShape ? retrieval.results.structural.scored.gate.status : states.rocksdbRetrieval.error ?? "retrieval artifact shape failed",
    ),
    chunkRecall: gate(
      "RocksDB chunk targeting and canonical byte recall pass the frozen suite.",
      retrievalShape && passedSuite(retrieval, "chunks"),
      retrievalShape ? retrieval.results.chunks.scored.gate.status : states.rocksdbRetrieval.error ?? "retrieval artifact shape failed",
    ),
    automaticHints: gate(
      "Automatic retrieval hints pass quality, safety, stability, and budget gates.",
      hintShape && passedSuite(hints, "hints") && hints.outcome === "passed",
      hintShape ? hints.results.hints.scored.gate.status : states.rocksdbHints.error ?? "hint artifact shape failed",
    ),
    lexicalBaselineBinding: gate(
      "The RocksDB lexical score names the exact SQLite baseline artifact hash.",
      retrievalShape
        && baselineShape
        && retrieval.results.lexical.baseline?.artifactHash === baseline.artifactHash,
      retrievalShape
        ? retrieval.results.lexical.baseline?.artifactHash ?? "missing baseline hash"
        : states.rocksdbRetrieval.error ?? "retrieval artifact shape failed",
    ),
    performance: gate(
      "The strict performance aggregate passes every required scale and gate.",
      states.performance.status === "valid" && performance.outcome === "passed",
      states.performance.status === "valid" ? performance.outcome : states.performance.error,
    ),
    migrationRollback: gate(
      "Offline parity, pre-authority SQLite rollback, authority sealing, restart, and retry all pass.",
      states.migrationRehearsal.status === "valid"
        && states.migrationVerification.status === "valid"
        && migration.outcome === "passed",
      states.migrationRehearsal.status === "valid" ? migration.outcome : states.migrationRehearsal.error,
    ),
    releaseMetadata: gate(
      "Performance and migration evidence match the current storage schema and protocol.",
      releaseMetadataPassed,
      releaseMetadataPassed ? expectedRelease : "release metadata is missing, stale, or mismatched",
    ),
  });
  const blockers = RELEASE_REPORT_GATE_NAMES
    .filter((name) => gates[name].status !== "passed")
    .map((name) => Object.freeze({ name, detail: gates[name].detail }));
  const report = {
    kind: "rocksdb-archive-release-report",
    schemaVersion: RELEASE_REPORT_ARTIFACT_VERSION,
    schemaFingerprint: RELEASE_REPORT_SCHEMA_FINGERPRINT,
    generatedAt: environment.capturedAt,
    environment,
    identity: currentIdentity,
    release: expectedRelease,
    components: Object.freeze(Object.fromEntries(RELEASE_REPORT_COMPONENTS.map(({ id }) => [
      id,
      componentReference(states[id]),
    ]))),
    gates,
    blockers: Object.freeze(blockers),
    outcome: blockers.length === 0 ? "passed" : "failed",
  };
  return Object.freeze({ ...report, artifactHash: artifactHash(report) });
}

export function buildReleaseReport({
  evidenceDirectory,
  environment = collectEvaluationEnvironment(),
} = {}) {
  if (typeof evidenceDirectory !== "string" || evidenceDirectory.length === 0) {
    throw new TypeError("evidenceDirectory is required");
  }
  return assembleReleaseReport({
    evidenceDirectory: resolve(evidenceDirectory),
    environment,
  });
}

export function writeReleaseReport({ evidenceDirectory, outputPath, environment } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required");
  }
  const report = buildReleaseReport({ evidenceDirectory, environment });
  validateReleaseReportStructure(report);
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function validateReleaseReportStructure(artifact) {
  assertFrozenReleaseReportContract();
  if (!artifact || artifact.kind !== "rocksdb-archive-release-report"
    || artifact.schemaVersion !== RELEASE_REPORT_ARTIFACT_VERSION) {
    throw new TypeError("artifact must be a rocksdb-archive-release-report v1 artifact");
  }
  if (artifact.schemaFingerprint !== RELEASE_REPORT_SCHEMA_FINGERPRINT) {
    throw new Error("release report schema fingerprint is stale");
  }
  validateEvaluationEnvironment(artifact.environment);
  if (artifact.generatedAt !== artifact.environment.capturedAt
    || !same(artifact.identity, identityFromEnvironment(artifact.environment))) {
    throw new Error("release report environment identity is inconsistent");
  }
  if (!same(artifact.release, expectedReleaseMetadata())) {
    throw new Error("release report storage schema or protocol is stale");
  }
  if (!artifact.components || typeof artifact.components !== "object") {
    throw new TypeError("release report components are missing");
  }
  if (!same(Object.keys(artifact.components).sort(), RELEASE_REPORT_COMPONENTS
    .map(({ id }) => id).sort())) {
    throw new Error("release report component set is incomplete or contains extra entries");
  }
  for (const definition of RELEASE_REPORT_COMPONENTS) {
    const component = artifact.components[definition.id];
    if (!component || component.id !== definition.id
      || component.relativePath !== definition.relativePath
      || !["missing", "invalid", "valid"].includes(component.status)) {
      throw new Error(`release report component ${definition.id} is invalid`);
    }
    if (component.status === "valid"
      && (!Number.isSafeInteger(component.bytes)
        || component.bytes <= 0
        || !/^sha256:[a-f0-9]{64}$/u.test(component.contentSha256))) {
      throw new Error(`release report component ${definition.id} lacks a valid content hash`);
    }
    if (component.status === "valid"
      && definition.id !== "migrationVerification"
      && !/^sha256:[a-f0-9]{64}$/u.test(component.artifactHash ?? "")) {
      throw new Error(`release report component ${definition.id} lacks a valid artifact hash`);
    }
  }
  if (!artifact.gates || typeof artifact.gates !== "object") {
    throw new TypeError("release report gates are missing");
  }
  if (!same(Object.keys(artifact.gates).sort(), [...RELEASE_REPORT_GATE_NAMES].sort())) {
    throw new Error("release report gate set is incomplete or contains extra entries");
  }
  for (const name of RELEASE_REPORT_GATE_NAMES) {
    const result = artifact.gates[name];
    if (!result || !["passed", "failed"].includes(result.status)
      || typeof result.requirement !== "string") {
      throw new Error(`release report gate ${name} is invalid`);
    }
  }
  const expectedBlockers = RELEASE_REPORT_GATE_NAMES
    .filter((name) => artifact.gates[name].status !== "passed")
    .map((name) => ({ name, detail: artifact.gates[name].detail }));
  if (!same(artifact.blockers, expectedBlockers)
    || artifact.outcome !== (expectedBlockers.length === 0 ? "passed" : "failed")) {
    throw new Error("release report outcome or blocker list does not match its gates");
  }
  if (artifact.artifactHash !== artifactHash(artifact)) {
    throw new Error("release report artifact hash does not match its canonical content");
  }
  return artifact;
}

export function validateReleaseReportArtifact(artifact, { evidenceDirectory } = {}) {
  if (typeof evidenceDirectory !== "string" || evidenceDirectory.length === 0) {
    throw new TypeError("evidenceDirectory is required to validate a release report");
  }
  validateReleaseReportStructure(artifact);
  const rebuilt = assembleReleaseReport({
    evidenceDirectory: resolve(evidenceDirectory),
    environment: artifact.environment,
  });
  if (!same(artifact, rebuilt)) {
    throw new Error("release report does not match the referenced evidence files");
  }
  return artifact;
}
