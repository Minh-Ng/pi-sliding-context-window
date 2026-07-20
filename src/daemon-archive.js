import { createHash, randomUUID } from "node:crypto";
import { archiveDocumentProvenance } from "./provenance.js";
import { canonicalDocumentIdentityHash } from "./document-identity.js";
import { defaultSocketPath, resolveStorePath } from "./daemon/paths.js";
import {
  normalizeArchiveRetentionPolicy,
  retentionForAdmission,
} from "./daemon/retention-policy.js";
import {
  DAEMON_REQUIRED_CAPABILITIES,
  DAEMON_RUNTIME_VERSION,
} from "./daemon/runtime-version.js";
import { SynchronousStoreBridge } from "./daemon-client/sync-bridge.js";
import { stableJson } from "./rocksdb/schema.js";
import {
  MAX_SESSION_LINEAGE_IDS,
  MAX_PROTECTED_DOCUMENT_VERSIONS,
  MAX_RECALL_TOKENS,
  MAX_STORE_IDENTIFIER_LENGTH,
  MAX_VISIBLE_SOURCE_KEYS,
  STORE_OPERATION_CONTRACTS,
  assertActiveHintMessageKeys,
  assertContract,
  assertVisibleSourceKeys,
} from "./store-contract.js";

const PROTECTION_LEASE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const MAX_RETENTION_WAVES = 100;
const DEFAULT_RECALL_MAX_TOKENS = 16_000;
const MAX_REMEMBERED_LOCATORS = 4_096;
const MAX_REMEMBERED_LOCATOR_BYTES = 1 * 1_024 * 1_024;
const PROTECTION_HANDOFF_PREFIX = "protection-handoff:v1:";
const MAX_PROTECTION_HANDOFF_OWNERS = 131_072;
const MAX_PROTECTION_HANDOFF_BYTES = 16 * 1_024 * 1_024;
const PREFLIGHT_REQUEST_FIELDS = new Set(Object.keys(
  STORE_OPERATION_CONTRACTS["store.preflight"].request.properties,
));
const PREFLIGHT_NUMERIC_POLICY_FIELDS = Object.freeze([
  "hintBudgetTokens",
  "activeHintBudgetTokens",
  "hintSourceCooldownMs",
  "ephemeralAutoRetrievalDays",
  "conversationAutoRetrievalDays",
  "derivedAutoRetrievalDays",
  "epochBudgetTokens",
]);

export class ArchiveMigrationGuardError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "ArchiveMigrationGuardError";
    this.code = "MIGRATION_REQUIRED";
    this.retryable = false;
    this.details = details;
  }
}

function hashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function protectionShardOwner(ownerId, shardIndex, shard, shardCount, sessionIds) {
  if (shardCount === 1) return ownerId;
  // Each store.protect call replaces one owner's complete set. Content-addressed
  // shard owners let a changed aggregate become complete before stale owners are
  // released, while an unchanged heartbeat reuses the same deterministic IDs.
  return `protection-shard:${hashParts([
    ownerId,
    shardIndex,
    ...(shardIndex === 0 ? ["sessions", ...sessionIds] : []),
    "documents",
    ...shard.flatMap(({ documentId, version }) => [documentId, version]),
  ])}`;
}

function protectionHandoffId(ownerId, physicalOwners) {
  const owners = [...new Set(physicalOwners)];
  if (owners.length === 0 || (owners.length === 1 && owners[0] === ownerId)) {
    return ownerId;
  }
  if (owners.length > MAX_PROTECTION_HANDOFF_OWNERS) {
    throw new RangeError("Protection handoff contains too many physical owners.");
  }
  const encoded = Buffer.from(JSON.stringify(owners), "utf8").toString("base64url");
  const handoffId = `${PROTECTION_HANDOFF_PREFIX}${encoded}`;
  if (Buffer.byteLength(handoffId, "utf8") > MAX_PROTECTION_HANDOFF_BYTES) {
    throw new RangeError("Protection handoff exceeds the local transfer limit.");
  }
  return handoffId;
}

function protectionHandoffOwners(value) {
  if (!value.startsWith(PROTECTION_HANDOFF_PREFIX)) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_PROTECTION_HANDOFF_BYTES) {
    throw new TypeError("Protection handoff is too large.");
  }
  const encoded = value.slice(PROTECTION_HANDOFF_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new TypeError("Protection handoff is malformed.");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new TypeError("Protection handoff is malformed.");
  }
  let owners;
  try {
    owners = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new TypeError("Protection handoff is malformed.");
  }
  if (!Array.isArray(owners)
    || owners.length === 0
    || owners.length > MAX_PROTECTION_HANDOFF_OWNERS
    || owners.some((owner) => (
      typeof owner !== "string"
      || owner.length === 0
      || Buffer.byteLength(owner, "utf8") > MAX_STORE_IDENTIFIER_LENGTH
    ))
    || new Set(owners).size !== owners.length) {
    throw new TypeError("Protection handoff is malformed.");
  }
  return owners;
}

function compareDocumentVersions(left, right) {
  if (left.documentId < right.documentId) return -1;
  if (left.documentId > right.documentId) return 1;
  return left.version - right.version;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function timestamp(value, fallback = Date.now()) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : fallback;
}

function normalizedVisibleSourceKeys(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_VISIBLE_SOURCE_KEYS) {
    // The shared validator checks maxItems before inspecting entries, so an
    // oversized caller array is rejected without first copying or coercing it.
    assertVisibleSourceKeys(value);
  }
  const normalized = value.filter(Boolean).map(String);
  assertVisibleSourceKeys(normalized);
  return normalized;
}

function validatedActiveHintMessageKeys(value) {
  assertActiveHintMessageKeys(value);
  return [...value];
}

function assertPreflightRequestFields(request) {
  const unknown = Object.keys(request)
    .filter((field) => !PREFLIGHT_REQUEST_FIELDS.has(field))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`preflight request.${unknown[0]} is not an allowed field.`);
  }
}

function assertPreflightNumericPolicyFields(request) {
  const properties = STORE_OPERATION_CONTRACTS["store.preflight"].request.properties;
  for (const field of PREFLIGHT_NUMERIC_POLICY_FIELDS) {
    if (!Object.hasOwn(request, field)) continue;
    assertContract(properties[field], request[field], { path: `$.${field}` });
  }
}

function jsonMetadata(value) {
  if (value === undefined) return {};
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return {};
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("metadata must serialize to a JSON object.");
  }
  return parsed;
}

function semanticTarget(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("supersedes must be an object.");
  }
  // Preserve unknown fields so the shared wire contract rejects them rather
  // than silently weakening an explicit invalidation request.
  return structuredClone(value);
}

function sourceIdentity(documentId, version, metadata) {
  const turnKeys = Array.isArray(metadata.sourceMessageKeys)
    ? metadata.sourceMessageKeys.filter((key) => typeof key === "string" && key.length > 0)
    : [];
  const toolKey = typeof metadata.sourceMessageKey === "string" && metadata.sourceMessageKey
    ? metadata.sourceMessageKey
    : undefined;
  const keys = turnKeys.length > 0 ? turnKeys : (toolKey ? [toolKey] : []);
  if (keys.length > 0) {
    return {
      sourceKey: keys[0],
      sourceKeyStatus: "preserved",
      sourceMessageKeys: keys,
    };
  }
  return {
    // DOCUMENT_SCHEMA requires an internal identity even when legacy source
    // provenance was never recorded. sourceKeyStatus prevents that identity
    // from being presented as source evidence.
    sourceKey: `unavailable:${hashParts([documentId, version])}`,
    sourceKeyStatus: "unavailable",
    sourceMessageKeys: [],
  };
}

function score(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(number)));
}

function normalizeStructuralMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message, index) => {
    const role = ["user", "assistant", "system", "tool", "unknown"].includes(message?.role)
      ? message.role
      : "unknown";
    return {
      messageKey: requiredString(String(message?.messageKey ?? `message:${index}`), "messageKey"),
      messageIndex: Number.isSafeInteger(message?.messageIndex) && message.messageIndex >= 0
        ? message.messageIndex
        : index,
      role,
      createdAt: timestamp(message?.createdAt, 0),
      text: role === "user" || role === "assistant" ? String(message?.text ?? "") : "",
      questionScore: score(message?.questionScore),
      requestScore: score(message?.requestScore),
      correctionScore: score(message?.correctionScore),
      answerScore: score(message?.answerScore),
    };
  });
}

function documentComparable(document) {
  return stableJson({
    documentId: document.documentId,
    version: document.version,
    sourceKey: document.sourceKey,
    sourceKeyStatus: document.sourceKeyStatus ?? "preserved",
    sourceMessageKeys: document.sourceMessageKeys ?? [],
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    text: document.text,
    metadata: document.metadata,
    subjectKey: document.subjectKey,
    supersedes: document.supersedes,
  });
}

function directChunkTableText(document) {
  const lines = [
    `Archived source ${document.documentId}@${document.version} is ${document.byteLength} UTF-8 byte(s) and was not materialized in this direct response.`,
    `Content SHA-256: ${document.contentHash}`,
    `Chunk table (${document.chunkTable.length} of ${document.chunkCount} occurrence(s)):`,
    ...document.chunkTable.map((chunk) => (
      `- ${chunk.ordinal}: bytes ${chunk.startByte}-${chunk.endByte} (${chunk.byteLength}); ${chunk.chunkId}`
    )),
  ];
  if (document.chunkTableTruncated) {
    lines.push(`- Table truncated after ${document.chunkTable.length} occurrence(s).`);
  }
  return lines.join("\n");
}

function directChunkTableProvenance(document, metadataParse) {
  let sourceMessages;
  if (document.sourceKeyStatus === "unavailable" || document.sourceMessageKeyCount === 0) {
    sourceMessages = {
      status: "unavailable",
      reason: "No stable source message keys were recorded for this archive document.",
    };
  } else {
    sourceMessages = {
      status: "available",
      keys: [...document.sourceMessageKeys],
      firstKey: document.sourceMessageKeys[0],
      lastKey: document.sourceMessageKeys.at(-1),
      count: document.sourceMessageKeyCount,
      ...(document.sourceMessageKeysTruncated ? { truncated: true } : {}),
    };
  }
  return {
    archive: {
      id: document.documentId,
      kind: document.kind,
      sessionId: document.sessionId,
      project: document.project,
      createdAt: document.createdAt,
    },
    sourceMessages,
    metadata: { ...metadataParse },
  };
}

function legacyDocument(document) {
  if (!document) return undefined;
  const chunkTable = document.materialization === "chunk-table";
  const metadataParse = chunkTable
    ? {
        status: "omitted",
        error: "Metadata was omitted from the bounded direct-document response.",
      }
    : { status: "valid" };
  const value = {
    id: document.documentId,
    version: document.version,
    sourceKey: document.sourceKey,
    sourceKeyStatus: document.sourceKeyStatus,
    sourceMessageKeys: [...(document.sourceMessageKeys ?? [])],
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    text: chunkTable ? directChunkTableText(document) : document.text,
    metadata: chunkTable ? {} : structuredClone(document.metadata ?? {}),
    ...(document.subjectKey === undefined ? {} : { subjectKey: document.subjectKey }),
    ...(document.supersedes === undefined
      ? {}
      : { supersedes: structuredClone(document.supersedes) }),
    metadataParse,
    ...(chunkTable
      ? {
          materialization: "chunk-table",
          sourceTextAvailable: false,
          contentHash: document.contentHash,
          byteLength: document.byteLength,
          chunkCount: document.chunkCount,
          chunkTable: structuredClone(document.chunkTable),
          chunkTableTruncated: document.chunkTableTruncated,
        }
      : {}),
  };
  return {
    ...value,
    provenance: chunkTable
      ? directChunkTableProvenance(document, metadataParse)
      : archiveDocumentProvenance(value),
  };
}

function looksLikeLocator(value) {
  return typeof value === "string" && /^cw[0-9]+\./u.test(value);
}

function normalizedSessionLineage(sessionIds, sessionId) {
  const values = Array.isArray(sessionIds)
    ? sessionIds
    : (sessionId === undefined ? [] : [sessionId]);
  return [...new Set(values.filter(Boolean).map(String))].slice(0, MAX_SESSION_LINEAGE_IDS);
}

function recallProvenance(response) {
  const source = response.sourceMessages;
  const sourceMessages = source.status === "available"
    ? {
        status: "available",
        keys: [...source.keys],
        firstKey: source.keys[0],
        lastKey: source.keys.at(-1),
        count: source.totalKeys ?? source.keys.length,
        ...(source.truncated ? { truncated: true } : {}),
      }
    : { status: source.status, reason: source.reason };
  return {
    archive: {
      id: response.documentId,
      kind: response.kind,
      sessionId: response.sessionId,
      project: response.project,
      createdAt: response.createdAt,
    },
    sourceMessages,
  };
}

function recalledDocument(response, locator) {
  return {
    id: response.documentId,
    documentId: response.documentId,
    recallId: locator,
    locator,
    version: response.version,
    sessionId: response.sessionId,
    project: response.project,
    kind: response.kind,
    createdAt: response.createdAt,
    // Store recall is the model-visible trust boundary. Keep its JSON-quoted,
    // length-bounded framing intact instead of re-exposing raw source bytes.
    text: response.renderedText,
    modelVisibleFramed: true,
    recalledText: response.text,
    historical: true,
    stalenessLabel: response.stalenessLabel,
    chunks: structuredClone(response.chunks),
    continuationLocators: [...response.continuationLocators],
    metadata: {},
    metadataParse: { status: "valid" },
    provenance: recallProvenance(response),
  };
}

export class ArchiveRecallError extends Error {
  constructor(response) {
    super(response.reason);
    this.name = "ArchiveRecallError";
    this.code = String(response.status).toUpperCase().replaceAll("-", "_");
    this.status = response.status;
    this.documentId = response.documentId;
    this.version = response.version;
  }
}

function retriableAdmissionConflict(error) {
  return error?.code === "CONFLICT"
    || error?.code === "EXPIRED"
    || error?.code === "SUPERSEDED"
    || (error?.code === "INTERNAL" && /conflict|immutable|idempot/iu.test(error.message));
}

function prunePresentation(before, after, result) {
  return {
    status: result.status === "blocked" ? "protected-over-limit" : result.status,
    totalBefore: before.liveLogicalBytes,
    totalAfter: after.liveLogicalBytes,
    deletedDocuments: result.tombstoned,
    deletedBytes: Math.max(0, before.liveLogicalBytes - after.liveLogicalBytes),
    byKind: {},
    scanned: result.scanned,
    deletedKeys: result.deletedKeys,
    protected: result.protected,
  };
}

/**
 * Legacy-compatible synchronous archive backed exclusively by context-windowd.
 * One facade is project-bound because project authorization is established by
 * the daemon handshake rather than trusted from individual method arguments.
 */
export class DaemonArchive {
  constructor({
    storePath,
    socketPath,
    project,
    requestTimeoutMs,
    daemonStartTimeoutMs,
    protectionTtlMs = PROTECTION_LEASE_MS,
    recallMaxTokens = DEFAULT_RECALL_MAX_TOKENS,
    retentionPolicy,
    migrationSourcePath,
    semantic,
    daemonLogPath,
    daemonLaunchLogPath,
    autoUpgradeDaemon = true,
  }) {
    this.path = resolveStorePath(storePath);
    this.socketPath = socketPath ?? defaultSocketPath(this.path);
    this.project = requiredString(project, "project");
    this.ownerId = `archive:${process.pid}:${randomUUID()}`;
    this.protectionTtlMs = positiveInteger(protectionTtlMs, PROTECTION_LEASE_MS);
    this.recallMaxTokens = positiveInteger(
      recallMaxTokens,
      DEFAULT_RECALL_MAX_TOKENS,
      MAX_RECALL_TOKENS,
    );
    this.retentionPolicy = normalizeArchiveRetentionPolicy(retentionPolicy);
    this.protectedSessionIds = new Set();
    this.protectedDocumentIds = new Set();
    this.protectionShardOwners = new Map();
    this.protectionHandoffId = undefined;
    this.locatorSessionIds = new Map();
    this.locatorSessionIdBytes = 0;
    this.lastPrune = undefined;
    this.lastCleanup = undefined;
    this.closed = false;
    this.bridge = new SynchronousStoreBridge({
      storePath: this.path,
      socketPath: this.socketPath,
      project: this.project,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(daemonStartTimeoutMs === undefined ? {} : { daemonStartTimeoutMs }),
      autoUpgradeDaemon: autoUpgradeDaemon === true,
      daemonRuntimeVersion: DAEMON_RUNTIME_VERSION,
      requiredCapabilities: DAEMON_REQUIRED_CAPABILITIES,
      ...(semantic === undefined ? {} : { semantic }),
      ...(daemonLogPath === undefined ? {} : { daemonLogPath }),
      ...(daemonLaunchLogPath === undefined ? {} : { daemonLaunchLogPath }),
    });
    try {
      if (migrationSourcePath !== undefined) {
        this.bridge.request("migration.activate-rocks", {
          sourcePath: requiredString(migrationSourcePath, "migrationSourcePath"),
        });
      }
    } catch (error) {
      this.closed = true;
      this.bridge.close();
      if (error?.code === "MIGRATION_BLOCKED"
        || error?.code === "ERR_MIGRATION_SOURCE_MISMATCH") {
        throw new ArchiveMigrationGuardError(
          error instanceof Error ? error.message : String(error),
          error?.details ?? { sourcePath: migrationSourcePath, storePath: this.path },
          { cause: error },
        );
      }
      throw error;
    }
  }

  request(operation, payload, options) {
    if (this.closed) throw new Error("Daemon archive is closed.");
    return this.bridge.request(operation, payload, options);
  }

  canonicalGet(id, version) {
    const response = this.request("store.get", {
      documentId: requiredString(id, "id"),
      ...(version === undefined ? {} : { version }),
    });
    if (response.status !== "resolved") return undefined;
    return response.materialization === "chunk-table"
      ? { ...response.document, materialization: "chunk-table" }
      : response.document;
  }

  resolveSubject(subjectKey) {
    const response = this.request("store.resolve-subject", {
      subjectKey: requiredString(subjectKey, "subjectKey"),
    });
    if (response.status !== "resolved") return undefined;
    return {
      documentId: response.documentId,
      version: response.version,
      kind: response.kind,
      subjectKey: response.subjectKey,
    };
  }

  supersede({
    documentId,
    version,
    sessionId,
    text,
    note,
  } = {}) {
    const targetId = requiredString(documentId, "documentId");
    const head = this.canonicalGet(targetId, version);
    if (head === undefined) {
      throw new Error(`Cannot supersede missing document ${targetId}.`);
    }
    const targetVersion = version === undefined ? head.version : version;
    const subjectKey = typeof head.subjectKey === "string" && head.subjectKey.length > 0
      ? head.subjectKey
      : undefined;
    const replacementText = String(text ?? note ?? "").trim()
      || `Supersedes ${targetId}@${targetVersion}.`;
    const id = this.put({
      sessionId: requiredString(sessionId ?? head.sessionId, "sessionId"),
      project: this.project,
      kind: "decision-candidate",
      text: replacementText,
      createdAt: Math.max(Date.now(), Number(head.createdAt) + 1 || Date.now()),
      metadata: {
        supersedeOf: targetId,
        supersedeVersion: targetVersion,
      },
      ...(subjectKey === undefined ? {} : { subjectKey }),
      supersedes: { documentId: targetId, version: targetVersion },
    });
    if (!id) throw new Error("Failed to admit superseding document.");
    return { documentId: id, superseded: { documentId: targetId, version: targetVersion } };
  }

  redact({
    scope,
    sessionId,
    sessionIds,
    confirm,
    batchSize = 256,
  } = {}) {
    let cursor;
    let aggregate = {
      status: "complete",
      scanned: 0,
      tombstoned: 0,
      alreadyTombstoned: 0,
      protected: 0,
      missing: 0,
      hintsCleared: 0,
    };
    for (let wave = 0; wave < 10_000; wave += 1) {
      const result = this.request("store.redact", {
        scope: requiredString(scope, "scope"),
        ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }),
        ...(sessionIds === undefined ? {} : { sessionIds: [...sessionIds] }),
        confirm: requiredString(confirm, "confirm"),
        batchSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      aggregate = {
        status: result.status,
        scanned: aggregate.scanned + result.scanned,
        tombstoned: aggregate.tombstoned + result.tombstoned,
        alreadyTombstoned: aggregate.alreadyTombstoned + result.alreadyTombstoned,
        protected: aggregate.protected + result.protected,
        missing: aggregate.missing + result.missing,
        hintsCleared: aggregate.hintsCleared + result.hintsCleared,
      };
      if (result.status !== "more-work" || result.nextCursor === undefined) {
        aggregate.status = "complete";
        break;
      }
      cursor = result.nextCursor;
    }
    return aggregate;
  }

  canonicalHeadState(id, version) {
    const response = this.request("store.get", {
      documentId: requiredString(id, "id"),
      ...(version === undefined ? {} : { version }),
      view: "identity",
    });
    const document = response.status === "resolved" ? response.document : undefined;
    const latestVersion = document?.version
      ?? (Number.isSafeInteger(response.version) ? response.version : 0);
    return { document, latestVersion };
  }

  canonicalHead(id, version) {
    return this.canonicalHeadState(id, version).document;
  }

  rememberLocatorSessionIds(locator, sessionIds) {
    const previous = this.locatorSessionIds.get(locator);
    if (previous !== undefined) {
      this.locatorSessionIdBytes -= previous.bytes;
      this.locatorSessionIds.delete(locator);
    }
    const retained = [...sessionIds];
    const bytes = Buffer.byteLength(locator, "utf8")
      + retained.reduce((total, sessionId) => total + Buffer.byteLength(sessionId, "utf8"), 0);
    if (bytes > MAX_REMEMBERED_LOCATOR_BYTES) return;
    this.locatorSessionIds.set(locator, { sessionIds: retained, bytes });
    this.locatorSessionIdBytes += bytes;
    while (this.locatorSessionIds.size > MAX_REMEMBERED_LOCATORS
      || this.locatorSessionIdBytes > MAX_REMEMBERED_LOCATOR_BYTES) {
      const oldest = this.locatorSessionIds.keys().next().value;
      const removed = this.locatorSessionIds.get(oldest);
      this.locatorSessionIds.delete(oldest);
      this.locatorSessionIdBytes -= removed.bytes;
    }
  }

  put(
    {
      id,
      sessionId,
      project = this.project,
      kind = "turn",
      text,
      metadata = {},
      createdAt = Date.now(),
      subjectKey,
      supersedes,
    },
    {
      protect = false,
      structuralMessages,
      retentionClass: requestedRetentionClass,
      expiresAt: requestedExpiresAt,
    } = {},
  ) {
    const content = String(text ?? "");
    if (!content.trim()) return undefined;
    requiredString(sessionId, "sessionId");
    if (project !== this.project) {
      throw new Error(`Daemon archive is bound to project ${this.project}; received ${project}.`);
    }
    const recordedAt = timestamp(createdAt);
    const documentId = id === undefined
      ? hashParts([sessionId, project, kind, recordedAt, content]).slice(0, 20)
      : requiredString(String(id), "id");
    const normalizedMetadata = jsonMetadata(metadata);
    const normalizedSubjectKey = subjectKey === undefined
      ? undefined
      : requiredString(subjectKey, "subjectKey");
    const normalizedSupersedes = semanticTarget(supersedes);
    const normalizedStructural = normalizeStructuralMessages(structuralMessages);
    const admissionRetention = retentionForAdmission(this.retentionPolicy, {
      kind,
      ...(requestedRetentionClass === undefined
        ? {}
        : { retentionClass: requestedRetentionClass }),
      ...(requestedExpiresAt === undefined ? {} : { expiresAt: requestedExpiresAt }),
      // Retention is measured from source time so retries derive the same
      // request identity and already-old evidence is eligible immediately.
      now: recordedAt,
    });

    let advanceAfterConflict = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const head = this.canonicalHeadState(documentId);
      const current = head.document;
      const candidateVersion = current?.version
        ?? (head.latestVersion + 1);
      let identity = sourceIdentity(documentId, candidateVersion, normalizedMetadata);
      let document = {
        documentId,
        version: candidateVersion,
        ...identity,
        sessionId,
        project,
        kind: requiredString(String(kind), "kind"),
        createdAt: recordedAt,
        text: content,
        metadata: normalizedMetadata,
        ...(normalizedSubjectKey === undefined ? {} : { subjectKey: normalizedSubjectKey }),
        ...(normalizedSupersedes === undefined ? {} : { supersedes: normalizedSupersedes }),
      };
      if (current !== undefined && (advanceAfterConflict
        || current.identityHash !== canonicalDocumentIdentityHash(document))) {
        document.version = current.version + 1;
        identity = sourceIdentity(documentId, document.version, normalizedMetadata);
        document = { ...document, ...identity };
      }
      const idempotencyKey = `legacy-put:${hashParts([
        documentId,
        document.version,
        documentComparable(document),
        stableJson(normalizedStructural),
      ])}`;
      try {
        const result = this.request("store.put", {
          idempotencyKey,
          document,
          structuralMessages: normalizedStructural,
          ...admissionRetention,
        }, { requestId: `rpc:${idempotencyKey}` });
        if (protect) {
          this.protectedDocumentIds.add(documentId);
          this.syncProtection();
        }
        return result.documentId;
      } catch (error) {
        if (attempt === 3 || !retriableAdmissionConflict(error)) throw error;
        advanceAfterConflict = true;
      }
    }
    return undefined;
  }

  get(id, options = {}) {
    if (looksLikeLocator(id)) return this.recall(id, options);
    return legacyDocument(this.canonicalGet(id));
  }

  recall(id, {
    neighbors = 1,
    maxTokens = this.recallMaxTokens,
    sessionId,
    sessionIds,
  } = {}) {
    if (!looksLikeLocator(id)) return legacyDocument(this.canonicalGet(id));
    const explicitLineage = sessionIds !== undefined || sessionId !== undefined
      ? normalizedSessionLineage(sessionIds, sessionId)
      : undefined;
    const authorizedSessionIds = explicitLineage
      ?? this.locatorSessionIds.get(id)?.sessionIds
      ?? normalizedSessionLineage([...this.protectedSessionIds]);
    const response = this.request("store.recall", {
      locator: id,
      neighbors: Number.isSafeInteger(neighbors) && neighbors >= 0 && neighbors <= 32
        ? neighbors
        : 1,
      maxTokens: Math.max(
        39,
        positiveInteger(maxTokens, this.recallMaxTokens, MAX_RECALL_TOKENS),
      ),
      sessionIds: authorizedSessionIds,
    });
    if (response.status !== "resolved") throw new ArchiveRecallError(response);
    return recalledDocument(response, id);
  }

  search(query, options = {}) {
    return this.searchDetailed(query, options).results;
  }

  searchDetailed(query, options = {}) {
    if (options.project !== undefined && options.project !== this.project) {
      return {
        mode: options.relation ? "structural" : "lexical",
        ...(options.relation ? { relation: options.relation } : {}),
        status: "not-found",
        results: [],
        candidates: [],
      };
    }
    const sessionIds = normalizedSessionLineage(options.sessionIds, options.sessionId);
    const response = this.request("store.search", {
      query: String(query ?? ""),
      ...(Array.isArray(options.expansionTerms)
        ? { expansionTerms: [...new Set(options.expansionTerms.map(String).filter(Boolean))].slice(0, 16) }
        : {}),
      relation: options.relation ?? null,
      semanticPolicy: options.semanticPolicy ?? "auto",
      scope: options.scope ?? "session",
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      sessionIds,
      project: this.project,
      limit: positiveInteger(options.limit, 3, 100),
      excludeVisibleSourceKeys: normalizedVisibleSourceKeys(options.excludeVisibleSourceKeys),
      hintBudgetTokens: Number.isSafeInteger(options.hintBudgetTokens)
        ? options.hintBudgetTokens
        : 0,
    });
    const results = [];
    for (const candidate of response.results) {
      const structural = options.relation
        ? {
            relation: options.relation,
            granularity: candidate.source.messageKey ? "message" : "document",
            ...(candidate.source.messageKey ? { messageKey: candidate.source.messageKey } : {}),
            relationConfidence: Math.round(candidate.score * 100),
          }
        : undefined;
      results.push({
        // The public result identity is the authenticated, exact-version
        // locator. Keep documentId separately for diagnostics only.
        id: candidate.locator,
        documentId: candidate.documentId,
        version: candidate.version,
        sessionId: candidate.source.sessionId,
        project: candidate.source.project,
        kind: candidate.kind,
        snippet: candidate.snippet,
        score: candidate.score,
        margin: candidate.margin,
        ...(candidate.rawScore === undefined ? {} : { rawScore: candidate.rawScore }),
        ...(candidate.calibratedScore === undefined
          ? {}
          : { calibratedScore: candidate.calibratedScore }),
        ...(candidate.retrievalMode === undefined
          ? {}
          : { retrievalMode: candidate.retrievalMode }),
        ...(candidate.createdAt === undefined ? {} : { createdAt: candidate.createdAt }),
        locator: candidate.locator,
        matchType: candidate.matchType,
        ...(candidate.matchedAnchors === undefined
          ? {}
          : { matchedAnchors: [...candidate.matchedAnchors] }),
        ...(candidate.matchedTerms === undefined
          ? {}
          : { matchedTerms: [...candidate.matchedTerms] }),
        ...(candidate.termCoverage === undefined
          ? {}
          : { termCoverage: candidate.termCoverage }),
        ...(candidate.termIdf === undefined
          ? {}
          : { termIdf: structuredClone(candidate.termIdf) }),
        ...(candidate.maxNormalizedIdf === undefined
          ? {}
          : { maxNormalizedIdf: candidate.maxNormalizedIdf }),
        historical: candidate.historical,
        superseded: candidate.superseded,
        source: structuredClone(candidate.source),
        ...(structural ? { structural } : {}),
      });
      // A synchronous legacy caller commonly follows search with get(locator)
      // and cannot pass request context through that older method signature.
      // Remember only the verified lineage used for the search, under a hard
      // bound, so the signed session-scoped locator remains usable by that
      // caller without widening it to project scope.
      this.rememberLocatorSessionIds(candidate.locator, sessionIds);
    }
    return {
      mode: options.relation ? "structural" : response.mode,
      retrievalMode: response.mode,
      ...(options.relation ? { relation: options.relation } : {}),
      status: results.length === 0 ? "not-found" : response.status,
      results,
      candidates: results.map((result) => result.structural ?? ({
        id: result.id,
        granularity: "document",
      })),
      indexGeneration: response.indexGeneration,
    };
  }

  gatherDetailed(query, options = {}) {
    if (options.project !== undefined && options.project !== this.project) {
      return {
        status: "not-found",
        mode: "lexical",
        intent: options.intent ?? "auto",
        anchorCount: 0,
        candidateCount: 0,
        returnedTokens: 0,
        truncated: false,
        hasMore: false,
        evidence: [],
      };
    }
    const intent = options.intent ?? "auto";
    const defaults = intent === "state"
      ? { before: 0, after: 0 }
      : intent === "workflow"
        ? { before: 1, after: 8 }
        : { before: 1, after: 3 };
    const sessionIds = normalizedSessionLineage(options.sessionIds, options.sessionId);
    const response = this.request("store.gather", {
      query: requiredString(query, "query"),
      ...(Array.isArray(options.expansionTerms)
        ? { expansionTerms: [...new Set(options.expansionTerms.map(String).filter(Boolean))].slice(0, 16) }
        : {}),
      intent,
      scope: options.scope ?? "session",
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      sessionIds,
      project: this.project,
      limit: positiveInteger(options.limit, 3, 10),
      before: Number.isSafeInteger(options.before) ? options.before : defaults.before,
      after: Number.isSafeInteger(options.after) ? options.after : defaults.after,
      neighborhoodAnchors: positiveInteger(options.neighborhoodAnchors, 2, 5),
      maxEvidence: positiveInteger(options.maxEvidence, 12, 24),
      maxTokens: Math.max(
        39,
        positiveInteger(options.maxTokens, this.recallMaxTokens, MAX_RECALL_TOKENS),
      ),
      excludeVisibleSourceKeys: normalizedVisibleSourceKeys(options.excludeVisibleSourceKeys),
    });
    const evidence = response.evidence.map((item) => {
      const authorizedSessionIds = [...new Set([...sessionIds, item.document.sessionId])];
      this.rememberLocatorSessionIds(item.locator, authorizedSessionIds);
      return {
        relation: item.relation,
        anchorRank: item.anchorRank,
        distance: item.distance,
        id: item.locator,
        locator: item.locator,
        document: recalledDocument(item.document, item.locator),
      };
    });
    return {
      status: response.status,
      mode: response.mode,
      intent: response.intent,
      anchorCount: response.anchorCount,
      candidateCount: response.candidateCount,
      returnedTokens: response.returnedTokens,
      truncated: response.truncated,
      hasMore: response.hasMore,
      evidence,
    };
  }

  traverseDetailed(locator, {
    direction = "before",
    scope = "session",
    sessionId,
    sessionIds,
    limit = 128,
    scanLimit = 2_048,
  } = {}) {
    const lineage = normalizedSessionLineage(sessionIds, sessionId);
    const response = this.request("store.traverse", {
      locator: requiredString(locator, "locator"),
      direction,
      scope,
      sessionIds: lineage,
      limit: positiveInteger(limit, 128, 128),
      scanLimit: positiveInteger(scanLimit, 2_048, 10_000),
    });
    const results = response.results.map((candidate) => {
      this.rememberLocatorSessionIds(candidate.locator, lineage);
      return {
        id: candidate.locator,
        documentId: candidate.documentId,
        version: candidate.version,
        sessionId: candidate.source.sessionId,
        project: candidate.source.project,
        kind: candidate.kind,
        createdAt: candidate.createdAt,
        snippet: candidate.snippet,
        locator: candidate.locator,
        historical: candidate.historical,
        superseded: candidate.superseded,
        source: structuredClone(candidate.source),
      };
    });
    return {
      mode: "chronological",
      status: response.status,
      direction: response.direction,
      scanned: response.scanned,
      truncated: response.truncated,
      hasMore: response.hasMore,
      results,
      candidates: results.map(({ id }) => ({ id, granularity: "document" })),
    };
  }

  count({ sessionId, sessionIds, project, scope = "session" } = {}) {
    if (project !== undefined && project !== this.project) return 0;
    const scoped = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean).map(String)
      : (sessionId ? [String(sessionId)] : []);
    return this.request("store.count", {
      scope,
      ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }),
      sessionIds: scoped,
      project: this.project,
    }).count;
  }

  preflight(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("preflight request must be an object.");
    }
    assertPreflightRequestFields(request);
    assertPreflightNumericPolicyFields(request);
    if (request.activeMessageKeys !== undefined) {
      assertActiveHintMessageKeys(request.activeMessageKeys);
    }
    if (request.project !== undefined && request.project !== this.project) {
      return { modelVisibleText: "", hints: [] };
    }
    return this.request("store.preflight", {
      messageKey: requiredString(request.messageKey, "messageKey"),
      message: requiredString(request.message, "message"),
      scope: request.scope ?? "session",
      sessionId: requiredString(request.sessionId, "sessionId"),
      sessionIds: Array.isArray(request.sessionIds)
        ? request.sessionIds.filter(Boolean).map(String)
        : [request.sessionId],
      project: this.project,
      excludeVisibleSourceKeys: normalizedVisibleSourceKeys(request.excludeVisibleSourceKeys),
      hintBudgetTokens: Number.isSafeInteger(request.hintBudgetTokens)
        ? request.hintBudgetTokens
        : 160,
      ...(request.activeHintBudgetTokens === undefined
        ? {}
        : { activeHintBudgetTokens: request.activeHintBudgetTokens }),
      ...(request.activeMessageKeys === undefined
        ? {}
        : { activeMessageKeys: validatedActiveHintMessageKeys(request.activeMessageKeys) }),
      ...(request.hintSourceCooldownMs === undefined
        ? {}
        : { hintSourceCooldownMs: request.hintSourceCooldownMs }),
      ...(request.ephemeralAutoRetrievalDays === undefined
        ? {}
        : { ephemeralAutoRetrievalDays: request.ephemeralAutoRetrievalDays }),
      ...(request.conversationAutoRetrievalDays === undefined
        ? {}
        : { conversationAutoRetrievalDays: request.conversationAutoRetrievalDays }),
      ...(request.derivedAutoRetrievalDays === undefined
        ? {}
        : { derivedAutoRetrievalDays: request.derivedAutoRetrievalDays }),
      ...(request.reconstruct === undefined ? {} : { reconstruct: request.reconstruct === true }),
      ...(request.includeDiagnostics === undefined
        ? {}
        : { includeDiagnostics: request.includeDiagnostics === true }),
      ...(request.epochId === undefined ? {} : { epochId: String(request.epochId) }),
      ...(request.epochBudgetTokens === undefined
        ? {}
        : { epochBudgetTokens: request.epochBudgetTokens }),
    });
  }

  removeHints(messageKeys, { sessionId } = {}) {
    if (!Array.isArray(messageKeys)) {
      throw new TypeError("messageKeys must be an array.");
    }
    const normalizedSessionId = requiredString(sessionId, "sessionId");
    const unique = [...new Set(messageKeys.map((key) => requiredString(String(key), "messageKey")))];
    let removed = 0;
    let notFound = 0;
    for (let offset = 0; offset < unique.length; offset += 1_000) {
      const batch = unique.slice(offset, offset + 1_000);
      if (batch.length === 0) continue;
      const result = this.request("store.remove-hints", {
        sessionId: normalizedSessionId,
        messageKeys: batch,
      });
      removed += result.removed;
      notFound += result.notFound;
    }
    return { removed, notFound };
  }

  documentVersions(documentIds) {
    const versions = [];
    for (const documentId of documentIds) {
      const document = this.canonicalHead(documentId);
      if (document) versions.push({ documentId, version: document.version });
    }
    return versions;
  }

  syncProtection(ownerId = this.ownerId, sessionIds = this.protectedSessionIds,
    documentIds = this.protectedDocumentIds) {
    const normalizedOwnerId = requiredString(ownerId, "ownerId");
    const normalizedSessionIds = [...new Set(sessionIds)];
    const sessionIdentity = [...normalizedSessionIds].sort();
    const documentVersions = this.documentVersions(documentIds).sort(compareDocumentVersions);
    const shards = [];
    for (let offset = 0; offset < documentVersions.length;
      offset += MAX_PROTECTED_DOCUMENT_VERSIONS) {
      shards.push(documentVersions.slice(offset, offset + MAX_PROTECTED_DOCUMENT_VERSIONS));
    }
    if (shards.length === 0) shards.push([]);
    const shardOwners = shards.map((shard, shardIndex) => protectionShardOwner(
      normalizedOwnerId,
      shardIndex,
      shard,
      shards.length,
      sessionIdentity,
    ));
    const previousOwners = this.protectionShardOwners.get(normalizedOwnerId) ?? [];
    const responses = [];
    const attemptedOwners = [];
    try {
      for (let shardIndex = 0; shardIndex < shards.length; shardIndex += 1) {
        // Track before dispatch because a transport failure can hide a daemon
        // commit. Release is idempotent, so an uncertain owner is safer to
        // retain for cleanup than to leak until its TTL expires.
        attemptedOwners.push(shardOwners[shardIndex]);
        responses.push(this.request("store.protect", {
          ownerId: shardOwners[shardIndex],
          sessionIds: shardIndex === 0 ? normalizedSessionIds : [],
          documentVersions: shards[shardIndex],
          ttlMs: this.protectionTtlMs,
        }));
      }
    } catch (error) {
      const retainedOwners = [...new Set([...previousOwners, ...attemptedOwners])];
      if (retainedOwners.length > 0) {
        this.protectionShardOwners.set(normalizedOwnerId, retainedOwners);
      }
      throw error;
    }
    const activeOwners = new Set(shardOwners);
    try {
      for (const staleOwner of previousOwners) {
        if (!activeOwners.has(staleOwner)) {
          this.request("store.release-protection", { ownerId: staleOwner });
        }
      }
    } catch (error) {
      this.protectionShardOwners.set(
        normalizedOwnerId,
        [...new Set([...previousOwners, ...shardOwners])],
      );
      throw error;
    }
    this.protectionShardOwners.set(normalizedOwnerId, shardOwners);
    if (responses.length === 1) return responses[0];
    return {
      ownerId: normalizedOwnerId,
      expiresAt: responses.reduce(
        (earliest, response) => Math.min(earliest, response.expiresAt),
        Number.MAX_SAFE_INTEGER,
      ),
      protectedSessions: normalizedSessionIds.length,
      protectedDocuments: documentVersions.length,
    };
  }

  setProtectedContext({ sessionIds = [], documentIds = [] } = {}) {
    this.protectedSessionIds = new Set(sessionIds.filter(Boolean).map(String));
    this.protectedDocumentIds = new Set(documentIds.filter(Boolean).map(String));
    this.syncProtection();
  }

  refreshPolicyLease() {
    this.syncProtection();
  }

  releaseProtectionOwner(ownerId) {
    if (!ownerId) return;
    const normalizedOwnerId = String(ownerId);
    const shardOwners = this.protectionShardOwners.get(normalizedOwnerId)
      ?? protectionHandoffOwners(normalizedOwnerId)
      ?? [normalizedOwnerId];
    const failedOwners = [];
    let releaseError;
    for (const shardOwner of shardOwners) {
      try {
        this.request("store.release-protection", { ownerId: shardOwner });
      } catch (error) {
        failedOwners.push(shardOwner);
        releaseError ??= error;
      }
    }
    if (failedOwners.length === 0) this.protectionShardOwners.delete(normalizedOwnerId);
    else this.protectionShardOwners.set(normalizedOwnerId, failedOwners);
    if (releaseError) throw releaseError;
  }

  prune({
    force = false,
    now = Date.now(),
    protectedSessionIds = [],
    protectedDocumentIds = [],
    withinTransaction = false,
    batchSize = DEFAULT_RETENTION_BATCH_SIZE,
  } = {}) {
    if (withinTransaction) {
      throw new TypeError("Daemon-backed pruning cannot join a caller-owned transaction.");
    }
    const temporaryOwner = `${this.ownerId}:prune`;
    const hasTemporaryProtection = protectedSessionIds.length > 0 || protectedDocumentIds.length > 0;
    if (hasTemporaryProtection) {
      this.syncProtection(
        temporaryOwner,
        new Set(protectedSessionIds.filter(Boolean).map(String)),
        new Set(protectedDocumentIds.filter(Boolean).map(String)),
      );
    }
    const before = this.request("retention.status", {});
    let aggregate = {
      status: "complete",
      scanned: 0,
      tombstoned: 0,
      deletedKeys: 0,
      protected: 0,
    };
    try {
      for (let wave = 0; wave < MAX_RETENTION_WAVES; wave += 1) {
        const result = this.request("retention.run", {
          now: timestamp(now),
          force: force === true,
          batchSize: positiveInteger(batchSize, DEFAULT_RETENTION_BATCH_SIZE, 100_000),
        });
        aggregate = {
          status: result.status,
          scanned: aggregate.scanned + result.scanned,
          tombstoned: aggregate.tombstoned + result.tombstoned,
          deletedKeys: aggregate.deletedKeys + result.deletedKeys,
          protected: aggregate.protected + result.protected,
        };
        if (result.status !== "more-work") break;
      }
    } finally {
      if (hasTemporaryProtection) this.releaseProtectionOwner(temporaryOwner);
    }
    const after = this.request("retention.status", {});
    const presented = prunePresentation(before, after, aggregate);
    this.lastPrune = presented;
    if (presented.deletedDocuments > 0) this.lastCleanup = presented;
    return presented;
  }

  logicalBytes() {
    return this.request("retention.status", {}).liveLogicalBytes;
  }

  daemonStatus() {
    const status = this.request("daemon.status", {});
    return {
      ...status,
      expectedRuntimeVersion: DAEMON_RUNTIME_VERSION,
      runtimeMatches: status.runtimeVersion === DAEMON_RUNTIME_VERSION,
    };
  }

  restartDaemon({ reason = "operator requested restart" } = {}) {
    if (this.closed) throw new Error("Daemon archive is closed.");
    return this.bridge.restart(reason);
  }

  stats() {
    const status = this.request("daemon.status", {});
    // Daemon status deliberately returns a bounded, possibly approximate
    // count. Do not turn a status render into a full archive scan.
    const activeDocuments = Number(status.counts?.documents ?? 0);
    const approximate = status.counts?.approximate === true
      || status.retention?.approximate === true;
    const retention = {
      ...(status.retention ?? {}),
      liveDocuments: activeDocuments,
      approximate,
    };
    const rocksdb = status.rocksdb ?? {};
    const liveDataBytes = Number(rocksdb.liveDataBytes ?? retention.liveLogicalBytes ?? 0);
    const totalSstBytes = Number(rocksdb.totalSstBytes ?? 0);
    const logicalBytes = Number(retention.liveLogicalBytes ?? status.counts?.logicalBytes ?? 0);
    return {
      backend: "rocksdb",
      noRoutineSizeCap: true,
      counts: { documents: activeDocuments, logicalBytes, approximate },
      logicalBytes,
      maxBytes: null,
      targetBytes: null,
      databaseBytes: totalSstBytes,
      walBytes: 0,
      allocatedBytes: totalSstBytes,
      reclaimableBytes: Math.max(0, totalSstBytes - liveDataBytes),
      autoVacuum: "lsm-compaction",
      overLimit: false,
      emergencyMode: retention.emergencyMode === true,
      processId: status.processId,
      runtimeVersion: status.runtimeVersion,
      storePath: status.storePath,
      filesystem: status.filesystem,
      rocksdb,
      retention,
      lastPrune: this.lastCleanup ?? this.lastPrune,
    };
  }

  reclaim() {
    const before = this.stats();
    const result = this.request("store.compact", { reason: "operator" });
    const after = this.stats();
    return {
      status: result.status === "complete" ? "reclaimed" : result.status,
      ...(result.error ? { error: result.error } : {}),
      before,
      after,
    };
  }

  close({ releaseProtection = true } = {}) {
    if (this.closed) return releaseProtection ? undefined : (this.protectionHandoffId ?? this.ownerId);
    if (!releaseProtection) {
      const physicalOwners = [...new Set([...this.protectionShardOwners.values()].flat())];
      this.protectionHandoffId = protectionHandoffId(
        this.ownerId,
        physicalOwners.length > 0 ? physicalOwners : [this.ownerId],
      );
    }
    let releaseError;
    if (releaseProtection) {
      const logicalOwners = new Set([this.ownerId, ...this.protectionShardOwners.keys()]);
      for (const ownerId of logicalOwners) {
        try {
          this.releaseProtectionOwner(ownerId);
        } catch (error) {
          releaseError ??= error;
        }
      }
      if (releaseError && this.protectionShardOwners.size > 0) {
        const remainingOwners = [...new Set([...this.protectionShardOwners.values()].flat())];
        this.protectionHandoffId = protectionHandoffId(this.ownerId, remainingOwners);
      }
    }
    this.closed = true;
    this.locatorSessionIds.clear();
    this.locatorSessionIdBytes = 0;
    try { this.bridge.close(); } catch (error) { releaseError ??= error; }
    if (releaseError) throw releaseError;
    return releaseProtection ? undefined : this.protectionHandoffId;
  }
}

export function createDaemonArchive(options) {
  return new DaemonArchive(options);
}

export { hashParts as stableDaemonArchiveHash };
