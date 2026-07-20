import { createHash } from "node:crypto";
import { KEYSPACE } from "../rocksdb/keys.js";
import { assertStoreResult } from "../store-contract.js";

/**
 * Local implicit relevance feedback: the machine's own click log. Each served
 * search records which results were shown (rank, retrieval mode, calibrated and
 * raw scores, and an opaque locator fingerprint); each later recall of a shown
 * locator joins back to that search event by fingerprint. Only ids, scores, and
 * the query string are stored — never archived content. The log never leaves the
 * machine and is not an index: retrieval never reads it, so it does not
 * participate in derived-index generation or replay.
 *
 * A schema change gets a fresh namespace so old-format records age out through
 * the bounded ring instead of being misread under the new format.
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
    return { joined: true };
  });
}

function accumulate(map, key, recalled) {
  const bucket = map.get(key) ?? { shown: 0, recalled: 0 };
  bucket.shown += 1;
  if (recalled) bucket.recalled += 1;
  map.set(key, bucket);
}

/**
 * Read API: shown-vs-recalled stats for this project, per query and broken down
 * by retrieval mode and rank — the signal for evaluating ranking against real
 * usage instead of only fixtures.
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
  // Reverse (newest-first): if a writer's maxEvents ever exceeds this read
  // limit, bound the read to the most recent events rather than the oldest.
  for (const { payload: event } of store.iterate(feedbackKeys.eventPrefix(project), {
    limit: MAX_FEEDBACK_EVENTS_PER_PROJECT,
    fillCache: false,
    reverse: true,
  })) {
    events += 1;
    // Only a "resolved" recall is positive relevance signal: a lease-expired or
    // locator-invalid recall reached this locator but did not actually retrieve it.
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
  return assertStoreResult("feedback.stats", {
    events,
    shownTotal,
    recalledTotal,
    byMode,
    byRank,
    queries,
  });
}
