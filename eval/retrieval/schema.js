import { createHash } from "node:crypto";

export const RETRIEVAL_FIXTURE_SCHEMA_VERSION = 1;
export const RETRIEVAL_ARTIFACT_SCHEMA_VERSION = 1;
export const RETRIEVAL_BACKEND_API_VERSION = 1;

export const RETRIEVAL_SUITES = Object.freeze([
  "exact",
  "lexical",
  "structural",
  "chunks",
  "hints",
]);

export const EXPOSURE_STATES = Object.freeze(["untouched", "regression"]);

const FIXTURE_KEYS = new Set([
  "schemaVersion",
  "fixtureId",
  "description",
  "seed",
  "exposure",
  "chunking",
  "documents",
  "suites",
]);

const DOCUMENT_KEYS = new Set([
  "id",
  "sessionId",
  "project",
  "kind",
  "createdAt",
  "text",
  "metadata",
  "structuralMessages",
]);

const STRUCTURAL_MESSAGE_KEYS = new Set([
  "messageKey",
  "role",
  "text",
  "questionScore",
  "requestScore",
  "correctionScore",
  "answerScore",
]);

const STRUCTURAL_RELATIONS = new Set([
  "latest-question",
  "latest-request",
  "latest-correction",
  "latest-answer",
]);

const SCOPES = new Set(["session", "project", "all"]);
const HINT_DISCLOSURES = new Set(["historical-snippet", "continuity-marker"]);
const HINT_NEGATIVE_TYPES = new Set([
  "already-visible",
  "common-word",
  "correction",
  "current-state",
  "general-knowledge",
  "incidental-exact",
  "active-budget",
  "repeated-source",
  "stale-source",
  "weak-bm25",
]);

const COMMON_CASE_KEYS = new Set(["id", "exposure", "query", "scope", "limit"]);

const CASE_KEYS = Object.freeze({
  exact: new Set([...COMMON_CASE_KEYS, "relevantDocumentIds", "anchorType"]),
  lexical: new Set([...COMMON_CASE_KEYS, "relevantDocumentIds"]),
  structural: new Set([
    ...COMMON_CASE_KEYS,
    "relation",
    "relevantLocations",
  ]),
  chunks: new Set([
    ...COMMON_CASE_KEYS,
    "relevantWindow",
    "neighbors",
    "maxTokens",
  ]),
  hints: new Set([
    "id",
    "exposure",
    "messageKey",
    "message",
    "expected",
    "expectedDisclosure",
    "negativeType",
    "relevantDocumentIds",
    "visibleSourceKeys",
    "hintBudgetTokens",
    "candidateOnlyTerms",
    "sessionId",
    "sessionIds",
    "epochId",
    "activeMessageKeys",
    "activeHintBudgetTokens",
    "now",
    "hintSourceCooldownMs",
    "ephemeralAutoRetrievalDays",
    "conversationAutoRetrievalDays",
    "derivedAutoRetrievalDays",
    "rotationSourceCaseId",
    "reason",
  ]),
});

export const RETRIEVAL_SCHEMA_DESCRIPTOR = Object.freeze({
  fixtureSchemaVersion: RETRIEVAL_FIXTURE_SCHEMA_VERSION,
  artifactSchemaVersion: RETRIEVAL_ARTIFACT_SCHEMA_VERSION,
  backendApiVersion: RETRIEVAL_BACKEND_API_VERSION,
  suites: RETRIEVAL_SUITES,
  exposureStates: EXPOSURE_STATES,
  resultKinds: ["retrieval-evaluation", "retrieval-fixture-validation"],
  hintDisclosures: [...HINT_DISCLOSURES],
  hintNegativeTypes: [...HINT_NEGATIVE_TYPES],
  hintRuntimePolicyFields: [
    "sessionId",
    "sessionIds",
    "epochId",
    "activeMessageKeys",
    "activeHintBudgetTokens",
    "now",
    "hintSourceCooldownMs",
    "ephemeralAutoRetrievalDays",
    "conversationAutoRetrievalDays",
    "derivedAutoRetrievalDays",
  ],
  metrics: {
    exact: ["recallAt3", "meanReciprocalRank"],
    lexical: ["recallAt3", "meanReciprocalRank"],
    structural: ["resolutionAccuracy"],
    chunks: [
      "correctWindowRate",
      "canonicalByteAccuracy",
      "meanReturnedTokens",
      "tokenBudgetViolationCount",
    ],
    hints: [
      "historicalNeedRecall",
      "continuityMarkerRecall",
      "negativeFalsePositiveRate",
      "maxOneViolationCount",
      "budgetViolationCount",
      "activeBudgetViolationCount",
      "frozenByteMismatchCount",
      "candidateOnlyTermLeakageCount",
      "staleRevealCount",
      "repeatedSourceRevealCount",
      "unsafeArchivedToolHintCount",
    ],
  },
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashJson(value) {
  return sha256(canonicalJson(value));
}

export const RETRIEVAL_SCHEMA_FINGERPRINT = hashJson(RETRIEVAL_SCHEMA_DESCRIPTOR);

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
}

function assertExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed by the fixture schema");
  }
}

function assertString(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
}

function assertStringArray(value, path, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(path, `must be a${allowEmpty ? "n" : " non-empty"} array`);
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    assertString(entry, `${path}[${index}]`);
    if (seen.has(entry)) fail(`${path}[${index}]`, "must not duplicate an earlier value");
    seen.add(entry);
  });
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(path, "must be a positive integer");
}

function assertExposure(value, path) {
  if (!EXPOSURE_STATES.includes(value)) {
    fail(path, `must be one of ${EXPOSURE_STATES.join(", ")}`);
  }
}

function utf8Offset(text, codeUnitOffset) {
  return Buffer.byteLength(text.slice(0, codeUnitOffset), "utf8");
}

export function locateUtf8Evidence(text, evidence) {
  const codeUnitStart = text.indexOf(evidence);
  if (codeUnitStart < 0) throw new TypeError("evidence must occur in canonical document text");
  if (text.indexOf(evidence, codeUnitStart + 1) >= 0) {
    throw new TypeError("evidence must occur exactly once in canonical document text");
  }
  const startByte = utf8Offset(text, codeUnitStart);
  return Object.freeze({
    evidence,
    startByte,
    endByte: startByte + Buffer.byteLength(evidence, "utf8"),
  });
}

function validateDocument(document, index, ids) {
  const path = `fixture.documents[${index}]`;
  assertObject(document, path);
  assertExactKeys(document, DOCUMENT_KEYS, path);
  for (const key of ["id", "sessionId", "project", "kind", "text"]) {
    assertString(document[key], `${path}.${key}`);
  }
  if (!Number.isSafeInteger(document.createdAt) || document.createdAt < 0) {
    fail(`${path}.createdAt`, "must be a non-negative integer");
  }
  if (ids.has(document.id)) fail(`${path}.id`, "must be unique");
  ids.add(document.id);
  if (document.metadata !== undefined) assertObject(document.metadata, `${path}.metadata`);
  if (document.structuralMessages !== undefined) {
    if (!Array.isArray(document.structuralMessages) || document.structuralMessages.length === 0) {
      fail(`${path}.structuralMessages`, "must be a non-empty array when present");
    }
    const messageKeys = new Set();
    document.structuralMessages.forEach((message, messageIndex) => {
      const messagePath = `${path}.structuralMessages[${messageIndex}]`;
      assertObject(message, messagePath);
      assertExactKeys(message, STRUCTURAL_MESSAGE_KEYS, messagePath);
      for (const key of ["messageKey", "role", "text"]) assertString(message[key], `${messagePath}.${key}`);
      if (messageKeys.has(message.messageKey)) fail(`${messagePath}.messageKey`, "must be unique within a document");
      messageKeys.add(message.messageKey);
      for (const field of ["questionScore", "requestScore", "correctionScore", "answerScore"]) {
        if (!Number.isSafeInteger(message[field]) || message[field] < 0 || message[field] > 100) {
          fail(`${messagePath}.${field}`, "must be an integer from 0 through 100");
        }
      }
    });
  }
}

function validateSearchCase(suite, evaluationCase, index, fixture, documentIds, caseIds) {
  const path = `fixture.suites.${suite}[${index}]`;
  assertObject(evaluationCase, path);
  assertExactKeys(evaluationCase, CASE_KEYS[suite], path);
  assertString(evaluationCase.id, `${path}.id`);
  const expectedId = `${suite}-${String(index + 1).padStart(3, "0")}`;
  if (evaluationCase.id !== expectedId) fail(`${path}.id`, `must be ${expectedId} to freeze ordering`);
  if (caseIds.has(evaluationCase.id)) fail(`${path}.id`, "must be globally unique");
  caseIds.add(evaluationCase.id);
  assertExposure(evaluationCase.exposure, `${path}.exposure`);
  if (evaluationCase.exposure !== fixture.exposure) fail(`${path}.exposure`, "must match fixture exposure");

  if (suite === "hints") {
    for (const key of ["messageKey", "message", "expected", "reason"]) {
      assertString(evaluationCase[key], `${path}.${key}`);
    }
    if (!["reveal", "suppress"].includes(evaluationCase.expected)) {
      fail(`${path}.expected`, "must be reveal or suppress");
    }
    if (evaluationCase.expected === "reveal") {
      if (!HINT_DISCLOSURES.has(evaluationCase.expectedDisclosure)) {
        fail(`${path}.expectedDisclosure`, "must name historical-snippet or continuity-marker for a reveal case");
      }
      if (evaluationCase.negativeType !== undefined) {
        fail(`${path}.negativeType`, "is only allowed for suppress cases");
      }
    } else {
      if (!HINT_NEGATIVE_TYPES.has(evaluationCase.negativeType)) {
        fail(`${path}.negativeType`, "must classify the suppress case with a supported hard-negative type");
      }
      if (evaluationCase.expectedDisclosure !== undefined) {
        fail(`${path}.expectedDisclosure`, "is only allowed for reveal cases");
      }
    }
    assertStringArray(evaluationCase.relevantDocumentIds, `${path}.relevantDocumentIds`, {
      allowEmpty: evaluationCase.expected === "suppress",
    });
    assertStringArray(evaluationCase.visibleSourceKeys, `${path}.visibleSourceKeys`, { allowEmpty: true });
    assertPositiveInteger(evaluationCase.hintBudgetTokens, `${path}.hintBudgetTokens`);
    if (evaluationCase.candidateOnlyTerms !== undefined) {
      assertStringArray(evaluationCase.candidateOnlyTerms, `${path}.candidateOnlyTerms`);
    }
    for (const key of ["sessionId", "epochId"]) assertString(evaluationCase[key], `${path}.${key}`);
    assertStringArray(evaluationCase.sessionIds, `${path}.sessionIds`);
    if (!evaluationCase.sessionIds.includes(evaluationCase.sessionId)) {
      fail(`${path}.sessionIds`, "must include sessionId");
    }
    assertStringArray(evaluationCase.activeMessageKeys, `${path}.activeMessageKeys`);
    if (!evaluationCase.activeMessageKeys.includes(evaluationCase.messageKey)) {
      fail(`${path}.activeMessageKeys`, "must include messageKey");
    }
    for (const key of [
      "activeHintBudgetTokens",
      "now",
      "hintSourceCooldownMs",
      "ephemeralAutoRetrievalDays",
      "conversationAutoRetrievalDays",
      "derivedAutoRetrievalDays",
    ]) {
      if (!Number.isSafeInteger(evaluationCase[key]) || evaluationCase[key] < 0) {
        fail(`${path}.${key}`, "must be a non-negative safe integer");
      }
    }
    if (evaluationCase.rotationSourceCaseId !== undefined) {
      assertString(evaluationCase.rotationSourceCaseId, `${path}.rotationSourceCaseId`);
    }
    for (const id of evaluationCase.relevantDocumentIds) {
      if (!documentIds.has(id)) fail(`${path}.relevantDocumentIds`, `references unknown document ${id}`);
    }
    return;
  }

  assertString(evaluationCase.query, `${path}.query`);
  assertString(evaluationCase.scope, `${path}.scope`);
  if (!SCOPES.has(evaluationCase.scope)) fail(`${path}.scope`, "must be session, project, or all");
  assertPositiveInteger(evaluationCase.limit, `${path}.limit`);

  if (suite === "exact" || suite === "lexical") {
    assertStringArray(evaluationCase.relevantDocumentIds, `${path}.relevantDocumentIds`);
    for (const id of evaluationCase.relevantDocumentIds) {
      if (!documentIds.has(id)) fail(`${path}.relevantDocumentIds`, `references unknown document ${id}`);
    }
    if (suite === "exact") assertString(evaluationCase.anchorType, `${path}.anchorType`);
  }

  if (suite === "structural") {
    assertString(evaluationCase.relation, `${path}.relation`);
    if (!STRUCTURAL_RELATIONS.has(evaluationCase.relation)) {
      fail(`${path}.relation`, "must name a supported deterministic structural relation");
    }
    if (!Array.isArray(evaluationCase.relevantLocations) || evaluationCase.relevantLocations.length === 0) {
      fail(`${path}.relevantLocations`, "must be a non-empty array");
    }
    evaluationCase.relevantLocations.forEach((location, locationIndex) => {
      const locationPath = `${path}.relevantLocations[${locationIndex}]`;
      assertObject(location, locationPath);
      assertExactKeys(location, new Set(["documentId", "messageKey"]), locationPath);
      assertString(location.documentId, `${locationPath}.documentId`);
      assertString(location.messageKey, `${locationPath}.messageKey`);
      if (!documentIds.has(location.documentId)) fail(locationPath, "references an unknown document");
      const document = fixture.documents.find(({ id }) => id === location.documentId);
      if (!document.structuralMessages?.some(({ messageKey }) => messageKey === location.messageKey)) {
        fail(locationPath, "references an unknown structural message");
      }
    });
  }

  if (suite === "chunks") {
    assertObject(evaluationCase.relevantWindow, `${path}.relevantWindow`);
    assertExactKeys(
      evaluationCase.relevantWindow,
      new Set(["documentId", "evidence", "startByte", "endByte"]),
      `${path}.relevantWindow`,
    );
    const { documentId, evidence, startByte, endByte } = evaluationCase.relevantWindow;
    const document = fixture.documents.find(({ id }) => id === documentId);
    if (!document) fail(`${path}.relevantWindow.documentId`, "references an unknown document");
    assertString(evidence, `${path}.relevantWindow.evidence`);
    const located = locateUtf8Evidence(document.text, evidence);
    if (located.startByte !== startByte || located.endByte !== endByte) {
      fail(`${path}.relevantWindow`, "byte coordinates do not match canonical evidence");
    }
    if (!Number.isSafeInteger(evaluationCase.neighbors) || evaluationCase.neighbors < 0) {
      fail(`${path}.neighbors`, "must be a non-negative integer");
    }
    assertPositiveInteger(evaluationCase.maxTokens, `${path}.maxTokens`);
  }
}

export function validateRetrievalFixture(fixture, { allowUntouched = true } = {}) {
  assertObject(fixture, "fixture");
  assertExactKeys(fixture, FIXTURE_KEYS, "fixture");
  if (fixture.schemaVersion !== RETRIEVAL_FIXTURE_SCHEMA_VERSION) {
    fail("fixture.schemaVersion", `must equal ${RETRIEVAL_FIXTURE_SCHEMA_VERSION}`);
  }
  for (const key of ["fixtureId", "description"]) assertString(fixture[key], `fixture.${key}`);
  assertPositiveInteger(fixture.seed, "fixture.seed");
  assertExposure(fixture.exposure, "fixture.exposure");
  if (!allowUntouched && fixture.exposure === "untouched") {
    fail("fixture.exposure", "cannot be evaluated until an explicit held-out exposure is authorized");
  }
  assertObject(fixture.chunking, "fixture.chunking");
  assertExactKeys(fixture.chunking, new Set(["targetBytes", "overlapBytes"]), "fixture.chunking");
  assertPositiveInteger(fixture.chunking.targetBytes, "fixture.chunking.targetBytes");
  if (!Number.isSafeInteger(fixture.chunking.overlapBytes) || fixture.chunking.overlapBytes < 0) {
    fail("fixture.chunking.overlapBytes", "must be a non-negative integer");
  }
  if (fixture.chunking.overlapBytes >= fixture.chunking.targetBytes) {
    fail("fixture.chunking.overlapBytes", "must be smaller than targetBytes");
  }
  if (!Array.isArray(fixture.documents) || fixture.documents.length === 0) {
    fail("fixture.documents", "must be a non-empty array");
  }
  const documentIds = new Set();
  fixture.documents.forEach((document, index) => validateDocument(document, index, documentIds));
  assertObject(fixture.suites, "fixture.suites");
  assertExactKeys(fixture.suites, new Set(RETRIEVAL_SUITES), "fixture.suites");
  const caseIds = new Set();
  for (const suite of RETRIEVAL_SUITES) {
    const cases = fixture.suites[suite];
    if (!Array.isArray(cases) || cases.length === 0) fail(`fixture.suites.${suite}`, "must be a non-empty array");
    cases.forEach((evaluationCase, index) =>
      validateSearchCase(suite, evaluationCase, index, fixture, documentIds, caseIds));
  }
  const hintCases = new Map(fixture.suites.hints.map((evaluationCase) => [evaluationCase.id, evaluationCase]));
  for (const evaluationCase of fixture.suites.hints) {
    if (evaluationCase.rotationSourceCaseId === undefined) continue;
    const source = hintCases.get(evaluationCase.rotationSourceCaseId);
    if (source === undefined || source.id >= evaluationCase.id) {
      fail(`fixture.suites.hints.${evaluationCase.id}.rotationSourceCaseId`, "must reference an earlier hint case");
    }
    if (source.messageKey !== evaluationCase.messageKey || source.message !== evaluationCase.message) {
      fail(`fixture.suites.hints.${evaluationCase.id}.rotationSourceCaseId`, "must preserve the source message key and bytes");
    }
  }
  return fixture;
}

export function hintRuntimePolicy(evaluationCase) {
  return Object.freeze({
    sessionId: evaluationCase.sessionId,
    sessionIds: Object.freeze([...evaluationCase.sessionIds]),
    epochId: evaluationCase.epochId,
    activeMessageKeys: Object.freeze([...evaluationCase.activeMessageKeys]),
    activeHintBudgetTokens: evaluationCase.activeHintBudgetTokens,
    now: evaluationCase.now,
    hintSourceCooldownMs: evaluationCase.hintSourceCooldownMs,
    ephemeralAutoRetrievalDays: evaluationCase.ephemeralAutoRetrievalDays,
    conversationAutoRetrievalDays: evaluationCase.conversationAutoRetrievalDays,
    derivedAutoRetrievalDays: evaluationCase.derivedAutoRetrievalDays,
  });
}

export function fixtureFingerprint(fixture) {
  validateRetrievalFixture(fixture);
  return hashJson(fixture);
}

export function fixtureManifest(fixture) {
  validateRetrievalFixture(fixture);
  return Object.freeze({
    fixtureId: fixture.fixtureId,
    schemaVersion: fixture.schemaVersion,
    schemaFingerprint: RETRIEVAL_SCHEMA_FINGERPRINT,
    fixtureFingerprint: hashJson(fixture),
    exposure: fixture.exposure,
    documentOrderHash: hashJson(fixture.documents.map(({ id }) => id)),
    documentContentHash: hashJson(fixture.documents),
    suites: Object.fromEntries(RETRIEVAL_SUITES.map((suite) => [suite, Object.freeze({
      caseOrderHash: hashJson(fixture.suites[suite].map(({ id }) => id)),
      annotationHash: hashJson(fixture.suites[suite]),
      caseCount: fixture.suites[suite].length,
    })])),
  });
}

export function authorizeFixtureEvaluation(fixture, { allowHeldout = false } = {}) {
  validateRetrievalFixture(fixture);
  if (fixture.exposure === "untouched" && !allowHeldout) {
    throw new Error(
      "Untouched held-out fixtures require allowHeldout=true for one recorded release-candidate run; "
      + "after inspection or tuning they must be reclassified as regression fixtures.",
    );
  }
  return fixture;
}
