import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { semanticIdentifier } from "../../identity/semantic-identifiers.js";
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
} from "./tokenizer.js";
import { structuralMessageLocations } from "./structural.js";
import {
  BM25_INDEX_VERSION,
  bm25Keys,
  compareStrings,
  hydrateDocumentMetadata,
  identifier,
  positiveInteger,
  requireView,
} from "./bm25-keys.js";

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
const MAX_BUFFERED_CROSS_SEGMENT_CODE_POINTS = 1_024;

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

// Fallback (non-cue) structural scores are never exactly 0 in production
// (structuralMessageScores in ../../structural-annotations.js gives every non-empty user
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
  const turnId = semanticIdentifier(manifest.metadata?.sourceTurnId)
    ?? semanticIdentifier(manifest.metadata?.turnId);
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
