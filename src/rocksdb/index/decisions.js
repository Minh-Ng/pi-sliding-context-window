import { KEYSPACE } from "../keys.js";
import {
  derivedViewKeys,
  isDerivedViewQueryCutover,
} from "../derived-view.js";
import { MAX_SESSION_LINEAGE_IDS } from "../../store/store-contract.js";
import { semanticIdentifier } from "../../identity/semantic-identifiers.js";

export const DECISION_INDEX_VERSION = 1;
export const DECISION_KEYSPACE = "decision";
const MAX_DECISION_EXCERPT_BYTES = 64 * 1_024;
const SEARCH_YIELD_RECORDS = 128;
const SEARCH_YIELD_CHARACTERS = 1 * 1_024 * 1_024;
const SEARCH_SCAN_PAGE = 64;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function allowedScope(
  evidence,
  {
    project,
    sessionIds,
    scope,
    generation,
    store,
    derivedViewAuthoritative,
  },
) {
  if (evidence.generation > generation) return false;
  if (derivedViewAuthoritative) {
    const assignment = store.scan(derivedViewKeys.document(
      evidence.project,
      evidence.documentId,
      evidence.documentVersion,
    ), { limit: 1 })[0]?.payload;
    if (assignment === undefined || store.scan(
      derivedViewKeys.tombstone(evidence.project, assignment.ordinal),
      { limit: 1 },
    ).length > 0) return false;
  } else if (store.scan([
    KEYSPACE.SUPERSESSION,
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

function decisionPrefixes({ project, sessionIds, scope }) {
  if (scope === "session") {
    return sessionIds.map((lineageSessionId) => [
      DECISION_KEYSPACE,
      "session",
      project,
      lineageSessionId,
    ]);
  }
  if (scope === "project") {
    return [[DECISION_KEYSPACE, "project", project]];
  }
  return [[DECISION_KEYSPACE, "all"]];
}

function decisionRecords(store, options) {
  return decisionPrefixes(options).flatMap((prefix) =>
    store.scan(prefix, { limit: options.scanLimit }));
}

function containsDecisionTerm(excerpt, terms) {
  if (terms.size === 0) return true;
  const normalized = String(excerpt).toLocaleLowerCase();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    if (terms.has(match[0])) return true;
  }
  return false;
}

function decisionLookupContext(store, {
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
  const derivedViewAuthoritative = isDerivedViewQueryCutover(
    store.scan(derivedViewKeys.queryCutover(), { limit: 1 })[0]?.payload,
  );
  const terms = new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  const boundedScan = Math.min(100_000, Math.max(boundedLimit, Number(scanLimit) || 10_000));
  return {
    project,
    scope,
    lineage,
    resolvedGeneration,
    terms,
    boundedLimit,
    boundedScan,
    derivedViewAuthoritative,
  };
}

function decisionResult(payload, lineage) {
  return Object.freeze({
    ...payload,
    relation: "latest-decision",
    granularity: "decision-excerpt",
    relationConfidence: 100,
    lineageDepth: Math.max(0, lineage.indexOf(payload.sessionId)),
    snippet: payload.excerpt,
  });
}

function* decisionLookupWork(store, request) {
  const context = decisionLookupContext(store, request);
  const {
    project,
    scope,
    lineage,
    resolvedGeneration,
    terms,
    boundedLimit,
    boundedScan,
  } = context;
  const results = [];
  const seen = new Set();
  let recordsSinceYield = 0;
  let charactersSinceYield = 0;
  for (const prefix of decisionPrefixes({ project, sessionIds: lineage, scope })) {
    let liveRemaining = boundedScan;
    let physicalRemaining = 100_000;
    let after;
    while (liveRemaining > 0 && physicalRemaining > 0) {
      const pageLimit = Math.min(SEARCH_SCAN_PAGE, physicalRemaining);
      const page = store.scan(prefix, {
        limit: pageLimit,
        ...(after === undefined ? {} : { after }),
      });
      physicalRemaining -= page.length;
      for (const { payload } of page) {
        recordsSinceYield += 1;
        charactersSinceYield += typeof payload?.excerpt === "string" ? payload.excerpt.length : 0;
        const allowed = payload?.verbatim && allowedScope(payload, {
          project,
          sessionIds: lineage,
          scope,
          generation: resolvedGeneration,
          store,
          derivedViewAuthoritative: context.derivedViewAuthoritative,
        });
        if (allowed) {
          liveRemaining -= 1;
          if (containsDecisionTerm(payload.excerpt, terms)) {
            const identity = `${payload.documentId}\0${payload.documentVersion}`;
            if (!seen.has(identity)) {
              seen.add(identity);
              results.push(decisionResult(payload, lineage));
              if (results.length >= boundedLimit) return Object.freeze(results);
            }
          }
        }
        if (recordsSinceYield >= SEARCH_YIELD_RECORDS
          || charactersSinceYield >= SEARCH_YIELD_CHARACTERS) {
          recordsSinceYield = 0;
          charactersSinceYield = 0;
          yield;
        }
      }
      if (liveRemaining <= 0 || page.length < pageLimit
        || page.at(-1)?.keyBytes === undefined) break;
      after = page.at(-1).keyBytes;
    }
  }
  return Object.freeze(results);
}

function runDecisionLookup(work) {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Return newest verbatim decisions with explicit source linkage. */
export function lookupDecisionEvidence(store, request = {}) {
  return runDecisionLookup(decisionLookupWork(store, request));
}

/** Cooperative variant for daemon request paths that must remain responsive. */
export async function lookupDecisionEvidenceAsync(store, request = {}, {
  yieldControl = yieldToEventLoop,
} = {}) {
  const context = decisionLookupContext(store, request);
  const results = [];
  const seen = new Set();
  let recordsSinceYield = 0;
  let charactersSinceYield = 0;
  for (const prefix of decisionPrefixes({
    project: context.project,
    sessionIds: context.lineage,
    scope: context.scope,
  })) {
    let liveRemaining = context.boundedScan;
    let physicalRemaining = 100_000;
    let after;
    while (liveRemaining > 0 && physicalRemaining > 0) {
      const pageLimit = Math.min(SEARCH_SCAN_PAGE, physicalRemaining);
      const page = store.scan(prefix, {
        limit: pageLimit,
        ...(after === undefined ? {} : { after }),
      });
      physicalRemaining -= page.length;
      for (const { payload } of page) {
        recordsSinceYield += 1;
        charactersSinceYield += typeof payload?.excerpt === "string" ? payload.excerpt.length : 0;
        const allowed = payload?.verbatim && allowedScope(payload, {
          project: context.project,
          sessionIds: context.lineage,
          scope: context.scope,
          generation: context.resolvedGeneration,
          store,
          derivedViewAuthoritative: context.derivedViewAuthoritative,
        });
        if (allowed) {
          liveRemaining -= 1;
          if (containsDecisionTerm(payload.excerpt, context.terms)) {
            const identity = `${payload.documentId}\0${payload.documentVersion}`;
            if (!seen.has(identity)) {
              seen.add(identity);
              results.push(decisionResult(payload, context.lineage));
              if (results.length >= context.boundedLimit) return Object.freeze(results);
            }
          }
        }
        if (recordsSinceYield >= SEARCH_YIELD_RECORDS
          || charactersSinceYield >= SEARCH_YIELD_CHARACTERS) {
          recordsSinceYield = 0;
          charactersSinceYield = 0;
          await yieldControl();
        }
      }
      if (liveRemaining <= 0 || page.length < pageLimit
        || page.at(-1)?.keyBytes === undefined) break;
      after = page.at(-1).keyBytes;
      await yieldControl();
    }
  }
  return Object.freeze(results);
}
