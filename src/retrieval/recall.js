import {
  assertStoreRequest,
  assertStoreResult,
} from "../store/store-contract.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import {
  manifestKeys,
  retiredDocumentStatus,
} from "../rocksdb/manifests.js";
import { findDependentDocuments } from "../rocksdb/dependents.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import { tokenizeWithByteOffsets } from "../rocksdb/windows.js";
import {
  authorizeLocator,
  getOrCreateLocatorSecret,
  LocatorError,
  signLocator,
} from "./locator.js";
import { validateRetrievalLease } from "./leases.js";
import { historicalStalenessLabel, renderRecalledEvidence } from "./render.js";
import { estimateModelVisibleTokens } from "../session/model-token-budget.js";
import { MAX_SESSION_LINEAGE_IDS } from "../store/store-contract.js";

const MAX_FULL_TURN_RECALL_BYTES = 64 * 1_024;
// Safety valve on symmetric span widening: bounds how many additional
// windows a single excerpt can absorb, so a document built from many
// unusually small windows cannot turn one recall into an unbounded scan.
const MAX_SPAN_GROWTH_WINDOWS = 256;

function unresolved(status, reason, claims, dependents) {
  const result = { status, reason };
  if (claims) {
    result.documentId = claims.documentId;
    result.version = claims.documentVersion;
  }
  // Surface-only invalidation cascade (ultracode task #36): only ever
  // attached by the "superseded" call site below, and only when the bounded
  // lookup actually found something.
  if (dependents !== undefined) result.dependents = dependents;
  return assertStoreResult("store.recall", result);
}

function authorizationOptions(options) {
  const project = options.project;
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Recall requires an authorized project boundary.");
  }
  const sessionIds = options.sessionIds ?? (options.sessionId === undefined ? [] : [options.sessionId]);
  if (!Array.isArray(sessionIds)
    || sessionIds.some((sessionId) => typeof sessionId !== "string" || sessionId.length === 0)) {
    throw new TypeError("sessionIds must be an array of non-empty strings.");
  }
  if (new Set(sessionIds).size > MAX_SESSION_LINEAGE_IDS) {
    throw new RangeError(`sessionIds must contain at most ${MAX_SESSION_LINEAGE_IDS} unique IDs.`);
  }
  return Object.freeze({ project, sessionIds: Object.freeze([...new Set(sessionIds)]) });
}

async function readWindow(view, documentId, version, ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
  const window = await view.get(manifestKeys.window(documentId, version, ordinal));
  return window?.ordinal === ordinal ? window : undefined;
}

function supersessionFor(view, claims) {
  return view.scan([
    KEYSPACE.SUPERSESSION,
    claims.documentId,
    claims.documentVersion,
  ], { limit: 1 })[0]?.payload;
}

function tokenCount(text) {
  return tokenizeWithByteOffsets(text).length;
}

function byteBudget(maxTokens) {
  return maxTokens * 4;
}

function fitsRecallBudget(text, maxTokens) {
  return tokenCount(text) <= maxTokens
    && Buffer.byteLength(text, "utf8") <= byteBudget(maxTokens);
}

/**
 * Render-time-only span widening: opt-in per caller (never for the fixed
 * `neighbors` shape an explicit recall request asked for), grows a window
 * range symmetrically around the match, one stored window at a time, while
 * headroom remains in the per-evidence token budget. Growth stays inside the
 * document boundary and never re-shrinks; once a side no longer fits it is
 * marked exhausted so the loop cannot re-attempt a doomed direction.
 */
async function growWindowRange(view, manifest, claims, target, firstWindow, lastWindow, maxTokens) {
  let first = firstWindow;
  let last = lastWindow;
  const budget = byteBudget(maxTokens);
  let leftExhausted = first.ordinal === 0;
  let rightExhausted = false;
  for (let step = 0; step < MAX_SPAN_GROWTH_WINDOWS && (!leftExhausted || !rightExhausted); step += 1) {
    const leftDistance = target.ordinal - first.ordinal;
    const rightDistance = last.ordinal - target.ordinal;
    const growLeft = !leftExhausted && (rightExhausted || leftDistance <= rightDistance);
    if (growLeft) {
      const candidate = await readWindow(view, claims.documentId, claims.documentVersion, first.ordinal - 1);
      if (candidate === undefined || last.endByte - candidate.startByte > budget) {
        leftExhausted = true;
        continue;
      }
      const materialized = await readDocumentRange(view, manifest, candidate.startByte, last.endByte);
      if (!fitsRecallBudget(materialized.text, maxTokens)) {
        leftExhausted = true;
        continue;
      }
      first = candidate;
    } else {
      const candidate = await readWindow(view, claims.documentId, claims.documentVersion, last.ordinal + 1);
      if (candidate === undefined || candidate.endByte - first.startByte > budget) {
        rightExhausted = true;
        continue;
      }
      const materialized = await readDocumentRange(view, manifest, first.startByte, candidate.endByte);
      if (!fitsRecallBudget(materialized.text, maxTokens)) {
        rightExhausted = true;
        continue;
      }
      last = candidate;
    }
  }
  return { first, last };
}

async function selectedWindowRange(
  view,
  manifest,
  claims,
  target,
  neighbors,
  maxTokens,
  kind,
  expandToBudget,
) {
  if (kind === "turn"
    && manifest.byteLength <= MAX_FULL_TURN_RECALL_BYTES
    && manifest.byteLength <= byteBudget(maxTokens)) {
    const materialized = await readDocumentRange(view, manifest, 0, manifest.byteLength);
    if (fitsRecallBudget(materialized.text, maxTokens)) {
      return {
        startByte: 0,
        endByte: manifest.byteLength,
        firstWindow: target,
        lastWindow: target,
        wholeDocument: true,
        materialized,
      };
    }
  }
  const desiredFirst = Math.max(0, target.ordinal - neighbors);
  const desiredLast = target.ordinal + neighbors;
  const windows = [];
  for (let ordinal = desiredFirst; ordinal <= desiredLast; ordinal += 1) {
    const window = await readWindow(view, claims.documentId, claims.documentVersion, ordinal);
    if (window === undefined) {
      if (ordinal <= target.ordinal) return undefined;
      break;
    }
    windows.push(window);
  }
  const targetIndex = windows.findIndex(({ ordinal }) => ordinal === target.ordinal);
  if (targetIndex < 0) return undefined;
  let first = 0;
  let last = windows.length - 1;
  const shrink = () => {
    const leftDistance = targetIndex - first;
    const rightDistance = last - targetIndex;
    if (rightDistance >= leftDistance && last > targetIndex) last -= 1;
    else if (first < targetIndex) first += 1;
  };
  while (first < last
    && windows[last].endByte - windows[first].startByte > byteBudget(maxTokens)) {
    shrink();
  }
  let materialized;
  if (windows[last].endByte - windows[first].startByte <= byteBudget(maxTokens)) {
    materialized = await readDocumentRange(
      view,
      manifest,
      windows[first].startByte,
      windows[last].endByte,
    );
  }
  while (first < last && !fitsRecallBudget(materialized.text, maxTokens)) {
    shrink();
    materialized = await readDocumentRange(
      view,
      manifest,
      windows[first].startByte,
      windows[last].endByte,
    );
  }
  let firstWindow = windows[first];
  let lastWindow = windows[last];
  if (expandToBudget) {
    const grown = await growWindowRange(view, manifest, claims, target, firstWindow, lastWindow, maxTokens);
    if (grown.first !== firstWindow || grown.last !== lastWindow) {
      firstWindow = grown.first;
      lastWindow = grown.last;
      materialized = await readDocumentRange(view, manifest, firstWindow.startByte, lastWindow.endByte);
    }
  }
  return {
    startByte: firstWindow.startByte,
    endByte: lastWindow.endByte,
    firstWindow,
    lastWindow,
    wholeDocument: false,
    materialized,
  };
}

function byteBoundedRange(range, matchRange, maxBytes) {
  if (range.endByte - range.startByte <= maxBytes) return range;
  const clampedMatchStart = Math.max(range.startByte, Math.min(range.endByte, matchRange.startByte));
  const clampedMatchEnd = Math.max(clampedMatchStart, Math.min(range.endByte, matchRange.endByte));
  const anchorStart = clampedMatchStart;
  const anchorEnd = clampedMatchEnd;
  const anchorBytes = anchorEnd - anchorStart;
  let startByte;
  let endByte;

  if (anchorBytes >= maxBytes) {
    startByte = anchorStart;
    endByte = Math.min(range.endByte, startByte + maxBytes);
  } else {
    const spareBytes = maxBytes - anchorBytes;
    const earliestStart = Math.max(range.startByte, anchorEnd - maxBytes);
    const latestStart = anchorStart;
    let desiredStart = anchorStart - Math.floor(spareBytes / 2);
    desiredStart = Math.max(earliestStart, Math.min(latestStart, desiredStart));
    if (desiredStart + maxBytes > range.endByte) {
      desiredStart = Math.max(earliestStart, range.endByte - maxBytes);
    }
    startByte = desiredStart;
    endByte = Math.min(range.endByte, startByte + maxBytes);
    if (endByte < anchorEnd) {
      endByte = anchorEnd;
      startByte = Math.max(range.startByte, endByte - maxBytes);
    }
  }

  if (endByte === startByte && startByte < range.endByte) {
    endByte = Math.min(range.endByte, startByte + maxBytes);
  }
  if (endByte - startByte > maxBytes
    || startByte < range.startByte
    || endByte > range.endByte) {
    throw new Error("Unable to produce a valid UTF-8 recall range within the byte budget.");
  }
  return { startByte, endByte };
}

async function clippedTargetRange(
  view,
  manifest,
  window,
  matchRange,
  maxTokens,
  current,
) {
  let materialized = current;
  if (materialized === undefined
    || materialized.endByte - materialized.startByte > byteBudget(maxTokens)) {
    const bounded = byteBoundedRange(window, matchRange, byteBudget(maxTokens));
    materialized = await readDocumentRange(
      view,
      manifest,
      bounded.startByte,
      bounded.endByte,
      { adjustUtf8: true },
    );
  }
  const tokens = tokenizeWithByteOffsets(materialized.text);
  if (tokens.length > maxTokens) {
    const localMatchStart = Math.max(0, matchRange.startByte - materialized.startByte);
    const localMatchEnd = Math.min(
      materialized.endByte - materialized.startByte,
      matchRange.endByte - materialized.startByte,
    );
    let matchFirst = tokens.findIndex((token) => token.endByte > localMatchStart);
    if (matchFirst < 0) matchFirst = tokens.length - 1;
    let matchLast = tokens.findLastIndex((token) => token.startByte < localMatchEnd);
    if (matchLast < matchFirst) matchLast = matchFirst;
    const matchTokenCount = matchLast - matchFirst + 1;
    if (matchTokenCount > maxTokens) matchLast = matchFirst + maxTokens - 1;
    const selectedMatchTokens = matchLast - matchFirst + 1;
    const spare = Math.max(0, maxTokens - selectedMatchTokens);
    let startIndex = Math.max(0, matchFirst - Math.floor(spare / 2));
    let endIndex = Math.min(tokens.length, startIndex + maxTokens);
    startIndex = Math.max(0, endIndex - maxTokens);
    materialized = await readDocumentRange(
      view,
      manifest,
      materialized.startByte + tokens[startIndex].startByte,
      materialized.startByte + tokens[endIndex - 1].endByte,
    );
  }
  return materialized;
}

function continuationLocator(claims, window, secret, matchRange = undefined) {
  return signLocator({
    ...claims,
    windowOrdinal: window.ordinal,
    matchRange: matchRange ?? { startByte: window.startByte, endByte: window.endByte },
  }, secret);
}

function sourceProvenance(manifest, maxTokens) {
  if (manifest.sourceKeyStatus === "unavailable") {
    return {
      status: "documented-absence",
      reason: "The legacy source did not record original message keys; its internal archive identity is not source provenance.",
    };
  }
  if (Array.isArray(manifest.sourceMessageKeys) && manifest.sourceMessageKeys.length > 0) {
    const allKeys = [...manifest.sourceMessageKeys];
    const budget = byteBudget(maxTokens);
    const complete = { status: "available", keys: allKeys };
    if (Buffer.byteLength(JSON.stringify(complete), "utf8") <= budget) return complete;
    const selected = [];
    for (const key of allKeys) {
      const candidate = {
        status: "available",
        keys: [...selected, key],
        totalKeys: allKeys.length,
        truncated: true,
      };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > budget) break;
      selected.push(key);
    }
    return {
      status: "available",
      keys: selected,
      totalKeys: allKeys.length,
      truncated: true,
    };
  }
  return {
    status: "documented-absence",
    reason: "No source message keys were recorded for this legacy document.",
  };
}

async function recallSnapshot(view, request, options, secret, claims) {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative timestamp.");
  const supersession = supersessionFor(view, claims);
  if (supersession) {
    const status = supersession.status === "superseded" ? "superseded" : "expired";
    let dependents;
    if (status === "superseded") {
      // The target's own canonical record is still readable here even though
      // it is no longer live; recall of a superseded document is exactly the
      // moment a caller learns it was stale, so surface any later document
      // that already shows signs of referencing it (ultracode task #36).
      const manifest = await view.get(manifestKeys.document(claims.documentId, claims.documentVersion));
      if (manifest !== undefined) {
        try {
          // `replacementDocumentId` excludes the deliberate replacement
          // itself from the signals below -- without it, a note-less
          // supersede's default replacement text ("Supersedes
          // <targetId>@<version>.") embeds the target's own documentId,
          // which the exact indexer mines as an anchor citation on the
          // replacement, misreporting it as its own dependent. Best-effort,
          // like the put()/get() paths' own lookups: a fault here (e.g. a
          // legacy manifest failing the target-identity check) must not
          // turn an otherwise-graceful "superseded" recall into an RPC error.
          const found = await findDependentDocuments(view, {
            documentId: manifest.documentId,
            version: manifest.version,
            project: manifest.project,
            sessionId: manifest.sessionId,
            createdAt: manifest.createdAt,
            subjectKey: manifest.subjectKey,
            sourceMessageKeys: manifest.sourceMessageKeys,
          }, { replacementDocumentId: supersession.replacementDocumentId });
          if (found.count > 0) dependents = found;
        } catch (error) {
          options.recordBackgroundError?.(error);
        }
      }
    }
    return unresolved(
      status,
      supersession.reason ?? `The archived version is ${supersession.status}.`,
      claims,
      dependents,
    );
  }
  const history = await view.get(manifestKeys.documentHistory(claims.documentId));
  const retired = history?.project === claims.project
    ? retiredDocumentStatus(history, claims.documentVersion)
    : undefined;
  if (retired !== undefined) {
    return unresolved(retired.status, retired.reason, claims);
  }
  if (now >= claims.expiresAt) {
    return unresolved("lease-expired", "The retrieval locator has expired.", claims);
  }
  const lease = await validateRetrievalLease(view, {
    leaseId: claims.leaseId,
    documentId: claims.documentId,
    documentVersion: claims.documentVersion,
    now,
  });
  if (lease.status !== "active") {
    return unresolved("lease-expired", `The retrieval lease is ${lease.status}.`, claims);
  }

  const manifest = await view.get(manifestKeys.document(claims.documentId, claims.documentVersion));
  if (manifest === undefined) {
    return unresolved("missing", "The exact archived document version is unavailable.", claims);
  }
  if (manifest.project !== claims.project || manifest.sessionId !== claims.sessionId) {
    return unresolved("locator-invalid", "The locator source identity does not match the canonical manifest.", claims);
  }
  const target = await readWindow(
    view,
    claims.documentId,
    claims.documentVersion,
    claims.windowOrdinal,
  );
  if (!target || target.ordinal !== claims.windowOrdinal
    || claims.matchRange.startByte < target.startByte
    || claims.matchRange.endByte > target.endByte) {
    return unresolved("locator-invalid", "The locator window or match coordinates are invalid.", claims);
  }
  const selected = await selectedWindowRange(
    view,
    manifest,
    claims,
    target,
    request.neighbors,
    request.maxTokens,
    manifest.kind,
    options.expandToBudget === true,
  );
  if (selected === undefined) {
    return unresolved("locator-invalid", "The locator window neighborhood is incomplete.", claims);
  }
  let materialized = selected.materialized;
  if (!selected.wholeDocument
    && selected.firstWindow.ordinal === selected.lastWindow.ordinal
    && (materialized === undefined
      || !fitsRecallBudget(materialized.text, request.maxTokens))) {
    materialized = await clippedTargetRange(
      view,
      manifest,
      target,
      claims.matchRange,
      request.maxTokens,
      materialized,
    );
  }
  if (materialized === undefined) {
    throw new Error("Recall range selection did not materialize a bounded source range.");
  }
  const { startByte, endByte, chunks, text: recalledText } = materialized;
  const continuationLocators = [];
  if (startByte > target.startByte) {
    continuationLocators.push(continuationLocator(claims, target, secret, {
      startByte: target.startByte,
      endByte: startByte,
    }));
  } else if (!selected.wholeDocument && selected.firstWindow.ordinal > 0) {
    const window = await readWindow(
      view,
      claims.documentId,
      claims.documentVersion,
      selected.firstWindow.ordinal - 1,
    );
    if (window !== undefined) continuationLocators.push(continuationLocator(claims, window, secret));
  }
  if (endByte < target.endByte) {
    continuationLocators.push(continuationLocator(claims, target, secret, {
      startByte: endByte,
      endByte: target.endByte,
    }));
  } else if (!selected.wholeDocument) {
    const window = await readWindow(
      view,
      claims.documentId,
      claims.documentVersion,
      selected.lastWindow.ordinal + 1,
    );
    if (window !== undefined) continuationLocators.push(continuationLocator(claims, window, secret));
  }
  if (!fitsRecallBudget(recalledText, request.maxTokens)) {
    throw new Error("Recalled source exceeds its requested token or UTF-8 byte budget.");
  }
  const response = {
    status: "resolved",
    documentId: manifest.documentId,
    version: manifest.version,
    kind: manifest.kind,
    sessionId: manifest.sessionId,
    project: manifest.project,
    createdAt: manifest.createdAt,
    historical: true,
    stalenessLabel: historicalStalenessLabel(manifest.createdAt),
    sourceMessages: sourceProvenance(manifest, request.maxTokens),
    chunks,
    text: recalledText,
    continuationLocators,
    maxTokens: request.maxTokens,
  };
  const renderedText = renderRecalledEvidence(response, request.maxTokens, {
    focusStartByte: Math.max(0, claims.matchRange.startByte - startByte),
    focusEndByte: Math.max(0, claims.matchRange.endByte - startByte),
    format: options.renderFormat,
  });
  return assertStoreResult("store.recall", {
    ...response,
    renderedText,
    returnedTokens: estimateModelVisibleTokens(renderedText),
  });
}

/** Materialize exact canonical source around one authenticated search result. */
export async function recallArchive(store, request, options = {}) {
  if (!store || typeof store.snapshot !== "function") {
    throw new TypeError("recallArchive requires a RocksStore-compatible snapshot method.");
  }
  assertStoreRequest("store.recall", request);
  const authorization = authorizationOptions(options);
  const secret = await getOrCreateLocatorSecret(store, {
    secret: options.secret,
    now: options.now,
  });
  let claims;
  try {
    claims = authorizeLocator(request.locator, secret, authorization);
  } catch (error) {
    if (!(error instanceof LocatorError)) throw error;
    return unresolved("locator-invalid", error.message);
  }
  return store.snapshot((view) => recallSnapshot(view, request, options, secret, claims));
}
