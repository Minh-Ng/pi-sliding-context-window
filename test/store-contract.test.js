import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractError,
  DOCUMENT_SCHEMA,
  EVENT_SCHEMA,
  LOCATOR_PAYLOAD_SCHEMA,
  MAX_ACTIVE_HINT_MESSAGE_KEYS,
  MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES,
  MAX_JSON_VALUE_DEPTH,
  MAX_RECALL_TOKENS,
  MAX_STORE_ERROR_MESSAGE_LENGTH,
  MAX_STORE_IDENTIFIER_LENGTH,
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_PROTECTED_DOCUMENT_VERSIONS,
  MAX_SESSION_LINEAGE_IDS,
  MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
  MAX_VISIBLE_SOURCE_KEYS,
  MAX_VISIBLE_SOURCE_KEY_BYTES,
  STORE_ERROR_CODES,
  STORE_LOCATOR_VERSION,
  STORE_OPERATION_CONTRACTS,
  STORE_OPERATIONS,
  STORE_PROTOCOL_VERSION,
  STORE_SCHEMA_METADATA_SCHEMA,
  STORE_SCHEMA_VERSION,
  SUPERSESSION_SCHEMA,
  assertContract,
  assertLocatorPayload,
  assertStoreRequest,
  assertStoreResult,
  assertStoreSchemaMetadata,
} from "../src/store/store-contract.js";
import { DEFAULT_MAX_FRAME_BYTES } from "../src/daemon/framing.js";
import {
  PROTOCOL_FRAME_TYPES,
  assertHandshakeRequest,
  assertRequestFrame,
  assertResponseFrame,
  createErrorResponse,
  createHandshakeAccepted,
  createHandshakeRejected,
  createSuccessResponse,
  decodeProtocolLine,
  encodeProtocolFrame,
} from "../src/store/store-protocol.js";

const document = Object.freeze({
  documentId: "doc/\u0000/雪",
  version: 1,
  sourceKey: "source:one",
  sessionId: "session-1",
  project: "/project/雪",
  kind: "turn",
  createdAt: 1_000,
  text: "Remember REAP_DRAIN.",
  metadata: { nested: [true, 3, null] },
  sourceMessageKeys: ["user:1", "assistant:1"],
});

const migration = Object.freeze({
  phase: "offline-ready",
  sourcePath: "/tmp/archive.db",
  sourceFingerprint: "sha256:fixture",
  migratedCount: 8,
  failedCount: 0,
  comparisonFailures: 0,
  rollbackEligible: true,
  checkpoint: { orderingKey: 8 },
});

const requests = Object.freeze({
  "store.put": {
    idempotencyKey: "put-1",
    document,
    retentionClass: "conversation-source",
  },
  "store.get": { documentId: document.documentId, version: 1 },
  "store.search": {
    query: "REAP_DRAIN",
    relation: null,
    scope: "session",
    sessionIds: ["session-1", "parent-session"],
    project: "/project/雪",
    limit: 3,
    excludeVisibleSourceKeys: ["user:1"],
    hintBudgetTokens: 160,
  },
  "store.gather": {
    query: "What changed about REAP_DRAIN?",
    intent: "state",
    scope: "session",
    sessionIds: ["session-1", "parent-session"],
    project: "/project/雪",
    limit: 3,
    before: 0,
    after: 0,
    neighborhoodAnchors: 2,
    maxEvidence: 8,
    maxTokens: 3_000,
    excludeVisibleSourceKeys: ["user:1"],
  },
  "store.traverse": {
    locator: "locator.v1.opaque",
    direction: "before",
    scope: "session",
    sessionIds: ["session-1", "parent-session"],
    limit: 32,
    scanLimit: 2_048,
  },
  "store.recall": {
    locator: "locator.v1.opaque",
    neighbors: 1,
    maxTokens: 3_000,
    sessionIds: ["session-1", "parent-session"],
  },
  "store.preflight": {
    messageKey: "user:2",
    message: "What did we decide about REAP_DRAIN?",
    scope: "session",
    sessionId: "session-1",
    sessionIds: ["session-1"],
    project: "/project/雪",
    excludeVisibleSourceKeys: ["user:2"],
    hintBudgetTokens: 160,
    activeHintBudgetTokens: 640,
    activeMessageKeys: ["user:1", "user:2"],
    hintSourceCooldownMs: 86_400_000,
    ephemeralAutoRetrievalDays: 7,
    conversationAutoRetrievalDays: 30,
    derivedAutoRetrievalDays: 30,
    epochId: "epoch-1",
    epochBudgetTokens: 640,
  },
  "store.remove-hints": {
    sessionId: "session-1",
    messageKeys: ["user:1", "user:2"],
  },
  "store.count": { scope: "project", project: "/project/雪" },
  "store.protect": {
    ownerId: "client-1",
    sessionIds: ["session-1"],
    documentVersions: [{ documentId: document.documentId, version: 1 }],
    ttlMs: 60_000,
  },
  "store.release-protection": { ownerId: "client-1" },
  "store.pin": {
    pinId: "pin-1",
    documentId: document.documentId,
    version: 1,
    reason: "Keep the accepted decision.",
  },
  "store.unpin": { pinId: "pin-1" },
  "store.resolve-subject": { subjectKey: "decision:REAP_DRAIN" },
  "store.redact": {
    scope: "session",
    sessionId: "session-1",
    confirm: "session-1",
    batchSize: 100,
  },
  "retention.run": { now: 2_000, force: false, batchSize: 100 },
  "retention.status": {},
  "feedback.stats": { queryLimit: 25 },
  "store.compact": { reason: "deletion-wave", startKey: "a", endKey: "z" },
  "daemon.status": {},
  "daemon.ping": { nonce: "ping-1" },
  "daemon.shutdown": { reason: "test complete" },
  "migration.status": {},
  "migration.activate-rocks": { sourcePath: "/tmp/archive.db" },
  "migration.claim-sqlite": { sourcePath: "/tmp/archive.db" },
  "migration.start": { sourcePath: "/tmp/archive.db", batchSize: 100, offline: true },
  "migration.verify": { sampleLimit: 1_000 },
});

const results = Object.freeze({
  "store.put": {
    status: "stored",
    documentId: document.documentId,
    version: 1,
    sourceKey: document.sourceKey,
    outboxSequence: 1,
  },
  "store.get": { status: "resolved", document },
  "store.search": {
    mode: "exact",
    status: "resolved",
    indexGeneration: 7,
    results: [{
      documentId: document.documentId,
      version: 1,
      kind: "turn",
      score: 0.91,
      rawScore: 4.5,
      calibratedScore: 0.91,
      retrievalMode: "exact",
      createdAt: 1_000,
      matchType: "exact-symbol",
      margin: 0.28,
      matchedAnchors: ["REAP_DRAIN"],
      matchedTerms: [],
      termCoverage: 1,
      termIdf: [],
      maxNormalizedIdf: 1,
      snippet: "Remember REAP_DRAIN.",
      historical: true,
      superseded: false,
      locator: "locator.v1.opaque",
      source: {
        sessionId: "session-1",
        turnId: "turn-1",
        messageKey: "assistant:1",
      },
    }],
    expiredMatches: { count: 0, retentionClasses: [] },
  },
  "store.gather": {
    status: "resolved",
    mode: "hybrid",
    intent: "state",
    anchorCount: 1,
    candidateCount: 1,
    returnedTokens: 8,
    truncated: false,
    hasMore: false,
    evidence: [{
      relation: "anchor",
      anchorRank: 1,
      distance: 0,
      locator: "locator.v1.opaque",
      document: {
        status: "resolved",
        documentId: document.documentId,
        version: 1,
        kind: "turn",
        sessionId: "session-1",
        project: "/project/雪",
        createdAt: 1_000,
        historical: true,
        stalenessLabel: "Archived historical evidence; verify current state.",
        sourceMessages: { status: "available", keys: ["user:1", "assistant:1"] },
        chunks: [{
          chunkId: "chunk-1",
          ordinal: 0,
          startByte: 0,
          endByte: 20,
          text: "Remember REAP_DRAIN.",
        }],
        text: "Remember REAP_DRAIN.",
        continuationLocators: [],
        maxTokens: 100,
        renderedText: "[ARCHIVED HISTORICAL EVIDENCE]",
        returnedTokens: 8,
      },
    }],
  },
  "store.traverse": {
    status: "resolved",
    direction: "before",
    scanned: 20,
    truncated: false,
    hasMore: false,
    results: [{
      documentId: document.documentId,
      version: 1,
      kind: "turn",
      score: 1,
      rawScore: 1,
      calibratedScore: 1,
      retrievalMode: "structural",
      createdAt: 1_000,
      matchType: "chronological-before",
      margin: 1,
      matchedAnchors: [],
      matchedTerms: [],
      termCoverage: 0,
      termIdf: [],
      maxNormalizedIdf: 0,
      snippet: "Remember REAP_DRAIN.",
      historical: true,
      superseded: false,
      locator: "locator.v1.prior",
      source: { sessionId: "session-1" },
    }],
  },
  "store.recall": {
    status: "resolved",
    documentId: document.documentId,
    version: 1,
    kind: "turn",
    sessionId: "session-1",
    project: "/project/雪",
    createdAt: 1_000,
    historical: true,
    stalenessLabel: "Archived historical evidence; verify current state.",
    sourceMessages: { status: "available", keys: ["user:1", "assistant:1"] },
    chunks: [{
      chunkId: "chunk-1",
      ordinal: 0,
      startByte: 0,
      endByte: 20,
      text: "Remember REAP_DRAIN.",
    }],
    text: "Remember REAP_DRAIN.",
    continuationLocators: [],
    maxTokens: 100,
    renderedText: "[ARCHIVED HISTORICAL EVIDENCE]",
    returnedTokens: 8,
  },
  "store.preflight": {
    modelVisibleText: "[ARCHIVED HISTORICAL EVIDENCE]",
    hints: [{
      documentId: document.documentId,
      text: "[ARCHIVED HISTORICAL EVIDENCE]",
      tokenCount: 8,
      sourceKind: "turn",
      archivedDataDelimited: true,
      disclosureType: "historical-snippet",
    }],
  },
  "store.remove-hints": { removed: 1, notFound: 1 },
  "store.count": { count: 1 },
  "store.protect": {
    ownerId: "client-1",
    expiresAt: 61_000,
    protectedSessions: 1,
    protectedDocuments: 1,
  },
  "store.release-protection": { released: 2 },
  "store.pin": { status: "pinned", pinId: "pin-1" },
  "store.unpin": { status: "unpinned", pinId: "pin-1" },
  "store.resolve-subject": {
    status: "resolved",
    documentId: document.documentId,
    version: 1,
    kind: "turn",
    subjectKey: "decision:REAP_DRAIN",
  },
  "store.redact": {
    status: "complete",
    scanned: 1,
    tombstoned: 1,
    alreadyTombstoned: 0,
    protected: 0,
    missing: 0,
    hintsCleared: 2,
  },
  "retention.run": {
    status: "complete",
    scanned: 20,
    tombstoned: 3,
    deletedKeys: 12,
    protected: 2,
  },
  "retention.status": {
    liveDocuments: 10,
    liveLogicalBytes: 2_048,
    pins: 1,
    leases: 2,
    expiredVersions: 3,
    cleanupBacklog: 0,
    emergencyMode: false,
  },
  "feedback.stats": {
    events: 3,
    shownTotal: 7,
    recalledTotal: 2,
    byMode: { lexical: { shown: 5, recalled: 2 }, exact: { shown: 2, recalled: 0 } },
    byRank: [
      { rank: 0, shown: 3, recalled: 2 },
      { rank: 1, shown: 4, recalled: 0 },
    ],
    queries: [
      { query: "reap drain", searches: 2, shown: 5, recalled: 2 },
      { query: "shutdown", searches: 1, shown: 2, recalled: 0 },
    ],
    chainCount: 1,
    chainRate: 1 / 3,
    chains: [
      { sessionId: "session-1", missQueryKey: "shutdown", missSeq: 1, hitQueryKey: "reap drain", hitSeq: 2 },
    ],
    chainQueryKeys: ["shutdown", "reap drain"],
  },
  "store.compact": { status: "complete", bytesBefore: 2_048, bytesAfter: 1_024 },
  "daemon.status": {
    ready: true,
    processId: 42,
    storePath: "/tmp/context-window.rocks",
    startedAt: 1_000,
    schemaVersion: 1,
    protocolVersion: 1,
    capabilities: STORE_OPERATIONS,
    backgroundErrors: [],
    slowRequests: [],
  },
  "daemon.ping": { nonce: "ping-1", serverTime: 2_000 },
  "daemon.shutdown": { accepted: true },
  "migration.status": migration,
  "migration.activate-rocks": {
    backend: "rocksdb",
    mode: "verified-cutover",
    phase: "offline-ready",
    sourcePath: "/tmp/archive.db",
  },
  "migration.claim-sqlite": {
    backend: "sqlite",
    phase: "offline-ready",
    sourcePath: "/tmp/archive.db",
  },
  "migration.start": { accepted: true, status: migration },
  "migration.verify": {
    status: "passed",
    checked: 8,
    missing: 0,
    extra: 0,
    provenanceDifferences: 0,
    recallDifferences: 0,
    differences: 0,
    failures: 0,
    differenceCounts: {},
    failureCounts: {},
    comparisonHash: `sha256:${"a".repeat(64)}`,
    sampledDifferences: 0,
    samplesTruncated: false,
    artifactPath: "/tmp/verify.json",
  },
});

function expectContractError(action, { code, path }) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}

test("contract versions and operation registry are explicit and frozen", () => {
  assert.equal(STORE_SCHEMA_VERSION, 1);
  assert.equal(STORE_PROTOCOL_VERSION, 1);
  assert.equal(STORE_LOCATOR_VERSION, 1);
  assert.deepEqual(PROTOCOL_FRAME_TYPES, ["handshake", "handshake-ack", "request", "response"]);
  assert.deepEqual(STORE_OPERATIONS, Object.keys(requests));
  assert.ok(Object.isFrozen(STORE_OPERATIONS));
  assert.ok(Object.isFrozen(STORE_OPERATION_CONTRACTS));
  assert.ok(STORE_ERROR_CODES.includes("DISK_LOW"));
  assert.ok(STORE_ERROR_CODES.includes("LOCATOR_INVALID"));
});

test("canonical schemas accept hostile identifiers and reject unknown fields", () => {
  assert.equal(assertContract(DOCUMENT_SCHEMA, document), document);
  assertContract(EVENT_SCHEMA, {
    eventId: "event/\u0000/雪",
    sourceKey: "source/\u0000",
    sessionId: "session/one",
    project: "/project/雪",
    sequence: 1,
    kind: "user",
    createdAt: 1,
    content: "hello",
    metadata: {},
  });
  const schemaMetadata = {
    schemaVersion: 1,
    minimumReadableVersion: 1,
    minimumWritableVersion: 1,
    createdAt: 1,
  };
  assertContract(STORE_SCHEMA_METADATA_SCHEMA, schemaMetadata);
  assert.equal(assertStoreSchemaMetadata(schemaMetadata), schemaMetadata);

  expectContractError(
    () => assertContract(DOCUMENT_SCHEMA, { ...document, zzz: true, aaa: true }),
    { code: "INVALID_REQUEST", path: "$.aaa" },
  );
  expectContractError(
    () => assertContract(DOCUMENT_SCHEMA, { ...document, version: 1.5 }),
    { code: "INVALID_REQUEST", path: "$.version" },
  );
});

test("canonical admission carries exact semantic supersession provenance", () => {
  const correction = {
    ...requests["store.put"],
    document: {
      ...document,
      subjectKey: "decision:storage-layout",
      supersedes: { documentId: "prior-decision", version: 3 },
    },
  };
  assert.equal(assertStoreRequest("store.put", correction), correction);
  assertContract(SUPERSESSION_SCHEMA, {
    documentId: "prior-decision",
    documentVersion: 3,
    status: "superseded",
    replacementDocumentId: document.documentId,
    replacementVersion: 1,
    project: document.project,
    subjectKey: "decision:storage-layout",
    supersessionType: "explicit",
    reason: "Explicit correction.",
    recordedAt: document.createdAt,
  });

  expectContractError(
    () => assertStoreRequest("store.put", {
      ...correction,
      document: {
        ...correction.document,
        supersedes: { ...correction.document.supersedes, locator: "not-canonical" },
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.supersedes.locator" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...correction,
      document: { ...correction.document, subjectKey: "" },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.subjectKey" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...correction,
      document: {
        ...correction.document,
        supersedes: { documentId: "prior-decision", version: 0 },
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.supersedes.version" },
  );
});

test("request contracts bound verified session lineage fan-out", () => {
  const oversized = {
    ...requests["store.search"],
    sessionIds: Array.from(
      { length: MAX_SESSION_LINEAGE_IDS + 1 },
      (_, index) => `session-${index}`,
    ),
  };
  expectContractError(
    () => assertStoreRequest("store.search", oversized),
    { code: "INVALID_REQUEST", path: "$.payload.sessionIds" },
  );
  expectContractError(
    () => assertStoreRequest("store.protect", {
      ...requests["store.protect"],
      documentVersions: Array.from(
        { length: MAX_PROTECTED_DOCUMENT_VERSIONS + 1 },
        (_, index) => ({ documentId: `document-${index}`, version: 1 }),
      ),
    }),
    { code: "INVALID_REQUEST", path: "$.payload.documentVersions" },
  );
  for (const operation of ["store.search", "store.preflight"]) {
    expectContractError(
      () => assertStoreRequest(operation, {
        ...requests[operation],
        excludeVisibleSourceKeys: Array.from(
          { length: MAX_VISIBLE_SOURCE_KEYS + 1 },
          (_, index) => `visible-${index}`,
        ),
      }),
      { code: "INVALID_REQUEST", path: "$.payload.excludeVisibleSourceKeys" },
    );
    expectContractError(
      () => assertStoreRequest(operation, {
        ...requests[operation],
        excludeVisibleSourceKeys: Array.from(
          { length: MAX_VISIBLE_SOURCE_KEYS },
          (_, index) => `${index}:${"v".repeat(Math.ceil(
            MAX_VISIBLE_SOURCE_KEY_BYTES / MAX_VISIBLE_SOURCE_KEYS,
          ))}`,
        ),
      }),
      { code: "INVALID_REQUEST", path: "$.payload.excludeVisibleSourceKeys" },
    );
  }
  expectContractError(
    () => assertStoreRequest("store.preflight", {
      ...requests["store.preflight"],
      activeMessageKeys: Array.from(
        { length: MAX_ACTIVE_HINT_MESSAGE_KEYS + 1 },
        (_, index) => `user:${index}`,
      ),
    }),
    { code: "INVALID_REQUEST", path: "$.payload.activeMessageKeys" },
  );
  expectContractError(
    () => assertStoreRequest("store.preflight", {
      ...requests["store.preflight"],
      activeMessageKeys: Array.from(
        { length: MAX_ACTIVE_HINT_MESSAGE_KEYS },
        (_, index) => `${index}:${"a".repeat(Math.ceil(
          MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES / MAX_ACTIVE_HINT_MESSAGE_KEYS,
        ))}`,
      ),
    }),
    { code: "INVALID_REQUEST", path: "$.payload.activeMessageKeys" },
  );
  expectContractError(
    () => assertStoreRequest("store.preflight", {
      ...requests["store.preflight"],
      activeMessageKeys: ["user:1", null],
    }),
    { code: "INVALID_REQUEST", path: "$.payload.activeMessageKeys[1]" },
  );
});

test("canonical admission contracts bound record-expanding source fan-out", () => {
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        sourceMessageKeys: Array.from(
          { length: MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT + 1 },
          (_, index) => `source-${index}`,
        ),
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.sourceMessageKeys" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      structuralMessages: Array.from(
        { length: MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT + 1 },
        (_, index) => ({
          messageKey: `message-${index}`,
          messageIndex: index,
          role: "user",
          createdAt: index,
          text: "bounded",
        }),
      ),
    }),
    { code: "INVALID_REQUEST", path: "$.payload.structuralMessages" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        sourceMessageKeys: Array.from(
          { length: MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT },
          (_, index) => `${index}:${"x".repeat(Math.ceil(
            MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT / MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT,
          ))}`,
        ),
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.sourceMessageKeys" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      structuralMessages: Array.from(
        { length: MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT },
        (_, index) => ({
          messageKey: `${index}:${"k".repeat(Math.ceil(
            MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT / MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
          ))}`,
          messageIndex: index,
          role: "user",
          createdAt: index,
          text: "",
        }),
      ),
    }),
    { code: "INVALID_REQUEST", path: "$.payload.structuralMessages" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      structuralMessages: [{
        messageKey: "oversized-structural-message",
        messageIndex: 0,
        role: "user",
        createdAt: 0,
        text: "x".repeat(MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT + 1),
      }],
    }),
    { code: "INVALID_REQUEST", path: "$.payload.structuralMessages" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        text: "x".repeat(MAX_DOCUMENT_TEXT_BYTES + 1),
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.text" },
  );
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        metadata: { payload: "x".repeat(MAX_DOCUMENT_METADATA_BYTES + 1) },
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.metadata" },
  );
});

test("canonical admission text limit measures UTF-8 bytes", () => {
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        text: `é${"x".repeat(MAX_DOCUMENT_TEXT_BYTES - 1)}`,
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.text" },
  );
});

test("incompatible on-disk schema versions fail before backend access", () => {
  expectContractError(
    () => assertStoreSchemaMetadata({
      schemaVersion: 2,
      minimumReadableVersion: 2,
      minimumWritableVersion: 2,
      createdAt: 1,
    }),
    { code: "UNSUPPORTED_SCHEMA_VERSION", path: "$.schema.schemaVersion" },
  );
  expectContractError(
    () => assertStoreSchemaMetadata({
      schemaVersion: 1,
      minimumReadableVersion: 1,
      minimumWritableVersion: 2,
      createdAt: 1,
    }),
    { code: "UNSUPPORTED_SCHEMA_VERSION", path: "$.schema.minimumWritableVersion" },
  );
});

test("metadata accepts JSON but rejects non-JSON and cyclic values", () => {
  expectContractError(
    () => assertContract(DOCUMENT_SCHEMA, { ...document, metadata: { invalid: 1n } }),
    { code: "INVALID_REQUEST", path: "$.metadata.invalid" },
  );
  expectContractError(
    () => assertContract(DOCUMENT_SCHEMA, { ...document, metadata: { invalid: new Date() } }),
    { code: "INVALID_REQUEST", path: "$.metadata.invalid" },
  );
  const cycle = {};
  cycle.self = cycle;
  expectContractError(
    () => assertContract(DOCUMENT_SCHEMA, { ...document, metadata: cycle }),
    { code: "INVALID_REQUEST", path: "$.metadata.self" },
  );
  let deeplyNested = null;
  for (let depth = 0; depth <= MAX_JSON_VALUE_DEPTH; depth += 1) deeplyNested = [deeplyNested];
  expectContractError(
    () => assertStoreRequest("store.put", {
      ...requests["store.put"],
      document: {
        ...requests["store.put"].document,
        metadata: { deeplyNested },
      },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.document.metadata.deeplyNested" },
  );
});

test("every current and planned operation validates its request and result", () => {
  for (const operation of STORE_OPERATIONS) {
    assert.equal(assertStoreRequest(operation, requests[operation]), requests[operation], operation);
    assert.equal(assertStoreResult(operation, results[operation]), results[operation], operation);
  }
  const { slowRequests: _slowRequests, ...legacyStatus } = results["daemon.status"];
  assert.equal(assertStoreResult("daemon.status", legacyStatus), legacyStatus);
});

test("daemon slow-request stage timings are bounded to privacy-safe fields", () => {
  const timedStatus = {
    ...results["daemon.status"],
    memory: {
      rssBytes: 1_024,
      maxRssBytes: 2_048,
      heapTotalBytes: 512,
      heapUsedBytes: 256,
      externalBytes: 128,
      arrayBuffersBytes: 64,
    },
    startupTimings: {
      pathsAndLockMs: 1,
      storeRuntimeMs: 12,
      socketPreparationMs: 2,
      listenMs: 3,
      startupOtherMs: 1,
      totalMs: 19,
    },
    slowRequests: [{
      operation: "store.gather",
      requestBytes: 512,
      durationMs: 20,
      completedAt: 2_000,
      ok: true,
      stageTimings: {
        maintenanceMs: 1,
        candidateSearchMs: 3,
        semanticMs: 8,
        requestOtherMs: 8,
      },
    }],
  };
  assert.equal(assertStoreResult("daemon.status", timedStatus), timedStatus);
  expectContractError(
    () => assertStoreResult("daemon.status", {
      ...timedStatus,
      slowRequests: [{
        ...timedStatus.slowRequests[0],
        stageTimings: {
          ...timedStatus.slowRequests[0].stageTimings,
          query: "private query text",
        },
      }],
    }),
    { code: "INVALID_RESPONSE", path: "$.result.slowRequests[0].stageTimings.query" },
  );
});

test("search response evidence rejects negative and out-of-range confidence values", () => {
  const invalid = [
    ["score", -0.01],
    ["score", 1.01],
    ["rawScore", -0.01],
    ["calibratedScore", -0.01],
    ["calibratedScore", 1.01],
    ["margin", -0.01],
    ["margin", 1.01],
  ];
  for (const [field, value] of invalid) {
    expectContractError(
      () => assertStoreResult("store.search", {
        ...results["store.search"],
        results: [{ ...results["store.search"].results[0], [field]: value }],
      }),
      { code: "INVALID_RESPONSE", path: `$.result.results[0].${field}` },
    );
  }
});

test("gathered anchor evidence may carry an optional relevance score and mode, still bounded to [0, 1]", () => {
  const scoredAnchor = {
    ...results["store.gather"].evidence[0],
    score: 0.62,
    retrievalMode: "lexical",
  };
  const withScore = assertStoreResult("store.gather", {
    ...results["store.gather"],
    evidence: [scoredAnchor],
  });
  assert.equal(withScore.evidence[0].score, 0.62);
  assert.equal(withScore.evidence[0].retrievalMode, "lexical");

  // Chronological before/after evidence omitting score/retrievalMode remains
  // valid — only anchors carry a search-ranked relevance signal.
  assertStoreResult("store.gather", results["store.gather"]);

  for (const value of [-0.01, 1.01]) {
    expectContractError(
      () => assertStoreResult("store.gather", {
        ...results["store.gather"],
        evidence: [{ ...scoredAnchor, score: value }],
      }),
      { code: "INVALID_RESPONSE", path: "$.result.evidence[0].score" },
    );
  }
});

test("workingSet is an optional ranking-boost field on store.search/store.gather requests and results", () => {
  const searchWithWorkingSet = assertStoreRequest("store.search", {
    ...requests["store.search"],
    workingSet: ["src/rocksdb/index/exact.js", "REAP_DRAIN"],
  });
  assert.deepEqual(searchWithWorkingSet.workingSet, ["src/rocksdb/index/exact.js", "REAP_DRAIN"]);
  // Absent entirely remains valid: workingSet is optional, not required.
  assertStoreRequest("store.search", requests["store.search"]);

  const gatherWithWorkingSet = assertStoreRequest("store.gather", {
    ...requests["store.gather"],
    workingSet: ["src/rocksdb/index/exact.js"],
  });
  assert.deepEqual(gatherWithWorkingSet.workingSet, ["src/rocksdb/index/exact.js"]);

  for (const operation of ["store.search", "store.gather"]) {
    expectContractError(
      () => assertStoreRequest(operation, {
        ...requests[operation],
        workingSet: Array.from({ length: 17 }, (_, index) => `anchor-${index}`),
      }),
      { code: "INVALID_REQUEST", path: "$.payload.workingSet" },
    );
  }

  const boostedResult = assertStoreResult("store.search", {
    ...results["store.search"],
    results: [{ ...results["store.search"].results[0], workingSetAnchors: ["REAP_DRAIN"] }],
  });
  assert.deepEqual(boostedResult.results[0].workingSetAnchors, ["REAP_DRAIN"]);
  // Absent entirely remains valid: most results are never boosted.
  assertStoreResult("store.search", results["store.search"]);

  const boostedAnchorEvidence = assertStoreResult("store.gather", {
    ...results["store.gather"],
    evidence: [{ ...results["store.gather"].evidence[0], workingSetAnchors: ["REAP_DRAIN"] }],
  });
  assert.deepEqual(boostedAnchorEvidence.evidence[0].workingSetAnchors, ["REAP_DRAIN"]);
});

// Same optional-field contract shape as workingSet above, for sessionContext
// (ultracode task #32).
test("sessionContext is an optional ranking-boost field on store.search/store.gather requests and results", () => {
  const searchWithSessionContext = assertStoreRequest("store.search", {
    ...requests["store.search"],
    sessionContext: ["pallet", "rout", "planner"],
  });
  assert.deepEqual(searchWithSessionContext.sessionContext, ["pallet", "rout", "planner"]);
  // Absent entirely remains valid: sessionContext is optional, not required.
  assertStoreRequest("store.search", requests["store.search"]);

  const gatherWithSessionContext = assertStoreRequest("store.gather", {
    ...requests["store.gather"],
    sessionContext: ["pallet"],
  });
  assert.deepEqual(gatherWithSessionContext.sessionContext, ["pallet"]);

  for (const operation of ["store.search", "store.gather"]) {
    expectContractError(
      () => assertStoreRequest(operation, {
        ...requests[operation],
        sessionContext: Array.from({ length: 17 }, (_, index) => `term-${index}`),
      }),
      { code: "INVALID_REQUEST", path: "$.payload.sessionContext" },
    );
  }

  const boostedResult = assertStoreResult("store.search", {
    ...results["store.search"],
    results: [{ ...results["store.search"].results[0], sessionContextTerms: ["pallet"] }],
  });
  assert.deepEqual(boostedResult.results[0].sessionContextTerms, ["pallet"]);
  // Absent entirely remains valid: most results are never boosted.
  assertStoreResult("store.search", results["store.search"]);

  const boostedAnchorEvidence = assertStoreResult("store.gather", {
    ...results["store.gather"],
    evidence: [{ ...results["store.gather"].evidence[0], sessionContextTerms: ["pallet"] }],
  });
  assert.deepEqual(boostedAnchorEvidence.evidence[0].sessionContextTerms, ["pallet"]);
});

test("searchEffort is an optional caller-uncertainty field on store.search/store.gather requests, defaulting to normal", () => {
  for (const operation of ["store.search", "store.gather"]) {
    // Absent entirely remains valid: searchEffort is optional, not required,
    // and its absence is what keeps default behavior byte-for-byte.
    assertStoreRequest(operation, requests[operation]);

    const wide = assertStoreRequest(operation, { ...requests[operation], searchEffort: "wide" });
    assert.equal(wide.searchEffort, "wide");

    const normal = assertStoreRequest(operation, { ...requests[operation], searchEffort: "normal" });
    assert.equal(normal.searchEffort, "normal");

    expectContractError(
      () => assertStoreRequest(operation, { ...requests[operation], searchEffort: "maximum" }),
      { code: "INVALID_REQUEST", path: "$.payload.searchEffort" },
    );
  }
});

test("unknown operations and fields fail with stable codes and paths", () => {
  expectContractError(
    () => assertStoreRequest("store.destroy", {}),
    { code: "UNKNOWN_OPERATION", path: "$.operation" },
  );
  expectContractError(
    () => assertStoreRequest("store.get", { documentId: "doc-1", offset: 4 }),
    { code: "INVALID_REQUEST", path: "$.payload.offset" },
  );
  expectContractError(
    () => assertStoreRequest("store.preflight", {
      ...requests["store.preflight"],
      activeMessages: ["user:1"],
    }),
    { code: "INVALID_REQUEST", path: "$.payload.activeMessages" },
  );
  expectContractError(
    () => assertStoreResult("store.count", { count: 1, approximate: true }),
    { code: "INVALID_RESPONSE", path: "$.result.approximate" },
  );
  expectContractError(
    () => assertStoreRequest("migration.start", { sourcePath: "/tmp/archive.db" }),
    { code: "INVALID_REQUEST", path: "$.payload.offline" },
  );
});

test("locator claims bind version, match, generation, lease, and authorization scope", () => {
  const locator = {
    locatorVersion: 1,
    documentId: "doc-1",
    documentVersion: 2,
    windowOrdinal: 3,
    matchRange: { startByte: 20, endByte: 31 },
    indexGeneration: 9,
    leaseId: "lease-1",
    project: "/project/a",
    sessionId: "session-1",
    scope: "session",
    issuedAt: 1_000,
    expiresAt: 2_000,
  };
  assert.equal(assertLocatorPayload(locator), locator);
  assertContract(LOCATOR_PAYLOAD_SCHEMA, locator);

  expectContractError(
    () => assertLocatorPayload({ ...locator, locatorVersion: 2 }),
    { code: "LOCATOR_INVALID", path: "$.locator.locatorVersion" },
  );
  expectContractError(
    () => assertLocatorPayload({ ...locator, matchRange: { startByte: 40, endByte: 20 } }),
    { code: "LOCATOR_INVALID", path: "$.locator.matchRange.endByte" },
  );
  expectContractError(
    () => assertLocatorPayload({ ...locator, issuedAt: 3_000 }),
    { code: "LOCATOR_INVALID", path: "$.locator.expiresAt" },
  );
});

test("handshake enforces exact fields and rejects incompatible protocol versions", () => {
  const handshake = {
    protocolVersion: 1,
    type: "handshake",
    client: "pi-extension",
    clientVersion: "0.1.0",
    project: "/project/a",
  };
  assert.equal(assertHandshakeRequest(handshake), handshake);
  expectContractError(
    () => assertHandshakeRequest({ ...handshake, protocolVersion: 2 }),
    { code: "UNSUPPORTED_PROTOCOL_VERSION", path: "$.protocolVersion" },
  );
  expectContractError(
    () => assertHandshakeRequest({ ...handshake, auth: "surprise" }),
    { code: "INVALID_REQUEST", path: "$.auth" },
  );

  const accepted = createHandshakeAccepted({
    serverVersion: "0.1.0",
    processId: 42,
    storePath: "/tmp/context-window.rocks",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.schemaVersion, 1);
  assert.deepEqual(accepted.capabilities, STORE_OPERATIONS);

  const rejected = createHandshakeRejected(
    new ContractError("UNSUPPORTED_PROTOCOL_VERSION", "$.protocolVersion", "unsupported"),
  );
  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.error.details, { path: "$.protocolVersion" });
});

test("request and response envelopes validate payloads before crossing the wire", () => {
  const request = {
    protocolVersion: 1,
    type: "request",
    requestId: "request-1",
    operation: "store.count",
    payload: { scope: "all" },
  };
  assert.equal(assertRequestFrame(request), request);

  const response = createSuccessResponse(request, { count: 12 });
  assert.equal(assertResponseFrame(response), response);
  assert.deepEqual(response, {
    protocolVersion: 1,
    type: "response",
    requestId: "request-1",
    operation: "store.count",
    ok: true,
    result: { count: 12 },
  });

  expectContractError(
    () => assertRequestFrame({ ...request, payload: { scope: "all", mystery: true } }),
    { code: "INVALID_REQUEST", path: "$.payload.mystery" },
  );
  expectContractError(
    () => assertResponseFrame({ ...response, result: { count: -1 } }),
    { code: "INVALID_RESPONSE", path: "$.result.count" },
  );
});

test("error responses preserve correlation for malformed and unknown requests", () => {
  const error = createErrorResponse(
    { requestId: "bad-1", operation: "store.destroy" },
    new ContractError("UNKNOWN_OPERATION", "$.operation", "unknown operation"),
  );
  assert.equal(error.requestId, "bad-1");
  assert.equal(error.operation, "store.destroy");
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "UNKNOWN_OPERATION");
  assert.equal(error.error.retryable, false);
  assert.deepEqual(error.error.details, { path: "$.operation" });

  const oversized = createErrorResponse({}, new Error("x".repeat(9_000)));
  assert.equal(oversized.error.code, "INTERNAL");
  assert.equal(oversized.error.message.length, MAX_STORE_ERROR_MESSAGE_LENGTH);
  assert.match(oversized.error.message, /…$/u);

  const cyclicDetails = {};
  cyclicDetails.self = cyclicDetails;
  const malformedCorrelation = createErrorResponse({
    requestId: "r".repeat(MAX_STORE_IDENTIFIER_LENGTH + 1),
    operation: "o".repeat(MAX_STORE_IDENTIFIER_LENGTH + 1),
  }, new Error("bounded"), { details: cyclicDetails });
  assert.equal(malformedCorrelation.requestId.length, MAX_STORE_IDENTIFIER_LENGTH);
  assert.equal(malformedCorrelation.operation.length, MAX_STORE_IDENTIFIER_LENGTH);
  assert.equal(Object.hasOwn(malformedCorrelation.error, "details"), false);

  const oversizedDetails = createErrorResponse({}, new Error("bounded"), {
    details: { payload: "x".repeat(9_000) },
  });
  assert.deepEqual(oversizedDetails.error.details, { truncated: true });

  const diskLow = createErrorResponse(
    { requestId: "disk-low-1", operation: "store.put" },
    Object.assign(new Error("filesystem reserve reached"), { code: "DISK_LOW" }),
  );
  assert.equal(diskLow.error.code, "DISK_LOW");
  assert.equal(diskLow.error.retryable, true);

  const internal = createErrorResponse({}, new Error("boom"));
  assert.equal(internal.error.code, "INTERNAL");
  assert.equal(internal.error.message, "boom");
});

test("maximum recall tokens remain below the encoded response frame", () => {
  const request = {
    protocolVersion: 1,
    type: "request",
    requestId: "maximum-recall-response",
    operation: "store.recall",
    payload: {
      locator: "locator.v1.maximum",
      neighbors: 0,
      maxTokens: MAX_RECALL_TOKENS,
    },
  };
  const worstEscapedVisibleText = "\0".repeat(MAX_RECALL_TOKENS * 4);
  const response = createSuccessResponse(request, {
    status: "resolved",
    documentId: "maximum-recall-document",
    version: 1,
    kind: "turn",
    sessionId: "maximum-recall-session",
    project: "/maximum-recall-project",
    createdAt: 1,
    historical: true,
    stalenessLabel: "Archived historical evidence; verify current state.",
    sourceMessages: { status: "documented-absence", reason: "not retained" },
    chunks: [{
      chunkId: "maximum-recall-chunk",
      ordinal: 0,
      startByte: 0,
      endByte: worstEscapedVisibleText.length,
      text: worstEscapedVisibleText,
    }],
    text: worstEscapedVisibleText,
    continuationLocators: [],
    maxTokens: MAX_RECALL_TOKENS,
    renderedText: worstEscapedVisibleText,
    returnedTokens: MAX_RECALL_TOKENS,
  });
  const encoded = encodeProtocolFrame(response);
  assert.ok(Buffer.byteLength(encoded, "utf8") - 1 < DEFAULT_MAX_FRAME_BYTES);
  expectContractError(
    () => assertRequestFrame({
      ...request,
      payload: { ...request.payload, maxTokens: MAX_RECALL_TOKENS + 1 },
    }),
    { code: "INVALID_REQUEST", path: "$.payload.maxTokens" },
  );
});

test("NDJSON encoding and decoding round-trip one validated frame", () => {
  const request = {
    protocolVersion: 1,
    type: "request",
    requestId: "ping-request",
    operation: "daemon.ping",
    payload: { nonce: "nonce-1" },
  };
  const encoded = encodeProtocolFrame(request);
  assert.ok(encoded.endsWith("\n"));
  assert.deepEqual(decodeProtocolLine(encoded, { direction: "request" }), request);
  assert.deepEqual(decodeProtocolLine(Buffer.from(encoded)), request);

  expectContractError(
    () => decodeProtocolLine("{broken", { direction: "request" }),
    { code: "INVALID_REQUEST", path: "$" },
  );
  expectContractError(
    () => decodeProtocolLine(`${encoded}${encoded}`, { direction: "request" }),
    { code: "INVALID_REQUEST", path: "$" },
  );
  expectContractError(
    () => decodeProtocolLine(JSON.stringify({ ...request, protocolVersion: 99 })),
    { code: "UNSUPPORTED_PROTOCOL_VERSION", path: "$.protocolVersion" },
  );
});

test("unresolved recall never resolves an expired locator to a new version", () => {
  const expired = { status: "expired", documentId: "doc-1", version: 1, reason: "retention expired" };
  assert.equal(assertStoreResult("store.recall", expired), expired);
  expectContractError(
    () => assertStoreResult("store.recall", { ...expired, document: { ...document, version: 2 } }),
    { code: "INVALID_RESPONSE", path: "$.result" },
  );
});

const minimalResolvedRecall = Object.freeze({
  status: "resolved",
  documentId: "chain-doc",
  version: 2,
  kind: "manual",
  sessionId: "chain-session",
  project: "/chain-project",
  createdAt: 200,
  historical: true,
  stalenessLabel: "Archived historical evidence; verify current state.",
  sourceMessages: { status: "documented-absence", reason: "not retained" },
  chunks: [{ chunkId: "chain-chunk", ordinal: 0, startByte: 0, endByte: 4, text: "text" }],
  text: "text",
  continuationLocators: [],
  maxTokens: 1_000,
  renderedText: "text",
  returnedTokens: 39,
});

test("resolved and unresolved recall accept an optional chain-position summary (ultracode task #38)", () => {
  assert.equal(assertStoreResult("store.recall", minimalResolvedRecall), minimalResolvedRecall);

  const withChain = {
    ...minimalResolvedRecall,
    chain: {
      position: 2,
      totalVersions: 3,
      predecessor: { documentId: "chain-doc-v1", version: 1, createdAt: 100 },
      successor: { documentId: "chain-doc-v3", version: 1, createdAt: 300 },
    },
  };
  assert.equal(assertStoreResult("store.recall", withChain), withChain);

  const unresolvedWithChain = {
    status: "superseded",
    documentId: "chain-doc",
    version: 1,
    reason: "Explicitly replaced.",
    chain: { position: 1, totalVersions: 2, successor: { documentId: "chain-doc-v2", version: 1, createdAt: 200 } },
  };
  assert.equal(assertStoreResult("store.recall", unresolvedWithChain), unresolvedWithChain);

  expectContractError(
    () => assertStoreResult("store.recall", {
      ...minimalResolvedRecall,
      chain: { totalVersions: 3, predecessor: { documentId: "chain-doc-v1", version: 1, createdAt: 100 } },
    }),
    { code: "INVALID_RESPONSE", path: "$.result" },
  );
  expectContractError(
    () => assertStoreResult("store.recall", {
      ...minimalResolvedRecall,
      chain: { position: 2, totalVersions: 3, predecessor: { documentId: "chain-doc-v1" } },
    }),
    { code: "INVALID_RESPONSE", path: "$.result" },
  );
  expectContractError(
    () => assertStoreResult("store.recall", {
      ...minimalResolvedRecall,
      chain: { position: 2, totalVersions: 3, unexpected: true },
    }),
    { code: "INVALID_RESPONSE", path: "$.result" },
  );
});
