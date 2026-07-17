import { createHash } from "node:crypto";
import { KEYSPACE } from "../rocksdb/keys.js";
import { stableJson } from "../rocksdb/schema.js";
import { estimateModelVisibleTokens } from "../model-token-budget.js";
import { leaseKeys, releaseLeaseFromView } from "./leases.js";

export const HINT_FORMAT_VERSION = 1;
export const DEFAULT_ACTIVE_HINT_BUDGET_TOKENS = 640;
export const DEFAULT_HINT_SOURCE_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
// Compatibility export for callers that have not moved to active-context
// accounting. New preflight decisions never reset this budget by epoch.
export const DEFAULT_EPOCH_HINT_BUDGET_TOKENS = DEFAULT_ACTIVE_HINT_BUDGET_TOKENS;
export const DEFAULT_ABANDONED_HINT_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1_000;

const ROOT = Object.freeze([KEYSPACE.META, "retrieval-hint"]);

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

export const hintKeys = Object.freeze({
  message(project, sessionId, messageKey) {
    return [
      ...ROOT,
      "message",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(messageKey, "messageKey"),
    ];
  },
  activity(project, sessionId) {
    return [
      ...ROOT,
      "activity",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
    ];
  },
  abandonment(checkAt, project, sessionId, messageKey) {
    return [
      ...ROOT,
      "abandonment",
      nonNegativeInteger(checkAt, "checkAt"),
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(messageKey, "messageKey"),
    ];
  },
  abandonmentPrefix() {
    return [...ROOT, "abandonment"];
  },
  abandonmentPointer(project, sessionId, messageKey) {
    return [
      ...ROOT,
      "abandonment-pointer",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(messageKey, "messageKey"),
    ];
  },
  epoch(project, sessionId, epochId, messageKey) {
    return [
      ...ROOT,
      "epoch",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(epochId, "epochId"),
      identifier(messageKey, "messageKey"),
    ];
  },
  epochPrefix(project, sessionId, epochId) {
    return [
      ...ROOT,
      "epoch",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(epochId, "epochId"),
    ];
  },
  source(project, sessionId, documentId, version, messageKey) {
    return [
      ...ROOT,
      "source",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(documentId, "documentId"),
      nonNegativeInteger(version, "version"),
      identifier(messageKey, "messageKey"),
    ];
  },
  sourcePrefix(project, sessionId, documentId, version) {
    return [
      ...ROOT,
      "source",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(documentId, "documentId"),
      nonNegativeInteger(version, "version"),
    ];
  },
  exposure(project, sessionId, documentId, version) {
    return [
      ...ROOT,
      "exposure",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(documentId, "documentId"),
      nonNegativeInteger(version, "version"),
    ];
  },
  exposureExpiry(expiresAt, project, sessionId, documentId, version) {
    return [
      ...ROOT,
      "exposure-expiry",
      nonNegativeInteger(expiresAt, "expiresAt"),
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(documentId, "documentId"),
      nonNegativeInteger(version, "version"),
    ];
  },
  exposureExpiryPrefix() {
    return [...ROOT, "exposure-expiry"];
  },
});

function abandonmentDeadline(now, inactivityMs) {
  nonNegativeInteger(now, "now");
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs <= 0
    || now > Number.MAX_SAFE_INTEGER - inactivityMs) {
    throw new TypeError("inactivityMs must be a positive safe duration without timestamp overflow.");
  }
  return now + inactivityMs;
}

export function hintQueryHash(request) {
  // The record key already scopes project and session. Only stable user-input
  // identity belongs in this guard: visibility, scope, budgets, and index state
  // may change later, but a frozen provider prefix must not.
  return createHash("sha256").update(stableJson({
    messageKey: request.messageKey,
    message: request.message,
  })).digest("hex");
}

/** Conservative deterministic accounting for exact model-visible hint bytes. */
export function estimateHintTokens(text) {
  return estimateModelVisibleTokens(text);
}

export function frozenHintResponse(record) {
  return Object.freeze({
    modelVisibleText: record.modelVisibleText,
    hints: Object.freeze(record.hints.map((hint) => Object.freeze({ ...hint }))),
  });
}

export async function readFrozenHint(view, { project, sessionId, messageKey } = {}) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("readFrozenHint requires a RocksStore-compatible read view.");
  }
  return view.get(hintKeys.message(project, sessionId, messageKey));
}

/** Mark a session active without changing any frozen hint bytes. */
export async function touchFrozenHintSession(store, {
  project,
  sessionId,
  now = Date.now(),
  inactivityMs = DEFAULT_ABANDONED_HINT_INACTIVITY_MS,
} = {}) {
  if (!store || typeof store.transaction !== "function") {
    throw new TypeError("touchFrozenHintSession requires a writable RocksStore-compatible store.");
  }
  const key = hintKeys.activity(project, sessionId);
  const abandonAfter = abandonmentDeadline(now, inactivityMs);
  await store.get(key);
  return store.transaction(async (transaction) => {
    const existing = await transaction.get(key);
    const lastSeen = Math.max(existing?.lastSeen ?? 0, now);
    const effectiveAbandonAfter = abandonmentDeadline(lastSeen, inactivityMs);
    const activity = {
      project,
      sessionId,
      lastSeen,
      abandonAfter: effectiveAbandonAfter,
      hintCount: existing?.hintCount ?? 0,
    };
    await transaction.put(key, activity, { kind: "retrieval-hint-activity" });
    return activity;
  });
}

export function epochHintTokens(view, { project, sessionId, epochId } = {}) {
  if (!view || typeof view.scan !== "function") {
    throw new TypeError("epochHintTokens requires a RocksStore-compatible read view.");
  }
  let total = 0;
  let after;
  for (;;) {
    const page = view.scan(hintKeys.epochPrefix(project, sessionId, epochId), {
      limit: 100_000,
      ...(after === undefined ? {} : { after }),
    });
    for (const { payload } of page) total += payload?.tokenCount ?? 0;
    if (page.length < 100_000) return total;
    after = page.at(-1).keyBytes;
  }
}

/** Sum frozen model-visible hints for the exact user messages still in context. */
export async function activeHintTokens(view, {
  project,
  sessionId,
  messageKeys,
} = {}) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("activeHintTokens requires a RocksStore-compatible read view.");
  }
  if (!Array.isArray(messageKeys)) throw new TypeError("messageKeys must be an array.");
  let total = 0;
  for (const messageKey of new Set(messageKeys)) {
    const record = await view.get(hintKeys.message(project, sessionId, messageKey));
    total += record?.tokenCount ?? 0;
  }
  return total;
}

export async function previouslySurfaced(view, {
  project,
  sessionId,
  documentId,
  version,
  now,
  cooldownMs,
} = {}) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("previouslySurfaced requires a RocksStore-compatible read view.");
  }
  const currentTime = nonNegativeInteger(now, "now");
  const duration = nonNegativeInteger(cooldownMs, "cooldownMs");
  if (duration === 0) return false;
  const threshold = currentTime - Math.min(currentTime, duration);
  const exposure = await view.get(hintKeys.exposure(
    project,
    sessionId,
    documentId,
    version,
  ));
  return exposure?.surfacedAt > threshold;
}

/** Persist the exact selected bytes and secondary budget/suppression indexes. */
export async function persistFrozenHint(store, record, options = {}) {
  if (!store || typeof store.get !== "function" || typeof store.transaction !== "function") {
    throw new TypeError("persistFrozenHint requires a writable RocksStore-compatible store.");
  }
  if (options.validateBeforeWrite !== undefined
    && typeof options.validateBeforeWrite !== "function") {
    throw new TypeError("validateBeforeWrite must be a function when provided.");
  }
  if (options.exposureSessionIds !== undefined && !Array.isArray(options.exposureSessionIds)) {
    throw new TypeError("exposureSessionIds must be an array when provided.");
  }
  const exposureSessionIds = [...new Set([
    record.sessionId,
    ...(options.exposureSessionIds ?? []),
  ])];
  if (exposureSessionIds.some((sessionId) => typeof sessionId !== "string" || sessionId.length === 0)) {
    throw new TypeError("exposureSessionIds must contain only non-empty strings.");
  }
  const exposureCooldownMs = nonNegativeInteger(
    options.exposureCooldownMs ?? DEFAULT_HINT_SOURCE_COOLDOWN_MS,
    "exposureCooldownMs",
  );
  const messageKey = hintKeys.message(record.project, record.sessionId, record.messageKey);
  const activityKey = hintKeys.activity(record.project, record.sessionId);
  const checkAt = abandonmentDeadline(
    record.createdAt,
    options.inactivityMs ?? DEFAULT_ABANDONED_HINT_INACTIVITY_MS,
  );
  const checkKey = hintKeys.abandonment(
    checkAt,
    record.project,
    record.sessionId,
    record.messageKey,
  );
  const pointerKey = hintKeys.abandonmentPointer(
    record.project,
    record.sessionId,
    record.messageKey,
  );
  await store.get(messageKey);
  await store.get(activityKey);
  await store.get(checkKey);
  await store.get(pointerKey);
  if (record.documentId !== null) {
    await store.get(hintKeys.source(
      record.project,
      record.sessionId,
      record.documentId,
      record.documentVersion,
      record.messageKey,
    ));
    for (const sessionId of exposureSessionIds) {
      await store.get(hintKeys.exposure(
        record.project,
        sessionId,
        record.documentId,
        record.documentVersion,
      ));
    }
  }
  return store.transaction(async (transaction) => {
    const existing = await transaction.get(messageKey);
    if (existing !== undefined) {
      if (existing.queryHash !== record.queryHash) {
        throw new Error(`Hint message key ${record.messageKey} was reused for different input.`);
      }
      return existing;
    }
    let effectiveRecord = record;
    if (record.documentId !== null && options.validateBeforeWrite !== undefined) {
      const suppressionReason = await options.validateBeforeWrite(transaction, record);
      if (suppressionReason !== undefined) {
        if (typeof suppressionReason !== "string" || suppressionReason.length === 0) {
          throw new TypeError("validateBeforeWrite must return undefined or a non-empty suppression reason.");
        }
        effectiveRecord = Object.freeze({
          ...record,
          outcome: "suppress",
          reason: suppressionReason,
          documentId: null,
          documentVersion: null,
          leaseId: null,
          locator: null,
          modelVisibleText: "",
          tokenCount: 0,
          hints: Object.freeze([]),
        });
      }
    }
    await transaction.putImmutable(messageKey, effectiveRecord, { kind: "retrieval-hint" });
    if (effectiveRecord.tokenCount > 0) {
      await transaction.putImmutable(
        hintKeys.epoch(
          effectiveRecord.project,
          effectiveRecord.sessionId,
          effectiveRecord.epochId,
          effectiveRecord.messageKey,
        ),
        { messageKey: effectiveRecord.messageKey, tokenCount: effectiveRecord.tokenCount },
        { kind: "retrieval-hint-epoch" },
      );
    }
    if (effectiveRecord.documentId !== null) {
      await transaction.putImmutable(hintKeys.source(
        effectiveRecord.project,
        effectiveRecord.sessionId,
        effectiveRecord.documentId,
        effectiveRecord.documentVersion,
        effectiveRecord.messageKey,
      ), {
        messageKey: effectiveRecord.messageKey,
      }, { kind: "retrieval-hint-source" });
      if (exposureCooldownMs > 0) {
        for (const sessionId of exposureSessionIds) {
          const exposureKey = hintKeys.exposure(
            effectiveRecord.project,
            sessionId,
            effectiveRecord.documentId,
            effectiveRecord.documentVersion,
          );
          const exposure = await transaction.get(exposureKey);
          if (exposure?.expiresAt !== undefined) {
            await transaction.remove(hintKeys.exposureExpiry(
              exposure.expiresAt,
              effectiveRecord.project,
              sessionId,
              effectiveRecord.documentId,
              effectiveRecord.documentVersion,
            ));
          }
          const surfacedAt = Math.max(exposure?.surfacedAt ?? 0, effectiveRecord.createdAt);
          if (surfacedAt > Number.MAX_SAFE_INTEGER - exposureCooldownMs) {
            throw new TypeError("exposureCooldownMs overflows the exposure expiry timestamp.");
          }
          const expiresAt = surfacedAt + exposureCooldownMs;
          await transaction.put(exposureKey, {
            documentId: effectiveRecord.documentId,
            documentVersion: effectiveRecord.documentVersion,
            surfacedAt,
            expiresAt,
          }, { kind: "retrieval-hint-exposure" });
          await transaction.putImmutable(hintKeys.exposureExpiry(
            expiresAt,
            effectiveRecord.project,
            sessionId,
            effectiveRecord.documentId,
            effectiveRecord.documentVersion,
          ), {
            expiresAt,
            project: effectiveRecord.project,
            sessionId,
            documentId: effectiveRecord.documentId,
            documentVersion: effectiveRecord.documentVersion,
          }, { kind: "retrieval-hint-exposure-expiry" });
        }
      }
    }
    const activity = await transaction.get(activityKey);
    const lastSeen = Math.max(activity?.lastSeen ?? 0, record.createdAt);
    await transaction.put(activityKey, {
      project: record.project,
      sessionId: record.sessionId,
      lastSeen,
      abandonAfter: abandonmentDeadline(
        lastSeen,
        options.inactivityMs ?? DEFAULT_ABANDONED_HINT_INACTIVITY_MS,
      ),
      hintCount: (activity?.hintCount ?? 0) + 1,
    }, { kind: "retrieval-hint-activity" });
    await transaction.putImmutable(checkKey, {
      project: record.project,
      sessionId: record.sessionId,
      messageKey: record.messageKey,
      checkAt,
    }, { kind: "retrieval-hint-abandonment" });
    await transaction.put(pointerKey, { checkAt }, { kind: "retrieval-hint-abandonment-pointer" });
    return effectiveRecord;
  });
}

async function removeFrozenHintFromView(transaction, record, key) {
  const { project, sessionId, messageKey } = record;
  await transaction.remove(key);
  if (record.tokenCount > 0) {
    await transaction.remove(hintKeys.epoch(project, sessionId, record.epochId, messageKey));
  }
  if (record.documentId !== null) {
    await transaction.remove(hintKeys.source(
      project,
      sessionId,
      record.documentId,
      record.documentVersion,
      messageKey,
    ));
  }
  const pointerKey = hintKeys.abandonmentPointer(project, sessionId, messageKey);
  const pointer = await transaction.get(pointerKey);
  if (pointer?.checkAt !== undefined) {
    await transaction.remove(hintKeys.abandonment(pointer.checkAt, project, sessionId, messageKey));
  }
  await transaction.remove(pointerKey);
  const activityKey = hintKeys.activity(project, sessionId);
  const activity = await transaction.get(activityKey);
  if ((activity?.hintCount ?? 1) <= 1) await transaction.remove(activityKey);
  else {
    await transaction.put(activityKey, {
      ...activity,
      hintCount: activity.hintCount - 1,
    }, { kind: "retrieval-hint-activity" });
  }
  if (record.leaseId) await releaseLeaseFromView(transaction, record.leaseId);
}

/** Remove one hint when its containing turn rotates out of the active epoch. */
export async function removeFrozenHint(store, { project, sessionId, messageKey } = {}) {
  if (!store || typeof store.transaction !== "function") {
    throw new TypeError("removeFrozenHint requires a writable RocksStore-compatible store.");
  }
  const key = hintKeys.message(project, sessionId, messageKey);
  const existing = await store.get(key);
  if (existing?.leaseId) await store.get(leaseKeys.byId(existing.leaseId));
  await store.get(hintKeys.activity(project, sessionId));
  await store.get(hintKeys.abandonmentPointer(project, sessionId, messageKey));
  return store.transaction(async (transaction) => {
    const record = await transaction.get(key);
    if (record === undefined) return Object.freeze({ status: "not-found", leaseId: undefined });
    await removeFrozenHintFromView(transaction, record, key);
    return Object.freeze({ status: "removed", leaseId: record.leaseId ?? undefined });
  });
}

/**
 * Reclaim hints from inactive sessions and expired source-exposure records.
 * Each scanned record is one bounded unit; active sessions are lazily rescheduled.
 */
export async function cleanupAbandonedHints(store, {
  now = Date.now(),
  limit = 1_000,
} = {}) {
  nonNegativeInteger(now, "now");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new TypeError("limit must be a positive safe integer at most 100000.");
  }
  const candidates = store.scan(hintKeys.abandonmentPrefix(), { limit });
  let scanned = 0;
  let removed = 0;
  let rescheduled = 0;
  for (const { payload } of candidates) {
    if (payload.checkAt > now) break;
    scanned += 1;
    const messageKey = hintKeys.message(payload.project, payload.sessionId, payload.messageKey);
    const activityKey = hintKeys.activity(payload.project, payload.sessionId);
    const pointerKey = hintKeys.abandonmentPointer(
      payload.project,
      payload.sessionId,
      payload.messageKey,
    );
    if ((await store.get(messageKey))?.leaseId) {
      const record = await store.get(messageKey);
      if (record?.leaseId) await store.get(leaseKeys.byId(record.leaseId));
    }
    await store.get(activityKey);
    await store.get(pointerKey);
    const outcome = await store.transaction(async (transaction) => {
      const pointer = await transaction.get(pointerKey);
      const oldCheckKey = hintKeys.abandonment(
        payload.checkAt,
        payload.project,
        payload.sessionId,
        payload.messageKey,
      );
      if (pointer?.checkAt !== payload.checkAt) {
        await transaction.remove(oldCheckKey);
        return "stale";
      }
      const record = await transaction.get(messageKey);
      if (record === undefined) {
        await transaction.remove(oldCheckKey);
        await transaction.remove(pointerKey);
        return "missing";
      }
      const activity = await transaction.get(activityKey);
      if (activity?.abandonAfter > now) {
        const nextCheckKey = hintKeys.abandonment(
          activity.abandonAfter,
          payload.project,
          payload.sessionId,
          payload.messageKey,
        );
        await transaction.remove(oldCheckKey);
        await transaction.putImmutable(nextCheckKey, {
          ...payload,
          checkAt: activity.abandonAfter,
        }, { kind: "retrieval-hint-abandonment" });
        await transaction.put(pointerKey, { checkAt: activity.abandonAfter }, {
          kind: "retrieval-hint-abandonment-pointer",
        });
        return "rescheduled";
      }
      await removeFrozenHintFromView(transaction, record, messageKey);
      return "removed";
    });
    if (outcome === "rescheduled") rescheduled += 1;
    if (outcome === "removed") removed += 1;
  }
  const remaining = limit - scanned;
  if (remaining > 0) {
    const exposures = store.scan(hintKeys.exposureExpiryPrefix(), { limit: remaining });
    for (const { payload } of exposures) {
      if (payload.expiresAt > now) break;
      scanned += 1;
      const expiryKey = hintKeys.exposureExpiry(
        payload.expiresAt,
        payload.project,
        payload.sessionId,
        payload.documentId,
        payload.documentVersion,
      );
      const exposureKey = hintKeys.exposure(
        payload.project,
        payload.sessionId,
        payload.documentId,
        payload.documentVersion,
      );
      await store.get(exposureKey);
      await store.transaction(async (transaction) => {
        const exposure = await transaction.get(exposureKey);
        if (exposure?.expiresAt === payload.expiresAt && exposure.expiresAt <= now) {
          await transaction.remove(exposureKey);
        }
        await transaction.remove(expiryKey);
      });
    }
  }
  return Object.freeze({ scanned, removed, rescheduled });
}
