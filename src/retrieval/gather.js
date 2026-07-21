import {
  assertStoreRequest,
  assertStoreResult,
} from "../store/store-contract.js";
import {
  readNearDuplicateSignature,
  selectNearDuplicateRepresentatives,
} from "../rocksdb/index/simhash.js";
import { extractExactAnchors } from "../rocksdb/index/exact.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { DECISION_CUE_PATTERN } from "../session/window.js";
import { recallArchive } from "./recall.js";
import { searchArchive } from "./search.js";
import { traverseArchive } from "./traverse.js";

const MIN_RECALL_TOKENS = 39;
const DEFAULT_SCAN_LIMIT = 2_048;

function reportStageTiming(options, stage, durationMs) {
  if (typeof options.recordStageTiming !== "function") return;
  try {
    options.recordStageTiming(stage, Math.max(0, durationMs));
  } catch { /* diagnostics must not affect retrieval */ }
}

// Reversal-flavored half of the decision extractor's own cue lexicon
// (session/window.js's DECISION_CUE_PATTERN, reused verbatim above as the
// "this sentence is decision-shaped at all" test): reject/rule-out/won't/
// instead-of/rather-than/out-of-scope/defer, plus revert. A text matching
// DECISION_CUE_PATTERN but not this subset reads as the affirming half of a
// possibly-conflicting pair ("we decided to use X"); matching both reads as
// the reversal half ("instead of X, we're rejecting it"). Two evidence items
// are "opposing" only when exactly one side is reversal-flavored -- two
// affirmations or two rejections of the same subject are not evidence of a
// conflict on their own.
const REVERSAL_CUE_PATTERN = new RegExp(
  "\\b(?:"
  + [
    "instead of", "rather than", "reject(?:ed|ing)?", "rul(?:ed?|ing) out",
    "won'?t (?:use|do|support|need)", "will not", "out of scope",
    "deferr?(?:ed|ing)?", "revert(?:ed|ing)?",
  ].join("|")
  + ")\\b",
  "i",
);

// "Strong" exact-anchor types (rocksdb/index/exact.js's TYPE_SPECIFICITY)
// for subject-signal overlap: every classified type except the generic
// "value" catch-all (bare version numbers, hex constants, k=v pairs), which
// is too common across unrelated evidence to imply the same subject.
const STRONG_CONFLICT_ANCHOR_TYPES = new Set([
  "error", "path", "commit", "quoted-value", "symbol", "dotted-name", "url",
]);
// Local, per-evidence-item text scan -- not a store scan -- so this stays
// cheap regardless of how large the archive is; capped defensively anyway
// since a pathological excerpt could otherwise produce a large anchor set.
const MAX_CONFLICT_ANCHORS_PER_EVIDENCE = 64;
// Contract cap on gatheredEvidence.possiblyConflicting (store-contract-schema
// .js). A packet holds up to 24 evidence items, so one item can in principle
// share a subject signal with up to 23 others; must truncate here rather
// than let the schema validator reject the whole packet.
const MAX_POSSIBLY_CONFLICTING_REFS = 8;

function candidateIdentity(candidate) {
  return `${candidate.documentId}\0${candidate.version}`;
}

function presets(request) {
  if (request.intent === "state") return { before: 0, after: 0 };
  if (request.intent === "workflow") return { before: 1, after: 8 };
  return { before: 1, after: 3 };
}

function normalizeRequest(rawRequest, project) {
  assertStoreRequest("store.gather", rawRequest);
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Gather requires an authorized project boundary.");
  }
  const sessionIds = [...new Set(rawRequest.sessionIds ?? [])];
  if (rawRequest.scope === "session" && sessionIds.length === 0) {
    throw new TypeError("Session-scoped gather requires sessionIds.");
  }
  const defaults = presets(rawRequest);
  return Object.freeze({
    ...rawRequest,
    project,
    sessionIds: Object.freeze(sessionIds),
    before: rawRequest.before ?? defaults.before,
    after: rawRequest.after ?? defaults.after,
  });
}

function candidatePriority(relation, anchorRank, distance, intent) {
  if (intent === "workflow") {
    if (anchorRank === 1 && relation === "anchor") return 0;
    if (anchorRank === 1 && relation === "after") return distance;
    if (anchorRank === 1 && relation === "before") return 50 + distance;
    if (relation === "anchor") return 100 + anchorRank;
    return 200 + anchorRank * 20 + distance;
  }
  if (relation === "anchor") return anchorRank;
  return 100 + anchorRank * 20 + (relation === "after" ? distance : 10 + distance);
}

function addCandidate(candidates, candidate, relation, anchorRank, distance, intent) {
  const identity = candidateIdentity(candidate);
  const priority = candidatePriority(relation, anchorRank, distance, intent);
  const current = candidates.get(identity);
  if (current === undefined || priority < current.priority) {
    candidates.set(identity, {
      candidate,
      relation,
      anchorRank,
      distance,
      priority,
    });
  }
}

function traversalLineage(request, anchor) {
  if (request.scope === "session") return request.sessionIds;
  return Object.freeze([anchor.source.sessionId]);
}

export function chronological(left, right) {
  return Number(left.document.createdAt) - Number(right.document.createdAt)
    || String(left.document.documentId).localeCompare(String(right.document.documentId))
    || Number(left.document.version) - Number(right.document.version);
}

/**
 * Collapse near-duplicate gather candidates onto one representative per
 * cluster, over the already-priority-sorted candidate list (anchors and
 * their before/after traversal neighbors alike) rather than anchors alone.
 * An anchor candidate may already carry a `nearDuplicates` count from
 * search.js's own dedup pass; priorCount folds that into whichever
 * representative ultimately absorbs it here, so a repeated-output anchor and
 * a repeated-output neighbor collapsing together does not lose the anchor's
 * already-suppressed count.
 */
async function dedupOrderedCandidates(store, orderedCandidates, project, options = {}) {
  if (orderedCandidates.length <= 1) return orderedCandidates;
  const signatures = await store.snapshot(async (view) => {
    const map = new Map();
    for (const entry of orderedCandidates) {
      const simhash = await readNearDuplicateSignature(
        view,
        project,
        entry.candidate.documentId,
        entry.candidate.version,
      );
      if (simhash !== undefined) map.set(entry, simhash);
    }
    return map;
  });
  const representatives = selectNearDuplicateRepresentatives(orderedCandidates, {
    ...(options.maxHammingDistance === undefined
      ? {}
      : { maxHammingDistance: options.maxHammingDistance }),
    signatureOf: (entry) => signatures.get(entry),
    priorCount: (entry) => entry.candidate.nearDuplicates ?? 0,
  });
  return representatives.map(({ item, nearDuplicates }) => ({ ...item, nearDuplicates }));
}

/** Bounded, local (no store access) set of this evidence item's own strong
 * exact-anchor citations, keyed case-insensitively by type+value. */
function strongAnchorKeys(text) {
  const anchors = extractExactAnchors(String(text ?? ""), {
    maxAnchors: MAX_CONFLICT_ANCHORS_PER_EVIDENCE,
  });
  const keys = new Set();
  for (const anchor of anchors) {
    if (!STRONG_CONFLICT_ANCHOR_TYPES.has(anchor.type)) continue;
    keys.add(`${anchor.type}::${anchor.folded}`);
  }
  return keys;
}

function sharesStrongAnchor(left, right) {
  if (left.size === 0 || right.size === 0) return false;
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

/** Both sides read as decision-shaped, and exactly one side is
 * reversal-flavored: the "opposing decision cues" half of the contract. */
function opposingDecisionCues(leftText, rightText) {
  if (!DECISION_CUE_PATTERN.test(leftText) || !DECISION_CUE_PATTERN.test(rightText)) {
    return false;
  }
  return REVERSAL_CUE_PATTERN.test(leftText) !== REVERSAL_CUE_PATTERN.test(rightText);
}

/** True when one item's own recorded explicit supersession already targets
 * the other -- the tension is already formalized, not merely possible. In
 * gatherArchive's own flow this is always false by construction (a document
 * that is actually superseded fails recall and never reaches `evidence`);
 * this is a defense-in-depth guard against ever mislabeling a formally
 * reconciled pair, kept independently testable and cheap (no extra store
 * round trip -- `supersedes` rides along with the subjectKey manifest read
 * gatherArchive already does for every evidence item). */
function supersessionLinks(left, right) {
  const leftTargetsRight = left.supersedes
    && left.supersedes.documentId === right.documentId
    && left.supersedes.version === right.version;
  const rightTargetsLeft = right.supersedes
    && right.supersedes.documentId === left.documentId
    && right.supersedes.version === left.version;
  return Boolean(leftTargetsRight || rightTargetsLeft);
}

/**
 * Deterministic, bounded pairwise conflict flagging within one gather packet
 * (ultracode task #37). Two evidence descriptors that share a subject signal
 * (same live subjectKey, or a strong typed-anchor citation in common),
 * carry opposing decision-cue language, and are not already connected by an
 * explicit supersession get a mutual "possibly conflicting" cross-reference.
 * This is honest uncertainty, not a verdict -- the agent judges: two records
 * restating the same decision, or coincidentally sharing an anchor, are the
 * accepted false-positive risk, so every label reads "possibly," never
 * "conflicting." Pairwise over `descriptors` (bounded by the caller to one
 * gather packet's evidence, itself capped by maxEvidence), never a store
 * scan. Exported directly for targeted unit coverage of the flagging logic
 * itself (e.g. the supersession-link exclusion), independent of whether
 * gatherArchive's own recall filtering can ever construct that input.
 * Each item's ref list is truncated at MAX_POSSIBLY_CONFLICTING_REFS (the
 * schema's possiblyConflicting maxItems) -- with up to 24 evidence items per
 * packet, one item can otherwise collect more conflict refs than the
 * contract allows, which would make the whole packet fail validation rather
 * than degrade gracefully.
 */
export function detectPossibleConflicts(descriptors) {
  const conflicts = new Map();
  const addRef = (ref, otherRef) => {
    const existing = conflicts.get(ref);
    if (existing === undefined) {
      conflicts.set(ref, [otherRef]);
    } else if (
      !existing.includes(otherRef)
      && existing.length < MAX_POSSIBLY_CONFLICTING_REFS
    ) {
      existing.push(otherRef);
    }
  };
  for (let i = 0; i < descriptors.length; i += 1) {
    for (let j = i + 1; j < descriptors.length; j += 1) {
      const left = descriptors[i];
      const right = descriptors[j];
      const sameSubject = (left.subjectKey !== undefined && left.subjectKey === right.subjectKey)
        || sharesStrongAnchor(left.anchorKeys, right.anchorKeys);
      if (!sameSubject) continue;
      if (!opposingDecisionCues(left.text, right.text)) continue;
      if (supersessionLinks(left, right)) continue;
      addRef(left.ref, right.ref);
      addRef(right.ref, left.ref);
    }
  }
  return conflicts;
}

/**
 * Enrich already-resolved gather evidence with possibly-conflicting
 * cross-references, mutating each item in place. One bounded manifest
 * point-read per evidence item (subjectKey + any recorded explicit
 * supersedes target, evidence.length <= the request's maxEvidence cap);
 * anchor extraction and cue matching are local text scans. No-op below two
 * evidence items -- callers that trim a two-or-more item evidence array down
 * to fewer than two beforehand get their stale flags cleared automatically
 * (see below), but the trivial no-op path here can't reach an item to clear.
 * Idempotent and re-runnable on already-flagged evidence: any prior
 * possiblyConflicting value on an item is overwritten (or removed, if this
 * pass finds no conflict for it), so a caller that pools evidence across
 * multiple prior gatherArchive calls (each of which already ran this once
 * against its own smaller set) and then trims can safely call this again
 * over the final pooled set to get cross-set detection and drop any
 * dangling ref that no longer resolves to a surviving item.
 */
export async function flagPossibleConflicts(store, evidence) {
  if (evidence.length < 2) {
    for (const item of evidence) delete item.possiblyConflicting;
    return;
  }
  const manifests = await store.snapshot(async (view) => {
    const map = new Map();
    for (const item of evidence) {
      const manifest = await view.get(
        manifestKeys.document(item.document.documentId, item.document.version),
      );
      map.set(item, manifest);
    }
    return map;
  });
  const descriptors = evidence.map((item) => {
    const manifest = manifests.get(item);
    return {
      ref: item.locator,
      documentId: item.document.documentId,
      version: item.document.version,
      subjectKey: manifest?.subjectKey,
      supersedes: manifest?.supersedes,
      text: item.document.text,
      anchorKeys: strongAnchorKeys(item.document.text),
    };
  });
  const conflicts = detectPossibleConflicts(descriptors);
  for (const item of evidence) {
    const refs = conflicts.get(item.locator);
    if (refs !== undefined && refs.length > 0) {
      item.possiblyConflicting = refs;
    } else {
      delete item.possiblyConflicting;
    }
  }
}

/**
 * Gather a bounded, provenance-preserving evidence packet in one store call.
 * Search discovers stable anchors; traversal expands only their authorized
 * branch neighborhood; recall materializes exact canonical source.
 */
export async function gatherArchive(store, rawRequest, options = {}) {
  if (!store || typeof store.snapshot !== "function") {
    throw new TypeError("gatherArchive requires a RocksStore-compatible store.");
  }
  const request = normalizeRequest(rawRequest, options.project);
  const gatherStartedAt = performance.now();
  const stageDurations = new Map();
  const recordStage = (stage, durationMs) => {
    const duration = Math.max(0, durationMs);
    stageDurations.set(stage, (stageDurations.get(stage) ?? 0) + duration);
    reportStageTiming(options, stage, duration);
  };
  const finishGatherTiming = () => {
    const attributedMs = [...stageDurations.values()]
      .reduce((total, durationMs) => total + durationMs, 0);
    recordStage("gatherOtherMs", Math.max(0, performance.now() - gatherStartedAt - attributedMs));
  };
  const searchStageDurations = new Map();
  const searchStartedAt = performance.now();
  const search = await searchArchive(store, {
    query: request.query,
    ...(request.expansionTerms === undefined ? {} : { expansionTerms: request.expansionTerms }),
    ...(request.workingSet === undefined ? {} : { workingSet: request.workingSet }),
    ...(request.sessionContext === undefined ? {} : { sessionContext: request.sessionContext }),
    relation: null,
    semanticPolicy: "always",
    scope: request.scope,
    sessionIds: request.sessionIds,
    project: request.project,
    limit: request.limit,
    excludeVisibleSourceKeys: request.excludeVisibleSourceKeys,
    hintBudgetTokens: 0,
    ...(request.searchEffort === undefined ? {} : { searchEffort: request.searchEffort }),
  }, {
    ...options,
    recordStageTiming: (stage, durationMs) => {
      const duration = Math.max(0, durationMs);
      searchStageDurations.set(stage, (searchStageDurations.get(stage) ?? 0) + duration);
      recordStage(stage, duration);
    },
    // RM3 expansion additionally requires this explicit-search-only
    // server-side opt-in (options.allowExpansion, src/retrieval/search.js);
    // gather's own internal search call never sets it on the normal path, so
    // RM3 stays off for gather by default exactly as before. searchEffort:
    // "wide" is the caller's own per-call signal that this gather is worth
    // the extra requery, so it also grants the opt-in gather never grants on
    // its own -- shouldTryExpansion's unconditional branch then takes over.
    ...(request.searchEffort === "wide" ? { allowExpansion: true } : {}),
  });
  const measuredSearchMs = [...searchStageDurations.values()]
    .reduce((total, durationMs) => total + durationMs, 0);
  recordStage("searchOtherMs", Math.max(0, performance.now() - searchStartedAt - measuredSearchMs));

  if (search.results.length === 0) {
    finishGatherTiming();
    return assertStoreResult("store.gather", {
      status: "not-found",
      mode: search.mode,
      intent: request.intent,
      anchorCount: 0,
      candidateCount: 0,
      returnedTokens: 0,
      truncated: false,
      hasMore: false,
      evidence: [],
      expiredMatches: search.expiredMatches,
    });
  }

  const candidates = new Map();
  for (let index = 0; index < search.results.length; index += 1) {
    addCandidate(candidates, search.results[index], "anchor", index + 1, 0, request.intent);
  }

  let traversalHasMore = false;
  const traversalStartedAt = performance.now();
  const neighborhoodAnchors = search.results.slice(0, request.neighborhoodAnchors);
  for (let anchorIndex = 0; anchorIndex < neighborhoodAnchors.length; anchorIndex += 1) {
    const anchor = neighborhoodAnchors[anchorIndex];
    const lineage = traversalLineage(request, anchor);
    for (const [direction, limit] of [["before", request.before], ["after", request.after]]) {
      if (limit === 0) continue;
      const traversal = await traverseArchive(store, {
        locator: anchor.locator,
        direction,
        scope: "session",
        sessionIds: lineage,
        limit,
        scanLimit: DEFAULT_SCAN_LIMIT,
      }, { ...options, project: request.project });
      traversalHasMore ||= traversal.hasMore;
      for (let index = 0; index < traversal.results.length; index += 1) {
        addCandidate(
          candidates,
          traversal.results[index],
          direction,
          anchorIndex + 1,
          index + 1,
          request.intent,
        );
      }
    }
  }
  recordStage("traversalMs", performance.now() - traversalStartedAt);

  const orderedCandidates = [...candidates.values()]
    .sort((left, right) => left.priority - right.priority);
  // Dedup is an explicit-gather affordance only (options.dedupe, set by the
  // daemon's store.gather operation), mirroring search.js's opt-in.
  const deduped = options.dedupe === true
    ? await dedupOrderedCandidates(store, orderedCandidates, request.project, options.nearDuplicate ?? {})
    : orderedCandidates;
  const selectableCount = Math.min(
    deduped.length,
    request.maxEvidence,
    Math.max(1, Math.floor(request.maxTokens / MIN_RECALL_TOKENS)),
  );
  const selected = deduped.slice(0, selectableCount);
  const perEvidenceTokens = Math.max(
    MIN_RECALL_TOKENS,
    Math.floor(request.maxTokens / Math.max(1, selected.length)),
  );
  const evidence = [];
  let returnedTokens = 0;
  let recallIncomplete = false;
  const recallStartedAt = performance.now();
  for (const item of selected) {
    const recallSessionIds = [...new Set([
      ...request.sessionIds,
      item.candidate.source.sessionId,
    ])];
    const document = await recallArchive(store, {
      locator: item.candidate.locator,
      neighbors: 1,
      maxTokens: perEvidenceTokens,
      sessionIds: recallSessionIds,
    }, {
      ...options,
      project: request.project,
      sessionIds: recallSessionIds,
      // Each evidence excerpt already has its own slice of the gather's
      // token budget (perEvidenceTokens); widen it symmetrically to spend
      // that budget on real surrounding turns instead of leaving headroom
      // unused past the fixed neighbors:1 window.
      expandToBudget: true,
    });
    if (document.status !== "resolved") {
      recallIncomplete = true;
      continue;
    }
    returnedTokens += document.returnedTokens;
    recallIncomplete ||= document.continuationLocators.length > 0;
    evidence.push({
      relation: item.relation,
      anchorRank: item.anchorRank,
      distance: item.distance,
      locator: item.candidate.locator,
      document,
      ...(item.nearDuplicates > 0 ? { nearDuplicates: item.nearDuplicates } : {}),
      // Traversal-derived before/after neighbors carry a fixed placeholder
      // score (chronological adjacency, not a ranked hit); only the anchor's
      // real search-ranked score is a relevance signal worth surfacing.
      ...(item.relation === "anchor"
        ? {
          score: item.candidate.score,
          retrievalMode: item.candidate.retrievalMode,
          ...(item.candidate.reranked === true ? { reranked: true } : {}),
          ...(item.candidate.workingSetAnchors?.length > 0
            ? { workingSetAnchors: [...item.candidate.workingSetAnchors] }
            : {}),
          ...(item.candidate.sessionContextTerms?.length > 0
            ? { sessionContextTerms: [...item.candidate.sessionContextTerms] }
            : {}),
        }
        : {}),
    });
  }
  recordStage("recallMs", performance.now() - recallStartedAt);
  evidence.sort(chronological);
  const conflictStartedAt = performance.now();
  await flagPossibleConflicts(store, evidence);
  recordStage("conflictMs", performance.now() - conflictStartedAt);

  const candidateOverflow = deduped.length > selected.length;
  const searchMayHaveMore = search.results.length === request.limit;
  const truncated = traversalHasMore || candidateOverflow || recallIncomplete || searchMayHaveMore;
  finishGatherTiming();
  return assertStoreResult("store.gather", {
    status: evidence.length > 0 ? "resolved" : "not-found",
    mode: search.mode,
    intent: request.intent,
    anchorCount: search.results.length,
    candidateCount: orderedCandidates.length,
    returnedTokens,
    truncated,
    hasMore: truncated,
    evidence,
    expiredMatches: search.expiredMatches,
  });
}
