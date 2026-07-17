import { createHash } from "node:crypto";
import {
  assertStoreRequest,
  assertStoreResult,
} from "../store-contract.js";
import { KEYSPACE, keyFor } from "./keys.js";
import {
  contentHash,
  createChunkReferences,
  reconstructPhysicalChunks,
  splitPhysicalChunks,
  uniquePhysicalChunks,
} from "./chunks.js";
import {
  createSearchWindows,
  normalizeWindowOptions,
} from "./windows.js";
import { guardKeys } from "./guards.js";

export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_KEYSPACE = "manifest";
export const DOCUMENT_HISTORY_FORMAT_VERSION = 1;
export const AUXILIARY_MANIFEST_REFERENCE_VERSION = 1;

export class ManifestIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ManifestIntegrityError";
    this.code = "ERR_ROCKSDB_MANIFEST_INTEGRITY";
    this.details = details;
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer timestamp.`);
  }
  return value;
}

function identifiers(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = identifier(values[index], `${label}[${index}]`);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  if (!allowEmpty && result.length === 0) throw new TypeError(`${label} must not be empty.`);
  return Object.freeze(result);
}

function orderedIdentifiers(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const result = values.map((value, index) => identifier(value, `${label}[${index}]`));
  return Object.freeze(result);
}

function hashPart(hash, value) {
  const bytes = Buffer.from(String(value), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

/** A delimiter-safe deterministic identifier for immutable manifest records. */
export function deterministicManifestId(kind, ...identity) {
  const hash = createHash("sha256");
  hashPart(hash, identifier(kind, "kind"));
  for (const part of identity) hashPart(hash, part);
  return `${kind}:${hash.digest("hex")}`;
}

export const manifestKeys = Object.freeze({
  chunk(chunkId) {
    return [KEYSPACE.CHUNK, identifier(chunkId, "chunkId")];
  },
  chunkReference(chunkId, documentId, version, ordinal) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new TypeError("ordinal must be a non-negative safe integer.");
    }
    return [
      KEYSPACE.CHUNK_REFERENCE,
      identifier(chunkId, "chunkId"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      ordinal,
    ];
  },
  chunkReferencePrefix(chunkId) {
    return [KEYSPACE.CHUNK_REFERENCE, identifier(chunkId, "chunkId")];
  },
  document(documentId, version) {
    return [KEYSPACE.DOCUMENT, identifier(documentId, "documentId"), positiveInteger(version, "version")];
  },
  documentHistory(documentId) {
    return [
      KEYSPACE.META,
      "document-history",
      identifier(documentId, "documentId"),
    ];
  },
  documentAdmissionReference(documentId, version, requestId) {
    return [
      KEYSPACE.META,
      "document-admission-reference",
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      identifier(requestId, "requestId"),
    ];
  },
  documentAdmissionReferencePrefix(documentId, version) {
    return [
      KEYSPACE.META,
      "document-admission-reference",
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  sourceMessage(project, sessionId, sourceKey) {
    return [
      KEYSPACE.EVENT,
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(sourceKey, "sourceKey"),
    ];
  },
  sourceMessageReference(project, sessionId, sourceKey, documentId, version) {
    return [
      KEYSPACE.EVENT_REFERENCE,
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(sourceKey, "sourceKey"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  sourceMessageReferencePrefix(project, sessionId, sourceKey) {
    return [
      KEYSPACE.EVENT_REFERENCE,
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(sourceKey, "sourceKey"),
    ];
  },
  sessionDocumentReference(project, sessionId, documentId, version) {
    return [
      KEYSPACE.META,
      "session-document-reference",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  sessionDocumentReferencePrefix(project, sessionId) {
    return [
      KEYSPACE.META,
      "session-document-reference",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
    ];
  },
  window(documentId, version, ordinal) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new TypeError("ordinal must be a non-negative safe integer.");
    }
    return [KEYSPACE.WINDOW, identifier(documentId, "documentId"), positiveInteger(version, "version"), ordinal];
  },
  turn(manifestId, version) {
    return [MANIFEST_KEYSPACE, "turn", identifier(manifestId, "manifestId"), positiveInteger(version, "version")];
  },
  toolResult(manifestId, version) {
    return [MANIFEST_KEYSPACE, "tool-result", identifier(manifestId, "manifestId"), positiveInteger(version, "version")];
  },
  auxiliaryManifestReference(kind, manifestId, version, documentId, documentVersion) {
    if (kind !== "turn" && kind !== "tool-result") {
      throw new TypeError("kind must be turn or tool-result.");
    }
    return [
      MANIFEST_KEYSPACE,
      "reference",
      kind,
      identifier(manifestId, "manifestId"),
      positiveInteger(version, "version"),
      identifier(documentId, "documentId"),
      positiveInteger(documentVersion, "documentVersion"),
    ];
  },
  auxiliaryManifestReferencePrefix(kind, manifestId, version) {
    if (kind !== "turn" && kind !== "tool-result") {
      throw new TypeError("kind must be turn or tool-result.");
    }
    return [
      MANIFEST_KEYSPACE,
      "reference",
      kind,
      identifier(manifestId, "manifestId"),
      positiveInteger(version, "version"),
    ];
  },
  expiry(expiresAt, retentionClass, documentId, version) {
    timestamp(expiresAt, "expiresAt");
    return [
      KEYSPACE.EXPIRY,
      Math.floor(expiresAt / 3_600_000),
      identifier(retentionClass, "retentionClass"),
      expiresAt,
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
});

/** Resolve the shared turn/tool payload owned by a document manifest. */
export function auxiliaryManifestIdentityForDocument(manifest) {
  const reference = manifest?.auxiliaryManifestReference;
  if (reference !== undefined) {
    if (!reference || reference.referenceVersion !== AUXILIARY_MANIFEST_REFERENCE_VERSION
      || (reference.kind !== "turn" && reference.kind !== "tool-result")
      || typeof reference.manifestId !== "string" || reference.manifestId.length === 0
      || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
      throw new Error(
        `Document ${String(manifest?.documentId)}@${String(manifest?.version)} has malformed auxiliary manifest ownership.`,
      );
    }
    return Object.freeze({
      managed: true,
      kind: reference.kind,
      manifestId: reference.manifestId,
      version: reference.version,
      key: reference.kind === "turn"
        ? manifestKeys.turn(reference.manifestId, reference.version)
        : manifestKeys.toolResult(reference.manifestId, reference.version),
    });
  }
  if (manifest?.kind === "turn") {
    const turnId = typeof manifest.metadata?.turnId === "string"
      ? manifest.metadata.turnId
      : manifest.documentId;
    const manifestId = deterministicManifestId("turn", manifest.project, manifest.sessionId, turnId);
    return Object.freeze({
      managed: false,
      kind: "turn",
      manifestId,
      version: manifest.version,
      key: manifestKeys.turn(manifestId, manifest.version),
    });
  }
  if (manifest?.kind === "tool-result") {
    const toolCallId = typeof manifest.metadata?.toolCallId === "string"
      ? manifest.metadata.toolCallId
      : manifest.documentId;
    const manifestId = deterministicManifestId(
      "tool-result",
      manifest.project,
      manifest.sessionId,
      toolCallId,
    );
    return Object.freeze({
      managed: false,
      kind: "tool-result",
      manifestId,
      version: manifest.version,
      key: manifestKeys.toolResult(manifestId, manifest.version),
    });
  }
  return undefined;
}

/**
 * Create one immutable source-message identity without copying document text.
 * A source can participate in more than one document (for example, an
 * externalized tool result and its containing turn), so containment and chunk
 * coordinates live on document manifests rather than this shared identity.
 */
export function createSourceMessageRecord(document, sourceKey) {
  const key = identifier(sourceKey, "sourceKey");
  return deepFreeze({
    sourceMessageFormatVersion: MANIFEST_FORMAT_VERSION,
    eventId: deterministicManifestId("event", document.project, document.sessionId, key),
    sourceKey: key,
    sessionId: document.sessionId,
    project: document.project,
  });
}

/** Create the canonical document metadata and ordered physical occurrence manifest. */
export function createDocumentManifest(document, {
  chunks,
  retentionClass,
  expiresAt,
  protect = false,
  structuralMessages = [],
} = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError("A document manifest requires ordered chunk references.");
  }
  const sourceKeyStatus = document.sourceKeyStatus ?? "preserved";
  if (sourceKeyStatus !== "preserved" && sourceKeyStatus !== "unavailable") {
    throw new TypeError("sourceKeyStatus must be preserved or unavailable.");
  }
  const suppliedSourceKeys = document.sourceMessageKeys;
  if (sourceKeyStatus === "unavailable" && (suppliedSourceKeys?.length ?? 0) > 0) {
    throw new TypeError("Unavailable source provenance cannot contain sourceMessageKeys.");
  }
  const sourceMessageKeys = sourceKeyStatus === "unavailable"
    ? Object.freeze([])
    : orderedIdentifiers(
      suppliedSourceKeys === undefined ? [document.sourceKey] : suppliedSourceKeys,
      "sourceMessageKeys",
    );
  const byteLength = Buffer.byteLength(document.text, "utf8");
  const manifest = {
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    manifestId: deterministicManifestId("document", document.documentId, document.version),
    documentId: document.documentId,
    version: document.version,
    sourceKey: document.sourceKey,
    sourceKeyStatus,
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    metadata: structuredClone(document.metadata),
    sourceMessageKeys,
    contentHash: contentHash(document.text),
    byteLength,
    retentionClass: identifier(retentionClass, "retentionClass"),
    referenceIndexVersion: 1,
    protectedAtAdmission: protect === true,
    chunks: structuredClone(chunks),
    structuralMessages: structuredClone(structuralMessages),
  };
  if (document.subjectKey !== undefined) manifest.subjectKey = document.subjectKey;
  if (document.supersedes !== undefined) manifest.supersedes = structuredClone(document.supersedes);
  if (expiresAt !== undefined) manifest.expiresAt = timestamp(expiresAt, "expiresAt");
  return deepFreeze(manifest);
}

/** Build an ordered immutable turn manifest from already-canonical source events. */
export function createTurnManifest({
  manifestId,
  version = 1,
  sessionId,
  project,
  turnId,
  sourceEventIds,
  createdAt,
} = {}) {
  const normalizedSessionId = identifier(sessionId, "sessionId");
  const normalizedProject = identifier(project, "project");
  const normalizedTurnId = identifier(turnId, "turnId");
  const normalizedEvents = identifiers(sourceEventIds, "sourceEventIds", { allowEmpty: false });
  return deepFreeze({
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    manifestId: manifestId === undefined
      ? deterministicManifestId("turn", normalizedProject, normalizedSessionId, normalizedTurnId)
      : identifier(manifestId, "manifestId"),
    version: positiveInteger(version, "version"),
    sessionId: normalizedSessionId,
    project: normalizedProject,
    turnId: normalizedTurnId,
    sourceEventIds: normalizedEvents,
    createdAt: timestamp(createdAt, "createdAt"),
  });
}

/** Build an immutable tool-result manifest that refers to physical payloads once. */
export function createToolResultManifest({
  manifestId,
  version = 1,
  sessionId,
  project,
  toolCallId,
  parentTurnIds = [],
  chunkIds,
  createdAt,
} = {}) {
  const normalizedSessionId = identifier(sessionId, "sessionId");
  const normalizedProject = identifier(project, "project");
  const normalizedToolCallId = identifier(toolCallId, "toolCallId");
  return deepFreeze({
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    manifestId: manifestId === undefined
      ? deterministicManifestId("tool-result", normalizedProject, normalizedSessionId, normalizedToolCallId)
      : identifier(manifestId, "manifestId"),
    version: positiveInteger(version, "version"),
    sessionId: normalizedSessionId,
    project: normalizedProject,
    toolCallId: normalizedToolCallId,
    parentTurnIds: identifiers(parentTurnIds, "parentTurnIds"),
    // Duplicates are intentional when identical physical content occurs more
    // than once; array order is the source reconstruction order.
    chunkIds: Object.freeze(chunkIds.map((chunkId, index) => identifier(chunkId, `chunkIds[${index}]`))),
    createdAt: timestamp(createdAt, "createdAt"),
  });
}

function turnManifestForDocument(document, sourceMessages, explicit) {
  if (document.sourceKeyStatus === "unavailable" || sourceMessages.length === 0) return undefined;
  if (explicit === null) return undefined;
  if (explicit !== undefined) {
    return createTurnManifest({
      ...explicit,
      sessionId: document.sessionId,
      project: document.project,
      createdAt: document.createdAt,
      version: explicit.version ?? document.version,
    });
  }
  if (document.kind !== "turn") return undefined;
  return createTurnManifest({
    sessionId: document.sessionId,
    project: document.project,
    turnId: typeof document.metadata.turnId === "string"
      ? document.metadata.turnId
      : document.documentId,
    version: document.version,
    sourceEventIds: sourceMessages.map((message) => message.eventId),
    createdAt: document.createdAt,
  });
}

function parentTurnIds(metadata) {
  if (Array.isArray(metadata.parentTurnIds)) return metadata.parentTurnIds;
  for (const field of ["parentTurnId", "sourceTurnId", "turnId"]) {
    if (typeof metadata[field] === "string" && metadata[field].length > 0) return [metadata[field]];
  }
  return [];
}

function toolManifestForDocument(document, chunkReferences, explicit) {
  if (explicit === null) return undefined;
  if (explicit !== undefined) {
    return createToolResultManifest({
      ...explicit,
      sessionId: document.sessionId,
      project: document.project,
      createdAt: document.createdAt,
      version: explicit.version ?? document.version,
      chunkIds: chunkReferences.map((chunk) => chunk.chunkId),
    });
  }
  if (document.kind !== "tool-result") return undefined;
  return createToolResultManifest({
    sessionId: document.sessionId,
    project: document.project,
    toolCallId: typeof document.metadata.toolCallId === "string"
      ? document.metadata.toolCallId
      : document.documentId,
    parentTurnIds: parentTurnIds(document.metadata),
    version: document.version,
    chunkIds: chunkReferences.map((chunk) => chunk.chunkId),
    createdAt: document.createdAt,
  });
}

function canonicalRecord(key, kind, payload) {
  return Object.freeze({ key, kind, payload });
}

function validateDocumentHistory(history, documentId, project) {
  if (history === undefined) return undefined;
  if (!history || history.documentHistoryFormatVersion !== DOCUMENT_HISTORY_FORMAT_VERSION
    || history.documentId !== documentId || history.project !== project
    || !Number.isSafeInteger(history.highestAdmittedVersion)
    || history.highestAdmittedVersion <= 0
    || !Number.isSafeInteger(history.retiredThrough)
    || history.retiredThrough < 0
    || history.retiredThrough > history.highestAdmittedVersion) {
    throw new ManifestIntegrityError(`Document history for ${documentId} is malformed or belongs to another project.`);
  }
  return history;
}

/** One bounded record preserves version monotonicity after detailed tombstones are reclaimed. */
export function admittedDocumentHistory(document) {
  return deepFreeze({
    documentHistoryFormatVersion: DOCUMENT_HISTORY_FORMAT_VERSION,
    documentId: identifier(document.documentId, "documentId"),
    project: identifier(document.project, "project"),
    highestAdmittedVersion: positiveInteger(document.version, "version"),
    retiredThrough: document.version - 1,
  });
}

/** Advance a document's bounded ledger when one canonical version becomes retired. */
export function retiredDocumentHistory(history, manifest, highestKnownVersion = manifest.version) {
  const current = validateDocumentHistory(history, manifest.documentId, manifest.project);
  const highest = Math.max(
    current?.highestAdmittedVersion ?? 0,
    positiveInteger(highestKnownVersion, "highestKnownVersion"),
    positiveInteger(manifest.version, "manifest.version"),
  );
  return deepFreeze({
    documentHistoryFormatVersion: DOCUMENT_HISTORY_FORMAT_VERSION,
    documentId: manifest.documentId,
    project: manifest.project,
    highestAdmittedVersion: highest,
    // Admissions are sequential. If a later version exists, every preceding
    // version is necessarily retired even when this store predates ledgers.
    retiredThrough: Math.max(current?.retiredThrough ?? 0, manifest.version, highest - 1),
  });
}

/** Classify a missing exact version using only the compact durable ledger. */
export function retiredDocumentStatus(history, version = history?.highestAdmittedVersion) {
  if (!history || history.documentHistoryFormatVersion !== DOCUMENT_HISTORY_FORMAT_VERSION
    || !Number.isSafeInteger(version) || version <= 0
    || !Number.isSafeInteger(history.retiredThrough)
    || version > history.retiredThrough) {
    return undefined;
  }
  const status = version < history.highestAdmittedVersion ? "superseded" : "expired";
  return Object.freeze({
    status,
    documentId: history.documentId,
    version,
    reason: status === "superseded"
      ? "The exact archived document version has been retired by a later version."
      : "The exact archived document version has been retired by retention.",
  });
}

function assertCallerAdmissionOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Admission options must be an object.");
  }
  if ("semanticSupersession" in options || "semanticTargetManifest" in options) {
    throw new TypeError("Semantic admission state is reserved for validated internal use.");
  }
}

function prepareDocumentAdmissionCore(request, options = {}, semanticState = {}) {
  assertStoreRequest("store.put", request);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Admission options must be an object.");
  }
  const document = request.document;
  const physicalOccurrences = splitPhysicalChunks(document.text, options.chunking);
  const chunks = createChunkReferences(physicalOccurrences);
  const physicalChunks = uniquePhysicalChunks(physicalOccurrences);
  const windowParameters = normalizeWindowOptions(options.windows);
  const windows = createSearchWindows({
    text: document.text,
    documentId: document.documentId,
    documentVersion: document.version,
    chunks,
    indexGeneration: options.indexGeneration ?? 0,
  }, { ...windowParameters, tokenize: options.windows?.tokenize });
  let manifest = createDocumentManifest(document, {
    chunks,
    retentionClass: request.retentionClass,
    expiresAt: request.expiresAt,
    protect: request.protect,
    structuralMessages: request.structuralMessages ?? [],
  });
  const sourceMessages = [...new Set(manifest.sourceMessageKeys)].map(
    (sourceKey) => createSourceMessageRecord(document, sourceKey),
  );
  const turnManifest = turnManifestForDocument(document, sourceMessages, options.turnManifest);
  const toolResultManifest = toolManifestForDocument(document, chunks, options.toolResultManifest);
  const auxiliaryManifest = turnManifest === undefined
    ? (toolResultManifest === undefined ? undefined : { kind: "tool-result", payload: toolResultManifest })
    : { kind: "turn", payload: turnManifest };
  if (auxiliaryManifest !== undefined) {
    manifest = deepFreeze({
      ...manifest,
      auxiliaryManifestReference: {
        referenceVersion: AUXILIARY_MANIFEST_REFERENCE_VERSION,
        kind: auxiliaryManifest.kind,
        manifestId: auxiliaryManifest.payload.manifestId,
        version: auxiliaryManifest.payload.version,
      },
    });
  }

  const records = [];
  if (options.supersession !== undefined) {
    const marker = options.supersession;
    if (!marker || marker.documentId !== document.documentId
      || marker.replacementVersion !== document.version
      || marker.documentVersion >= marker.replacementVersion
      || marker.status !== "superseded") {
      throw new TypeError("Admission supersession must replace an older version of the admitted document.");
    }
    records.push(canonicalRecord(
      [KEYSPACE.SUPERSESSION, marker.documentId, marker.documentVersion],
      "supersession",
      deepFreeze(structuredClone(marker)),
    ));
  }
  if (semanticState.semanticSupersession !== undefined) {
    const marker = semanticState.semanticSupersession;
    if (!marker || marker.documentId === document.documentId
      || marker.replacementDocumentId !== document.documentId
      || marker.replacementVersion !== document.version
      || marker.status !== "superseded"
      || marker.supersessionType !== "explicit") {
      throw new TypeError("Explicit admission supersession must name a different exact target and the admitted replacement.");
    }
    records.push(canonicalRecord(
      [KEYSPACE.SUPERSESSION, marker.documentId, marker.documentVersion],
      "supersession",
      deepFreeze(structuredClone(marker)),
    ));
  }
  for (const chunk of physicalChunks) {
    records.push(canonicalRecord(manifestKeys.chunk(chunk.chunkId), "physical-chunk", chunk));
  }
  for (const reference of chunks) {
    records.push(canonicalRecord(
      manifestKeys.chunkReference(
        reference.chunkId,
        document.documentId,
        document.version,
        reference.ordinal,
      ),
      "physical-chunk-reference",
      deepFreeze({
        chunkId: reference.chunkId,
        documentId: document.documentId,
        documentVersion: document.version,
        ordinal: reference.ordinal,
      }),
    ));
  }
  for (const sourceMessage of sourceMessages) {
    records.push(canonicalRecord(
      manifestKeys.sourceMessage(sourceMessage.project, sourceMessage.sessionId, sourceMessage.sourceKey),
      "source-message",
      sourceMessage,
    ));
    records.push(canonicalRecord(
      manifestKeys.sourceMessageReference(
        sourceMessage.project,
        sourceMessage.sessionId,
        sourceMessage.sourceKey,
        document.documentId,
        document.version,
      ),
      "source-message-reference",
      deepFreeze({
        eventId: sourceMessage.eventId,
        project: sourceMessage.project,
        sessionId: sourceMessage.sessionId,
        sourceKey: sourceMessage.sourceKey,
        documentId: document.documentId,
        documentVersion: document.version,
      }),
    ));
  }
  records.push(canonicalRecord(
    manifestKeys.document(document.documentId, document.version),
    "document-manifest",
    manifest,
  ));
  records.push(canonicalRecord(
    manifestKeys.documentAdmissionReference(
      document.documentId,
      document.version,
      request.idempotencyKey,
    ),
    "document-admission-reference",
    deepFreeze({
      documentId: document.documentId,
      documentVersion: document.version,
      requestId: request.idempotencyKey,
    }),
  ));
  records.push(canonicalRecord(
    manifestKeys.sessionDocumentReference(
      document.project,
      document.sessionId,
      document.documentId,
      document.version,
    ),
    "session-document-reference",
    deepFreeze({
      project: document.project,
      sessionId: document.sessionId,
      documentId: document.documentId,
      documentVersion: document.version,
    }),
  ));
  for (const window of windows) {
    records.push(canonicalRecord(
      manifestKeys.window(document.documentId, document.version, window.ordinal),
      "search-window",
      window,
    ));
  }
  if (turnManifest) {
    records.push(canonicalRecord(
      manifestKeys.turn(turnManifest.manifestId, turnManifest.version),
      "turn-manifest",
      turnManifest,
    ));
  }
  if (toolResultManifest) {
    records.push(canonicalRecord(
      manifestKeys.toolResult(toolResultManifest.manifestId, toolResultManifest.version),
      "tool-result-manifest",
      toolResultManifest,
    ));
  }
  if (auxiliaryManifest !== undefined) {
    records.push(canonicalRecord(
      manifestKeys.auxiliaryManifestReference(
        auxiliaryManifest.kind,
        auxiliaryManifest.payload.manifestId,
        auxiliaryManifest.payload.version,
        document.documentId,
        document.version,
      ),
      "auxiliary-manifest-reference",
      deepFreeze({
        referenceVersion: AUXILIARY_MANIFEST_REFERENCE_VERSION,
        kind: auxiliaryManifest.kind,
        manifestId: auxiliaryManifest.payload.manifestId,
        manifestVersion: auxiliaryManifest.payload.version,
        documentId: document.documentId,
        documentVersion: document.version,
      }),
    ));
  }
  if (request.expiresAt !== undefined) {
    records.push(canonicalRecord(
      manifestKeys.expiry(
        request.expiresAt,
        request.retentionClass,
        document.documentId,
        document.version,
      ),
      "expiry",
      deepFreeze({
        documentId: document.documentId,
        documentVersion: document.version,
        retentionClass: request.retentionClass,
        expiresAt: request.expiresAt,
      }),
    ));
  }

  return deepFreeze({
    requestId: request.idempotencyKey,
    records,
    outbox: {
      payload: {
        operation: "index",
        documentId: document.documentId,
        documentVersion: document.version,
        sourceVersion: document.version,
        admittedAt: document.createdAt,
      },
    },
    manifest,
    sourceMessages,
    turnManifest,
    toolResultManifest,
    physicalChunks,
    chunks,
    windows,
    chunking: options.chunking === undefined ? undefined : { ...options.chunking },
    windowParameters,
    transitions: [{
      key: manifestKeys.documentHistory(document.documentId),
      kind: "document-history",
      previous: options.documentHistory,
      payload: admittedDocumentHistory(document),
    }],
    mustBeAbsent: [
      [KEYSPACE.SUPERSESSION, document.documentId, document.version],
      ...(options.supersession === undefined
        ? []
        : [[KEYSPACE.SUPERSESSION, document.documentId, options.supersession.documentVersion]]),
      ...(semanticState.semanticSupersession === undefined
        ? []
        : [[
            KEYSPACE.SUPERSESSION,
            semanticState.semanticSupersession.documentId,
            semanticState.semanticSupersession.documentVersion,
          ]]),
    ],
    mustMatch: semanticState.semanticTargetManifest === undefined
      ? []
      : [canonicalRecord(
          manifestKeys.document(
            semanticState.semanticTargetManifest.documentId,
            semanticState.semanticTargetManifest.version,
          ),
          "document-manifest",
          semanticState.semanticTargetManifest,
        )],
    guards: [
      ...physicalChunks.map((chunk) => guardKeys.chunk(chunk.chunkId)),
      ...sourceMessages.map((sourceMessage) => guardKeys.sourceMessage(
        sourceMessage.project,
        sourceMessage.sessionId,
        sourceMessage.sourceKey,
      )),
      guardKeys.document(document.documentId, document.version),
      guardKeys.session(document.sessionId),
      ...(auxiliaryManifest === undefined
        ? []
        : [guardKeys.auxiliaryManifest(
            auxiliaryManifest.kind,
            auxiliaryManifest.payload.manifestId,
            auxiliaryManifest.payload.version,
          )]),
      ...(options.supersession === undefined
        ? []
        : [guardKeys.document(document.documentId, options.supersession.documentVersion)]),
      ...(semanticState.semanticSupersession === undefined
        ? []
        : [guardKeys.document(
            semanticState.semanticSupersession.documentId,
            semanticState.semanticSupersession.documentVersion,
          )]),
    ],
  });
}

function prepareValidatedDocumentAdmission(request, options, state) {
  const {
    semanticSupersession,
    semanticTargetManifest,
    ...validatedVersionState
  } = state;
  return prepareDocumentAdmissionCore(
    request,
    { ...options, ...validatedVersionState },
    { semanticSupersession, semanticTargetManifest },
  );
}

/**
 * Validate a `store.put` request and deterministically map it to canonical
 * records. No RocksDB state is touched until the returned request is passed to
 * `RocksStore.commitCanonical`.
 */
export function prepareDocumentAdmission(request, options = {}) {
  assertCallerAdmissionOptions(options);
  assertStoreRequest("store.put", request);
  if (request.document.supersedes !== undefined) {
    throw new TypeError(
      "Explicit supersession requires store-aware validation; use admitDocument instead of prepareDocumentAdmission.",
    );
  }
  return prepareDocumentAdmissionCore(request, options);
}

const admissionQueues = new WeakMap();

async function serializeAdmission(store, documentId, callback) {
  let queues = admissionQueues.get(store);
  if (queues === undefined) {
    queues = new Map();
    admissionQueues.set(store, queues);
  }
  const previous = queues.get(documentId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queues.set(documentId, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (queues.get(documentId) === current) queues.delete(documentId);
  }
}

function admissionConflict(marker, document) {
  const error = new Error(
    `Document ${document.documentId}@${document.version} is already ${marker.status}.`,
  );
  error.code = marker.status === "expired" ? "EXPIRED" : "SUPERSEDED";
  return error;
}

async function admissionSupersession(store, request) {
  const document = request.document;
  const documentHistory = await store.get(manifestKeys.documentHistory(document.documentId));
  if (documentHistory !== undefined && documentHistory.project !== document.project) {
    const error = new Error(`Document ${document.documentId} already belongs to another project.`);
    error.code = "CONFLICT";
    throw error;
  }
  validateDocumentHistory(documentHistory, document.documentId, document.project);
  const committed = await store.get(keyFor.idempotency(request.idempotencyKey));
  if (committed !== undefined) {
    if (document.version <= 1) return { documentHistory, supersession: undefined };
    const prior = await store.get([
      KEYSPACE.SUPERSESSION,
      document.documentId,
      document.version - 1,
    ]);
    return {
      documentHistory,
      supersession: prior?.status === "superseded" && prior.replacementVersion === document.version
        ? prior
        : undefined,
    };
  }
  const retired = retiredDocumentStatus(documentHistory, document.version);
  if (retired !== undefined) {
    throw admissionConflict(retired, document);
  }
  if (documentHistory !== undefined
    && document.version !== documentHistory.highestAdmittedVersion
    && document.version !== documentHistory.highestAdmittedVersion + 1) {
    const error = new Error(
      `Document ${document.documentId} version ${document.version} does not follow durable version ${documentHistory.highestAdmittedVersion}.`,
    );
    error.code = "CONFLICT";
    throw error;
  }
  const targetMarker = await store.get([
    KEYSPACE.SUPERSESSION,
    document.documentId,
    document.version,
  ]);
  if (targetMarker !== undefined) throw admissionConflict(targetMarker, document);
  const versions = store.scan([KEYSPACE.DOCUMENT, document.documentId], {
    reverse: true,
    limit: 1,
  });
  const latest = versions[0]?.payload;
  if (latest === undefined || document.version <= latest.version) {
    if (document.version <= 1) return { documentHistory, supersession: undefined };
    const prior = await store.get([
      KEYSPACE.SUPERSESSION,
      document.documentId,
      document.version - 1,
    ]);
    return {
      documentHistory,
      supersession: prior?.status === "superseded" && prior.replacementVersion === document.version
        ? prior
        : undefined,
    };
  }
  if (document.version !== latest.version + 1) {
    const error = new Error(
      `Document ${document.documentId} version ${document.version} does not follow current version ${latest.version}.`,
    );
    error.code = "CONFLICT";
    throw error;
  }
  const existing = await store.get([
    KEYSPACE.SUPERSESSION,
    latest.documentId,
    latest.version,
  ]);
  if (existing !== undefined) return { documentHistory, supersession: undefined };
  return {
    documentHistory,
    supersession: Object.freeze({
      documentId: latest.documentId,
      documentVersion: latest.version,
      status: "superseded",
      replacementVersion: document.version,
      reason: `Replaced by immutable document version ${document.version}.`,
      recordedAt: Date.now(),
    }),
  };
}

function semanticAdmissionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactTarget(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.documentId !== "string" || value.documentId.length === 0
    || !Number.isSafeInteger(value.version) || value.version <= 0) {
    throw new ManifestIntegrityError(`${label} is not a valid exact document target.`);
  }
  return value;
}

function markerReplaces(marker, document) {
  return marker?.status === "superseded"
    && marker.supersessionType === "explicit"
    && marker.replacementDocumentId === document.documentId
    && marker.replacementVersion === document.version;
}

/** Validate one explicit semantic edge against canonical state before commit. */
async function admissionExplicitSupersession(store, request) {
  const document = request.document;
  const target = document.supersedes;
  if (target === undefined) return {};
  if (target.documentId === document.documentId) {
    throw semanticAdmissionError(
      "CONFLICT",
      "Explicit supersession must target a different document; same-document versions supersede automatically.",
    );
  }

  const targetKey = [KEYSPACE.SUPERSESSION, target.documentId, target.version];
  const committed = await store.get(keyFor.idempotency(request.idempotencyKey));
  const existingMarker = await store.get(targetKey);
  if (committed !== undefined) {
    if (!markerReplaces(existingMarker, document)) {
      throw semanticAdmissionError(
        "CONFLICT",
        `Idempotency record ${request.idempotencyKey} does not own the requested semantic supersession.`,
      );
    }
    return { semanticSupersession: existingMarker };
  }
  if (existingMarker !== undefined) {
    throw semanticAdmissionError(
      existingMarker.status === "expired" ? "EXPIRED" : "SUPERSEDED",
      `Explicit supersession target ${target.documentId}@${target.version} is not live.`,
    );
  }

  const targetManifest = await store.get(manifestKeys.document(target.documentId, target.version));
  if (targetManifest === undefined) {
    throw semanticAdmissionError(
      "NOT_FOUND",
      `Explicit supersession target ${target.documentId}@${target.version} does not exist.`,
    );
  }
  if (targetManifest.project !== document.project) {
    throw semanticAdmissionError("CONFLICT", "Explicit supersession cannot cross project boundaries.");
  }
  if (!Number.isSafeInteger(targetManifest.createdAt)
    || targetManifest.createdAt >= document.createdAt) {
    throw semanticAdmissionError(
      "CONFLICT",
      "Explicit supersession target must be older than its replacement.",
    );
  }
  if (targetManifest.subjectKey !== undefined
    && targetManifest.subjectKey !== document.subjectKey) {
    throw semanticAdmissionError(
      "CONFLICT",
      "A stable subjectKey cannot be changed or omitted by an explicit replacement.",
    );
  }

  const visited = new Set();
  let cursor = targetManifest;
  for (let depth = 0; cursor?.supersedes !== undefined; depth += 1) {
    if (depth >= 4_096) {
      throw semanticAdmissionError("CONFLICT", "Explicit supersession chain exceeds the validation bound.");
    }
    const predecessor = exactTarget(cursor.supersedes, "Stored explicit supersession");
    if (predecessor.documentId === document.documentId) {
      throw semanticAdmissionError("CONFLICT", "Explicit supersession would create a cycle.");
    }
    const identity = `${predecessor.documentId}\u0000${predecessor.version}`;
    if (visited.has(identity)) {
      throw semanticAdmissionError("CONFLICT", "Stored explicit supersession chain contains a cycle.");
    }
    visited.add(identity);
    cursor = await store.get(manifestKeys.document(predecessor.documentId, predecessor.version));
    if (cursor === undefined || cursor.project !== document.project) {
      throw new ManifestIntegrityError("Stored explicit supersession chain has missing or foreign provenance.");
    }
  }

  const subjectKey = document.subjectKey ?? targetManifest.subjectKey;
  return {
    semanticTargetManifest: targetManifest,
    semanticSupersession: Object.freeze({
      documentId: target.documentId,
      documentVersion: target.version,
      status: "superseded",
      replacementDocumentId: document.documentId,
      replacementVersion: document.version,
      project: document.project,
      ...(subjectKey === undefined ? {} : { subjectKey }),
      supersessionType: "explicit",
      reason: `Explicitly replaced by immutable document ${document.documentId}@${document.version}.`,
      recordedAt: document.createdAt,
    }),
  };
}

const semanticAdmissionQueues = new WeakMap();

async function serializeSemanticAdmission(store, callback) {
  const previous = semanticAdmissionQueues.get(store) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  semanticAdmissionQueues.set(store, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (semanticAdmissionQueues.get(store) === current) semanticAdmissionQueues.delete(store);
  }
}

async function documentAdmissionState(store, request, { diagnostic = false } = {}) {
  const versionState = request.document.version === 1 && !diagnostic
    ? { documentHistory: undefined, supersession: undefined }
    : await admissionSupersession(store, request);
  return {
    ...versionState,
    ...await admissionExplicitSupersession(store, request),
  };
}

/** Admit one validated document at RocksStore's atomic acknowledgement boundary. */
export async function admitDocument(store, request, options = {}) {
  if (!store || typeof store.commitCanonical !== "function") {
    throw new TypeError("admitDocument requires a RocksStore-compatible commitCanonical method.");
  }
  assertStoreRequest("store.put", request);
  assertCallerAdmissionOptions(options);
  const execute = () => serializeAdmission(store, request.document.documentId, async () => {
    // New version-one identities are the dominant append path. Their history
    // transition and supersession absence are compare-and-set preconditions in
    // the canonical transaction, so avoid four redundant point/range reads.
    // On a genuine state conflict, take the full diagnostic path to preserve
    // precise expired/superseded/project errors and then retry safely.
    let state = await documentAdmissionState(store, request);
    let prepared = prepareValidatedDocumentAdmission(request, options, state);
    let result;
    try {
      result = await store.commitCanonical(prepared);
    } catch (error) {
      if (request.document.version !== 1
        || (error?.code !== "CONFLICT" && error?.code !== "SUPERSEDED")) throw error;
      state = await documentAdmissionState(store, request, { diagnostic: true });
      prepared = prepareValidatedDocumentAdmission(request, options, state);
      result = await store.commitCanonical(prepared);
    }
    return assertStoreResult("store.put", {
      status: result.duplicate ? "duplicate" : "stored",
      documentId: request.document.documentId,
      version: request.document.version,
      sourceKey: request.document.sourceKey,
      outboxSequence: result.outboxSequence,
    });
  });
  return request.document.supersedes === undefined
    ? execute()
    : serializeSemanticAdmission(store, execute);
}

async function physicalOccurrence(view, reference, cache) {
  let chunk = cache.get(reference.chunkId);
  if (chunk === undefined) {
    chunk = await view.get(manifestKeys.chunk(reference.chunkId));
    if (chunk !== undefined) cache.set(reference.chunkId, chunk);
  }
  if (chunk === undefined) {
    throw new ManifestIntegrityError(`Physical chunk ${reference.chunkId} is missing.`, {
      chunkId: reference.chunkId,
    });
  }
  return {
    ...reference,
    contentHash: chunk.contentHash,
    encoding: chunk.encoding,
    content: chunk.content,
  };
}

/** Materialize byte-identical source text from a canonical document manifest. */
export async function reconstructDocumentText(view, manifest) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("reconstructDocumentText requires a store or snapshot view.");
  }
  if (!manifest || manifest.manifestFormatVersion !== MANIFEST_FORMAT_VERSION
    || !Array.isArray(manifest.chunks)) {
    throw new ManifestIntegrityError("The supplied value is not a supported document manifest.");
  }
  const cache = new Map();
  const occurrences = [];
  for (const reference of manifest.chunks) {
    occurrences.push(await physicalOccurrence(view, reference, cache));
  }
  const text = reconstructPhysicalChunks(occurrences);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes !== manifest.byteLength || contentHash(text) !== manifest.contentHash) {
    throw new ManifestIntegrityError(`Document ${manifest.documentId} reconstruction failed its manifest digest.`);
  }
  return text;
}

/** Read and reconstruct one exact immutable document version. */
export async function readCanonicalDocument(view, documentId, version) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("readCanonicalDocument requires a store or snapshot view.");
  }
  const manifest = await view.get(manifestKeys.document(documentId, version));
  if (manifest === undefined) return undefined;
  const text = await reconstructDocumentText(view, manifest);
  return deepFreeze({
    documentId: manifest.documentId,
    version: manifest.version,
    sourceKey: manifest.sourceKey,
    sourceKeyStatus: manifest.sourceKeyStatus,
    sessionId: manifest.sessionId,
    project: manifest.project,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    text,
    metadata: structuredClone(manifest.metadata),
    sourceMessageKeys: [...manifest.sourceMessageKeys],
    ...(manifest.subjectKey === undefined ? {} : { subjectKey: manifest.subjectKey }),
    ...(manifest.supersedes === undefined
      ? {}
      : { supersedes: structuredClone(manifest.supersedes) }),
  });
}
