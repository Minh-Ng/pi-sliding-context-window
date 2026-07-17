import {
  RETRIEVAL_ARTIFACT_SCHEMA_VERSION,
  RETRIEVAL_BACKEND_API_VERSION,
  RETRIEVAL_SCHEMA_FINGERPRINT,
  RETRIEVAL_SUITES,
  canonicalJson,
  fixtureManifest,
  hashJson,
  validateRetrievalFixture,
} from "./schema.js";
import { validateEvaluationEnvironment } from "./environment.js";
import {
  evaluationOutcome,
  scoreRetrievalSuite,
  unsupportedSuite,
} from "./scoring.js";

function artifactHash(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  return hashJson(unsigned);
}

function assertBackendMetadata(backend) {
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) {
    throw new TypeError("backend metadata must be an object");
  }
  for (const key of ["id", "version"]) {
    if (typeof backend[key] !== "string" || backend[key].length === 0) {
      throw new TypeError(`backend.${key} must be a non-empty string`);
    }
  }
  if (backend.apiVersion !== RETRIEVAL_BACKEND_API_VERSION) {
    throw new TypeError(`backend.apiVersion must equal ${RETRIEVAL_BACKEND_API_VERSION}`);
  }
  if (!Array.isArray(backend.capabilities) || backend.capabilities.some((value) => typeof value !== "string")) {
    throw new TypeError("backend.capabilities must be an array of strings");
  }
}

export function createFixtureValidationArtifact({ fixture, environment }) {
  validateRetrievalFixture(fixture);
  validateEvaluationEnvironment(environment);
  const artifact = {
    kind: "retrieval-fixture-validation",
    schemaVersion: RETRIEVAL_ARTIFACT_SCHEMA_VERSION,
    schemaFingerprint: RETRIEVAL_SCHEMA_FINGERPRINT,
    generatedAt: environment.capturedAt,
    fixture: fixtureManifest(fixture),
    environment,
  };
  return Object.freeze({ ...artifact, artifactHash: artifactHash(artifact) });
}

export function createEvaluationArtifact({
  fixture,
  environment,
  backend,
  selectedSuites,
  runs,
  lexicalBaseline,
}) {
  validateRetrievalFixture(fixture, { allowUntouched: false });
  validateEvaluationEnvironment(environment);
  assertBackendMetadata(backend);
  if (!Array.isArray(selectedSuites) || selectedSuites.length === 0) {
    throw new TypeError("selectedSuites must be a non-empty array");
  }
  const seen = new Set();
  for (const suite of selectedSuites) {
    if (!RETRIEVAL_SUITES.includes(suite) || seen.has(suite)) {
      throw new TypeError(`selectedSuites contains invalid or duplicate suite: ${String(suite)}`);
    }
    seen.add(suite);
  }
  const results = {};
  const scoredSuites = {};
  for (const suite of selectedSuites) {
    const run = runs[suite];
    if (!run || typeof run !== "object") throw new TypeError(`missing run for suite ${suite}`);
    if (run.status === "unsupported") {
      const scored = unsupportedSuite(String(run.reason ?? `${suite} is unsupported by this backend`));
      results[suite] = { status: "unsupported", reason: scored.reason, observations: [], scored };
      scoredSuites[suite] = scored;
      continue;
    }
    if (run.status !== "completed" || !Array.isArray(run.observations)) {
      throw new TypeError(`run ${suite} must be completed or unsupported`);
    }
    const baseline = suite === "lexical" ? lexicalBaseline : undefined;
    const scored = scoreRetrievalSuite(suite, fixture, run.observations, { baseline });
    results[suite] = {
      status: "completed",
      observations: run.observations,
      baseline: baseline ?? null,
      scored,
    };
    scoredSuites[suite] = scored;
  }
  const artifact = {
    kind: "retrieval-evaluation",
    schemaVersion: RETRIEVAL_ARTIFACT_SCHEMA_VERSION,
    schemaFingerprint: RETRIEVAL_SCHEMA_FINGERPRINT,
    generatedAt: environment.capturedAt,
    fixture: fixtureManifest(fixture),
    environment,
    backend,
    selectedSuites,
    results,
    outcome: evaluationOutcome(scoredSuites),
  };
  return Object.freeze({ ...artifact, artifactHash: artifactHash(artifact) });
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateRetrievalArtifact(artifact, fixture) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new TypeError("artifact must be an object");
  }
  validateRetrievalFixture(fixture);
  if (artifact.schemaVersion !== RETRIEVAL_ARTIFACT_SCHEMA_VERSION) {
    throw new TypeError(`artifact.schemaVersion must equal ${RETRIEVAL_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (artifact.schemaFingerprint !== RETRIEVAL_SCHEMA_FINGERPRINT) {
    throw new Error("artifact schema fingerprint is stale");
  }
  if (!sameValue(artifact.fixture, fixtureManifest(fixture))) {
    throw new Error("artifact fixture manifest, ordering, annotations, or exposure state does not match the frozen fixture");
  }
  validateEvaluationEnvironment(artifact.environment);
  if (artifact.generatedAt !== artifact.environment.capturedAt) {
    throw new Error("artifact generatedAt must match environment capture time");
  }
  if (artifact.artifactHash !== artifactHash(artifact)) {
    throw new Error("artifact hash does not match its canonical content");
  }
  if (artifact.kind === "retrieval-fixture-validation") return artifact;
  if (artifact.kind !== "retrieval-evaluation") throw new TypeError("artifact.kind is not recognized");
  assertBackendMetadata(artifact.backend);
  if (!Array.isArray(artifact.selectedSuites) || artifact.selectedSuites.length === 0) {
    throw new TypeError("artifact.selectedSuites must be a non-empty array");
  }
  if (new Set(artifact.selectedSuites).size !== artifact.selectedSuites.length) {
    throw new TypeError("artifact.selectedSuites must not contain duplicates");
  }
  const rescored = {};
  for (const suite of artifact.selectedSuites) {
    if (!RETRIEVAL_SUITES.includes(suite)) throw new TypeError(`unknown selected suite ${String(suite)}`);
    const result = artifact.results?.[suite];
    if (!result || typeof result !== "object") throw new TypeError(`artifact is missing result ${suite}`);
    if (result.status === "unsupported") {
      const expected = unsupportedSuite(result.reason);
      if (!sameValue(result.scored, expected)) throw new Error(`${suite} unsupported score payload was modified`);
      rescored[suite] = expected;
      continue;
    }
    if (result.status !== "completed" || !Array.isArray(result.observations)) {
      throw new TypeError(`${suite} result must be completed or unsupported`);
    }
    const score = scoreRetrievalSuite(suite, fixture, result.observations, {
      baseline: suite === "lexical" ? result.baseline ?? undefined : undefined,
    });
    if (!sameValue(score, result.scored)) {
      throw new Error(`${suite} stored scores do not match recomputed scores`);
    }
    rescored[suite] = score;
  }
  if (artifact.outcome !== evaluationOutcome(rescored)) {
    throw new Error("artifact outcome does not match recomputed suite gates");
  }
  return artifact;
}
