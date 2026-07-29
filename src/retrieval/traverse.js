import { KEYSPACE } from "../rocksdb/keys.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import {
  assertStoreRequest,
  assertStoreResult,
  MAX_SESSION_LINEAGE_IDS,
} from "../store/store-contract.js";
import {
  createRetrievalLease,
  RetrievalLeaseTargetUnavailableError,
} from "./leases.js";
import {
  authorizeLocator,
  getOrCreateLocatorSecret,
  signLocator,
} from "./locator.js";

const DEFAULT_SCAN_LIMIT = 2_048;
const MAX_SCAN_LIMIT = 10_000;
const MAX_SNIPPET_BYTES = 512;

function requireStore(store) {
  if (!store || typeof store.snapshot !== "function" || typeof store.scan !== "function") {
    throw new TypeError("traverseArchive requires a RocksStore-compatible store.");
  }
}

function normalizeRequest(request, project) {
  assertStoreRequest("store.traverse", request);
  const sessionIds = [...new Set(request.sessionIds ?? [])];
  if (sessionIds.length > MAX_SESSION_LINEAGE_IDS) {
    throw new RangeError(`sessionIds must contain at most ${MAX_SESSION_LINEAGE_IDS} unique IDs.`);
  }
  return Object.freeze({
    locator: request.locator,
    direction: request.direction,
    scope: request.scope === "all" ? "project" : request.scope,
    sessionIds: Object.freeze(sessionIds),
    project,
    limit: request.limit,
    scanLimit: request.scanLimit ?? DEFAULT_SCAN_LIMIT,
  });
}

function tupleCompare(left, right) {
  return Number(left.createdAt) - Number(right.createdAt)
    || String(left.documentId).localeCompare(String(right.documentId))
    || Number(left.version) - Number(right.version);
}

function referencePrefixes(request) {
  if (request.scope === "session") {
    return request.sessionIds.map((sessionId) =>
      manifestKeys.sessionDocumentReferencePrefix(request.project, sessionId));
  }
  return [[KEYSPACE.META, "session-document-reference", request.project]];
}

async function collectCandidates(view, anchorClaims, request) {
  const anchor = await view.get(manifestKeys.document(
    anchorClaims.documentId,
    anchorClaims.documentVersion,
  ));
  if (anchor === undefined || anchor.project !== request.project) {
    return { candidates: [], scanned: 0, truncated: false, hasMore: false };
  }
  if (request.scope === "session" && !request.sessionIds.includes(anchor.sessionId)) {
    return { candidates: [], scanned: 0, truncated: false, hasMore: false };
  }

  const references = [];
  let truncated = false;
  for (const prefix of referencePrefixes(request)) {
    const remaining = request.scanLimit - references.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = view.scan(prefix, { limit: remaining + 1 });
    if (page.length > remaining) truncated = true;
    references.push(...page.slice(0, remaining));
  }

  const candidates = [];
  for (const { payload: reference } of references) {
    if (reference.documentId === anchor.documentId
      && reference.documentVersion === anchor.version) continue;
    const manifest = await view.get(manifestKeys.document(
      reference.documentId,
      reference.documentVersion,
    ));
    if (manifest === undefined || manifest.project !== request.project) continue;
    if (request.scope === "session" && !request.sessionIds.includes(manifest.sessionId)) continue;
    const retired = view.scan([
      KEYSPACE.SUPERSESSION,
      manifest.documentId,
      manifest.version,
    ], { limit: 1 });
    if (retired.length > 0) continue;
    const ordering = tupleCompare(manifest, anchor);
    if ((request.direction === "before" && ordering >= 0)
      || (request.direction === "after" && ordering <= 0)) continue;
    const range = await readDocumentRange(
      view,
      manifest,
      0,
      Math.min(manifest.byteLength, MAX_SNIPPET_BYTES),
      { adjustUtf8: true },
    );
    candidates.push({ manifest, snippet: range.text });
  }
  candidates.sort((left, right) => request.direction === "before"
    ? tupleCompare(right.manifest, left.manifest)
    : tupleCompare(left.manifest, right.manifest));
  return {
    candidates: candidates.slice(0, request.limit),
    scanned: references.length,
    truncated,
    hasMore: truncated || candidates.length > request.limit,
  };
}

/** Traverse exact archived document chronology from an authenticated locator. */
export async function traverseArchive(store, rawRequest, options = {}) {
  requireStore(store);
  const project = options.project;
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Traversal requires an authorized project boundary.");
  }
  const request = normalizeRequest(rawRequest, project);
  if (request.scanLimit > MAX_SCAN_LIMIT) throw new RangeError(`scanLimit must be at most ${MAX_SCAN_LIMIT}.`);
  const secret = await getOrCreateLocatorSecret(store, {
    secret: options.secret,
    now: options.now,
  });
  const anchorClaims = authorizeLocator(request.locator, secret, {
    project: request.project,
    sessionIds: request.sessionIds,
  });
  const effectiveRequest = anchorClaims.scope === "session"
    ? { ...request, scope: "session" }
    : request;
  const collected = await store.snapshot((view) =>
    collectCandidates(view, anchorClaims, effectiveRequest));

  const now = options.now ?? Date.now();
  const results = [];
  for (const { manifest, snippet } of collected.candidates) {
    let lease;
    try {
      lease = await createRetrievalLease(store, {
        ownerId: options.ownerId ?? "traverse",
        documentId: manifest.documentId,
        documentVersion: manifest.version,
        now,
        ttlMs: options.leaseMs,
      });
    } catch (error) {
      if (error instanceof RetrievalLeaseTargetUnavailableError) continue;
      throw error;
    }
    const endByte = Math.min(manifest.byteLength, Math.max(1, Buffer.byteLength(snippet, "utf8")));
    const locator = signLocator({
      locatorVersion: 1,
      documentId: manifest.documentId,
      documentVersion: manifest.version,
      windowOrdinal: 0,
      matchRange: { startByte: 0, endByte },
      indexGeneration: 0,
      leaseId: lease.leaseId,
      project: request.project,
      sessionId: manifest.sessionId,
      scope: effectiveRequest.scope,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
    }, secret);
    results.push({
      documentId: manifest.documentId,
      version: manifest.version,
      kind: manifest.kind,
      score: 1,
      rawScore: 1,
      calibratedScore: 1,
      retrievalMode: "structural",
      createdAt: manifest.createdAt,
      matchType: `chronological-${request.direction}`,
      margin: 1,
      matchedAnchors: [],
      matchedTerms: [],
      termCoverage: 0,
      termIdf: [],
      maxNormalizedIdf: 0,
      snippet,
      historical: true,
      superseded: false,
      locator,
      source: {
        sessionId: manifest.sessionId,
        project: manifest.project,
      },
    });
  }
  return assertStoreResult("store.traverse", {
    status: results.length > 0 ? "resolved" : "not-found",
    direction: request.direction,
    scanned: collected.scanned,
    truncated: collected.truncated,
    hasMore: collected.hasMore,
    results,
  });
}
