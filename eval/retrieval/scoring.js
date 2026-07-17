import { RETRIEVAL_SUITES, hintRuntimePolicy } from "./schema.js";
import { estimateModelVisibleTokens } from "../../src/model-token-budget.js";
import { renderContinuityMarker } from "../../src/retrieval/continuity-policy.js";
import { oneLineJson } from "../../src/retrieval/render.js";

function roundMetric(value) {
  return Number(value.toFixed(12));
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertOrderedObservations(cases, observations, suite) {
  if (!Array.isArray(observations) || observations.length !== cases.length) {
    throw new TypeError(`${suite} observations must contain exactly ${cases.length} ordered cases`);
  }
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object" || observation.id !== cases[index].id) {
      throw new TypeError(`${suite} observation ${index} must have id ${cases[index].id}`);
    }
  });
}

function resultDocumentId(result) {
  return String(result?.documentId ?? result?.id ?? "");
}

function rankOfRelevant(results, relevantDocumentIds, limit) {
  const relevant = new Set(relevantDocumentIds);
  const rank = results.slice(0, limit).findIndex((result) => relevant.has(resultDocumentId(result)));
  return rank < 0 ? 0 : rank + 1;
}

function scoreRankedSuite(suite, cases, observations, { baseline } = {}) {
  const scoredCases = cases.map((evaluationCase, index) => {
    const observation = observations[index];
    if (!Array.isArray(observation.results)) {
      throw new TypeError(`${suite} observation ${evaluationCase.id}.results must be an array`);
    }
    const rank = rankOfRelevant(observation.results, evaluationCase.relevantDocumentIds, 3);
    return Object.freeze({
      id: evaluationCase.id,
      returnedDocumentIds: observation.results.map(resultDocumentId),
      relevantRankAt3: rank,
      recalledAt3: rank > 0,
      reciprocalRank: rank > 0 ? roundMetric(1 / rank) : 0,
    });
  });
  const metrics = Object.freeze({
    recallAt3: roundMetric(mean(scoredCases.map(({ recalledAt3 }) => Number(recalledAt3)))),
    meanReciprocalRank: roundMetric(mean(scoredCases.map(({ reciprocalRank }) => reciprocalRank))),
  });
  let gate;
  if (suite === "exact") {
    gate = Object.freeze({
      status: metrics.recallAt3 === 1 ? "passed" : "failed",
      requirement: "Exact-anchor Recall@3 must equal 1.",
    });
  } else if (baseline) {
    const validBaseline = Number.isFinite(baseline.recallAt3)
      && Number.isFinite(baseline.meanReciprocalRank);
    if (!validBaseline) throw new TypeError("lexical baseline must contain finite Recall@3 and reciprocal-rank metrics");
    const passed = metrics.recallAt3 >= baseline.recallAt3
      && metrics.meanReciprocalRank >= baseline.meanReciprocalRank;
    gate = Object.freeze({
      status: passed ? "passed" : "failed",
      requirement: "Lexical Recall@3 and reciprocal rank must be no worse than the SQLite baseline.",
      baseline: Object.freeze({
        recallAt3: baseline.recallAt3,
        meanReciprocalRank: baseline.meanReciprocalRank,
      }),
    });
  } else {
    gate = Object.freeze({
      status: "not-evaluated",
      requirement: "A SQLite baseline artifact is required for lexical comparison.",
    });
  }
  return Object.freeze({ status: "completed", cases: Object.freeze(scoredCases), metrics, gate });
}

function scoreStructural(cases, observations) {
  const scoredCases = cases.map((evaluationCase, index) => {
    const observation = observations[index];
    if (!Array.isArray(observation.results)) {
      throw new TypeError(`structural observation ${evaluationCase.id}.results must be an array`);
    }
    const expected = new Set(evaluationCase.relevantLocations.map(
      ({ documentId, messageKey }) => `${documentId}\u0000${messageKey}`,
    ));
    const top = observation.results[0];
    const topDocumentId = resultDocumentId(top);
    const topMessageKey = String(top?.messageKey ?? top?.structural?.messageKey ?? "");
    const resolved = expected.has(`${topDocumentId}\u0000${topMessageKey}`);
    return Object.freeze({
      id: evaluationCase.id,
      topDocumentId,
      topMessageKey,
      resolved,
      resultCount: observation.results.length,
    });
  });
  const metrics = Object.freeze({
    resolutionAccuracy: roundMetric(mean(scoredCases.map(({ resolved }) => Number(resolved)))),
  });
  return Object.freeze({
    status: "completed",
    cases: Object.freeze(scoredCases),
    metrics,
    gate: Object.freeze({
      status: metrics.resolutionAccuracy === 1 ? "passed" : "failed",
      requirement: "Supported structural relations must resolve with 100 percent accuracy.",
    }),
  });
}

function canonicalSlice(document, startByte, endByte) {
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)) return undefined;
  if (startByte < 0 || endByte < startByte) return undefined;
  const bytes = Buffer.from(document.text, "utf8");
  if (endByte > bytes.length) return undefined;
  return bytes.subarray(startByte, endByte).toString("utf8");
}

function scoreChunks(cases, observations, fixture) {
  const documents = new Map(fixture.documents.map((document) => [document.id, document]));
  const scoredCases = cases.map((evaluationCase, index) => {
    const recall = observations[index].recall;
    if (!recall || typeof recall !== "object") {
      throw new TypeError(`chunks observation ${evaluationCase.id}.recall must be an object`);
    }
    const expected = evaluationCase.relevantWindow;
    const document = documents.get(expected.documentId);
    const returnedDocumentId = resultDocumentId(recall);
    const returnedStartByte = Number(recall.startByte);
    const returnedEndByte = Number(recall.endByte);
    const canonicalText = String(recall.canonicalText ?? recall.text ?? "");
    const expectedCanonicalText = returnedDocumentId === expected.documentId
      ? canonicalSlice(document, returnedStartByte, returnedEndByte)
      : undefined;
    const coversExpectedRange = returnedDocumentId === expected.documentId
      && Number.isSafeInteger(returnedStartByte)
      && Number.isSafeInteger(returnedEndByte)
      && returnedStartByte <= expected.startByte
      && returnedEndByte >= expected.endByte;
    const modelVisibleText = String(recall.renderedText ?? "");
    const containsEvidence = modelVisibleText.includes(expected.evidence);
    const canonicalContainsEvidence = canonicalText.includes(expected.evidence);
    const canonicalBytesExact = expectedCanonicalText !== undefined
      && Buffer.from(canonicalText).equals(Buffer.from(expectedCanonicalText));
    // Backend token counts are diagnostic claims, not evaluation evidence. The
    // scorer accounts for the exact bytes that would enter the model context.
    const returnedTokens = estimateModelVisibleTokens(modelVisibleText);
    return Object.freeze({
      id: evaluationCase.id,
      status: String(recall.status ?? "resolved"),
      returnedDocumentId,
      returnedStartByte,
      returnedEndByte,
      coversExpectedRange,
      containsEvidence,
      canonicalContainsEvidence,
      correctWindow: coversExpectedRange && containsEvidence,
      canonicalBytesExact,
      returnedTokens,
      withinTokenBudget: returnedTokens <= evaluationCase.maxTokens,
    });
  });
  const metrics = Object.freeze({
    correctWindowRate: roundMetric(mean(scoredCases.map(({ correctWindow }) => Number(correctWindow)))),
    canonicalByteAccuracy: roundMetric(mean(scoredCases.map(({ canonicalBytesExact }) => Number(canonicalBytesExact)))),
    meanReturnedTokens: roundMetric(mean(scoredCases.map(({ returnedTokens }) => returnedTokens))),
    tokenBudgetViolationCount: scoredCases.filter(({ withinTokenBudget }) => !withinTokenBudget).length,
  });
  const passed = metrics.correctWindowRate >= 0.95
    && metrics.canonicalByteAccuracy === 1
    && metrics.tokenBudgetViolationCount === 0;
  return Object.freeze({
    status: "completed",
    cases: Object.freeze(scoredCases),
    metrics,
    gate: Object.freeze({
      status: passed ? "passed" : "failed",
      requirement: "At least 95 percent of chunk cases must target the correct window with exact canonical bytes and no token-budget violations.",
    }),
  });
}

function normalizeHintResponse(response, path) {
  if (!response || typeof response !== "object") throw new TypeError(`${path} must be an object`);
  if (!Array.isArray(response.hints)) throw new TypeError(`${path}.hints must be an array`);
  return {
    hints: response.hints,
    modelVisibleText: String(response.modelVisibleText ?? ""),
  };
}

function visibleDisclosureType(modelVisibleText) {
  if (modelVisibleText.startsWith("\n\n[PRIOR SHARED CONTEXT MARKER]\n")) return "continuity-marker";
  if (modelVisibleText.startsWith("\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]\n")) {
    return "historical-snippet";
  }
  return modelVisibleText.length === 0 ? null : "unknown";
}

const CONTINUITY_MARKER_PREFIX = [
  "",
  "",
  "[PRIOR SHARED CONTEXT MARKER]",
  "Archived discussion may exist for these exact phrases from the current user message:",
  "",
].join("\n");

const CONTINUITY_MARKER_SUFFIX = [
  "",
  "Search those phrases before relying on prior shared meaning; this marker is not historical evidence.",
].join("\n");

const HISTORICAL_SNIPPET_PREFIX = "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]\nArchived excerpt from ";
const HISTORICAL_SNIPPET_SEPARATOR = " as JSON data: verify current state; ";
const COMPACT_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function validContinuityMarker(modelVisibleText, message) {
  if (!modelVisibleText.startsWith(CONTINUITY_MARKER_PREFIX)
    || !modelVisibleText.endsWith(CONTINUITY_MARKER_SUFFIX)) return false;
  const bulletText = modelVisibleText.slice(
    CONTINUITY_MARKER_PREFIX.length,
    modelVisibleText.length - CONTINUITY_MARKER_SUFFIX.length,
  );
  if (bulletText.length === 0) return false;
  const anchors = bulletText.split("\n").map((line) => line.startsWith("- ") ? line.slice(2) : "");
  if (anchors.some((anchor) => anchor.length === 0) || new Set(anchors).size !== anchors.length) return false;
  if (anchors.some((anchor) => !message.includes(anchor))) return false;
  try {
    return renderContinuityMarker(message, anchors) === modelVisibleText;
  } catch {
    return false;
  }
}

function compactSourceDate(createdAt) {
  try {
    return new Date(createdAt).toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

function validHistoricalSnippet(modelVisibleText, document) {
  if (!document || !modelVisibleText.startsWith(HISTORICAL_SNIPPET_PREFIX)) return false;
  const payload = modelVisibleText.slice(HISTORICAL_SNIPPET_PREFIX.length);
  const separatorIndex = payload.indexOf(HISTORICAL_SNIPPET_SEPARATOR);
  if (separatorIndex < 0) return false;
  const sourceDate = payload.slice(0, separatorIndex);
  if (!COMPACT_DATE.test(sourceDate) || sourceDate !== compactSourceDate(document.createdAt)) return false;
  const encodedExcerpt = payload.slice(separatorIndex + HISTORICAL_SNIPPET_SEPARATOR.length);
  let excerpt;
  try {
    excerpt = JSON.parse(encodedExcerpt);
  } catch {
    return false;
  }
  return typeof excerpt === "string"
    && excerpt.length > 0
    && oneLineJson(excerpt) === encodedExcerpt
    && document.text.includes(excerpt);
}

function hintTextConsistent(response) {
  if (response.modelVisibleText.length === 0) return response.hints.length === 0;
  return response.hints.length === 1
    && String(response.hints[0]?.text ?? "") === response.modelVisibleText;
}

function validateVisibleHint(evaluationCase, response, documents, disclosureType) {
  if (response.modelVisibleText.length === 0 || response.hints.length !== 1) {
    return { valid: false, document: undefined };
  }
  const document = documents.get(resultDocumentId(response.hints[0]));
  if (!document) return { valid: false, document: undefined };
  if (disclosureType === "continuity-marker") {
    return {
      valid: validContinuityMarker(response.modelVisibleText, evaluationCase.message),
      document,
    };
  }
  if (disclosureType === "historical-snippet") {
    return {
      valid: validHistoricalSnippet(response.modelVisibleText, document),
      document,
    };
  }
  return { valid: false, document };
}

function assertRuntimePolicyObservation(evaluationCase, observation) {
  const expected = hintRuntimePolicy(evaluationCase);
  if (JSON.stringify(observation.runtimePolicy) !== JSON.stringify(expected)) {
    throw new TypeError(
      `hints observation ${evaluationCase.id}.runtimePolicy must exactly match the annotated preflight inputs`,
    );
  }
  return expected;
}

function scoreHints(cases, observations, fixture) {
  const documents = new Map(fixture.documents.map((document) => [document.id, document]));
  const scoredCases = cases.map((evaluationCase, index) => {
    const observation = observations[index];
    const runtimePolicy = assertRuntimePolicyObservation(evaluationCase, observation);
    const first = normalizeHintResponse(observation.first, `hints observation ${evaluationCase.id}.first`);
    const reconstruction = normalizeHintResponse(
      observation.reconstruction,
      `hints observation ${evaluationCase.id}.reconstruction`,
    );
    const expectedDocuments = new Set(evaluationCase.relevantDocumentIds);
    const visible = first.modelVisibleText.length > 0;
    const disclosureType = visibleDisclosureType(first.modelVisibleText);
    const firstHintTextConsistent = hintTextConsistent(first);
    const reconstructionHintTextConsistent = hintTextConsistent(reconstruction);
    const responseHintTextConsistent = firstHintTextConsistent && reconstructionHintTextConsistent;
    const visibleValidation = validateVisibleHint(evaluationCase, first, documents, disclosureType);
    const relevantDocument = first.hints.length === 1
      && expectedDocuments.has(resultDocumentId(first.hints[0]));
    const useful = visible
      && responseHintTextConsistent
      && visibleValidation.valid
      && relevantDocument;
    const disclosureCorrect = evaluationCase.expected === "suppress"
      ? !visible && responseHintTextConsistent
      : disclosureType === evaluationCase.expectedDisclosure
        && visibleValidation.valid
        && responseHintTextConsistent;
    const leakedCandidateOnlyTerms = (evaluationCase.candidateOnlyTerms ?? [])
      .filter((term) => first.modelVisibleText.includes(term));
    // This includes every separator and header byte. Per-hint tokenCount values
    // cannot reduce or omit model-visible overhead in the evaluation.
    const returnedTokens = estimateModelVisibleTokens(first.modelVisibleText);
    return Object.freeze({
      id: evaluationCase.id,
      expected: evaluationCase.expected,
      expectedDisclosure: evaluationCase.expectedDisclosure ?? null,
      negativeType: evaluationCase.negativeType ?? null,
      useful,
      visible,
      disclosureType,
      disclosureCorrect,
      hintCount: first.hints.length,
      returnedDocumentIds: first.hints.map(resultDocumentId),
      returnedTokens,
      withinBudget: returnedTokens <= evaluationCase.hintBudgetTokens,
      frozenBytesEqual: first.modelVisibleText === reconstruction.modelVisibleText,
      visibleBytesValid: !visible || visibleValidation.valid,
      hintTextConsistent: responseHintTextConsistent,
      safeArchivedData: first.hints.every((hint) => {
        const document = documents.get(resultDocumentId(hint));
        if (!document) return false;
        if (document.kind !== "tool-result") return true;
        return first.hints.length === 1
          && disclosureType === "historical-snippet"
          && visibleValidation.valid
          && responseHintTextConsistent;
      }),
      leakedCandidateOnlyTerms: Object.freeze(leakedCandidateOnlyTerms),
      activeHintBudgetTokens: runtimePolicy.activeHintBudgetTokens,
    });
  });
  const positives = scoredCases.filter(({ expected }) => expected === "reveal");
  const negatives = scoredCases.filter(({ expected }) => expected === "suppress");
  const markerPositives = scoredCases.filter(
    ({ expectedDisclosure }) => expectedDisclosure === "continuity-marker",
  );
  const metrics = Object.freeze({
    historicalNeedRecall: roundMetric(mean(positives.map(
      ({ useful, disclosureCorrect }) => Number(useful && disclosureCorrect),
    ))),
    continuityMarkerRecall: roundMetric(mean(markerPositives.map(
      ({ useful, disclosureCorrect }) => Number(useful && disclosureCorrect),
    ))),
    negativeFalsePositiveRate: roundMetric(mean(negatives.map(({ visible }) => Number(visible)))),
    maxOneViolationCount: scoredCases.filter(({ hintCount }) => hintCount > 1).length,
    budgetViolationCount: scoredCases.filter(({ withinBudget }) => !withinBudget).length,
    activeBudgetViolationCount: scoredCases.filter(
      ({ negativeType, visible }) => negativeType === "active-budget" && visible,
    ).length,
    frozenByteMismatchCount: scoredCases.filter(({ frozenBytesEqual }) => !frozenBytesEqual).length,
    candidateOnlyTermLeakageCount: scoredCases
      .reduce((total, scoredCase) => total + scoredCase.leakedCandidateOnlyTerms.length, 0),
    staleRevealCount: scoredCases.filter(
      ({ negativeType, visible }) => negativeType === "stale-source" && visible,
    ).length,
    repeatedSourceRevealCount: scoredCases.filter(
      ({ negativeType, visible }) => negativeType === "repeated-source" && visible,
    ).length,
    unsafeArchivedToolHintCount: scoredCases.filter(({ safeArchivedData }) => !safeArchivedData).length,
  });
  const passed = metrics.historicalNeedRecall >= 0.9
    && metrics.continuityMarkerRecall >= 0.9
    && metrics.negativeFalsePositiveRate <= 0.05
    && metrics.maxOneViolationCount === 0
    && metrics.budgetViolationCount === 0
    && metrics.activeBudgetViolationCount === 0
    && metrics.frozenByteMismatchCount === 0
    && metrics.candidateOnlyTermLeakageCount === 0
    && metrics.staleRevealCount === 0
    && metrics.repeatedSourceRevealCount === 0
    && metrics.unsafeArchivedToolHintCount === 0
    && scoredCases.every(({ visibleBytesValid, hintTextConsistent }) => visibleBytesValid && hintTextConsistent);
  return Object.freeze({
    status: "completed",
    cases: Object.freeze(scoredCases),
    metrics,
    gate: Object.freeze({
      status: passed ? "passed" : "failed",
      requirement: "Automatic hints must use canonical marker or quoted-snippet bytes with consistent hint text, meet historical and continuity-marker recall, and have zero stale, repeated-source, active-budget, candidate-term, frozen-byte, cardinality, or archived-tool safety violations.",
    }),
  });
}

export function unsupportedSuite(reason) {
  return Object.freeze({
    status: "unsupported",
    reason,
    cases: Object.freeze([]),
    metrics: Object.freeze({}),
    gate: Object.freeze({ status: "not-evaluated", requirement: reason }),
  });
}

export function scoreRetrievalSuite(suite, fixture, observations, options = {}) {
  if (!RETRIEVAL_SUITES.includes(suite)) throw new TypeError(`unknown retrieval suite: ${String(suite)}`);
  const cases = fixture.suites[suite];
  assertOrderedObservations(cases, observations, suite);
  if (suite === "exact" || suite === "lexical") {
    return scoreRankedSuite(suite, cases, observations, options);
  }
  if (suite === "structural") return scoreStructural(cases, observations);
  if (suite === "chunks") return scoreChunks(cases, observations, fixture);
  return scoreHints(cases, observations, fixture);
}

export function evaluationOutcome(scoredSuites) {
  const suiteValues = Object.values(scoredSuites);
  if (suiteValues.some(({ gate }) => gate.status === "failed")) return "failed";
  if (suiteValues.some(({ gate }) => gate.status === "not-evaluated")) return "partial";
  return "passed";
}
