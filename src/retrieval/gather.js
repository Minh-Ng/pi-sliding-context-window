import {
  assertStoreRequest,
  assertStoreResult,
} from "../store-contract.js";
import { recallArchive } from "./recall.js";
import { searchArchive } from "./search.js";
import { traverseArchive } from "./traverse.js";

const MIN_RECALL_TOKENS = 39;
const DEFAULT_SCAN_LIMIT = 2_048;

function candidateIdentity(candidate) {
  return `${candidate.documentId}\0${candidate.version}`;
}

function presets(request) {
  if (request.intent === "state") return { before: 0, after: 0 };
  if (request.intent === "workflow") return { before: 1, after: 8 };
  return { before: 1, after: 3 };
}

function normalizeRequest(rawRequest, project) {
  assertStoreRequest("store.gather", rawRequest);
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Gather requires an authorized project boundary.");
  }
  const sessionIds = [...new Set(rawRequest.sessionIds ?? [])];
  if (rawRequest.scope === "session" && sessionIds.length === 0) {
    throw new TypeError("Session-scoped gather requires sessionIds.");
  }
  const defaults = presets(rawRequest);
  return Object.freeze({
    ...rawRequest,
    project,
    sessionIds: Object.freeze(sessionIds),
    before: rawRequest.before ?? defaults.before,
    after: rawRequest.after ?? defaults.after,
  });
}

function candidatePriority(relation, anchorRank, distance, intent) {
  if (intent === "workflow") {
    if (anchorRank === 1 && relation === "anchor") return 0;
    if (anchorRank === 1 && relation === "after") return distance;
    if (anchorRank === 1 && relation === "before") return 50 + distance;
    if (relation === "anchor") return 100 + anchorRank;
    return 200 + anchorRank * 20 + distance;
  }
  if (relation === "anchor") return anchorRank;
  return 100 + anchorRank * 20 + (relation === "after" ? distance : 10 + distance);
}

function addCandidate(candidates, candidate, relation, anchorRank, distance, intent) {
  const identity = candidateIdentity(candidate);
  const priority = candidatePriority(relation, anchorRank, distance, intent);
  const current = candidates.get(identity);
  if (current === undefined || priority < current.priority) {
    candidates.set(identity, {
      candidate,
      relation,
      anchorRank,
      distance,
      priority,
    });
  }
}

function traversalLineage(request, anchor) {
  if (request.scope === "session") return request.sessionIds;
  return Object.freeze([anchor.source.sessionId]);
}

function chronological(left, right) {
  return Number(left.document.createdAt) - Number(right.document.createdAt)
    || String(left.document.documentId).localeCompare(String(right.document.documentId))
    || Number(left.document.version) - Number(right.document.version);
}

/**
 * Gather a bounded, provenance-preserving evidence packet in one store call.
 * Search discovers stable anchors; traversal expands only their authorized
 * branch neighborhood; recall materializes exact canonical source.
 */
export async function gatherArchive(store, rawRequest, options = {}) {
  if (!store || typeof store.snapshot !== "function") {
    throw new TypeError("gatherArchive requires a RocksStore-compatible store.");
  }
  const request = normalizeRequest(rawRequest, options.project);
  const search = await searchArchive(store, {
    query: request.query,
    ...(request.expansionTerms === undefined ? {} : { expansionTerms: request.expansionTerms }),
    relation: null,
    semanticPolicy: "always",
    scope: request.scope,
    sessionIds: request.sessionIds,
    project: request.project,
    limit: request.limit,
    excludeVisibleSourceKeys: request.excludeVisibleSourceKeys,
    hintBudgetTokens: 0,
  }, options);

  if (search.results.length === 0) {
    return assertStoreResult("store.gather", {
      status: "not-found",
      mode: search.mode,
      intent: request.intent,
      anchorCount: 0,
      candidateCount: 0,
      returnedTokens: 0,
      truncated: false,
      hasMore: false,
      evidence: [],
    });
  }

  const candidates = new Map();
  for (let index = 0; index < search.results.length; index += 1) {
    addCandidate(candidates, search.results[index], "anchor", index + 1, 0, request.intent);
  }

  let traversalHasMore = false;
  const neighborhoodAnchors = search.results.slice(0, request.neighborhoodAnchors);
  for (let anchorIndex = 0; anchorIndex < neighborhoodAnchors.length; anchorIndex += 1) {
    const anchor = neighborhoodAnchors[anchorIndex];
    const lineage = traversalLineage(request, anchor);
    for (const [direction, limit] of [["before", request.before], ["after", request.after]]) {
      if (limit === 0) continue;
      const traversal = await traverseArchive(store, {
        locator: anchor.locator,
        direction,
        scope: "session",
        sessionIds: lineage,
        limit,
        scanLimit: DEFAULT_SCAN_LIMIT,
      }, { ...options, project: request.project });
      traversalHasMore ||= traversal.hasMore;
      for (let index = 0; index < traversal.results.length; index += 1) {
        addCandidate(
          candidates,
          traversal.results[index],
          direction,
          anchorIndex + 1,
          index + 1,
          request.intent,
        );
      }
    }
  }

  const orderedCandidates = [...candidates.values()]
    .sort((left, right) => left.priority - right.priority);
  const selectableCount = Math.min(
    orderedCandidates.length,
    request.maxEvidence,
    Math.max(1, Math.floor(request.maxTokens / MIN_RECALL_TOKENS)),
  );
  const selected = orderedCandidates.slice(0, selectableCount);
  const perEvidenceTokens = Math.max(
    MIN_RECALL_TOKENS,
    Math.floor(request.maxTokens / Math.max(1, selected.length)),
  );
  const evidence = [];
  let returnedTokens = 0;
  let recallIncomplete = false;
  for (const item of selected) {
    const recallSessionIds = [...new Set([
      ...request.sessionIds,
      item.candidate.source.sessionId,
    ])];
    const document = await recallArchive(store, {
      locator: item.candidate.locator,
      neighbors: 1,
      maxTokens: perEvidenceTokens,
      sessionIds: recallSessionIds,
    }, { ...options, project: request.project, sessionIds: recallSessionIds });
    if (document.status !== "resolved") {
      recallIncomplete = true;
      continue;
    }
    returnedTokens += document.returnedTokens;
    recallIncomplete ||= document.continuationLocators.length > 0;
    evidence.push({
      relation: item.relation,
      anchorRank: item.anchorRank,
      distance: item.distance,
      locator: item.candidate.locator,
      document,
    });
  }
  evidence.sort(chronological);

  const candidateOverflow = orderedCandidates.length > selected.length;
  const searchMayHaveMore = search.results.length === request.limit;
  const truncated = traversalHasMore || candidateOverflow || recallIncomplete || searchMayHaveMore;
  return assertStoreResult("store.gather", {
    status: evidence.length > 0 ? "resolved" : "not-found",
    mode: search.mode,
    intent: request.intent,
    anchorCount: search.results.length,
    candidateCount: orderedCandidates.length,
    returnedTokens,
    truncated,
    hasMore: truncated,
    evidence,
  });
}
