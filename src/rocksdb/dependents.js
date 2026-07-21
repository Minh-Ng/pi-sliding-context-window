// Surface-only invalidation cascade (ultracode task #36): once a document is
// superseded, find later-admitted documents that show signs of depending on
// it, from postings that already exist at admission time. Every read below
// is either a single point get or a bounded prefix/limit scan against one
// existing posting family (EVENT_REFERENCE, EXACT, SUPERSESSION) -- never a
// keyspace-wide scan -- so this stays cheap no matter how large the archive
// grows. This module only counts and names candidates; it never tombstones,
// re-ranks, or otherwise acts on what it finds -- the agent judges.
import { KEYSPACE } from "./keys.js";
import { manifestKeys } from "./manifests.js";
import { exactKeys, normalizeExactValue } from "./index/exact.js";

// Total distinct candidate documents this lookup will ever consider across
// its three signals combined (source-message overlap, anchor citation of the
// target's documentId/subjectKey, and subjectKey supersession lineage). Once
// a call reaches this many distinct candidates it stops looking at further
// postings, so `count` is a floor -- not necessarily the exact total -- on
// any call where it lands exactly on this cap.
export const MAX_DEPENDENT_CANDIDATES = 25;
// Recallable document IDs actually surfaced to a caller. Independent of (and
// smaller than) MAX_DEPENDENT_CANDIDATES so a wide fan-out never grows the
// presented list past what a human or agent would scan in one glance.
export const MAX_DEPENDENT_DOCUMENT_IDS = 10;

const MAX_SOURCE_KEYS_SCANNED = 5;
const MAX_REFS_PER_SOURCE_KEY = 10;
const MAX_ANCHOR_POSTINGS_SCANNED = 10;
// The lineage walk itself is bounded independently of MAX_DEPENDENT_CANDIDATES
// so a long chain of same-subject revisions cannot spend the whole candidate
// budget before the other two signals get a turn.
const MAX_LINEAGE_HOPS = 20;

function addCandidate(candidates, documentId, version, excludeIds) {
  if (typeof documentId !== "string" || documentId.length === 0) return;
  if (!Number.isSafeInteger(version) || version <= 0) return;
  if (excludeIds.has(documentId)) return;
  const existing = candidates.get(documentId);
  if (existing !== undefined) {
    if (version > existing.version) existing.version = version;
    return;
  }
  if (candidates.size >= MAX_DEPENDENT_CANDIDATES) return;
  candidates.set(documentId, { version });
}

/** Signal 1: documents that share one of the target's own source messages. */
function sourceMessageOverlapCandidates(view, target, candidates, excludeIds) {
  const keys = [...(target.sourceMessageKeys ?? [])].slice(0, MAX_SOURCE_KEYS_SCANNED);
  for (const sourceKey of keys) {
    if (candidates.size >= MAX_DEPENDENT_CANDIDATES) break;
    const refs = view.scan(
      manifestKeys.sourceMessageReferencePrefix(target.project, target.sessionId, sourceKey),
      { limit: MAX_REFS_PER_SOURCE_KEY },
    );
    for (const ref of refs) {
      addCandidate(candidates, ref.payload?.documentId, ref.payload?.documentVersion, excludeIds);
    }
  }
}

/**
 * Signal 2: documents whose exact-anchor postings cite `term` -- the
 * target's own documentId or subjectKey, i.e. its identity. Exact postings
 * already carry the citing document's createdAt, so a hit here never needs a
 * follow-up manifest read.
 */
function anchorTermCandidates(view, term, project, candidates, excludeIds, createdAtByCandidate) {
  if (typeof term !== "string" || term.length === 0) return;
  const terms = [
    ["exact", normalizeExactValue(term, { foldCase: false })],
    ["folded", normalizeExactValue(term, { foldCase: true })],
  ];
  for (const [caseMode, value] of terms) {
    if (candidates.size >= MAX_DEPENDENT_CANDIDATES) break;
    const postings = view.scan(exactKeys.termPrefix(project, caseMode, value), {
      limit: MAX_ANCHOR_POSTINGS_SCANNED,
    });
    for (const posting of postings) {
      const payload = posting.payload;
      if (!payload || excludeIds.has(payload.documentId)) continue;
      addCandidate(candidates, payload.documentId, payload.documentVersion, excludeIds);
      if (Number.isSafeInteger(payload.createdAt)) {
        createdAtByCandidate.set(payload.documentId, payload.createdAt);
      }
    }
  }
}

/**
 * Signal 3: later hops down the target's own subjectKey supersession chain,
 * skipping the immediate direct successor -- that document is the
 * deliberate replacement the caller just created (or already knows about via
 * the supersede result's own `superseded` pointer / a recall's `reason`),
 * not a discovered dependency. Further hops are documents the caller likely
 * has not seen yet. `excludeIds` (the target's own identity plus, when known,
 * the direct replacement's documentId) is a second, redundant guard against
 * ever reporting that direct replacement here even if hop bookkeeping alone
 * would have let it through.
 */
function subjectLineageCandidates(view, target, candidates, createdAtByCandidate, excludeIds) {
  if (typeof target.subjectKey !== "string" || target.subjectKey.length === 0) return;
  let cursor = { documentId: target.documentId, version: target.version };
  for (let hop = 0; hop < MAX_LINEAGE_HOPS && candidates.size < MAX_DEPENDENT_CANDIDATES; hop += 1) {
    const marker = view.scan(
      [KEYSPACE.SUPERSESSION, cursor.documentId, cursor.version],
      { limit: 1 },
    )[0]?.payload;
    if (!marker || !Number.isSafeInteger(marker.replacementVersion)) break;
    const nextDocumentId = typeof marker.replacementDocumentId === "string"
      ? marker.replacementDocumentId
      : cursor.documentId;
    if (hop > 0) {
      addCandidate(candidates, nextDocumentId, marker.replacementVersion, excludeIds);
      if (Number.isSafeInteger(marker.recordedAt)) {
        createdAtByCandidate.set(nextDocumentId, marker.recordedAt);
      }
    }
    cursor = { documentId: nextDocumentId, version: marker.replacementVersion };
  }
}

/**
 * Bounded, postings-only surfacing of later-admitted documents that show
 * signs of referencing `target`. `target` is the superseded document's own
 * identity: `{documentId, version, project, sessionId, createdAt,
 * subjectKey?, sourceMessageKeys?}`. Returns `{count, documentIds}` --
 * `documentIds` is a recallable, capped subset; `count` is the number found
 * within this call's bounded scan (see MAX_DEPENDENT_CANDIDATES).
 *
 * `options.replacementDocumentId`, when the caller already knows it (the
 * SUPERSESSION marker's own pointer, or the documentId a supersede admission
 * just created), is excluded from every signal -- not just the subjectKey
 * lineage walk. Without this, a note-less supersede's default replacement
 * text (`Supersedes <targetId>@<version>.`) embeds the target's documentId,
 * which the exact indexer mines as an anchor citation on the replacement
 * itself, making the deliberate replacement misreport as its own dependent.
 *
 * This never tombstones, re-ranks, or otherwise changes anything it finds --
 * strictly a report for a human or agent to judge.
 */
export async function findDependentDocuments(view, target, options = {}) {
  if (!view || typeof view.scan !== "function" || typeof view.get !== "function") {
    throw new TypeError("findDependentDocuments requires a store or snapshot view.");
  }
  if (typeof target?.documentId !== "string" || target.documentId.length === 0
    || !Number.isSafeInteger(target?.version) || target.version <= 0
    || typeof target?.project !== "string" || target.project.length === 0
    || !Number.isSafeInteger(target?.createdAt)) {
    throw new TypeError("findDependentDocuments requires a target document identity.");
  }
  const excludeIds = new Set([target.documentId]);
  if (typeof options.replacementDocumentId === "string" && options.replacementDocumentId.length > 0) {
    excludeIds.add(options.replacementDocumentId);
  }
  const candidates = new Map();
  const createdAtByCandidate = new Map();
  sourceMessageOverlapCandidates(view, target, candidates, excludeIds);
  anchorTermCandidates(
    view, target.documentId, target.project, candidates, excludeIds, createdAtByCandidate,
  );
  if (target.subjectKey) {
    anchorTermCandidates(
      view, target.subjectKey, target.project, candidates, excludeIds, createdAtByCandidate,
    );
  }
  subjectLineageCandidates(view, target, candidates, createdAtByCandidate, excludeIds);

  const qualifying = [];
  for (const [documentId, info] of candidates) {
    let createdAt = createdAtByCandidate.get(documentId);
    if (createdAt === undefined) {
      const manifest = await view.get(manifestKeys.document(documentId, info.version));
      if (!manifest || manifest.project !== target.project) continue;
      createdAt = manifest.createdAt;
    }
    if (!(Number.isSafeInteger(createdAt) && createdAt > target.createdAt)) continue;
    qualifying.push({ documentId, createdAt });
  }
  qualifying.sort((left, right) => left.createdAt - right.createdAt
    || left.documentId.localeCompare(right.documentId));
  return Object.freeze({
    count: qualifying.length,
    documentIds: Object.freeze(qualifying.slice(0, MAX_DEPENDENT_DOCUMENT_IDS).map(({ documentId }) => documentId)),
  });
}
