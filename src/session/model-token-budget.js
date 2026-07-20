const TOKEN_UNIT = /[\p{L}\p{M}\p{N}_]+|\s+|[^\s]/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_HEX = /^[a-fA-F0-9]{6,}$/u;

function opaqueIdentifier(value) {
  return value.length >= 12
    || value.includes("_")
    || (/\p{L}/u.test(value) && /\p{N}/u.test(value))
    || (/\p{Ll}/u.test(value) && /\p{Lu}/u.test(value))
    || ASCII_HEX.test(value);
}

/**
 * Deterministic fallback for model-visible token accounting.
 *
 * Every repository lexical token costs at least one unit. Cases that byte/4
 * systematically undercounts are charged more aggressively: JSON escapes and
 * punctuation are individual units, CJK and non-ASCII symbols use their UTF-8
 * byte length, and opaque identifiers use one unit per UTF-8 byte. Natural
 * word and whitespace runs retain a conservative byte/4 floor.
 */
export function estimateModelVisibleTokens(text) {
  if (typeof text !== "string") throw new TypeError("Model-visible text must be a string.");
  let total = 0;
  for (const match of text.matchAll(TOKEN_UNIT)) {
    const value = match[0];
    const bytes = Buffer.byteLength(value, "utf8");
    if (/^\s+$/u.test(value)) {
      total += Math.max(1, Math.ceil(bytes / 4));
    } else if (/^[\p{L}\p{M}\p{N}_]+$/u.test(value)) {
      total += CJK.test(value) || opaqueIdentifier(value)
        ? bytes
        : Math.max(1, Math.ceil(bytes / 4));
    } else {
      total += bytes;
    }
  }
  return total;
}

export function fitsModelVisibleTokenBudget(text, maxTokens) {
  return Number.isSafeInteger(maxTokens)
    && maxTokens >= 0
    && estimateModelVisibleTokens(text) <= maxTokens;
}

/** Longest Unicode-scalar prefix that fits after appending a fixed suffix. */
export function modelVisiblePrefix(text, maxTokens, suffix = "") {
  if (typeof text !== "string" || typeof suffix !== "string") {
    throw new TypeError("Model-visible prefix input and suffix must be strings.");
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new TypeError("maxTokens must be a non-negative safe integer.");
  }
  if (estimateModelVisibleTokens(suffix) > maxTokens) return "";
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, midpoint).join("");
    if (estimateModelVisibleTokens(candidate + suffix) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}
