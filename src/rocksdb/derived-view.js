import { keyFor, KEYSPACE } from "./keys.js";
import { manifestKeys, retiredDocumentStatus } from "./manifests.js";
import { SchemaCompatibilityError, stableJson } from "./schema.js";

export const DOCUMENT_ORDINAL_FORMAT_VERSION = 1;
export const DERIVED_VIEW_FORMAT_VERSION = 1;
export const DERIVED_VIEW_LAYOUT = "ordinal-overlay-v1";
export const MAX_DOCUMENT_ORDINAL = 0xffff_ffff;

// Keep startup memory bounded even when a legacy manifest contains a large
// structural payload. The upgrade is crash-resumable at the page boundary.
const BACKFILL_PAGE_SIZE = 8;
const ROOT = Object.freeze([KEYSPACE.META, "derived-view"]);

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer timestamp.`);
  }
  return value;
}

export const derivedViewKeys = Object.freeze({
  upgradeState() {
    return [...ROOT, "upgrade"];
  },
  queryCutover() {
    return [...ROOT, "query-cutover"];
  },
  active(project) {
    return [...ROOT, "active", identifier(project, "project")];
  },
  document(project, documentId, version) {
    return [
      ...ROOT,
      "document",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  ordinal(ordinal) {
    return [...ROOT, "ordinal", positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL)];
  },
  projectDocument(project, ordinal) {
    return [
      ...ROOT,
      "scope",
      "project",
      identifier(project, "project"),
      positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL),
    ];
  },
  sessionDocument(project, sessionId, ordinal) {
    return [
      ...ROOT,
      "scope",
      "session",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL),
    ];
  },
  tombstone(project, ordinal) {
    return [
      ...ROOT,
      "tombstone",
      identifier(project, "project"),
      positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL),
    ];
  },
});

export function documentViewAdmission(payload) {
  if (payload === undefined) return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("derivedView must be an object.");
  }
  const retiredDocuments = payload.retiredDocuments ?? [];
  if (!Array.isArray(retiredDocuments)) {
    throw new TypeError("derivedView.retiredDocuments must be an array.");
  }
  return Object.freeze({
    project: identifier(payload.project, "derivedView.project"),
    sessionId: identifier(payload.sessionId, "derivedView.sessionId"),
    documentId: identifier(payload.documentId, "derivedView.documentId"),
    documentVersion: positiveInteger(payload.documentVersion, "derivedView.documentVersion"),
    admittedAt: timestamp(payload.admittedAt, "derivedView.admittedAt"),
    retiredDocuments: Object.freeze(retiredDocuments.map((marker, index) => {
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
        throw new TypeError(`derivedView.retiredDocuments[${index}] must be an object.`);
      }
      return Object.freeze({
        ...marker,
        documentId: identifier(marker.documentId, `derivedView.retiredDocuments[${index}].documentId`),
        documentVersion: positiveInteger(
          marker.documentVersion,
          `derivedView.retiredDocuments[${index}].documentVersion`,
        ),
        status: identifier(marker.status, `derivedView.retiredDocuments[${index}].status`),
        recordedAt: timestamp(marker.recordedAt, `derivedView.retiredDocuments[${index}].recordedAt`),
      });
    })),
  });
}

export function createDocumentOrdinal(admission, ordinal) {
  return Object.freeze({
    ordinalFormatVersion: DOCUMENT_ORDINAL_FORMAT_VERSION,
    ordinal: positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL),
    project: identifier(admission.project, "admission.project"),
    sessionId: identifier(admission.sessionId, "admission.sessionId"),
    documentId: identifier(admission.documentId, "admission.documentId"),
    documentVersion: positiveInteger(admission.documentVersion, "admission.documentVersion"),
    admittedAt: timestamp(admission.admittedAt, "admission.admittedAt"),
  });
}

function createRetiredDocumentOrdinal(retirement, ordinal) {
  return Object.freeze({
    ordinalFormatVersion: DOCUMENT_ORDINAL_FORMAT_VERSION,
    ordinal: positiveInteger(ordinal, "ordinal", MAX_DOCUMENT_ORDINAL),
    project: identifier(retirement.project, "retirement.project"),
    documentId: identifier(retirement.documentId, "retirement.documentId"),
    documentVersion: positiveInteger(
      retirement.documentVersion,
      "retirement.documentVersion",
    ),
    admittedAt: 0,
    retiredOnly: true,
  });
}

export function createDerivedViewTombstone(assignment, marker) {
  return Object.freeze({
    derivedViewFormatVersion: DERIVED_VIEW_FORMAT_VERSION,
    ordinal: positiveInteger(assignment.ordinal, "assignment.ordinal", MAX_DOCUMENT_ORDINAL),
    project: identifier(assignment.project, "assignment.project"),
    documentId: identifier(assignment.documentId, "assignment.documentId"),
    documentVersion: positiveInteger(assignment.documentVersion, "assignment.documentVersion"),
    status: identifier(marker.status, "marker.status"),
    reason: identifier(marker.reason, "marker.reason"),
    recordedAt: timestamp(marker.recordedAt, "marker.recordedAt"),
  });
}

export function advanceDerivedViewManifest(
  current,
  {
    project,
    admittedOrdinals = [],
    tombstonedOrdinals = [],
    updatedAt = Date.now(),
  },
) {
  identifier(project, "project");
  timestamp(updatedAt, "updatedAt");
  if (!Array.isArray(admittedOrdinals) || !Array.isArray(tombstonedOrdinals)) {
    throw new TypeError("Derived-view manifest ordinal deltas must be arrays.");
  }
  if (current !== undefined && (
    current.derivedViewFormatVersion !== DERIVED_VIEW_FORMAT_VERSION
    || current.layout !== DERIVED_VIEW_LAYOUT
    || current.project !== project
    || !Number.isSafeInteger(current.activeEpoch) || current.activeEpoch <= 0
    || !Number.isSafeInteger(current.ordinalHighWatermark)
    || current.ordinalHighWatermark < 0
    || !Number.isSafeInteger(current.admittedDocuments) || current.admittedDocuments < 0
    || !Number.isSafeInteger(current.tombstonedDocuments)
    || current.tombstonedDocuments < 0
    || current.tombstonedDocuments > current.admittedDocuments
    || !Number.isSafeInteger(current.tombstoneGeneration)
    || current.tombstoneGeneration < current.tombstonedDocuments
    || !Array.isArray(current.runs)
    || !Number.isSafeInteger(current.updatedAt) || current.updatedAt < 0
  )) {
    throw new SchemaCompatibilityError(`Derived-view manifest for ${project} is malformed.`);
  }
  const admitted = admittedOrdinals.map((ordinal) =>
    positiveInteger(ordinal, "admitted ordinal", MAX_DOCUMENT_ORDINAL));
  const tombstoned = tombstonedOrdinals.map((ordinal) =>
    positiveInteger(ordinal, "tombstoned ordinal", MAX_DOCUMENT_ORDINAL));
  return Object.freeze({
    derivedViewFormatVersion: DERIVED_VIEW_FORMAT_VERSION,
    layout: DERIVED_VIEW_LAYOUT,
    project,
    activeEpoch: current?.activeEpoch ?? 1,
    ordinalHighWatermark: Math.max(current?.ordinalHighWatermark ?? 0, ...admitted, 0),
    admittedDocuments: (current?.admittedDocuments ?? 0) + admitted.length,
    tombstonedDocuments: (current?.tombstonedDocuments ?? 0) + tombstoned.length,
    tombstoneGeneration: (current?.tombstoneGeneration ?? 0) + tombstoned.length,
    runs: Object.freeze([...(current?.runs ?? [])]),
    updatedAt: Math.max(current?.updatedAt ?? 0, updatedAt),
  });
}

export async function resolveDocumentOrdinal(view, {
  project,
  documentId,
  version,
} = {}) {
  return view.get(derivedViewKeys.document(project, documentId, version));
}

export async function isDocumentOrdinalLive(view, assignment) {
  return await view.get(
    derivedViewKeys.tombstone(assignment.project, assignment.ordinal),
  ) === undefined;
}

export function isDerivedViewQueryCutover(value) {
  return value?.layout === DERIVED_VIEW_LAYOUT
    && value?.formatVersion === DERIVED_VIEW_FORMAT_VERSION;
}

export async function documentOrdinalLiveness(view, {
  project,
  documentId,
  version,
  authoritative,
} = {}) {
  if (typeof project !== "string" || project.length === 0
    || typeof documentId !== "string" || documentId.length === 0
    || !Number.isSafeInteger(version) || version <= 0) {
    return undefined;
  }
  const assignment = await resolveDocumentOrdinal(view, { project, documentId, version });
  if (assignment === undefined) return undefined;
  const [tombstone, cutover] = await Promise.all([
    view.get(derivedViewKeys.tombstone(assignment.project, assignment.ordinal)),
    authoritative === undefined
      ? view.get(derivedViewKeys.queryCutover())
      : undefined,
  ]);
  return Object.freeze({
    assignment,
    live: tombstone === undefined,
    tombstone,
    authoritative: authoritative ?? isDerivedViewQueryCutover(cutover),
  });
}

/** Synchronous scan equivalent for structural lookup's legacy sync surface. */
export function scanDocumentOrdinalLiveness(view, {
  project,
  documentId,
  version,
  authoritative,
} = {}) {
  if (typeof project !== "string" || project.length === 0
    || typeof documentId !== "string" || documentId.length === 0
    || !Number.isSafeInteger(version) || version <= 0) {
    return undefined;
  }
  const assignment = view.scan(derivedViewKeys.document(project, documentId, version), {
    limit: 1,
  })[0]?.payload;
  if (assignment === undefined
    || typeof assignment.project !== "string" || assignment.project.length === 0
    || !Number.isSafeInteger(assignment.ordinal) || assignment.ordinal <= 0) {
    return undefined;
  }
  const tombstone = view.scan(derivedViewKeys.tombstone(
    assignment.project,
    assignment.ordinal,
  ), { limit: 1 })[0]?.payload;
  const cutover = authoritative === undefined
    ? view.scan(derivedViewKeys.queryCutover(), { limit: 1 })[0]?.payload
    : undefined;
  return Object.freeze({
    assignment,
    live: tombstone === undefined,
    tombstone,
    authoritative: authoritative ?? isDerivedViewQueryCutover(cutover),
  });
}

/**
 * Record a retirement at the same transaction boundary as its canonical
 * supersession marker. Absence remains the compact representation of "live".
 */
export async function recordDerivedViewTombstone(transaction, assignment, marker) {
  if (assignment === undefined) return false;
  const key = derivedViewKeys.tombstone(assignment.project, assignment.ordinal);
  const payload = createDerivedViewTombstone(assignment, marker);
  const status = await transaction.putImmutable(key, payload, {
    kind: "derived-view-tombstone",
  });
  if (status === "unchanged") return false;
  const manifestKey = derivedViewKeys.active(assignment.project);
  const current = await transaction.get(manifestKey);
  await transaction.put(manifestKey, advanceDerivedViewManifest(current, {
    project: assignment.project,
    tombstonedOrdinals: [assignment.ordinal],
    updatedAt: marker.recordedAt,
  }), { kind: "derived-view-manifest" });
  return true;
}

function initialUpgradeState() {
  return Object.freeze({
    formatVersion: DERIVED_VIEW_FORMAT_VERSION,
    status: "indexing",
    phase: "documents",
    after: null,
    indexedDocuments: 0,
    tombstonedDocuments: 0,
    outboxHighWatermark: 0,
    retirementHighWatermark: 0,
  });
}

function completeUpgradeState(state = initialUpgradeState(), outboxHighWatermark = 0) {
  return Object.freeze({
    formatVersion: DERIVED_VIEW_FORMAT_VERSION,
    status: "complete",
    phase: "complete",
    after: null,
    indexedDocuments: state.indexedDocuments,
    tombstonedDocuments: state.tombstonedDocuments,
    outboxHighWatermark: nonNegativeInteger(outboxHighWatermark, "outboxHighWatermark"),
    retirementHighWatermark: nonNegativeInteger(
      outboxHighWatermark,
      "retirementHighWatermark",
    ),
  });
}

function assertUpgradeState(value) {
  if (!value || value.formatVersion !== DERIVED_VIEW_FORMAT_VERSION
    || !["indexing", "complete"].includes(value.status)
    || ![
      "documents",
      "retired-markers",
      "retired-histories",
      "retirements",
      "complete",
    ].includes(
      value.phase ?? (value.status === "complete" ? "complete" : "documents"),
    )
    || (value.after !== null && typeof value.after !== "string")
    || (value.historyDocumentId !== undefined
      && (typeof value.historyDocumentId !== "string"
        || value.historyDocumentId.length === 0))
    || (value.historyVersion !== undefined
      && (!Number.isSafeInteger(value.historyVersion)
        || value.historyVersion < 0))
    || ((value.historyDocumentId === undefined)
      !== (value.historyVersion === undefined))
    || !Number.isSafeInteger(value.indexedDocuments) || value.indexedDocuments < 0
    || !Number.isSafeInteger(value.tombstonedDocuments) || value.tombstonedDocuments < 0
    || (value.outboxHighWatermark !== undefined
      && (!Number.isSafeInteger(value.outboxHighWatermark)
        || value.outboxHighWatermark < 0))
    || (value.retirementHighWatermark !== undefined
      && (!Number.isSafeInteger(value.retirementHighWatermark)
        || value.retirementHighWatermark < 0))) {
    throw new SchemaCompatibilityError("Derived-view upgrade state is missing or malformed.");
  }
  return Object.freeze({
    ...value,
    phase: value.phase ?? (value.status === "complete" ? "complete" : "documents"),
    outboxHighWatermark: value.outboxHighWatermark ?? 0,
    retirementHighWatermark: value.retirementHighWatermark ?? 0,
  });
}

function sameUpgradeState(left, right) {
  return left?.formatVersion === right.formatVersion
    && left?.status === right.status
    && (left?.phase ?? (left?.status === "complete" ? "complete" : "documents")) === right.phase
    && left?.after === right.after
    && left?.indexedDocuments === right.indexedDocuments
    && left?.tombstonedDocuments === right.tombstonedDocuments
    && (left?.outboxHighWatermark ?? 0) === right.outboxHighWatermark
    && (left?.retirementHighWatermark ?? 0) === right.retirementHighWatermark
    && left?.historyDocumentId === right.historyDocumentId
    && left?.historyVersion === right.historyVersion;
}

export function advanceDerivedViewOutbox(state, sequence) {
  const current = assertUpgradeState(state);
  const outboxHighWatermark = positiveInteger(sequence, "outbox sequence");
  return Object.freeze({
    ...current,
    outboxHighWatermark: Math.max(current.outboxHighWatermark, outboxHighWatermark),
    retirementHighWatermark: Math.max(
      current.retirementHighWatermark,
      outboxHighWatermark,
    ),
  });
}

async function transitionReconciliationPhase(
  store,
  stateKey,
  state,
  phase,
  outboxHighWatermark,
) {
  const {
    historyDocumentId: _historyDocumentId,
    historyVersion: _historyVersion,
    ...baseState
  } = state;
  const next = Object.freeze({
    ...baseState,
    status: "indexing",
    phase,
    after: null,
    outboxHighWatermark,
  });
  await store.get(stateKey);
  await store.transaction(async (transaction) => {
    const current = await transaction.get(stateKey);
    if (!sameUpgradeState(current, state)) {
      throw new SchemaCompatibilityError("Derived-view upgrade state changed unexpectedly.");
    }
    await transaction.put(stateKey, next, { kind: "derived-view-upgrade-state" });
  });
  return next;
}

async function materializeRetiredCandidates(
  store,
  stateKey,
  state,
  candidates,
  nextState,
  outboxHighWatermark,
) {
  const projects = new Set(candidates.map(({ project }) => project));
  for (const project of projects) await store.get(derivedViewKeys.active(project));
  for (const candidate of candidates) {
    const assignment = await store.get(derivedViewKeys.document(
      candidate.project,
      candidate.documentId,
      candidate.documentVersion,
    ));
    if (assignment !== undefined) {
      await store.get(derivedViewKeys.tombstone(
        assignment.project,
        assignment.ordinal,
      ));
    }
  }
  await store.get(stateKey);
  return store.transaction(async (transaction) => {
    const currentState = await transaction.get(stateKey);
    if (!sameUpgradeState(currentState, state)) {
      throw new SchemaCompatibilityError("Derived-view upgrade state changed unexpectedly.");
    }
    let addedDocuments = 0;
    let addedTombstones = 0;
    const deltas = new Map();
    for (const candidate of candidates) {
      const identityKey = derivedViewKeys.document(
        candidate.project,
        candidate.documentId,
        candidate.documentVersion,
      );
      let assignment = await transaction.get(identityKey);
      let addedOrdinal = false;
      if (assignment === undefined) {
        const ordinal = await transaction.increment("document-ordinal");
        if (ordinal > MAX_DOCUMENT_ORDINAL) {
          throw new RangeError("Document ordinal counter exceeded the uint32 range.");
        }
        assignment = createRetiredDocumentOrdinal(candidate, ordinal);
        await transaction.putImmutable(identityKey, assignment, {
          kind: "document-ordinal",
        });
        await transaction.putImmutable(derivedViewKeys.ordinal(ordinal), assignment, {
          kind: "document-ordinal",
        });
        await transaction.putImmutable(
          derivedViewKeys.projectDocument(assignment.project, ordinal),
          assignment,
          { kind: "derived-view-project-member" },
        );
        addedOrdinal = true;
        addedDocuments += 1;
      } else if (assignment.project !== candidate.project
        || assignment.documentId !== candidate.documentId
        || assignment.documentVersion !== candidate.documentVersion) {
        throw new SchemaCompatibilityError(
          `Document ordinal ${assignment.ordinal} conflicts with its retired identity.`,
        );
      }
      const tombstoneKey = derivedViewKeys.tombstone(
        assignment.project,
        assignment.ordinal,
      );
      const existingTombstone = addedOrdinal
        ? undefined
        : await transaction.get(tombstoneKey);
      let addedTombstone = false;
      if (existingTombstone === undefined) {
        await transaction.putImmutable(
          tombstoneKey,
          createDerivedViewTombstone(assignment, candidate.marker),
          { kind: "derived-view-tombstone" },
        );
        addedTombstone = true;
        addedTombstones += 1;
      }
      if (!addedOrdinal && !addedTombstone) continue;
      const delta = deltas.get(assignment.project) ?? {
        admittedOrdinals: [],
        tombstonedOrdinals: [],
        updatedAt: candidate.marker.recordedAt,
      };
      if (addedOrdinal) delta.admittedOrdinals.push(assignment.ordinal);
      if (addedTombstone) delta.tombstonedOrdinals.push(assignment.ordinal);
      delta.updatedAt = Math.max(delta.updatedAt, candidate.marker.recordedAt);
      deltas.set(assignment.project, delta);
    }
    for (const [project, delta] of deltas) {
      const manifestKey = derivedViewKeys.active(project);
      const current = await transaction.get(manifestKey);
      await transaction.put(
        manifestKey,
        advanceDerivedViewManifest(current, { project, ...delta }),
        { kind: "derived-view-manifest" },
      );
    }
    const {
      historyDocumentId: _historyDocumentId,
      historyVersion: _historyVersion,
      ...baseState
    } = state;
    const next = Object.freeze({
      ...baseState,
      ...nextState,
      indexedDocuments: state.indexedDocuments + addedDocuments,
      tombstonedDocuments: state.tombstonedDocuments + addedTombstones,
      outboxHighWatermark,
    });
    await transaction.put(stateKey, next, { kind: "derived-view-upgrade-state" });
    return next;
  });
}

async function reconcileRetiredMarkerPage(
  store,
  stateKey,
  state,
  outboxHighWatermark,
) {
  const page = store.scan([KEYSPACE.SUPERSESSION], {
    limit: BACKFILL_PAGE_SIZE,
    ...(state.after === null ? {} : { after: Buffer.from(state.after, "base64url") }),
  });
  if (page.length === 0) {
    return transitionReconciliationPhase(
      store,
      stateKey,
      state,
      "retired-histories",
      outboxHighWatermark,
    );
  }
  const candidates = [];
  for (const { payload: marker } of page) {
    const manifest = await store.get(manifestKeys.document(
      marker.documentId,
      marker.documentVersion,
    ));
    const history = await store.get(manifestKeys.documentHistory(marker.documentId));
    const project = manifest?.project ?? history?.project;
    if (project === undefined) continue;
    candidates.push({
      project,
      documentId: marker.documentId,
      documentVersion: marker.documentVersion,
      marker,
    });
  }
  return materializeRetiredCandidates(
    store,
    stateKey,
    state,
    candidates,
    {
      status: "indexing",
      phase: "retired-markers",
      after: page.at(-1).keyBytes.toString("base64url"),
    },
    outboxHighWatermark,
  );
}

async function reconcileRetiredHistoryPage(
  store,
  stateKey,
  state,
  outboxHighWatermark,
) {
  const page = store.scan([KEYSPACE.META, "document-history"], {
    limit: 1,
    ...(state.after === null ? {} : { after: Buffer.from(state.after, "base64url") }),
  });
  if (page.length === 0) {
    return transitionReconciliationPhase(
      store,
      stateKey,
      state,
      "retirements",
      outboxHighWatermark,
    );
  }
  const record = page[0];
  const history = record.payload;
  const documentId = identifier(history.documentId, "document history documentId");
  const project = identifier(history.project, "document history project");
  const retiredThrough = nonNegativeInteger(
    history.retiredThrough,
    "document history retiredThrough",
  );
  if (state.historyDocumentId !== undefined
    && state.historyDocumentId !== documentId) {
    throw new SchemaCompatibilityError("Derived-view history cursor changed unexpectedly.");
  }
  const firstVersion = (state.historyVersion ?? 0) + 1;
  const lastVersion = Math.min(
    retiredThrough,
    firstVersion + BACKFILL_PAGE_SIZE - 1,
  );
  const candidates = [];
  for (let version = firstVersion; version <= lastVersion; version += 1) {
    const retired = retiredDocumentStatus(history, version);
    if (retired === undefined) {
      throw new SchemaCompatibilityError(
        `Document history for ${documentId}@${version} does not prove retirement.`,
      );
    }
    candidates.push({
      project,
      documentId,
      documentVersion: version,
      marker: {
        documentId,
        documentVersion: version,
        status: retired.status,
        reason: retired.reason,
        recordedAt: 0,
      },
    });
  }
  const complete = lastVersion >= retiredThrough;
  return materializeRetiredCandidates(
    store,
    stateKey,
    state,
    candidates,
    {
      status: "indexing",
      phase: "retired-histories",
      after: complete ? record.keyBytes.toString("base64url") : state.after,
      ...(complete
        ? {}
        : { historyDocumentId: documentId, historyVersion: lastVersion }),
    },
    outboxHighWatermark,
  );
}

async function reconcileRetirementPage(store, stateKey, state, outboxHighWatermark) {
  const page = store.scan([...ROOT, "ordinal"], {
    limit: BACKFILL_PAGE_SIZE,
    ...(state.after === null ? {} : { after: Buffer.from(state.after, "base64url") }),
  });
  if (page.length === 0) {
    const next = completeUpgradeState(state, outboxHighWatermark);
    await store.get(stateKey);
    await store.transaction(async (transaction) => {
      const current = await transaction.get(stateKey);
      if (!sameUpgradeState(current, state)) {
        throw new SchemaCompatibilityError("Derived-view upgrade state changed unexpectedly.");
      }
      await transaction.put(stateKey, next, { kind: "derived-view-upgrade-state" });
    });
    return next;
  }

  const candidates = [];
  const projects = new Set();
  for (const { payload: assignment } of page) {
    if (await store.get(derivedViewKeys.tombstone(
      assignment.project,
      assignment.ordinal,
    )) !== undefined) {
      continue;
    }
    let marker = await store.get([
      KEYSPACE.SUPERSESSION,
      assignment.documentId,
      assignment.documentVersion,
    ]);
    if (marker === undefined) {
      const history = await store.get(manifestKeys.documentHistory(assignment.documentId));
      const retired = retiredDocumentStatus(history, assignment.documentVersion);
      if (retired !== undefined) {
        marker = {
          documentId: assignment.documentId,
          documentVersion: assignment.documentVersion,
          status: retired.status,
          reason: retired.reason,
          recordedAt: 0,
        };
      }
    }
    if (marker === undefined) continue;
    candidates.push({ assignment, marker });
    projects.add(assignment.project);
  }
  for (const project of projects) await store.get(derivedViewKeys.active(project));
  await store.get(stateKey);

  const after = page.at(-1).keyBytes.toString("base64url");
  return store.transaction(async (transaction) => {
    const currentState = await transaction.get(stateKey);
    if (!sameUpgradeState(currentState, state)) {
      throw new SchemaCompatibilityError("Derived-view upgrade state changed unexpectedly.");
    }
    let addedTombstones = 0;
    const deltas = new Map();
    for (const { assignment, marker } of candidates) {
      const tombstoneKey = derivedViewKeys.tombstone(
        assignment.project,
        assignment.ordinal,
      );
      if (await transaction.get(tombstoneKey) !== undefined) continue;
      await transaction.putImmutable(
        tombstoneKey,
        createDerivedViewTombstone(assignment, marker),
        { kind: "derived-view-tombstone" },
      );
      const delta = deltas.get(assignment.project) ?? {
        admittedOrdinals: [],
        tombstonedOrdinals: [],
        updatedAt: marker.recordedAt,
      };
      delta.tombstonedOrdinals.push(assignment.ordinal);
      delta.updatedAt = Math.max(delta.updatedAt, marker.recordedAt);
      deltas.set(assignment.project, delta);
      addedTombstones += 1;
    }
    for (const [project, delta] of deltas) {
      const manifestKey = derivedViewKeys.active(project);
      const current = await transaction.get(manifestKey);
      if (current === undefined) {
        throw new SchemaCompatibilityError(
          `Derived-view manifest for ${project} is missing during retirement reconciliation.`,
        );
      }
      await transaction.put(
        manifestKey,
        advanceDerivedViewManifest(current, { project, ...delta }),
        { kind: "derived-view-manifest" },
      );
    }
    const next = Object.freeze({
      ...state,
      status: "indexing",
      phase: "retirements",
      after,
      tombstonedDocuments: state.tombstonedDocuments + addedTombstones,
      outboxHighWatermark,
    });
    await transaction.put(stateKey, next, { kind: "derived-view-upgrade-state" });
    return next;
  });
}

/**
 * Assign dense ordinals to manifests written before ordinal views existed.
 * Current admissions allocate from the same counter in their canonical
 * transaction, so ordinals are stable and never reused.
 */
export async function ensureDerivedView(store, { fresh = false } = {}) {
  const stateKey = derivedViewKeys.upgradeState();
  const outboxHighWatermark = await store.get(keyFor.counter("outbox")) ?? 0;
  if (!Number.isSafeInteger(outboxHighWatermark) || outboxHighWatermark < 0) {
    throw new SchemaCompatibilityError("The canonical outbox counter is malformed.");
  }
  let state = await store.get(stateKey);
  if (state === undefined && fresh) {
    if (store.readOnly) {
      throw new SchemaCompatibilityError("Cannot initialize derived views in read-only mode.");
    }
    state = completeUpgradeState(initialUpgradeState(), outboxHighWatermark);
    await store.put(stateKey, state, { kind: "derived-view-upgrade-state" });
    return state;
  }
  if (state === undefined) {
    if (store.readOnly) {
      throw new SchemaCompatibilityError(
        "This RocksDB store requires a writable derived-view upgrade before read-only use.",
      );
    }
    state = initialUpgradeState();
    await store.put(stateKey, state, { kind: "derived-view-upgrade-state" });
  } else {
    state = assertUpgradeState(state);
  }
  if (state.status === "complete"
    && state.outboxHighWatermark >= outboxHighWatermark
    && state.retirementHighWatermark >= outboxHighWatermark) {
    return state;
  }
  if (store.readOnly) {
    throw new SchemaCompatibilityError(
      "This RocksDB store has an incomplete or stale derived-view upgrade.",
    );
  }
  if (state.status === "complete") {
    state = Object.freeze({
      ...state,
      status: "indexing",
      phase: "documents",
      after: null,
      outboxHighWatermark,
    });
    await store.put(stateKey, state, { kind: "derived-view-upgrade-state" });
  }

  while (state.status === "indexing") {
    if (state.phase === "retired-markers") {
      state = await reconcileRetiredMarkerPage(
        store,
        stateKey,
        state,
        outboxHighWatermark,
      );
      continue;
    }
    if (state.phase === "retired-histories") {
      state = await reconcileRetiredHistoryPage(
        store,
        stateKey,
        state,
        outboxHighWatermark,
      );
      continue;
    }
    if (state.phase === "retirements") {
      state = await reconcileRetirementPage(
        store,
        stateKey,
        state,
        outboxHighWatermark,
      );
      continue;
    }
    const page = store.scan([KEYSPACE.DOCUMENT], {
      limit: BACKFILL_PAGE_SIZE,
      ...(state.after === null ? {} : { after: Buffer.from(state.after, "base64url") }),
    });
    if (page.length === 0) {
      state = await transitionReconciliationPhase(
        store,
        stateKey,
        state,
        "retired-markers",
        outboxHighWatermark,
      );
      continue;
    }

    const candidates = [];
    const projects = new Set();
    for (const { payload: manifest } of page) {
      const key = derivedViewKeys.document(
        manifest.project,
        manifest.documentId,
        manifest.version,
      );
      const existing = await store.get(key);
      if (existing !== undefined) continue;
      const supersession = await store.get([
        KEYSPACE.SUPERSESSION,
        manifest.documentId,
        manifest.version,
      ]);
      candidates.push({ manifest, key, supersession });
      projects.add(manifest.project);
    }
    for (const project of projects) await store.get(derivedViewKeys.active(project));
    await store.get(stateKey);

    const after = page.at(-1).keyBytes.toString("base64url");
    state = await store.transaction(async (transaction) => {
      const currentState = await transaction.get(stateKey);
      if (!sameUpgradeState(currentState, state)) {
        throw new SchemaCompatibilityError("Derived-view upgrade state changed unexpectedly.");
      }
      let addedDocuments = 0;
      let addedTombstones = 0;
      const deltas = new Map();
      for (const candidate of candidates) {
        if (await transaction.get(candidate.key) !== undefined) continue;
        const ordinal = await transaction.increment("document-ordinal");
        if (ordinal > MAX_DOCUMENT_ORDINAL) {
          throw new RangeError("Document ordinal counter exceeded the uint32 range.");
        }
        const assignment = createDocumentOrdinal({
          project: candidate.manifest.project,
          sessionId: candidate.manifest.sessionId,
          documentId: candidate.manifest.documentId,
          documentVersion: candidate.manifest.version,
          admittedAt: candidate.manifest.createdAt,
        }, ordinal);
        await transaction.putImmutable(candidate.key, assignment, {
          kind: "document-ordinal",
        });
        await transaction.putImmutable(derivedViewKeys.ordinal(ordinal), assignment, {
          kind: "document-ordinal",
        });
        await transaction.putImmutable(
          derivedViewKeys.projectDocument(assignment.project, ordinal),
          assignment,
          { kind: "derived-view-project-member" },
        );
        await transaction.putImmutable(
          derivedViewKeys.sessionDocument(assignment.project, assignment.sessionId, ordinal),
          assignment,
          { kind: "derived-view-session-member" },
        );
        const delta = deltas.get(assignment.project) ?? {
          admittedOrdinals: [],
          tombstonedOrdinals: [],
          updatedAt: assignment.admittedAt,
        };
        delta.admittedOrdinals.push(ordinal);
        delta.updatedAt = Math.max(delta.updatedAt, assignment.admittedAt);
        if (candidate.supersession !== undefined) {
          await transaction.putImmutable(
            derivedViewKeys.tombstone(assignment.project, ordinal),
            createDerivedViewTombstone(assignment, candidate.supersession),
            { kind: "derived-view-tombstone" },
          );
          delta.tombstonedOrdinals.push(ordinal);
          delta.updatedAt = Math.max(delta.updatedAt, candidate.supersession.recordedAt);
          addedTombstones += 1;
        }
        deltas.set(assignment.project, delta);
        addedDocuments += 1;
      }
      for (const [project, delta] of deltas) {
        const manifestKey = derivedViewKeys.active(project);
        const current = await transaction.get(manifestKey);
        await transaction.put(
          manifestKey,
          advanceDerivedViewManifest(current, { project, ...delta }),
          { kind: "derived-view-manifest" },
        );
      }
      const next = Object.freeze({
        formatVersion: DERIVED_VIEW_FORMAT_VERSION,
        status: "indexing",
        phase: "documents",
        after,
        indexedDocuments: state.indexedDocuments + addedDocuments,
        tombstonedDocuments: state.tombstonedDocuments + addedTombstones,
        outboxHighWatermark,
        retirementHighWatermark: state.retirementHighWatermark,
      });
      await transaction.put(stateKey, next, { kind: "derived-view-upgrade-state" });
      return next;
    });
  }
  return state;
}

export async function derivedViewStatus(store, { project } = {}) {
  const upgrade = assertUpgradeState(await store.get(derivedViewKeys.upgradeState()));
  if (project !== undefined) {
    const active = await store.get(derivedViewKeys.active(project));
    const {
      derivedViewFormatVersion: _derivedViewFormatVersion,
      ...activeStatus
    } = active ?? {};
    return Object.freeze({
      formatVersion: upgrade.formatVersion,
      upgradeStatus: upgrade.status,
      project,
      ...activeStatus,
      liveDocuments: active === undefined
        ? 0
        : active.admittedDocuments - active.tombstonedDocuments,
    });
  }
  const manifests = store.scan([...ROOT, "active"], { limit: 100_000 });
  const admittedDocuments = manifests.reduce(
    (total, { payload }) => total + payload.admittedDocuments,
    0,
  );
  const tombstonedDocuments = manifests.reduce(
    (total, { payload }) => total + payload.tombstonedDocuments,
    0,
  );
  return Object.freeze({
    formatVersion: upgrade.formatVersion,
    upgradeStatus: upgrade.status,
    projects: manifests.length,
    admittedDocuments,
    tombstonedDocuments,
    liveDocuments: admittedDocuments - tombstonedDocuments,
  });
}

function emptyVerificationSummary() {
  return {
    checked: 0,
    missingAssignments: 0,
    identityMismatches: 0,
    scopeMismatches: 0,
    retirementMismatches: 0,
    orphanLiveAssignments: 0,
    samples: [],
  };
}

function verificationResult(summary, extra = {}) {
  const mismatches = summary.missingAssignments
    + summary.identityMismatches
    + summary.scopeMismatches
    + summary.retirementMismatches
    + summary.orphanLiveAssignments;
  return Object.freeze({
    ok: mismatches === 0,
    checked: summary.checked,
    mismatches,
    missingAssignments: summary.missingAssignments,
    identityMismatches: summary.identityMismatches,
    scopeMismatches: summary.scopeMismatches,
    retirementMismatches: summary.retirementMismatches,
    orphanLiveAssignments: summary.orphanLiveAssignments,
    ...extra,
    samples: Object.freeze(summary.samples),
  });
}

function addVerificationSample(summary, sample) {
  if (summary.samples.length < 10) summary.samples.push(sample);
}

/**
 * Verify one bounded page of either canonical manifests or ordinal reverse
 * assignments. Callers can persist `nextAfter` and resume without making one
 * maintenance tick proportional to the full archive.
 */
export async function verifyDerivedViewPage(store, {
  phase = "documents",
  project,
  limit = 1_024,
  after,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new RangeError("Derived-view verification limit must be between 1 and 100000.");
  }
  if (!["documents", "assignments"].includes(phase)) {
    throw new TypeError("Derived-view verification phase must be documents or assignments.");
  }
  if (project !== undefined) identifier(project, "project");
  const prefix = phase === "documents" ? [KEYSPACE.DOCUMENT] : [...ROOT, "ordinal"];
  const records = store.scan(prefix, {
    limit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const summary = emptyVerificationSummary();
  if (phase === "documents") {
    for (const { payload: manifest } of records) {
      if (project !== undefined && manifest.project !== project) continue;
      summary.checked += 1;
      const assignment = await resolveDocumentOrdinal(store, {
        project: manifest.project,
        documentId: manifest.documentId,
        version: manifest.version,
      });
      if (assignment === undefined) {
        summary.missingAssignments += 1;
        addVerificationSample(summary, {
          documentId: manifest.documentId,
          version: manifest.version,
          issue: "missing-assignment",
        });
        continue;
      }
      const reverse = await store.get(derivedViewKeys.ordinal(assignment.ordinal));
      if (stableJson(reverse) !== stableJson(assignment)
        || assignment.project !== manifest.project
        || assignment.sessionId !== manifest.sessionId
        || assignment.documentId !== manifest.documentId
        || assignment.documentVersion !== manifest.version) {
        summary.identityMismatches += 1;
        addVerificationSample(summary, {
          documentId: manifest.documentId,
          version: manifest.version,
          ordinal: assignment.ordinal,
          issue: "identity-mismatch",
        });
      }
      const [projectMember, sessionMember] = await Promise.all([
        store.get(derivedViewKeys.projectDocument(manifest.project, assignment.ordinal)),
        store.get(derivedViewKeys.sessionDocument(
          manifest.project,
          manifest.sessionId,
          assignment.ordinal,
        )),
      ]);
      if (stableJson(projectMember) !== stableJson(assignment)
        || stableJson(sessionMember) !== stableJson(assignment)) {
        summary.scopeMismatches += 1;
        addVerificationSample(summary, {
          documentId: manifest.documentId,
          version: manifest.version,
          ordinal: assignment.ordinal,
          issue: "scope-mismatch",
        });
      }
      const [supersession, tombstone] = await Promise.all([
        store.get([KEYSPACE.SUPERSESSION, manifest.documentId, manifest.version]),
        store.get(derivedViewKeys.tombstone(manifest.project, assignment.ordinal)),
      ]);
      if ((supersession === undefined) !== (tombstone === undefined)
        || (supersession !== undefined
          && (tombstone.status !== supersession.status
            || tombstone.recordedAt !== supersession.recordedAt))) {
        summary.retirementMismatches += 1;
        addVerificationSample(summary, {
          documentId: manifest.documentId,
          version: manifest.version,
          ordinal: assignment.ordinal,
          issue: "retirement-mismatch",
        });
      }
    }
  } else {
    for (const { payload: assignment } of records) {
      if (project !== undefined && assignment.project !== project) continue;
      const [manifest, tombstone] = await Promise.all([
        store.get(manifestKeys.document(
          assignment.documentId,
          assignment.documentVersion,
        )),
        store.get(derivedViewKeys.tombstone(assignment.project, assignment.ordinal)),
      ]);
      if (manifest !== undefined || tombstone !== undefined) continue;
      summary.orphanLiveAssignments += 1;
      addVerificationSample(summary, {
        documentId: assignment.documentId,
        version: assignment.documentVersion,
        ordinal: assignment.ordinal,
        issue: "orphan-live-assignment",
      });
    }
  }
  return verificationResult(summary, {
    phase,
    scanned: records.length,
    complete: records.length < limit,
    ...(records.length === 0 ? {} : { nextAfter: records.at(-1).keyBytes }),
  });
}

/**
 * Compare one bounded page from each side of the ordinal substrate without
 * changing retrieval. Resumable maintenance uses verifyDerivedViewPage
 * directly; this aggregate helper preserves the diagnostic API.
 */
export async function verifyDerivedView(store, {
  project,
  limit = 100_000,
} = {}) {
  const [documents, assignments] = await Promise.all([
    verifyDerivedViewPage(store, { phase: "documents", project, limit }),
    verifyDerivedViewPage(store, { phase: "assignments", project, limit }),
  ]);
  const summary = emptyVerificationSummary();
  for (const result of [documents, assignments]) {
    summary.checked += result.checked;
    summary.missingAssignments += result.missingAssignments;
    summary.identityMismatches += result.identityMismatches;
    summary.scopeMismatches += result.scopeMismatches;
    summary.retirementMismatches += result.retirementMismatches;
    summary.orphanLiveAssignments += result.orphanLiveAssignments;
    for (const sample of result.samples) addVerificationSample(summary, sample);
  }
  return verificationResult(summary, {
    truncated: !documents.complete || !assignments.complete,
  });
}
