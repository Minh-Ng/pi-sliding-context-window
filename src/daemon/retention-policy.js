const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_RETENTION_LIFETIMES_MS = Object.freeze({
  "ephemeral-payload": 14 * DAY_MS,
  "conversation-source": 90 * DAY_MS,
  "derived-evidence": 30 * DAY_MS,
  "durable-evidence": null,
  "active-evidence": null,
});

export const DEFAULT_RETENTION_CLASS_BY_KIND = Object.freeze({
  "tool-result": "ephemeral-payload",
  "tool-argument": "ephemeral-payload",
  "decision-candidate": "derived-evidence",
  "fact-candidate": "derived-evidence",
  manual: "durable-evidence",
});

// Recency decay is a separate axis from expiry: expiry decides what remains
// live, half-life decides how quickly live evidence loses ranking weight.
// Durable/active evidence intentionally never decays so promoted decisions
// keep full weight regardless of age.
export const DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS = Object.freeze({
  "ephemeral-payload": 3 * DAY_MS,
  "conversation-source": 21 * DAY_MS,
  "derived-evidence": 14 * DAY_MS,
  "durable-evidence": null,
  "active-evidence": null,
});

const RETENTION_CLASSES = new Set(Object.keys(DEFAULT_RETENTION_LIFETIMES_MS));

function duration(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be null or a positive safe integer.`);
  }
  return value;
}

function className(value, label) {
  if (!RETENTION_CLASSES.has(value)) {
    throw new TypeError(`${label} must name a supported retention class.`);
  }
  return value;
}

function object(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

/** Normalize archive-kind routing and class/kind lifetime overrides once per client. */
export function normalizeArchiveRetentionPolicy(value = {}) {
  const policy = object(value, "retentionPolicy");
  const requestedClasses = object(policy.classByKind, "retentionPolicy.classByKind");
  const requestedClassLifetimes = object(
    policy.lifetimeMsByClass,
    "retentionPolicy.lifetimeMsByClass",
  );
  const requestedKindLifetimes = object(
    policy.lifetimeMsByKind,
    "retentionPolicy.lifetimeMsByKind",
  );
  const classByKind = { ...DEFAULT_RETENTION_CLASS_BY_KIND };
  for (const [kind, retentionClass] of Object.entries(requestedClasses)) {
    if (!kind) throw new TypeError("retentionPolicy.classByKind keys must be non-empty.");
    classByKind[kind] = className(retentionClass, `retention class for kind ${kind}`);
  }
  const lifetimeMsByClass = { ...DEFAULT_RETENTION_LIFETIMES_MS };
  for (const [retentionClass, lifetimeMs] of Object.entries(requestedClassLifetimes)) {
    className(retentionClass, "retentionPolicy.lifetimeMsByClass key");
    lifetimeMsByClass[retentionClass] = duration(
      lifetimeMs,
      `retention lifetime for class ${retentionClass}`,
    );
  }
  const lifetimeMsByKind = {};
  for (const [kind, lifetimeMs] of Object.entries(requestedKindLifetimes)) {
    if (!kind) throw new TypeError("retentionPolicy.lifetimeMsByKind keys must be non-empty.");
    lifetimeMsByKind[kind] = duration(lifetimeMs, `retention lifetime for kind ${kind}`);
  }
  return Object.freeze({
    classByKind: Object.freeze(classByKind),
    lifetimeMsByClass: Object.freeze(lifetimeMsByClass),
    lifetimeMsByKind: Object.freeze(lifetimeMsByKind),
  });
}

export function retentionForAdmission(policy, {
  kind,
  retentionClass,
  expiresAt,
  now = Date.now(),
} = {}) {
  const normalized = policy?.classByKind ? policy : normalizeArchiveRetentionPolicy(policy);
  const selectedClass = retentionClass === undefined
    ? (normalized.classByKind[kind] ?? "conversation-source")
    : className(retentionClass, "retentionClass");
  if (expiresAt !== undefined) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      throw new TypeError("expiresAt must be a non-negative safe integer timestamp.");
    }
    return Object.freeze({ retentionClass: selectedClass, expiresAt });
  }
  const lifetimeMs = Object.hasOwn(normalized.lifetimeMsByKind, kind)
    ? normalized.lifetimeMsByKind[kind]
    : normalized.lifetimeMsByClass[selectedClass];
  if (lifetimeMs === null) return Object.freeze({ retentionClass: selectedClass });
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - lifetimeMs) {
    throw new RangeError("Retention expiry exceeds the safe timestamp range.");
  }
  return Object.freeze({ retentionClass: selectedClass, expiresAt: now + lifetimeMs });
}

export function retentionPolicyFromDays({
  ephemeralRetentionDays,
  conversationRetentionDays,
  derivedRetentionDays,
} = {}) {
  const asDuration = (days, label) => {
    if (!Number.isSafeInteger(days) || days < 0 || days > Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS)) {
      throw new TypeError(`${label} must be a non-negative safe integer day count.`);
    }
    return days === 0 ? null : days * DAY_MS;
  };
  return {
    lifetimeMsByClass: {
      "ephemeral-payload": asDuration(ephemeralRetentionDays, "ephemeralRetentionDays"),
      "conversation-source": asDuration(conversationRetentionDays, "conversationRetentionDays"),
      "derived-evidence": asDuration(derivedRetentionDays, "derivedRetentionDays"),
    },
  };
}

/** Merge caller overrides onto the default recency half-life table once per search call. */
export function normalizeRecencyHalfLifeMsByClass(overrides = {}) {
  const requested = object(overrides, "recencyDecay.halfLifeMsByClass");
  const halfLifeMsByClass = { ...DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS };
  for (const [retentionClass, halfLifeMs] of Object.entries(requested)) {
    className(retentionClass, "recencyDecay.halfLifeMsByClass key");
    halfLifeMsByClass[retentionClass] = duration(
      halfLifeMs,
      `recency half-life for class ${retentionClass}`,
    );
  }
  return Object.freeze(halfLifeMsByClass);
}

/**
 * Multiplicative recency weight for a rerank score: 0.5 at exactly one
 * half-life old, approaching 0 as age grows. Pure function of retention
 * class and age (relative to the query timestamp), so a given
 * (query, corpus, query-time) triple always recomputes to the same weight.
 */
export function recencyDecayMultiplier({
  retentionClass,
  ageMs,
  halfLifeMsByClass = DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS,
} = {}) {
  const halfLifeMs = halfLifeMsByClass[retentionClass];
  if (halfLifeMs === undefined || halfLifeMs === null) return 1;
  if (!Number.isSafeInteger(halfLifeMs) || halfLifeMs <= 0) {
    throw new TypeError("Recency half-life must be null or a positive safe integer.");
  }
  if (!Number.isFinite(ageMs)) return 1;
  // A future-dated createdAt (clock skew, backfilled fixtures) gets no decay
  // penalty; it never gets a boost either.
  const clampedAgeMs = Math.max(0, ageMs);
  return 2 ** (-clampedAgeMs / halfLifeMs);
}
