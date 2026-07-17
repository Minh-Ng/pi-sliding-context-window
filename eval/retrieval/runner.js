import { RETRIEVAL_BACKEND_API_VERSION, RETRIEVAL_SUITES } from "./schema.js";

function assertBackend(backend) {
  if (!backend || typeof backend !== "object") throw new TypeError("evaluation backend must be an object");
  if (!backend.metadata || typeof backend.metadata !== "object") {
    throw new TypeError("evaluation backend must expose metadata");
  }
  if (backend.metadata.apiVersion !== RETRIEVAL_BACKEND_API_VERSION) {
    throw new Error(
      `evaluation backend API version ${String(backend.metadata.apiVersion)} is incompatible with ${RETRIEVAL_BACKEND_API_VERSION}`,
    );
  }
  if (!Array.isArray(backend.metadata.capabilities)) {
    throw new TypeError("evaluation backend metadata.capabilities must be an array");
  }
  if (typeof backend.prepare !== "function") throw new TypeError("evaluation backend must implement prepare(fixture)");
  if (typeof backend.search !== "function") throw new TypeError("evaluation backend must implement search(request)");
}

function normalizeSearchResults(response) {
  const results = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(results)) throw new TypeError("backend search response must be an array or contain results[]");
  return results.map((result, index) => {
    const locator = result?.locator ?? null;
    if (locator !== null && typeof locator !== "string") {
      throw new TypeError(`backend search result ${index}.locator must be an opaque string or null`);
    }
    return {
      documentId: String(result?.documentId ?? result?.id ?? ""),
      messageKey: result?.messageKey ?? result?.structural?.messageKey,
      score: Number.isFinite(result?.score) ? Number(result.score) : null,
      matchType: result?.matchType === undefined ? null : String(result.matchType),
      locator,
    };
  });
}

function safeCoordinate(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : -1;
}

function normalizeRecall(response) {
  if (!response || typeof response !== "object") throw new TypeError("backend recall response must be an object");
  return {
    status: String(response.status ?? "resolved"),
    documentId: String(response.documentId ?? response.id ?? ""),
    startByte: safeCoordinate(response.startByte),
    endByte: safeCoordinate(response.endByte),
    canonicalText: String(response.canonicalText ?? response.text ?? ""),
    renderedText: response.renderedText === undefined ? undefined : String(response.renderedText),
    returnedTokens: Number.isFinite(response.returnedTokens) ? Number(response.returnedTokens) : undefined,
  };
}

function normalizeHintResponse(response) {
  if (!response || typeof response !== "object" || !Array.isArray(response.hints)) {
    throw new TypeError("backend preflight response must contain hints[]");
  }
  const hints = response.hints.map((hint, index) => {
    const locator = hint?.locator ?? null;
    if (locator !== null && typeof locator !== "string") {
      throw new TypeError(`backend hint ${index}.locator must be an opaque string or null`);
    }
    return {
      documentId: String(hint?.documentId ?? hint?.id ?? ""),
      locator,
      text: String(hint?.text ?? ""),
      tokenCount: Number.isFinite(hint?.tokenCount) ? Number(hint.tokenCount) : undefined,
      sourceKind: hint?.sourceKind === undefined ? undefined : String(hint.sourceKind),
      archivedDataDelimited: hint?.archivedDataDelimited === true,
    };
  });
  return {
    modelVisibleText: String(response.modelVisibleText ?? ""),
    hints,
  };
}

function searchRequest(suite, evaluationCase) {
  return {
    mode: suite === "chunks" ? "lexical" : suite,
    query: evaluationCase.query,
    relation: evaluationCase.relation ?? null,
    scope: evaluationCase.scope,
    limit: evaluationCase.limit,
    sessionId: "session-main",
    sessionIds: ["session-main"],
    project: "/fixture/project",
  };
}

function hintRequest(evaluationCase) {
  return {
    messageKey: evaluationCase.messageKey,
    message: evaluationCase.message,
    scope: "session",
    sessionId: evaluationCase.sessionId,
    sessionIds: [...evaluationCase.sessionIds],
    project: "/fixture/project",
    excludeVisibleSourceKeys: [...evaluationCase.visibleSourceKeys],
    hintBudgetTokens: evaluationCase.hintBudgetTokens,
    epochId: evaluationCase.epochId,
    activeMessageKeys: [...evaluationCase.activeMessageKeys],
    activeHintBudgetTokens: evaluationCase.activeHintBudgetTokens,
    now: evaluationCase.now,
    hintSourceCooldownMs: evaluationCase.hintSourceCooldownMs,
    ephemeralAutoRetrievalDays: evaluationCase.ephemeralAutoRetrievalDays,
    conversationAutoRetrievalDays: evaluationCase.conversationAutoRetrievalDays,
    derivedAutoRetrievalDays: evaluationCase.derivedAutoRetrievalDays,
  };
}

function runtimePolicyFromHintRequest(request) {
  return {
    sessionId: request.sessionId,
    sessionIds: [...request.sessionIds],
    epochId: request.epochId,
    activeMessageKeys: [...request.activeMessageKeys],
    activeHintBudgetTokens: request.activeHintBudgetTokens,
    now: request.now,
    hintSourceCooldownMs: request.hintSourceCooldownMs,
    ephemeralAutoRetrievalDays: request.ephemeralAutoRetrievalDays,
    conversationAutoRetrievalDays: request.conversationAutoRetrievalDays,
    derivedAutoRetrievalDays: request.derivedAutoRetrievalDays,
  };
}

async function runSearchSuite(backend, suite, cases) {
  const observations = [];
  for (const evaluationCase of cases) {
    const response = await backend.search(searchRequest(suite, evaluationCase));
    observations.push({ id: evaluationCase.id, results: normalizeSearchResults(response) });
  }
  return observations;
}

async function runChunkSuite(backend, cases) {
  if (typeof backend.recall !== "function") throw new TypeError("chunks capability requires backend.recall(request)");
  const observations = [];
  for (const evaluationCase of cases) {
    const searchResults = normalizeSearchResults(await backend.search(searchRequest("chunks", evaluationCase)));
    const locator = searchResults[0]?.locator;
    const recall = locator === null || locator === undefined
      ? {
          status: "missing",
          documentId: "",
          startByte: -1,
          endByte: -1,
          canonicalText: "",
        }
      : normalizeRecall(await backend.recall({
          locator,
          neighbors: evaluationCase.neighbors,
          maxTokens: evaluationCase.maxTokens,
        }));
    observations.push({ id: evaluationCase.id, searchResults, recall });
  }
  return observations;
}

async function runHintSuite(backend, cases) {
  if (typeof backend.preflight !== "function") throw new TypeError("hints capability requires backend.preflight(request)");
  const observations = [];
  for (const evaluationCase of cases) {
    const request = hintRequest(evaluationCase);
    const first = normalizeHintResponse(await backend.preflight(request));
    const reconstruction = normalizeHintResponse(await backend.preflight({ ...request, reconstruct: true }));
    observations.push({
      id: evaluationCase.id,
      first,
      reconstruction,
      runtimePolicy: runtimePolicyFromHintRequest(request),
    });
  }
  return observations;
}

export async function runRetrievalEvaluation({ backend, fixture, suites = RETRIEVAL_SUITES }) {
  assertBackend(backend);
  await backend.prepare(fixture);
  const capabilities = new Set(backend.metadata.capabilities);
  const runs = {};
  for (const suite of suites) {
    if (!RETRIEVAL_SUITES.includes(suite)) throw new TypeError(`unknown retrieval suite: ${String(suite)}`);
    if (!capabilities.has(suite)) {
      runs[suite] = {
        status: "unsupported",
        reason: `${backend.metadata.id} does not declare the ${suite} evaluation capability`,
      };
      continue;
    }
    let observations;
    if (suite === "chunks") observations = await runChunkSuite(backend, fixture.suites[suite]);
    else if (suite === "hints") observations = await runHintSuite(backend, fixture.suites[suite]);
    else observations = await runSearchSuite(backend, suite, fixture.suites[suite]);
    runs[suite] = { status: "completed", observations };
  }
  return runs;
}

export async function closeEvaluationBackend(backend) {
  if (typeof backend?.close === "function") await backend.close();
}
