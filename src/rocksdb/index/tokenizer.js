export const BM25_TOKENIZER_VERSION = 1;
export const MAX_BM25_TERM_CODE_POINTS = 128;

const WORD = /[\p{L}\p{M}\p{N}_]+/gu;

function isConsonant(word, index) {
  const character = word[index];
  if ("aeiou".includes(character)) return false;
  if (character !== "y") return true;
  return index === 0 || !isConsonant(word, index - 1);
}

function measure(word) {
  let count = 0;
  let index = 0;
  while (index < word.length && isConsonant(word, index)) index += 1;
  while (index < word.length) {
    while (index < word.length && !isConsonant(word, index)) index += 1;
    if (index >= word.length) break;
    count += 1;
    while (index < word.length && isConsonant(word, index)) index += 1;
  }
  return count;
}

function containsVowel(word) {
  for (let index = 0; index < word.length; index += 1) {
    if (!isConsonant(word, index)) return true;
  }
  return false;
}

function endsWithDoubleConsonant(word) {
  if (word.length < 2 || word.at(-1) !== word.at(-2)) return false;
  return isConsonant(word, word.length - 1);
}

function endsCvc(word) {
  if (word.length < 3) return false;
  const last = word.at(-1);
  return isConsonant(word, word.length - 3)
    && !isConsonant(word, word.length - 2)
    && isConsonant(word, word.length - 1)
    && !"wxy".includes(last);
}

function replaceMeasuredSuffix(word, suffix, replacement, minimumMeasure) {
  if (!word.endsWith(suffix)) return undefined;
  const stem = word.slice(0, -suffix.length);
  return measure(stem) > minimumMeasure ? stem + replacement : word;
}

function porterStem(input) {
  if (!/^[a-z]+$/u.test(input) || input.length < 3) return input;
  let word = input;

  if (word.endsWith("sses")) word = `${word.slice(0, -4)}ss`;
  else if (word.endsWith("ies")) word = `${word.slice(0, -3)}i`;
  else if (!word.endsWith("ss") && word.endsWith("s")) word = word.slice(0, -1);

  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3);
    if (measure(stem) > 0) word = `${stem}ee`;
  } else {
    const suffix = word.endsWith("ed") ? "ed" : word.endsWith("ing") ? "ing" : undefined;
    if (suffix) {
      const stem = word.slice(0, -suffix.length);
      if (containsVowel(stem)) {
        word = stem;
        if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) word += "e";
        else if (endsWithDoubleConsonant(word) && !/[lsz]$/u.test(word)) word = word.slice(0, -1);
        else if (measure(word) === 1 && endsCvc(word)) word += "e";
      }
    }
  }

  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (containsVowel(stem)) word = `${stem}i`;
  }

  const step2 = [
    ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
    ["izer", "ize"], ["bli", "ble"], ["alli", "al"], ["entli", "ent"],
    ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
    ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
    ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
    ["logi", "log"],
  ];
  for (const [suffix, replacement] of step2) {
    const replaced = replaceMeasuredSuffix(word, suffix, replacement, 0);
    if (replaced !== undefined) {
      word = replaced;
      break;
    }
  }

  const step3 = [
    ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
    ["ical", "ic"], ["ful", ""], ["ness", ""],
  ];
  for (const [suffix, replacement] of step3) {
    const replaced = replaceMeasuredSuffix(word, suffix, replacement, 0);
    if (replaced !== undefined) {
      word = replaced;
      break;
    }
  }

  const step4 = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment",
    "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
  ];
  for (const suffix of step4) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    if (measure(stem) > 1 && (suffix !== "ion" || /[st]$/u.test(stem))) word = stem;
    break;
  }

  if (word.endsWith("e")) {
    const stem = word.slice(0, -1);
    const stemMeasure = measure(stem);
    if (stemMeasure > 1 || (stemMeasure === 1 && !endsCvc(stem))) word = stem;
  }
  if (word.endsWith("ll") && measure(word) > 1) word = word.slice(0, -1);
  return word;
}

/** Normalize one already-delimited word into the deterministic BM25 term. */
export function normalizeBm25Term(value) {
  if (typeof value !== "string") throw new TypeError("BM25 terms must be strings.");
  const normalized = value.normalize("NFKC").toLowerCase();
  if (normalized.length === 0 || Array.from(normalized).length > MAX_BM25_TERM_CODE_POINTS) return "";
  if (!/^[\p{L}\p{M}\p{N}_]+$/u.test(normalized)) return "";
  return /^[a-z]+$/u.test(normalized) ? porterStem(normalized) : normalized;
}

/** Tokenize text with original UTF-8 byte positions and stable Porter terms. */
export function tokenizeBm25(text) {
  if (typeof text !== "string") throw new TypeError("BM25 text must be a string.");
  if (typeof text.isWellFormed === "function" && !text.isWellFormed()) {
    throw new TypeError("BM25 text must not contain unpaired UTF-16 surrogates.");
  }
  const tokens = [];
  let previousCodeUnitEnd = 0;
  let previousByteEnd = 0;
  let position = 0;
  for (const match of text.matchAll(WORD)) {
    const skipped = text.slice(previousCodeUnitEnd, match.index);
    const startByte = previousByteEnd + Buffer.byteLength(skipped, "utf8");
    const endByte = startByte + Buffer.byteLength(match[0], "utf8");
    const term = normalizeBm25Term(match[0]);
    if (term) {
      tokens.push(Object.freeze({
        term,
        surface: match[0],
        position,
        startByte,
        endByte,
      }));
    }
    position += 1;
    previousCodeUnitEnd = match.index + match[0].length;
    previousByteEnd = endByte;
  }
  return Object.freeze(tokens);
}

/** Unique normalized query terms in first-occurrence order. */
export function tokenizeBm25Query(query, options = {}) {
  const maxTerms = options.maxTerms ?? 20;
  if (!Number.isSafeInteger(maxTerms) || maxTerms <= 0 || maxTerms > 100) {
    throw new RangeError("maxTerms must be between 1 and 100.");
  }
  const terms = [];
  const seen = new Set();
  for (const token of tokenizeBm25(query)) {
    if (seen.has(token.term)) continue;
    seen.add(token.term);
    terms.push(token.term);
    if (terms.length === maxTerms) break;
  }
  return Object.freeze(terms);
}
