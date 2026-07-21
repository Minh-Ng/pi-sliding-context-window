import { tokenizeBm25 } from "../rocksdb/index/tokenizer.js";

export const CONTINUITY_THRESHOLDS = Object.freeze({
  lexicalTerms: 2,
  termCoverage: 0.60,
  maxNormalizedIdf: 0.60,
  // Conservative automatic-disclosure policy, not an empirical probability:
  // abstain when rank 1 is within ten calibrated-score points of rank 2 in
  // the same retrieval mode. False automatic snippets cost more than a
  // source-free marker because the explicit search tools remain available.
  // Recalibrate only from labeled ambiguity outcomes; the incident that
  // introduced this gate was an exact tie and does not identify 0.10 itself.
  ambiguityMargin: 0.10,
});

export const CONTINUITY_REASON = Object.freeze({
  NO_CANDIDATE: "no-candidate",
  CURRENT_STATE_REQUIRED: "current-state-required",
  GENERAL_KNOWLEDGE: "general-knowledge",
  SOURCE_INELIGIBLE: "source-ineligible",
  WEAK_EVIDENCE: "weak-evidence",
  EXPLICIT_HISTORY: "explicit-history-strong-evidence",
  AMBIGUOUS_HISTORY: "ambiguous-history-continuity",
  IMPLICIT_CONTINUITY: "implicit-concept-continuity",
});

const HISTORICAL_CUE = /\b(?:earlier|histor(?:y|ical)|previous(?:ly)?|prior|recall(?:ed|ing)?|(?:do|can) you remember|remember when|remember(?:ed|ing)?(?:\s+(?:we|our))?\s+discuss(?:ed|ion)|we decided|did we decide|what did we|how did we|why did we|when (?:we|it|context)|reconstruct(?:ed|ion)?|restored|used to)\b/iu;
const CURRENT_STATE_CUE = /\b(?:right now|currently|current (?:code|config|configuration|file|files|implementation|repository|state|status|tree|runtime)|working tree|(?:code|file|files|repository) on disk|on-disk (?:code|file|files|repository)|checked[- ]out (?:code|file|files|repository)|local (?:code|file|files|repository|tree)|live (?:code|repository|state|runtime|status)|today|latest (?:code|config|configuration|file|implementation|repository|status|runtime))\b/iu;
const GENERAL_KNOWLEDGE_CUE = /(?:\b(?:in general|generally|as a general concept)\b|^(?:what does .+ stand for|define |what is the definition of ))/iu;
const CONVERSATION_KINDS = new Set([
  "conversation",
  "conversation-source",
  "decision-candidate",
  "turn",
]);

function requireMessage(message) {
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("Continuity policy requires a non-empty current user message.");
  }
  return message;
}

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function exactSpans(message, values) {
  if (!Array.isArray(values)) return Object.freeze([]);
  const spans = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || !message.includes(value) || seen.has(value)) continue;
    seen.add(value);
    spans.push(value);
  }
  return Object.freeze(spans);
}

/**
 * Whole message words (not camelCase/snake_case subtoken fragments) that
 * carry at least one term from `wanted`, one entry per distinct matched
 * term. A compound identifier tokenizes into its compound term plus
 * subterms sharing one position; all of them collapse to the single
 * whole-word surface at that position, so a subterm-only match still
 * credits exactly one word of evidence. A position is only credited if it
 * carries a matched term not already credited by an earlier position, so a
 * literally repeated word, and distinct inflections of the same stemmed
 * term (e.g. "connect" and "connecting"), are not double-counted either —
 * this keeps the evidence bar keyed on distinct matched terms, matching the
 * pre-subtoken-splitting behavior. Returned in first-occurrence order.
 */
function matchedMessageWords(message, wanted) {
  const widestSurfaceByPosition = new Map();
  const matchedTermsByPosition = new Map();
  const positionOrder = [];
  for (const token of tokenizeBm25(message)) {
    const current = widestSurfaceByPosition.get(token.position);
    if (current === undefined || token.surface.length > current.length) {
      widestSurfaceByPosition.set(token.position, token.surface);
    }
    let matchedTerms = matchedTermsByPosition.get(token.position);
    if (matchedTerms === undefined) {
      matchedTerms = new Set();
      matchedTermsByPosition.set(token.position, matchedTerms);
      positionOrder.push(token.position);
    }
    if (wanted.has(token.term)) matchedTerms.add(token.term);
  }
  const words = [];
  const creditedTerms = new Set();
  for (const position of positionOrder) {
    const matchedTerms = matchedTermsByPosition.get(position);
    if (matchedTerms.size === 0) continue;
    if ([...matchedTerms].every((term) => creditedTerms.has(term))) continue;
    for (const term of matchedTerms) creditedTerms.add(term);
    words.push(widestSurfaceByPosition.get(position));
  }
  return words;
}

function lexicalSpans(message, matchedTerms) {
  if (!Array.isArray(matchedTerms) || matchedTerms.length === 0) return Object.freeze([]);
  return Object.freeze(matchedMessageWords(message, new Set(matchedTerms)));
}

/** Detect only routing intent. Concept evidence is evaluated separately. */
export function continuityIntent(message) {
  requireMessage(message);
  const historical = HISTORICAL_CUE.test(message);
  return Object.freeze({
    historical,
    currentOnly: CURRENT_STATE_CUE.test(message) && !historical,
    generalKnowledge: GENERAL_KNOWLEDGE_CUE.test(message.trim()) && !historical,
  });
}

/** Return candidate evidence copied verbatim from the current user message. */
export function continuityAnchors(message, candidate) {
  requireMessage(message);
  if (!candidate || typeof candidate !== "object") return Object.freeze([]);
  const exact = exactSpans(message, candidate.matchedAnchors);
  if (exact.length > 0) return exact;
  return lexicalSpans(message, candidate.matchedTerms);
}

function strongExact(message, candidate) {
  return candidate.retrievalMode === "exact"
    && exactSpans(message, candidate.matchedAnchors).length > 0;
}

function strongLexical(message, candidate, { historical }) {
  const matchedTerms = Array.isArray(candidate.matchedTerms) ? new Set(candidate.matchedTerms) : new Set();
  // Count distinct whole message words with evidence, not distinct terms:
  // a compound identifier's camelCase/snake_case subterms must count as one
  // word, and a literally repeated word must not count twice.
  const words = matchedMessageWords(message, matchedTerms);
  const decisionRecall = historical
    && candidate.kind === "decision-candidate"
    && words.length >= CONTINUITY_THRESHOLDS.lexicalTerms + 1;
  return candidate.retrievalMode === "lexical"
    && words.length >= CONTINUITY_THRESHOLDS.lexicalTerms
    && finiteNumber(candidate.termCoverage) >= CONTINUITY_THRESHOLDS.termCoverage
    // A decision-shaped source answering explicit historical intent may use
    // three query words instead of corpus-relative IDF. Rotation archives the
    // same source turn and its decision candidate separately, which lowers IDF
    // without weakening the underlying evidence. Implicit recall and ordinary
    // turn records retain the distinctiveness gate.
    && (decisionRecall
      || finiteNumber(candidate.maxNormalizedIdf) >= CONTINUITY_THRESHOLDS.maxNormalizedIdf);
}

function isAmbiguous(candidate, explicitAmbiguity) {
  if (explicitAmbiguity !== undefined) return explicitAmbiguity === true;
  return finiteNumber(candidate.margin) <= CONTINUITY_THRESHOLDS.ambiguityMargin;
}

/**
 * Pure automatic-disclosure decision. Eligibility includes age, retention
 * class, and authorization checks performed by the preflight caller.
 */
export function decideContinuityDisclosure({
  message,
  candidate,
  sourceEligible = true,
  ambiguous,
}) {
  requireMessage(message);
  if (typeof sourceEligible !== "boolean") throw new TypeError("sourceEligible must be boolean.");
  if (ambiguous !== undefined && typeof ambiguous !== "boolean") {
    throw new TypeError("ambiguous must be boolean when provided.");
  }
  if (!candidate) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.NO_CANDIDATE, anchors: Object.freeze([]) });
  }
  const intent = continuityIntent(message);
  if (intent.currentOnly) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.CURRENT_STATE_REQUIRED, anchors: Object.freeze([]) });
  }
  if (intent.generalKnowledge) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.GENERAL_KNOWLEDGE, anchors: Object.freeze([]) });
  }
  if (!sourceEligible) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.SOURCE_INELIGIBLE, anchors: Object.freeze([]) });
  }

  const exact = strongExact(message, candidate);
  const lexical = strongLexical(message, candidate, { historical: intent.historical });
  const anchors = continuityAnchors(message, candidate);
  if (!exact && !lexical) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.WEAK_EVIDENCE, anchors: Object.freeze([]) });
  }
  const candidateAmbiguous = isAmbiguous(candidate, ambiguous);
  if (intent.historical && !candidateAmbiguous) {
    return Object.freeze({
      outcome: "historical-snippet",
      reason: CONTINUITY_REASON.EXPLICIT_HISTORY,
      anchors,
    });
  }
  if (!intent.historical && !CONVERSATION_KINDS.has(candidate.kind)) {
    return Object.freeze({ outcome: "suppress", reason: CONTINUITY_REASON.SOURCE_INELIGIBLE, anchors: Object.freeze([]) });
  }
  return Object.freeze({
    outcome: "continuity-marker",
    reason: intent.historical
      ? CONTINUITY_REASON.AMBIGUOUS_HISTORY
      : CONTINUITY_REASON.IMPLICIT_CONTINUITY,
    anchors,
  });
}

/** Render fixed guidance whose only variable material is current-message text. */
export function renderContinuityMarker(message, anchors) {
  requireMessage(message);
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new TypeError("A continuity marker requires at least one current-message anchor.");
  }
  const checked = exactSpans(message, anchors);
  if (checked.length !== anchors.length) {
    throw new TypeError("Every continuity marker anchor must be a unique exact span of the current message.");
  }
  return [
    "",
    "",
    "[PRIOR SHARED CONTEXT MARKER]",
    "Archived discussion may exist for these exact phrases from the current user message:",
    ...checked.map((anchor) => `- ${anchor}`),
    "Search those phrases before relying on prior shared meaning; this marker is not historical evidence.",
  ].join("\n");
}
