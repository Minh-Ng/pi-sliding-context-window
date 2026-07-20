import { tokenizeWithByteOffsets } from "../rocksdb/windows.js";

export const DEFAULT_SEMANTIC_SPAN_OPTIONS = Object.freeze({
  spanTokens: 160,
  overlapTokens: 24,
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/** Split canonical text into model-sized spans while retaining exact byte coordinates. */
export function createSemanticSpans(text, {
  baseStartByte = 0,
  windowOrdinal = 0,
  spanTokens = DEFAULT_SEMANTIC_SPAN_OPTIONS.spanTokens,
  overlapTokens = DEFAULT_SEMANTIC_SPAN_OPTIONS.overlapTokens,
} = {}) {
  if (typeof text !== "string") throw new TypeError("Semantic span text must be a string.");
  if (!Number.isSafeInteger(baseStartByte) || baseStartByte < 0) {
    throw new TypeError("baseStartByte must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(windowOrdinal) || windowOrdinal < 0) {
    throw new TypeError("windowOrdinal must be a non-negative safe integer.");
  }
  positiveInteger(spanTokens, "spanTokens");
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= spanTokens) {
    throw new RangeError("overlapTokens must be non-negative and smaller than spanTokens.");
  }
  const tokens = tokenizeWithByteOffsets(text);
  if (tokens.length === 0) return Object.freeze([]);
  const step = spanTokens - overlapTokens;
  const spans = [];
  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(tokens.length, start + spanTokens);
    const localStartByte = tokens[start].startByte;
    const localEndByte = tokens[end - 1].endByte;
    const bytes = Buffer.from(text, "utf8").subarray(localStartByte, localEndByte);
    spans.push(Object.freeze({
      windowOrdinal,
      startByte: baseStartByte + localStartByte,
      endByte: baseStartByte + localEndByte,
      text: bytes.toString("utf8"),
    }));
    if (end === tokens.length) break;
  }
  return Object.freeze(spans);
}
