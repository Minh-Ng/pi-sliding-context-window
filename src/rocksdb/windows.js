import { TextDecoder } from "node:util";
import { assertChunkLayout } from "./chunks.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const SEARCH_WINDOW_FORMAT_VERSION = 1;
// Bounds per-admission object expansion without imposing a database-size cap.
export const MAX_SEARCH_TOKENS_PER_DOCUMENT = 250_000;
export const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  windowTokens: 900,
  overlapRatio: 0.15,
});

function requireWellFormedText(value) {
  if (typeof value !== "string") throw new TypeError("text must be a string.");
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) {
    throw new TypeError("text must not contain unpaired UTF-16 surrogates.");
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/** Resolve a token count and overlap into deterministic integer parameters. */
export function normalizeWindowOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Window options must be an object.");
  }
  const windowTokens = positiveInteger(
    options.windowTokens ?? DEFAULT_WINDOW_OPTIONS.windowTokens,
    "windowTokens",
  );
  let overlapTokens;
  let overlapRatio;
  if (options.overlapTokens !== undefined) {
    overlapTokens = nonNegativeInteger(options.overlapTokens, "overlapTokens");
    overlapRatio = overlapTokens / windowTokens;
  } else {
    overlapRatio = options.overlapRatio ?? DEFAULT_WINDOW_OPTIONS.overlapRatio;
    if (typeof overlapRatio !== "number"
      || !Number.isFinite(overlapRatio)
      || overlapRatio < 0
      || overlapRatio >= 1) {
      throw new RangeError("overlapRatio must be at least 0 and less than 1.");
    }
    overlapTokens = Math.floor(windowTokens * overlapRatio);
  }
  if (overlapTokens >= windowTokens) {
    throw new RangeError("overlapTokens must be smaller than windowTokens.");
  }
  return Object.freeze({ windowTokens, overlapTokens, overlapRatio });
}

/**
 * Deterministically approximate model tokens while preserving exact UTF-8
 * byte coordinates. Word-like runs are one token; visible punctuation is one
 * token. The evaluation harness can inject a different tokenizer when needed.
 */
export function tokenizeWithByteOffsets(text) {
  const source = requireWellFormedText(text);
  const tokens = [];
  const expression = /[\p{L}\p{M}\p{N}_]+|[^\s]/gu;
  let previousCodeUnitEnd = 0;
  let previousByteEnd = 0;
  for (const match of source.matchAll(expression)) {
    if (tokens.length >= MAX_SEARCH_TOKENS_PER_DOCUMENT) {
      const error = new RangeError(
        `Document contains more than ${MAX_SEARCH_TOKENS_PER_DOCUMENT} searchable tokens; split it into smaller archival documents.`,
      );
      error.code = "INVALID_REQUEST";
      throw error;
    }
    const skipped = source.slice(previousCodeUnitEnd, match.index);
    const startByte = previousByteEnd + Buffer.byteLength(skipped, "utf8");
    const tokenBytes = Buffer.byteLength(match[0], "utf8");
    const endByte = startByte + tokenBytes;
    tokens.push(Object.freeze({
      value: match[0],
      startByte,
      endByte,
    }));
    previousCodeUnitEnd = match.index + match[0].length;
    previousByteEnd = endByte;
  }
  return Object.freeze(tokens);
}

function validateTokenRanges(tokens, byteLength) {
  if (!Array.isArray(tokens)) throw new TypeError("A tokenizer must return an array.");
  if (tokens.length > MAX_SEARCH_TOKENS_PER_DOCUMENT) {
    const error = new RangeError(
      `Tokenizer returned more than ${MAX_SEARCH_TOKENS_PER_DOCUMENT} searchable tokens.`,
    );
    error.code = "INVALID_REQUEST";
    throw error;
  }
  let previousEnd = 0;
  return Object.freeze(tokens.map((token, index) => {
    if (!token || typeof token !== "object" || Array.isArray(token)) {
      throw new TypeError(`Token ${index} must be an object.`);
    }
    const startByte = nonNegativeInteger(token.startByte, `tokens[${index}].startByte`);
    const endByte = nonNegativeInteger(token.endByte, `tokens[${index}].endByte`);
    if (endByte <= startByte || startByte < previousEnd || endByte > byteLength) {
      throw new RangeError(`Token ${index} has invalid or overlapping byte coordinates.`);
    }
    previousEnd = endByte;
    if (token.startByte === startByte && token.endByte === endByte && Object.isFrozen(token)) {
      return token;
    }
    return Object.freeze({ ...token, startByte, endByte });
  }));
}

function chunksForRange(chunks, startByte, endByte) {
  const selected = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const intersects = startByte === endByte
      ? chunk.startByte === startByte && chunk.endByte === endByte
      : chunk.startByte < endByte && chunk.endByte > startByte;
    if (!intersects || seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);
    selected.push(chunk.chunkId);
  }
  if (selected.length === 0 && chunks.length === 1 && chunks[0].startByte === chunks[0].endByte) {
    selected.push(chunks[0].chunkId);
  }
  if (selected.length === 0) {
    throw new RangeError(`No physical chunk covers logical byte range ${startByte}:${endByte}.`);
  }
  return Object.freeze(selected);
}

/**
 * Build overlapping logical search windows without copying payload text.
 * `chunks` are ordered manifest references, including repeated content IDs.
 */
export function createSearchWindows({
  text,
  documentId,
  documentVersion,
  chunks,
  indexGeneration = 0,
} = {}, options = {}) {
  const source = requireWellFormedText(text);
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new TypeError("documentId must be a non-empty string.");
  }
  positiveInteger(documentVersion, "documentVersion");
  nonNegativeInteger(indexGeneration, "indexGeneration");
  const byteLength = Buffer.byteLength(source, "utf8");
  assertChunkLayout(chunks, byteLength);
  const normalized = normalizeWindowOptions(options);
  const tokenizer = options.tokenize ?? tokenizeWithByteOffsets;
  if (typeof tokenizer !== "function") throw new TypeError("tokenize must be a function.");
  const tokens = validateTokenRanges(tokenizer(source), byteLength);
  const windows = [];

  if (tokens.length === 0) {
    windows.push(Object.freeze({
      windowFormatVersion: SEARCH_WINDOW_FORMAT_VERSION,
      documentId,
      documentVersion,
      ordinal: 0,
      startByte: 0,
      endByte: byteLength,
      chunkIds: chunksForRange(chunks, 0, byteLength),
      indexGeneration,
    }));
    return Object.freeze(windows);
  }

  const step = normalized.windowTokens - normalized.overlapTokens;
  for (let startToken = 0; startToken < tokens.length; startToken += step) {
    const endToken = Math.min(startToken + normalized.windowTokens, tokens.length);
    const startByte = startToken === 0 ? 0 : tokens[startToken].startByte;
    // End at the next token's start to retain intervening whitespace while
    // keeping adjacent non-overlapping windows gap-free.
    const endByte = endToken === tokens.length ? byteLength : tokens[endToken].startByte;
    windows.push(Object.freeze({
      windowFormatVersion: SEARCH_WINDOW_FORMAT_VERSION,
      documentId,
      documentVersion,
      ordinal: windows.length,
      startByte,
      endByte,
      chunkIds: chunksForRange(chunks, startByte, endByte),
      indexGeneration,
    }));
    if (endToken === tokens.length) break;
  }
  return Object.freeze(windows);
}

/** Return all logical windows intersecting a half-open source byte range. */
export function windowsForByteRange(windows, startByte, endByte) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new TypeError("windows must contain at least one logical window.");
  }
  nonNegativeInteger(startByte, "startByte");
  nonNegativeInteger(endByte, "endByte");
  if (endByte < startByte) throw new RangeError("endByte must not precede startByte.");
  return windows.filter((window, index) => {
    if (!window || window.ordinal !== index) throw new TypeError("windows must be ordered by ordinal.");
    if (startByte === endByte) {
      return (window.startByte <= startByte && startByte < window.endByte)
        || (index === windows.length - 1 && startByte === window.endByte);
    }
    return window.startByte < endByte && window.endByte > startByte;
  });
}

/** Resolve one deterministic containing window for an exact match range. */
export function windowForByteRange(windows, startByte, endByte) {
  const intersecting = windowsForByteRange(windows, startByte, endByte);
  const containing = intersecting.find((window, index) => window.startByte <= startByte
    && window.endByte >= endByte
    && (startByte < window.endByte || index === intersecting.length - 1));
  return containing ?? intersecting[0];
}

/** Decode an exact UTF-8 byte range, rejecting coordinates inside a scalar. */
export function sliceUtf8Bytes(text, startByte, endByte) {
  const source = requireWellFormedText(text);
  nonNegativeInteger(startByte, "startByte");
  nonNegativeInteger(endByte, "endByte");
  const bytes = Buffer.from(source, "utf8");
  if (endByte < startByte || endByte > bytes.length) {
    throw new RangeError("The requested byte range is outside the source text.");
  }
  try {
    return UTF8_DECODER.decode(bytes.subarray(startByte, endByte));
  } catch (error) {
    throw new RangeError(`The requested byte range does not align to UTF-8 boundaries: ${error.message}`);
  }
}
