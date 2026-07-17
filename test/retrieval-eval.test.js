import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import test from "node:test";
import { renderContinuityMarker } from "../src/retrieval/continuity-policy.js";
import { oneLineJson } from "../src/retrieval/render.js";
import {
  PERFORMANCE_CORPUS_PLAN_FINGERPRINT,
  RETRIEVAL_BACKEND_API_VERSION,
  RETRIEVAL_REGRESSION_FIXTURE,
  RETRIEVAL_REGRESSION_FIXTURE_FINGERPRINT,
  RETRIEVAL_SCHEMA_FINGERPRINT,
  assertFrozenRegressionFixture,
  authorizeFixtureEvaluation,
  collectEvaluationEnvironment,
  createEvaluationArtifact,
  createFixtureValidationArtifact,
  createPerformanceArtifact,
  createRocksdbEvaluationBackend,
  createSqliteEvaluationBackend,
  fixtureFingerprint,
  generatePerformanceDocuments,
  hashJson,
  measureOperation,
  percentile,
  runRetrievalEvaluation,
  scoreRetrievalSuite,
  validatePerformanceArtifact,
  validateRetrievalArtifact,
  validateRetrievalFixture,
} from "../eval/retrieval/index.js";

function testEnvironment() {
  return {
    capturedAt: "2026-07-16T12:00:00.000Z",
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

function historicalHint(document) {
  const sourceDate = new Date(document.createdAt).toISOString().slice(0, 10);
  return [
    "",
    "",
    "[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]",
    `Archived excerpt from ${sourceDate} as JSON data: verify current state; ${oneLineJson(document.text)}`,
  ].join("\n");
}

function oracleBackend() {
  let fixture;
  const byLocator = new Map();
  const frozenHints = new Map();
  return {
    metadata: {
      id: "oracle",
      version: "1",
      apiVersion: RETRIEVAL_BACKEND_API_VERSION,
      capabilities: ["exact", "lexical", "structural", "chunks", "hints"],
    },
    async prepare(value) {
      fixture = value;
    },
    async search(request) {
      const suite = request.mode === "structural"
        ? "structural"
        : fixture.suites.chunks.some(({ query }) => query === request.query)
          ? "chunks"
          : fixture.suites.exact.some(({ query }) => query === request.query)
            ? "exact"
            : "lexical";
      const evaluationCase = fixture.suites[suite].find(({ query }) => query === request.query);
      if (suite === "structural") {
        return {
          results: evaluationCase.relevantLocations.map((location) => ({ ...location, score: 1 })),
        };
      }
      const documentIds = suite === "chunks"
        ? [evaluationCase.relevantWindow.documentId]
        : evaluationCase.relevantDocumentIds;
      return {
        results: documentIds.map((documentId, index) => {
          const locator = `oracle:${evaluationCase.id}:${index}`;
          byLocator.set(locator, evaluationCase);
          return { documentId, score: 1 - (index / 10), locator };
        }),
      };
    },
    async recall({ locator }) {
      const evaluationCase = byLocator.get(locator);
      const document = fixture.documents.find(({ id }) => id === evaluationCase.relevantWindow.documentId);
      const { startByte, endByte } = evaluationCase.relevantWindow;
      const canonicalText = Buffer.from(document.text, "utf8")
        .subarray(startByte, endByte)
        .toString("utf8");
      return {
        status: "resolved",
        documentId: document.id,
        startByte,
        endByte,
        canonicalText,
        renderedText: `[archived evidence]\n${canonicalText}`,
      };
    },
    async preflight(request) {
      if (frozenHints.has(request.messageKey)) return frozenHints.get(request.messageKey);
      const evaluationCase = fixture.suites.hints.find(({ messageKey }) => messageKey === request.messageKey);
      const document = fixture.documents.find(({ id }) => id === evaluationCase.relevantDocumentIds[0]);
      const hintText = evaluationCase.expected === "suppress"
        ? ""
        : evaluationCase.expectedDisclosure === "continuity-marker"
          ? renderContinuityMarker(request.message, [request.message])
          : historicalHint(document);
      const response = evaluationCase.expected === "reveal"
        ? {
            modelVisibleText: hintText,
            hints: [{
              documentId: evaluationCase.relevantDocumentIds[0],
              text: hintText,
              tokenCount: 0,
              sourceKind: document.kind,
              archivedDataDelimited: evaluationCase.expectedDisclosure === "historical-snippet",
            }],
          }
        : { modelVisibleText: "", hints: [] };
      frozenHints.set(request.messageKey, response);
      return response;
    },
  };
}

async function oracleRuns(suites = ["exact", "lexical", "structural", "chunks", "hints"]) {
  return runRetrievalEvaluation({
    backend: oracleBackend(),
    fixture: RETRIEVAL_REGRESSION_FIXTURE,
    suites,
  });
}

function replaceHintVisibleText(observation, text, hintOverrides = {}) {
  for (const phase of ["first", "reconstruction"]) {
    const response = observation[phase];
    assert.equal(response.hints.length, 1);
    response.modelVisibleText = text;
    response.hints[0].text = text;
    Object.assign(response.hints[0], hintOverrides);
  }
}

function resign(artifact) {
  const { artifactHash: _old, ...unsigned } = artifact;
  artifact.artifactHash = hashJson(unsigned);
  return artifact;
}

test("frozen retrieval fixtures validate ordering, annotations, coordinates, and fingerprint", () => {
  assert.equal(assertFrozenRegressionFixture(), RETRIEVAL_REGRESSION_FIXTURE);
  assert.equal(
    fixtureFingerprint(RETRIEVAL_REGRESSION_FIXTURE),
    RETRIEVAL_REGRESSION_FIXTURE_FINGERPRINT,
  );
  assert.match(RETRIEVAL_SCHEMA_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
  const hintCases = RETRIEVAL_REGRESSION_FIXTURE.suites.hints;
  assert.ok(hintCases.filter(({ expectedDisclosure }) => expectedDisclosure === "continuity-marker").length >= 3);
  assert.deepEqual(
    new Set(hintCases.filter(({ expected }) => expected === "suppress").map(({ negativeType }) => negativeType)),
    new Set([
      "active-budget",
      "repeated-source",
      "stale-source",
      "weak-bm25",
      "common-word",
      "incidental-exact",
      "correction",
      "current-state",
      "already-visible",
      "general-knowledge",
    ]),
  );

  const reordered = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  reordered.suites.exact.reverse();
  assert.throws(() => validateRetrievalFixture(reordered), /must be exact-001/);

  const badCoordinates = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  badCoordinates.suites.chunks[0].relevantWindow.startByte += 1;
  assert.throws(() => validateRetrievalFixture(badCoordinates), /byte coordinates/);

  const unknownField = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  unknownField.suites.lexical[0].unexpected = true;
  assert.throws(() => validateRetrievalFixture(unknownField), /not allowed/);
});

test("untouched held-out fixtures require explicit one-run authorization", () => {
  const heldout = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  heldout.fixtureId = "retrieval-heldout-2026-07-16";
  heldout.exposure = "untouched";
  for (const suite of Object.values(heldout.suites)) {
    for (const evaluationCase of suite) evaluationCase.exposure = "untouched";
  }
  validateRetrievalFixture(heldout);
  assert.throws(() => authorizeFixtureEvaluation(heldout), /allowHeldout=true/);
  assert.equal(authorizeFixtureEvaluation(heldout, { allowHeldout: true }), heldout);
});

test("oracle backend passes exact, lexical, structural, chunk, and hint gates", async () => {
  const runs = await oracleRuns();
  const lexicalBaseline = scoreRetrievalSuite(
    "lexical",
    RETRIEVAL_REGRESSION_FIXTURE,
    runs.lexical.observations,
  ).metrics;
  const artifact = createEvaluationArtifact({
    fixture: RETRIEVAL_REGRESSION_FIXTURE,
    environment: testEnvironment(),
    backend: oracleBackend().metadata,
    selectedSuites: ["exact", "lexical", "structural", "chunks", "hints"],
    runs,
    lexicalBaseline,
  });
  assert.equal(artifact.outcome, "passed");
  assert.deepEqual(
    Object.fromEntries(Object.entries(artifact.results).map(([suite, result]) => [suite, result.scored.gate.status])),
    { exact: "passed", lexical: "passed", structural: "passed", chunks: "passed", hints: "passed" },
  );
  assert.equal(validateRetrievalArtifact(artifact, RETRIEVAL_REGRESSION_FIXTURE), artifact);
});

test("scoring exposes retrieval misses, unsafe hints, and byte-range corruption", async () => {
  const runs = await oracleRuns();
  runs.exact.observations[0].results = [];
  assert.equal(
    scoreRetrievalSuite("exact", RETRIEVAL_REGRESSION_FIXTURE, runs.exact.observations).gate.status,
    "failed",
  );

  runs.chunks.observations[0].recall.canonicalText += "corrupt";
  const chunkScore = scoreRetrievalSuite("chunks", RETRIEVAL_REGRESSION_FIXTURE, runs.chunks.observations);
  assert.equal(chunkScore.gate.status, "failed");
  assert.ok(chunkScore.metrics.canonicalByteAccuracy < 1);

  runs.hints.observations[9].first = {
    modelVisibleText: "irrelevant archive hint",
    hints: [{
      documentId: "doc-exact-error",
      text: "unquoted tool output",
      tokenCount: 5,
      sourceKind: "tool-result",
      archivedDataDelimited: false,
    }],
  };
  const hintScore = scoreRetrievalSuite("hints", RETRIEVAL_REGRESSION_FIXTURE, runs.hints.observations);
  assert.equal(hintScore.gate.status, "failed");
  assert.ok(hintScore.metrics.negativeFalsePositiveRate > 0.05);
  assert.equal(hintScore.metrics.staleRevealCount, 1);
  assert.equal(hintScore.metrics.unsafeArchivedToolHintCount, 1);
});

test("scoring rejects hidden chunk evidence and forged backend token counts", async () => {
  const hiddenRuns = await oracleRuns(["chunks"]);
  hiddenRuns.chunks.observations[0].recall.renderedText = "";
  hiddenRuns.chunks.observations[0].recall.returnedTokens = 0;
  const hiddenScore = scoreRetrievalSuite(
    "chunks",
    RETRIEVAL_REGRESSION_FIXTURE,
    hiddenRuns.chunks.observations,
  );
  assert.equal(hiddenScore.gate.status, "failed");
  assert.equal(hiddenScore.cases[0].containsEvidence, false);
  assert.equal(hiddenScore.cases[0].canonicalBytesExact, true);
  assert.equal(hiddenScore.metrics.canonicalByteAccuracy, 1);

  const forgedRuns = await oracleRuns(["chunks"]);
  forgedRuns.chunks.observations[0].recall.renderedText += `\n${"opaque_identifier_123456 ".repeat(100)}`;
  forgedRuns.chunks.observations[0].recall.returnedTokens = 0;
  const forgedScore = scoreRetrievalSuite(
    "chunks",
    RETRIEVAL_REGRESSION_FIXTURE,
    forgedRuns.chunks.observations,
  );
  assert.equal(forgedScore.gate.status, "failed");
  assert.ok(forgedScore.cases[0].returnedTokens > RETRIEVAL_REGRESSION_FIXTURE.suites.chunks[0].maxTokens);
  assert.equal(forgedScore.metrics.tokenBudgetViolationCount, 1);
});

test("hint scoring requires visible useful text and ignores forged per-hint budgets", async () => {
  const hiddenRuns = await oracleRuns(["hints"]);
  hiddenRuns.hints.observations[0].first.modelVisibleText = "";
  hiddenRuns.hints.observations[0].reconstruction.modelVisibleText = "";
  const hiddenScore = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    hiddenRuns.hints.observations,
  );
  assert.equal(hiddenScore.gate.status, "failed");
  assert.equal(hiddenScore.cases[0].useful, false);
  assert.equal(hiddenScore.cases[0].visible, false);

  const forgedRuns = await oracleRuns(["hints"]);
  const hugeModelVisibleText = `${forgedRuns.hints.observations[0].first.modelVisibleText}\n${"opaque_identifier_123456 ".repeat(100)}`;
  replaceHintVisibleText(forgedRuns.hints.observations[0], hugeModelVisibleText);
  forgedRuns.hints.observations[0].first.hints[0].tokenCount = 0;
  forgedRuns.hints.observations[0].reconstruction.hints[0].tokenCount = 0;
  const forgedScore = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    forgedRuns.hints.observations,
  );
  assert.equal(forgedScore.gate.status, "failed");
  assert.equal(forgedScore.cases[0].useful, false);
  assert.equal(forgedScore.cases[0].hintTextConsistent, true);
  assert.equal(forgedScore.cases[0].visibleBytesValid, false);
  assert.equal(forgedScore.cases[0].frozenBytesEqual, true);
  assert.ok(forgedScore.cases[0].returnedTokens > RETRIEVAL_REGRESSION_FIXTURE.suites.hints[0].hintBudgetTokens);
  assert.equal(forgedScore.metrics.budgetViolationCount, 1);
});

test("hint hard gates score disclosure bytes, candidate-only leakage, and shared active budget", async () => {
  const wrongDisclosureRuns = await oracleRuns(["hints"]);
  const wrongBytes = wrongDisclosureRuns.hints.observations[0].first.modelVisibleText
    .replace("[PRIOR SHARED CONTEXT MARKER]", "[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]");
  wrongDisclosureRuns.hints.observations[0].first.modelVisibleText = wrongBytes;
  wrongDisclosureRuns.hints.observations[0].first.hints[0].text = wrongBytes;
  wrongDisclosureRuns.hints.observations[0].reconstruction.modelVisibleText = wrongBytes;
  wrongDisclosureRuns.hints.observations[0].reconstruction.hints[0].text = wrongBytes;
  const wrongDisclosure = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    wrongDisclosureRuns.hints.observations,
  );
  assert.equal(wrongDisclosure.gate.status, "failed");
  assert.ok(wrongDisclosure.metrics.continuityMarkerRecall < 0.9);

  const leakageRuns = await oracleRuns(["hints"]);
  for (const phase of ["first", "reconstruction"]) {
    const response = leakageRuns.hints.observations[0][phase];
    response.modelVisibleText += "\nTABLET_QUORUM_WATERMARK";
    response.hints[0].text = response.modelVisibleText;
  }
  const leakage = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    leakageRuns.hints.observations,
  );
  assert.equal(leakage.gate.status, "failed");
  assert.equal(leakage.metrics.candidateOnlyTermLeakageCount, 1);

  const activeBudgetRuns = await oracleRuns(["hints"]);
  const activeBudgetCase = activeBudgetRuns.hints.observations[2];
  const leakedMarker = "\n\n[PRIOR SHARED CONTEXT MARKER]\nProvider cache prefix reconstruction.";
  for (const phase of ["first", "reconstruction"]) {
    activeBudgetCase[phase] = {
      modelVisibleText: leakedMarker,
      hints: [{
        documentId: "doc-continuity-cache",
        text: leakedMarker,
        sourceKind: "turn",
        archivedDataDelimited: false,
      }],
    };
  }
  const activeBudget = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    activeBudgetRuns.hints.observations,
  );
  assert.equal(activeBudget.gate.status, "failed");
  assert.equal(activeBudget.metrics.activeBudgetViolationCount, 1);
  assert.equal(activeBudget.metrics.budgetViolationCount, 0);

  const missingPolicyRuns = await oracleRuns(["hints"]);
  delete missingPolicyRuns.hints.observations[0].runtimePolicy;
  assert.throws(
    () => scoreRetrievalSuite(
      "hints",
      RETRIEVAL_REGRESSION_FIXTURE,
      missingPolicyRuns.hints.observations,
    ),
    /runtimePolicy must exactly match/u,
  );
  const forgedPolicyRuns = await oracleRuns(["hints"]);
  forgedPolicyRuns.hints.observations[0].runtimePolicy = {
    ...forgedPolicyRuns.hints.observations[0].runtimePolicy,
    activeHintBudgetTokens:
      forgedPolicyRuns.hints.observations[0].runtimePolicy.activeHintBudgetTokens + 1,
  };
  assert.throws(
    () => scoreRetrievalSuite(
      "hints",
      RETRIEVAL_REGRESSION_FIXTURE,
      forgedPolicyRuns.hints.observations,
    ),
    /runtimePolicy must exactly match/u,
  );
});

test("hint scoring rejects incomplete, noncanonical, and inconsistent disclosure bytes", async () => {
  const markerMutations = [
    () => "\n\n[PRIOR SHARED CONTEXT MARKER]",
    (text) => text.slice(0, text.lastIndexOf("\n")),
    (text) => text.replace(/\n- [^\n]+\n/u, "\n"),
    (text) => `${text}\nextra bytes`,
  ];
  for (const mutate of markerMutations) {
    const runs = await oracleRuns(["hints"]);
    const observation = runs.hints.observations[0];
    replaceHintVisibleText(observation, mutate(observation.first.modelVisibleText));
    const score = scoreRetrievalSuite("hints", RETRIEVAL_REGRESSION_FIXTURE, runs.hints.observations);
    assert.equal(score.gate.status, "failed");
    assert.equal(score.cases[0].visibleBytesValid, false);
    assert.equal(score.cases[0].useful, false);
  }

  const snippetDocument = RETRIEVAL_REGRESSION_FIXTURE.documents.find(({ id }) => id === "doc-lexical-dedup");
  const snippetMutations = [
    () => "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]",
    (text) => text.replace("from 2026-07-17", "from 2000-01-01"),
    (text) => text.replace(oneLineJson(snippetDocument.text), "\"\""),
    (text) => text.replace(oneLineJson(snippetDocument.text), oneLineJson("not canonical source text")),
    (text) => `${text}\nextra bytes`,
  ];
  for (const mutate of snippetMutations) {
    const runs = await oracleRuns(["hints"]);
    const observation = runs.hints.observations[5];
    replaceHintVisibleText(observation, mutate(observation.first.modelVisibleText));
    const score = scoreRetrievalSuite("hints", RETRIEVAL_REGRESSION_FIXTURE, runs.hints.observations);
    assert.equal(score.gate.status, "failed");
    assert.equal(score.cases[5].visibleBytesValid, false);
    assert.equal(score.cases[5].useful, false);
  }

  const inconsistentRuns = await oracleRuns(["hints"]);
  inconsistentRuns.hints.observations[0].reconstruction.hints[0].text += "\nnot model-visible";
  const inconsistent = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    inconsistentRuns.hints.observations,
  );
  assert.equal(inconsistent.gate.status, "failed");
  assert.equal(inconsistent.cases[0].visibleBytesValid, true);
  assert.equal(inconsistent.cases[0].hintTextConsistent, false);
  assert.equal(inconsistent.cases[0].useful, false);
});

test("exact marker grammar blocks case-folded jargon and ambiguous candidate prose", async () => {
  const caseFoldedRuns = await oracleRuns(["hints"]);
  const caseFoldedObservation = caseFoldedRuns.hints.observations[0];
  replaceHintVisibleText(
    caseFoldedObservation,
    `${caseFoldedObservation.first.modelVisibleText}\ntablet_quorum_watermark`,
  );
  const caseFolded = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    caseFoldedRuns.hints.observations,
  );
  assert.equal(caseFolded.gate.status, "failed");
  assert.equal(caseFolded.metrics.candidateOnlyTermLeakageCount, 0);
  assert.equal(caseFolded.cases[0].visibleBytesValid, false);

  const ambiguousRuns = await oracleRuns(["hints"]);
  const ambiguousObservation = ambiguousRuns.hints.observations[7];
  replaceHintVisibleText(
    ambiguousObservation,
    `${ambiguousObservation.first.modelVisibleText}\nselected the left layout`,
  );
  const ambiguous = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    ambiguousRuns.hints.observations,
  );
  assert.equal(ambiguous.gate.status, "failed");
  assert.equal(ambiguous.metrics.candidateOnlyTermLeakageCount, 0);
  assert.equal(ambiguous.cases[7].visibleBytesValid, false);
});

test("tool-result safety derives from fixture provenance and canonical quoted bytes", async () => {
  const rawToolRuns = await oracleRuns(["hints"]);
  const rawToolObservation = rawToolRuns.hints.observations[5];
  replaceHintVisibleText(
    rawToolObservation,
    "[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]\nRESPONSE_CHANNEL_CLOSED",
    {
      documentId: "doc-exact-error",
      sourceKind: "turn",
      archivedDataDelimited: true,
    },
  );
  const rawTool = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    rawToolRuns.hints.observations,
  );
  assert.equal(rawTool.gate.status, "failed");
  assert.equal(rawTool.metrics.unsafeArchivedToolHintCount, 1);
  assert.equal(rawTool.cases[5].safeArchivedData, false);
  assert.equal(rawTool.cases[5].visibleBytesValid, false);

  const toolMarkerRuns = await oracleRuns(["hints"]);
  const toolMarkerObservation = toolMarkerRuns.hints.observations[0];
  replaceHintVisibleText(
    toolMarkerObservation,
    toolMarkerObservation.first.modelVisibleText,
    {
      documentId: "doc-exact-error",
      sourceKind: "turn",
      archivedDataDelimited: true,
    },
  );
  const toolMarker = scoreRetrievalSuite(
    "hints",
    RETRIEVAL_REGRESSION_FIXTURE,
    toolMarkerRuns.hints.observations,
  );
  assert.equal(toolMarker.gate.status, "failed");
  assert.equal(toolMarker.metrics.unsafeArchivedToolHintCount, 1);
  assert.equal(toolMarker.cases[0].visibleBytesValid, true);
  assert.equal(toolMarker.cases[0].safeArchivedData, false);

  const toolFixture = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  toolFixture.suites.hints[5].relevantDocumentIds = ["doc-exact-error"];
  validateRetrievalFixture(toolFixture);
  const validToolRuns = await runRetrievalEvaluation({
    backend: oracleBackend(),
    fixture: toolFixture,
    suites: ["hints"],
  });
  for (const phase of ["first", "reconstruction"]) {
    validToolRuns.hints.observations[5][phase].hints[0].sourceKind = "turn";
    validToolRuns.hints.observations[5][phase].hints[0].archivedDataDelimited = false;
  }
  const validTool = scoreRetrievalSuite("hints", toolFixture, validToolRuns.hints.observations);
  assert.equal(validTool.gate.status, "passed");
  assert.equal(validTool.metrics.unsafeArchivedToolHintCount, 0);
  assert.equal(validTool.cases[5].safeArchivedData, true);
  assert.equal(validTool.cases[5].visibleBytesValid, true);
});

test("artifact validation rejects changed fixtures, stale schemas, hashes, and score recomputation mismatches", async () => {
  const runs = await oracleRuns(["exact"]);
  const artifact = createEvaluationArtifact({
    fixture: RETRIEVAL_REGRESSION_FIXTURE,
    environment: testEnvironment(),
    backend: oracleBackend().metadata,
    selectedSuites: ["exact"],
    runs,
  });

  const stale = structuredClone(artifact);
  stale.schemaFingerprint = `sha256:${"0".repeat(64)}`;
  resign(stale);
  assert.throws(() => validateRetrievalArtifact(stale, RETRIEVAL_REGRESSION_FIXTURE), /schema fingerprint is stale/);

  const badHash = structuredClone(artifact);
  badHash.backend.version = "modified";
  assert.throws(() => validateRetrievalArtifact(badHash, RETRIEVAL_REGRESSION_FIXTURE), /artifact hash/);

  const badScore = structuredClone(artifact);
  badScore.results.exact.scored.metrics.recallAt3 = 0;
  resign(badScore);
  assert.throws(() => validateRetrievalArtifact(badScore, RETRIEVAL_REGRESSION_FIXTURE), /stored scores/);

  const changedFixture = structuredClone(RETRIEVAL_REGRESSION_FIXTURE);
  changedFixture.documents[0].text += " changed";
  assert.throws(() => validateRetrievalArtifact(artifact, changedFixture), /fixture manifest/);
});

test("fixture validation artifacts carry complete environment and verify independently of a backend", () => {
  const environment = testEnvironment();
  const artifact = createFixtureValidationArtifact({
    fixture: RETRIEVAL_REGRESSION_FIXTURE,
    environment,
  });
  assert.equal(artifact.fixture.exposure, "regression");
  assert.equal(artifact.environment.dependencyLockSha256, environment.dependencyLockSha256);
  assert.equal(validateRetrievalArtifact(artifact, RETRIEVAL_REGRESSION_FIXTURE), artifact);
  assert.throws(
    () => createFixtureValidationArtifact({
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
      environment: { ...environment, cpu: undefined },
    }),
    /cpu.model/,
  );
});

test("legacy SQLite adapter establishes passing exact, lexical, and structural baselines", async () => {
  const backend = createSqliteEvaluationBackend();
  try {
    const runs = await runRetrievalEvaluation({
      backend,
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
      suites: ["exact", "lexical", "structural"],
    });
    const lexical = scoreRetrievalSuite(
      "lexical",
      RETRIEVAL_REGRESSION_FIXTURE,
      runs.lexical.observations,
    );
    assert.equal(scoreRetrievalSuite("exact", RETRIEVAL_REGRESSION_FIXTURE, runs.exact.observations).gate.status, "passed");
    assert.equal(scoreRetrievalSuite("structural", RETRIEVAL_REGRESSION_FIXTURE, runs.structural.observations).gate.status, "passed");
    assert.equal(lexical.metrics.recallAt3, 1);
    assert.equal(lexical.metrics.meanReciprocalRank, 1);
  } finally {
    await backend.close();
  }
});

test("RocksDB evaluation backend passes every release retrieval gate against SQLite", async () => {
  const sqlite = createSqliteEvaluationBackend();
  let lexicalBaseline;
  try {
    const runs = await runRetrievalEvaluation({
      backend: sqlite,
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
      suites: ["lexical"],
    });
    lexicalBaseline = scoreRetrievalSuite(
      "lexical",
      RETRIEVAL_REGRESSION_FIXTURE,
      runs.lexical.observations,
    ).metrics;
  } finally {
    await sqlite.close();
  }

  const rocksdb = await createRocksdbEvaluationBackend();
  try {
    const runs = await runRetrievalEvaluation({
      backend: rocksdb,
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
    });
    const artifact = createEvaluationArtifact({
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
      environment: testEnvironment(),
      backend: rocksdb.metadata,
      selectedSuites: ["exact", "lexical", "structural", "chunks", "hints"],
      runs,
      lexicalBaseline,
    });
    assert.equal(artifact.outcome, "passed");
    assert.deepEqual(
      Object.fromEntries(Object.entries(artifact.results).map(
        ([suite, result]) => [suite, result.scored.gate.status],
      )),
      { exact: "passed", lexical: "passed", structural: "passed", chunks: "passed", hints: "passed" },
    );
    const hintMetrics = artifact.results.hints.scored.metrics;
    assert.equal(hintMetrics.continuityMarkerRecall, 1);
    assert.equal(hintMetrics.candidateOnlyTermLeakageCount, 0);
    assert.equal(hintMetrics.staleRevealCount, 0);
    assert.equal(hintMetrics.activeBudgetViolationCount, 0);
    assert.equal(hintMetrics.repeatedSourceRevealCount, 0);
  } finally {
    await rocksdb.close();
  }
});

test("unsupported backend capabilities are recorded rather than silently approximated", async () => {
  const backend = createSqliteEvaluationBackend();
  try {
    const runs = await runRetrievalEvaluation({
      backend,
      fixture: RETRIEVAL_REGRESSION_FIXTURE,
      suites: ["chunks", "hints"],
    });
    assert.equal(runs.chunks.status, "unsupported");
    assert.equal(runs.hints.status, "unsupported");
  } finally {
    await backend.close();
  }
});

test("performance corpus and measurements are deterministic and machine-validatable", async () => {
  const first = [...generatePerformanceDocuments({ count: 10, seed: 7 })];
  const second = [...generatePerformanceDocuments({ count: 10, seed: 7 })];
  assert.deepEqual(first, second);
  assert.equal(first.length, 10);
  assert.match(PERFORMANCE_CORPUS_PLAN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);

  const sized = [...generatePerformanceDocuments({ count: 10_000, seed: 7 })];
  assert.equal(Buffer.byteLength(sized[999].text), 10 * 1024);
  assert.equal(Buffer.byteLength(sized[9_999].text), 1024 * 1024);
  assert.equal(sized[9_999].kind, "tool-result");

  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  const measurement = await measureOperation(async () => {}, { samples: 3, warmup: 1 });
  assert.equal(measurement.sampleCount, 3);
  assert.ok(measurement.summary.p95 >= 0);

  const artifact = createPerformanceArtifact({
    environment: testEnvironment(),
    backend: { id: "oracle", version: "1" },
    scale: 10_000,
    scenarios: { preflight: measurement },
    notes: ["fixture measurement"],
  });
  assert.equal(validatePerformanceArtifact(artifact), artifact);
  const modified = structuredClone(artifact);
  modified.scenarios.preflight.summary.p95 += 1;
  assert.throws(() => validatePerformanceArtifact(modified), /summary|artifact hash/);
});

test("live environment collector supplies required release metadata", () => {
  const environment = collectEvaluationEnvironment({ now: new Date("2026-07-16T12:00:00.000Z") });
  assert.equal(environment.capturedAt, "2026-07-16T12:00:00.000Z");
  assert.match(environment.node.version, /^v\d+/);
  assert.match(environment.dependencyLockSha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(environment.cpu.count > 0);
  assert.ok(environment.filesystem.totalBytes > 0);
});

test("CLI validate-only emits a validated JSON artifact and concise summary", () => {
  const result = spawnSync(process.execPath, ["eval/retrieval/cli.js", "--validate-only"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(result.stdout);
  validateRetrievalArtifact(artifact, RETRIEVAL_REGRESSION_FIXTURE);
  assert.match(result.stderr, /retrieval fixtures valid/);
});
