import { encodeKey, KEYSPACE } from "../keys.js";
import { readDocumentRange } from "../document-range.js";
import { manifestKeys } from "../manifests.js";
import { windowForByteRange } from "../windows.js";
import { semanticIdentifier } from "../../semantic-identifiers.js";
import { assertVisibleSourceKeys } from "../../store-contract.js";
import {
  MAX_EXACT_INDEX_ANCHORS,
  MAX_EXACT_POSTING_MUTATIONS,
  preparationLimit,
} from "../index-preparation.js";

export const EXACT_POSTING_VERSION = 1;
export const EXACT_INDEX_HANDLER_ID = "exact-postings-v1";
export const DEFAULT_EXACT_BUCKET_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EXACT_WORK_LIMIT = 2_048;
export const DEFAULT_EXACT_BUCKET_LIMIT = 32;
export const DEFAULT_EXACT_ANCHOR_LIMIT = 50_000;
export const DEFAULT_EXACT_SNIPPET_BYTES = 320;

const MAX_SCAN_LIMIT = 100_000;
const MAX_ANCHOR_BYTES = 512;
const MAX_MATCHES_PER_POSTING = 256;

const ERROR_CUE = /(?:^|_)(?:ERR(?:OR)?|FAIL(?:ED|URE)?|EXCEPTION|CLOSED|TIMEOUT|DENIED|INVALID|NOT_FOUND|UNAVAILABLE)(?:_|$)/u;
const ERROR_CLASS = /^[A-Z][A-Za-z0-9]*(?:Error|Exception)$/u;
const COMMIT = /^[0-9a-fA-F]{7,40}$/u;
const SNAKE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/u;
const DOTTED = /^(?:[$A-Za-z_][$A-Za-z0-9_]*\.)+[$A-Za-z_][$A-Za-z0-9_]*$/u;
const CAMEL_CANDIDATE = /\b[A-Za-z][A-Za-z0-9_]*\b/gu;
const HYPHENATED = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u;
const VERSION_OR_VALUE = /^(?:v?\d+\.\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?|0x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9_]*=[^\s,;]+)$/u;
const URL = /^https?:\/\/[^\s<>"'`]+$/iu;
const PATH = /^(?:(?:(?:\.{1,2}|~)?[\\/]|[A-Za-z]:[\\/])?)(?:[\p{L}\p{N}_@.+-]+[\\/])+[\p{L}\p{N}_@.+-]+$/u;

const TYPE_SPECIFICITY = Object.freeze({
  error: 1,
  path: 0.99,
  commit: 0.98,
  "quoted-value": 0.96,
  symbol: 0.94,
  "dotted-name": 0.92,
  url: 0.91,
  value: 0.88,
});

export class ExactIndexError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExactIndexError";
    this.code = "ERR_ROCKSDB_EXACT_INDEX";
    this.details = details;
  }
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Normalize one exact value without discarding punctuation or identifier boundaries. */
export function normalizeExactValue(value, options = {}) {
  if (typeof value !== "string") throw new TypeError("Exact values must be strings.");
  const normalized = value.normalize("NFKC");
  if (normalized.length === 0) throw new TypeError("Exact values must not be empty.");
  return options.foldCase === true ? normalized.toLowerCase() : normalized;
}

function commitLike(value) {
  return COMMIT.test(value) && (/\d/u.test(value) || value.length >= 12);
}

function snakeType(value) {
  return value === value.toUpperCase() && ERROR_CUE.test(value) ? "error" : "symbol";
}

function asciiUpper(code) {
  return code >= 65 && code <= 90;
}

function asciiLower(code) {
  return code >= 97 && code <= 122;
}

function asciiDigit(code) {
  return code >= 48 && code <= 57;
}

/** Classify the same lower-camel and PascalCase forms without regex backtracking. */
function camelLike(value) {
  if (typeof value !== "string" || value.length < 2) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!asciiUpper(code) && !asciiLower(code) && !asciiDigit(code)) return false;
  }
  const first = value.charCodeAt(0);
  if (asciiLower(first)) {
    for (let index = 1; index < value.length; index += 1) {
      if (asciiUpper(value.charCodeAt(index))) return true;
    }
    return false;
  }
  if (!asciiUpper(first) || !(asciiLower(value.charCodeAt(1)) || asciiDigit(value.charCodeAt(1)))) {
    return false;
  }
  let index = 2;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (asciiUpper(code)) return true;
    if (!asciiLower(code) && !asciiDigit(code)) return false;
    index += 1;
  }
  return false;
}

/** Classify an entire value. A non-null result must be attempted before lexical broadening. */
export function classifyExactValue(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (candidate.length === 0) return undefined;
  if ((candidate.startsWith('"') && candidate.endsWith('"'))
    || (candidate.startsWith("'") && candidate.endsWith("'"))
    || (candidate.startsWith("`") && candidate.endsWith("`"))) {
    const inner = candidate.slice(1, -1);
    return inner.length > 0 ? Object.freeze({ type: "quoted-value", value: inner }) : undefined;
  }
  if (URL.test(candidate)) return Object.freeze({ type: "url", value: candidate });
  if (PATH.test(candidate)) return Object.freeze({ type: "path", value: candidate });
  if (commitLike(candidate)) return Object.freeze({ type: "commit", value: candidate });
  if (SNAKE.test(candidate)) return Object.freeze({ type: snakeType(candidate), value: candidate });
  if (ERROR_CLASS.test(candidate)) return Object.freeze({ type: "error", value: candidate });
  if (DOTTED.test(candidate)) return Object.freeze({ type: "dotted-name", value: candidate });
  if (camelLike(candidate)) return Object.freeze({ type: "symbol", value: candidate });
  if (HYPHENATED.test(candidate) || VERSION_OR_VALUE.test(candidate)) {
    return Object.freeze({ type: "value", value: candidate });
  }
  return undefined;
}

function caseSensitive(type) {
  return type !== "commit";
}

function utf8ByteOffsets(text) {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;
  for (let index = 0; index < text.length;) {
    offsets[index] = byteOffset;
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      byteOffset += 1;
      index += 1;
    } else if (code <= 0x7ff) {
      byteOffset += 2;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      offsets[index + 1] = byteOffset;
      byteOffset += 4;
      index += 2;
    } else {
      byteOffset += 3;
      index += 1;
    }
    offsets[index] = byteOffset;
  }
  return offsets;
}

function anchorRecord(type, value, startCodeUnit, options, byteOffsets) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > options.maxAnchorBytes) return undefined;
  const startByte = byteOffsets[startCodeUnit];
  const endByte = startByte + byteLength;
  const sensitive = caseSensitive(type);
  const normalized = normalizeExactValue(value, { foldCase: !sensitive });
  return Object.freeze({
    type,
    value,
    normalized,
    folded: normalizeExactValue(value, { foldCase: true }),
    caseSensitive: sensitive,
    startByte,
    endByte,
    specificity: TYPE_SPECIFICITY[type] ?? 0.8,
  });
}

function collectMatches(
  target,
  text,
  expression,
  type,
  options,
  byteOffsets,
  group = 0,
  prefixGroup = undefined,
) {
  for (const match of text.matchAll(expression)) {
    const value = match[group];
    const resolvedType = typeof type === "function" ? type(value, match) : type;
    const prefixLength = prefixGroup === undefined ? 0 : match[prefixGroup].length;
    const anchor = anchorRecord(
      resolvedType,
      value,
      match.index + prefixLength,
      options,
      byteOffsets,
    );
    if (anchor) target.push(anchor);
  }
}

function collectCamelMatches(target, text, options, byteOffsets) {
  for (const match of text.matchAll(CAMEL_CANDIDATE)) {
    const value = match[0];
    if (!camelLike(value)) continue;
    const type = ERROR_CLASS.test(value) ? "error" : "symbol";
    const anchor = anchorRecord(type, value, match.index, options, byteOffsets);
    if (anchor) target.push(anchor);
  }
}

function compareAnchors(left, right) {
  return left.startByte - right.startByte
    || right.endByte - left.endByte
    || compareText(left.type, right.type)
    || compareText(left.value, right.value);
}

/** Extract bounded, exact referents with UTF-8 source coordinates. */
export function extractExactAnchors(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("Exact extraction requires string text.");
  if (typeof text.isWellFormed === "function" && !text.isWellFormed()) {
    throw new TypeError("Exact extraction text must not contain unpaired UTF-16 surrogates.");
  }
  const normalizedOptions = {
    maxAnchors: positiveInteger(options.maxAnchors ?? DEFAULT_EXACT_ANCHOR_LIMIT, "maxAnchors"),
    maxAnchorBytes: positiveInteger(options.maxAnchorBytes ?? MAX_ANCHOR_BYTES, "maxAnchorBytes", 4_096),
  };
  const byteOffsets = utf8ByteOffsets(text);
  const anchors = [];

  collectMatches(
    anchors,
    text,
    /(["'`])((?:\\.|(?!\1)[^\\\r\n]){1,256})\1/gu,
    "quoted-value",
    normalizedOptions,
    byteOffsets,
    2,
    1,
  );
  collectMatches(
    anchors,
    text,
    /\bhttps?:\/\/[^\s<>"'`]+/giu,
    "url",
    normalizedOptions,
    byteOffsets,
  );
  collectMatches(
    anchors,
    text,
    /(^|[\s("'`=])((?:(?:(?:\.{1,2}|~)?[\\/]|[A-Za-z]:[\\/])?)(?:[\p{L}\p{N}_@.+-]+[\\/])+[\p{L}\p{N}_@.+-]+)(?=$|[\s)"'`,:;!?])/gmu,
    "path",
    normalizedOptions,
    byteOffsets,
    2,
    1,
  );
  collectMatches(
    anchors,
    text,
    /\b(?:[$A-Za-z_][$A-Za-z0-9_]*\.)+[$A-Za-z_][$A-Za-z0-9_]*\b/gu,
    "dotted-name",
    normalizedOptions,
    byteOffsets,
  );
  collectMatches(
    anchors,
    text,
    /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/gu,
    snakeType,
    normalizedOptions,
    byteOffsets,
  );
  collectCamelMatches(anchors, text, normalizedOptions, byteOffsets);
  collectMatches(
    anchors,
    text,
    /\b[0-9a-fA-F]{7,40}\b/gu,
    "commit",
    normalizedOptions,
    byteOffsets,
  );
  collectMatches(
    anchors,
    text,
    /\b(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+|v?\d+\.\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?|0x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9_]*=[^\s,;]+)\b/gu,
    "value",
    normalizedOptions,
    byteOffsets,
  );

  anchors.sort(compareAnchors);
  const unique = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (anchor.type === "commit" && !commitLike(anchor.value)) continue;
    const identity = `${anchor.type}\u0000${anchor.startByte}\u0000${anchor.endByte}\u0000${anchor.value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(anchor);
    if (unique.length === normalizedOptions.maxAnchors) break;
  }
  return Object.freeze(unique);
}

function queryAnchor(classified, source = {}) {
  const sensitive = caseSensitive(classified.type);
  return Object.freeze({
    type: classified.type,
    value: classified.value,
    normalized: normalizeExactValue(classified.value, { foldCase: !sensitive }),
    folded: normalizeExactValue(classified.value, { foldCase: true }),
    caseSensitive: sensitive,
    specificity: TYPE_SPECIFICITY[classified.type] ?? 0.8,
    startByte: source.startByte,
    endByte: source.endByte,
  });
}

/** Preserve exact-looking input as one lookup unit before any lexical fallback. */
export function planExactQuery(query, options = {}) {
  if (typeof query !== "string") throw new TypeError("Exact queries must be strings.");
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return Object.freeze({
      query,
      exactLooking: false,
      preservedWhole: false,
      requiresExactFirst: false,
      broadeningAllowed: true,
      anchors: Object.freeze([]),
    });
  }
  const whole = classifyExactValue(trimmed);
  let anchors;
  if (whole) {
    anchors = [queryAnchor(whole)];
  } else {
    anchors = extractExactAnchors(query, {
      maxAnchors: options.maxAnchors ?? 32,
      maxAnchorBytes: options.maxAnchorBytes ?? MAX_ANCHOR_BYTES,
    }).map((anchor) => queryAnchor(anchor, anchor));
  }
  const unique = [];
  const seen = new Set();
  for (const anchor of anchors.sort((left, right) => right.specificity - left.specificity
    || compareText(left.normalized, right.normalized))) {
    const identity = `${anchor.type}\u0000${anchor.normalized}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(anchor);
  }
  return Object.freeze({
    query,
    exactLooking: unique.length > 0,
    preservedWhole: whole !== undefined,
    requiresExactFirst: unique.length > 0,
    broadeningAllowed: unique.length === 0,
    anchors: Object.freeze(unique),
  });
}

function bucketFor(createdAt, bucketMs) {
  return Math.floor(nonNegativeInteger(createdAt, "createdAt") / bucketMs);
}

export const exactKeys = Object.freeze({
  posting({
    project,
    caseMode,
    term,
    bucket,
    documentId,
    version,
    generation,
    windowOrdinal,
    segment = 0,
  }) {
    return [
      KEYSPACE.EXACT,
      identifier(project, "project"),
      identifier(caseMode, "caseMode"),
      identifier(term, "term"),
      nonNegativeInteger(bucket, "bucket"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      positiveInteger(generation, "generation"),
      nonNegativeInteger(windowOrdinal, "windowOrdinal"),
      nonNegativeInteger(segment, "segment"),
    ];
  },
  termPrefix(project, caseMode, term) {
    return [
      KEYSPACE.EXACT,
      identifier(project, "project"),
      identifier(caseMode, "caseMode"),
      identifier(term, "term"),
    ];
  },
});

function postingGroupKey(key) {
  return encodeKey(key).toString("base64url");
}

function compareMatches(left, right) {
  return left.startByte - right.startByte || left.endByte - right.endByte
    || compareText(left.type, right.type) || compareText(left.value, right.value);
}

function exactMutationsForAnchors(context, anchors, options = {}) {
  const bucketMs = positiveInteger(options.bucketMs ?? DEFAULT_EXACT_BUCKET_MS, "bucketMs");
  const manifest = context.manifest;
  const bucket = bucketFor(manifest.createdAt, bucketMs);
  const groups = new Map();
  let postingMutationCount = 0;
  let observedPostingMutations = 0;
  let omittedMatches = 0;
  const rankedAnchors = [...anchors].sort((left, right) =>
    right.specificity - left.specificity || compareAnchors(left, right));
  for (const anchor of rankedAnchors) {
    const window = windowForByteRange(context.windows, anchor.startByte, anchor.endByte);
    const modes = [{ caseMode: "exact", term: anchor.normalized }];
    if (anchor.caseSensitive) {
      modes.push({ caseMode: "folded", term: anchor.folded });
    }
    for (const mode of modes) {
      const key = exactKeys.posting({
        project: manifest.project,
        caseMode: mode.caseMode,
        term: mode.term,
        bucket,
        documentId: manifest.documentId,
        version: manifest.version,
        generation: context.generation,
        windowOrdinal: window.ordinal,
      });
      const identity = postingGroupKey(key);
      let group = groups.get(identity);
      const startsPosting = group === undefined
        || group.matches.length % MAX_MATCHES_PER_POSTING === 0;
      if (startsPosting) {
        observedPostingMutations += 1;
        if (postingMutationCount === MAX_EXACT_POSTING_MUTATIONS) {
          omittedMatches += 1;
          continue;
        }
        postingMutationCount += 1;
      }
      if (!group) {
        group = { key, caseMode: mode.caseMode, term: mode.term, window, matches: [] };
        groups.set(identity, group);
      }
      group.matches.push({
        type: anchor.type,
        value: anchor.value,
        startByte: anchor.startByte,
        endByte: anchor.endByte,
        specificity: anchor.specificity,
      });
    }
  }

  const sourceMessageKeys = [...manifest.sourceMessageKeys];
  const mutations = [...groups.values()].flatMap((group) => {
    group.matches.sort(compareMatches);
    const postings = [];
    for (let offset = 0, segment = 0; offset < group.matches.length;
      offset += MAX_MATCHES_PER_POSTING, segment += 1) {
      postings.push({
      type: "put",
      key: [...group.key.slice(0, -1), segment],
      kind: "exact-posting",
      // Derived postings are replaceable during an explicit index rebuild;
      // canonical sources remain immutable.
      immutable: false,
      payload: {
        postingVersion: EXACT_POSTING_VERSION,
        generation: context.generation,
        sourceVersion: manifest.version,
        project: manifest.project,
        sessionId: manifest.sessionId,
        bucket,
        createdAt: manifest.createdAt,
        documentId: manifest.documentId,
        documentVersion: manifest.version,
        documentKind: manifest.kind,
        sourceKey: manifest.sourceKey,
        sourceKeyStatus: manifest.sourceKeyStatus,
        sourceMessageKeys,
        turnId: semanticIdentifier(manifest.metadata?.turnId) ?? null,
        windowOrdinal: group.window.ordinal,
        windowStartByte: group.window.startByte,
        windowEndByte: group.window.endByte,
        caseMode: group.caseMode,
        normalizedTerm: group.term,
        matches: group.matches.slice(offset, offset + MAX_MATCHES_PER_POSTING),
      },
      });
    }
    return postings;
  });
  mutations.sort((left, right) => Buffer.compare(encodeKey(left.key), encodeKey(right.key)));
  return Object.freeze({
    metadata: Object.freeze({
      anchorCount: anchors.length,
      postingCount: mutations.length,
      indexedMatchCount: mutations.reduce((total, mutation) =>
        total + mutation.payload.matches.length, 0),
      omittedMatchCount: omittedMatches,
      ...(omittedMatches === 0 ? {} : {
        status: "partial",
        reason: "preparation-limit",
        limitKind: "exact posting mutations",
        limit: MAX_EXACT_POSTING_MUTATIONS,
        observed: observedPostingMutations,
      }),
      bucket,
      bucketMs,
    }),
    mutations: Object.freeze(mutations),
  });
}

/** Build deterministic exact posting mutations for one immutable in-memory source. */
export function buildExactIndexMutations(context, options = {}) {
  if (!context || typeof context !== "object" || typeof context.text !== "string"
    || !context.manifest || !Array.isArray(context.windows)) {
    throw new TypeError("Exact indexing requires an IndexWorker handler context.");
  }
  const anchors = extractExactAnchors(context.text, options);
  preparationLimit("exact", "exact anchors", MAX_EXACT_INDEX_ANCHORS, anchors.length);
  return exactMutationsForAnchors(context, anchors, options);
}

/**
 * Extract exact anchors from fixed-size source ranges. Overlap supplies regex
 * boundary context while core-range ownership prevents duplicate postings.
 */
export async function buildExactIndexMutationsFromRanges(context, options = {}) {
  if (!context || typeof context !== "object" || typeof context.readSourceRange !== "function"
    || typeof context.yieldControl !== "function" || !context.manifest
    || !Array.isArray(context.windows)) {
    throw new TypeError("Range exact indexing requires a bounded IndexWorker source context.");
  }
  const maxAnchors = positiveInteger(
    options.maxAnchors ?? DEFAULT_EXACT_ANCHOR_LIMIT,
    "maxAnchors",
  );
  const maxAnchorBytes = positiveInteger(
    options.maxAnchorBytes ?? MAX_ANCHOR_BYTES,
    "maxAnchorBytes",
    4_096,
  );
  const segmentBytes = positiveInteger(context.sourceSegmentBytes, "sourceSegmentBytes");
  // Quoted anchors allow 256 Unicode scalars. Keep enough context to observe
  // their closing delimiter as well as one byte beyond the largest accepted
  // un-delimited anchor, so a truncated long token cannot become a false hit.
  const overlapBytes = Math.max(maxAnchorBytes + 8, (256 * 4) + 8);
  const anchors = [];
  const byteLength = context.manifest.byteLength;
  for (let coreStart = 0; coreStart < byteLength && anchors.length < maxAnchors;
    coreStart += segmentBytes) {
    const coreEnd = Math.min(byteLength, coreStart + segmentBytes);
    const selected = await context.readSourceRange(
      Math.max(0, coreStart - overlapBytes),
      Math.min(byteLength, coreEnd + overlapBytes),
      { adjustUtf8: true },
    );
    const candidates = extractExactAnchors(selected.text, {
      ...options,
      maxAnchors,
      maxAnchorBytes,
    });
    for (const candidate of candidates) {
      const startByte = selected.startByte + candidate.startByte;
      if (startByte < coreStart || startByte >= coreEnd) continue;
      anchors.push(Object.freeze({
        ...candidate,
        startByte,
        endByte: selected.startByte + candidate.endByte,
      }));
      preparationLimit("exact", "exact anchors", MAX_EXACT_INDEX_ANCHORS, anchors.length);
      if (anchors.length === maxAnchors) break;
    }
    await context.yieldControl();
  }
  return exactMutationsForAnchors(context, Object.freeze(anchors), options);
}

/** Create the independently pluggable exact-posting IndexWorker handler. */
export function createExactIndexHandler(options = {}) {
  const captured = { ...options };
  return Object.freeze({
    id: EXACT_INDEX_HANDLER_ID,
    operations: Object.freeze(["index"]),
    prepare(context) {
      return typeof context?.readSourceRange === "function"
        ? buildExactIndexMutationsFromRanges(context, captured)
        : buildExactIndexMutations(context, captured);
    },
  });
}

function normalizedLookupOptions(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Exact lookup request must be an object.");
  }
  const scope = request.scope ?? "session";
  if (scope !== "session" && scope !== "project") {
    throw new TypeError("Exact lookup scope must be session or project.");
  }
  const sessionIds = request.sessionIds ?? (request.sessionId === undefined ? [] : [request.sessionId]);
  if (!Array.isArray(sessionIds) || sessionIds.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("sessionIds must be an array of non-empty strings.");
  }
  if (scope === "session" && sessionIds.length === 0) {
    throw new TypeError("Session-scoped exact lookup requires sessionId or sessionIds.");
  }
  const excluded = assertVisibleSourceKeys(request.excludeVisibleSourceKeys ?? []);
  const minBucket = request.minBucket ?? 0;
  const maxBucket = request.maxBucket ?? Number.MAX_SAFE_INTEGER;
  nonNegativeInteger(minBucket, "minBucket");
  nonNegativeInteger(maxBucket, "maxBucket");
  if (maxBucket < minBucket) throw new RangeError("maxBucket must not precede minBucket.");
  return Object.freeze({
    query: request.query,
    project: identifier(request.project, "project"),
    scope,
    sessionIds: new Set(sessionIds),
    excluded: new Set(excluded),
    limit: positiveInteger(request.limit ?? 3, "limit", 100),
    workLimit: positiveInteger(request.workLimit ?? DEFAULT_EXACT_WORK_LIMIT, "workLimit", MAX_SCAN_LIMIT),
    bucketLimit: positiveInteger(request.bucketLimit ?? DEFAULT_EXACT_BUCKET_LIMIT, "bucketLimit", 10_000),
    minBucket,
    maxBucket,
    maxSnippetBytes: positiveInteger(
      request.maxSnippetBytes ?? DEFAULT_EXACT_SNIPPET_BYTES,
      "maxSnippetBytes",
      16_384,
    ),
    allowCaseFold: request.allowCaseFold !== false,
  });
}

function validatePosting(record) {
  const posting = record?.payload;
  if (!posting || posting.postingVersion !== EXACT_POSTING_VERSION
    || !Number.isSafeInteger(posting.bucket) || !Array.isArray(posting.matches)) {
    throw new ExactIndexError("An exact posting is malformed.", { key: record?.key });
  }
  return posting;
}

function postingVisible(posting, options) {
  if (posting.project !== options.project) return false;
  if (posting.generation > options.generation) return false;
  if (posting.bucket < options.minBucket || posting.bucket > options.maxBucket) return false;
  if (options.scope === "session" && !options.sessionIds.has(posting.sessionId)) return false;
  return !posting.sourceMessageKeys.some((sourceKey) => options.excluded.has(sourceKey));
}

function evidenceIdentity(anchor) {
  return `${anchor.type}\u0000${anchor.normalized}`;
}

function locationIdentity(posting) {
  return `${posting.documentId}\u0000${posting.documentVersion}`;
}

function addPostingCandidate(candidates, posting, queryAnchorValue, caseMode) {
  const identity = locationIdentity(posting);
  let candidate = candidates.get(identity);
  const bestMatch = [...posting.matches].sort((left, right) =>
    (right.specificity ?? TYPE_SPECIFICITY[right.type] ?? 0.8)
      - (left.specificity ?? TYPE_SPECIFICITY[left.type] ?? 0.8)
      || compareMatches(left, right))[0];
  if (!candidate) {
    candidate = {
      posting,
      bestMatch,
      bestCaseMode: caseMode,
      queryEvidence: new Map(),
      postingCount: 0,
    };
    candidates.set(identity, candidate);
  }
  candidate.postingCount += 1;
  candidate.queryEvidence.set(evidenceIdentity(queryAnchorValue), {
    query: queryAnchorValue,
    caseMode,
    matches: posting.matches,
  });
  const currentSpecificity = candidate.bestMatch?.specificity ?? TYPE_SPECIFICITY[candidate.bestMatch?.type] ?? 0;
  const nextSpecificity = bestMatch?.specificity ?? TYPE_SPECIFICITY[bestMatch?.type] ?? 0;
  if (caseMode === "exact" && candidate.bestCaseMode !== "exact"
    || caseMode === candidate.bestCaseMode && nextSpecificity > currentSpecificity) {
    candidate.posting = posting;
    candidate.bestMatch = bestMatch;
    candidate.bestCaseMode = caseMode;
  }
}

function candidateScore(candidate, anchorCount) {
  const coverage = candidate.queryEvidence.size / Math.max(1, anchorCount);
  const specificity = candidate.bestMatch?.specificity
    ?? TYPE_SPECIFICITY[candidate.bestMatch?.type]
    ?? 0.8;
  const caseScore = candidate.bestCaseMode === "exact" ? 1 : 0.72;
  return Number(Math.min(1, 0.55 + (0.25 * caseScore) + (0.12 * coverage) + (0.08 * specificity)).toFixed(6));
}

function continuationByte(value) {
  return (value & 0xc0) === 0x80;
}

/** Render a bounded source-derived snippet around an exact UTF-8 match. */
export function exactSnippet(
  text,
  startByte,
  endByte,
  maxBytes = DEFAULT_EXACT_SNIPPET_BYTES,
  { preceded = false, followed = false } = {},
) {
  if (typeof text !== "string") throw new TypeError("Snippet text must be a string.");
  nonNegativeInteger(startByte, "startByte");
  nonNegativeInteger(endByte, "endByte");
  positiveInteger(maxBytes, "maxBytes", 16_384);
  const bytes = Buffer.from(text, "utf8");
  if (endByte < startByte || endByte > bytes.length) {
    throw new RangeError("Exact snippet coordinates are outside the source text.");
  }
  if (bytes.length <= maxBytes && !preceded && !followed) return text;
  const matchLength = endByte - startByte;
  const contentBudget = Math.max(1, maxBytes - 6);
  const usableMatchLength = Math.min(matchLength, contentBudget);
  const remaining = contentBudget - usableMatchLength;
  let start = Math.max(0, startByte - Math.floor(remaining / 2));
  let end = Math.min(bytes.length, Math.max(endByte, startByte + usableMatchLength) + Math.ceil(remaining / 2));
  if (end - start > contentBudget) end = start + contentBudget;
  if (end - start < contentBudget && start > 0) start = Math.max(0, end - contentBudget);
  while (start < startByte && continuationByte(bytes[start])) start += 1;
  while (end > start && end < bytes.length && continuationByte(bytes[end])) end -= 1;
  const prefix = preceded || start > 0 ? "…" : "";
  const suffix = followed || end < bytes.length ? "…" : "";
  return `${prefix}${bytes.subarray(start, end).toString("utf8")}${suffix}`;
}

async function materializeResult(store, candidate, plan, options) {
  const posting = candidate.posting;
  if (store.scan([
    KEYSPACE.SUPERSESSION,
    posting.documentId,
    posting.documentVersion,
  ], { limit: 1 }).length > 0) return undefined;
  const manifest = await store.get(manifestKeys.document(posting.documentId, posting.documentVersion));
  if (manifest === undefined) return undefined;
  const current = store.scan([KEYSPACE.DOCUMENT, posting.documentId], { reverse: true, limit: 1 })[0]?.payload;
  if (current === undefined || current.version !== posting.documentVersion) return undefined;
  const match = candidate.bestMatch;
  const range = await readDocumentRange(
    store,
    manifest,
    Math.max(0, match.startByte - options.maxSnippetBytes),
    Math.min(manifest.byteLength, match.endByte + options.maxSnippetBytes),
    { adjustUtf8: true },
  );
  const score = candidateScore(candidate, plan.anchors.length);
  const matchedAnchors = plan.anchors
    .filter((anchor) => candidate.queryEvidence.has(evidenceIdentity(anchor)))
    .map(({ value }) => value);
  return {
    documentId: posting.documentId,
    version: posting.documentVersion,
    kind: posting.documentKind,
    createdAt: posting.createdAt,
    score,
    matchType: `exact-${match.type}`,
    matchedAnchors,
    snippet: exactSnippet(
      range.text,
      match.startByte - range.startByte,
      match.endByte - range.startByte,
      options.maxSnippetBytes,
      {
        preceded: range.startByte > 0,
        followed: range.endByte < manifest.byteLength,
      },
    ),
    historical: true,
    superseded: false,
    locator: null,
    source: {
      project: posting.project,
      sessionId: posting.sessionId,
      turnId: semanticIdentifier(posting.turnId),
      messageKey: posting.sourceKeyStatus === "unavailable"
        ? undefined
        : (posting.sourceMessageKeys[0] ?? posting.sourceKey),
      sourceMessageKeys: posting.sourceMessageKeys,
    },
    location: {
      windowOrdinal: posting.windowOrdinal,
      startByte: match.startByte,
      endByte: match.endByte,
      generation: posting.generation,
      bucket: posting.bucket,
    },
    explanation: {
      mode: "exact",
      caseMode: candidate.bestCaseMode,
      matchedType: match.type,
      matchedValue: match.value,
      queryAnchors: plan.anchors.map(({ type, value }) => ({ type, value })),
      matchedAnchorCount: candidate.queryEvidence.size,
      postingCount: candidate.postingCount,
      scoreFactors: {
        case: candidate.bestCaseMode === "exact" ? 1 : 0.72,
        coverage: candidate.queryEvidence.size / Math.max(1, plan.anchors.length),
        specificity: match.specificity ?? TYPE_SPECIFICITY[match.type] ?? 0.8,
      },
    },
  };
}

async function scanCaseMode(store, plan, options, caseMode, candidates, work) {
  for (const anchor of plan.anchors) {
    const term = caseMode === "exact" ? anchor.normalized : anchor.folded;
    if (caseMode === "folded" && !anchor.caseSensitive) continue;
    const remaining = options.workLimit - work.postingsRead;
    if (remaining <= 0) {
      work.truncated = true;
      break;
    }
    const records = store.scan(exactKeys.termPrefix(options.project, caseMode, term), {
      reverse: true,
      limit: Math.min(MAX_SCAN_LIMIT, remaining + 1),
    });
    const usable = records.slice(0, remaining);
    if (records.length > usable.length) work.truncated = true;
    for (const record of usable) {
      work.postingsRead += 1;
      const posting = validatePosting(record);
      if (posting.bucket < options.minBucket) break;
      if (posting.bucket > options.maxBucket) continue;
      if (!work.bucketSet.has(posting.bucket)) {
        if (work.bucketSet.size >= options.bucketLimit) {
          work.truncated = true;
          break;
        }
        work.bucketSet.add(posting.bucket);
      }
      if (!postingVisible(posting, options)) continue;
      addPostingCandidate(candidates, posting, anchor, caseMode);
    }
  }
}

/** Bounded exact lookup with case-aware fallback, scope filters, snippets, and explanations. */
export async function lookupExact(store, request) {
  if (store && typeof store.snapshot === "function") {
    return store.snapshot((snapshot) => lookupExact(snapshot, request));
  }
  if (!store || typeof store.scan !== "function" || typeof store.get !== "function") {
    throw new TypeError("Exact lookup requires a RocksStore-compatible store.");
  }
  const requestedGeneration = request?.generation;
  const publication = await store.get([KEYSPACE.META, "published-index-generation"]);
  const publishedGeneration = publication?.generation ?? 0;
  if (!Number.isSafeInteger(publishedGeneration) || publishedGeneration < 0) {
    throw new ExactIndexError("The published index generation is malformed.");
  }
  if (requestedGeneration !== undefined
    && (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 0)) {
    throw new TypeError("generation must be a non-negative safe integer.");
  }
  if (requestedGeneration > publishedGeneration) {
    throw new RangeError("generation is newer than the published index.");
  }
  const options = Object.freeze({
    ...normalizedLookupOptions(request),
    generation: requestedGeneration ?? publishedGeneration,
  });
  const plan = planExactQuery(options.query);
  const candidates = new Map();
  const work = { postingsRead: 0, bucketSet: new Set(), truncated: false };
  if (plan.anchors.length > 0) {
    await scanCaseMode(store, plan, options, "exact", candidates, work);
    if (candidates.size === 0 && options.allowCaseFold && work.postingsRead < options.workLimit) {
      await scanCaseMode(store, plan, options, "folded", candidates, work);
    }
  }

  const ranked = [...candidates.values()].sort((left, right) =>
    candidateScore(right, plan.anchors.length) - candidateScore(left, plan.anchors.length)
      || right.queryEvidence.size - left.queryEvidence.size
      || right.posting.bucket - left.posting.bucket
      || right.posting.createdAt - left.posting.createdAt
      || compareText(left.posting.documentId, right.posting.documentId));
  const results = [];
  for (const candidate of ranked) {
    const result = await materializeResult(store, candidate, plan, options);
    if (result !== undefined) results.push(result);
    if (results.length === options.limit) break;
  }
  for (let index = 0; index < results.length; index += 1) {
    results[index].margin = Number((results[index].score - (results[index + 1]?.score ?? 0)).toFixed(6));
    Object.freeze(results[index].matchedAnchors);
    Object.freeze(results[index].source.sourceMessageKeys);
    Object.freeze(results[index].source);
    Object.freeze(results[index].location);
    Object.freeze(results[index].explanation.queryAnchors);
    Object.freeze(results[index].explanation.scoreFactors);
    Object.freeze(results[index].explanation);
    Object.freeze(results[index]);
  }
  return Object.freeze({
    results: Object.freeze(results),
    plan,
    work: Object.freeze({
      postingsRead: work.postingsRead,
      bucketsVisited: work.bucketSet.size,
      truncated: work.truncated,
      workLimit: options.workLimit,
      bucketLimit: options.bucketLimit,
      caseFallbackUsed: results.some(({ explanation }) => explanation.caseMode === "folded"),
    }),
  });
}
