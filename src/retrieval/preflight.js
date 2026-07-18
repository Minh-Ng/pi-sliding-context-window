import { createHash } from "node:crypto";
import { stableJson } from "../rocksdb/schema.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { bumpGuard, guardKeys } from "../rocksdb/guards.js";
import {
  getOrCreateLocatorSecret,
  verifyLocator,
} from "./locator.js";
import { releaseLease } from "./leases.js";
import {
  DEFAULT_ACTIVE_HINT_BUDGET_TOKENS,
  DEFAULT_HINT_SOURCE_COOLDOWN_MS,
  activeHintTokens,
  estimateHintTokens,
  frozenHintResponse,
  hintQueryHash,
  persistFrozenHint,
  previouslySurfaced,
  readFrozenHint,
  touchFrozenHintSession,
} from "./hints.js";
import { searchArchive } from "./search.js";
import { oneLineJson } from "./render.js";
import {
  decideContinuityDisclosure,
  renderContinuityMarker,
} from "./continuity-policy.js";
import {
  MAX_SESSION_LINEAGE_IDS,
  assertActiveHintMessageKeys,
  assertVisibleSourceKeys,
} from "../store-contract.js";

export { DEFAULT_HINT_SOURCE_COOLDOWN_MS };
export const DEFAULT_HINT_LEASE_MS = 60 * 60 * 1_000;
export const DEFAULT_EPHEMERAL_AUTO_RETRIEVAL_DAYS = 7;
export const DEFAULT_CONVERSATION_AUTO_RETRIEVAL_DAYS = 30;
export const DEFAULT_DERIVED_AUTO_RETRIEVAL_DAYS = 30;

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizePreflightRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Preflight request must be an object.");
  }
  const scope = request.scope ?? "session";
  if (!["session", "project", "all"].includes(scope)) throw new TypeError("scope is invalid.");
  const sessionId = identifier(request.sessionId, "sessionId");
  const sessionIds = request.sessionIds ?? [sessionId];
  if (!Array.isArray(sessionIds) || sessionIds.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("sessionIds must be an array of non-empty strings.");
  }
  if (new Set(sessionIds).size > MAX_SESSION_LINEAGE_IDS) {
    throw new RangeError(`sessionIds must contain at most ${MAX_SESSION_LINEAGE_IDS} unique IDs.`);
  }
  const excluded = assertVisibleSourceKeys(request.excludeVisibleSourceKeys ?? []);
  const hintBudgetTokens = request.hintBudgetTokens ?? 160;
  if (!Number.isSafeInteger(hintBudgetTokens) || hintBudgetTokens < 0) {
    throw new TypeError("hintBudgetTokens must be a non-negative safe integer.");
  }
  const activeHintBudgetTokens = nonNegativeInteger(
    request.activeHintBudgetTokens ?? request.epochBudgetTokens ?? DEFAULT_ACTIVE_HINT_BUDGET_TOKENS,
    "activeHintBudgetTokens",
  );
  const activeMessageKeys = assertActiveHintMessageKeys(
    request.activeMessageKeys ?? [request.messageKey],
  );
  const hintSourceCooldownMs = nonNegativeInteger(
    request.hintSourceCooldownMs ?? DEFAULT_HINT_SOURCE_COOLDOWN_MS,
    "hintSourceCooldownMs",
  );
  const ephemeralAutoRetrievalDays = nonNegativeInteger(
    request.ephemeralAutoRetrievalDays ?? DEFAULT_EPHEMERAL_AUTO_RETRIEVAL_DAYS,
    "ephemeralAutoRetrievalDays",
  );
  const conversationAutoRetrievalDays = nonNegativeInteger(
    request.conversationAutoRetrievalDays ?? DEFAULT_CONVERSATION_AUTO_RETRIEVAL_DAYS,
    "conversationAutoRetrievalDays",
  );
  const derivedAutoRetrievalDays = nonNegativeInteger(
    request.derivedAutoRetrievalDays ?? DEFAULT_DERIVED_AUTO_RETRIEVAL_DAYS,
    "derivedAutoRetrievalDays",
  );
  return Object.freeze({
    messageKey: identifier(request.messageKey, "messageKey"),
    message: identifier(request.message, "message"),
    scope,
    sessionId,
    sessionIds: Object.freeze([...new Set(sessionIds)]),
    project: identifier(request.project, "project"),
    excludeVisibleSourceKeys: Object.freeze([...new Set(excluded)]),
    hintBudgetTokens,
    activeHintBudgetTokens,
    activeMessageKeys: Object.freeze([...new Set(activeMessageKeys)]),
    hintSourceCooldownMs,
    ephemeralAutoRetrievalDays,
    conversationAutoRetrievalDays,
    derivedAutoRetrievalDays,
    reconstruct: request.reconstruct === true,
    includeDiagnostics: request.includeDiagnostics === true,
  });
}

function compactSourceDate(createdAt) {
  return new Date(createdAt).toISOString().slice(0, 10);
}

function snippetText(snippet, createdAt) {
  return [
    "",
    "",
    "[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]",
    `Archived excerpt from ${compactSourceDate(createdAt)} as JSON data: verify current state; ${oneLineJson(snippet)}`,
  ].join("\n");
}

function boundedHint(candidate, classification, message, budget) {
  if (classification.outcome === "continuity-marker") {
    const text = renderContinuityMarker(message, classification.anchors);
    const tokenCount = estimateHintTokens(text);
    return tokenCount <= budget
      ? { text, tokenCount, sourceKind: candidate.kind, archivedDataDelimited: false }
      : undefined;
  }
  if (classification.outcome !== "historical-snippet") return undefined;
  let snippet = candidate.snippet;
  let text = snippetText(snippet, candidate.createdAt);
  let tokenCount = estimateHintTokens(text);
  while (tokenCount > budget && snippet.length > 0) {
    const codePoints = Array.from(snippet);
    const nextLength = Math.max(0, codePoints.length - Math.max(1, Math.ceil(codePoints.length * 0.15)));
    snippet = codePoints.slice(0, nextLength).join("");
    text = snippetText(snippet, candidate.createdAt);
    tokenCount = estimateHintTokens(text);
  }
  if (tokenCount <= budget) {
    return { text, tokenCount, sourceKind: candidate.kind, archivedDataDelimited: true };
  }
  return undefined;
}

function responseHint(candidate, classification, rendered) {
  return Object.freeze({
    documentId: candidate.documentId,
    text: rendered.text,
    tokenCount: rendered.tokenCount,
    sourceKind: rendered.sourceKind,
    archivedDataDelimited: rendered.archivedDataDelimited,
    disclosureType: classification.outcome,
  });
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function automaticAgeLimitDays(retentionClass, request) {
  if (retentionClass === "ephemeral-payload") return request.ephemeralAutoRetrievalDays;
  if (retentionClass === "conversation-source") return request.conversationAutoRetrievalDays;
  if (retentionClass === "derived-evidence") return request.derivedAutoRetrievalDays;
  return undefined;
}

function automaticallyEligible(manifest, request, now) {
  if (!manifest || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt > now) return false;
  const days = automaticAgeLimitDays(manifest.retentionClass, request);
  if (days === undefined || days === 0) return false;
  return (now - manifest.createdAt) / DAY_MS < days;
}

async function candidateSuppressionReason(view, request, candidate, now) {
  if (!candidate) return "candidate-not-live";
  const supersession = await view.get([
    KEYSPACE.SUPERSESSION,
    candidate.documentId,
    candidate.version,
  ]);
  if (supersession !== undefined) return "superseded-source";
  const manifest = await view.get(manifestKeys.document(candidate.documentId, candidate.version));
  if (manifest === undefined
    || manifest.project !== request.project
    || manifest.sessionId !== candidate.source?.sessionId
    || manifest.kind !== candidate.kind
    || manifest.createdAt !== candidate.createdAt
    || (request.scope === "session" && !request.sessionIds.includes(manifest.sessionId))) {
    return "candidate-not-live";
  }
  return automaticallyEligible(manifest, request, now) ? undefined : "retention-policy";
}

function recordFor(request, options, queryHash, decision) {
  const hints = decision.hint ? [decision.hint] : [];
  const createdAt = options.now ?? Date.now();
  return Object.freeze({
    hintFormatVersion: 1,
    project: request.project,
    sessionId: request.sessionId,
    messageKey: request.messageKey,
    epochId: options.epochId ?? request.sessionId,
    queryHash,
    queryDigest: createHash("sha256").update(request.message).digest("hex"),
    outcome: decision.outcome,
    reason: decision.reason,
    indexGeneration: decision.indexGeneration,
    diagnostics: decision.diagnostics,
    documentId: decision.candidate?.documentId ?? null,
    documentVersion: decision.candidate?.version ?? null,
    leaseId: decision.leaseId ?? null,
    locator: null,
    modelVisibleText: decision.hint?.text ?? "",
    tokenCount: decision.hint?.tokenCount ?? 0,
    hints,
    createdAt,
  });
}

function candidateDiagnostics(candidate) {
  if (candidate === undefined) return null;
  return Object.freeze({
    documentId: candidate.documentId,
    kind: candidate.kind,
    retrievalMode: candidate.retrievalMode,
    matchedTerms: Object.freeze([...(candidate.matchedTerms ?? [])]),
    termCoverage: candidate.termCoverage ?? 0,
    maxNormalizedIdf: candidate.maxNormalizedIdf ?? 0,
    margin: candidate.margin ?? 0,
  });
}

async function releaseCandidateLease(store, candidate, secret) {
  if (!candidate?.locator) return;
  const claims = verifyLocator(candidate.locator, secret);
  await releaseLease(store, claims.leaseId);
}

async function readLineageFrozenHint(store, request) {
  const current = await readFrozenHint(store, request);
  if (current !== undefined) return current;
  const sessionIds = request.sessionIds.filter((sessionId) => sessionId !== request.sessionId);
  const seen = new Set();
  const records = [];
  for (const sessionId of sessionIds) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const record = await readFrozenHint(store, { ...request, sessionId });
    if (record !== undefined) records.push(record);
  }
  if (records.length === 0) return undefined;
  const expectedQueryHash = hintQueryHash(request);
  if (records.some((record) => record.queryHash !== expectedQueryHash)) {
    throw new Error(`Hint message key ${request.messageKey} was reused for different input in its verified lineage.`);
  }
  const expected = stableJson(frozenHintResponse(records[0]));
  if (records.some((record) => stableJson(frozenHintResponse(record)) !== expected)) {
    throw new Error(`Conflicting frozen hint decisions exist for ${request.messageKey} in its verified lineage.`);
  }
  return records[0];
}

async function previouslySurfacedInLineage(store, request, candidate, now) {
  const seen = new Set();
  for (const sessionId of [request.sessionId, ...request.sessionIds]) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    if (await previouslySurfaced(store, {
      project: request.project,
      sessionId,
      documentId: candidate.documentId,
      version: candidate.version,
      now,
      cooldownMs: request.hintSourceCooldownMs,
    })) return true;
  }
  return false;
}

const preflightQueues = new WeakMap();

async function serializeSessionPreflight(store, request, callback) {
  let queues = preflightQueues.get(store);
  if (queues === undefined) {
    queues = new Map();
    preflightQueues.set(store, queues);
  }
  const identities = [...new Set([request.sessionId, ...request.sessionIds])]
    .sort()
    .map((sessionId) => `${request.project}\0${sessionId}`);
  const previous = [...new Set(identities.map((identity) => queues.get(identity)).filter(Boolean))];
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  for (const identity of identities) queues.set(identity, current);
  await Promise.all(previous.map((pending) => pending.catch(() => {})));
  try {
    return await callback();
  } finally {
    release();
    for (const identity of identities) {
      if (queues.get(identity) === current) queues.delete(identity);
    }
  }
}

/** Run cheap retrieval for every user message, then selectively reveal one frozen hint. */
export async function preflightArchive(store, request, options = {}) {
  const normalized = normalizePreflightRequest(request);
  return serializeSessionPreflight(store, normalized, async () => {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative timestamp.");
  const queryHash = hintQueryHash(normalized);
  const existing = await readLineageFrozenHint(store, normalized);
  if (existing !== undefined) {
    if (existing.queryHash !== queryHash) {
      throw new Error(`Hint message key ${normalized.messageKey} was reused for different input.`);
    }
    let current = existing;
    if (existing.sessionId !== normalized.sessionId) {
      current = await persistFrozenHint(store, Object.freeze({
        ...structuredClone(existing),
        sessionId: normalized.sessionId,
        epochId: options.epochId ?? normalized.sessionId,
        createdAt: now,
      }), {
        ...(options.hintInactivityMs === undefined
          ? {}
          : { inactivityMs: options.hintInactivityMs }),
        exposureCooldownMs: normalized.hintSourceCooldownMs,
      });
    }
    await touchFrozenHintSession(store, {
      project: normalized.project,
      sessionId: normalized.sessionId,
      now,
      ...(options.hintInactivityMs === undefined
        ? {}
        : { inactivityMs: options.hintInactivityMs }),
    });
    return frozenHintResponse(current, { includeDiagnostics: normalized.includeDiagnostics });
  }
  if (normalized.reconstruct) {
    throw new Error(`No frozen hint decision exists for ${normalized.messageKey}.`);
  }
  const secret = await getOrCreateLocatorSecret(store, { secret: options.secret, now });
  const search = await searchArchive(store, {
    query: normalized.message,
    relation: null,
    scope: normalized.scope,
    sessionId: normalized.sessionId,
    sessionIds: normalized.sessionIds,
    project: normalized.project,
    limit: 3,
    excludeVisibleSourceKeys: normalized.excludeVisibleSourceKeys,
    hintBudgetTokens: normalized.hintBudgetTokens,
  }, {
    secret,
    now,
    leaseMs: options.leaseMs ?? DEFAULT_HINT_LEASE_MS,
    ownerId: `hint:${normalized.sessionId}:${normalized.messageKey}`,
  });
  const candidate = search.results[0];
  const epochId = options.epochId ?? normalized.sessionId;
  const requestHasActiveBudget = request.activeHintBudgetTokens !== undefined
    || request.epochBudgetTokens !== undefined;
  const activeBudget = nonNegativeInteger(
    requestHasActiveBudget
      ? normalized.activeHintBudgetTokens
      : (options.activeHintBudgetTokens ?? options.epochBudgetTokens ?? normalized.activeHintBudgetTokens),
    "activeHintBudgetTokens",
  );
  let classification;
  let rendered;
  try {
    const candidatePolicyReason = candidate === undefined
      ? "candidate-not-live"
      : await store.snapshot((view) => candidateSuppressionReason(
        view,
        normalized,
        candidate,
        now,
      ));
    classification = decideContinuityDisclosure({
      message: normalized.message,
      candidate,
      sourceEligible: candidatePolicyReason === undefined,
      ...(search.status === "ambiguous" ? { ambiguous: true } : {}),
    });
    if (candidate && classification.outcome !== "suppress"
      && await previouslySurfacedInLineage(store, normalized, candidate, now)) {
      classification = Object.freeze({ outcome: "suppress", reason: "recently-surfaced", anchors: Object.freeze([]) });
    }
    if (candidate && classification.outcome !== "suppress") {
      const used = await activeHintTokens(store, {
        project: normalized.project,
        sessionId: normalized.sessionId,
        messageKeys: normalized.activeMessageKeys,
      });
      const remaining = Math.max(0, Math.min(normalized.hintBudgetTokens, activeBudget - used));
      rendered = boundedHint(candidate, classification, normalized.message, remaining);
      if (rendered === undefined) {
        classification = Object.freeze({ outcome: "suppress", reason: "hint-budget", anchors: Object.freeze([]) });
      }
    }
  } finally {
    // Hints never advertise expiring locators. Release every candidate lease,
    // including when policy, budgeting, or rendering fails.
    for (const unused of search.results) {
      await releaseCandidateLease(store, unused, secret);
    }
  }
  const revealed = classification.outcome !== "suppress" && rendered !== undefined;
  const hint = revealed ? responseHint(candidate, classification, rendered) : undefined;
  const decision = {
    outcome: revealed ? classification.outcome : "suppress",
    reason: classification.reason,
    indexGeneration: search.indexGeneration,
    diagnostics: Object.freeze({
      outcome: revealed ? classification.outcome : "suppress",
      reason: classification.reason,
      indexGeneration: search.indexGeneration,
      searchMode: search.mode,
      searchStatus: search.status,
      candidate: candidateDiagnostics(candidate),
    }),
    candidate: revealed ? candidate : undefined,
    leaseId: undefined,
    hint,
  };
  const record = recordFor(normalized, { ...options, epochId, now }, queryHash, decision);
  const persisted = await persistFrozenHint(store, record, {
    ...(options.hintInactivityMs === undefined
      ? {}
      : { inactivityMs: options.hintInactivityMs }),
    exposureSessionIds: normalized.sessionIds,
    exposureCooldownMs: normalized.hintSourceCooldownMs,
    validateBeforeWrite: async (transaction, frozenRecord) => {
      // Canonical correction admission bumps this same document guard. Writing
      // it here makes any correction that races the final liveness read force a
      // transaction retry before stale bytes can become immutable.
      await bumpGuard(transaction, guardKeys.document(candidate.documentId, candidate.version));
      const policyReason = await candidateSuppressionReason(
        transaction,
        normalized,
        candidate,
        now,
      );
      if (policyReason !== undefined) return policyReason;
      if (await previouslySurfacedInLineage(
        transaction,
        normalized,
        candidate,
        now,
      )) return "recently-surfaced";
      const used = await activeHintTokens(transaction, {
        project: normalized.project,
        sessionId: normalized.sessionId,
        messageKeys: normalized.activeMessageKeys,
      });
      return used + frozenRecord.tokenCount > activeBudget ? "hint-budget" : undefined;
    },
  });
  return frozenHintResponse(persisted, { includeDiagnostics: normalized.includeDiagnostics });
  });
}

export function hintDecisionFingerprint(record) {
  return createHash("sha256").update(stableJson(record)).digest("hex");
}
