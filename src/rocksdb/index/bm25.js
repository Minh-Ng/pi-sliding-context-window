import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { KEYSPACE } from "../keys.js";
import { manifestKeys, retiredDocumentStatus } from "../manifests.js";
import { readDocumentRange } from "../document-range.js";
import { semanticIdentifier } from "../../semantic-identifiers.js";
import { assertVisibleSourceKeys } from "../../store-contract.js";
import { DEFAULT_RETENTION_CLASS_BY_KIND } from "../../daemon/retention-policy.js";
import {
  MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT,
  MAX_BM25_TERM_WINDOWS_PER_DOCUMENT,
  MAX_BM25_TOKENS_PER_WINDOW,
  preparationLimit,
} from "../index-preparation.js";
import {
  bm25Subterms,
  BM25_TOKENIZER_VERSION,
  normalizeBm25Term,
  tokenizeBm25,
  tokenizeBm25Query,
} from "./tokenizer.js";
import { structuralMessageLocations } from "./structural.js";

// Field-weighted postings (weighted term frequency and window length instead
// of raw counts) change the posting format, so this forks the derived
// namespace exactly like a tokenizer bump: 2 was the pre-field-weighting
// format, 3 is field-aware.
export const BM25_INDEX_VERSION = 3;
export const DEFAULT_BM25_PARAMETERS = Object.freeze({ k1: 1.2, b: 0.75 });
export const DEFAULT_BM25_SEARCH_LIMITS = Object.freeze({
  maxQueryTerms: 20,
  maxPostingRecords: 10_000,
  maxWindowCandidates: 4_000,
  maxSnippetCharacters: 280,
  maxLineageSessions: 64,
});
export const MAX_BM25_SNIPPET_CHARACTERS = 2_000;

// A tokenizer or posting-format bump gets a fresh derived namespace. Canonical
// sources remain unchanged and can be replayed to rebuild the new namespace.
const ROOT = Object.freeze([
  KEYSPACE.POSTING,
  "bm25",
  BM25_INDEX_VERSION,
  BM25_TOKENIZER_VERSION,
]);
const MAX_SCAN_LIMIT = 100_000;
// Subtoken splitting indexes each camelCase/snake_case identifier under both
// its compound term and its pieces, roughly doubling unique terms for
// code-dense text; raised from the pre-subtoken 256 so that documents which
// indexed cleanly before this change keep indexing cleanly now.
const MAX_UNIQUE_TERMS_PER_DOCUMENT = 512;
const DOCUMENT_WINDOWS_PER_SHARD = 256;
const DOCUMENT_TERM_ORDINALS_PER_SHARD = 1_024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// BM25F-style role weighting so a long tool result cannot outweigh the short
// user sentence that named a decision. `neutral` reproduces the pre-field-
// weighting score exactly (weight 1 on every byte), so any document without
// resolvable structural messages — every pre-existing fixture and migrated
// document included — is scored identically to before this change.
// `structural` is the boosted title-like tier for question/request/
// correction/answer-scored spans and whole decision-candidate documents;
// `tool` is the fallback for bytes inside a document that has known message
// structure but fall outside any located user/assistant span.
export const BM25_FIELD_WEIGHTS = Object.freeze({
  structural: 2.5,
  user: 2.25,
  assistant: 1.25,
  tool: 0.4,
  neutral: 1,
});
const BM25_WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const EMPTY_EXPIRED_MATCHES = Object.freeze({ count: 0, retentionClasses: Object.freeze([]) });
const MAX_BUFFERED_CROSS_SEGMENT_CODE_POINTS = 1_024;

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function finite(value, label, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

// Weighted corpus lengths are running sums/differences of fractional
// per-token field weights (2.5/2.25/1.25/0.4), so a value that is
// mathematically exactly zero can land a float epsilon on either side of
// zero depending purely on the order documents were added versus deleted.
// The smallest real per-token weight (0.4) is many orders of magnitude
// larger than any float rounding residue observed on this arithmetic, so a
// tolerance far below that (and far above IEEE-754 double epsilon) safely
// distinguishes true corpus corruption from rounding noise.
const WEIGHTED_LENGTH_ZERO_TOLERANCE = 1e-6;

/** Clamp a weighted-length delta that is negative only by float rounding
 * noise to exactly zero; a delta beyond the tolerance is a real corpus
 * statistics inconsistency and still throws. */
function clampWeightedLengthResidue(value, label) {
  if (value >= 0) return value;
  if (value > -WEIGHTED_LENGTH_ZERO_TOLERANCE) return 0;
  throw new Error(`${label} would become negative.`);
}

function requireView(view) {
  if (!view || typeof view.get !== "function" || typeof view.scan !== "function") {
    throw new TypeError("A RocksStore-compatible read view is required.");
  }
  return view;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Fallback (non-cue) structural scores are never exactly 0 in production
// (structuralMessageScores in ../../structural.js gives every non-empty user
// message question:10+/request:10+, and every non-error assistant message
// answer:75+), so a `> 0` promotion threshold would promote every located
// user and assistant span to the structural tier and collapse the intended
// user > assistant > tool ordering. Only the decisive cue-matched scores
// (an actual "?"/interrogative, an actual command verb, a correction phrase,
// or a terminal answer) clear this threshold; plain conversational filler
// falls through to the ordinary role weight instead.
const STRUCTURAL_PROMOTION_THRESHOLD = 85;

function isStructuralMessage(message) {
  return ["questionScore", "requestScore", "correctionScore", "answerScore"].some((field) => {
    const score = Number(message?.[field]);
    return Number.isFinite(score) && score >= STRUCTURAL_PROMOTION_THRESHOLD;
  });
}

/**
 * Resolve BM25F field boundaries from the same manifest data structural
 * indexing already relies on: `structuralMessages` for role-tagged spans
 * inside a turn, or the whole document for a decision-candidate excerpt.
 * Resolution is best-effort — an unresolved scan (duplicate text, an
 * oversized document, or a synchronous caller with no bounded reader) falls
 * back to no ranges, which weights every byte as `neutral` and reproduces
 * the pre-field-weighting score exactly.
 */
async function resolveFieldRanges(context) {
  if (context.manifest.kind === "decision-candidate") {
    return Object.freeze([
      { startByte: 0, endByte: context.manifest.byteLength, weight: BM25_FIELD_WEIGHTS.structural },
    ]);
  }
  if (typeof context.readSourceRange !== "function") return Object.freeze([]);
  const structural = Array.isArray(context.manifest.structuralMessages)
    ? context.manifest.structuralMessages
    : [];
  const located = structural.filter((message) =>
    (message.role === "user" || message.role === "assistant") && (message.text ?? "").length > 0);
  if (located.length === 0) return Object.freeze([]);
  let locations;
  try {
    locations = await structuralMessageLocations(context, located);
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(located.flatMap((message) => {
    const location = locations.get(message);
    if (location === undefined) return [];
    const weight = isStructuralMessage(message)
      ? BM25_FIELD_WEIGHTS.structural
      : BM25_FIELD_WEIGHTS[message.role];
    return [{ startByte: location.startByte, endByte: location.endByte, weight }];
  }).sort((left, right) => left.startByte - right.startByte));
}

/** Binary search a byte offset against sorted, non-overlapping field ranges.
 * An empty range set (no resolvable structural messages) is neutral; a gap
 * inside a document that does have located ranges is presumed tool output or
 * message-boundary formatting, so it gets the lowest weight instead. */
function weightForByte(fieldRanges, startByte) {
  if (fieldRanges.length === 0) return BM25_FIELD_WEIGHTS.neutral;
  let low = 0;
  let high = fieldRanges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = fieldRanges[middle];
    if (startByte < range.startByte) high = middle - 1;
    else if (startByte >= range.endByte) low = middle + 1;
    else return range.weight;
  }
  return BM25_FIELD_WEIGHTS.tool;
}

/** Sum per-occurrence field weight for one term's positions in one window. */
function weightedFrequency(positions, fieldRanges) {
  let total = 0;
  for (const position of positions) total += weightForByte(fieldRanges, position.startByte);
  return total;
}

/** Best-effort retention-class label for an honesty count only; the manifest
 * that recorded the real class is exactly what already went missing. */
function fallbackRetentionClass(kind) {
  return DEFAULT_RETENTION_CLASS_BY_KIND[kind] ?? "conversation-source";
}

function generationFromRecord(record) {
  const generation = record?.key?.at(-1);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
}

function latestVersionedRecord(view, prefix, generation) {
  const records = view.scan(prefix, { reverse: true, limit: MAX_SCAN_LIMIT });
  const result = records.find((record) => {
    const candidate = generationFromRecord(record);
    return candidate !== undefined && candidate <= generation;
  });
  if (result === undefined && records.length === MAX_SCAN_LIMIT) {
    throw new RangeError("Requested BM25 statistics are older than the bounded history scan.");
  }
  return result;
}

export const bm25Keys = Object.freeze({
  corpus(project, generation) {
    return [...ROOT, "corpus", identifier(project, "project"), positiveInteger(generation, "generation")];
  },
  corpusPrefix(project) {
    return [...ROOT, "corpus", identifier(project, "project")];
  },
  corpusCurrent(project) {
    return [...ROOT, "corpus-current", identifier(project, "project")];
  },
  current(project, documentId) {
    return [...ROOT, "current", identifier(project, "project"), identifier(documentId, "documentId")];
  },
  identity(documentId) {
    return [...ROOT, "identity", identifier(documentId, "documentId")];
  },
  document(project, documentId, version) {
    return [
      ...ROOT,
      "document",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  documentWindow(project, documentId, version, ordinal) {
    return [
      ...ROOT,
      "document-window",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      nonNegativeInteger(ordinal, "ordinal"),
    ];
  },
  documentWindowPrefix(project, documentId, version) {
    return [
      ...ROOT,
      "document-window",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  documentTerm(project, documentId, version, term, segment) {
    return [
      ...ROOT,
      "document-term",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      identifier(term, "term"),
      nonNegativeInteger(segment, "segment"),
    ];
  },
  documentTermPrefix(project, documentId, version) {
    return [
      ...ROOT,
      "document-term",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  generation(generation, project) {
    return [...ROOT, "generation", positiveInteger(generation, "generation"), identifier(project, "project")];
  },
  posting(project, term, bucket, createdAt, documentId, version, generation, windowOrdinal) {
    return [
      ...ROOT,
      "term",
      identifier(project, "project"),
      identifier(term, "term"),
      nonNegativeInteger(bucket, "bucket"),
      nonNegativeInteger(createdAt, "createdAt"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      positiveInteger(generation, "generation"),
      nonNegativeInteger(windowOrdinal, "windowOrdinal"),
    ];
  },
  postingPrefix(project, term) {
    return [...ROOT, "term", identifier(project, "project"), identifier(term, "term")];
  },
  sessionPosting(
    project,
    sessionId,
    term,
    bucket,
    createdAt,
    documentId,
    version,
    generation,
    windowOrdinal,
  ) {
    return [
      ...ROOT,
      "session-term",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(term, "term"),
      nonNegativeInteger(bucket, "bucket"),
      nonNegativeInteger(createdAt, "createdAt"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      positiveInteger(generation, "generation"),
      nonNegativeInteger(windowOrdinal, "windowOrdinal"),
    ];
  },
  sessionPostingPrefix(project, sessionId, term) {
    return [
      ...ROOT,
      "session-term",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(term, "term"),
    ];
  },
  termStatistics(project, term, generation) {
    return [
      ...ROOT,
      "df",
      identifier(project, "project"),
      identifier(term, "term"),
      positiveInteger(generation, "generation"),
    ];
  },
  termStatisticsPrefix(project, term) {
    return [...ROOT, "df", identifier(project, "project"), identifier(term, "term")];
  },
  termStatisticsCurrent(project, term) {
    return [
      ...ROOT,
      "df-current",
      identifier(project, "project"),
      identifier(term, "term"),
    ];
  },
});

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

// This synchronous fallback has no bounded source reader, so it cannot
// resolve structural-message field boundaries and always scores at neutral
// weight (weightedLength === length, weightedTermFrequency === termFrequency).
function analyzeDocument(context) {
  const termPostings = new Map();
  const windows = [];
  const documentBytes = Buffer.from(context.text, "utf8");
  let totalLength = 0;
  let totalWeightedLength = 0;
  let termWindows = 0;
  for (const window of context.windows) {
    const windowText = UTF8_DECODER.decode(
      documentBytes.subarray(window.startByte, window.endByte),
    );
    const tokens = tokenizeBm25(windowText);
    preparationLimit("bm25", "tokens per window", MAX_BM25_TOKENS_PER_WINDOW, tokens.length);
    preparationLimit(
      "bm25",
      "analyzed token occurrences",
      MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT,
      totalLength + tokens.length,
    );
    totalLength += tokens.length;
    totalWeightedLength += tokens.length;
    const grouped = new Map();
    for (const token of tokens) {
      let positions = grouped.get(token.term);
      if (positions === undefined) {
        positions = [];
        grouped.set(token.term, positions);
      }
      positions.push(Object.freeze({
        position: token.position,
        startByte: window.startByte + token.startByte,
        endByte: window.startByte + token.endByte,
      }));
    }
    windows.push(Object.freeze({
      ordinal: window.ordinal,
      startByte: window.startByte,
      endByte: window.endByte,
      length: tokens.length,
      weightedLength: tokens.length,
    }));
    for (const [term, positions] of grouped) {
      let posting = termPostings.get(term);
      if (posting === undefined) {
        posting = [];
        termPostings.set(term, posting);
        preparationLimit(
          "bm25",
          "unique terms",
          MAX_UNIQUE_TERMS_PER_DOCUMENT,
          termPostings.size,
        );
      }
      posting.push(Object.freeze({
        ordinal: window.ordinal,
        startByte: window.startByte,
        endByte: window.endByte,
        length: tokens.length,
        weightedLength: tokens.length,
        termFrequency: positions.length,
        weightedTermFrequency: positions.length,
        positions: Object.freeze(positions),
      }));
    }
    termWindows += grouped.size;
    preparationLimit(
      "bm25",
      "term-window postings",
      MAX_BM25_TERM_WINDOWS_PER_DOCUMENT,
      termWindows,
    );
  }
  preparationLimit(
    "bm25",
    "unique terms",
    MAX_UNIQUE_TERMS_PER_DOCUMENT,
    termPostings.size,
  );
  return Object.freeze({ termPostings, windows: Object.freeze(windows), totalLength, totalWeightedLength });
}

function appendWordFragment(word, fragment) {
  word.endByte += Buffer.byteLength(fragment, "utf8");
  if (word.overflow) return;
  for (const character of fragment) {
    word.codePoints += 1;
    if (word.codePoints > MAX_BUFFERED_CROSS_SEGMENT_CODE_POINTS) {
      word.surface = "";
      word.overflow = true;
      return;
    }
    word.surface += character;
  }
}

function finishStreamedWord(state, target) {
  const word = state.pending;
  if (word === undefined) return;
  const term = word.overflow ? "" : normalizeBm25Term(word.surface);
  if (term) {
    preparationLimit(
      "bm25",
      "tokens per window",
      MAX_BM25_TOKENS_PER_WINDOW,
      target.length + 1,
    );
    target.push(Object.freeze({
      term,
      position: state.position,
      startByte: word.startByte,
      endByte: word.endByte,
    }));
  }
  // Subtokens carry the compound token's byte range, matching tokenizeBm25.
  if (!word.overflow) {
    for (const subterm of bm25Subterms(word.surface, term)) {
      preparationLimit(
        "bm25",
        "tokens per window",
        MAX_BM25_TOKENS_PER_WINDOW,
        target.length + 1,
      );
      target.push(Object.freeze({
        term: subterm.term,
        position: state.position,
        startByte: word.startByte,
        endByte: word.endByte,
      }));
    }
  }
  state.position += 1;
  state.pending = undefined;
}

/** Tokenize one bounded UTF-8 segment while carrying at most one word run. */
function tokenizeBm25Segment(state, text, baseByte, final, target) {
  let previousCodeUnitEnd = 0;
  let previousByteEnd = baseByte;
  let firstMatch = true;
  for (const match of text.matchAll(BM25_WORD)) {
    const skipped = text.slice(previousCodeUnitEnd, match.index);
    const startByte = previousByteEnd + Buffer.byteLength(skipped, "utf8");
    const continues = firstMatch && state.pending !== undefined && match.index === 0;
    if (state.pending !== undefined && !continues) finishStreamedWord(state, target);
    if (!continues) {
      state.pending = {
        startByte,
        endByte: startByte,
        codePoints: 0,
        surface: "",
        overflow: false,
      };
    }
    appendWordFragment(state.pending, match[0]);
    const matchCodeUnitEnd = match.index + match[0].length;
    const reachesSegmentEnd = matchCodeUnitEnd === text.length;
    if (!reachesSegmentEnd || final) finishStreamedWord(state, target);
    previousCodeUnitEnd = matchCodeUnitEnd;
    previousByteEnd = startByte + Buffer.byteLength(match[0], "utf8");
    firstMatch = false;
  }
  if (firstMatch && state.pending !== undefined && (text.length > 0 || final)) {
    finishStreamedWord(state, target);
  } else if (final && state.pending !== undefined) {
    finishStreamedWord(state, target);
  }
}

async function analyzeDocumentFromRanges(context) {
  const fieldRanges = await resolveFieldRanges(context);
  const termPostings = new Map();
  const windows = [];
  let totalLength = 0;
  let totalWeightedLength = 0;
  let termWindows = 0;
  for (const window of context.windows) {
    const tokens = [];
    const state = { pending: undefined, position: 0 };
    let cursor = window.startByte;
    if (cursor === window.endByte) {
      tokenizeBm25Segment(state, "", cursor, true, tokens);
    }
    while (cursor < window.endByte) {
      const requestedEnd = Math.min(window.endByte, cursor + context.sourceSegmentBytes);
      const selected = await context.readSourceRange(cursor, requestedEnd, { adjustUtf8: true });
      if (selected.startByte !== cursor || selected.endByte <= cursor) {
        throw new Error("BM25 bounded source reader failed to make UTF-8 progress.");
      }
      tokenizeBm25Segment(
        state,
        selected.text,
        selected.startByte,
        selected.endByte === window.endByte,
        tokens,
      );
      cursor = selected.endByte;
      await context.yieldControl();
    }
    preparationLimit(
      "bm25",
      "analyzed token occurrences",
      MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT,
      totalLength + tokens.length,
    );
    totalLength += tokens.length;
    let windowWeightedLength = 0;
    const grouped = new Map();
    for (const token of tokens) {
      windowWeightedLength += weightForByte(fieldRanges, token.startByte);
      let positions = grouped.get(token.term);
      if (positions === undefined) {
        positions = [];
        grouped.set(token.term, positions);
      }
      positions.push(Object.freeze({
        position: token.position,
        startByte: token.startByte,
        endByte: token.endByte,
      }));
    }
    totalWeightedLength += windowWeightedLength;
    windows.push(Object.freeze({
      ordinal: window.ordinal,
      startByte: window.startByte,
      endByte: window.endByte,
      length: tokens.length,
      weightedLength: windowWeightedLength,
    }));
    for (const [term, positions] of grouped) {
      let posting = termPostings.get(term);
      if (posting === undefined) {
        posting = [];
        termPostings.set(term, posting);
        preparationLimit(
          "bm25",
          "unique terms",
          MAX_UNIQUE_TERMS_PER_DOCUMENT,
          termPostings.size,
        );
      }
      posting.push(Object.freeze({
        ordinal: window.ordinal,
        startByte: window.startByte,
        endByte: window.endByte,
        length: tokens.length,
        weightedLength: windowWeightedLength,
        termFrequency: positions.length,
        weightedTermFrequency: weightedFrequency(positions, fieldRanges),
        positions: Object.freeze(positions),
      }));
    }
    termWindows += grouped.size;
    preparationLimit(
      "bm25",
      "term-window postings",
      MAX_BM25_TERM_WINDOWS_PER_DOCUMENT,
      termWindows,
    );
    preparationLimit(
      "bm25",
      "unique terms",
      MAX_UNIQUE_TERMS_PER_DOCUMENT,
      termPostings.size,
    );
  }
  return Object.freeze({ termPostings, windows: Object.freeze(windows), totalLength, totalWeightedLength });
}

function sourceMetadata(manifest) {
  const turnId = semanticIdentifier(manifest.metadata?.turnId);
  return {
    sessionId: manifest.sessionId,
    sourceMessageKeys: manifest.sourceMessageKeys,
    turnId,
  };
}

function storedPostingWindow(window) {
  const deltas = [];
  let priorPosition = 0;
  let priorStartByte = window.startByte;
  for (const position of window.positions) {
    deltas.push(
      position.position - priorPosition,
      position.startByte - priorStartByte,
      position.endByte - position.startByte,
    );
    priorPosition = position.position;
    priorStartByte = position.startByte;
  }
  return Object.freeze({
    ...window,
    positions: undefined,
    positionsEncoding: "delta-v1",
    positionDeltas: Object.freeze(deltas),
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

function termDfHash(termFrequencies) {
  const hash = createHash("sha256");
  for (const [term, frequency] of [...termFrequencies].sort(([left], [right]) => compareStrings(left, right))) {
    hash.update(`${term}\0${frequency}\n`);
  }
  return hash.digest("hex");
}

async function corpusBefore(view, project, generation) {
  if (generation <= 0) return undefined;
  const current = await view.get(bm25Keys.corpusCurrent(project))
    ?? view.scan(bm25Keys.corpusPrefix(project), { reverse: true, limit: 1 })[0]?.payload;
  if (current === undefined) return undefined;
  if (current.generation > generation) {
    throw new Error("BM25 corpus pointer is newer than the generation being prepared.");
  }
  return current;
}

async function termStatisticsBefore(view, project, term, generation) {
  if (generation <= 0) return undefined;
  const current = await view.get(bm25Keys.termStatisticsCurrent(project, term))
    ?? view.scan(bm25Keys.termStatisticsPrefix(project, term), { reverse: true, limit: 1 })[0]?.payload;
  if (current === undefined) return undefined;
  if (current.generation > generation) {
    throw new Error(`BM25 term pointer for ${term} is newer than the generation being prepared.`);
  }
  return current;
}

function documentMetadata(context, analysis, termFrequencies) {
  return Object.freeze({
    bm25DocumentVersion: BM25_INDEX_VERSION,
    tokenizerVersion: BM25_TOKENIZER_VERSION,
    project: context.manifest.project,
    sessionId: context.manifest.sessionId,
    documentId: context.manifest.documentId,
    documentVersion: context.manifest.version,
    generation: context.generation,
    contentHash: context.manifest.contentHash,
    createdAt: context.manifest.createdAt,
    bucket: Math.floor(context.manifest.createdAt / 3_600_000),
    windowCount: analysis.windows.length,
    totalLength: analysis.totalLength,
    totalWeightedLength: analysis.totalWeightedLength,
    termCount: termFrequencies.size,
    metadataLayout: "sharded-v2",
  });
}

function documentMetadataMutations(context, analysis, metadata, termFrequencies) {
  const mutations = [];
  for (let offset = 0, segment = 0; offset < analysis.windows.length;
    offset += DOCUMENT_WINDOWS_PER_SHARD, segment += 1) {
    const windows = Object.freeze(
      analysis.windows.slice(offset, offset + DOCUMENT_WINDOWS_PER_SHARD),
    );
    mutations.push({
      type: "put",
      immutable: false,
      key: bm25Keys.documentWindow(
        metadata.project,
        metadata.documentId,
        metadata.documentVersion,
        segment,
      ),
      kind: "bm25-document-window",
      payload: {
        bm25DocumentVersion: BM25_INDEX_VERSION,
        documentId: metadata.documentId,
        documentVersion: metadata.documentVersion,
        project: metadata.project,
        generation: context.generation,
        windows,
      },
    });
  }
  for (const [term, windows] of [...analysis.termPostings]
    .sort(([left], [right]) => compareStrings(left, right))) {
    const ordinals = windows.map(({ ordinal }) => ordinal);
    for (let offset = 0, segment = 0; offset < ordinals.length;
      offset += DOCUMENT_TERM_ORDINALS_PER_SHARD, segment += 1) {
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.documentTerm(
          metadata.project,
          metadata.documentId,
          metadata.documentVersion,
          term,
          segment,
        ),
        kind: "bm25-document-term",
        payload: {
          bm25DocumentVersion: BM25_INDEX_VERSION,
          documentId: metadata.documentId,
          documentVersion: metadata.documentVersion,
          project: metadata.project,
          generation: context.generation,
          term,
          documentFrequency: termFrequencies.get(term),
          windowOrdinals: Object.freeze(
            ordinals.slice(offset, offset + DOCUMENT_TERM_ORDINALS_PER_SHARD),
          ),
        },
      });
    }
  }
  return mutations;
}

function scanAll(view, prefix) {
  const records = [];
  let after;
  for (;;) {
    const page = view.scan(prefix, {
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
    });
    records.push(...page);
    if (page.length < 1_000) return records;
    after = page.at(-1).keyBytes;
  }
}

function hydrateDocumentMetadata(view, metadata) {
  if (metadata === undefined || Array.isArray(metadata.terms)) return metadata;
  if (!new Set(["sharded-v1", "sharded-v2"]).has(metadata.metadataLayout)) {
    throw new Error(`BM25 document ${metadata.documentId} has an unknown metadata layout.`);
  }
  const windowRecords = scanAll(
    view,
    bm25Keys.documentWindowPrefix(metadata.project, metadata.documentId, metadata.documentVersion),
  );
  const termRecords = scanAll(
    view,
    bm25Keys.documentTermPrefix(metadata.project, metadata.documentId, metadata.documentVersion),
  );
  const terms = new Map();
  for (const { payload } of termRecords) {
    let term = terms.get(payload.term);
    if (term === undefined) {
      term = {
        term: payload.term,
        documentFrequency: payload.documentFrequency,
        windowOrdinals: [],
      };
      terms.set(payload.term, term);
    } else if (term.documentFrequency !== payload.documentFrequency) {
      throw new Error(`BM25 term metadata for ${payload.term} is inconsistent.`);
    }
    term.windowOrdinals.push(...payload.windowOrdinals);
  }
  const windows = windowRecords.flatMap(({ payload }) => (
    Array.isArray(payload.windows) ? payload.windows : [payload.window]
  )).sort((left, right) => left.ordinal - right.ordinal);
  if (windows.length !== metadata.windowCount || terms.size !== metadata.termCount) {
    throw new Error(`BM25 document ${metadata.documentId} metadata shards are incomplete.`);
  }
  return Object.freeze({
    ...metadata,
    windows: Object.freeze(windows),
    terms: Object.freeze([...terms.values()].map((term) => Object.freeze({
      ...term,
      windowOrdinals: Object.freeze(term.windowOrdinals),
    }))),
    shardKeys: Object.freeze([
      ...windowRecords.map(({ key }) => key),
      ...termRecords.map(({ key }) => key),
    ]),
  });
}

async function prepareDelete(context, project) {
  const pointer = await context.view.get(bm25Keys.current(project, context.manifest.documentId));
  if (pointer === undefined || pointer.documentVersion !== context.manifest.version) {
    return {
      mutations: [],
      metadata: {
        project,
        deleted: false,
        reason: pointer === undefined ? "not-indexed" : "not-current-version",
        statisticsGeneration: context.generation,
      },
    };
  }
  const storedMetadata = await context.view.get(bm25Keys.document(
    project,
    context.manifest.documentId,
    context.manifest.version,
  ));
  if (storedMetadata === undefined) {
    throw new Error(`BM25 current pointer for ${context.manifest.documentId} has no document metadata.`);
  }
  const metadata = hydrateDocumentMetadata(context.view, storedMetadata);
  const priorCorpus = await corpusBefore(context.view, project, context.generation - 1);
  if (priorCorpus === undefined) {
    throw new Error(`BM25 corpus statistics are missing for ${context.manifest.documentId}.`);
  }
  const documentCount = priorCorpus.documentCount - metadata.windowCount;
  const totalDocumentLength = priorCorpus.totalDocumentLength - metadata.totalLength;
  if (documentCount < 0 || totalDocumentLength < 0) {
    throw new Error("BM25 deletion would make corpus statistics negative.");
  }
  // An empty corpus has no weighted length by definition; forcing the exact
  // value here (rather than trusting the running subtraction) stops a tiny
  // rounding residue from either sign surviving into the next admission.
  const totalWeightedDocumentLength = documentCount === 0 ? 0 : clampWeightedLengthResidue(
    priorCorpus.totalWeightedDocumentLength - metadata.totalWeightedLength,
    "BM25 deletion",
  );
  const corpus = Object.freeze({
    bm25StatisticsVersion: BM25_INDEX_VERSION,
    tokenizerVersion: BM25_TOKENIZER_VERSION,
    project,
    generation: context.generation,
    previousGeneration: priorCorpus.generation,
    documentCount,
    totalDocumentLength,
    averageDocumentLength: documentCount === 0 ? 0 : totalDocumentLength / documentCount,
    totalWeightedDocumentLength,
    averageWeightedDocumentLength: documentCount === 0 ? 0 : totalWeightedDocumentLength / documentCount,
  });
  const mutations = [];
  const changedDf = new Map();
  for (const { term, documentFrequency: contribution, windowOrdinals } of metadata.terms) {
    for (const windowOrdinal of windowOrdinals) {
      mutations.push({
        type: "remove",
        key: bm25Keys.posting(
          project,
          term,
          metadata.bucket,
          metadata.createdAt,
          metadata.documentId,
          metadata.documentVersion,
          metadata.generation,
          windowOrdinal,
        ),
      });
      mutations.push({
        type: "remove",
        key: bm25Keys.sessionPosting(
          project,
          metadata.sessionId,
          term,
          metadata.bucket,
          metadata.createdAt,
          metadata.documentId,
          metadata.documentVersion,
          metadata.generation,
          windowOrdinal,
        ),
      });
    }
    const priorTermStatistics = await termStatisticsBefore(
      context.view,
      project,
      term,
      context.generation - 1,
    );
    const before = priorTermStatistics?.documentFrequency ?? 0;
    const documentFrequency = before - contribution;
    if (documentFrequency < 0 || documentFrequency > documentCount) {
      throw new Error(`BM25 deletion produced inconsistent document frequency for ${term}.`);
    }
    changedDf.set(term, documentFrequency);
    const payload = {
      bm25StatisticsVersion: BM25_INDEX_VERSION,
      project,
      term,
      generation: context.generation,
      documentFrequency,
    };
    if (priorTermStatistics !== undefined) {
      mutations.push({
        type: "remove",
        key: bm25Keys.termStatistics(project, term, priorTermStatistics.generation),
      });
    }
    if (documentFrequency === 0) {
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.termStatisticsCurrent(project, term),
        kind: "bm25-current-term-statistics",
        payload,
      });
      mutations.push({
        type: "remove",
        stagePhase: "cleanup",
        key: bm25Keys.termStatisticsCurrent(project, term),
      });
    } else {
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.termStatistics(project, term, context.generation),
        kind: "bm25-term-statistics",
        payload,
      });
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.termStatisticsCurrent(project, term),
        kind: "bm25-current-term-statistics",
        payload,
      });
    }
  }
  mutations.push(
    {
      type: "remove",
      key: bm25Keys.current(project, metadata.documentId),
      stagePhase: "publish",
    },
    { type: "remove", key: bm25Keys.document(project, metadata.documentId, metadata.documentVersion) },
    ...(metadata.shardKeys ?? []).map((key) => ({ type: "remove", key })),
    { type: "remove", key: bm25Keys.identity(metadata.documentId) },
    { type: "remove", key: bm25Keys.corpus(project, priorCorpus.generation) },
    { type: "remove", key: bm25Keys.generation(priorCorpus.generation, project) },
    {
      type: "put",
      immutable: false,
      key: bm25Keys.corpus(project, context.generation),
      kind: "bm25-corpus-statistics",
      payload: corpus,
    },
    {
      type: "put",
      immutable: false,
      key: bm25Keys.corpusCurrent(project),
      kind: "bm25-current-corpus-statistics",
      payload: corpus,
    },
    {
      type: "put",
      immutable: false,
      key: bm25Keys.generation(context.generation, project),
      kind: "bm25-generation",
      payload: {
        bm25GenerationVersion: BM25_INDEX_VERSION,
        project,
        generation: context.generation,
        documentId: metadata.documentId,
        documentVersion: metadata.documentVersion,
        replacedVersion: metadata.documentVersion,
        deleted: true,
        changedTermCount: changedDf.size,
        changedTermDfHash: termDfHash(changedDf),
        documentCount,
        totalDocumentLength,
        totalWeightedDocumentLength,
      },
    },
  );
  return {
    mutations,
    metadata: {
      project,
      deleted: true,
      termCount: metadata.terms.length,
      windowCount: metadata.windowCount,
      documentLength: metadata.totalLength,
      statisticsGeneration: context.generation,
    },
  };
}

/** IndexWorker handler for deterministic window-level BM25 postings. */
export function createBm25IndexHandler(options = {}) {
  const id = options.id ?? "bm25";
  identifier(id, "handler id");
  const operations = options.operations ?? ["index", "delete"];
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("BM25 handler operations must be a non-empty array.");
  }
  return Object.freeze({
    id,
    operations: Object.freeze([...operations]),
    async prepare(context) {
      requireView(context?.view);
      positiveInteger(context.generation, "generation");
      const manifest = context.manifest;
      const project = identifier(manifest?.project, "manifest.project");
      const identity = await context.view.get(bm25Keys.identity(manifest.documentId));
      if (identity !== undefined && identity.project !== project) {
        throw new Error(
          `BM25 document ${manifest.documentId} cannot move from project ${identity.project} to ${project}.`,
        );
      }
      if (context.operation === "delete") return prepareDelete(context, project);
      const analysis = typeof context.readSourceRange === "function"
        ? await analyzeDocumentFromRanges(context)
        : analyzeDocument(context);
      const newTermFrequencies = new Map(
        [...analysis.termPostings].map(([term, windows]) => [term, windows.length]),
      );
      const previousPointer = await context.view.get(bm25Keys.current(project, manifest.documentId));
      const storedPreviousMetadata = previousPointer === undefined
        ? undefined
        : await context.view.get(bm25Keys.document(project, manifest.documentId, previousPointer.documentVersion));
      if (previousPointer !== undefined && storedPreviousMetadata === undefined) {
        throw new Error(`BM25 current pointer for ${manifest.documentId} has no document metadata.`);
      }
      const previousMetadata = hydrateDocumentMetadata(context.view, storedPreviousMetadata);
      const sameVersion = previousPointer?.documentVersion === manifest.version;
      if (sameVersion && previousMetadata.contentHash !== manifest.contentHash) {
        throw new Error(`BM25 document ${manifest.documentId}@${manifest.version} changed immutable content.`);
      }
      const previousTerms = new Map(
        (previousMetadata?.terms ?? []).map(({ term, documentFrequency }) => [term, documentFrequency]),
      );
      const priorCorpus = await corpusBefore(context.view, project, context.generation - 1) ?? {
        generation: 0,
        documentCount: 0,
        totalDocumentLength: 0,
        totalWeightedDocumentLength: 0,
      };
      const removedWindowCount = previousMetadata && !sameVersion ? previousMetadata.windowCount : 0;
      const removedLength = previousMetadata && !sameVersion ? previousMetadata.totalLength : 0;
      const removedWeightedLength = previousMetadata && !sameVersion ? previousMetadata.totalWeightedLength : 0;
      const addedWindowCount = sameVersion ? 0 : analysis.windows.length;
      const addedLength = sameVersion ? 0 : analysis.totalLength;
      const addedWeightedLength = sameVersion ? 0 : analysis.totalWeightedLength;
      const documentCount = priorCorpus.documentCount - removedWindowCount + addedWindowCount;
      const totalDocumentLength = priorCorpus.totalDocumentLength - removedLength + addedLength;
      if (documentCount < 0 || totalDocumentLength < 0) {
        throw new Error("BM25 corpus statistics would become negative.");
      }
      // An empty corpus has no weighted length by definition; forcing the
      // exact value here (rather than trusting the running arithmetic) stops
      // a tiny rounding residue from either sign surviving into the next
      // admission.
      const totalWeightedDocumentLength = documentCount === 0 ? 0 : clampWeightedLengthResidue(
        priorCorpus.totalWeightedDocumentLength - removedWeightedLength + addedWeightedLength,
        "BM25 corpus statistics",
      );
      const corpus = Object.freeze({
        bm25StatisticsVersion: BM25_INDEX_VERSION,
        tokenizerVersion: BM25_TOKENIZER_VERSION,
        project,
        generation: context.generation,
        previousGeneration: priorCorpus.generation,
        documentCount,
        totalDocumentLength,
        averageDocumentLength: documentCount === 0 ? 0 : totalDocumentLength / documentCount,
        totalWeightedDocumentLength,
        averageWeightedDocumentLength: documentCount === 0 ? 0 : totalWeightedDocumentLength / documentCount,
      });
      const mutations = [];
      const changedDf = new Map();

      if (!sameVersion) {
        if (previousMetadata) {
          for (const { term, windowOrdinals } of previousMetadata.terms) {
            for (const windowOrdinal of windowOrdinals) {
              mutations.push({
                type: "remove",
                key: bm25Keys.posting(
                  project,
                  term,
                  previousMetadata.bucket,
                  previousMetadata.createdAt,
                  manifest.documentId,
                  previousMetadata.documentVersion,
                  previousMetadata.generation,
                  windowOrdinal,
                ),
              });
              mutations.push({
                type: "remove",
                key: bm25Keys.sessionPosting(
                  project,
                  previousMetadata.sessionId,
                  term,
                  previousMetadata.bucket,
                  previousMetadata.createdAt,
                  manifest.documentId,
                  previousMetadata.documentVersion,
                  previousMetadata.generation,
                  windowOrdinal,
                ),
              });
            }
          }
        }
        const allTerms = new Set([...previousTerms.keys(), ...newTermFrequencies.keys()]);
        for (const term of [...allTerms].sort()) {
          const priorTermStatistics = await termStatisticsBefore(
            context.view,
            project,
            term,
            context.generation - 1,
          );
          const before = priorTermStatistics?.documentFrequency ?? 0;
          const documentFrequency = before
            - (previousTerms.get(term) ?? 0)
            + (newTermFrequencies.get(term) ?? 0);
          if (documentFrequency < 0 || documentFrequency > documentCount) {
            throw new Error(`BM25 document frequency for ${term} is inconsistent with the corpus.`);
          }
          changedDf.set(term, documentFrequency);
          const payload = {
            bm25StatisticsVersion: BM25_INDEX_VERSION,
            project,
            term,
            generation: context.generation,
            documentFrequency,
          };
          if (priorTermStatistics !== undefined) {
            mutations.push({
              type: "remove",
              key: bm25Keys.termStatistics(project, term, priorTermStatistics.generation),
            });
          }
          if (documentFrequency === 0) {
            mutations.push({
              type: "put",
              immutable: false,
              key: bm25Keys.termStatisticsCurrent(project, term),
              kind: "bm25-current-term-statistics",
              payload,
            });
            mutations.push({
              type: "remove",
              stagePhase: "cleanup",
              key: bm25Keys.termStatisticsCurrent(project, term),
            });
          } else {
            mutations.push({
              type: "put",
              immutable: false,
              key: bm25Keys.termStatistics(project, term, context.generation),
              kind: "bm25-term-statistics",
              payload,
            });
            mutations.push({
              type: "put",
              immutable: false,
              key: bm25Keys.termStatisticsCurrent(project, term),
              kind: "bm25-current-term-statistics",
              payload,
            });
          }
        }
      }

      // Derived records are intentionally replaceable: replaying an unchanged
      // canonical version repairs a partially lost or explicitly rebuilt index.
      const metadata = documentMetadata(context, analysis, newTermFrequencies);
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.document(project, manifest.documentId, manifest.version),
        kind: "bm25-document",
        payload: metadata,
      });
      mutations.push(...documentMetadataMutations(
        context,
        analysis,
        metadata,
        newTermFrequencies,
      ));
      const source = sourceMetadata(manifest);
      for (const [term, windows] of analysis.termPostings) {
        for (const window of windows) {
          const payload = {
            bm25PostingVersion: BM25_INDEX_VERSION,
            tokenizerVersion: BM25_TOKENIZER_VERSION,
            generation: context.generation,
            project,
            term,
            documentId: manifest.documentId,
            documentVersion: manifest.version,
            kind: manifest.kind,
            createdAt: manifest.createdAt,
            bucket: metadata.bucket,
            ...source,
            window: storedPostingWindow(window),
          };
          mutations.push({
            type: "put",
            immutable: false,
            key: bm25Keys.posting(
              project,
              term,
              metadata.bucket,
              manifest.createdAt,
              manifest.documentId,
              manifest.version,
              context.generation,
              window.ordinal,
            ),
            kind: "bm25-posting",
            payload,
          });
          mutations.push({
            type: "put",
            immutable: false,
            key: bm25Keys.sessionPosting(
              project,
              manifest.sessionId,
              term,
              metadata.bucket,
              manifest.createdAt,
              manifest.documentId,
              manifest.version,
              context.generation,
              window.ordinal,
            ),
            kind: "bm25-session-posting",
            payload,
          });
        }
      }

      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.identity(manifest.documentId),
        kind: "bm25-document-identity",
        payload: {
          bm25DocumentVersion: BM25_INDEX_VERSION,
          documentId: manifest.documentId,
          project,
        },
      });
      if (priorCorpus.generation > 0) {
        mutations.push({
          type: "remove",
          key: bm25Keys.corpus(project, priorCorpus.generation),
        });
        mutations.push({
          type: "remove",
          key: bm25Keys.generation(priorCorpus.generation, project),
        });
      }
      mutations.push({
        type: "put",
        immutable: false,
        stagePhase: "publish",
        key: bm25Keys.current(project, manifest.documentId),
        kind: "bm25-current-document",
        payload: {
          bm25DocumentVersion: BM25_INDEX_VERSION,
          project,
          documentId: manifest.documentId,
          documentVersion: manifest.version,
          contentHash: manifest.contentHash,
          generation: context.generation,
        },
      });
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.corpus(project, context.generation),
        kind: "bm25-corpus-statistics",
        payload: corpus,
      });
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.corpusCurrent(project),
        kind: "bm25-current-corpus-statistics",
        payload: corpus,
      });
      mutations.push({
        type: "put",
        immutable: false,
        key: bm25Keys.generation(context.generation, project),
        kind: "bm25-generation",
        payload: {
          bm25GenerationVersion: BM25_INDEX_VERSION,
          project,
          generation: context.generation,
          documentId: manifest.documentId,
          documentVersion: manifest.version,
          replacedVersion: previousMetadata && !sameVersion ? previousMetadata.documentVersion : null,
          changedTermCount: changedDf.size,
          changedTermDfHash: termDfHash(changedDf),
          documentCount,
          totalDocumentLength,
          totalWeightedDocumentLength,
        },
      });
      return {
        mutations,
        metadata: {
          project,
          termCount: newTermFrequencies.size,
          windowCount: analysis.windows.length,
          documentLength: analysis.totalLength,
          statisticsGeneration: context.generation,
        },
      };
    },
  });
}

async function resolveGeneration(view, requested) {
  const published = await view.get([KEYSPACE.META, "published-index-generation"]);
  if (published === undefined) return 0;
  const current = positiveInteger(published.generation, "published generation");
  if (requested === undefined) return current;
  const generation = positiveInteger(requested, "generation");
  if (generation > current) throw new RangeError("generation is newer than the published index.");
  return generation;
}

/** Read the exact corpus and DF records used to score a query generation. */
export async function readBm25Statistics(view, { project, terms = [], generation } = {}) {
  if (view && typeof view.snapshot === "function") {
    return view.snapshot((snapshot) => readBm25Statistics(snapshot, { project, terms, generation }));
  }
  requireView(view);
  const normalizedProject = identifier(project, "project");
  if (!Array.isArray(terms) || terms.some((term) => typeof term !== "string" || term.length === 0)) {
    throw new TypeError("terms must be an array of normalized non-empty strings.");
  }
  const resolvedGeneration = await resolveGeneration(view, generation);
  if (resolvedGeneration === 0) {
    return Object.freeze({ generation: 0, corpus: undefined, terms: Object.freeze({}) });
  }
  const currentCorpus = await view.get(bm25Keys.corpusCurrent(normalizedProject));
  const corpusRecord = currentCorpus?.generation <= resolvedGeneration
    ? { payload: currentCorpus }
    : latestVersionedRecord(
      view,
      bm25Keys.corpusPrefix(normalizedProject),
      resolvedGeneration,
    );
  const termStatistics = {};
  for (const term of [...new Set(terms)].sort()) {
    const current = await view.get(bm25Keys.termStatisticsCurrent(normalizedProject, term));
    const record = current?.generation <= resolvedGeneration
      ? { payload: current }
      : latestVersionedRecord(
        view,
        bm25Keys.termStatisticsPrefix(normalizedProject, term),
        resolvedGeneration,
      );
    if (record !== undefined) termStatistics[term] = record.payload;
  }
  return Object.freeze({
    generation: resolvedGeneration,
    corpus: corpusRecord?.payload,
    terms: Object.freeze(termStatistics),
  });
}

/**
 * Read the full indexed term vocabulary of one live document, for query
 * expansion (RM3/Bo1-style pseudo-relevance feedback). Reuses the same
 * sharded document-term metadata already written at index time; it never
 * rescans or retokenizes source text.
 */
export async function readDocumentTermVocabulary(view, { project, documentId, version } = {}) {
  if (view && typeof view.snapshot === "function") {
    return view.snapshot((snapshot) => readDocumentTermVocabulary(snapshot, { project, documentId, version }));
  }
  requireView(view);
  const stored = await view.get(bm25Keys.document(
    identifier(project, "project"),
    identifier(documentId, "documentId"),
    positiveInteger(version, "version"),
  ));
  if (stored === undefined) return Object.freeze([]);
  const hydrated = hydrateDocumentMetadata(view, stored);
  return Object.freeze(hydrated.terms.map(({ term }) => term).sort());
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
  return right.payload.bucket - left.payload.bucket
    || right.payload.createdAt - left.payload.createdAt
    || Buffer.compare(right.keyBytes, left.keyBytes);
}

function scanTermPostings(view, project, term, request, limit) {
  if (request.scope !== "session") {
    const records = view.scan(bm25Keys.postingPrefix(project, term), {
      reverse: true,
      limit,
    });
    return Object.freeze({
      records,
      recordsScanned: records.length,
      truncated: records.length === limit,
    });
  }
  const states = request.sessionIds.map((sessionId) => ({
    prefix: bm25Keys.sessionPostingPrefix(project, sessionId, term),
    requested: 0,
    records: [],
    consumed: 0,
    exhausted: false,
  }));
  const records = [];
  let recordsScanned = 0;
  const available = (state) => {
    if (state.consumed < state.records.length) return true;
    if (state.exhausted) return false;
    const nextLimit = state.requested === 0 ? 1 : Math.min(limit, state.requested * 2);
    if (nextLimit === state.requested) {
      state.exhausted = true;
      return false;
    }
    state.records = view.scan(state.prefix, { reverse: true, limit: nextLimit });
    state.requested = nextLimit;
    state.exhausted = state.records.length < nextLimit;
    recordsScanned += state.records.length;
    return state.consumed < state.records.length;
  };
  while (records.length < limit) {
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
  const truncated = records.length === limit && states.some((state) =>
    state.consumed < state.records.length || !state.exhausted);
  return Object.freeze({ records, recordsScanned, truncated });
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
  if (queryTerms.length === 0) {
    return Object.freeze({ generation: publishedGeneration, results: Object.freeze([]), work: Object.freeze({
      postingRecordsRead: 0,
      postingRecordsScanned: 0,
      windowCandidates: 0,
      supersessionChecks: 0,
      truncated: false,
      termsConsidered: Object.freeze([]),
      expiredMatches: EMPTY_EXPIRED_MATCHES,
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
      windowCandidates: 0,
      supersessionChecks: 0,
      truncated: false,
      termsConsidered: Object.freeze([]),
      expiredMatches: EMPTY_EXPIRED_MATCHES,
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
  let supersessionChecks = 0;
  let truncated = false;
  const supersession = new Map();
  // Retention class of each matched-but-retired document, keyed by
  // documentId so the same expired document is never double-counted across
  // its stale windows/terms or a later retired-without-manifest hit below.
  const expiredRetentionClasses = new Map();

  for (const term of activeTerms) {
    const remaining = normalized.maxPostingRecords - postingRecordsRead;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const {
      records: postings,
      recordsScanned,
      truncated: termTruncated,
    } = scanTermPostings(
      view,
      project,
      term,
      searchRequest,
      remaining,
    );
    postingRecordsRead += postings.length;
    postingRecordsScanned += recordsScanned;
    if (termTruncated) truncated = true;
    for (const { payload: posting } of postings) {
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
        const marker = view.scan([
          KEYSPACE.SUPERSESSION,
          posting.documentId,
          posting.documentVersion,
        ], { limit: 1 })[0]?.payload;
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
      windowCandidates: candidates.size,
      supersessionChecks,
      truncated,
      termsConsidered: Object.freeze(activeTerms),
      expiredMatches: Object.freeze({
        count: expiredRetentionClasses.size,
        retentionClasses: Object.freeze([...new Set(expiredRetentionClasses.values())].sort()),
      }),
    }),
  });
}
