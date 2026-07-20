import {
  assertStoreRequest,
  assertStoreResult,
} from "../store/store-contract.js";
import {
  DEFAULT_EXACT_SNIPPET_BYTES,
  lookupExact,
  MAX_EXACT_SNIPPET_BYTES,
  planExactQuery,
} from "../rocksdb/index/exact.js";
import {
  bm25InverseDocumentFrequency,
  DEFAULT_BM25_SEARCH_LIMITS,
  MAX_BM25_SNIPPET_CHARACTERS,
  readBm25Statistics,
  readDocumentTermVocabulary,
  searchBm25,
} from "../rocksdb/index/bm25.js";
import { tokenizeBm25Query } from "../rocksdb/index/tokenizer.js";
import { lookupStructuralAsync } from "../rocksdb/index/structural.js";
import { documentImportancePrior } from "../rocksdb/index/importance.js";
import {
  readNearDuplicateSignature,
  selectNearDuplicateRepresentatives,
} from "../rocksdb/index/simhash.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import { semanticIdentifier } from "../identity/semantic-identifiers.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { perEvidenceSnippetBudget } from "../presentation.js";
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

/**
 * Candidate pool size to fetch per mode and fuse over. Explicit search/gather
 * with an enabled cross-encoder reranker (options.reranker, never set by
 * automatic preflight) widens this to at least the reranker's own candidate
 * window: the eval that justified building the reranker
 * (eval/retrieval/reranker-verdict.json) measured its Recall@3/MRR recovery
 * over 40-candidate pools, so a caller-limit-scaled pool of 9-30 candidates
 * (the default limit=3..10 without this widening) would starve the reranker
 * of exactly the deeper, lower-fused-rank candidates it exists to promote.
 * Automatic preflight and any explicit search with the reranker disabled or
 * absent keep the original, cheaper limit-scaled pool.
 */
function resolveCandidateLimit(limit, reranker) {
  const base = Math.min(100, Math.max(limit, limit * 3));
  if (!reranker || reranker.enabled !== true) return base;
  const window = Number.isSafeInteger(reranker.candidateWindow) && reranker.candidateWindow > 0
    ? reranker.candidateWindow
    : base;
  return Math.max(base, window);
}
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

// Reciprocal Rank Fusion constant. 60 is the standard RRF default (Cormack
// et al.); it flattens the gap between adjacent ranks so one system's noisy
// tail cannot dominate the fused order.
const RRF_K = 60;
const TIER_ONE = 1;

// Rank fusion is most trustworthy near the head of a mode's own ranking and
// least trustworthy deep in its tail, so the RRF component's blend weight
// decays with rank instead of applying uniformly.
function rankFusionWeight(rank) {
  if (rank <= 3) return 0.75;
  if (rank <= 10) return 0.6;
  return 0.4;
}

/**
 * Cross-mode fusion keeps a hard tier boundary above lexical/semantic
 * (exact outranks everything; structural outranks lexical/semantic), but
 * BM25 and embedding-cosine scores are calibrated on unrelated curves, so
 * ordering *within* that shared tier by squashed score alone is
 * uncalibrated. RRF instead fuses each mode's own rank order — a candidate
 * found by more than one mode in the tier accumulates rank credit from
 * each — then blends the fused rank score with the candidate's own
 * normalized score, trusting the rank fusion most where rank order is most
 * reliable (near the head of each mode's list) and falling back toward the
 * calibrated score deeper in the tail. This only reorders lexical/semantic
 * candidates against each other; it never crosses the exact/structural tier
 * boundary and never changes the presented `score`.
 */
function withTierOneFusionScores(candidates) {
  const rankLists = new Map();
  for (const candidate of candidates) {
    if (MODE_PRIORITY[candidate.retrievalMode] !== TIER_ONE) continue;
    const list = rankLists.get(candidate.retrievalMode);
    if (list) list.push(candidate);
    else rankLists.set(candidate.retrievalMode, [candidate]);
  }
  const sortedLists = new Map();
  const fusionByIdentity = new Map();
  let maxRrf = 0;
  for (const [mode, rawList] of rankLists) {
    // Rank assignment below assumes each mode's list arrives best-first, but
    // re-fusion callers cannot guarantee that: broadenWithExpansion appends
    // requery-only candidates after the already-fused first pass, and
    // applyRecencyDecay re-fuses a list still ordered by pre-decay
    // fusionScore while scores have just been decayed. Sort explicitly by
    // this mode's own normalizedScore instead of trusting input order.
    const sorted = [...rawList].sort((left, right) => right.normalizedScore - left.normalizedScore);
    sortedLists.set(mode, sorted);
    // A mode can return multiple entries for the same document (e.g. one
    // per matched semantic span); those must collapse to a single rank
    // here, or a document would self-accumulate RRF credit across its own
    // spans as if it had been independently corroborated by another mode,
    // and would inflate maxRrf against every other candidate.
    const seenInMode = new Set();
    let rank = 0;
    let previousScore;
    for (const candidate of sorted) {
      const identity = candidateIdentity(candidate);
      if (seenInMode.has(identity)) continue;
      seenInMode.add(identity);
      // A run of exactly tied normalizedScore candidates shares one rank
      // instead of advancing per-candidate: a mode's own scan/insertion
      // order among ties (e.g. BM25's recency-then-documentId tiebreak) is
      // not a relevance signal, so treating it as one is exactly the kind
      // of uncalibrated-position noise this fusion exists to avoid. Without
      // this, two genuinely tied lexical candidates would get different RRF
      // credit purely from arbitrary scan order, masking the documentId
      // tiebreak that compareCandidates falls back to when scores tie.
      if (previousScore === undefined || candidate.normalizedScore !== previousScore) rank += 1;
      previousScore = candidate.normalizedScore;
      const entry = fusionByIdentity.get(identity) ?? { rrf: 0, bestRank: rank };
      entry.rrf += 1 / (RRF_K + rank);
      entry.bestRank = Math.min(entry.bestRank, rank);
      fusionByIdentity.set(identity, entry);
      maxRrf = Math.max(maxRrf, entry.rrf);
    }
  }
  const blendedFusionScore = (candidate) => {
    const entry = fusionByIdentity.get(candidateIdentity(candidate));
    const normalizedRrf = maxRrf > 0 ? entry.rrf / maxRrf : 0;
    const weight = rankFusionWeight(entry.bestRank);
    return (weight * normalizedRrf) + ((1 - weight) * candidate.normalizedScore);
  };
  // rankFusionWeight's rank-dependent blend trusts the RRF component most
  // near a mode's own head and the calibrated score most in its tail. At the
  // rank boundary where that trust shifts, the reallocation can hand a
  // lower-scored candidate a higher blended score than a strictly
  // higher-scored candidate earlier in that very same mode's own ranking.
  // Clamp each mode's blended scores to be non-increasing along its own
  // best-first order, so the blend can never invert an order the mode
  // itself already established.
  const clampedByModeIdentity = new Map();
  for (const [mode, sorted] of sortedLists) {
    const clampedForMode = new Map();
    let ceiling = Infinity;
    for (const candidate of sorted) {
      const identity = candidateIdentity(candidate);
      if (clampedForMode.has(identity)) continue;
      const clamped = Math.min(blendedFusionScore(candidate), ceiling);
      clampedForMode.set(identity, clamped);
      ceiling = clamped;
    }
    clampedByModeIdentity.set(mode, clampedForMode);
  }
  return candidates.map((candidate) => {
    if (MODE_PRIORITY[candidate.retrievalMode] !== TIER_ONE) {
      return { ...candidate, fusionScore: candidate.normalizedScore };
    }
    const fusionScore = clampedByModeIdentity.get(candidate.retrievalMode).get(candidateIdentity(candidate));
    return { ...candidate, fusionScore };
  });
}

function compareCandidates(left, right) {
  return MODE_PRIORITY[right.retrievalMode] - MODE_PRIORITY[left.retrievalMode]
    || right.fusionScore - left.fusionScore
    || (right.source.sessionId === left.source.sessionId ? 0 : 0)
    || String(left.documentId).localeCompare(String(right.documentId));
}

/** Exported for direct testing of RRF tier fusion against hand-built candidates. */
export function fuseCandidates(rawCandidates, limit) {
  const candidates = withTierOneFusionScores(rawCandidates);
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
 * Re-rank fused candidates by a bounded query-independent importance prior.
 * IMPORTANCE_PRIOR_MAX_MULTIPLIER is calibrated against each candidate's own
 * per-mode normalizedScore (a ~13% relevance-gap bound), not against
 * fusionScore, whose RRF position blend already compresses adjacent-rank
 * gaps within a mode — multiplying the prior directly onto fusionScore would
 * let a bounded 1.15x prior overrule a relevance gap RRF's own blend had
 * already narrowed, breaking the "prior can never overrule a strong
 * relevance gap" contract. Instead, apply the prior to a shadow copy of the
 * pre-fusion candidate pool's normalizedScore and re-run the same cross-mode
 * RRF fusion over that shadow pool, so a document's ranking position
 * reflects both the upstream cross-mode corroboration (the reason this
 * fusion tier exists) and a prior bounded relative to the calibrated
 * per-mode relevance scale, exactly as before. Every explicit search/gather
 * caller (src/daemon/operations.js) sets `applyImportancePrior: true`
 * unconditionally, so this ranking is what actually reaches results, not
 * just an intermediate candidate-truncation step. Applied to explicit search
 * ranking only; the automatic preflight path never sets this flag, so
 * frozen-hint scoring stays byte-identical.
 */
async function applyImportancePriors(view, collected, project) {
  const priorByIdentity = new Map();
  const shadowCandidates = [];
  for (const candidate of collected.rawCandidates) {
    const identity = candidateIdentity(candidate);
    let prior = priorByIdentity.get(identity);
    if (prior === undefined) {
      prior = await documentImportancePrior(view, {
        documentId: candidate.documentId,
        version: candidate.version,
        project,
      });
      priorByIdentity.set(identity, prior);
    }
    shadowCandidates.push({ ...candidate, normalizedScore: candidate.normalizedScore * prior });
  }
  const refused = fuseCandidates(shadowCandidates, shadowCandidates.length);
  const rankingScoreByIdentity = new Map(
    refused.map((candidate) => [candidateIdentity(candidate), candidate.fusionScore]),
  );
  const ranked = collected.candidates.map((candidate) => {
    const identity = candidateIdentity(candidate);
    return {
      ...candidate,
      importancePrior: priorByIdentity.get(identity),
      rankingScore: rankingScoreByIdentity.get(identity),
    };
  });
  return ranked.sort(compareRankedCandidates);
}

function preserveCandidateMargins(candidates) {
  // Margin is the confidence gap to the next-best candidate *of the same
  // mode*, an intrinsic property of the mode's own calibrated scores. It
  // must not be read off the array's presentation order: both RRF fusion
  // and importance-prior reordering can legitimately promote a candidate
  // above a same-mode candidate with a higher normalizedScore, and margin
  // computed against that position would go negative, violating its [0,1]
  // contract. Sorting by normalizedScore within each mode first guarantees
  // a non-negative margin regardless of how the caller's array is ordered.
  const byMode = new Map();
  for (const candidate of candidates) {
    const list = byMode.get(candidate.retrievalMode);
    if (list) list.push(candidate);
    else byMode.set(candidate.retrievalMode, [candidate]);
  }
  const marginByIdentity = new Map();
  for (const list of byMode.values()) {
    const sorted = [...list].sort((left, right) => right.normalizedScore - left.normalizedScore);
    sorted.forEach((candidate, index) => {
      const margin = candidate.normalizedScore - (sorted[index + 1]?.normalizedScore ?? 0);
      marginByIdentity.set(candidateIdentity(candidate), Number(margin.toFixed(6)));
    });
  }
  return candidates.map((candidate) => ({
    ...candidate,
    margin: marginByIdentity.get(candidateIdentity(candidate)),
  }));
}

// Render-time-only excerpt widening: opt-in per caller (never for automatic
// preflight, whose frozen hint bytes must stay unaffected by this). When
// enabled, split the request's evidence budget across its requested result
// count and let the underlying exact/BM25 snippet materializer widen its
// match-centered excerpt symmetrically up to that budget instead of always
// using the small fixed default. An explicit maxSnippetBytes/maxSnippetCharacters
// override always wins, preserving caller control.
function widenedSnippetOptions(mode, explicit, request, options) {
  if (!options.expandSnippetsToBudget) return explicit;
  const key = mode === "exact" ? "maxSnippetBytes" : "maxSnippetCharacters";
  if (explicit[key] !== undefined) return explicit;
  const bounds = mode === "exact"
    ? { min: DEFAULT_EXACT_SNIPPET_BYTES, max: MAX_EXACT_SNIPPET_BYTES }
    : { min: DEFAULT_BM25_SEARCH_LIMITS.maxSnippetCharacters, max: MAX_BM25_SNIPPET_CHARACTERS };
  const budget = perEvidenceSnippetBudget(request.hintBudgetTokens, request.limit, bounds);
  return { ...explicit, [key]: budget };
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

async function collectCandidates(view, request, options) {
  const generation = await publishedGeneration(view);
  const plan = planExactQuery(request.query);
  const candidateLimit = resolveCandidateLimit(request.limit, options.reranker);
  const candidates = [];
  let exactAttempted = false;
  let lexicalAttempted = false;
  let structuralAttempted = false;
  let structuralStatus;
  // Shared by the exact and lexical passes below so a document tombstoned
  // without a live replacement is counted once even when both indexes
  // independently retain a stale posting for it; bounded by what those
  // passes already scan, never a separate lookup.
  const expiredRetentionClasses = new Map();

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
      expiredRetentionClasses,
      ...widenedSnippetOptions("exact", options.exact ?? {}, request, options),
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
    }, { ...widenedSnippetOptions("bm25", options.bm25 ?? {}, request, options), expiredRetentionClasses });
    candidates.push(...lexicalCandidates(lexical));
  }
  const expiredMatches = Object.freeze({
    count: expiredRetentionClasses.size,
    retentionClasses: Object.freeze([...new Set(expiredRetentionClasses.values())].sort()),
  });

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
    // The pre-fusion pool, kept alongside the deduped `candidates` view.
    // fuseCandidates collapses same-identity duplicates down to one
    // surviving mode's copy per document; a later re-fusion pass (expansion,
    // recency decay) that only had the already-collapsed `candidates` to
    // work from would permanently lose whichever other mode's copy lost that
    // collapse, so it could never recompute genuine cross-mode RRF credit
    // for that document again. Re-fusion passes fuse over this pool instead.
    rawCandidates: Object.freeze(candidates),
    mode: responseMode({ exactAttempted, lexicalAttempted, structuralAttempted }),
    exactAttempted,
    lexicalAttempted,
    structuralAttempted,
    structuralStatus,
    expiredMatches,
  });
}

// RM3/Bo1-style pseudo-relevance feedback. Fully deterministic and index-only
// (no model call): the first BM25 pass already exposes per-term document
// frequency, so "informative" expansion terms are just the top-k results'
// own vocabulary ranked by corpus-wide IDF. Capped to bound the one allowed
// requery's cost and keep the expanded query from drifting off-topic.
const DEFAULT_EXPANSION_CANDIDATE_DOCUMENTS = 3;
const DEFAULT_EXPANSION_TERM_LIMIT = 8;
const DEFAULT_EXPANSION_MINIMUM_LEXICAL_SCORE = 0.55;
const DEFAULT_EXPANSION_MINIMUM_TERM_COVERAGE = 0.5;

// Query expansion never participates in automatic preflight: it is gated
// behind an explicit `options.allowExpansion` opt-in that only the explicit
// store.search path sets (see src/daemon/operations.js). preflightArchive
// never sets it, so this predicate is unreachable from the automatic path
// regardless of how weak the evidence looks.
function shouldTryExpansion(collected, request, options) {
  if (options.allowExpansion !== true) return false;
  if (request.expansionPolicy === "never" || request.query.trim().length === 0) return false;
  if (collected.candidates.some(({ retrievalMode }) => retrievalMode === "exact")) return false;
  const lexical = collected.candidates.find(({ retrievalMode }) => retrievalMode === "lexical");
  return lexical === undefined
    || lexical.normalizedScore < (options.expansionMinimumLexicalScore ?? DEFAULT_EXPANSION_MINIMUM_LEXICAL_SCORE)
    || lexical.termCoverage < (options.expansionMinimumTermCoverage ?? DEFAULT_EXPANSION_MINIMUM_TERM_COVERAGE);
}

/** Rank the top-k first-pass documents' own vocabulary by corpus-wide IDF. */
async function selectExpansionTerms(view, collected, request, options) {
  const documentLimit = options.expansionCandidateDocuments ?? DEFAULT_EXPANSION_CANDIDATE_DOCUMENTS;
  const termLimit = options.expansionTermLimit ?? DEFAULT_EXPANSION_TERM_LIMIT;
  const topDocuments = collected.candidates
    .filter(({ retrievalMode }) => retrievalMode === "lexical")
    .slice(0, documentLimit);
  if (topDocuments.length === 0) return Object.freeze([]);
  // Agent-supplied expansionTerms are already part of the effective first-pass
  // query (see the lexicalAllowed branch above), so their stemmed forms must
  // stay out of the candidate vocabulary too - otherwise a term the agent
  // asked for can get re-selected and mislabeled as system RM3 provenance.
  const queryTerms = new Set([
    ...tokenizeBm25Query(request.query, { maxTerms: options.bm25?.maxQueryTerms }),
    ...tokenizeBm25Query((request.expansionTerms ?? []).join(" "), { maxTerms: options.bm25?.maxQueryTerms }),
  ]);
  const vocabulary = new Set();
  for (const candidate of topDocuments) {
    const terms = await readDocumentTermVocabulary(view, {
      project: request.project,
      documentId: candidate.documentId,
      version: candidate.version,
    });
    for (const term of terms) {
      if (!queryTerms.has(term)) vocabulary.add(term);
    }
  }
  if (vocabulary.size === 0) return Object.freeze([]);
  const statistics = await readBm25Statistics(view, {
    project: request.project,
    terms: [...vocabulary],
    generation: collected.generation,
  });
  if (!statistics.corpus || statistics.corpus.documentCount === 0) return Object.freeze([]);
  const documentCount = statistics.corpus.documentCount;
  const maximumIdf = bm25InverseDocumentFrequency(documentCount, 1);
  const ranked = [...vocabulary]
    .map((term) => {
      const documentFrequency = statistics.terms[term]?.documentFrequency;
      if (!documentFrequency || documentFrequency <= 0) return undefined;
      const idf = bm25InverseDocumentFrequency(documentCount, documentFrequency);
      return { term, normalizedIdf: maximumIdf === 0 ? 0 : idf / maximumIdf };
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.normalizedIdf - left.normalizedIdf || left.term.localeCompare(right.term))
    .slice(0, termLimit);
  return Object.freeze(ranked.map(({ term }) => term));
}

/** Run the one allowed requery with system-selected expansion terms merged into the query. */
async function broadenWithExpansion(store, collected, request, options) {
  if (!shouldTryExpansion(collected, request, options)) return collected;
  const expansionTerms = await store.snapshot((view) => selectExpansionTerms(view, collected, request, options));
  if (expansionTerms.length === 0) return collected;
  const expandedRequest = {
    // Carry agent-supplied expansionTerms into the requery too, matching the
    // first pass (lexicalAllowed branch above): otherwise a document that
    // only matches via an agent-supplied term would win the first pass but
    // silently lose ranking/coverage once expansion decides to run.
    query: [request.query, ...(request.expansionTerms ?? [])].join(" "),
    // Already-stemmed index vocabulary goes in as literalTerms, not appended
    // text: Porter stemming is not idempotent, so re-tokenizing an already
    // stemmed term through the query-string path can rewrite it into a
    // different term with zero postings (e.g. "univers" -> "univ").
    literalTerms: expansionTerms,
    project: request.project,
    scope: request.effectiveScope,
    sessionIds: request.sessionIds,
    excludeVisibleSourceKeys: request.excludeVisibleSourceKeys,
    limit: resolveCandidateLimit(request.limit, options.reranker),
    // No generation pin here: this requery opens its own snapshot after the
    // first pass has already closed, and searchBm25 only accepts a
    // generation equal to the currently published one. Pinning the
    // first-pass generation would throw whenever a publish lands between
    // the two snapshots; letting it resolve to whatever is current keeps
    // expansion best-effort instead of making explicit search racy.
  };
  const requeried = await store.snapshot((view) => searchBm25(view, expandedRequest, options.bm25));
  const expandedTermSet = new Set(expansionTerms);
  // A document the first pass already matched keeps its first-pass score,
  // matchedTerms, and termCoverage: fuseCandidates otherwise prefers the
  // higher-scoring requery copy (more terms matched against the same doc),
  // which would silently restate that document's coverage against the
  // system-expanded query instead of the user's actual query. Expansion only
  // adds documents the first pass never surfaced.
  const alreadyCollected = new Set(collected.candidates.map((candidate) => candidateIdentity(candidate)));
  const expandedCandidates = requeried.results
    .filter((result) => !alreadyCollected.has(candidateIdentity(result)))
    .map((result) => ({
      ...result,
      retrievalMode: "lexical",
      normalizedScore: normalizeModeScore("lexical", result.rawScore),
      matchedAnchors: Object.freeze([]),
      // Provenance: only the expansion terms this specific result actually
      // matched, so `/window recall why` can explain the match without
      // implying every attempted expansion term was found here.
      expandedTerms: Object.freeze(result.matchedTerms.filter((term) => expandedTermSet.has(term))),
    }));
  const limit = resolveCandidateLimit(request.limit, options.reranker);
  // Re-fuse over the pre-fusion pool, not the already-deduped `candidates`
  // view: fusing over the deduped view would only ever see one surviving
  // mode's copy per document and could never recompute cross-mode RRF credit
  // for a document whose other-mode copy was already collapsed away.
  const rawCandidates = Object.freeze([...collected.rawCandidates, ...expandedCandidates]);
  const candidates = preserveCandidateMargins(fuseCandidates(rawCandidates, limit));
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(candidates),
    rawCandidates,
    expansionTerms: Object.freeze(expansionTerms),
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
  // Fuse over the pre-fusion pool (see broadenWithExpansion) so a document
  // whose lexical copy already lost the identity collapse still contributes
  // its lexical rank to this pass's cross-mode RRF recomputation.
  const rawCandidates = Object.freeze([
    ...collected.rawCandidates,
    ...semanticCandidates(results, collected.generation),
  ]);
  const candidates = preserveCandidateMargins(
    fuseCandidates(rawCandidates, resolveCandidateLimit(request.limit, options.reranker)),
  );
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(candidates),
    rawCandidates,
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
 * below, which reads whatever fusionScore this re-fusion produces.
 */
function applyRecencyDecay(collected, decay, candidateLimit) {
  if (decay === undefined) return collected;
  // Decay (and re-fuse) over the pre-fusion pool, not the already-deduped
  // `candidates` view: see collectCandidates' rawCandidates comment. Fusing
  // over the deduped view here would have permanently discarded whichever
  // mode's copy lost the identity collapse in the prior pass, and could
  // never recompute genuine cross-mode RRF credit for that document again.
  const decayed = collected.rawCandidates.map((candidate) => {
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
    rawCandidates: Object.freeze(decayed),
  });
}

/**
 * Apply the importance prior to the final candidate set, after semantic
 * broadening and any recency decay. See applyImportancePriors for why this
 * re-fuses over the pre-fusion pool (collected.rawCandidates) instead of
 * ranking the already-deduped `candidates` view directly.
 */
async function rankByImportance(store, collected, project) {
  const ranked = await store.snapshot((view) => applyImportancePriors(view, collected, project));
  return Object.freeze({
    ...collected,
    candidates: Object.freeze(preserveCandidateMargins(ranked)),
  });
}

/**
 * Cross-encoder rerank of the lexical/semantic tier only (deferred task #2;
 * see eval/retrieval/reranker-verdict.json for the offline decision this
 * reproduces through the real tool surface). Runs after the importance prior
 * (so the reranker sees the same candidate order/text explicit search would
 * otherwise present) and before near-duplicate dedup, so dedup's
 * representative-per-cluster choice reflects the reranked order and
 * diversity is preserved among what the reranker actually promoted. Exact and
 * structural candidates never reach `reranker.rerank` (see LocalReranker),
 * so they keep their absolute priority-tier precedence regardless of this
 * step. A caller that never sets `options.reranker` (every automatic
 * preflight call) skips this entirely -- `options.reranker` is undefined, so
 * the ternary below never even constructs the ranked-candidates array.
 */
async function rerankTierOne(reranker, collected, request) {
  if (!reranker || typeof reranker.rerank !== "function") return collected;
  const reranked = await reranker.rerank(request.query, collected.candidates);
  if (reranked === collected.candidates) return collected;
  return Object.freeze({ ...collected, candidates: Object.freeze(reranked) });
}

/**
 * Collapse near-duplicate candidates (repeated test/build output) into one
 * representative per cluster, reporting the suppressed count on the survivor.
 * Runs after semantic broadening (not inside collectCandidates) so a semantic
 * candidate added later still competes for the same cluster instead of always
 * winning the slot silently, undetected. Signatures are a versioned derived
 * index; a candidate without a "complete" one is never clustered, so evidence
 * we cannot fully fingerprint is shown rather than hidden.
 */
async function annotateNearDuplicates(store, collected, request, options = {}) {
  const { candidates } = collected;
  if (candidates.length <= 1) return collected;
  const signatures = await store.snapshot(async (view) => {
    const map = new Map();
    for (const candidate of candidates) {
      const simhash = await readNearDuplicateSignature(
        view,
        request.project,
        candidate.documentId,
        candidate.version,
      );
      if (simhash !== undefined) map.set(candidate, simhash);
    }
    return map;
  });
  const representatives = selectNearDuplicateRepresentatives(candidates, {
    ...(options.maxHammingDistance === undefined
      ? {}
      : { maxHammingDistance: options.maxHammingDistance }),
    signatureOf: (candidate) => signatures.get(candidate),
  });
  const deduped = representatives.map(({ item, nearDuplicates }) => (
    nearDuplicates > 0 ? { ...item, nearDuplicates } : item
  ));
  return Object.freeze({ ...collected, candidates: Object.freeze(deduped) });
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
      expandedTerms: candidate.expandedTerms ?? [],
      snippet: candidate.snippet,
      historical: true,
      superseded: false,
      ...(candidate.nearDuplicates > 0 ? { nearDuplicates: candidate.nearDuplicates } : {}),
      // Provenance for `/window recall why`-style explanations, matching the
      // RM3 expandedTerms precedent: present only when this specific result
      // was actually reordered by the cross-encoder (LocalReranker.rerank),
      // never a blanket flag for every explicit search.
      ...(candidate.reranked === true ? { reranked: true } : {}),
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
  // Cheap, deterministic, index-only broadening runs before the heavier
  // (and only conditionally available) semantic fallback.
  const expanded = await broadenWithExpansion(store, lexical, normalized, resolvedOptions);
  const undecayed = await broadenWithSemantic(expanded, normalized, resolvedOptions);
  const decay = recencyDecayContext(resolvedOptions, now);
  const candidateLimit = resolveCandidateLimit(normalized.limit, resolvedOptions.reranker);
  const decayed = applyRecencyDecay(undecayed, decay, candidateLimit);
  const ranked = resolvedOptions.applyImportancePrior === true
    ? await rankByImportance(store, decayed, normalized.project)
    : decayed;
  // Cross-encoder rerank of the lexical/semantic tier, explicit search/gather
  // only (resolvedOptions.reranker, set by the daemon's store.search/gather
  // operations -- see rerankTierOne above). Automatic preflight never sets
  // this option, so frozen hints stay byte-identical.
  const reranked = await rerankTierOne(resolvedOptions.reranker, ranked, normalized);
  // Dedup is an explicit-search affordance only (options.dedupe, set by the
  // daemon's store.search operation). The automatic preflight path never opts
  // in, so frozen hints stay byte-identical. Runs last, over the fully ranked
  // set (semantic broadening + recency decay + importance prior + rerank all
  // applied), so the representative kept per cluster is whichever member the
  // final ranking actually prefers.
  const collected = resolvedOptions.dedupe === true
    ? await annotateNearDuplicates(store, reranked, normalized, resolvedOptions.nearDuplicate ?? {})
    : reranked;
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
      sessionIds: normalized.sessionIds,
      now,
    });
  }
  return result;
}
