import { createHash } from "node:crypto";
import { keyFor, KEYSPACE } from "../rocksdb/keys.js";
import { assertStoreResult } from "../store/store-contract.js";

/**
 * Local implicit relevance feedback: the machine's own click log. Each served
 * search records which results were shown (rank, retrieval mode, calibrated and
 * raw scores, and an opaque locator fingerprint) and the session ids that
 * authorized it; each later recall of a shown locator joins back to that
 * search event by fingerprint. Only ids, scores, session ids, and the query
 * string are stored — never archived content. The log never leaves
 * the machine and the raw event ring is not itself an index: retrieval never
 * reads shown/recalls events, so they do not participate in derived-index
 * generation or replay.
 *
 * The one exception is a per-document recall counter (see
 * recallCounterName/documentRecallCount below), incremented on each resolved
 * recall of a shown locator. Unlike the bounded event ring it evicts, it never
 * does, so the importance batch job (src/rocksdb/index/importance.js) can read
 * a document's all-time recalled-after-search tally in O(1) instead of
 * rescanning history. It is a plain local counter, not a model or network
 * call, so it stays within the write-path's no-model-calls constraint.
 *
 * A schema change gets a fresh namespace so old-format records age out through
 * the bounded ring instead of being misread under the new format. Exception:
 * adding `sessionIds` did not bump this version, because it is read as
 * `event.sessionIds ?? []` — an old-format event without the field simply
 * fails closed out of chain detection (see detectReformulationChains) rather
 * than being misread, so the fresh-namespace requirement is moot for it.
 */
export const RELEVANCE_FEEDBACK_VERSION = 1;

// Bounded retention: a per-project ring keeps the most recent search events.
// Writing event N evicts event N - MAX (sequences are gapless), so the log and
// its locator index stay bounded without a background sweeper.
export const MAX_FEEDBACK_EVENTS_PER_PROJECT = 2_000;

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 1_000;
const MAX_QUERY_STORED_CHARS = 512;
const MAX_SHOWN_PER_EVENT = 100;

const ROOT = Object.freeze([KEYSPACE.FEEDBACK, RELEVANCE_FEEDBACK_VERSION]);

function requireStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.transaction !== "function") {
    throw new TypeError("Relevance feedback requires a writable RocksStore-compatible store.");
  }
  return store;
}

function requireProject(project) {
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Relevance feedback requires a project boundary.");
  }
  return project;
}

function requireTimestamp(now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Relevance feedback timestamps must be non-negative safe integers.");
  }
  return now;
}

export const feedbackKeys = Object.freeze({
  counterName(project) {
    return `relevance-feedback:v${RELEVANCE_FEEDBACK_VERSION}:${project}`;
  },
  eventPrefix(project) {
    return [...ROOT, requireProject(project), "event"];
  },
  event(project, seq) {
    return [...this.eventPrefix(project), seq];
  },
  locator(project, fingerprint) {
    return [...ROOT, requireProject(project), "locator", fingerprint];
  },
});

/** Durable (non-evicting) per-document recall tally name; see documentRecallCount. */
export function recallCounterName(project, documentId, version) {
  return `relevance-feedback-recall:v${RELEVANCE_FEEDBACK_VERSION}:${requireProject(project)}:${documentId}:${version}`;
}

/** Opaque, content-free join key. Each shown locator is unique (fresh lease). */
export function locatorFingerprint(locator) {
  return createHash("sha256").update(String(locator ?? "")).digest("hex");
}

function normalizeQueryKey(query) {
  return String(query ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase()
    .slice(0, MAX_QUERY_STORED_CHARS);
}

function storedQuery(query) {
  return String(query ?? "").slice(0, MAX_QUERY_STORED_CHARS);
}

// Session ids are recorded only to bound reformulation-chain analysis to a
// single conversation; an event with none never links across sessions.
function normalizeSessionIds(sessionIds) {
  const list = Array.isArray(sessionIds) ? sessionIds : [];
  return [...new Set(list.filter((id) => typeof id === "string" && id.length > 0))];
}

function shownEntries(results) {
  const list = Array.isArray(results) ? results : [];
  return list.slice(0, MAX_SHOWN_PER_EVENT)
    .filter((result) => typeof result?.locator === "string" && result.locator.length > 0)
    .map((result, rank) => ({
      rank,
      documentId: result.documentId,
      version: result.version,
      retrievalMode: result.retrievalMode,
      score: typeof result.calibratedScore === "number" ? result.calibratedScore : result.score,
      rawScore: result.rawScore,
      locatorFingerprint: locatorFingerprint(result.locator),
    }));
}

/**
 * Log one served search: the query and its shown results. The event, its
 * locator index entries, and the eviction of the oldest event commit together.
 */
export async function recordShownResults(store, {
  project,
  query,
  mode,
  status,
  results,
  sessionIds,
  now = Date.now(),
  maxEvents = MAX_FEEDBACK_EVENTS_PER_PROJECT,
} = {}) {
  requireStore(store);
  requireProject(project);
  requireTimestamp(now);
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
    throw new TypeError("maxEvents must be a positive safe integer.");
  }
  const shown = shownEntries(results);
  const seq = await store.transaction(async (tx) => {
    const sequence = await tx.increment(feedbackKeys.counterName(project));
    await tx.put(feedbackKeys.event(project, sequence), {
      feedbackVersion: RELEVANCE_FEEDBACK_VERSION,
      seq: sequence,
      project,
      query: storedQuery(query),
      queryKey: normalizeQueryKey(query),
      mode: typeof mode === "string" ? mode : null,
      status: typeof status === "string" ? status : null,
      createdAt: now,
      shownCount: shown.length,
      shown,
      recalls: [],
      sessionIds: normalizeSessionIds(sessionIds),
    }, { kind: "relevance-feedback-event" });
    for (const entry of shown) {
      await tx.put(feedbackKeys.locator(project, entry.locatorFingerprint), {
        seq: sequence,
        rank: entry.rank,
      }, { kind: "relevance-feedback-locator" });
    }
    const evictSeq = sequence - maxEvents;
    if (evictSeq >= 1) {
      const stale = await tx.get(feedbackKeys.event(project, evictSeq));
      if (stale !== undefined) {
        for (const entry of stale.shown ?? []) {
          if (entry.locatorFingerprint) {
            await tx.remove(feedbackKeys.locator(project, entry.locatorFingerprint));
          }
        }
        await tx.remove(feedbackKeys.event(project, evictSeq));
      }
    }
    return sequence;
  });
  return { seq, shown: shown.length };
}

/**
 * Join a recall back to the search that showed its locator. A locator never
 * shown (or already evicted) is a no-op, so isolation holds: only fingerprints
 * this project logged are ever marked recalled.
 */
export async function recordRecalledLocator(store, {
  project,
  locator,
  status,
  now = Date.now(),
} = {}) {
  requireStore(store);
  requireProject(project);
  requireTimestamp(now);
  const fingerprint = locatorFingerprint(locator);
  // Avoid taking a write lease for the common recall of a non-shown locator
  // (for example a recall-issued continuation locator).
  if (await store.get(feedbackKeys.locator(project, fingerprint)) === undefined) {
    return { joined: false };
  }
  return store.transaction(async (tx) => {
    const index = await tx.get(feedbackKeys.locator(project, fingerprint));
    if (index === undefined) return { joined: false };
    const eventKey = feedbackKeys.event(project, index.seq);
    const event = await tx.get(eventKey);
    if (event === undefined) return { joined: false };
    const recalls = event.recalls ?? [];
    if (recalls.some((recall) => recall.locatorFingerprint === fingerprint)) {
      return { joined: true, alreadyRecorded: true };
    }
    await tx.put(eventKey, {
      ...event,
      recalls: [
        ...recalls,
        {
          locatorFingerprint: fingerprint,
          recalledAt: now,
          status: typeof status === "string" ? status : null,
        },
      ],
    }, { kind: "relevance-feedback-event" });
    // Only a "resolved" recall is positive relevance signal (see
    // relevanceFeedbackStats); tally it against the shown document so the
    // importance batch job can read a per-document recall count in O(1).
    if (status === "resolved") {
      const shownEntry = (event.shown ?? []).find(
        (entry) => entry.locatorFingerprint === fingerprint,
      );
      if (shownEntry !== undefined) {
        await tx.increment(recallCounterName(project, shownEntry.documentId, shownEntry.version));
      }
    }
    return { joined: true };
  });
}

/**
 * Read the durable recalled-after-search tally for one document version.
 * Returns 0 when no recall has ever been recorded. This is the only feedback
 * signal retrieval-adjacent code reads; the raw event ring stays write-only.
 */
export async function documentRecallCount(view, { project, documentId, version } = {}) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("documentRecallCount requires a store or snapshot view.");
  }
  requireProject(project);
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new TypeError("documentRecallCount requires a documentId.");
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError("documentRecallCount requires a positive version.");
  }
  const value = await view.get(keyFor.counter(recallCounterName(project, documentId, version)));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function accumulate(map, key, recalled) {
  const bucket = map.get(key) ?? { shown: 0, recalled: 0 };
  bucket.shown += 1;
  if (recalled) bucket.recalled += 1;
  map.set(key, bucket);
}

function resolvedRecallCount(event) {
  // Only a "resolved" recall is positive relevance signal: a lease-expired or
  // locator-invalid recall reached this locator but did not actually retrieve it.
  return (event.recalls ?? []).filter((recall) => recall.status === "resolved").length;
}

/**
 * Below-the-fold misses never generate a shown/fingerprinted candidate, so
 * they cannot be measured directly the way rank-4+ within-page precision can.
 * The only observable proxy is a reformulation chain: a zero-recall search
 * (something was shown but nothing was actually recalled) followed, later in
 * the same session, by a *differently worded* search that did resolve a
 * recall — the miss's below-the-fold candidate never surfaced, but rewording
 * found it another way. A same-queryKey retry that eventually resolves is
 * excluded: that is the miss search itself succeeding, not a reformulation.
 *
 * Chains are scoped to sessions the writer recorded on the event
 * (`sessionIds`); an event that recorded none can never participate, so a
 * missing session id fails closed instead of silently linking across
 * sessions.
 */
// A miss recorded under sessionIds [A, B] is one event, open under both ids.
// A hit that shares only A resolves that same miss, so it must close under B
// too -- otherwise a later hit sharing only B would re-resolve the identical
// miss under a different hitSeq, inflating chainCount past one chain per
// miss (and chainRate past the normalizedScore max of 1). Close by seq match
// so an unrelated miss that happens to reuse the same queryKey in session B
// is left alone.
function closeMissEverywhere(openMissesBySession, miss) {
  for (const linkedSessionId of miss.sessionIds) {
    const linkedOpenMisses = openMissesBySession.get(linkedSessionId);
    if (linkedOpenMisses?.get(miss.queryKey)?.seq === miss.seq) {
      linkedOpenMisses.delete(miss.queryKey);
    }
  }
}

function detectReformulationChains(eventsChronological, limit) {
  const chains = [];
  // A real search carries a multi-id session lineage (resumed/forked sessions
  // report every ancestor id), so the same miss->hit pair is reachable once
  // per shared id below. Dedupe by the underlying event pair, not per id, or
  // a shared N-id lineage would count one reformulation N times.
  const seenChainKeys = new Set();
  const involvedQueryKeys = new Set();
  // sessionId -> Map(queryKey -> { queryKey, seq, sessionIds }) of open,
  // unresolved misses awaiting a later, differently-worded search in that
  // same session lineage.
  const openMissesBySession = new Map();
  for (const event of eventsChronological) {
    const shown = event.shown ?? [];
    if (shown.length === 0) continue; // nothing below the fold to miss
    const queryKey = event.queryKey ?? "";
    const isHit = resolvedRecallCount(event) > 0;
    const eventSessionIds = event.sessionIds ?? [];
    const missRecord = { queryKey, seq: event.seq, sessionIds: eventSessionIds };
    for (const sessionId of eventSessionIds) {
      const openMisses = openMissesBySession.get(sessionId) ?? new Map();
      if (isHit) {
        for (const [missQueryKey, miss] of openMisses) {
          if (missQueryKey === queryKey) continue; // same-query retry, not a chain
          const chainKey = `${miss.seq}:${event.seq}`;
          if (!seenChainKeys.has(chainKey)) {
            seenChainKeys.add(chainKey);
            chains.push({
              sessionId,
              missQueryKey,
              missSeq: miss.seq,
              hitQueryKey: queryKey,
              hitSeq: event.seq,
            });
            involvedQueryKeys.add(missQueryKey);
            involvedQueryKeys.add(queryKey);
          }
          closeMissEverywhere(openMissesBySession, miss);
        }
        // This search itself resolved, so it is not left open as a miss either.
        const selfMiss = openMisses.get(queryKey);
        if (selfMiss !== undefined) closeMissEverywhere(openMissesBySession, selfMiss);
      } else {
        openMisses.set(queryKey, missRecord);
      }
      openMissesBySession.set(sessionId, openMisses);
    }
  }
  return {
    chainCount: chains.length,
    chains: chains.slice(0, limit),
    chainQueryKeys: [...involvedQueryKeys].slice(0, limit),
  };
}

/**
 * Read API: shown-vs-recalled stats for this project, per query and broken down
 * by retrieval mode and rank — the signal for evaluating ranking against real
 * usage instead of only fixtures. Also reports reformulation chains, the proxy
 * signal for below-the-fold misses (see detectReformulationChains).
 */
export async function relevanceFeedbackStats(store, { project, queryLimit } = {}) {
  requireStore(store);
  requireProject(project);
  const limit = Number.isSafeInteger(queryLimit)
    ? Math.min(MAX_QUERY_LIMIT, Math.max(1, queryLimit))
    : DEFAULT_QUERY_LIMIT;
  let events = 0;
  let shownTotal = 0;
  let recalledTotal = 0;
  const byModeMap = new Map();
  const byRankMap = new Map();
  const queryMap = new Map();
  const eventsNewestFirst = [];
  // Reverse (newest-first): if a writer's maxEvents ever exceeds this read
  // limit, bound the read to the most recent events rather than the oldest.
  for (const { payload: event } of store.iterate(feedbackKeys.eventPrefix(project), {
    limit: MAX_FEEDBACK_EVENTS_PER_PROJECT,
    fillCache: false,
    reverse: true,
  })) {
    events += 1;
    eventsNewestFirst.push(event);
    const recalledFingerprints = new Set(
      (event.recalls ?? [])
        .filter((recall) => recall.status === "resolved")
        .map((recall) => recall.locatorFingerprint),
    );
    const queryKey = event.queryKey ?? "";
    const query = queryMap.get(queryKey)
      ?? { query: event.query ?? "", searches: 0, shown: 0, recalled: 0 };
    query.searches += 1;
    for (const entry of event.shown ?? []) {
      const recalled = recalledFingerprints.has(entry.locatorFingerprint);
      shownTotal += 1;
      query.shown += 1;
      if (recalled) {
        recalledTotal += 1;
        query.recalled += 1;
      }
      if (typeof entry.retrievalMode === "string") {
        accumulate(byModeMap, entry.retrievalMode, recalled);
      }
      if (Number.isSafeInteger(entry.rank)) accumulate(byRankMap, entry.rank, recalled);
    }
    queryMap.set(queryKey, query);
  }
  const byMode = {};
  for (const [mode, bucket] of byModeMap) byMode[mode] = bucket;
  const byRank = [...byRankMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rank, bucket]) => ({ rank, ...bucket }));
  const queries = [...queryMap.values()]
    .sort((left, right) => right.searches - left.searches
      || right.recalled - left.recalled
      || right.shown - left.shown)
    .slice(0, limit);
  // Chain detection needs chronological (oldest-first) order to tell an
  // earlier miss from the later search that resolves it.
  const { chainCount, chains, chainQueryKeys } = detectReformulationChains(
    [...eventsNewestFirst].reverse(),
    limit,
  );
  return assertStoreResult("feedback.stats", {
    events,
    shownTotal,
    recalledTotal,
    byMode,
    byRank,
    queries,
    chainCount,
    chainRate: events > 0 ? chainCount / events : 0,
    chains,
    chainQueryKeys,
  });
}
