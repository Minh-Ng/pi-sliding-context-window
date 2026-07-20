import {
  assertStoreRequest,
  assertStoreResult,
} from "../store-contract.js";
import { lookupExact, planExactQuery } from "../rocksdb/index/exact.js";
import { searchBm25 } from "../rocksdb/index/bm25.js";
import { lookupStructuralAsync } from "../rocksdb/index/structural.js";
import { documentImportancePrior } from "../rocksdb/index/importance.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import { semanticIdentifier } from "../semantic-identifiers.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import {
  getOrCreateLocatorSecret,
  signLocator,
} from "./locator.js";
import {
  createRetrievalLease,
  releaseLease,
  RetrievalLeaseTargetUnavailableError,
} from "./leases.js";
import {
  normalizeRecencyHalfLifeMsByClass,
  recencyDecayMultiplier,
} from "../daemon/retention-policy.js";

const MODE_PRIORITY = Object.freeze({ exact: 3, structural: 2, lexical: 1, semantic: 1 });
const WINDOW_SCAN_PAGE = 1_000;
const MAX_LEGACY_STRUCTURAL_LOCATION_BYTES = 64 * 1_024;
const MAX_STRUCTURAL_CANDIDATE_BYTES = 64 * 1_024;
const MAX_INDEXED_STRUCTURAL_EXCERPT_BYTES = 1 * 1_024 * 1_024;

function requireStore(store) {
  if (!store || typeof store.snapshot !== "function" || typeof store.get !== "function") {
    throw new TypeError("Search orchestration requires a writable RocksStore-compatible store.");
  }
  return store;
}

function normalizeRequest(request) {
  assertStoreRequest("store.search", request);
  if (typeof request.project !== "string" || request.project.length === 0) {
    throw new TypeError("Search requires an authorized project boundary.");
  }
  const sessionIds = request.sessionIds ?? (request.sessionId === undefined ? [] : [request.sessionId]);
  if (request.scope === "session" && sessionIds.length === 0) {
    throw new TypeError("Session-scoped search requires sessionId or sessionIds.");
  }
  // `all` means all evidence authorized to this connection. The first cut has
  // one authorized project per request, so it safely collapses to project
  // scope instead of reading the structural index's cross-project prefix.
  const effectiveScope = request.scope === "all" ? "project" : request.scope;
  return Object.freeze({
    ...request,
    effectiveScope,
    sessionIds: Object.freeze([...new Set(sessionIds)]),
    excludeVisibleSourceKeys: Object.freeze([...new Set(request.excludeVisibleSourceKeys)]),
  });
}

async function publishedGeneration(view) {
  const publication = await view.get([KEYSPACE.META, "published-index-generation"]);
  const generation = publication?.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("The published index generation is malformed.");
  }
  return generation;
}

export function normalizeModeScore(mode, score) {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) return 0;
  if (mode === "exact") return Math.min(1, score);
  if (mode === "structural") return Math.min(1, score / 100);
  // BM25 is unbounded. Calibrate each result against one fixed curve instead
  // of the current result set, so adding a weaker candidate cannot promote the
  // top result to an artificial confidence of 1.0 or otherwise change it.
  if (mode === "lexical") return score / (score + 1);
  if (mode === "semantic") return Math.min(1, score);
  throw new TypeError(`Unknown retrieval mode ${mode}.`);
}

function candidateIdentity(candidate) {
  return `${candidate.documentId}\0${candidate.version}`;
}

function exactCandidates(response) {
  return response.results.map((result) => ({
    ...result,
    rawScore: result.score,
    retrievalMode: "exact",
    normalizedScore: normalizeModeScore("exact", result.score),
    matchedTerms: Object.freeze([]),
    termCoverage: 0,
    termIdf: Object.freeze([]),
    maxNormalizedIdf: 0,
  }));
}

/**
 * Explicit search/gather callers opt in via `options.recencyDecay`; the
 * automatic preflight path never sets it, so its BM25 candidate ranking
 * stays undecayed and its frozen hints stay byte-identical over time.
 */
function recencyDecayContext(options, now) {
  const setting = options.recencyDecay;
  if (!setting) return undefined;
  const overrides = setting === true ? {} : (setting.halfLifeMsByClass ?? {});
  return Object.freeze({ now, halfLifeMsByClass: normalizeRecencyHalfLifeMsByClass(overrides) });
}

function lexicalCandidates(response) {
  return response.results.map((result) => ({
    ...result,
    retrievalMode: "lexical",
    // rawScore (above) is the untouched BM25 value the index layer computed;
    // normalizedScore is the undecayed calibration. Decay is applied later, in
    // applyRecencyDecay, so shouldTrySemantic's cost-control gate below always
    // reads the undecayed lexical score regardless of options.recencyDecay.
    normalizedScore: normalizeModeScore("lexical", result.rawScore),
    matchedAnchors: Object.freeze([]),
  }));
}

function semanticCandidates(results, generation) {
  return results.map((result) => ({
    documentId: result.documentId,
    version: result.version,
    kind: result.kind,
    createdAt: result.createdAt,
    score: result.score,
    rawScore: result.score,
    normalizedScore: normalizeModeScore("semantic", result.score),
    retrievalMode: "semantic",
    matchType: "semantic-similarity",
    margin: 0,
    snippet: result.text,
    historical: true,
    superseded: false,
    matchedAnchors: Object.freeze([]),
    matchedTerms: Object.freeze([]),
    termCoverage: 0,
    termIdf: Object.freeze([]),
    maxNormalizedIdf: 0,
    source: {
      project: result.project,
      sessionId: result.sessionId,
      sourceMessageKeys: result.sourceMessageKeys,
    },
    location: {
      windowOrdinal: result.windowOrdinal,
      startByte: result.startByte,
      endByte: result.endByte,
      generation,
    },
  }));
}

/** Find a containing/intersecting stored window without a total-window cap. */
export function findStoredWindowForByteRange(view, documentId, version, startByte, endByte) {
  let after;
  let firstIntersecting;
  while (true) {
    const page = view.scan([KEYSPACE.WINDOW, documentId, version], {
      limit: WINDOW_SCAN_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    for (const { payload: candidate } of page) {
      const intersects = startByte === endByte
        ? candidate.startByte === startByte || candidate.endByte === endByte
        : candidate.endByte > startByte && candidate.startByte < endByte;
      if (intersects && firstIntersecting === undefined) firstIntersecting = candidate;
      if (candidate.startByte <= startByte && candidate.endByte >= endByte
        && (startByte < candidate.endByte || candidate === page.at(-1)?.payload)) {
        return candidate;
      }
      if (firstIntersecting !== undefined && candidate.startByte >= endByte) {
        return firstIntersecting;
      }
    }
    if (page.length < WINDOW_SCAN_PAGE) return firstIntersecting;
    after = page.at(-1).keyBytes;
  }
}

function structuralQueryRange(excerpt, query) {
  const firstScalarBytes = excerpt.length === 0
    ? 0
    : Buffer.byteLength(Array.from(excerpt)[0], "utf8");
  const excerptTokens = [...excerpt.matchAll(/[\p{L}\p{N}_-]{2,}/gu)];
  const fallback = () => {
    const match = excerptTokens[Math.floor(excerptTokens.length / 2)];
    if (match === undefined) return Object.freeze({ startByte: 0, endByte: firstScalarBytes });
    const startByte = Buffer.byteLength(excerpt.slice(0, match.index), "utf8");
    return Object.freeze({
      startByte,
      endByte: startByte + Buffer.byteLength(match[0], "utf8"),
    });
  };
  const terms = new Set(String(query ?? "").toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  if (terms.size === 0) return fallback();
  for (const match of excerptTokens) {
    if (!terms.has(match[0].toLocaleLowerCase())) continue;
    const startByte = Buffer.byteLength(excerpt.slice(0, match.index), "utf8");
    return Object.freeze({
      startByte,
      endByte: startByte + Buffer.byteLength(match[0], "utf8"),
    });
  }
  return fallback();
}

async function structuralCandidate(view, result, generation, request) {
  if (result.project !== request.project) return undefined;
  const manifest = await view.get(manifestKeys.document(result.documentId, result.version));
  if (manifest === undefined || manifest.project !== request.project) return undefined;
  if (request.effectiveScope === "session" && !request.sessionIds.includes(manifest.sessionId)) return undefined;
  if (manifest.sourceMessageKeys.some((key) => request.excludeVisibleSourceKeys.includes(key))) return undefined;
  if (view.scan([KEYSPACE.SUPERSESSION, result.documentId, result.version], { limit: 1 }).length > 0) {
    return undefined;
  }
  const excerpt = String(result.snippet ?? "");
  const excerptBytes = Buffer.byteLength(excerpt, "utf8");
  if (excerptBytes > MAX_INDEXED_STRUCTURAL_EXCERPT_BYTES) return undefined;
  let startByte = result.structural?.startByte;
  let endByte = result.structural?.endByte;
  if (Number.isSafeInteger(startByte) && Number.isSafeInteger(endByte)
    && startByte >= 0 && endByte >= startByte && endByte <= manifest.byteLength) {
    if (endByte - startByte !== excerptBytes) return undefined;
  } else {
    // Pre-coordinate structural postings remain compatible only while their
    // source is explicitly small. Large legacy postings must be reindexed;
    // query-time full reconstruction is never an acceptable fallback.
    if (manifest.byteLength > MAX_LEGACY_STRUCTURAL_LOCATION_BYTES) return undefined;
    const source = (await readDocumentRange(view, manifest, 0, manifest.byteLength)).text;
    const codeUnitStart = excerpt.length === 0 ? 0 : source.indexOf(excerpt);
    if (codeUnitStart < 0) return undefined;
    startByte = Buffer.byteLength(source.slice(0, codeUnitStart), "utf8");
    endByte = startByte + Buffer.byteLength(excerpt, "utf8");
  }
  const excerptStartByte = startByte;
  const excerptEndByte = endByte;
  const queryRange = structuralQueryRange(excerpt, request.query);
  const targetStartByte = excerptStartByte + queryRange.startByte;
  const targetEndByte = excerptStartByte + queryRange.endByte;
  const window = findStoredWindowForByteRange(
    view,
    result.documentId,
    result.version,
    targetStartByte,
    targetEndByte,
  );
  if (window === undefined) return undefined;
  startByte = Math.max(excerptStartByte, window.startByte);
  endByte = Math.min(excerptEndByte, window.endByte);
  if (endByte - startByte > MAX_STRUCTURAL_CANDIDATE_BYTES) {
    startByte = Math.max(startByte, targetStartByte - Math.floor(MAX_STRUCTURAL_CANDIDATE_BYTES / 2));
    endByte = Math.min(endByte, startByte + MAX_STRUCTURAL_CANDIDATE_BYTES);
    if (endByte < targetEndByte) {
      endByte = Math.min(excerptEndByte, window.endByte, targetEndByte);
      startByte = Math.max(excerptStartByte, window.startByte, endByte - MAX_STRUCTURAL_CANDIDATE_BYTES);
    }
  }
  const selected = await readDocumentRange(view, manifest, startByte, endByte, { adjustUtf8: true });
  startByte = selected.startByte;
  endByte = selected.endByte;
  const excerptBuffer = Buffer.from(excerpt, "utf8");
  const expected = excerptBuffer.subarray(
    startByte - excerptStartByte,
    endByte - excerptStartByte,
  ).toString("utf8");
  if (selected.text !== expected) return undefined;
  // The snippet may cover most of the containing window, but the signed match
  // range must identify the query-bearing bytes. Bounded recall centers on the
  // signed match rather than assuming the caller can consume the whole window.
  const matchStartByte = Math.max(startByte, targetStartByte);
  const matchEndByte = Math.min(endByte, targetEndByte);
  if (matchEndByte < matchStartByte) return undefined;
  return {
    documentId: result.documentId,
    version: result.version,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    score: result.score,
    rawScore: result.score,
    normalizedScore: normalizeModeScore("structural", result.score),
    retrievalMode: "structural",
    matchType: result.structural?.relation ?? "structural",
    margin: 0,
    snippet: selected.text,
    historical: true,
    superseded: false,
    matchedAnchors: Object.freeze([]),
    matchedTerms: Object.freeze([]),
    termCoverage: 0,
    termIdf: Object.freeze([]),
    maxNormalizedIdf: 0,
    source: {
      project: manifest.project,
      sessionId: manifest.sessionId,
      turnId: semanticIdentifier(result.structural?.sourceTurnId)
        ?? semanticIdentifier(manifest.metadata?.turnId)
        ?? null,
      messageKey: semanticIdentifier(result.structural?.messageKey)
        ?? (manifest.sourceKeyStatus === "unavailable"
          ? undefined
          : semanticIdentifier(manifest.sourceKey)),
      sourceMessageKeys: manifest.sourceMessageKeys,
    },
    location: {
      windowOrdinal: window.ordinal,
      startByte: matchStartByte,
      endByte: matchEndByte,
      generation,
    },
  };
}

async function structuralCandidates(view, response, generation, request) {
  const candidates = [];
  for (const result of response.results) {
    const candidate = await structuralCandidate(view, result, generation, request);
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

function compareCandidates(left, right) {
  return MODE_PRIORITY[right.retrievalMode] - MODE_PRIORITY[left.retrievalMode]
    || right.normalizedScore - left.normalizedScore
    || (right.source.sessionId === left.source.sessionId ? 0 : 0)
    || String(left.documentId).localeCompare(String(right.documentId));
}

function fuseCandidates(candidates, limit) {
  const best = new Map();
  for (const candidate of candidates) {
    const identity = candidateIdentity(candidate);
    const current = best.get(identity);
    if (current === undefined || compareCandidates(candidate, current) < 0) best.set(identity, candidate);
  }
  return [...best.values()].sort(compareCandidates).slice(0, limit);
}

function compareRankedCandidates(left, right) {
  return MODE_PRIORITY[right.retrievalMode] - MODE_PRIORITY[left.retrievalMode]
    || right.rankingScore - left.rankingScore
    || String(left.documentId).localeCompare(String(right.documentId))
    || left.version - right.version;
}

/**
 * Re-rank fused candidates by a bounded query-independent importance prior. The
 * prior only multiplies the normalized relevance score, so it can reorder
 * near-ties but never overrule a strong relevance gap. Applied to explicit
 * search ranking only; the automatic preflight path never sets this flag, so
 * frozen-hint scoring stays byte-identical.
 */
async function applyImportancePriors(view, candidates, project) {
  const ranked = [];
  for (const candidate of candidates) {
    const prior = await documentImportancePrior(view, {
      documentId: candidate.documentId,
      version: candidate.version,
      project,
    });
    ranked.push({
      ...candidate,
      importancePrior: prior,
      rankingScore: candidate.normalizedScore * prior,
    });
  }
  return ranked.sort(compareRankedCandidates);
}

function preserveCandidateMargins(candidates) {
  return candidates.map((candidate, index) => {
    const sameModeNext = candidates.slice(index + 1)
      .find(({ retrievalMode }) => retrievalMode === candidate.retrievalMode);
    // The list may be ordered by rankingScore (importance-prior reordering)
    // rather than normalizedScore, so the next same-mode candidate is not
    // guaranteed to have a lower normalizedScore than this one. The contract
    // requires a non-negative margin, so a prior-driven reorder reports a
    // margin of 0 (no clear lead) instead of a negative confidence gap.
    const margin = candidate.normalizedScore - (sameModeNext?.normalizedScore ?? 0);
    return {
      ...candidate,
      margin: Number(Math.max(0, margin).toFixed(6)),
    };
  });
}

function responseMode({ exactAttempted, lexicalAttempted, structuralAttempted, semanticAttempted }) {
  const count = Number(Boolean(exactAttempted)) + Number(Boolean(lexicalAttempted))
    + Number(Boolean(structuralAttempted)) + Number(Boolean(semanticAttempted));
  if (count > 1) return "hybrid";
  if (exactAttempted) return "exact";
  if (structuralAttempted) return "structural";
  if (semanticAttempted) return "semantic";
  return "lexical";
}

const EMPTY_EXPIRED_MATCHES = Object.freeze({ count: 0, retentionClasses: Object.freeze([]) });

async function collectCandidates(view, request, options) {
  const generation = await publishedGeneration(view);
  const plan = planExactQuery(request.query);
  const candidateLimit = Math.min(100, Math.max(request.limit, request.limit * 3));
  const candidates = [];
  let exactAttempted = false;
  let lexicalAttempted = false;
  let structuralAttempted = false;
  let structuralStatus;
  // Bounded by what the lexical pass already touched; never a separate scan.
  let expiredMatches = EMPTY_EXPIRED_MATCHES;

  if (plan.anchors.length > 0) {
    exactAttempted = true;
    const exact = await lookupExact(view, {
      query: request.query,
      project: request.project,
      scope: request.effectiveScope,
      sessionIds: request.sessionIds,
      excludeVisibleSourceKeys: request.excludeVisibleSourceKeys,
      limit: candidateLimit,
      generation,
      ...(options.exact ?? {}),
    });
    candidates.push(...exactCandidates(exact));
  }

  const exactResolved = candidates.some(({ retrievalMode }) => retrievalMode === "exact");
  const lexicalAllowed = request.query.trim().length > 0
    && !exactResolved
    && options.broadenExactMiss !== false;
  if (lexicalAllowed) {
    lexicalAttempted = true;
    const lexical = await searchBm25(view, {
      query: [request.query, ...(request.expansionTerms ?? [])].join(" "),
      project: request.project,
      scope: request.effectiveScope,
      sessionIds: request.sessionIds,
      excludeVisibleSourceKeys: request.excludeVisibleSourceKeys,
      limit: candidateLimit,
      ...(generation > 0 ? { generation } : {}),
    }, options.bm25);
    candidates.push(...lexicalCandidates(lexical));
    expiredMatches = lexical.work.expiredMatches;
  }

  if (request.relation !== null) {
    structuralAttempted = true;
    const structural = await lookupStructuralAsync(view, {
      relation: request.relation,
      query: request.query,
      project: request.project,
      scope: request.effectiveScope,
      sessionIds: request.sessionIds,
      limit: candidateLimit,
      generation,
      scanLimit: options.structural?.scanLimit,
    });
    structuralStatus = structural.status;
    candidates.push(...await structuralCandidates(view, structural, generation, request));
  }

  const fused = fuseCandidates(candidates, candidateLimit);
  return Object.freeze({
    generation,
    candidates: Object.freeze(preserveCandidateMargins(fused)),
    mode: responseMode({ exactAttempted, lexicalAttempted, structuralAttempted }),
    exactAttempted,
    lexicalAttempted,
    structuralAttempted,
    structuralStatus,
    expiredMatches,
  });
}

function shouldTrySemantic(collected, request, options) {
  if (!options.semantic
    || options.allowSemantic === false
    || request.semanticPolicy === "never"
    || request.query.trim().length === 0) return false;
  if (request.semanticPolicy === "always") return true;
  if (collected.candidates.some(({ retrievalMode }) => retrievalMode === "exact")) return false;
  const lexical = collected.candidates.find(({ retrievalMode }) => retrievalMode === "lexical");
  return lexical === undefined
    || lexical.normalizedScore < (options.semanticMinimumLexicalScore ?? 0.55)
    || lexical.termCoverage < (options.semanticMinimumTermCoverage ?? 0.5);
}

async function broadenWithSemantic(collected, request, options) {
  if (!shouldTrySemantic(collected, request, options)) return collected;
  const results = await options.semantic.search(request);
  const candidates = preserveCandidateMargins(fuseCandidates([
    ...collected.candidates,
    ...semanticCandidates(results, collected.generation),
  ], Math.min(100, Math.max(request.limit, request.limit * 3))));
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(candidates),
    mode: responseMode({
      exactAttempted: collected.exactAttempted,
      lexicalAttempted: collected.lexicalAttempted,
      structuralAttempted: collected.structuralAttempted,
      semanticAttempted: true,
    }),
  });
}

/**
 * Rerank the fully-collected (lexical + structural/exact + any semantic
 * broadening) candidate set by query-time recency. This runs after
 * broadenWithSemantic on purpose: shouldTrySemantic's cost/behavior gate must
 * see the undecayed lexical score, or decay would change which requests pay
 * for an embedding-backed semantic search, an interaction the caller never
 * opted into via recencyDecay. It also runs before the importance prior
 * below, which re-fuses by whatever normalizedScore it is handed and must see
 * the decay-adjusted value to reorder consistently with the exposed score.
 */
function applyRecencyDecay(collected, decay, candidateLimit) {
  if (decay === undefined) return collected;
  const decayed = collected.candidates.map((candidate) => {
    if (candidate.retrievalMode !== "lexical") return candidate;
    const multiplier = recencyDecayMultiplier({
      retentionClass: candidate.retentionClass,
      ageMs: decay.now - candidate.createdAt,
      halfLifeMsByClass: decay.halfLifeMsByClass,
    });
    // rawScore stays the untouched BM25 value; only normalizedScore (the
    // ranking/rerank score) moves, so BM25 evidence stays independently
    // recomputable from `explanation` regardless of query time.
    return { ...candidate, normalizedScore: candidate.normalizedScore * multiplier };
  });
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(preserveCandidateMargins(
      fuseCandidates(decayed, candidateLimit),
    )),
  });
}

/**
 * Apply the importance prior to the final candidate set, after semantic
 * broadening and any recency decay. Semantic broadening re-fuses candidates by
 * normalizedScore (broadenWithSemantic), and recency decay does the same
 * (applyRecencyDecay), either of which would otherwise discard any
 * prior-driven reorder from an earlier pass — applying the prior once, last,
 * keeps it consistent regardless of whether semantic search engaged or decay
 * was requested.
 */
async function rankByImportance(store, collected, project) {
  const ranked = await store.snapshot((view) => applyImportancePriors(view, collected.candidates, project));
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(preserveCandidateMargins(ranked)),
  });
}

async function candidateStillLive(store, candidate, request) {
  return store.snapshot(async (view) => {
    if (view.scan([KEYSPACE.SUPERSESSION, candidate.documentId, candidate.version], { limit: 1 }).length > 0) {
      return false;
    }
    const manifest = await view.get(manifestKeys.document(candidate.documentId, candidate.version));
    if (manifest === undefined || manifest.project !== request.project
      || manifest.sessionId !== candidate.source.sessionId) return false;
    if (request.effectiveScope === "session" && !request.sessionIds.includes(manifest.sessionId)) return false;
    return true;
  });
}

async function locateCandidates(store, collected, request, options, secret) {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative timestamp.");
  const results = [];
  for (const candidate of collected.candidates) {
    let lease;
    try {
      lease = await createRetrievalLease(store, {
        ownerId: options.ownerId ?? "search",
        documentId: candidate.documentId,
        documentVersion: candidate.version,
        now,
        ttlMs: options.leaseMs,
      });
    } catch (error) {
      if (error instanceof RetrievalLeaseTargetUnavailableError) continue;
      throw error;
    }
    if (!await candidateStillLive(store, candidate, request)) {
      await releaseLease(store, lease.leaseId);
      continue;
    }
    const locator = signLocator({
      locatorVersion: 1,
      documentId: candidate.documentId,
      documentVersion: candidate.version,
      windowOrdinal: candidate.location.windowOrdinal,
      matchRange: {
        startByte: candidate.location.startByte,
        endByte: candidate.location.endByte,
      },
      indexGeneration: collected.generation,
      leaseId: lease.leaseId,
      project: request.project,
      sessionId: candidate.source.sessionId,
      scope: request.effectiveScope,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
    }, secret);
    results.push({
      documentId: candidate.documentId,
      version: candidate.version,
      kind: candidate.kind,
      score: candidate.normalizedScore,
      rawScore: candidate.rawScore ?? candidate.score,
      calibratedScore: candidate.normalizedScore,
      retrievalMode: candidate.retrievalMode,
      createdAt: candidate.createdAt,
      matchType: candidate.matchType,
      margin: candidate.margin,
      matchedAnchors: candidate.matchedAnchors ?? [],
      matchedTerms: candidate.matchedTerms ?? [],
      termCoverage: candidate.termCoverage ?? 0,
      termIdf: candidate.termIdf ?? [],
      maxNormalizedIdf: candidate.maxNormalizedIdf ?? 0,
      snippet: candidate.snippet,
      historical: true,
      superseded: false,
      locator,
      source: {
        sessionId: candidate.source.sessionId,
        project: request.project,
        ...(candidate.source.turnId ? { turnId: candidate.source.turnId } : {}),
        ...(candidate.source.messageKey ? { messageKey: candidate.source.messageKey } : {}),
      },
    });
    if (results.length === request.limit) break;
  }
  return results;
}

/** Exact-first, bounded, project-authorized archive search with leased locators. */
export async function searchArchive(store, request, options = {}) {
  requireStore(store);
  const normalized = normalizeRequest(request);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative timestamp.");
  // One resolved timestamp for the secret, the leases, and any recency decay
  // below keeps a (query, corpus, query-time) triple's score recomputable.
  const resolvedOptions = Object.freeze({ ...options, now });
  const secret = await getOrCreateLocatorSecret(store, {
    secret: resolvedOptions.secret,
    now,
  });
  const lexical = await store.snapshot((view) => collectCandidates(view, normalized, resolvedOptions));
  const undecayed = await broadenWithSemantic(lexical, normalized, resolvedOptions);
  const decay = recencyDecayContext(resolvedOptions, now);
  const candidateLimit = Math.min(100, Math.max(normalized.limit, normalized.limit * 3));
  const decayed = applyRecencyDecay(undecayed, decay, candidateLimit);
  const collected = resolvedOptions.applyImportancePrior === true
    ? await rankByImportance(store, decayed, normalized.project)
    : decayed;
  const results = await locateCandidates(store, collected, normalized, resolvedOptions, secret);
  let status = results.length === 0 ? "not-found" : "resolved";
  if (results.length > 0 && collected.mode === "structural"
    && ["ambiguous", "legacy-fallback"].includes(collected.structuralStatus)) {
    status = collected.structuralStatus;
  }
  const result = assertStoreResult("store.search", {
    mode: collected.mode,
    status,
    indexGeneration: collected.generation,
    results,
    expiredMatches: collected.expiredMatches,
  });
  // Implicit relevance feedback: hand the presented results (query, ranks,
  // modes, scores, locators) to an optional local recorder. The daemon supplies
  // a recorder that never throws; search behavior is otherwise unchanged.
  if (typeof options.recordShownResults === "function") {
    await options.recordShownResults({
      project: normalized.project,
      query: normalized.query,
      mode: result.mode,
      status: result.status,
      results: result.results,
      now,
    });
  }
  return result;
}
