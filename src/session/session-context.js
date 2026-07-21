import { contentToText, groupCompleteTurns } from "./window.js";
import { tokenizeBm25 } from "../rocksdb/index/tokenizer.js";

/**
 * Explicit search/gather ranking signal only (ultracode task #32), never
 * consulted by automatic preflight: a deterministic digest of the recent
 * conversation prefix, computed purely client-side from the epoch's own
 * active messages -- no store round trip, no model call. The digest is the
 * top-K terms (SESSION_CONTEXT_TERM_LIMIT) from the last N complete
 * interaction groups (SESSION_CONTEXT_GROUP_WINDOW; one user turn plus
 * everything up to the next user turn, via groupCompleteTurns -- the same
 * grouping epoch-window.js already uses for turn-based rotation), ranked by
 * a *local* IDF proxy computed across those N groups themselves (each group
 * treated as one pseudo-document): a term present in fewer of the N groups
 * ranks higher, so a term that recurs across the whole window (ordinary
 * conversational language, repeated tool-call boilerplate) is naturally
 * deprioritized without a hand-maintained stopword list, while a term
 * concentrated in one or two recent groups -- the kind of thing actually
 * worth carrying into a ranking-boost signal -- ranks high. This is a local
 * proxy, not the corpus-wide IDF the BM25 index itself computes
 * (src/rocksdb/index/bm25.js): computing that here would require the very
 * store round trip this client-side digest exists to avoid, and RM3
 * expansion (src/retrieval/search.js) already gets a corpus-calibrated
 * signal from the store on the query side. Deterministic given a fixed
 * `messages` prefix and groupWindow/termLimit: same input, same digest,
 * every time -- ties break on term frequency, then lexicographically, so
 * there is never scan-order nondeterminism.
 */
export const SESSION_CONTEXT_GROUP_WINDOW = 6;
export const SESSION_CONTEXT_TERM_LIMIT = 16;

/**
 * Active-message content can carry unpaired UTF-16 surrogates (e.g. a
 * tool-result preview truncated mid-emoji/CJK by code-unit .slice() in
 * window.js), which tokenizeBm25 rejects. Sanitize here -- the one place raw
 * active-message text reaches the tokenizer -- rather than in the tokenizer
 * itself, since every other tokenizeBm25 caller feeds already-admitted,
 * pre-sanitized store content and is expected to throw on malformed input.
 */
function toWellFormedText(text) {
  return typeof text === "string" && typeof text.toWellFormed === "function"
    ? text.toWellFormed()
    : text;
}

function groupText(group) {
  return group.messages
    .map((message) => toWellFormedText(contentToText(message?.content)))
    .join("\n");
}

/** Pure, deterministic; exported for direct unit testing against hand-built message arrays. */
export function deriveSessionContextTerms(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return Object.freeze([]);
  const groupWindow = Number.isSafeInteger(options.groupWindow) && options.groupWindow > 0
    ? options.groupWindow
    : SESSION_CONTEXT_GROUP_WINDOW;
  const termLimit = Number.isSafeInteger(options.termLimit) && options.termLimit > 0
    ? options.termLimit
    : SESSION_CONTEXT_TERM_LIMIT;
  const groups = groupCompleteTurns(messages).slice(-groupWindow);
  if (groups.length === 0) return Object.freeze([]);
  const groupDocumentFrequency = new Map();
  const totalFrequency = new Map();
  for (const group of groups) {
    const seenInGroup = new Set();
    for (const token of tokenizeBm25(groupText(group))) {
      totalFrequency.set(token.term, (totalFrequency.get(token.term) ?? 0) + 1);
      if (seenInGroup.has(token.term)) continue;
      seenInGroup.add(token.term);
      groupDocumentFrequency.set(token.term, (groupDocumentFrequency.get(token.term) ?? 0) + 1);
    }
  }
  const groupCount = groups.length;
  const ranked = [...groupDocumentFrequency.entries()]
    .map(([term, documentFrequency]) => ({
      term,
      localIdf: Math.log((groupCount + 1) / (documentFrequency + 1)) + 1,
      totalFrequency: totalFrequency.get(term) ?? 0,
    }))
    .sort((left, right) => right.localIdf - left.localIdf
      || right.totalFrequency - left.totalFrequency
      || left.term.localeCompare(right.term))
    .slice(0, termLimit);
  return Object.freeze(ranked.map((entry) => entry.term));
}
