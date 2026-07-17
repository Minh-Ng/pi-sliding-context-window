import { hashJson } from "../../eval/retrieval/schema.js";
import {
  ARCHIVE_BENCHMARK_GATE_NAMES,
  ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT,
  validateArchiveBenchmarkArtifact,
} from "./artifact.js";
import { createArchiveBenchmarkFixture } from "./fixture.js";
import {
  ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT,
  validateArchiveSystemProbeArtifact,
} from "./system-artifact.js";

export const ARCHIVE_RELEASE_ARTIFACT_VERSION = 1;
export const ARCHIVE_RELEASE_COMPARISON_SCALES = Object.freeze([
  10_000,
  100_000,
  1_000_000,
]);
export const ARCHIVE_RELEASE_RETENTION_FIXTURE = createArchiveBenchmarkFixture();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const ARCHIVE_RELEASE_SCHEMA_DESCRIPTOR = deepFreeze({
  artifactVersion: ARCHIVE_RELEASE_ARTIFACT_VERSION,
  comparisonScales: ARCHIVE_RELEASE_COMPARISON_SCALES,
  officialSystemScale: ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  componentKinds: [
    "three archive-benchmark comparison artifacts",
    "one official archive-system-probe artifact",
    "one archive-benchmark retention artifact",
  ],
  commonProvenance: [
    "clean git revision",
    "dependency lock SHA-256",
    "storage schema version",
    "storage schema fingerprint",
    "store protocol version",
  ],
  gateNames: ARCHIVE_BENCHMARK_GATE_NAMES,
  acceptedGateStatus: "passed",
  acceptedOutcome: "passed",
  componentBinding: "external artifacts are bound by their canonical artifact hashes",
  systemBindings: ["planFingerprint", "corpusFingerprint"],
  retentionFixture: ARCHIVE_RELEASE_RETENTION_FIXTURE,
});

export const ARCHIVE_RELEASE_SCHEMA_FINGERPRINT = hashJson(
  ARCHIVE_RELEASE_SCHEMA_DESCRIPTOR,
);

const TOP_LEVEL_KEYS = new Set([
  "kind",
  "schemaVersion",
  "schemaFingerprint",
  "generatedAt",
  "provenance",
  "components",
  "gates",
  "outcome",
  "notes",
  "artifactHash",
]);
const BUNDLE_KEYS = new Set([
  "comparisonArtifacts",
  "systemArtifact",
  "retentionArtifact",
]);

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
}

function assertExactKeys(value, keys, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${path}.${key}`, "is not allowed");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function assertString(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSha256(value, path) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail(path, "must be a SHA-256 fingerprint");
  }
}

function normalizeBundle(bundle) {
  assertExactKeys(bundle, BUNDLE_KEYS, "components");
  validateArchiveSystemProbeArtifact(bundle.systemArtifact);
  const system = bundle.systemArtifact;
  if (system.scale.profile !== "official"
    || system.scale.logicalWindows !== ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE
    || system.scale.releaseEligible !== true) {
    throw new Error("release system probe must be the official one-million-window profile");
  }
  assertSha256(system.artifactHash, "components.systemArtifact.artifactHash");

  if (!Array.isArray(bundle.comparisonArtifacts)) {
    fail("components.comparisonArtifacts", "must be an array");
  }
  if (bundle.comparisonArtifacts.length !== ARCHIVE_RELEASE_COMPARISON_SCALES.length) {
    fail(
      "components.comparisonArtifacts",
      `must contain exactly ${ARCHIVE_RELEASE_COMPARISON_SCALES.length} artifacts`,
    );
  }
  const comparisons = bundle.comparisonArtifacts.map((artifact, index) => {
    validateArchiveBenchmarkArtifact(artifact);
    if (artifact.mode !== "comparison") {
      fail(`components.comparisonArtifacts[${index}].mode`, "must be comparison");
    }
    if (artifact.fixture?.officialScale !== true
      || !ARCHIVE_RELEASE_COMPARISON_SCALES.includes(artifact.fixture?.scale)
      || artifact.fixture.logicalWindows !== artifact.fixture.scale) {
      fail(
        `components.comparisonArtifacts[${index}].fixture`,
        "must identify an official release comparison scale",
      );
    }
    assertSha256(
      artifact.artifactHash,
      `components.comparisonArtifacts[${index}].artifactHash`,
    );
    return artifact;
  }).sort((left, right) => left.fixture.scale - right.fixture.scale);
  const actualScales = comparisons.map(({ fixture }) => fixture.scale);
  if (!same(actualScales, ARCHIVE_RELEASE_COMPARISON_SCALES)) {
    throw new Error("release comparison artifacts must cover exactly 10k, 100k, and 1m windows");
  }

  const retention = validateArchiveReleaseRetentionArtifact(bundle.retentionArtifact);
  return { comparisons, system, retention };
}

export function validateArchiveReleaseRetentionArtifact(retention) {
  validateArchiveBenchmarkArtifact(retention);
  if (retention.mode !== "retention") {
    fail("components.retentionArtifact.mode", "must be retention");
  }
  if (!same(retention.fixture, ARCHIVE_RELEASE_RETENTION_FIXTURE)) {
    throw new Error("release retention artifact does not match the frozen retention fixture");
  }
  assertSha256(retention.artifactHash, "components.retentionArtifact.artifactHash");
  return retention;
}

function componentList(normalized) {
  return [...normalized.comparisons, normalized.system, normalized.retention];
}

function commonProvenance(normalized) {
  const artifacts = componentList(normalized);
  const first = artifacts[0];
  const revision = first.environment?.git?.revision;
  const dependencyLockSha256 = first.environment?.dependencyLockSha256;
  const storageSchemaVersion = first.release?.storageSchemaVersion;
  const storageSchemaFingerprint = first.release?.storageSchemaFingerprint;
  const protocolVersion = first.release?.protocolVersion;
  if (!/^[a-f0-9]{40,64}$/u.test(revision ?? "")) {
    throw new Error("release evidence requires an available hexadecimal git revision");
  }
  assertSha256(dependencyLockSha256, "component environment dependency lock");
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.environment?.git?.dirty !== false) {
      throw new Error(`release component ${index} was not captured from a clean worktree`);
    }
    if (artifact.environment.git.revision !== revision) {
      throw new Error("release components do not share one git revision");
    }
    if (artifact.environment.dependencyLockSha256 !== dependencyLockSha256) {
      throw new Error("release components do not share one dependency lock hash");
    }
    if (artifact.release.storageSchemaVersion !== storageSchemaVersion
      || artifact.release.storageSchemaFingerprint !== storageSchemaFingerprint) {
      throw new Error("release components do not share one storage schema");
    }
    if (artifact.release.protocolVersion !== protocolVersion) {
      throw new Error("release components do not share one store protocol");
    }
  }
  return {
    gitRevision: revision,
    dependencyLockSha256,
    storageSchemaVersion,
    storageSchemaFingerprint,
    protocolVersion,
    archiveBenchmarkSchemaFingerprint: ARCHIVE_BENCHMARK_SCHEMA_FINGERPRINT,
    archiveSystemProbeSchemaFingerprint: ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT,
  };
}

function requirePassedGate(gate, path) {
  if (!gate || gate.status !== "passed") {
    throw new Error(`${path} must be measured and passed`);
  }
}

function aggregateGates(normalized) {
  for (const [index, artifact] of normalized.comparisons.entries()) {
    requirePassedGate(
      artifact.gates.canonicalAppendP95,
      `comparison ${ARCHIVE_RELEASE_COMPARISON_SCALES[index]} canonicalAppendP95`,
    );
    requirePassedGate(
      artifact.gates.largeToolIngestThroughput,
      `comparison ${ARCHIVE_RELEASE_COMPARISON_SCALES[index]} largeToolIngestThroughput`,
    );
  }
  for (const name of [
    "warmPreflightP95",
    "threeWindowRecallP95",
    "steadyStateRss",
    "indexingBacklogRecovery",
    "acknowledgedWriteRecovery",
  ]) {
    requirePassedGate(normalized.system.gates[name], `official system probe ${name}`);
  }
  requirePassedGate(
    normalized.retention.gates.retentionCompaction,
    "retention retentionCompaction",
  );

  const comparisonHashes = normalized.comparisons.map(({ artifactHash }) => artifactHash);
  const systemHash = normalized.system.artifactHash;
  const retentionHash = normalized.retention.artifactHash;
  return {
    canonicalAppendP95: {
      status: "passed",
      measuredScales: [...ARCHIVE_RELEASE_COMPARISON_SCALES],
      componentHashes: comparisonHashes,
    },
    largeToolIngestThroughput: {
      status: "passed",
      measuredScales: [...ARCHIVE_RELEASE_COMPARISON_SCALES],
      componentHashes: comparisonHashes,
    },
    warmPreflightP95: { status: "passed", componentHash: systemHash },
    threeWindowRecallP95: { status: "passed", componentHash: systemHash },
    steadyStateRss: { status: "passed", componentHash: systemHash },
    indexingBacklogRecovery: { status: "passed", componentHash: systemHash },
    acknowledgedWriteRecovery: { status: "passed", componentHash: systemHash },
    retentionCompaction: { status: "passed", componentHash: retentionHash },
  };
}

function componentReferences(normalized) {
  return {
    comparisons: normalized.comparisons.map((artifact) => ({
      kind: artifact.kind,
      mode: artifact.mode,
      scale: artifact.fixture.scale,
      schemaFingerprint: artifact.schemaFingerprint,
      artifactHash: artifact.artifactHash,
    })),
    system: {
      kind: normalized.system.kind,
      profile: normalized.system.scale.profile,
      scale: normalized.system.scale.logicalWindows,
      schemaFingerprint: normalized.system.schemaFingerprint,
      planFingerprint: normalized.system.planFingerprint,
      corpusFingerprint: normalized.system.corpusFingerprint,
      artifactHash: normalized.system.artifactHash,
    },
    retention: {
      kind: normalized.retention.kind,
      mode: normalized.retention.mode,
      schemaFingerprint: normalized.retention.schemaFingerprint,
      artifactHash: normalized.retention.artifactHash,
    },
  };
}

function generatedAt(normalized) {
  return componentList(normalized)
    .map(({ environment }) => environment.capturedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1);
}

function unsignedRelease(bundle, notes) {
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    fail("notes", "must be an array of strings");
  }
  const normalized = normalizeBundle(bundle);
  const gates = aggregateGates(normalized);
  if (!same(Object.keys(gates), ARCHIVE_BENCHMARK_GATE_NAMES)) {
    throw new Error("release aggregate does not contain exactly the eight required gates");
  }
  return {
    kind: "archive-benchmark-release",
    schemaVersion: ARCHIVE_RELEASE_ARTIFACT_VERSION,
    schemaFingerprint: ARCHIVE_RELEASE_SCHEMA_FINGERPRINT,
    generatedAt: generatedAt(normalized),
    provenance: commonProvenance(normalized),
    components: componentReferences(normalized),
    gates,
    outcome: "passed",
    notes: structuredClone(notes),
  };
}

export function createArchiveReleaseArtifact({
  comparisonArtifacts,
  systemArtifact,
  retentionArtifact,
  notes = [],
}) {
  const artifact = unsignedRelease({
    comparisonArtifacts,
    systemArtifact,
    retentionArtifact,
  }, notes);
  return deepFreeze({ ...artifact, artifactHash: hashJson(artifact) });
}

/**
 * Validate an aggregate and the external component artifacts it hashes.
 * Omitting the component bundle fails closed because hash references alone
 * cannot prove that raw observations and recomputed component gates exist.
 */
export function validateArchiveReleaseArtifact(artifact, componentBundle) {
  assertExactKeys(artifact, TOP_LEVEL_KEYS, "artifact");
  if (artifact.kind !== "archive-benchmark-release"
    || artifact.schemaVersion !== ARCHIVE_RELEASE_ARTIFACT_VERSION) {
    fail("artifact", "must be an archive-benchmark-release v1 artifact");
  }
  if (artifact.schemaFingerprint !== ARCHIVE_RELEASE_SCHEMA_FINGERPRINT) {
    throw new Error("archive release artifact schema fingerprint is stale");
  }
  if (componentBundle === undefined) {
    throw new Error("release component artifacts are required for validation");
  }
  const rebuilt = unsignedRelease(componentBundle, artifact.notes);
  for (const field of [
    "generatedAt",
    "provenance",
    "components",
    "gates",
    "outcome",
  ]) {
    if (!same(artifact[field], rebuilt[field])) {
      throw new Error(`archive release artifact ${field} does not match its components`);
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(artifact.artifactHash)
    || artifact.artifactHash !== hashJson(rebuilt)) {
    throw new Error("archive release artifact hash does not match its canonical content");
  }
  return artifact;
}

export const createArchiveBenchmarkReleaseArtifact = createArchiveReleaseArtifact;
export const validateArchiveBenchmarkReleaseArtifact = validateArchiveReleaseArtifact;
