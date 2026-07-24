import { encodeKey, KEYSPACE } from "../keys.js";
import { manifestKeys, retiredDocumentStatus } from "../manifests.js";
import { readDocumentRange } from "../document-range.js";
import { semanticIdentifier } from "../../identity/semantic-identifiers.js";
import { assertVisibleSourceKeys } from "../../store/store-contract.js";
import { DEFAULT_RETENTION_CLASS_BY_KIND } from "../../daemon/retention-policy.js";
import {
  derivedViewKeys,
  documentOrdinalLiveness,
  isDerivedViewQueryCutover,
} from "../derived-view.js";
import { tokenizeBm25Query } from "./tokenizer.js";
import {
  bm25Keys,
  compareStrings,
  finite,
  identifier,
  MAX_SCAN_LIMIT,
  positiveInteger,
  readBm25Statistics,
  requireView,
  resolveGeneration,
} from "./bm25-keys.js";
import {
  decodePostingLocator,
  isPostingLocator,
  POSTING_LOCATOR_KIND,
} from "./posting-locator.js";
import {
  decodeBm25PostingBlock,
  isPostingBlock,
} from "./posting-block.js";

export const DEFAULT_BM25_PARAMETERS = Object.freeze({ k1: 1.2, b: 0.75 });
export const DEFAULT_BM25_SEARCH_LIMITS = Object.freeze({
  maxQueryTerms: 20,
  maxPostingRecords: 10_000,
  maxPhysicalPostingRecords: MAX_SCAN_LIMIT,
  maxWindowCandidates: 4_000,
  maxSnippetCharacters: 280,
  maxLineageSessions: 64,
});
export const MAX_BM25_SNIPPET_CHARACTERS = 2_000;

/** Summarize a retention-class-by-documentId map into the public count/class
 * shape; never includes expired content, only a count and its class(es). */
function summarizeExpiredMatches(expiredRetentionClasses) {
  return Object.freeze({
    count: expiredRetentionClasses.size,
    retentionClasses: Object.freeze([...new Set(expiredRetentionClasses.values())].sort()),
  });
}

/** Best-effort retention-class label for an honesty count only; the manifest
 * that recorded the real class is exactly what already went missing. */
function fallbackRetentionClass(kind) {
  return DEFAULT_RETENTION_CLASS_BY_KIND[kind] ?? "conversation-source";
}

function normalizeParameters(options = {}) {
  return Object.freeze({
    k1: finite(options.k1 ?? DEFAULT_BM25_PARAMETERS.k1, "k1", { minimum: 0.01, maximum: 10 }),
    b: finite(options.b ?? DEFAULT_BM25_PARAMETERS.b, "b", { minimum: 0, maximum: 1 }),
  });
}

/** Standard Robertson/Sparck Jones BM25 inverse-document-frequency term. */
export function bm25InverseDocumentFrequency(documentCount, documentFrequency) {
  positiveInteger(documentCount, "documentCount");
  positiveInteger(documentFrequency, "documentFrequency");
  if (documentFrequency > documentCount) {
    throw new RangeError("documentFrequency must not exceed documentCount.");
  }
  return Math.log(1 + ((documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5)));
}

/** Score one query term in one logical window. */
export function bm25TermScore({
  termFrequency,
  documentLength,
  averageDocumentLength,
  documentFrequency,
  documentCount,
  k1 = DEFAULT_BM25_PARAMETERS.k1,
  b = DEFAULT_BM25_PARAMETERS.b,
} = {}) {
  // Field weighting makes both inputs weighted sums rather than raw counts,
  // so they are finite positive numbers rather than integers; an unweighted
  // (neutral-weight) caller still passes plain integers, which satisfy the
  // same bounds and score identically to the pre-field-weighting formula.
  finite(termFrequency, "termFrequency", { minimum: Number.MIN_VALUE });
  finite(documentLength, "documentLength");
  finite(averageDocumentLength, "averageDocumentLength");
  const parameters = normalizeParameters({ k1, b });
  const idf = bm25InverseDocumentFrequency(documentCount, documentFrequency);
  const normalizedLength = averageDocumentLength === 0 ? 0 : documentLength / averageDocumentLength;
  const denominator = termFrequency + (parameters.k1 * (1 - parameters.b + (parameters.b * normalizedLength)));
  return idf * ((termFrequency * (parameters.k1 + 1)) / denominator);
}

/** Recompute a result score using only its persisted-statistics explanation. */
export function recomputeBm25Score(explanation) {
  if (!explanation || explanation.formula !== "BM25" || !Array.isArray(explanation.terms)) {
    throw new TypeError("A BM25 score explanation is required.");
  }
  return explanation.terms.reduce((total, term) => total + bm25TermScore({
    termFrequency: term.termFrequency,
    documentLength: explanation.documentLength,
    averageDocumentLength: explanation.averageDocumentLength,
    documentFrequency: term.documentFrequency,
    documentCount: explanation.documentCount,
    k1: explanation.k1,
    b: explanation.b,
  }), 0);
}

/** Recompute lexical match evidence using only one returned score explanation. */
export function recomputeBm25Evidence(explanation) {
  if (!explanation || explanation.formula !== "BM25" || !Array.isArray(explanation.terms)) {
    throw new TypeError("A BM25 score explanation is required.");
  }
  const queryTermCount = positiveInteger(explanation.queryTermCount, "queryTermCount");
  const documentCount = positiveInteger(explanation.documentCount, "documentCount");
  if (explanation.terms.length > queryTermCount) {
    throw new RangeError("Matched BM25 terms must not exceed the query term count.");
  }
  const maximumIdf = bm25InverseDocumentFrequency(documentCount, 1);
  const matchedTerms = [];
  const termIdf = [];
  const seen = new Set();
  for (const term of explanation.terms) {
    identifier(term?.term, "matched term");
    if (seen.has(term.term)) throw new TypeError("Matched BM25 terms must be unique.");
    seen.add(term.term);
    matchedTerms.push(term.term);
    const idf = bm25InverseDocumentFrequency(documentCount, term.documentFrequency);
    termIdf.push(Object.freeze({
      term: term.term,
      idf,
      normalizedIdf: idf / maximumIdf,
    }));
  }
  return Object.freeze({
    matchedTerms: Object.freeze(matchedTerms),
    termCoverage: matchedTerms.length / queryTermCount,
    termIdf: Object.freeze(termIdf),
    maxNormalizedIdf: termIdf.reduce(
      (maximum, evidence) => Math.max(maximum, evidence.normalizedIdf),
      0,
    ),
  });
}

function postingPositions(window) {
  if (window.positionsEncoding !== "delta-v1") return window.positions;
  if (!Array.isArray(window.positionDeltas) || window.positionDeltas.length % 3 !== 0) {
    throw new Error("BM25 posting position deltas are malformed.");
  }
  const positions = [];
  let position = 0;
  let startByte = window.startByte;
  for (let index = 0; index < window.positionDeltas.length; index += 3) {
    position += window.positionDeltas[index];
    startByte += window.positionDeltas[index + 1];
    positions.push(Object.freeze({
      position,
      startByte,
      endByte: startByte + window.positionDeltas[index + 2],
    }));
  }
  return Object.freeze(positions);
}

function normalizeSearchOptions(options = {}) {
  const bounded = (value, fallback, label, maximum) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
      throw new RangeError(`${label} must be between 1 and ${maximum}.`);
    }
    return result;
  };
  return Object.freeze({
    limit: bounded(options.limit, 3, "limit", 100),
    maxQueryTerms: bounded(
      options.maxQueryTerms,
      DEFAULT_BM25_SEARCH_LIMITS.maxQueryTerms,
      "maxQueryTerms",
      100,
    ),
    maxPostingRecords: bounded(
      options.maxPostingRecords,
      DEFAULT_BM25_SEARCH_LIMITS.maxPostingRecords,
      "maxPostingRecords",
      MAX_SCAN_LIMIT,
    ),
    maxPhysicalPostingRecords: bounded(
      options.maxPhysicalPostingRecords,
      DEFAULT_BM25_SEARCH_LIMITS.maxPhysicalPostingRecords,
      "maxPhysicalPostingRecords",
      MAX_SCAN_LIMIT,
    ),
    maxWindowCandidates: bounded(
      options.maxWindowCandidates,
      DEFAULT_BM25_SEARCH_LIMITS.maxWindowCandidates,
      "maxWindowCandidates",
      MAX_SCAN_LIMIT,
    ),
    maxSnippetCharacters: bounded(
      options.maxSnippetCharacters,
      DEFAULT_BM25_SEARCH_LIMITS.maxSnippetCharacters,
      "maxSnippetCharacters",
      MAX_BM25_SNIPPET_CHARACTERS,
    ),
    maxLineageSessions: bounded(
      options.maxLineageSessions,
      DEFAULT_BM25_SEARCH_LIMITS.maxLineageSessions,
      "maxLineageSessions",
      1_000,
    ),
    ...normalizeParameters(options),
  });
}

function normalizeSearchRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("BM25 search request must be an object.");
  }
  const scope = request.scope ?? "session";
  if (!["session", "project", "all"].includes(scope)) {
    throw new TypeError("scope must be session, project, or all.");
  }
  const sessionIds = request.sessionIds ?? (request.sessionId === undefined ? [] : [request.sessionId]);
  if (!Array.isArray(sessionIds)
    || sessionIds.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("sessionIds must be an array of non-empty strings.");
  }
  if (scope === "session" && sessionIds.length === 0) {
    throw new TypeError("Session-scoped BM25 search requires sessionId or sessionIds.");
  }
  const excluded = assertVisibleSourceKeys(request.excludeVisibleSourceKeys ?? []);
  const literalTerms = request.literalTerms ?? [];
  if (!Array.isArray(literalTerms)
    || literalTerms.some((term) => typeof term !== "string" || term.length === 0)) {
    throw new TypeError("literalTerms must be an array of non-empty strings.");
  }
  return Object.freeze({
    ...request,
    project: identifier(request.project, "project"),
    query: identifier(request.query, "query"),
    scope,
    sessionIds: Object.freeze([...new Set(sessionIds)]),
    excludeVisibleSourceKeys: Object.freeze([...new Set(excluded)]),
    // Already-normalized terms (e.g. RM3 expansion vocabulary read straight
    // from the index) that must query postings by exact match. Porter
    // stemming is not idempotent, so routing these back through the
    // query-string tokenizer/stemmer can turn a valid stemmed term into a
    // different one with zero postings; literalTerms skips that round trip.
    literalTerms: Object.freeze([...new Set(literalTerms)]),
  });
}

function scopeAllows(posting, request) {
  if (request.scope === "all") return true;
  if (request.scope === "project") return true;
  return request.sessionIds.includes(posting.sessionId);
}

function visibleSource(posting, excluded) {
  if (excluded.size === 0) return false;
  return posting.sourceMessageKeys.some((sourceKey) => excluded.has(sourceKey));
}

function comparePostingRecency(left, right) {
  const leftBucket = left.payload?.bucket ?? left.key[8];
  const rightBucket = right.payload?.bucket ?? right.key[8];
  const leftCreatedAt = left.payload?.createdAt ?? left.key[9];
  const rightCreatedAt = right.payload?.createdAt ?? right.key[9];
  return rightBucket - leftBucket
    || rightCreatedAt - leftCreatedAt
    || Buffer.compare(right.keyBytes, left.keyBytes);
}

async function resolveSessionPostingLocators(view, records) {
  const resolved = [];
  let canonicalPostingsRead = 0;
  for (const record of records) {
    if (!isPostingLocator(record.payload)) {
      resolved.push(record);
      continue;
    }
    const locator = decodePostingLocator(
      record.payload,
      POSTING_LOCATOR_KIND.BM25_SESSION,
    );
    if (locator.targets.length !== 1) {
      throw new Error("BM25 session posting locator must have exactly one canonical target.");
    }
    const [
      ,
      ,
      ,
      ,
      ,
      project,
      sessionId,
      term,
      bucket,
      createdAt,
      documentId,
      version,
      generation,
      windowOrdinal,
    ] = record.key;
    const expected = encodeKey(bm25Keys.posting(
      project,
      term,
      bucket,
      createdAt,
      documentId,
      version,
      generation,
      windowOrdinal,
    ));
    if (!locator.targets[0].equals(expected)) {
      throw new Error("BM25 session posting locator does not match its canonical key.");
    }
    const stored = await view.get(locator.targets[0]);
    canonicalPostingsRead += 1;
    if (stored === undefined) continue;
    const payload = isPostingBlock(stored) ? decodeBm25PostingBlock(stored) : stored;
    if (payload.sessionId !== sessionId) {
      throw new Error("BM25 session posting locator crosses session scope.");
    }
    resolved.push(Object.freeze({ ...record, payload }));
  }
  return Object.freeze({
    records: Object.freeze(resolved),
    canonicalPostingsRead,
  });
}

async function scanTermPostings(view, project, term, request, limit) {
  if (request.scope !== "session") {
    const records = view.scan(bm25Keys.postingPrefix(project, term), {
      reverse: true,
      limit,
    });
    return Object.freeze({
      records,
      recordsScanned: records.length,
      canonicalPostingsRead: 0,
      truncated: records.length === limit,
    });
  }
  const states = request.sessionIds.map((sessionId) => ({
    prefix: bm25Keys.sessionPostingPrefix(project, sessionId, term),
    records: [],
    consumed: 0,
    before: undefined,
    exhausted: false,
  }));
  const records = [];
  let recordsScanned = 0;
  // Session records may be compact locators that require one canonical point
  // read. Reserve half the physical budget for that worst case so the whole
  // term remains bounded even when every selected record is a locator.
  const recordLimit = Math.max(1, Math.floor(limit / 2));
  let scanBudgetExhausted = false;
  const available = (state) => {
    if (state.consumed < state.records.length) return true;
    if (state.exhausted) return false;
    if (recordsScanned >= recordLimit) {
      scanBudgetExhausted = true;
      return false;
    }
    state.records = view.scan(state.prefix, {
      reverse: true,
      limit: 1,
      ...(state.before === undefined ? {} : { before: state.before }),
    });
    state.consumed = 0;
    state.exhausted = state.records.length === 0;
    recordsScanned += state.records.length;
    if (state.records.at(-1)?.keyBytes !== undefined) {
      state.before = state.records.at(-1).keyBytes;
    }
    return state.consumed < state.records.length;
  };
  while (records.length < recordLimit) {
    let newest;
    for (const state of states) {
      if (!available(state)) continue;
      const record = state.records[state.consumed];
      if (newest === undefined || comparePostingRecency(record, newest.record) < 0) {
        newest = { state, record };
      }
    }
    if (newest === undefined) break;
    records.push(newest.record);
    newest.state.consumed += 1;
  }
  const truncated = scanBudgetExhausted || (records.length === recordLimit && states.some((state) =>
    state.consumed < state.records.length || !state.exhausted));
  const hydrated = await resolveSessionPostingLocators(view, records);
  return Object.freeze({
    records: hydrated.records,
    recordsScanned,
    canonicalPostingsRead: hydrated.canonicalPostingsRead,
    truncated,
  });
}

function snippetForCandidate(sourceText, candidate, maxCharacters, sourceRange) {
  const codePoints = Array.from(sourceText);
  const firstPosition = [...candidate.evidence.values()]
    .flatMap(({ positions }) => positions)
    .sort((left, right) => left.startByte - right.startByte)[0];
  if (!firstPosition) return codePoints.slice(0, maxCharacters).join("");
  const localStart = Math.max(0, firstPosition.startByte - sourceRange.startByte);
  const localEnd = Math.min(
    sourceRange.endByte - sourceRange.startByte,
    firstPosition.endByte - sourceRange.startByte,
  );
  let byte = 0;
  let matchStart = 0;
  let matchEnd = codePoints.length;
  for (let index = 0; index < codePoints.length; index += 1) {
    const next = byte + Buffer.byteLength(codePoints[index], "utf8");
    if (byte <= localStart && localStart < next) matchStart = index;
    if (byte < localEnd && localEnd <= next) {
      matchEnd = index + 1;
      break;
    }
    byte = next;
  }
  const contentBudget = Math.max(1, maxCharacters - 4);
  const matchPoints = codePoints.slice(matchStart, matchEnd).slice(0, contentBudget);
  const availableContext = Math.max(0, contentBudget - matchPoints.length);
  const start = Math.max(0, matchStart - Math.floor(availableContext / 2));
  const end = Math.min(codePoints.length, matchEnd + (availableContext - (matchStart - start)));
  const beforePoints = codePoints.slice(start, matchStart);
  const afterPoints = codePoints.slice(matchEnd, end);
  const render = () => [
    ...(sourceRange.startByte > candidate.startByte || start > 0 ? ["…"] : []),
    ...beforePoints,
    "[",
    ...matchPoints,
    "]",
    ...afterPoints,
    ...(sourceRange.endByte < candidate.endByte
      || end < codePoints.length
      || matchPoints.length < matchEnd - matchStart
      || firstPosition.endByte > sourceRange.endByte
      ? ["…"]
      : []),
  ];
  let rendered = render();
  while (rendered.length > maxCharacters && afterPoints.length > 0) {
    afterPoints.pop();
    rendered = render();
  }
  while (rendered.length > maxCharacters && beforePoints.length > 0) {
    beforePoints.shift();
    rendered = render();
  }
  while (rendered.length > maxCharacters && matchPoints.length > 1) {
    matchPoints.pop();
    rendered = render();
  }
  return rendered.slice(0, maxCharacters).join("");
}

function matchRange(candidate) {
  const position = [...candidate.evidence.values()]
    .flatMap(({ positions }) => positions)
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte)[0];
  if (!position) throw new Error("A BM25 candidate has no persisted match position.");
  return Object.freeze({ startByte: position.startByte, endByte: position.endByte });
}

function candidateScore(candidate, statistics, parameters, queryTermCount) {
  const terms = [];
  for (const [term, evidence] of [...candidate.evidence].sort(([left], [right]) => compareStrings(left, right))) {
    const termStatistics = statistics.terms[term];
    if (!termStatistics || termStatistics.documentFrequency <= 0) continue;
    // The formula scores BM25F-weighted term frequency and window length
    // (weight 1 everywhere a document has no resolvable structural
    // messages), not the raw occurrence counts also carried on evidence.
    const score = bm25TermScore({
      termFrequency: evidence.weightedTermFrequency,
      documentLength: candidate.weightedLength,
      averageDocumentLength: statistics.corpus.averageWeightedDocumentLength,
      documentFrequency: termStatistics.documentFrequency,
      documentCount: statistics.corpus.documentCount,
      ...parameters,
    });
    terms.push(Object.freeze({
      term,
      termFrequency: evidence.weightedTermFrequency,
      documentFrequency: termStatistics.documentFrequency,
      statisticsGeneration: termStatistics.generation,
      score,
      positions: Object.freeze(evidence.positions.map((position) => Object.freeze({ ...position }))),
    }));
  }
  const explanation = Object.freeze({
    formula: "BM25",
    k1: parameters.k1,
    b: parameters.b,
    statisticsGeneration: statistics.generation,
    corpusStatisticsGeneration: statistics.corpus.generation,
    documentCount: statistics.corpus.documentCount,
    documentLength: candidate.weightedLength,
    averageDocumentLength: statistics.corpus.averageWeightedDocumentLength,
    queryTermCount,
    terms: Object.freeze(terms),
  });
  return Object.freeze({
    score: recomputeBm25Score(explanation),
    explanation,
    retrievalEvidence: recomputeBm25Evidence(explanation),
  });
}

/** Bounded least-common-first posting merge and deterministic BM25 ranking. */
export async function searchBm25(view, request = {}, options = {}) {
  if (view && typeof view.snapshot === "function") {
    return view.snapshot((snapshot) => searchBm25(snapshot, request, options));
  }
  requireView(view);
  const searchRequest = normalizeSearchRequest(request);
  const { project, query } = searchRequest;
  const normalized = normalizeSearchOptions({ ...options, limit: searchRequest.limit ?? options.limit });
  if (normalized.maxSnippetCharacters < 8) {
    throw new RangeError("maxSnippetCharacters must be at least 8.");
  }
  if (searchRequest.sessionIds.length > normalized.maxLineageSessions) {
    throw new RangeError(`sessionIds exceeds the ${normalized.maxLineageSessions} session lineage limit.`);
  }
  const publishedGeneration = await resolveGeneration(view);
  if (searchRequest.generation !== undefined
    && positiveInteger(searchRequest.generation, "generation") !== publishedGeneration) {
    throw new RangeError("BM25 search only supports the current published generation.");
  }
  // literalTerms (e.g. RM3 expansion vocabulary) bypass the tokenizer/stemmer
  // entirely and are merged in as-is, so postings are looked up by the exact
  // term the index stored them under, not a re-stem of it. They are exempt
  // from maxQueryTerms: that cap bounds how much of the free-text query the
  // tokenizer keeps, not the small, separately-capped expansion vocabulary.
  const queryTerms = [
    ...new Set([
      ...tokenizeBm25Query(query, { maxTerms: normalized.maxQueryTerms }),
      ...searchRequest.literalTerms,
    ]),
  ];
  // A caller composing exact and lexical lookups for one request (see
  // collectCandidates in retrieval/search.js) may supply a shared map so the
  // same tombstoned document is never double-counted across both indexes.
  const expiredRetentionClasses = options.expiredRetentionClasses instanceof Map
    ? options.expiredRetentionClasses
    : new Map();
  if (queryTerms.length === 0) {
    return Object.freeze({ generation: publishedGeneration, results: Object.freeze([]), work: Object.freeze({
      postingRecordsRead: 0,
      postingRecordsScanned: 0,
      canonicalPostingsRead: 0,
      windowCandidates: 0,
      supersessionChecks: 0,
      truncated: false,
      termsConsidered: Object.freeze([]),
      expiredMatches: summarizeExpiredMatches(expiredRetentionClasses),
    }) });
  }
  const statistics = await readBm25Statistics(view, {
    project,
    terms: queryTerms,
    generation: searchRequest.generation,
  });
  if (!statistics.corpus || statistics.corpus.documentCount === 0) {
    return Object.freeze({ generation: statistics.generation, results: Object.freeze([]), work: Object.freeze({
      postingRecordsRead: 0,
      postingRecordsScanned: 0,
      canonicalPostingsRead: 0,
      windowCandidates: 0,
      supersessionChecks: 0,
      truncated: false,
      termsConsidered: Object.freeze([]),
      expiredMatches: summarizeExpiredMatches(expiredRetentionClasses),
    }) });
  }
  const activeTerms = queryTerms
    .filter((term) => statistics.terms[term]?.documentFrequency > 0)
    .sort((left, right) =>
      statistics.terms[left].documentFrequency - statistics.terms[right].documentFrequency
      || compareStrings(left, right));
  const candidates = new Map();
  const currentVersions = new Map();
  const excluded = new Set(searchRequest.excludeVisibleSourceKeys);
  let postingRecordsRead = 0;
  let postingRecordsScanned = 0;
  let canonicalPostingsRead = 0;
  let supersessionChecks = 0;
  let truncated = false;
  const supersession = new Map();
  const derivedViewAuthoritative = isDerivedViewQueryCutover(
    await view.get(derivedViewKeys.queryCutover()),
  );
  // expiredRetentionClasses (declared above, possibly shared with a sibling
  // exact lookup) is keyed by documentId so the same expired document is
  // never double-counted across its stale windows/terms or a later
  // retired-without-manifest hit below.

  for (const term of activeTerms) {
    const remaining = normalized.maxPostingRecords - postingRecordsRead;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const physicalRemaining = normalized.maxPhysicalPostingRecords
      - postingRecordsScanned
      - canonicalPostingsRead;
    if (physicalRemaining <= 0) {
      truncated = true;
      break;
    }
    const {
      records: postings,
      recordsScanned,
      canonicalPostingsRead: termCanonicalPostingsRead,
      truncated: termTruncated,
    } = await scanTermPostings(
      view,
      project,
      term,
      searchRequest,
      physicalRemaining,
    );
    postingRecordsScanned += recordsScanned;
    canonicalPostingsRead += termCanonicalPostingsRead;
    if (termTruncated) truncated = true;
    for (const record of postings) {
      const posting = isPostingBlock(record.payload)
        ? decodeBm25PostingBlock(record.payload)
        : record.payload;
      if (!Number.isSafeInteger(posting.generation)
        || posting.generation <= 0
        || posting.generation > statistics.generation) continue;
      if (!scopeAllows(posting, searchRequest) || visibleSource(posting, excluded)) continue;
      let currentVersion = currentVersions.get(posting.documentId);
      if (currentVersion === undefined) {
        currentVersion = (await view.get(bm25Keys.current(project, posting.documentId)))?.documentVersion ?? null;
        currentVersions.set(posting.documentId, currentVersion);
      }
      if (currentVersion !== posting.documentVersion) continue;
      const versionIdentity = `${posting.documentId}\0${posting.documentVersion}`;
      let isSuperseded = supersession.get(versionIdentity);
      if (isSuperseded === undefined) {
        const ordinal = await documentOrdinalLiveness(view, {
          project,
          documentId: posting.documentId,
          version: posting.documentVersion,
          authoritative: derivedViewAuthoritative,
        });
        const marker = ordinal === undefined
          || (!ordinal.authoritative && ordinal.tombstone === undefined)
          ? view.scan([
              KEYSPACE.SUPERSESSION,
              posting.documentId,
              posting.documentVersion,
            ], { limit: 1 })[0]?.payload
          : ordinal.tombstone;
        isSuperseded = marker !== undefined;
        supersession.set(versionIdentity, isSuperseded);
        supersessionChecks += 1;
        // Only a tombstone with no live replacement is the silent-amnesia
        // case; a version-bump marker always carries "superseded" and must
        // not inflate this count, since that document still resolves live.
        if (marker?.status === "expired" && !expiredRetentionClasses.has(posting.documentId)) {
          const manifest = await view.get(manifestKeys.document(posting.documentId, posting.documentVersion));
          expiredRetentionClasses.set(
            posting.documentId,
            manifest?.retentionClass ?? fallbackRetentionClass(posting.kind),
          );
        }
      }
      if (isSuperseded) continue;
      if (postingRecordsRead >= normalized.maxPostingRecords) {
        truncated = true;
        break;
      }
      // The user-visible work budget counts live postings. Retired immutable
      // records remain bounded by MAX_SCAN_LIMIT and are consolidated later,
      // but cannot crowd a live result out of a smaller logical budget.
      postingRecordsRead += 1;
      const { window } = posting;
      const candidateKey = `${posting.documentId}\0${posting.documentVersion}\0${window.ordinal}`;
      let candidate = candidates.get(candidateKey);
      if (candidate === undefined) {
        if (candidates.size >= normalized.maxWindowCandidates) {
          truncated = true;
          continue;
        }
        candidate = {
          documentId: posting.documentId,
          version: posting.documentVersion,
          windowOrdinal: window.ordinal,
          startByte: window.startByte,
          endByte: window.endByte,
          length: window.length,
          weightedLength: window.weightedLength,
          kind: posting.kind,
          createdAt: posting.createdAt,
          sessionId: posting.sessionId,
          sourceMessageKeys: posting.sourceMessageKeys,
          turnId: semanticIdentifier(posting.turnId),
          evidence: new Map(),
        };
        candidates.set(candidateKey, candidate);
      }
      candidate.evidence.set(term, {
        termFrequency: window.termFrequency,
        weightedTermFrequency: window.weightedTermFrequency,
        positions: postingPositions(window),
      });
    }
  }

  const ranked = [...candidates.values()].map((candidate) => {
    const scored = candidateScore(candidate, statistics, normalized, queryTerms.length);
    return { ...candidate, ...scored };
  }).sort((left, right) =>
    right.score - left.score
    || right.evidence.size - left.evidence.size
    || right.createdAt - left.createdAt
    || compareStrings(left.documentId, right.documentId)
    || left.windowOrdinal - right.windowOrdinal);
  const selected = [];
  const seenDocuments = new Set();
  for (const candidate of ranked) {
    const identity = `${candidate.documentId}\0${candidate.version}`;
    if (seenDocuments.has(identity)) continue;
    seenDocuments.add(identity);
    const manifest = await view.get(manifestKeys.document(candidate.documentId, candidate.version));
    // Retention may have removed canonical source before an index cleanup pass.
    if (manifest === undefined) {
      if (!expiredRetentionClasses.has(candidate.documentId)) {
        const marker = view.scan([
          KEYSPACE.SUPERSESSION,
          candidate.documentId,
          candidate.version,
        ], { limit: 1 })[0]?.payload;
        // The tombstone (step 1 of deletion) always precedes canonical
        // removal (a later step), so a marker is normally already present
        // here too; documentHistory is only a fallback for the rare window
        // before that write or after its audited tombstone metadata ages out.
        const status = marker?.status ?? retiredDocumentStatus(
          await view.get(manifestKeys.documentHistory(candidate.documentId)),
          candidate.version,
        )?.status;
        if (status === "expired") {
          expiredRetentionClasses.set(candidate.documentId, fallbackRetentionClass(candidate.kind));
        }
      }
      continue;
    }
    selected.push({ ...candidate, manifest });
    if (selected.length === normalized.limit) break;
  }

  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const matched = matchRange(candidate);
    // Four UTF-8 bytes per requested display character on either side keeps
    // source IO proportional to the snippet budget even when one logical
    // window (or one lexical token) spans the entire document.
    const contextBytes = normalized.maxSnippetCharacters * 4;
    const snippetRange = await readDocumentRange(
      view,
      candidate.manifest,
      Math.max(candidate.startByte, matched.startByte - contextBytes),
      Math.min(candidate.endByte, matched.startByte + (2 * contextBytes)),
      { adjustUtf8: true },
    );
    const nextScore = selected[index + 1]?.score ?? 0;
    results.push(Object.freeze({
      documentId: candidate.documentId,
      project,
      version: candidate.version,
      kind: candidate.kind,
      createdAt: candidate.createdAt,
      windowOrdinal: candidate.windowOrdinal,
      startByte: matched.startByte,
      endByte: matched.endByte,
      windowStartByte: candidate.startByte,
      windowEndByte: candidate.endByte,
      score: candidate.score,
      rawScore: candidate.score,
      // Not part of the store.search contract; consumed only by the search
      // orchestration layer to compute a query-time recency multiplier.
      retentionClass: candidate.manifest.retentionClass,
      margin: candidate.score - nextScore,
      matchType: "bm25",
      matchedTerms: candidate.retrievalEvidence.matchedTerms,
      termCoverage: candidate.retrievalEvidence.termCoverage,
      termIdf: candidate.retrievalEvidence.termIdf,
      maxNormalizedIdf: candidate.retrievalEvidence.maxNormalizedIdf,
      snippet: snippetForCandidate(
        snippetRange.text,
        candidate,
        normalized.maxSnippetCharacters,
        snippetRange,
      ),
      historical: true,
      superseded: false,
      locator: null,
      source: Object.freeze({
        project,
        sessionId: candidate.sessionId,
        turnId: semanticIdentifier(candidate.turnId),
        messageKey: semanticIdentifier(candidate.sourceMessageKeys[0]),
        sourceMessageKeys: Object.freeze([...candidate.sourceMessageKeys]),
      }),
      location: Object.freeze({
        windowOrdinal: candidate.windowOrdinal,
        startByte: matched.startByte,
        endByte: matched.endByte,
        matchStartByte: matched.startByte,
        matchEndByte: matched.endByte,
        windowStartByte: candidate.startByte,
        windowEndByte: candidate.endByte,
        generation: statistics.generation,
      }),
      explanation: candidate.explanation,
    }));
  }
  return Object.freeze({
    generation: statistics.generation,
    statistics: Object.freeze({
      documentCount: statistics.corpus.documentCount,
      averageDocumentLength: statistics.corpus.averageDocumentLength,
    }),
    results: Object.freeze(results),
    work: Object.freeze({
      postingRecordsRead,
      postingRecordsScanned,
      canonicalPostingsRead,
      windowCandidates: candidates.size,
      supersessionChecks,
      truncated,
      termsConsidered: Object.freeze(activeTerms),
      expiredMatches: summarizeExpiredMatches(expiredRetentionClasses),
    }),
  });
}
