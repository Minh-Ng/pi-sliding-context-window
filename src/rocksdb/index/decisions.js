import { KEYSPACE } from "../keys.js";
import { MAX_SESSION_LINEAGE_IDS } from "../../store-contract.js";
import { semanticIdentifier } from "../../semantic-identifiers.js";

export const DECISION_INDEX_VERSION = 1;
export const DECISION_KEYSPACE = "decision";
const MAX_DECISION_EXCERPT_BYTES = 64 * 1_024;

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function resolvePublishedGeneration(store, requested) {
  const publication = store.scan([
    KEYSPACE.META,
    "published-index-generation",
  ], { limit: 1 })[0]?.payload;
  const published = publication === undefined
    ? 0
    : nonNegativeInteger(publication.generation, "published generation");
  if (requested === undefined) return published;
  const generation = nonNegativeInteger(requested, "generation");
  if (generation > published) {
    throw new RangeError(`generation ${generation} is newer than published generation ${published}.`);
  }
  return generation;
}

/** Build source-linked decision evidence without summarizing or rewriting it. */
export function createDecisionEvidence({ manifest, text, generation, outboxSequence }) {
  if (!manifest || manifest.kind !== "decision-candidate") return undefined;
  identifier(text, "decision text");
  const sourceTurnId = semanticIdentifier(manifest.metadata?.sourceTurnId);
  // A decision excerpt without a containing source turn is not auditable and
  // must remain an ordinary document rather than derived decision evidence.
  if (!sourceTurnId) return undefined;
  return Object.freeze({
    decisionIndexVersion: DECISION_INDEX_VERSION,
    documentId: identifier(manifest.documentId, "documentId"),
    documentVersion: manifest.version,
    project: identifier(manifest.project, "project"),
    sessionId: identifier(manifest.sessionId, "sessionId"),
    createdAt: nonNegativeInteger(manifest.createdAt, "createdAt"),
    generation: nonNegativeInteger(generation, "generation"),
    outboxSequence: nonNegativeInteger(outboxSequence, "outboxSequence"),
    sourceTurnId,
    sourceMessageKeys: Object.freeze([...(manifest.sourceMessageKeys ?? [])]),
    excerpt: text,
    verbatim: true,
  });
}

export function decisionMutation(evidence, reverseSequence) {
  if (!evidence) return Object.freeze([]);
  nonNegativeInteger(reverseSequence, "reverseSequence");
  const bytes = Buffer.from(evidence.excerpt, "utf8");
  const excerpts = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + MAX_DECISION_EXCERPT_BYTES);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) throw new Error("Decision excerpt segment cannot make UTF-8 progress.");
    excerpts.push({
      excerpt: bytes.subarray(start, end).toString("utf8"),
      startByte: start,
      endByte: end,
    });
    start = end;
  }
  if (excerpts.length === 0) excerpts.push({ excerpt: "", startByte: 0, endByte: 0 });
  return Object.freeze(excerpts.flatMap((segment, excerptSegmentOrdinal) => {
    const suffix = [evidence.documentId, evidence.documentVersion, excerptSegmentOrdinal];
    const payload = Object.freeze({
      ...evidence,
      excerpt: segment.excerpt,
      startByte: segment.startByte,
      endByte: segment.endByte,
      excerptSegmentOrdinal,
      excerptSegmentCount: excerpts.length,
    });
    return [
      ["session", evidence.project, evidence.sessionId, reverseSequence, ...suffix],
      ["project", evidence.project, reverseSequence, evidence.sessionId, ...suffix],
      ["all", reverseSequence, evidence.project, evidence.sessionId, ...suffix],
    ].map((parts) => Object.freeze({
        type: "put",
        key: [DECISION_KEYSPACE, ...parts],
        kind: "decision-evidence",
        payload,
        immutable: true,
      }));
  }));
}

function allowedScope(evidence, { project, sessionIds, scope, generation, store }) {
  if (evidence.generation > generation) return false;
  if (store.scan([
    "supersession",
    evidence.documentId,
    evidence.documentVersion,
  ], { limit: 1 }).length > 0) return false;
  if (scope === "all") return true;
  if (project && evidence.project !== project) return false;
  if (scope === "session" && sessionIds.length > 0 && !sessionIds.includes(evidence.sessionId)) {
    return false;
  }
  return true;
}

function decisionRecords(store, { project, sessionIds, scope, scanLimit }) {
  if (scope === "session") {
    return sessionIds.flatMap((lineageSessionId) => store.scan([
      DECISION_KEYSPACE,
      "session",
      project,
      lineageSessionId,
    ], { limit: scanLimit }));
  }
  if (scope === "project") {
    return store.scan([DECISION_KEYSPACE, "project", project], { limit: scanLimit });
  }
  return store.scan([DECISION_KEYSPACE, "all"], { limit: scanLimit });
}

/** Return newest verbatim decisions with explicit source linkage. */
export function lookupDecisionEvidence(store, {
  query = "",
  project,
  sessionId,
  sessionIds = sessionId ? [sessionId] : [],
  scope = "session",
  generation,
  limit = 3,
  scanLimit = 10_000,
} = {}) {
  if (!store || typeof store.scan !== "function") {
    throw new TypeError("lookupDecisionEvidence requires a RocksStore-compatible store.");
  }
  if (!["session", "project", "all"].includes(scope)) {
    throw new TypeError("scope must be session, project, or all.");
  }
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 3));
  const lineage = [...new Set(sessionIds.filter(Boolean).map(String))];
  if (lineage.length > MAX_SESSION_LINEAGE_IDS) {
    throw new RangeError(`sessionIds must contain at most ${MAX_SESSION_LINEAGE_IDS} unique IDs.`);
  }
  if (scope === "session" && lineage.length === 0) {
    throw new TypeError("Session-scoped decision lookup requires sessionId or sessionIds.");
  }
  if (scope !== "all" && (typeof project !== "string" || project.length === 0)) {
    throw new TypeError("Scoped decision lookup requires project.");
  }
  const resolvedGeneration = resolvePublishedGeneration(store, generation);
  const terms = [...new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
  const boundedScan = Math.min(100_000, Math.max(boundedLimit, Number(scanLimit) || 10_000));
  const records = decisionRecords(store, { project, sessionIds: lineage, scope, scanLimit: boundedScan });
  const results = [];
  const seen = new Set();
  for (const { payload } of records) {
    if (!payload?.verbatim || !allowedScope(payload, {
      project,
      sessionIds: lineage,
      scope,
      generation: resolvedGeneration,
      store,
    })) continue;
    const excerptTerms = new Set(String(payload.excerpt).toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
    if (terms.length > 0 && !terms.some((term) => excerptTerms.has(term))) continue;
    const identity = `${payload.documentId}\0${payload.documentVersion}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push(Object.freeze({
      ...payload,
      relation: "latest-decision",
      granularity: "decision-excerpt",
      relationConfidence: 100,
      lineageDepth: Math.max(0, lineage.indexOf(payload.sessionId)),
      snippet: payload.excerpt,
    }));
    if (results.length >= boundedLimit) break;
  }
  return Object.freeze(results);
}
