/**
 * Versioned, backend-independent schema descriptors for the archive store.
 *
 * The schema descriptors intentionally cover only the small JSON-schema subset
 * used by this module. They are executable through `assertContract` (see
 * store-contract-validate.js) and remain ordinary frozen data that tests,
 * clients, and the daemon can share.
 */

/**
 * @typedef {null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue}} JsonValue
 */

/**
 * @typedef {object} StoreDocument
 * @property {string} documentId
 * @property {number} version
 * @property {string} sourceKey
 * @property {string} sessionId
 * @property {string} project
 * @property {string} kind
 * @property {number} createdAt
 * @property {string} text
 * @property {Record<string, JsonValue>} metadata
 * @property {string[]=} sourceMessageKeys
 * @property {"preserved" | "unavailable"=} sourceKeyStatus
 * @property {string=} subjectKey
 * @property {{documentId: string, version: number}=} supersedes
 */

/**
 * Decoded locator claims. The serialized locator remains opaque and is
 * authenticated by the retrieval layer before these claims are trusted.
 * @typedef {object} LocatorPayload
 * @property {1} locatorVersion
 * @property {string} documentId
 * @property {number} documentVersion
 * @property {number} windowOrdinal
 * @property {{startByte: number, endByte: number}} matchRange
 * @property {number} indexGeneration
 * @property {string} leaseId
 * @property {string} project
 * @property {string} sessionId
 * @property {"session" | "project"} scope
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

/**
 * @typedef {object} ContractSchema
 * @property {string=} type
 * @property {unknown=} const
 * @property {readonly unknown[]=} enum
 * @property {readonly ContractSchema[]=} anyOf
 * @property {Record<string, ContractSchema>=} properties
 * @property {readonly string[]=} required
 * @property {false | ContractSchema=} additionalProperties
 * @property {ContractSchema=} items
 */

export const STORE_SCHEMA_VERSION = 1;
export const STORE_PROTOCOL_VERSION = 1;
export const STORE_LOCATOR_VERSION = 1;
export const MAX_STORE_ERROR_MESSAGE_LENGTH = 8_192;
export const MAX_STORE_IDENTIFIER_LENGTH = 8_192;
export const MAX_JSON_VALUE_DEPTH = 128;
// One current session plus at most 64 verified ancestors from session headers.
export const MAX_SESSION_LINEAGE_IDS = 65;
export const MAX_PROTECTED_DOCUMENT_VERSIONS = 1_000;
export const MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT = 256;
export const MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT = 1 * 1_024 * 1_024;
export const MAX_VISIBLE_SOURCE_KEYS = 1_000;
export const MAX_VISIBLE_SOURCE_KEY_BYTES = 1 * 1_024 * 1_024;
export const MAX_ACTIVE_HINT_MESSAGE_KEYS = 1_000;
export const MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES = 1 * 1_024 * 1_024;
export const MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT = 4_096;
export const MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT = 1 * 1_024 * 1_024;
export const MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT = 1 * 1_024 * 1_024;
// Canonical admission currently materializes chunks and search windows before
// the write batch is committed. Keep one request safely below the daemon's
// memory gate; callers can split larger sources across documents while total
// archive storage remains unbounded.
export const MAX_DOCUMENT_TEXT_BYTES = 8 * 1_024 * 1_024;
export const MAX_DOCUMENT_METADATA_BYTES = 1 * 1_024 * 1_024;
// Direct reads stay below the 16 MiB encoded transport frame. Larger source is
// represented by a bounded manifest-only table rather than reconstructed.
export const MAX_DIRECT_DOCUMENT_SOURCE_BYTES = 1 * 1_024 * 1_024;
export const MAX_DIRECT_DOCUMENT_RESPONSE_BYTES = 8 * 1_024 * 1_024;
export const MAX_DIRECT_CHUNK_TABLE_ENTRIES = 256;
export const MAX_DIRECT_SOURCE_MESSAGE_KEYS = 16;
// Dependent-document cascade surfacing (ultracode task #36): recallable IDs
// returned alongside a superseded document's dependents count. See
// MAX_DEPENDENT_DOCUMENT_IDS in src/rocksdb/dependents.js, which this mirrors
// so the wire contract and the bounded lookup that fills it never drift.
export const MAX_DEPENDENT_DOCUMENT_IDS = 10;
// Recall repeats bounded content across chunk, plain-text, and rendered-text
// response fields. Keep the complete encoded response below the 16 MiB wire
// frame even under worst-case JSON escaping.
export const MAX_RECALL_TOKENS = 100_000;

export const STORE_SCOPES = Object.freeze(["session", "project", "all"]);
export const RETRIEVAL_MODES = Object.freeze(["exact", "lexical", "semantic", "structural", "hybrid"]);
export const STRUCTURAL_RELATIONS = Object.freeze([
  "latest-question",
  "latest-request",
  "latest-correction",
  "latest-answer",
  "latest-decision",
]);
export const RECALL_STATUSES = Object.freeze([
  "resolved",
  "expired",
  "superseded",
  "missing",
  "locator-invalid",
  "lease-expired",
]);
export const RETENTION_CLASSES = Object.freeze([
  "ephemeral-payload",
  "conversation-source",
  "derived-evidence",
  "durable-evidence",
  "active-evidence",
]);
export const STORE_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "UNKNOWN_OPERATION",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNSUPPORTED_SCHEMA_VERSION",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "LOCATOR_INVALID",
  "LEASE_EXPIRED",
  "EXPIRED",
  "SUPERSEDED",
  "CONFLICT",
  "STORE_BUSY",
  "DISK_LOW",
  "MIGRATION_BLOCKED",
  "CONNECTION_CLOSED",
  "INTERNAL",
]);

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

const string = (options = {}) => ({ type: "string", ...options });
const integer = (options = {}) => ({ type: "integer", ...options });
const number = (options = {}) => ({ type: "number", ...options });
const boolean = () => ({ type: "boolean" });
const literal = (value) => ({ const: value });
const enumeration = (values) => ({ enum: values });
const array = (items, options = {}) => ({ type: "array", items, ...options });
const object = (properties, required = Object.keys(properties), options = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...options,
});
const optionalObject = (properties, required = []) => object(properties, required);
const anyOf = (...schemas) => ({ anyOf: schemas });
const nullable = (schema) => anyOf(schema, { type: "null" });

const identifier = string({ minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH });
const text = string({ maxLength: 1_073_741_824 });
const timestamp = integer({ minimum: 0 });
const positiveInteger = integer({ minimum: 1 });
const nonNegativeInteger = integer({ minimum: 0 });
const nonNegativeNumber = number({ minimum: 0 });
const normalizedScore = number({ minimum: 0, maximum: 1 });
const jsonValue = { type: "json" };
const metadata = { type: "object", additionalProperties: jsonValue };
const nonNegativeIntegerMap = { type: "object", additionalProperties: nonNegativeInteger };

export const SOURCE_REFERENCE_SCHEMA = object({
  sessionId: identifier,
  project: identifier,
  turnId: identifier,
  messageKey: identifier,
}, ["sessionId"], { additionalProperties: false });

export const STRUCTURAL_MESSAGE_SCHEMA = object({
  messageKey: identifier,
  messageIndex: nonNegativeInteger,
  role: enumeration(["user", "assistant", "system", "tool", "unknown"]),
  createdAt: timestamp,
  text,
  questionScore: integer({ minimum: 0, maximum: 100 }),
  requestScore: integer({ minimum: 0, maximum: 100 }),
  correctionScore: integer({ minimum: 0, maximum: 100 }),
  answerScore: integer({ minimum: 0, maximum: 100 }),
}, ["messageKey", "messageIndex", "role", "createdAt", "text"]);

/** An explicit, exact semantic-invalidation target. */
export const SUPERSEDES_TARGET_SCHEMA = object({
  documentId: identifier,
  version: positiveInteger,
});

/** Canonical source event. Values are immutable once admitted. */
export const EVENT_SCHEMA = object({
  eventId: identifier,
  sourceKey: identifier,
  sessionId: identifier,
  project: identifier,
  sequence: positiveInteger,
  kind: enumeration(["user", "assistant", "tool-call", "tool-result", "synthetic"]),
  createdAt: timestamp,
  content: text,
  metadata,
});

/** Canonical searchable document assembled from source events or migration. */
export const DOCUMENT_SCHEMA = object({
  documentId: identifier,
  version: positiveInteger,
  sourceKey: identifier,
  sessionId: identifier,
  project: identifier,
  kind: identifier,
  createdAt: timestamp,
  text,
  metadata,
  sourceMessageKeys: array(identifier, { maxItems: MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT }),
  sourceKeyStatus: enumeration(["preserved", "unavailable"]),
  subjectKey: identifier,
  supersedes: SUPERSEDES_TARGET_SCHEMA,
}, [
  "documentId",
  "version",
  "sourceKey",
  "sessionId",
  "project",
  "kind",
  "createdAt",
  "text",
  "metadata",
]);

export const PHYSICAL_CHUNK_SCHEMA = object({
  chunkId: identifier,
  contentHash: string({ pattern: "^[a-f0-9]{64}$" }),
  retentionClass: enumeration(RETENTION_CLASSES),
  project: identifier,
  sessionId: identifier,
  bucket: identifier,
  documentId: identifier,
  documentVersion: positiveInteger,
  ordinal: nonNegativeInteger,
  startByte: nonNegativeInteger,
  endByte: nonNegativeInteger,
  encoding: enumeration(["utf8", "base64"]),
  content: text,
});

export const SEARCH_WINDOW_SCHEMA = object({
  documentId: identifier,
  documentVersion: positiveInteger,
  ordinal: nonNegativeInteger,
  startByte: nonNegativeInteger,
  endByte: nonNegativeInteger,
  chunkIds: array(identifier, { minItems: 1 }),
  indexGeneration: nonNegativeInteger,
});

export const TURN_MANIFEST_SCHEMA = object({
  manifestId: identifier,
  version: positiveInteger,
  sessionId: identifier,
  project: identifier,
  turnId: identifier,
  sourceEventIds: array(identifier, { minItems: 1 }),
  createdAt: timestamp,
});

export const TOOL_RESULT_MANIFEST_SCHEMA = object({
  manifestId: identifier,
  version: positiveInteger,
  sessionId: identifier,
  project: identifier,
  toolCallId: identifier,
  parentTurnIds: array(identifier),
  chunkIds: array(identifier, { minItems: 1 }),
  createdAt: timestamp,
});

export const SUPERSESSION_SCHEMA = object({
  documentId: identifier,
  documentVersion: positiveInteger,
  status: enumeration(["superseded", "expired", "deleted"]),
  replacementDocumentId: identifier,
  replacementVersion: positiveInteger,
  project: identifier,
  subjectKey: identifier,
  supersessionType: enumeration(["version", "explicit"]),
  reason: string({ minLength: 1, maxLength: 4_096 }),
  recordedAt: timestamp,
}, ["documentId", "documentVersion", "status", "reason", "recordedAt"]);

export const LEASE_SCHEMA = object({
  leaseId: identifier,
  ownerId: identifier,
  kind: enumeration(["retrieval", "active-context"]),
  documentId: identifier,
  documentVersion: positiveInteger,
  issuedAt: timestamp,
  expiresAt: timestamp,
});

export const OUTBOX_ENTRY_SCHEMA = object({
  sequence: positiveInteger,
  operation: enumeration(["index", "delete", "supersede"]),
  documentId: identifier,
  documentVersion: positiveInteger,
  sourceVersion: positiveInteger,
  admittedAt: timestamp,
});

export const STORE_SCHEMA_METADATA_SCHEMA = object({
  schemaVersion: literal(STORE_SCHEMA_VERSION),
  minimumReadableVersion: literal(STORE_SCHEMA_VERSION),
  minimumWritableVersion: literal(STORE_SCHEMA_VERSION),
  createdAt: timestamp,
});

export const LOCATOR_PAYLOAD_SCHEMA = object({
  locatorVersion: literal(STORE_LOCATOR_VERSION),
  documentId: identifier,
  documentVersion: positiveInteger,
  windowOrdinal: nonNegativeInteger,
  matchRange: object({
    startByte: nonNegativeInteger,
    endByte: nonNegativeInteger,
  }),
  indexGeneration: nonNegativeInteger,
  leaseId: identifier,
  project: identifier,
  sessionId: identifier,
  scope: enumeration(["session", "project"]),
  issuedAt: timestamp,
  expiresAt: timestamp,
});

export const STORE_ERROR_SCHEMA = object({
  code: enumeration(STORE_ERROR_CODES),
  message: string({ minLength: 1, maxLength: MAX_STORE_ERROR_MESSAGE_LENGTH }),
  retryable: boolean(),
  details: jsonValue,
}, ["code", "message", "retryable"]);

const scopeProperties = {
  scope: enumeration(STORE_SCOPES),
  sessionId: identifier,
  sessionIds: array(identifier, { maxItems: MAX_SESSION_LINEAGE_IDS }),
  project: identifier,
};

// Exported so store-contract-validate.js can bound these fields directly
// (assertVisibleSourceKeys / assertActiveHintMessageKeys) without duplicating
// the shared array schema.
export const visibleSourceKeys = array(identifier, { maxItems: MAX_VISIBLE_SOURCE_KEYS });
export const activeHintMessageKeys = array(identifier, { maxItems: MAX_ACTIVE_HINT_MESSAGE_KEYS });

const termIdfEvidence = object({
  term: identifier,
  idf: number({ minimum: 0 }),
  normalizedIdf: number({ minimum: 0, maximum: 1 }),
});

const searchRequest = object({
  query: string({ maxLength: 65_536 }),
  expansionTerms: array(identifier, { maxItems: 16 }),
  relation: nullable(enumeration(STRUCTURAL_RELATIONS)),
  semanticPolicy: enumeration(["auto", "always", "never"]),
  // Gates only the system-side RM3/Bo1 pseudo-relevance-feedback requery
  // (distinct from the agent-supplied `expansionTerms` above); "never"
  // disables it even where the server would otherwise allow it. It cannot
  // enable expansion on its own — that also requires server-side opt-in
  // (see options.allowExpansion in src/retrieval/search.js), which the
  // automatic preflight path never sets.
  expansionPolicy: enumeration(["auto", "never"]),
  ...scopeProperties,
  limit: integer({ minimum: 1, maximum: 100 }),
  excludeVisibleSourceKeys: visibleSourceKeys,
  hintBudgetTokens: integer({ minimum: 0, maximum: 100_000 }),
  // Optional (not in the required list): a caller must opt in per request.
  // Two genuinely distinct documents can share near-identical text (repeated
  // boilerplate, not just repeated tool output), so collapsing near-dup
  // clusters is never a safe default -- only a caller who wants coding-session
  // noise reduction should ask for it. Absent entirely on the automatic
  // preflight path.
  dedupe: boolean(),
  // Optional (not in the required list): explicit paths/symbols/identifiers
  // the agent is actively acting on. Ranking-boost input only (see
  // classifyWorkingSetAnchors/lookupExactAnchorDocuments in
  // src/rocksdb/index/exact.js) -- never a filter, never widens what a
  // request can retrieve. Absent entirely on the automatic preflight path.
  workingSet: array(identifier, { maxItems: 16 }),
  // Optional (not in the required list): the caller's own uncertainty signal
  // for this one call. "normal" (the default whenever omitted) is today's
  // behavior, byte-for-byte. "wide" relaxes existing retrieval gates for this
  // call only -- semantic broadening runs unconditionally, RM3 expansion runs
  // unconditionally, and the candidate pool doubles (still hard-capped at the
  // existing 100-candidate ceiling) -- see src/retrieval/search.js's
  // SEARCH_EFFORT_POLICY. It moves existing thresholds; it adds no new
  // retrieval machinery. Absent entirely on the automatic preflight path.
  searchEffort: enumeration(["normal", "wide"]),
  // Optional (not in the required list): a deterministic digest of session
  // context terms (ultracode task #32) -- the Pi adapter's own top-K
  // high-IDF terms extracted from the recent conversation prefix
  // (src/session/session-context.js), or an MCP caller's own equivalent.
  // Ranking-boost input only (see applySessionContextBoost in
  // src/retrieval/search.js) -- never a filter, never widens what a request
  // can retrieve: a document matching only these terms and not the query
  // itself never enters results. Absent entirely on the automatic preflight
  // path.
  sessionContext: array(identifier, { maxItems: 16 }),
}, ["query", "relation", "scope", "limit", "excludeVisibleSourceKeys", "hintBudgetTokens"]);

const searchResult = object({
  documentId: identifier,
  version: positiveInteger,
  kind: identifier,
  score: normalizedScore,
  rawScore: nonNegativeNumber,
  calibratedScore: normalizedScore,
  retrievalMode: enumeration(["exact", "lexical", "semantic", "structural"]),
  createdAt: timestamp,
  matchType: identifier,
  margin: normalizedScore,
  matchedAnchors: array(identifier, { maxItems: 256 }),
  matchedTerms: array(identifier, { maxItems: 256 }),
  termCoverage: number({ minimum: 0, maximum: 1 }),
  termIdf: array(termIdfEvidence, { maxItems: 256 }),
  maxNormalizedIdf: number({ minimum: 0, maximum: 1 }),
  // System-selected RM3/Bo1 expansion terms that this specific result
  // matched (a subset of matchedTerms), so callers can explain why a
  // document surfaced even though it did not match the literal query.
  expandedTerms: array(identifier, { maxItems: 8 }),
  snippet: text,
  historical: boolean(),
  superseded: boolean(),
  nearDuplicates: nonNegativeInteger,
  // Cross-encoder rerank provenance (deferred task #2): present only when
  // this result was scored by the local reranker, mirroring the
  // expandedTerms provenance pattern above. This means "the reranker scored
  // this candidate," not "the reranker moved it" -- a tied or near-tied
  // cross-encoder score can leave a scored candidate exactly where it
  // started (LocalReranker.rerank's stable-sort tie-break), and a
  // reorder-only flag would then flicker on/off across otherwise-identical
  // requests depending on incidental tie patterns. Absent on every
  // automatic preflight result and on any explicit result the reranker left
  // untouched (disabled, unavailable, or outside its candidate window).
  reranked: boolean(),
  // Provenance for the request's workingSet ranking boost (see
  // classifyWorkingSetAnchors/lookupExactAnchorDocuments in
  // src/rocksdb/index/exact.js), matching the expandedTerms provenance
  // pattern above: the working-set anchor value(s) whose exact postings
  // intersected this document, so `/window recall why` can explain a boost
  // (e.g. "boosted by working-set anchor <x>"). Like expandedTerms, this
  // field is always present but only non-empty when this specific result was
  // actually boosted -- empty whenever workingSet is omitted, matched no
  // anchor, or matched a different document. Bounded independently of the
  // request's workingSet maxItems (16): every classified anchor can
  // independently intersect one document, so this is truncated to 8 wherever
  // it is produced (MAX_WORKING_SET_ANCHORS_PER_RESULT, exact.js).
  workingSetAnchors: array(identifier, { maxItems: 8 }),
  // Same expandedTerms/workingSetAnchors provenance pattern above, for the
  // request's sessionContext ranking boost (ultracode task #32; see
  // applySessionContextBoost in src/retrieval/search.js): the sessionContext
  // term(s) this specific document's own indexed vocabulary actually
  // matched, present only when this result was actually boosted -- empty
  // whenever sessionContext is omitted or matched a different document.
  // Bounded independently of the request's sessionContext maxItems (16) the
  // same way workingSetAnchors is bounded independently of workingSet's:
  // MAX_SESSION_CONTEXT_TERMS_PER_RESULT (search.js) truncates to this bound
  // wherever it is produced.
  sessionContextTerms: array(identifier, { maxItems: 8 }),
  locator: identifier,
  source: SOURCE_REFERENCE_SCHEMA,
}, [
  "documentId",
  "version",
  "kind",
  "score",
  "matchType",
  "margin",
  "snippet",
  "historical",
  "superseded",
  "locator",
  "source",
]);

const expiredMatchesSummary = object({
  count: nonNegativeInteger,
  retentionClasses: array(enumeration(RETENTION_CLASSES), { maxItems: RETENTION_CLASSES.length }),
});

// Surface-only invalidation cascade (ultracode task #36): a bounded,
// postings-only count of later-admitted documents that show signs of
// referencing a document once it is superseded, plus a capped, recallable
// subset of their IDs. Never includes their content and never implies any
// action was taken on them -- see findDependentDocuments in
// src/rocksdb/dependents.js. Optional wherever it appears below so older
// daemons/clients that predate this field validate unchanged.
const dependentDocumentsSummary = object({
  count: nonNegativeInteger,
  documentIds: array(identifier, { maxItems: MAX_DEPENDENT_DOCUMENT_IDS }),
});

// Artifact-versioning chain view (ultracode task #38): a compact summary of
// one document's position within its explicit subjectKey + supersedes
// chain -- see supersessionChainView in src/rocksdb/supersession-chain.js.
// `predecessor`/`successor` each name only the immediate neighbor in that
// direction, not the full chain. Optional wherever it appears below so
// older daemons/clients that predate this field validate unchanged.
const supersessionChainNeighbor = object({
  documentId: identifier,
  version: positiveInteger,
  createdAt: timestamp,
});
const supersessionChainSummary = object({
  position: positiveInteger,
  totalVersions: positiveInteger,
  predecessor: supersessionChainNeighbor,
  successor: supersessionChainNeighbor,
}, ["position", "totalVersions"]);

const searchResponse = object({
  mode: enumeration(RETRIEVAL_MODES),
  status: enumeration(["resolved", "not-found", "ambiguous", "legacy-fallback"]),
  indexGeneration: nonNegativeInteger,
  results: array(searchResult),
  // Matching documents that retention already expired/tombstoned without a
  // live replacement; surfaced so an agent learns evidence existed and aged
  // out instead of concluding a topic was never discussed. Never includes
  // expired content itself. Optional (not in the required list below) so
  // older daemons/clients that predate this field do not fail validation.
  expiredMatches: expiredMatchesSummary,
}, ["mode", "status", "indexGeneration", "results"]);

const traversalResponse = object({
  status: enumeration(["resolved", "not-found"]),
  direction: enumeration(["before", "after"]),
  scanned: nonNegativeInteger,
  truncated: boolean(),
  hasMore: boolean(),
  results: array(searchResult, { maxItems: 128 }),
}, ["status", "direction", "scanned", "truncated", "hasMore", "results"]);

const automaticHint = object({
  documentId: identifier,
  text,
  tokenCount: nonNegativeInteger,
  sourceKind: identifier,
  archivedDataDelimited: boolean(),
  disclosureType: enumeration(["historical-snippet", "continuity-marker"]),
}, ["documentId", "text", "tokenCount", "sourceKind", "archivedDataDelimited"]);

const preflightCandidateDiagnostics = object({
  documentId: identifier,
  kind: identifier,
  retrievalMode: enumeration(["exact", "lexical", "structural"]),
  matchedTerms: array(identifier, { maxItems: 256 }),
  termCoverage: number({ minimum: 0, maximum: 1 }),
  maxNormalizedIdf: number({ minimum: 0, maximum: 1 }),
  margin: normalizedScore,
});

const preflightDiagnostics = object({
  outcome: enumeration(["historical-snippet", "continuity-marker", "suppress"]),
  reason: identifier,
  indexGeneration: nonNegativeInteger,
  searchMode: enumeration(RETRIEVAL_MODES),
  searchStatus: enumeration(["resolved", "not-found", "ambiguous", "legacy-fallback"]),
  candidate: nullable(preflightCandidateDiagnostics),
}, ["outcome", "reason", "indexGeneration", "candidate"]);

const preflightResponse = object({
  modelVisibleText: text,
  hints: array(automaticHint),
  diagnostics: preflightDiagnostics,
}, ["modelVisibleText", "hints"]);

const sourceProvenance = anyOf(
  object({
    status: literal("available"),
    keys: array(identifier),
    totalKeys: nonNegativeInteger,
    truncated: boolean(),
  }, ["status", "keys"]),
  object({
    status: enumeration(["documented-absence", "unavailable"]),
    reason: string({ minLength: 1, maxLength: 8_192 }),
  }),
);

const recalledChunk = object({
  chunkId: identifier,
  ordinal: nonNegativeInteger,
  startByte: nonNegativeInteger,
  endByte: nonNegativeInteger,
  text,
});

const resolvedRecall = object({
  status: literal("resolved"),
  documentId: identifier,
  version: positiveInteger,
  kind: identifier,
  sessionId: identifier,
  project: identifier,
  createdAt: timestamp,
  historical: literal(true),
  stalenessLabel: string({ minLength: 1, maxLength: 1_024 }),
  sourceMessages: sourceProvenance,
  chunks: array(recalledChunk, { minItems: 1 }),
  text,
  continuationLocators: array(identifier),
  maxTokens: positiveInteger,
  renderedText: text,
  returnedTokens: nonNegativeInteger,
  // Present only when this document is part of an explicit subjectKey +
  // supersedes chain, either direction (ultracode task #38).
  chain: supersessionChainSummary,
}, [
  "status",
  "documentId",
  "version",
  "kind",
  "sessionId",
  "project",
  "createdAt",
  "historical",
  "stalenessLabel",
  "sourceMessages",
  "chunks",
  "text",
  "continuationLocators",
  "maxTokens",
  "renderedText",
  "returnedTokens",
]);

const unresolvedRecall = object({
  status: enumeration(RECALL_STATUSES.filter((status) => status !== "resolved")),
  documentId: identifier,
  version: positiveInteger,
  reason: string({ minLength: 1, maxLength: 8_192 }),
  replacementLocator: identifier,
  // Present only when status is "superseded" and the bounded lookup found at
  // least one later document referencing it (ultracode task #36).
  dependents: dependentDocumentsSummary,
  // Present only when status is "superseded" and this document is part of an
  // explicit subjectKey + supersedes chain, either direction (ultracode
  // task #38).
  chain: supersessionChainSummary,
}, ["status", "reason"]);

const gatheredEvidence = object({
  relation: enumeration(["anchor", "before", "after"]),
  anchorRank: positiveInteger,
  distance: nonNegativeInteger,
  locator: identifier,
  document: resolvedRecall,
  nearDuplicates: nonNegativeInteger,
  // Only anchor evidence carries a search-ranked relevance score; chronological
  // before/after neighbors are context, not ranked hits, so this stays optional.
  score: normalizedScore,
  retrievalMode: enumeration(["exact", "lexical", "semantic", "structural"]),
  // Same cross-encoder rerank provenance as store.search's searchResult
  // ("scored by," not "moved by" -- see that field's comment), carried onto
  // anchor evidence only (see the score/retrievalMode comment above;
  // before/after neighbors are never reranked).
  reranked: boolean(),
  // Same workingSet ranking-boost provenance as store.search's searchResult
  // (see that field's comment), carried onto anchor evidence only -- the same
  // restriction as score/retrievalMode/reranked above.
  workingSetAnchors: array(identifier, { maxItems: 8 }),
  // Same sessionContext ranking-boost provenance as store.search's
  // searchResult (ultracode task #32; see that field's comment), carried
  // onto anchor evidence only -- the same restriction as
  // score/retrievalMode/reranked/workingSetAnchors above.
  sessionContextTerms: array(identifier, { maxItems: 8 }),
  // Deterministic, bounded pairwise conflict flagging within this one gather
  // packet (ultracode task #37; see detectPossibleConflicts in
  // src/retrieval/gather.js): the locator(s) of other evidence in the same
  // packet that share this evidence's subject (same live subjectKey, or a
  // strong typed-anchor citation in common) and carry opposing decision-cue
  // language, with no explicit supersession already connecting the pair.
  // "Possibly" is the operative word -- the agent judges; false positives
  // (two records restating the same decision) are the accepted risk. Never
  // present on store.search/store.traverse results or the automatic
  // preflight path -- gather-only.
  possiblyConflicting: array(identifier, { maxItems: 8 }),
}, ["relation", "anchorRank", "distance", "locator", "document"]);

const gatherResponse = object({
  status: enumeration(["resolved", "not-found"]),
  mode: enumeration(RETRIEVAL_MODES),
  intent: enumeration(["auto", "state", "workflow"]),
  anchorCount: nonNegativeInteger,
  candidateCount: nonNegativeInteger,
  returnedTokens: nonNegativeInteger,
  truncated: boolean(),
  hasMore: boolean(),
  evidence: array(gatheredEvidence, { maxItems: 24 }),
  // Matching documents that retention already expired/tombstoned without a
  // live replacement, surfaced from gather's internal search call so an
  // agent learns evidence existed and aged out instead of concluding a topic
  // was never discussed. Never includes expired content itself. Optional
  // (not in the required list below) so older daemons/clients that predate
  // this field do not fail validation.
  expiredMatches: expiredMatchesSummary,
}, [
  "status",
  "mode",
  "intent",
  "anchorCount",
  "candidateCount",
  "returnedTokens",
  "truncated",
  "hasMore",
  "evidence",
]);

const directDocumentIdentity = object({
  documentId: identifier,
  version: positiveInteger,
  contentHash: string({ pattern: "^[a-f0-9]{64}$" }),
  identityHash: string({ pattern: "^sha256:[a-f0-9]{64}$" }),
  byteLength: nonNegativeInteger,
});

const directChunkTableEntry = object({
  chunkId: identifier,
  ordinal: nonNegativeInteger,
  startByte: nonNegativeInteger,
  endByte: nonNegativeInteger,
  byteLength: nonNegativeInteger,
});

const directChunkTableDocument = object({
  documentId: identifier,
  version: positiveInteger,
  sourceKey: identifier,
  sourceKeyStatus: enumeration(["preserved", "unavailable"]),
  sessionId: identifier,
  project: identifier,
  kind: identifier,
  createdAt: timestamp,
  contentHash: string({ pattern: "^[a-f0-9]{64}$" }),
  byteLength: nonNegativeInteger,
  sourceMessageKeys: array(identifier, { maxItems: MAX_DIRECT_SOURCE_MESSAGE_KEYS }),
  sourceMessageKeyCount: nonNegativeInteger,
  sourceMessageKeysTruncated: boolean(),
  chunkCount: positiveInteger,
  chunkTable: array(directChunkTableEntry, {
    minItems: 1,
    maxItems: MAX_DIRECT_CHUNK_TABLE_ENTRIES,
  }),
  chunkTableTruncated: boolean(),
});

const documentReadResponse = anyOf(
  object({ status: literal("resolved"), document: DOCUMENT_SCHEMA }),
  object({
    status: literal("resolved"),
    materialization: literal("identity"),
    document: directDocumentIdentity,
  }),
  object({
    status: literal("resolved"),
    materialization: literal("chunk-table"),
    document: directChunkTableDocument,
  }),
  object({
    status: enumeration(["missing", "expired", "superseded"]),
    documentId: identifier,
    version: positiveInteger,
    reason: string({ minLength: 1, maxLength: 8_192 }),
    // Present only when status is "superseded" and the bounded lookup found
    // at least one later document referencing it (ultracode task #36).
    dependents: dependentDocumentsSummary,
    // Present only when status is "superseded" and this document is part of
    // an explicit subjectKey + supersedes chain, either direction
    // (ultracode task #38).
    chain: supersessionChainSummary,
  }, ["status", "documentId"]),
);

const retentionStats = object({
  liveDocuments: nonNegativeInteger,
  liveLogicalBytes: nonNegativeInteger,
  pins: nonNegativeInteger,
  leases: nonNegativeInteger,
  expiredVersions: nonNegativeInteger,
  cleanupBacklog: nonNegativeInteger,
  emergencyMode: boolean(),
  approximate: boolean(),
}, [
  "liveDocuments",
  "liveLogicalBytes",
  "pins",
  "leases",
  "expiredVersions",
  "cleanupBacklog",
  "emergencyMode",
]);

const migrationStatus = object({
  phase: enumeration([
    "not-started",
    "offline-copy",
    "offline-verification",
    "offline-ready",
    "rocksdb-authority",
    "blocked",
  ]),
  sourcePath: identifier,
  sourceFingerprint: identifier,
  migratedCount: nonNegativeInteger,
  failedCount: nonNegativeInteger,
  comparisonFailures: nonNegativeInteger,
  rollbackEligible: boolean(),
  checkpoint: jsonValue,
}, ["phase", "migratedCount", "failedCount", "comparisonFailures", "rollbackEligible"]);

const shownRecalledStats = object({ shown: nonNegativeInteger, recalled: nonNegativeInteger });
const queryKeyField = string({ maxLength: 512 });
// Below-the-fold misses are never shown, so they cannot be measured directly;
// a reformulation chain (an earlier zero-recall search followed, in the same
// session, by a differently-worded search that resolves) is the read-only
// proxy signal. See detectReformulationChains in relevance-feedback.js.
const feedbackChainResponse = object({
  sessionId: identifier,
  missQueryKey: queryKeyField,
  missSeq: nonNegativeInteger,
  hitQueryKey: queryKeyField,
  hitSeq: nonNegativeInteger,
});
const feedbackStatsResponse = object({
  events: nonNegativeInteger,
  shownTotal: nonNegativeInteger,
  recalledTotal: nonNegativeInteger,
  byMode: { type: "object", additionalProperties: shownRecalledStats },
  byRank: array(object({
    rank: nonNegativeInteger,
    shown: nonNegativeInteger,
    recalled: nonNegativeInteger,
  })),
  queries: array(object({
    query: string({ maxLength: 65_536 }),
    searches: nonNegativeInteger,
    shown: nonNegativeInteger,
    recalled: nonNegativeInteger,
  })),
  chainCount: nonNegativeInteger,
  chainRate: normalizedScore,
  chains: array(feedbackChainResponse),
  chainQueryKeys: array(queryKeyField),
});

/**
 * Runtime schemas for every store and daemon operation. Operation names are
 * stable protocol identifiers, not JavaScript method names.
 */
export const STORE_OPERATION_CONTRACTS = deepFreeze({
  "store.put": {
    request: object({
      idempotencyKey: identifier,
      document: DOCUMENT_SCHEMA,
      structuralMessages: array(STRUCTURAL_MESSAGE_SCHEMA, {
        maxItems: MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
      }),
      retentionClass: enumeration(RETENTION_CLASSES),
      expiresAt: timestamp,
      protect: boolean(),
    }, ["idempotencyKey", "document", "retentionClass"]),
    result: object({
      status: enumeration(["stored", "duplicate"]),
      documentId: identifier,
      version: positiveInteger,
      sourceKey: identifier,
      outboxSequence: positiveInteger,
      // Present only when this admission carried an explicit `supersedes`
      // pointer and the bounded lookup found at least one later document
      // already referencing the document it just superseded (ultracode task
      // #36).
      dependents: dependentDocumentsSummary,
    }, ["status", "documentId", "version", "sourceKey", "outboxSequence"]),
  },
  "store.get": {
    request: object({
      documentId: identifier,
      version: positiveInteger,
      view: enumeration(["bounded", "identity"]),
    }, ["documentId"]),
    result: documentReadResponse,
  },
  "store.search": {
    request: searchRequest,
    result: searchResponse,
  },
  "store.gather": {
    request: object({
      query: string({ minLength: 1, maxLength: 65_536 }),
      expansionTerms: array(identifier, { maxItems: 16 }),
      intent: enumeration(["auto", "state", "workflow"]),
      ...scopeProperties,
      limit: integer({ minimum: 1, maximum: 10 }),
      before: integer({ minimum: 0, maximum: 8 }),
      after: integer({ minimum: 0, maximum: 16 }),
      neighborhoodAnchors: integer({ minimum: 1, maximum: 5 }),
      maxEvidence: integer({ minimum: 1, maximum: 24 }),
      maxTokens: integer({ minimum: 39, maximum: MAX_RECALL_TOKENS }),
      excludeVisibleSourceKeys: visibleSourceKeys,
      // Optional (not required): same explicit per-request opt-in as
      // store.search's dedupe, for the same reason -- collapsing near-dup
      // clusters is never a safe default.
      dedupe: boolean(),
      // Same working-set ranking-boost input as store.search's workingSet
      // above (optional, not required): forwarded into gather's internal
      // search call so its anchor evidence gets the same boost.
      workingSet: array(identifier, { maxItems: 16 }),
      // Same caller-uncertainty signal as store.search's searchEffort above
      // (optional, not required): forwarded into gather's internal search
      // call so its anchor search gets the same widened gates.
      searchEffort: enumeration(["normal", "wide"]),
      // Same sessionContext ranking-boost input as store.search's
      // sessionContext above (ultracode task #32; optional, not required):
      // forwarded into gather's internal search call so its anchor evidence
      // gets the same boost.
      sessionContext: array(identifier, { maxItems: 16 }),
    }, [
      "query",
      "intent",
      "scope",
      "limit",
      "before",
      "after",
      "neighborhoodAnchors",
      "maxEvidence",
      "maxTokens",
      "excludeVisibleSourceKeys",
    ]),
    result: gatherResponse,
  },
  "store.traverse": {
    request: object({
      locator: identifier,
      direction: enumeration(["before", "after"]),
      ...scopeProperties,
      limit: integer({ minimum: 1, maximum: 128 }),
      scanLimit: integer({ minimum: 1, maximum: 10_000 }),
    }, ["locator", "direction", "scope", "sessionIds", "limit", "scanLimit"]),
    result: traversalResponse,
  },
  "store.recall": {
    request: object({
      locator: identifier,
      neighbors: integer({ minimum: 0, maximum: 32 }),
      maxTokens: integer({ minimum: 39, maximum: MAX_RECALL_TOKENS }),
      sessionIds: array(identifier, { maxItems: MAX_SESSION_LINEAGE_IDS }),
    }, ["locator", "neighbors", "maxTokens"]),
    result: anyOf(resolvedRecall, unresolvedRecall),
  },
  "store.preflight": {
    request: object({
      messageKey: identifier,
      message: identifier,
      scope: enumeration(STORE_SCOPES),
      sessionId: identifier,
      sessionIds: array(identifier, { maxItems: MAX_SESSION_LINEAGE_IDS }),
      project: identifier,
      excludeVisibleSourceKeys: visibleSourceKeys,
      hintBudgetTokens: integer({ minimum: 0, maximum: 100_000 }),
      activeHintBudgetTokens: integer({ minimum: 0, maximum: 100_000 }),
      activeMessageKeys: activeHintMessageKeys,
      hintSourceCooldownMs: nonNegativeInteger,
      ephemeralAutoRetrievalDays: nonNegativeInteger,
      conversationAutoRetrievalDays: nonNegativeInteger,
      derivedAutoRetrievalDays: nonNegativeInteger,
      reconstruct: boolean(),
      includeDiagnostics: boolean(),
      epochId: identifier,
      epochBudgetTokens: integer({ minimum: 0, maximum: 100_000 }),
    }, [
      "messageKey",
      "message",
      "scope",
      "sessionId",
      "sessionIds",
      "project",
      "excludeVisibleSourceKeys",
      "hintBudgetTokens",
    ]),
    result: preflightResponse,
  },
  "store.remove-hints": {
    request: object({
      sessionId: identifier,
      messageKeys: array(identifier, { minItems: 1, maxItems: 1_000 }),
    }),
    result: object({
      removed: nonNegativeInteger,
      notFound: nonNegativeInteger,
    }),
  },
  "store.count": {
    request: optionalObject(scopeProperties, ["scope"]),
    result: object({ count: nonNegativeInteger }),
  },
  "store.protect": {
    request: object({
      ownerId: identifier,
      sessionIds: array(identifier, { maxItems: MAX_SESSION_LINEAGE_IDS }),
      documentVersions: array(object({
        documentId: identifier,
        version: positiveInteger,
      }), { maxItems: MAX_PROTECTED_DOCUMENT_VERSIONS }),
      ttlMs: positiveInteger,
    }),
    result: object({
      ownerId: identifier,
      expiresAt: timestamp,
      protectedSessions: nonNegativeInteger,
      protectedDocuments: nonNegativeInteger,
    }),
  },
  "store.release-protection": {
    request: object({ ownerId: identifier }),
    result: object({ released: nonNegativeInteger }),
  },
  "store.pin": {
    request: object({
      pinId: identifier,
      documentId: identifier,
      version: positiveInteger,
      reason: string({ minLength: 1, maxLength: 4_096 }),
    }),
    result: object({ status: enumeration(["pinned", "already-pinned"]), pinId: identifier }),
  },
  "store.unpin": {
    request: object({ pinId: identifier }),
    result: object({ status: enumeration(["unpinned", "not-found"]), pinId: identifier }),
  },
  "store.resolve-subject": {
    request: object({
      subjectKey: identifier,
    }, ["subjectKey"]),
    result: anyOf(
      object({
        status: enumeration(["resolved"]),
        documentId: identifier,
        version: positiveInteger,
        kind: identifier,
        subjectKey: identifier,
      }, ["status", "documentId", "version", "kind", "subjectKey"]),
      object({
        status: enumeration(["not-found"]),
        subjectKey: identifier,
      }, ["status", "subjectKey"]),
    ),
  },
  "store.redact": {
    request: object({
      scope: enumeration(["session", "project"]),
      sessionId: identifier,
      sessionIds: array(identifier, { maxItems: MAX_SESSION_LINEAGE_IDS }),
      confirm: identifier,
      batchSize: integer({ minimum: 1, maximum: 1_000 }),
      now: timestamp,
      cursor: identifier,
    }, ["scope", "confirm", "batchSize"]),
    result: object({
      status: enumeration(["complete", "more-work"]),
      scanned: nonNegativeInteger,
      tombstoned: nonNegativeInteger,
      alreadyTombstoned: nonNegativeInteger,
      protected: nonNegativeInteger,
      missing: nonNegativeInteger,
      hintsCleared: nonNegativeInteger,
      nextCursor: identifier,
    }, [
      "status",
      "scanned",
      "tombstoned",
      "alreadyTombstoned",
      "protected",
      "missing",
      "hintsCleared",
    ]),
  },
  "retention.run": {
    request: object({
      now: timestamp,
      force: boolean(),
      class: enumeration(RETENTION_CLASSES),
      batchSize: integer({ minimum: 1, maximum: 100_000 }),
    }, ["now", "force", "batchSize"]),
    result: object({
      status: enumeration(["complete", "more-work", "blocked"]),
      scanned: nonNegativeInteger,
      tombstoned: nonNegativeInteger,
      deletedKeys: nonNegativeInteger,
      protected: nonNegativeInteger,
      nextCursor: identifier,
    }, ["status", "scanned", "tombstoned", "deletedKeys", "protected"]),
  },
  "retention.status": {
    request: object({}),
    result: retentionStats,
  },
  "feedback.stats": {
    request: object({
      queryLimit: integer({ minimum: 1, maximum: 1_000 }),
    }, []),
    result: feedbackStatsResponse,
  },
  "store.compact": {
    request: object({
      startKey: string(),
      endKey: string(),
      reason: enumeration(["deletion-wave", "disk-pressure", "operator"]),
    }, ["reason"]),
    result: object({
      status: enumeration(["scheduled", "complete", "busy", "error"]),
      bytesBefore: nonNegativeInteger,
      bytesAfter: nonNegativeInteger,
      error: string({ minLength: 1, maxLength: 8_192 }),
    }, ["status"]),
  },
  "daemon.status": {
    request: object({}),
    result: object({
      ready: boolean(),
      processId: positiveInteger,
      storePath: identifier,
      runtimeVersion: identifier,
      startedAt: timestamp,
      startupTimings: optionalObject({
        pathsAndLockMs: nonNegativeInteger,
        storeRuntimeMs: nonNegativeInteger,
        socketPreparationMs: nonNegativeInteger,
        listenMs: nonNegativeInteger,
        startupOtherMs: nonNegativeInteger,
        totalMs: nonNegativeInteger,
      }, [
        "pathsAndLockMs",
        "storeRuntimeMs",
        "socketPreparationMs",
        "listenMs",
        "startupOtherMs",
        "totalMs",
      ]),
      schemaVersion: literal(STORE_SCHEMA_VERSION),
      protocolVersion: literal(STORE_PROTOCOL_VERSION),
      capabilities: array(identifier),
      clientConnections: nonNegativeInteger,
      activeRequests: nonNegativeInteger,
      idleShutdownAt: timestamp,
      counts: optionalObject({
        documents: nonNegativeInteger,
        events: nonNegativeInteger,
        chunks: nonNegativeInteger,
        logicalBytes: nonNegativeInteger,
        approximate: boolean(),
      }),
      outbox: optionalObject({
        depth: nonNegativeInteger,
        oldestPendingAgeMs: nonNegativeInteger,
        skippedDocuments: nonNegativeInteger,
        skippedHandlers: nonNegativeInteger,
      }),
      index: optionalObject({ generation: nonNegativeInteger }),
      derivedView: optionalObject({
        formatVersion: positiveInteger,
        upgradeStatus: enumeration(["indexing", "complete"]),
        project: identifier,
        projects: nonNegativeInteger,
        layout: identifier,
        activeEpoch: positiveInteger,
        ordinalHighWatermark: nonNegativeInteger,
        admittedDocuments: nonNegativeInteger,
        tombstonedDocuments: nonNegativeInteger,
        tombstoneGeneration: nonNegativeInteger,
        liveDocuments: nonNegativeInteger,
        runs: array(jsonValue),
        updatedAt: timestamp,
      }, ["formatVersion", "upgradeStatus", "liveDocuments"]),
      memory: optionalObject({
        rssBytes: nonNegativeInteger,
        maxRssBytes: nonNegativeInteger,
        heapTotalBytes: nonNegativeInteger,
        heapUsedBytes: nonNegativeInteger,
        externalBytes: nonNegativeInteger,
        arrayBuffersBytes: nonNegativeInteger,
      }, [
        "rssBytes",
        "maxRssBytes",
        "heapTotalBytes",
        "heapUsedBytes",
        "externalBytes",
        "arrayBuffersBytes",
      ]),
      semantic: optionalObject({
        enabled: boolean(),
        available: boolean(),
        projects: nonNegativeInteger,
        model: identifier,
        revision: identifier,
        dimensions: nonNegativeInteger,
        pooling: identifier,
        entries: nonNegativeInteger,
        documents: nonNegativeInteger,
        queuedDocuments: nonNegativeInteger,
        metadataBytes: nonNegativeInteger,
        indexBytes: nonNegativeInteger,
      }),
      reranker: optionalObject({
        enabled: boolean(),
        available: boolean(),
        model: identifier,
        revision: identifier,
        candidateWindow: nonNegativeInteger,
      }),
      retention: retentionStats,
      rocksdb: metadata,
      filesystem: optionalObject({
        freeBytes: nonNegativeInteger,
        emergencyMode: boolean(),
      }),
      migration: migrationStatus,
      backgroundErrors: array(STORE_ERROR_SCHEMA),
      slowRequests: array(object({
        operation: identifier,
        requestBytes: nonNegativeInteger,
        durationMs: nonNegativeInteger,
        completedAt: timestamp,
        ok: boolean(),
        stageTimings: optionalObject({
          maintenanceMs: nonNegativeInteger,
          candidateSearchMs: nonNegativeInteger,
          semanticMs: nonNegativeInteger,
          rerankerMs: nonNegativeInteger,
          searchOtherMs: nonNegativeInteger,
          traversalMs: nonNegativeInteger,
          recallMs: nonNegativeInteger,
          conflictMs: nonNegativeInteger,
          gatherOtherMs: nonNegativeInteger,
          requestOtherMs: nonNegativeInteger,
        }, ["requestOtherMs"]),
      }, ["operation", "requestBytes", "durationMs", "completedAt", "ok"])),
    }, [
      "ready",
      "processId",
      "storePath",
      "startedAt",
      "schemaVersion",
      "protocolVersion",
      "capabilities",
      "backgroundErrors",
    ]),
  },
  "daemon.ping": {
    request: object({ nonce: identifier }),
    result: object({ nonce: identifier, serverTime: timestamp }),
  },
  "daemon.shutdown": {
    request: object({ reason: string({ minLength: 1, maxLength: 4_096 }) }, []),
    result: object({ accepted: literal(true) }),
  },
  "migration.status": {
    request: object({}),
    result: migrationStatus,
  },
  "migration.activate-rocks": {
    request: object({ sourcePath: identifier }),
    result: object({
      backend: literal("rocksdb"),
      mode: enumeration(["fresh-authority", "verified-cutover", "authority"]),
      phase: enumeration([
        "not-started",
        "offline-copy",
        "offline-verification",
        "offline-ready",
        "rocksdb-authority",
        "blocked",
      ]),
      sourcePath: identifier,
    }),
  },
  "migration.claim-sqlite": {
    request: object({ sourcePath: identifier }),
    result: object({
      backend: literal("sqlite"),
      phase: enumeration([
        "not-started",
        "offline-copy",
        "offline-verification",
        "offline-ready",
        "rocksdb-authority",
        "blocked",
      ]),
      sourcePath: identifier,
    }),
  },
  "migration.start": {
    request: object({
      sourcePath: identifier,
      batchSize: integer({ minimum: 1, maximum: 100_000 }),
      offline: literal(true),
    }, ["sourcePath", "offline"]),
    result: object({ accepted: literal(true), status: migrationStatus }),
  },
  "migration.verify": {
    request: object({
      sourcePath: identifier,
      sampleLimit: integer({ minimum: 1, maximum: 1_000_000 }),
      allowlist: array(jsonValue),
      artifactPath: identifier,
    }, []),
    result: object({
      status: enumeration(["passed", "failed"]),
      checked: nonNegativeInteger,
      missing: nonNegativeInteger,
      extra: nonNegativeInteger,
      provenanceDifferences: nonNegativeInteger,
      recallDifferences: nonNegativeInteger,
      differences: nonNegativeInteger,
      failures: nonNegativeInteger,
      differenceCounts: nonNegativeIntegerMap,
      failureCounts: nonNegativeIntegerMap,
      comparisonHash: string({ pattern: "^sha256:[a-f0-9]{64}$" }),
      sampledDifferences: nonNegativeInteger,
      samplesTruncated: boolean(),
      artifactPath: identifier,
    }, [
      "status",
      "checked",
      "missing",
      "extra",
      "provenanceDifferences",
      "recallDifferences",
      "differences",
      "failures",
      "differenceCounts",
      "failureCounts",
      "comparisonHash",
      "sampledDifferences",
      "samplesTruncated",
    ]),
  },
});

export const STORE_OPERATIONS = Object.freeze(Object.keys(STORE_OPERATION_CONTRACTS));

for (const schema of [
  SOURCE_REFERENCE_SCHEMA,
  STRUCTURAL_MESSAGE_SCHEMA,
  SUPERSEDES_TARGET_SCHEMA,
  EVENT_SCHEMA,
  DOCUMENT_SCHEMA,
  PHYSICAL_CHUNK_SCHEMA,
  SEARCH_WINDOW_SCHEMA,
  TURN_MANIFEST_SCHEMA,
  TOOL_RESULT_MANIFEST_SCHEMA,
  SUPERSESSION_SCHEMA,
  LEASE_SCHEMA,
  OUTBOX_ENTRY_SCHEMA,
  STORE_SCHEMA_METADATA_SCHEMA,
  LOCATOR_PAYLOAD_SCHEMA,
  STORE_ERROR_SCHEMA,
]) deepFreeze(schema);
