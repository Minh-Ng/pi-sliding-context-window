import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
  EpochWindowSession,
  OversizedInputArchiveError,
  ROTATION_STATE_ENTRY,
  TOC_MAX_ENTRIES,
} from "../src/epoch-window.js";
import {
  createCompactionCatalog,
  reconstructCheckpointSource,
} from "../src/archive-checkpoint.js";
import { estimateModelVisibleTokens } from "../src/model-token-budget.js";
import { archiveDocumentProvenance } from "../src/provenance.js";
import { MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT } from "../src/store-contract.js";
import { estimateTokens, messageKey, serializeMessage, serializeMessages } from "../src/window.js";

const config = {
  rotationTokens: 100_000,
  rotationTurns: 3,
  hardLimitTokens: 120_000,
  retainTurns: 1,
  maxInlineUserTokens: 16_000,
  maxToolResultTokens: 4_000,
  maxToolArgumentTokens: 4_000,
  searchResults: 3,
  searchResultTokens: 1_500,
  preventAutoCompaction: true,
  dbPath: "/tmp/archive.db",
};

function user(text, timestamp) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text, timestamp) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

function persistedLegacyBoundaryKey(message) {
  const digest = createHash("sha256")
    .update(serializeMessage(message).slice(0, 8_000))
    .digest("hex")
    .slice(0, 12);
  return `${message.role}:${message.timestamp}::${digest}`;
}

function memoryArchive() {
  const documents = new Map();
  return {
    documents,
    closed: false,
    put(document) {
      const id = document.id ?? `doc-${documents.size + 1}`;
      documents.set(id, { ...document, id });
      return id;
    },
    search() { return []; },
    get(id) { return documents.get(id); },
    count() { return documents.size; },
    close() { this.closed = true; },
  };
}

function trackingMemoryArchive() {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  archive.putCalls = 0;
  archive.pruneCalls = 0;
  archive.protectionRequests = [];
  archive.put = (document, options) => {
    archive.putCalls += 1;
    return put(document, options);
  };
  archive.prune = () => {
    archive.pruneCalls += 1;
  };
  archive.setProtectedContext = (request) => {
    archive.protectionRequests.push(structuredClone(request));
  };
  return archive;
}

function archiveEntryIds(entries) {
  return new Set(entries.flatMap((entry) => [
    entry.publicationId,
    entry.rootId,
    ...entry.partIds,
  ]));
}

function checkpointHashParts(parts) {
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

function seedLegacyCheckpoint(archive, {
  text,
  project,
  sessionId,
  sourceKey,
  kind,
}) {
  const hash = createHash("sha256").update(text).digest("hex");
  const sourceIdentity = checkpointHashParts([
    "archive-checkpoint-source-v1",
    project,
    sessionId,
    sourceKey,
    kind,
    hash,
  ]);
  const publicationId = `checkpoint-publication:${checkpointHashParts([
    "archive-checkpoint-publication-v1",
    sourceIdentity,
  ])}`;
  const rootId = `checkpoint-root:${checkpointHashParts([
    "archive-checkpoint-root-v1",
    sourceIdentity,
    publicationId,
  ])}`;
  const partId = `checkpoint-part:${checkpointHashParts([
    "archive-checkpoint-part-v1",
    project,
    sessionId,
    rootId,
    hash,
  ])}`;
  const byteCount = Buffer.byteLength(text, "utf8");
  archive.documents.set(partId, {
    id: partId,
    text: `[context-window exact checkpoint part v1]\n${text}`,
  });
  archive.documents.set(rootId, {
    id: rootId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "root",
      rootId,
      publicationId,
      sourceIdentity,
      sessionId,
      project,
      sourceKey,
      sourceKind: kind,
      encoding: "utf8",
      byteCount,
      hash,
      parts: [{
        id: partId,
        ordinal: 0,
        startByte: 0,
        endByte: byteCount,
        byteCount,
        hash,
      }],
    }),
  });
  archive.documents.set(publicationId, {
    id: publicationId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "publication",
      publicationId,
      sourceIdentities: [sourceIdentity],
      rootIds: [rootId],
    }),
  });
  return { publicationId, rootId, partId };
}

function seedVerifiedCheckpointEntries(archive, partCounts, {
  project = "/project",
  sessionId = "seeded-checkpoint-session",
} = {}) {
  const emptyHash = createHash("sha256").update("").digest("hex");
  const sources = partCounts.map((_, index) => {
    const sourceKey = `seeded-source-${index}`;
    const sourceIdentity = checkpointHashParts([
      "archive-checkpoint-source-v1",
      project,
      sessionId,
      sourceKey,
      "compaction-span",
      emptyHash,
    ]);
    return { sourceKey, sourceIdentity };
  });
  const publicationId = `checkpoint-publication:${checkpointHashParts([
    "archive-checkpoint-publication-v1",
    ...sources.map(({ sourceIdentity }) => sourceIdentity),
  ])}`;
  const rootIds = sources.map(({ sourceIdentity }) =>
    `checkpoint-root:${checkpointHashParts([
      "archive-checkpoint-root-v1",
      sourceIdentity,
      publicationId,
    ])}`);
  archive.documents.set(publicationId, {
    id: publicationId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "publication",
      publicationId,
      sourceIdentities: sources.map(({ sourceIdentity }) => sourceIdentity),
      rootIds,
    }),
  });

  return sources.map(({ sourceKey, sourceIdentity }, index) => {
    const rootId = rootIds[index];
    const partId = `checkpoint-part:${checkpointHashParts([
      "archive-checkpoint-part-v1",
      project,
      sessionId,
      rootId,
      emptyHash,
    ])}`;
    archive.documents.set(partId, {
      id: partId,
      text: "[context-window exact checkpoint part v1]\n",
    });
    const parts = Array.from({ length: partCounts[index] }, (_, ordinal) => ({
      id: partId,
      ordinal,
      startByte: 0,
      endByte: 0,
      byteCount: 0,
      hash: emptyHash,
    }));
    archive.documents.set(rootId, {
      id: rootId,
      text: JSON.stringify({
        checkpointFormatVersion: 1,
        recordType: "root",
        rootId,
        publicationId,
        sourceIdentity,
        sessionId,
        project,
        sourceKey,
        sourceKind: "compaction-span",
        encoding: "utf8",
        byteCount: 0,
        hash: emptyHash,
        parts,
      }),
    });
    return {
      rootId,
      publicationId,
      kind: "compaction-span",
      topic: "",
      terms: [],
      byteCount: 0,
      hash: emptyHash,
      partCount: parts.length,
      partIds: parts.map(({ id }) => id),
    };
  });
}

function pressureArchive(limit) {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  let protectedIds = new Set();
  archive.setProtectedContext = ({ documentIds = [] } = {}) => {
    protectedIds = new Set(documentIds);
  };
  archive.prune = () => {
    for (const id of archive.documents.keys()) {
      if (archive.documents.size <= limit) break;
      if (!protectedIds.has(id)) archive.documents.delete(id);
    }
  };
  archive.put = (document, { deferPrune = false } = {}) => {
    const id = put(document);
    if (!deferPrune) archive.prune();
    return archive.documents.has(id) ? id : undefined;
  };
  return archive;
}

test("session controller rotates, archives source turns, and emits durable state", () => {
  const archive = memoryArchive();
  const rotations = [];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  const active = session.process(messages, { contextWindow: 200_000 });

  const [marker, ...retained] = active;
  assert.equal(marker.role, "user");
  const markerText = marker.content[0].text;
  assert.match(markerText, /rotated out/);
  assert.match(markerText, /doc-1 "one"/);
  assert.match(markerText, /doc-2 "two"/);
  assert.deepEqual(retained, messages.slice(4));
  assert.equal(archive.documents.size, 2);
  const archived = [...archive.documents.values()];
  assert.equal(archived[0].text, serializeMessages(messages.slice(0, 2)));
  assert.deepEqual(archived[0].metadata, {
    startKey: messageKey(messages[0]),
    messageCount: 2,
    sourceMessageKeys: messages.slice(0, 2).map(messageKey),
    sourceFirstKey: messageKey(messages[0]),
    sourceLastKey: messageKey(messages[1]),
    sourceMessageCount: 2,
  });
  assert.deepEqual(archived[1].metadata.sourceMessageKeys, messages.slice(2, 4).map(messageKey));
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].boundaryKey, messageKey(messages[4]));
  assert.deepEqual(rotations[0].toc, [
    { id: "doc-1", topic: "one", terms: [] },
    { id: "doc-2", topic: "two", terms: [] },
  ]);
  assert.deepEqual(session.status(), {
    activeTokens: estimateTokens(active),
    activeTurns: 1,
    rotationTokens: 100_000,
    rotationTurns: 3,
    modelPattern: undefined,
    retainTurns: 1,
    rotations: 1,
    rotationPending: false,
    lastRotationReason: "turns",
    lastRotationMode: "normal",
    effectiveRetainTurns: 1,
    compactionFallbackReason: undefined,
    archivedDocuments: 2,
    dbPath: "/tmp/archive.db",
  });
});

test("rotation segments a message-heavy turn within archive provenance bounds", () => {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  archive.put = (document) => {
    const sourceMessageKeys = document.metadata?.sourceMessageKeys ?? [];
    assert.ok(sourceMessageKeys.length <= MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT);
    return put(document);
  };
  const heavyTurn = [
    user("message-heavy turn", 1),
    ...Array.from({ length: 300 }, (_, index) =>
      assistant(`step ${index + 1}`, index + 2)),
  ];
  const secondTurn = [user("second turn", 400), assistant("second answer", 401)];
  const retainedTurn = [user("retained turn", 500), assistant("retained answer", 501)];
  const messages = [...heavyTurn, ...secondTurn, ...retainedTurn];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "message-heavy-session",
    project: "/project",
  });

  const active = session.process(messages, { contextWindow: 200_000 });

  const documents = [...archive.documents.values()];
  assert.equal(documents.length, 3);
  assert.deepEqual(
    documents.flatMap((document) => document.metadata.sourceMessageKeys),
    [...heavyTurn, ...secondTurn].map((message) => messageKey(message)),
  );
  assert.equal(
    documents.map((document) => document.text).join("\n\n"),
    serializeMessages([...heavyTurn, ...secondTurn]),
  );
  assert.equal(session.rotationState().toc.length, 3);
  assert.deepEqual(active.slice(1), retainedTurn);
});

test("rotation does not advance its boundary when a required turn cannot be archived", () => {
  const archive = memoryArchive();
  archive.put = () => undefined;
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "capacity-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  assert.throws(
    () => session.process(messages, { contextWindow: 200_000 }),
    /capacity prevented storing a rotated turn/,
  );
  assert.equal(session.rotationState().boundaryKey, undefined);
  assert.equal(session.status().rotations, 0);
});

test("partial multi-turn admission failure does not mutate or duplicate TOC state", () => {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  let calls = 0;
  archive.put = (document) => {
    calls += 1;
    return calls === 2 ? undefined : put(document);
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "partial-capacity-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  assert.throws(
    () => session.process(messages, { contextWindow: 200_000 }),
    /capacity prevented storing a rotated turn/,
  );
  assert.deepEqual(session.rotationState().toc, []);
  assert.equal(session.rotationState().boundaryKey, undefined);

  archive.put = put;
  const result = session.process(messages, { contextWindow: 200_000 });
  const toc = session.rotationState().toc;
  assert.equal(toc.length, 2);
  assert.equal(new Set(toc.map(({ id }) => id)).size, 2);
  for (const { id } of toc) assert.match(result[0].content[0].text, new RegExp(id));
});

test("post-admission cleanup failure rolls back staged TOC state", () => {
  const archive = memoryArchive();
  let pruneCalls = 0;
  archive.prune = () => {
    pruneCalls += 1;
    if (pruneCalls === 2) throw new Error("cleanup failed");
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "cleanup-failure-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  assert.throws(
    () => session.process(messages, { contextWindow: 200_000 }),
    /cleanup failed/,
  );
  assert.deepEqual(session.rotationState().toc, []);
  assert.equal(session.rotationState().boundaryKey, undefined);

  archive.prune = () => {};
  session.process(messages, { contextWindow: 200_000 });
  const toc = session.rotationState().toc;
  assert.equal(toc.length, 2);
  assert.equal(new Set(toc.map(({ id }) => id)).size, 2);
});

test("token pressure rotates below the configured retention floor and restores deterministically", () => {
  const archive = memoryArchive();
  const rotations = [];
  const emergencyConfig = {
    ...config,
    rotationTokens: 1_200,
    hardLimitTokens: 5_000,
    rotationTurns: 20,
    retainTurns: 10,
  };
  const messages = [
    user("old large turn", 1), assistant("x".repeat(10_000), 2),
    user("recent two", 3), assistant("small two", 4),
    user("recent three", 5), assistant("small three", 6),
  ];
  const session = new EpochWindowSession({
    archive,
    config: emergencyConfig,
    sessionId: "session-1",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });

  const first = session.process(messages);
  assert.match(first[0].content[0].text, /rotated out/);
  assert.deepEqual(first.slice(1), messages.slice(2));
  assert.equal(archive.documents.size, 1);
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].reason, "tokens");
  assert.equal(rotations[0].mode, "emergency-retention");
  assert.equal(rotations[0].configuredRetainTurns, 10);
  assert.equal(rotations[0].effectiveRetainTurns, 2);
  assert.equal(rotations[0].boundaryKey, messageKey(messages[2]));

  const second = session.process(messages);
  assert.deepEqual(second, first);
  assert.equal(archive.documents.size, 1);
  assert.equal(session.status().rotations, 1);

  const restored = new EpochWindowSession({
    archive: memoryArchive(),
    config: emergencyConfig,
    sessionId: "session-1",
    project: "/project",
  });
  restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: rotations[0] }]);
  assert.deepEqual(restored.process(messages), first);
  assert.equal(restored.status().lastRotationReason, "tokens");
  assert.equal(restored.status().lastRotationMode, "emergency-retention");
  assert.equal(restored.status().effectiveRetainTurns, 2);

  const reset = session.resetAfterCompaction();
  assert.equal(reset.boundaryKey, undefined);
  assert.deepEqual(reset.toc, []);
  assert.equal(reset.mode, undefined);
  assert.equal(session.status().activeTokens, undefined);
  assert.equal(session.status().compactionFallbackReason, undefined);
});

test("an oversized latest turn requires archive-first compaction without mutating epoch state", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      rotationTokens: 1_200,
      hardLimitTokens: 5_000,
      rotationTurns: 20,
      retainTurns: 10,
    },
    sessionId: "session-1",
    project: "/project",
  });
  const messages = [
    user("old", 1), assistant("old", 2),
    user("oversized current", 3), assistant("x".repeat(10_000), 4),
  ];

  assert.deepEqual(session.process(messages), messages);
  assert.equal(archive.documents.size, 0);
  assert.equal(session.status().rotations, 0);
  assert.equal(session.status().compactionFallbackReason, "oversized-latest-turn");
  assert.equal(session.rotationState().boundaryKey, undefined);
});

test("externalized tool results retain their one original source message key", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
  });
  const originalToolResult = {
    role: "toolResult",
    content: [{ type: "text", text: "x".repeat(20_000) }],
    timestamp: 2,
    toolCallId: "call-large",
    toolName: "bash",
  };

  session.process([user("run", 1), originalToolResult]);

  const [document] = [...archive.documents.values()];
  const sourceKey = messageKey(originalToolResult);
  assert.equal(document.kind, "tool-result");
  assert.equal(document.metadata.sourceMessageKey, sourceKey);
  assert.deepEqual(archiveDocumentProvenance(document).sourceMessages, {
    status: "available",
    keys: [sourceKey],
    firstKey: sourceKey,
    lastKey: sourceKey,
    count: 1,
    archivedTurn: false,
  });
  assert.deepEqual(archiveDocumentProvenance(document).toolResult, {
    toolCallId: "call-large",
    toolName: "bash",
    sourceMessageKey: sourceKey,
    archivedTurn: false,
  });
});

test("externalized tool-call arguments retain their one original source message key", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
  });
  const originalToolCall = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-large-write",
      name: "write",
      arguments: { path: "/tmp/big.txt", content: "x".repeat(20_000) },
    }],
    timestamp: 2,
  };

  session.process([user("write a big file", 1), originalToolCall]);

  const [document] = [...archive.documents.values()];
  const sourceKey = messageKey(originalToolCall);
  assert.equal(document.kind, "tool-argument");
  assert.equal(document.metadata.sourceMessageKey, sourceKey);
  assert.match(document.text, /"path":"\/tmp\/big\.txt"/);
  assert.deepEqual(archiveDocumentProvenance(document).sourceMessages, {
    status: "available",
    keys: [sourceKey],
    firstKey: sourceKey,
    lastKey: sourceKey,
    count: 1,
    archivedTurn: false,
  });
  assert.deepEqual(archiveDocumentProvenance(document).toolArgument, {
    toolCallId: "call-large-write",
    toolName: "write",
    sourceMessageKey: sourceKey,
    archivedTurn: false,
  });
});

test("oversized tool-call arguments are archived while the dispatched call keeps its full arguments", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
  });
  const fullContent = "line of file content\n".repeat(2_000);
  // Simulate the host's own record of the already-dispatched tool call: this
  // exact object is what a real tool execution reads its arguments from, and
  // it must never be touched by context-window's provider-facing filtering.
  const dispatchedToolCall = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-dispatched-write",
      name: "write",
      arguments: { path: "/tmp/dispatched.txt", content: fullContent },
    }],
    timestamp: 2,
  };
  const dispatchedContentSnapshot = structuredClone(dispatchedToolCall.content);

  const providerMessages = session.process([user("write the file", 1), dispatchedToolCall]);

  // The tool already executed against dispatchedToolCall before this filter
  // ever ran; that record must remain byte-identical afterward so a caller
  // that already dispatched it (or would dispatch it again from its own
  // untouched session state) always sees the real arguments.
  assert.deepEqual(dispatchedToolCall.content, dispatchedContentSnapshot);
  assert.equal(dispatchedToolCall.content[0].arguments.content, fullContent);

  const providerCall = providerMessages[1].content[0];
  assert.equal(providerCall.id, "call-dispatched-write");
  // Anthropic tool_use.input, Bedrock Converse toolUse.input, and Gemini
  // functionCall.args all require a JSON object, so the externalized field
  // must stay object-shaped rather than becoming a bare preview string.
  assert.equal(typeof providerCall.arguments, "object");
  assert.notEqual(providerCall.arguments.preview, fullContent);
  assert.match(providerCall.arguments.preview, /use context_recall/);

  const [document] = [...archive.documents.values()];
  assert.equal(document.kind, "tool-argument");
  // The archived copy — what context_recall reconstructs — holds the exact
  // real arguments the tool executed with, not the bounded preview.
  assert.equal(document.text, JSON.stringify(dispatchedContentSnapshot[0].arguments));
  assert.match(document.text, /"path":"\/tmp\/dispatched\.txt"/);
});

test("tool-result previews retain every archive ID created in the same context batch", () => {
  const archive = pressureArchive(1);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, maxToolResultTokens: 10 },
    sessionId: "tool-batch-session",
    project: "/project",
  });
  const messages = [
    user("run tools", 1),
    {
      role: "toolResult",
      content: [{ type: "text", text: "a".repeat(10_000) }],
      timestamp: 2,
      toolCallId: "call-a",
      toolName: "read",
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "b".repeat(10_000) }],
      timestamp: 3,
      toolCallId: "call-b",
      toolName: "read",
    },
  ];

  const result = session.process(messages, { contextWindow: 200_000 });
  const ids = [...archive.documents.keys()];
  assert.equal(ids.length, 2);
  assert.match(result[1].content[0].text, new RegExp(ids[0]));
  assert.match(result[2].content[0].text, new RegExp(ids[1]));
});

test("multi-turn rotation protects every new TOC target before cleanup", () => {
  const archive = pressureArchive(1);
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "rotation-batch-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  const result = session.process(messages, { contextWindow: 200_000 });
  const markerText = result[0].content[0].text;
  assert.equal(archive.documents.size, 2);
  for (const id of archive.documents.keys()) assert.match(markerText, new RegExp(id));
});

test("forced rotation archives preamble keys in order under the current fork identity", () => {
  const archive = memoryArchive();
  const preamble = assistant("branch setup", 1);
  const messages = [
    preamble,
    user("parent one", 2), assistant("answer one", 3),
    user("parent two", 4), assistant("answer two", 5),
  ];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "child-session",
    project: "/forked/project",
  });
  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: { sessionId: "parent-session", sessionIds: ["parent-session"] },
  }]);
  session.requestRotation();

  const processed = session.process(messages);
  assert.match(processed[0].content[0].text, /rotated out/);
  assert.deepEqual(processed.slice(1), messages.slice(3));
  const [archivedPreamble, archivedTurn] = [...archive.documents.values()];
  assert.equal(archivedPreamble.kind, "preamble");
  assert.equal(archivedPreamble.sessionId, "child-session");
  assert.equal(archivedPreamble.project, "/forked/project");
  assert.deepEqual(archivedPreamble.metadata.sourceMessageKeys, [messageKey(preamble)]);
  assert.deepEqual(archivedTurn.metadata.sourceMessageKeys, messages.slice(1, 3).map(messageKey));
});

test("rotation archives synthetic Pi preambles with their real payloads", () => {
  const archive = memoryArchive();
  const synthetic = [
    {
      role: "bashExecution",
      command: "npm test",
      output: "synthetic-bash-output",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    },
    { role: "compactionSummary", summary: "native-compaction-context", tokensBefore: 371_566, timestamp: 2 },
    { role: "branchSummary", summary: "branch-summary-context", fromId: "branch-1", timestamp: 3 },
  ];
  const messages = [
    ...synthetic,
    user("one", 4), assistant("answer one", 5),
    user("two", 6), assistant("answer two", 7),
    user("three", 8), assistant("answer three", 9),
  ];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
  });

  session.process(messages);

  const preamble = [...archive.documents.values()].find((document) => document.kind === "preamble");
  assert.ok(preamble);
  assert.match(preamble.text, /npm test/);
  assert.match(preamble.text, /synthetic-bash-output/);
  assert.match(preamble.text, /native-compaction-context/);
  assert.match(preamble.text, /branch-summary-context/);
  assert.deepEqual(preamble.metadata.sourceMessageKeys, synthetic.map(messageKey));
});

test("session controller restores the latest persisted epoch boundary", () => {
  const archive = memoryArchive();
  const messages = [user("old", 1), assistant("old answer", 2), user("current", 3)];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
  });
  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: { sessionId: "session-1", boundaryKey: messageKey(messages[2]), rotations: 4 },
  }]);

  assert.deepEqual(session.process(messages), [messages[2]]);
  assert.equal(session.status().rotations, 4);
});

test("restores a legacy truncated-hash boundary and emits only full keys afterward", () => {
  const archive = memoryArchive();
  const rotations = [];
  const boundary = user(`${"x".repeat(8_100)} boundary`, 3);
  const messages = [
    user("already archived", 1), assistant("already archived answer", 2),
    boundary, assistant("boundary answer", 4),
    user("next", 5), assistant("next answer", 6),
    user(`${"y".repeat(8_100)} retained`, 7), assistant("retained answer", 8),
  ];
  const legacyKey = persistedLegacyBoundaryKey(boundary);
  assert.notEqual(legacyKey, messageKey(boundary));

  const session = new EpochWindowSession({
    archive,
    config: { ...config, rotationTurns: 99 },
    sessionId: "session-1",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });
  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: { sessionId: "session-1", boundaryKey: legacyKey, rotations: 1 },
  }]);

  assert.deepEqual(session.process(messages), messages.slice(2));
  assert.equal(session.rotationState().boundaryKey, legacyKey);
  assert.equal(archive.documents.size, 0);

  session.requestRotation();
  const rotated = session.process(messages);
  assert.match(rotated[0].content[0].text, /rotated out/);
  assert.deepEqual(rotated.slice(1), messages.slice(6));
  const archived = [...archive.documents.values()];
  assert.equal(archived.length, 2);
  assert.equal(archived[0].text, serializeMessages(messages.slice(2, 4)));
  assert.deepEqual(archived[0].metadata.sourceMessageKeys, messages.slice(2, 4).map(messageKey));
  assert.equal(archived[0].metadata.sourceMessageKeys[0], messageKey(boundary));
  assert.notEqual(archived[0].metadata.sourceMessageKeys[0], legacyKey);
  assert.equal(archived.some((document) => document.text.includes("already archived")), false);
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].boundaryKey, messageKey(messages[6]));
  assert.notEqual(rotations[0].boundaryKey, persistedLegacyBoundaryKey(messages[6]));
  assert.equal(session.rotationState().boundaryKey, messageKey(messages[6]));
});

test("restore accepts rotation state but ignores forged persisted lineage", () => {
  const archive = memoryArchive();
  const messages = [user("archived parent turn", 1), assistant("old answer", 2), user("fork point", 3)];
  let searchOptions;
  archive.search = (_query, options) => {
    searchOptions = options;
    return [];
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "child-session",
    initialSessionIds: ["verified-parent-session"],
    project: "/project",
  });
  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: {
      sessionId: "forged-parent-session",
      sessionIds: ["forged-grandparent-session"],
      boundaryKey: messageKey(messages[2]),
      rotations: 3,
    },
  }]);

  assert.deepEqual(session.process(messages), [messages[2]]);
  assert.equal(session.status().rotations, 3);
  session.search("parent evidence");
  assert.deepEqual(new Set(searchOptions.sessionIds), new Set([
    "verified-parent-session",
    "child-session",
  ]));
});

test("restore keeps only header-derived lineage for descendants", () => {
  const archive = memoryArchive();
  let searchOptions;
  archive.search = (_query, options) => {
    searchOptions = options;
    return [];
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "child-session",
    initialSessionIds: ["parent-session", "grandparent-session"],
    project: "/project",
  });

  session.restore([]);
  session.search("pre-rotation parent evidence", { scope: "session" });
  assert.deepEqual(new Set(searchOptions.sessionIds), new Set([
    "child-session", "parent-session", "grandparent-session",
  ]));

  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: { sessionId: "forged-session", sessionIds: "scalar-forged-session" },
  }]);
  assert.deepEqual(new Set(session.rotationState().sessionIds), new Set([
    "child-session", "parent-session", "grandparent-session",
  ]));

  assert.doesNotThrow(() => session.restore([
    null,
    { type: "custom", customType: ROTATION_STATE_ENTRY, data: "malformed" },
    { type: "custom", customType: ROTATION_STATE_ENTRY, data: { sessionIds: 42 } },
  ]));
  assert.deepEqual(new Set(session.rotationState().sessionIds), new Set([
    "child-session", "parent-session", "grandparent-session",
  ]));
});

test("toc marker indexes salient terms, stays byte-stable, and survives restore", () => {
  const archive = memoryArchive();
  const rotations = [];
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });
  const messages = [
    user("fix the `retryBudget` bug in src/auth/login.ts", 1),
    assistant("The loginHandler retry_count logic in config.maxRetries is wrong.", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  const first = session.process(messages);
  const markerText = first[0].content[0].text;
  for (const term of ["retryBudget", "src/auth/login.ts", "loginHandler", "retry_count", "config.maxRetries"]) {
    assert.ok(markerText.includes(term), `marker missing term: ${term}`);
  }
  assert.match(markerText, /"fix the `retryBudget` bug in src\/auth\/login.ts"/);

  // Byte-stable across requests between rotations: identical input state
  // must render an identical marker so the prompt prefix stays cacheable.
  const second = session.process([...messages]);
  assert.equal(second[0].content[0].text, markerText);

  // A fresh session restored from persisted rotation state rebuilds the
  // exact same marker without re-reading the archive.
  const restored = new EpochWindowSession({
    archive: memoryArchive(),
    config,
    sessionId: "session-1",
    project: "/project",
  });
  restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: rotations.at(-1) }]);
  const reprocessed = restored.process(messages);
  assert.equal(reprocessed[0].content[0].text, markerText);
  assert.deepEqual(reprocessed.slice(1), messages.slice(4));
});

test("restore sanitizes malformed toc entries and caps their count", () => {
  const session = new EpochWindowSession({
    archive: memoryArchive(),
    config,
    sessionId: "session-1",
    project: "/project",
  });
  const oversized = Array.from({ length: TOC_MAX_ENTRIES + 10 }, (_, index) => ({
    id: `doc-${index}`,
    topic: `topic ${index}`,
    terms: [`term${index}`],
  }));
  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: {
      sessionId: "session-1",
      toc: [
        null,
        "malformed",
        { topic: "missing id" },
        { id: "doc-ok", topic: 42, terms: ["kept", 7, "also-kept"] },
        ...oversized,
      ],
    },
  }]);
  assert.equal(session.toc.length, TOC_MAX_ENTRIES);
  assert.equal(session.toc.at(-1).id, `doc-${TOC_MAX_ENTRIES + 9}`);
  assert.ok(session.toc.every((entry) => typeof entry.id === "string"
    && typeof entry.topic === "string"
    && entry.terms.every((term) => typeof term === "string")));
});

test("session controller updates limits immediately when the model changes", () => {
  const session = new EpochWindowSession({
    archive: memoryArchive(),
    config: {
      ...config,
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.8,
      rotationTokensExplicit: false,
      hardLimitTokensExplicit: false,
      models: {
        "anthropic/claude-*": { rotationContextRatio: 0.7, rotationTurns: 24 },
        "openai/gpt-*": { rotationContextRatio: 0.55, rotationTurns: 16 },
      },
    },
    sessionId: "session-1",
    project: "/project",
    model: { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 },
  });

  assert.equal(session.status().rotationTokens, 140_000);
  assert.equal(session.status().rotationTurns, 24);
  assert.equal(session.status().modelPattern, "anthropic/claude-*");

  session.updateModel({ provider: "openai", id: "gpt-test", contextWindow: 100_000 });
  assert.equal(session.status().rotationTokens, 55_000);
  assert.equal(session.status().rotationTurns, 16);
  assert.equal(session.status().modelPattern, "openai/gpt-*");
});

test("adaptive rotation derives limits from each model's Pi input budget", () => {
  for (const { contextWindow, reserveTokens, expectedRotation } of [
    { contextWindow: 100_000, reserveTokens: 20_000, expectedRotation: 52_000 },
    { contextWindow: 372_000, reserveTokens: 128_000, expectedRotation: 158_600 },
    { contextWindow: 1_000_000, reserveTokens: 256_000, expectedRotation: 483_600 },
  ]) {
    const model = { provider: "provider", id: "model", contextWindow, maxTokens: 10_000 };
    const session = new EpochWindowSession({
      archive: memoryArchive(),
      config: {
        ...config,
        rotationContextRatio: 0.65,
        hardLimitContextRatio: 0.8,
        rotationTokensExplicit: false,
        hardLimitTokensExplicit: false,
        piCompactionReserveTokens: reserveTokens,
        models: {},
      },
      sessionId: `model-${contextWindow}`,
      project: "/project",
      model,
    });
    const status = session.status({ includeArchiveCount: false });
    assert.equal(status.inputWindowTokens, contextWindow - reserveTokens);
    assert.equal(status.piCompactionReserveTokens, reserveTokens);
    assert.equal(status.rotationTokens, expectedRotation);
  }

  const modelFallback = new EpochWindowSession({
    archive: memoryArchive(),
    config: {
      ...config,
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.8,
      rotationTokensExplicit: false,
      hardLimitTokensExplicit: false,
      piCompactionReserveTokens: undefined,
      models: {},
    },
    sessionId: "model-output-fallback",
    project: "/project",
    model: { provider: "provider", id: "model", contextWindow: 200_000, maxTokens: 40_000 },
  });
  assert.equal(modelFallback.status({ includeArchiveCount: false }).rotationTokens, 104_000);

  const explicitZero = new EpochWindowSession({
    archive: memoryArchive(),
    config: {
      ...config,
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.8,
      rotationTokensExplicit: false,
      hardLimitTokensExplicit: false,
      piCompactionReserveTokens: 0,
      models: {},
    },
    sessionId: "zero-reserve",
    project: "/project",
    model: { provider: "provider", id: "model", contextWindow: 100_000, maxTokens: 40_000 },
  });
  assert.equal(explicitZero.status({ includeArchiveCount: false }).inputWindowTokens, 100_000);
  assert.equal(explicitZero.status({ includeArchiveCount: false }).piCompactionReserveTokens, 0);
  assert.equal(explicitZero.status({ includeArchiveCount: false }).rotationTokens, 65_000);

  const exhausted = new EpochWindowSession({
    archive: memoryArchive(),
    config: {
      ...config,
      piCompactionReserveTokens: 100_000,
      models: {},
    },
    sessionId: "exhausted-input-budget",
    project: "/project",
    model: { provider: "provider", id: "model", contextWindow: 100_000 },
  });
  assert.equal(exhausted.status({ includeArchiveCount: false }).inputWindowTokens, 0);
  assert.throws(
    () => exhausted.process([user("cannot send", 1)], {
      provider: "provider",
      id: "model",
      contextWindow: 100_000,
    }),
    /no usable model input budget/u,
  );
});

test("rotation indexes deterministic structural scores for original messages", () => {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  const indexed = [];
  archive.put = (document, options) => {
    if (document.kind === "turn") indexed.push(options.structuralMessages);
    return put(document);
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "structural-session",
    project: "/project",
  });
  session.process([
    user("Can you check Datadog?", 1),
    assistant("Yes.", 2),
    { ...assistant("A later failed retry.", 2.5), stopReason: "error" },
    user("The whole point is no compaction.", 3), assistant("Understood.", 4),
    user("current", 5), assistant("current answer", 6),
  ], { contextWindow: 200_000 });

  assert.equal(indexed.length, 2);
  assert.equal(indexed[0][0].questionScore, 100);
  assert.equal(indexed[0][0].requestScore, 100);
  assert.equal(indexed[0][1].answerScore, 100);
  assert.equal(indexed[0][2].answerScore, 0);
  assert.equal(indexed[1][0].correctionScore, 100);
  assert.match(indexed[0][0].messageKey, /^user:1::/);
});

test("rotation archives verbatim decision candidates with turn provenance", () => {
  const archive = memoryArchive();
  archive.resolveSubject = () => {
    throw new Error("rotation must not infer supersession from an exact anchor");
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: () => {},
  });
  const decisionText = "We agreed to keep src/config.js for queue settings rather than callbacks.";
  const messages = [
    user("queue or callbacks?", 1), assistant(decisionText, 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages, { contextWindow: 200_000 });

  const documents = [...archive.documents.values()];
  const candidates = documents.filter((document) => document.kind === "decision-candidate");
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  // Verbatim: the archived sentence is an exact span of the serialized turn.
  assert.equal(candidate.text, `[assistant] ${decisionText}`);
  assert.equal(candidate.subjectKey, undefined);
  const turnDocument = documents.find((document) => document.kind === "turn"
    && document.metadata.sourceMessageKeys[0] === messageKey(messages[0]));
  assert.equal(candidate.metadata.sourceTurnId, turnDocument.id);
  assert.deepEqual(candidate.metadata.sourceMessageKeys, messages.slice(0, 2).map(messageKey));

  const provenance = archiveDocumentProvenance(candidate);
  assert.equal(provenance.sourceMessages.status, "available");
  assert.deepEqual(provenance.decisionCandidate, {
    verbatim: true,
    sourceTurnId: turnDocument.id,
  });
});

test("automatic preflight caches every frozen decision and survives later retrieval failure", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return {
      modelVisibleText: `\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]\nArchived excerpt as JSON data: ${JSON.stringify(request.messageKey)}`,
      hints: [],
    };
  };
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      hintBudgetTokens: 80,
      epochHintBudgetTokens: 320,
      rotationTurns: 20,
    },
    sessionId: "hint-session",
    initialSessionIds: ["parent-session"],
    project: "/project",
  });
  const first = user("What did we decide earlier?", 1);
  const firstVisible = session.process([first]);

  assert.equal(firstVisible.length, 1);
  assert.equal(firstVisible[0].role, "user");
  assert.equal(firstVisible[0].content[0].text, first.content[0].text);
  assert.match(firstVisible[0].content.at(-1).text, /ARCHIVED HISTORICAL EVIDENCE/u);
  assert.deepEqual(requests[0], {
    messageKey: messageKey(first),
    message: "What did we decide earlier?",
    scope: "session",
    sessionId: "hint-session",
    sessionIds: ["hint-session", "parent-session"],
    project: "/project",
    excludeVisibleSourceKeys: [messageKey(first)],
    hintBudgetTokens: 80,
    activeHintBudgetTokens: 320,
    activeMessageKeys: [messageKey(first)],
    hintSourceCooldownMs: 86_400_000,
    ephemeralAutoRetrievalDays: 7,
    conversationAutoRetrievalDays: 30,
    derivedAutoRetrievalDays: 30,
    includeDiagnostics: true,
    epochId: "hint-session:0",
    epochBudgetTokens: 320,
  });
  assert.equal(session.activeTokens, estimateTokens(firstVisible));

  const answer = assistant("We chose the indexed archive.", 2);
  const second = user("Why did we choose it?", 3);
  const secondVisible = session.process([first, answer, second]);
  assert.deepEqual(secondVisible[0], firstVisible[0]);
  assert.match(secondVisible[2].content.at(-1).text, /ARCHIVED HISTORICAL EVIDENCE/u);
  assert.deepEqual(requests.slice(1).map(({ messageKey: key }) => key), [
    messageKey(second),
  ]);
  assert.deepEqual(requests[1].excludeVisibleSourceKeys, [
    messageKey(first),
    messageKey(answer),
    messageKey(second),
  ]);
  assert.deepEqual(requests[1].activeMessageKeys, [
    messageKey(first),
    messageKey(second),
  ]);

  session.resetAfterCompaction();
  const afterCompactionReset = session.process([first, answer, second]);
  assert.deepEqual(afterCompactionReset, secondVisible);
  assert.equal(requests.length, 2);

  archive.preflight = () => { throw new Error("daemon unavailable"); };
  const secondAnswer = assistant("Because it preserves exact evidence.", 4);
  const third = user("What is the live status?", 5);
  const reconstructed = session.process([first, answer, second, secondAnswer, third]);
  assert.deepEqual(reconstructed.slice(0, 3), secondVisible);
  assert.deepEqual(reconstructed.slice(3), [secondAnswer, third]);
  assert.equal(requests.length, 2);
  assert.equal(session.status().preflightError, "daemon unavailable");
});

test("automatic retrieval diagnostics preserve the last sanitized preflight decision", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({
    modelVisibleText: "",
    hints: [],
    diagnostics: {
      outcome: "suppress",
      reason: "weak-evidence",
      indexGeneration: 7,
      searchMode: "lexical",
      searchStatus: "resolved",
      candidate: {
        documentId: "decision-7",
        kind: "decision-candidate",
        retrievalMode: "lexical",
        matchedTerms: ["canari", "deploi"],
        termCoverage: 0.4,
        maxNormalizedIdf: 1,
        margin: 0.5,
      },
    },
  });
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "diagnostic-session",
    project: "/project",
  });
  const prompt = user("What color is used for canary deploys?", 1);
  session.process([prompt]);

  assert.deepEqual(session.automaticRetrievalDiagnostics(), {
    outcome: "suppress",
    reason: "weak-evidence",
    indexGeneration: 7,
    searchMode: "lexical",
    searchStatus: "resolved",
    candidate: {
      documentId: "decision-7",
      kind: "decision-candidate",
      retrievalMode: "lexical",
      matchedTerms: ["canari", "deploi"],
      termCoverage: 0.4,
      maxNormalizedIdf: 1,
      margin: 0.5,
    },
    messageKey: messageKey(prompt),
  });
});

test("rotation sends retained user keys under one unchanged active hint budget", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return { modelVisibleText: "", hints: [] };
  };
  archive.removeHints = () => ({ removed: 1, notFound: 0 });
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      rotationTurns: 3,
      retainTurns: 2,
      activeHintBudgetTokens: 222,
      hintSourceCooldownHours: 12,
      ephemeralAutoRetrievalDays: 4,
      conversationAutoRetrievalDays: 18,
      derivedAutoRetrievalDays: 9,
    },
    sessionId: "hint-rotation-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];
  session.process(messages.slice(0, 2));
  session.process(messages.slice(0, 4));
  session.process(messages);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].activeMessageKeys, [
    messageKey(messages[2]),
    messageKey(messages[4]),
  ]);
  assert.equal(requests[2].activeHintBudgetTokens, 222);
  assert.equal(requests[2].epochBudgetTokens, 222);
  assert.equal(requests[2].epochId, "hint-rotation-session:1");
  assert.equal(requests[2].hintSourceCooldownMs, 12 * 60 * 60 * 1_000);
  assert.equal(requests[2].ephemeralAutoRetrievalDays, 4);
  assert.equal(requests[2].conversationAutoRetrievalDays, 18);
  assert.equal(requests[2].derivedAutoRetrievalDays, 9);
  assert.ok(requests[2].excludeVisibleSourceKeys.includes(messageKey(messages[3])));
});

test("automatic preflight excludes original source keys after provider-only externalization", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return { modelVisibleText: "", hints: [] };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true, maxToolResultTokens: 10 },
    sessionId: "hint-visible-source-session",
    project: "/project",
  });
  const prompt = user("inspect the tool result", 1);
  const tool = {
    role: "toolResult",
    content: [{ type: "text", text: "x".repeat(10_000) }],
    timestamp: 2,
    toolCallId: "visible-tool",
    toolName: "read",
  };
  const processed = session.process([prompt, tool]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(prompt)));
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(tool)));
  assert.notEqual(messageKey(processed[1]), messageKey(tool));
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(processed[1])));
});

test("frozen hint records retire only after post-compaction context reconciliation", () => {
  const archive = memoryArchive();
  const preflighted = [];
  const removals = [];
  archive.preflight = (request) => {
    preflighted.push(request.messageKey);
    return { modelVisibleText: "", hints: [] };
  };
  archive.removeHints = (messageKeys, options) => {
    removals.push({ messageKeys: [...messageKeys], options });
    return { removed: messageKeys.length, notFound: 0 };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "hint-lifecycle-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages.slice(0, 2), { contextWindow: 200_000 });
  session.process(messages.slice(0, 4), { contextWindow: 200_000 });
  session.process(messages, { contextWindow: 200_000 });

  assert.deepEqual(preflighted, [
    messageKey(messages[0]),
    messageKey(messages[2]),
    messageKey(messages[4]),
  ]);
  assert.deepEqual(removals, [{
    messageKeys: [messageKey(messages[0]), messageKey(messages[2])],
    options: { sessionId: "hint-lifecycle-session" },
  }]);

  session.process(messages, { contextWindow: 200_000 });
  assert.equal(removals.length, 1);
  session.resetAfterCompaction();
  assert.equal(removals.length, 1);
  session.process([]);
  assert.deepEqual(removals[1], {
    messageKeys: [messageKey(messages[4])],
    options: { sessionId: "hint-lifecycle-session" },
  });
});

test("failed frozen hint retirement is retried without failing the live prompt", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({ modelVisibleText: "", hints: [] });
  let attempts = 0;
  archive.removeHints = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary cleanup failure");
    return { removed: 2, notFound: 0 };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "hint-cleanup-retry-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];
  session.process(messages.slice(0, 2), { contextWindow: 200_000 });
  session.process(messages.slice(0, 4), { contextWindow: 200_000 });

  const visible = session.process(messages, { contextWindow: 200_000 });
  assert.ok(visible.some((message) => message.role === "user"
    && message.content[0].text === "three"));
  assert.equal(session.status().hintCleanupError, "temporary cleanup failure");

  session.process(messages, { contextWindow: 200_000 });
  assert.equal(attempts, 2);
  assert.equal(Object.hasOwn(session.status(), "hintCleanupError"), false);
});

test("suppressed or failed automatic retrieval adds zero model-visible content", () => {
  const message = user("current status", 1);
  for (let behavior of [
    () => ({ modelVisibleText: "", hints: [] }),
    () => { throw new Error("daemon unavailable"); },
  ]) {
    const archive = memoryArchive();
    let calls = 0;
    archive.preflight = (...args) => {
      calls += 1;
      return behavior(...args);
    };
    const session = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: "no-hint-session",
      project: "/project",
    });
    const visible = session.process([message]);
    assert.deepEqual(visible, [message]);
    assert.equal(session.activeTokens, estimateTokens([message]));

    behavior = () => ({
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    });
    assert.deepEqual(session.process([message]), visible);
    assert.equal(calls, 1);
  }
});

test("failed preflight stays reconstruct-only across rotation, reload, fork, and compaction reset", () => {
  const archive = memoryArchive();
  const requests = [];
  let recovered = false;
  archive.preflight = (request) => {
    requests.push(request);
    if (!recovered) throw new Error("daemon unavailable");
    if (request.reconstruct) throw new Error("no frozen decision");
    return {
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    };
  };
  archive.removeHints = () => ({ removed: 1, notFound: 0 });
  const persisted = [];
  const parent = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      rotationTurns: 2,
      retainTurns: 1,
    },
    sessionId: "failed-parent-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });
  const first = user("What did we decide about archive compaction?", 1);
  const firstAnswer = assistant("I will check.", 2);
  const second = user("How does that decision apply here?", 3);

  assert.deepEqual(parent.process([first]), [first]);
  assert.deepEqual(persisted.at(-1).hintState, {
    version: 1,
    reconstructOnlyMessageKeys: [messageKey(first)],
  });

  const source = [first, firstAnswer, second];
  const rotated = parent.process(source, { contextWindow: 200_000 });
  const durableState = persisted.at(-1);
  assert.equal(durableState.boundaryKey, messageKey(second));
  assert.deepEqual(durableState.hintState.reconstructOnlyMessageKeys, [messageKey(second)]);
  assert.deepEqual(rotated.slice(1), [second]);

  recovered = true;
  const restoreAndProcess = (sessionId, initialSessionIds, state, messages) => {
    const restored = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId,
      initialSessionIds,
      project: "/project",
    });
    restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: state }]);
    return restored.process(messages, { contextWindow: 200_000 });
  };

  assert.deepEqual(
    restoreAndProcess("failed-parent-session", [], durableState, source),
    rotated,
  );
  assert.deepEqual(
    restoreAndProcess("failed-child-session", ["failed-parent-session"], durableState, source),
    rotated,
  );

  const compactedState = parent.resetAfterCompaction();
  assert.deepEqual(
    restoreAndProcess("failed-parent-session", [], compactedState, [second]),
    [second],
  );
  assert.ok(requests.slice(-3).every((request) => request.reconstruct === true));
});

test("successful empty-context hint cleanup durably retires reconstruct-only keys", () => {
  for (const hasRemoveHints of [true, false]) {
    const archive = memoryArchive();
    const requests = [];
    archive.preflight = (request) => {
      requests.push(request);
      return { modelVisibleText: "", hints: [] };
    };
    if (hasRemoveHints) {
      archive.removeHints = () => ({ removed: 1, notFound: 0 });
    }
    const persisted = [];
    const message = user(`retire ${hasRemoveHints ? "daemon" : "local"} hint`, 1);
    const session = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: `cleanup-${hasRemoveHints ? "daemon" : "local"}-session`,
      project: "/project",
      onRotation: (state) => persisted.push(structuredClone(state)),
    });

    session.process([message]);
    session.process([]);
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);
    assert.deepEqual(persisted[1].hintState.reconstructOnlyMessageKeys, []);

    const restored = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: `cleanup-${hasRemoveHints ? "daemon" : "local"}-session`,
      project: "/project",
    });
    restored.restore(persisted.map((data) => ({
      type: "custom",
      customType: ROTATION_STATE_ENTRY,
      data,
    })));
    restored.process([message]);
    assert.equal(requests.at(-1).reconstruct, undefined);
  }
});

test("failed hint cleanup does not persist a removal", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({ modelVisibleText: "", hints: [] });
  let cleanupAttempts = 0;
  archive.removeHints = () => {
    cleanupAttempts += 1;
    throw new Error("cleanup unavailable");
  };
  const persisted = [];
  const message = user("retain failed cleanup state", 1);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "failed-cleanup-state-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });

  session.process([message]);
  session.process([]);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);

  const retryPersisted = [];
  const restored = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "failed-cleanup-state-session",
    project: "/project",
    onRotation: (state) => retryPersisted.push(structuredClone(state)),
  });
  restored.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  restored.process([]);
  assert.equal(cleanupAttempts, 2);
  assert.equal(retryPersisted.length, 0);
  assert.deepEqual(
    restored.rotationState().hintState.reconstructOnlyMessageKeys,
    [messageKey(message)],
  );

  archive.removeHints = () => {
    cleanupAttempts += 1;
    return { removed: 1, notFound: 0 };
  };
  restored.process([]);
  assert.equal(cleanupAttempts, 3);
  assert.equal(retryPersisted.length, 1);
  assert.deepEqual(retryPersisted[0].hintState.reconstructOnlyMessageKeys, []);
});

test("missing preflight capability freezes an empty decision before capability recovery", () => {
  const archive = memoryArchive();
  const persisted = [];
  const message = user("continue the archive design", 1);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });

  assert.deepEqual(session.process([message]), [message]);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);

  const removals = [];
  archive.removeHints = (messageKeys) => {
    removals.push([...messageKeys]);
    return { removed: 0, notFound: messageKeys.length };
  };
  const cleanupPersisted = [];
  const inactiveReload = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
    onRotation: (state) => cleanupPersisted.push(structuredClone(state)),
  });
  inactiveReload.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  inactiveReload.process([]);
  assert.deepEqual(removals, [[messageKey(message)]]);
  assert.equal(cleanupPersisted.length, 1);
  assert.deepEqual(cleanupPersisted[0].hintState.reconstructOnlyMessageKeys, []);

  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    if (request.reconstruct) throw new Error("no frozen decision");
    return {
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    };
  };
  assert.deepEqual(session.process([message]), [message]);
  assert.equal(requests.length, 0);
  assert.equal(persisted.length, 1);

  const restored = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
  });
  restored.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  assert.deepEqual(restored.process([message]), [message]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reconstruct, true);
});

test("oversized multimodal user input is archived before accounting and only the provider copy changes", () => {
  const archive = trackingMemoryArchive();
  let preflightCalls = 0;
  archive.preflight = () => {
    preflightCalls += 1;
    return { modelVisibleText: "unexpected", hints: [] };
  };
  const sentinel = "MIDDLE_INPUT_SENTINEL_MUST_STAY_OUT_OF_CONTEXT";
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const original = {
    role: "user",
    content: [
      { type: "text", text: `${"alpha ".repeat(4_000)}${sentinel}${" omega".repeat(4_000)}` },
      image,
      { type: "text", text: "postlude ".repeat(4_000) },
    ],
    timestamp: 101,
  };
  const inputSnapshot = structuredClone(original);
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      maxInlineUserTokens: 1_700,
      rotationTurns: 20,
    },
    sessionId: "oversized-admission-session",
    project: "/project",
  });

  const first = session.process([original], { contextWindow: 200_000 });
  assert.deepEqual(original, inputSnapshot);
  assert.notStrictEqual(first[0], original);
  assert.strictEqual(first[0].content[1], image);
  assert.deepEqual(
    first[0].content.filter((part) => part.type !== "text"),
    [image],
  );
  assert.equal(serializeMessage(first[0]).includes(sentinel), false);
  assert.ok(Math.max(
    estimateTokens([first[0]]),
    estimateModelVisibleTokens(serializeMessage(first[0])),
  ) <= 1_700);
  assert.equal(preflightCalls, 0);

  const rootDocument = [...archive.documents.values()]
    .find((document) => document.kind === "archive-checkpoint-root");
  assert.ok(rootDocument);
  const root = JSON.parse(rootDocument.text);
  assert.equal(root.sourceKey, messageKey(original));
  assert.equal(root.sourceKind, "oversized-user");
  assert.equal(
    reconstructCheckpointSource(archive, rootDocument.id).text,
    serializeMessage(original),
  );
  const recalled = session.recall(rootDocument.id);
  assert.equal(recalled.kind, "oversized-user");
  assert.equal(recalled.text, serializeMessage(original));
  assert.equal(recalled.modelVisibleFramed, undefined);

  const expectedProtectedIds = new Set([
    root.publicationId,
    root.rootId,
    ...root.parts.map((part) => part.id),
  ]);
  assert.deepEqual(
    new Set(archive.protectionRequests.at(-1).documentIds),
    expectedProtectedIds,
  );

  const writesAfterFirstProcess = archive.putCalls;
  const documentIdsAfterFirstProcess = [...archive.documents.keys()];
  const second = session.process([original], { contextWindow: 200_000 });
  assert.deepEqual(second, first);
  assert.equal(archive.putCalls, writesAfterFirstProcess);
  assert.deepEqual([...archive.documents.keys()], documentIdsAfterFirstProcess);
  assert.equal(preflightCalls, 0);
  assert.deepEqual(original, inputSnapshot);
});

test("oversized user checkpoint failure aborts without exposing or mutating the source", () => {
  const archive = trackingMemoryArchive();
  archive.put = () => {
    archive.putCalls += 1;
    return undefined;
  };
  const source = user(`head ${"private ".repeat(5_000)} tail`, 1);
  const snapshot = structuredClone(source);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 200, rotationTurns: 20 },
    sessionId: "oversized-failure-session",
    project: "/project",
  });

  assert.throws(
    () => session.process([source]),
    (error) => error instanceof OversizedInputArchiveError
      && error.code === "OVERSIZED_INPUT_ARCHIVE_FAILED"
      && !error.message.includes("private"),
  );
  assert.deepEqual(source, snapshot);
  assert.equal(archive.documents.size, 0);
  assert.equal(session.rotationState().boundaryKey, undefined);
  assert.deepEqual(session.rotationState().toc, []);
});

test("oversized admission planning reuses a complete legacy checkpoint", () => {
  const archive = trackingMemoryArchive();
  const source = user(`legacy oversized ${"payload ".repeat(5_000)}`, 1);
  const sessionId = "legacy-oversized-session";
  const project = "/project";
  const legacy = seedLegacyCheckpoint(archive, {
    text: serializeMessage(source),
    project,
    sessionId,
    sourceKey: messageKey(source),
    kind: "oversized-user",
  });
  const documentCount = archive.documents.size;
  const session = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 300, rotationTurns: 20 },
    sessionId,
    project,
  });

  const providerMessages = session.process([source], { contextWindow: 200_000 });

  assert.equal(providerMessages.length, 1);
  assert.equal(serializeMessage(providerMessages[0]).includes(legacy.rootId), true);
  assert.equal(reconstructCheckpointSource(archive, legacy.rootId).text, serializeMessage(source));
  assert.equal(archive.putCalls, 0);
  assert.equal(archive.documents.size, documentCount);
});

test("an oversized rotated turn uses an exact checkpoint and a bounded TOC entry", () => {
  const archive = trackingMemoryArchive();
  const sentinel = "ROTATED_MIDDLE_SENTINEL_MUST_NOT_REENTER_CONTEXT";
  const oversized = user(
    `${"old-head ".repeat(3_000)}${sentinel}${" old-tail".repeat(3_000)}`,
    1,
  );
  const messages = [
    oversized, assistant("first answer", 2),
    user("second turn", 3), assistant("second answer", 4),
    user("retained turn", 5), assistant("retained answer", 6),
  ];
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      maxInlineUserTokens: 300,
      rotationTurns: 3,
      retainTurns: 1,
    },
    sessionId: "oversized-rotation-session",
    project: "/project",
  });

  const result = session.process(messages, { contextWindow: 200_000 });
  assert.equal(serializeMessages(result).includes(sentinel), false);
  const state = session.rotationState();
  assert.equal(state.toc.length, 2);
  assert.ok(Array.isArray(state.toc[0].archiveIds));
  assert.ok(state.toc[0].archiveIds.length >= 3);
  assert.equal(result[0].content[0].text.includes(sentinel), false);
  assert.equal(
    reconstructCheckpointSource(archive, state.toc[0].id).text,
    serializeMessages(messages.slice(0, 2)),
  );
  assert.equal(
    session.recall(state.toc[0].id).text,
    serializeMessages(messages.slice(0, 2)),
  );
  assert.deepEqual(
    session.recall(state.toc[0].id).sourceMessageKeys,
    messages.slice(0, 2).map((message) => messageKey(message)),
  );
  const recalledSourceKeys = messages.slice(0, 2).map((message) => messageKey(message));
  assert.deepEqual(
    archiveDocumentProvenance(session.recall(state.toc[0].id)).sourceMessages,
    {
      status: "available",
      keys: recalledSourceKeys,
      firstKey: recalledSourceKeys[0],
      lastKey: recalledSourceKeys.at(-1),
      count: recalledSourceKeys.length,
    },
  );
  const protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of state.toc[0].archiveIds) assert.ok(protectedIds.has(id));

  const writesAfterRotation = archive.putCalls;
  assert.deepEqual(session.process(messages, { contextWindow: 200_000 }), result);
  assert.equal(archive.putCalls, writesAfterRotation);

  const restored = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 300 },
    sessionId: "oversized-rotation-session",
    project: "/project",
  });
  restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: state }]);
  const restoredProtectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of state.toc[0].archiveIds) assert.ok(restoredProtectedIds.has(id));
  assert.deepEqual(
    restored.recall(state.toc[0].id).sourceMessageKeys,
    messages.slice(0, 2).map((message) => messageKey(message)),
  );

  const truncatedState = structuredClone(state);
  truncatedState.toc[0].archiveIds = [state.toc[0].id];
  const rejectsTruncatedProtection = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 300 },
    sessionId: "oversized-rotation-session",
    project: "/project",
  });
  rejectsTruncatedProtection.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: truncatedState,
  }]);
  assert.equal(
    rejectsTruncatedProtection.rotationState().toc.some(({ id }) => id === state.toc[0].id),
    false,
  );

  const omittedState = structuredClone(state);
  delete omittedState.toc[0].archiveIds;
  const rejectsOmittedProtection = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 300 },
    sessionId: "oversized-rotation-session",
    project: "/project",
  });
  rejectsOmittedProtection.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: omittedState,
  }]);
  assert.equal(
    rejectsOmittedProtection.rotationState().toc.some(({ id }) => id === state.toc[0].id),
    false,
  );

  const malformedState = structuredClone(state);
  malformedState.toc[0].archiveIds = [
    state.toc[0].id,
    `checkpoint-publication:${"f".repeat(64)}`,
    ...Array.from({ length: 1_001 }, (_, index) =>
      `checkpoint-part:${createHash("sha256").update(`toc-part-${index}`).digest("hex")}`),
  ];
  const rejectsPartialProtection = new EpochWindowSession({
    archive,
    config: { ...config, maxInlineUserTokens: 300 },
    sessionId: "oversized-rotation-session",
    project: "/project",
  });
  rejectsPartialProtection.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: malformedState,
  }]);
  assert.equal(
    rejectsPartialProtection.rotationState().toc.some(({ id }) => id === state.toc[0].id),
    false,
  );
  assert.equal(
    new Set(archive.protectionRequests.at(-1).documentIds).has(state.toc[0].archiveIds.at(-1)),
    false,
  );
});

test("restore accepts a complete deduplicated checkpoint protection set", () => {
  const archive = trackingMemoryArchive();
  const [entry] = seedVerifiedCheckpointEntries(
    archive,
    [4],
    { sessionId: "deduplicated-protection-session" },
  );
  const archiveIds = [...new Set([
    entry.publicationId,
    entry.rootId,
    ...entry.partIds,
  ])];
  assert.ok(archiveIds.length < entry.partCount + 2);
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "deduplicated-protection-session",
    project: "/project",
  });

  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: {
      toc: [{ id: entry.rootId, topic: "", terms: [], archiveIds }],
    },
  }]);

  assert.equal(session.rotationState().toc.length, 1);
  const protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of archiveIds) assert.ok(protectedIds.has(id));
});

test("restore rejects a checkpoint over the raw part-occurrence limit", () => {
  const archive = trackingMemoryArchive();
  const [entry] = seedVerifiedCheckpointEntries(
    archive,
    [1_001],
    { sessionId: "raw-part-limit-session" },
  );
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "raw-part-limit-session",
    project: "/project",
  });

  session.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: {
      toc: [{
        id: entry.rootId,
        topic: "",
        terms: [],
        archiveIds: [...new Set([
          entry.publicationId,
          entry.rootId,
          ...entry.partIds,
        ])],
      }],
    },
  }]);

  assert.equal(session.rotationState().toc.length, 0);
});

test("split-turn compaction checkpoints exact sources and preserves protection across reset and restore", () => {
  const archive = trackingMemoryArchive();
  const sentinel = "COMPACTION_MIDDLE_SENTINEL_MUST_NOT_ENTER_CATALOG";
  const preparation = {
    firstKeptEntryId: "kept-entry-7",
    messagesToSummarize: [
      user(`${"history-head ".repeat(3_000)}${sentinel}${" history-tail".repeat(3_000)}`, 10),
      assistant("history answer", 11),
    ],
    turnPrefixMessages: [
      user("split turn request", 12),
      assistant("split turn prefix answer", 13),
    ],
    isSplitTurn: true,
    tokensBefore: 123_456,
    previousSummary: undefined,
    fileOps: { read: [], written: [] },
    settings: { keepRecentTokens: 20_000 },
  };
  const preparationSnapshot = structuredClone(preparation);
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "compaction-checkpoint-session",
    project: "/project",
  });

  const result = session.checkpointCompaction(preparation, { branchEntries: [] });
  assert.ok(result);
  assert.deepEqual(preparation, preparationSnapshot);
  assert.deepEqual(Object.keys(result).sort(), [
    "details", "firstKeptEntryId", "summary", "tokensBefore",
  ]);
  assert.equal(result.firstKeptEntryId, preparation.firstKeptEntryId);
  assert.equal(result.tokensBefore, preparation.tokensBefore);
  assert.equal(result.summary.includes(sentinel), false);
  assert.ok(estimateModelVisibleTokens(result.summary) <= 1_000);
  assert.equal(
    result.details.contextWindowArchive.version,
    CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
  );
  assert.deepEqual(
    result.details.contextWindowArchive.entries.map((entry) => entry.kind),
    ["compaction-span", "compaction-turn-prefix"],
  );

  const [span, prefix] = result.details.contextWindowArchive.entries;
  assert.equal(
    reconstructCheckpointSource(archive, span.rootId).text,
    serializeMessages(preparation.messagesToSummarize),
  );
  assert.equal(
    reconstructCheckpointSource(archive, prefix.rootId).text,
    serializeMessages(preparation.turnPrefixMessages),
  );
  assert.equal(
    session.recall(span.rootId).text,
    serializeMessages(preparation.messagesToSummarize),
  );

  const allIds = archiveEntryIds(result.details.contextWindowArchive.entries);
  let protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of allIds) assert.ok(protectedIds.has(id));

  const writesAfterFirstCheckpoint = archive.putCalls;
  assert.deepEqual(
    session.checkpointCompaction(preparation, { branchEntries: [] }),
    result,
  );
  assert.equal(archive.putCalls, writesAfterFirstCheckpoint);

  session.resetAfterCompaction();
  protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of allIds) assert.ok(protectedIds.has(id));

  const compactionEntry = {
    type: "compaction",
    fromHook: true,
    summary: result.summary,
    details: result.details,
  };
  const restored = new EpochWindowSession({
    archive,
    config,
    sessionId: "compaction-checkpoint-session",
    project: "/project",
  });
  restored.restore([compactionEntry]);
  protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of allIds) assert.ok(protectedIds.has(id));
  restored.resetAfterCompaction();
  protectedIds = new Set(archive.protectionRequests.at(-1).documentIds);
  for (const id of allIds) assert.ok(protectedIds.has(id));

  const forgedPartId = `checkpoint-part:${"e".repeat(64)}`;
  const forgedEntry = structuredClone(compactionEntry);
  forgedEntry.details.contextWindowArchive.entries[0].partIds[0] = forgedPartId;
  const rejectsForgedProtection = new EpochWindowSession({
    archive,
    config,
    sessionId: "compaction-checkpoint-session",
    project: "/project",
  });
  rejectsForgedProtection.restore([forgedEntry]);
  assert.deepEqual(rejectsForgedProtection.compactionArchiveEntries, []);
  assert.equal(
    new Set(archive.protectionRequests.at(-1).documentIds).has(forgedPartId),
    false,
  );
});

test("large compaction spans split into bounded exact-provenance checkpoint sources", () => {
  const archive = trackingMemoryArchive();
  const messages = Array.from({ length: 650 }, (_, index) =>
    user(`large checkpoint message ${index}`, index + 1),
  );
  const preparation = {
    firstKeptEntryId: "kept-after-large-span",
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 300_000,
    fileOps: {},
    settings: { keepRecentTokens: 20_000 },
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "large-compaction-checkpoint-session",
    project: "/project",
  });

  const result = session.checkpointCompaction(preparation, { branchEntries: [] });
  assert.ok(result);
  const entries = result.details.contextWindowArchive.entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.kind), [
    "compaction-span",
    "compaction-span",
    "compaction-span",
  ]);
  const reconstructed = entries.map((entry) =>
    reconstructCheckpointSource(archive, entry.rootId),
  );
  assert.deepEqual(
    reconstructed.map((source) => source.root.sourceMessageKeys.length),
    [256, 256, 138],
  );
  assert.deepEqual(
    reconstructed.flatMap((source) => source.root.sourceMessageKeys),
    messages.map(messageKey),
  );
  assert.deepEqual(
    reconstructed.map((source) => source.text),
    [
      serializeMessages(messages.slice(0, 256)),
      serializeMessages(messages.slice(256, 512)),
      serializeMessages(messages.slice(512)),
    ],
  );

  const writesAfterFirstCheckpoint = archive.putCalls;
  assert.deepEqual(
    session.checkpointCompaction(preparation, { branchEntries: [] }),
    result,
  );
  assert.equal(archive.putCalls, writesAfterFirstCheckpoint);
});

test("compaction carries only the strictly trusted latest extension catalog", () => {
  const archive = trackingMemoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "compaction-chain-session",
    project: "/project",
  });
  const firstPreparation = {
    firstKeptEntryId: "kept-first",
    messagesToSummarize: [user("first exact compaction source", 1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: {},
    settings: {},
  };
  const first = session.checkpointCompaction(firstPreparation, { branchEntries: [] });
  assert.ok(first);
  const firstEntry = {
    type: "compaction",
    fromHook: true,
    summary: first.summary,
    details: first.details,
  };
  const secondPreparation = {
    ...firstPreparation,
    firstKeptEntryId: "kept-second",
    messagesToSummarize: [user("second exact compaction source", 2)],
    tokensBefore: 200,
    previousSummary: first.summary,
  };

  const second = session.checkpointCompaction(secondPreparation, {
    branchEntries: [firstEntry],
  });
  assert.ok(second);
  assert.equal(
    second.details.contextWindowArchive.entries.some((entry) =>
      entry.kind === "archive-previous-summary"),
    false,
  );
  const secondRootIds = new Set(
    second.details.contextWindowArchive.entries.map((entry) => entry.rootId),
  );
  for (const entry of first.details.contextWindowArchive.entries) {
    assert.ok(secondRootIds.has(entry.rootId));
  }

  const fakeRootId = `checkpoint-root:${"f".repeat(64)}`;
  const malformedDetails = [
    {
      name: "outer details key",
      details: { ...structuredClone(first.details), unexpected: true },
    },
    {
      name: "namespace key",
      details: {
        contextWindowArchive: {
          ...structuredClone(first.details.contextWindowArchive),
          unexpected: true,
        },
      },
    },
    ...["rootId", "publicationId", "partIds"].map((field) => {
      const details = structuredClone(first.details);
      if (field === "rootId") {
        details.contextWindowArchive.entries[0].rootId =
          `checkpoint-root:${"a".repeat(65)}`;
      } else if (field === "publicationId") {
        details.contextWindowArchive.entries[0].publicationId =
          `checkpoint-publication:${"b".repeat(65)}`;
      } else {
        details.contextWindowArchive.entries[0].partIds[0] =
          `checkpoint-part:${"c".repeat(65)}`;
      }
      return { name: `oversized ${field}`, details };
    }),
  ];

  const aggregateEntries = Array.from({ length: 5 }, (_, rootIndex) => {
    const partCount = rootIndex < 4 ? 1_000 : 97;
    return {
      rootId: `checkpoint-root:${createHash("sha256").update(`aggregate-root-${rootIndex}`).digest("hex")}`,
      publicationId: `checkpoint-publication:${"d".repeat(64)}`,
      kind: "compaction-span",
      topic: "",
      terms: [],
      byteCount: 1,
      hash: "e".repeat(64),
      partCount,
      partIds: Array.from({ length: partCount }, (_, partIndex) =>
        `checkpoint-part:${createHash("sha256")
          .update(`aggregate-part-${rootIndex}-${partIndex}`)
          .digest("hex")}`),
    };
  });
  malformedDetails.push({
    name: "aggregate part IDs",
    details: {
      contextWindowArchive: {
        version: CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
        entries: aggregateEntries,
      },
    },
  });

  for (const candidate of malformedDetails) {
    const candidateArchive = trackingMemoryArchive();
    const candidateSession = new EpochWindowSession({
      archive: candidateArchive,
      config,
      sessionId: `reject-${candidate.name.replaceAll(" ", "-")}`,
      project: "/project",
    });
    const uncovered = candidateSession.checkpointCompaction(secondPreparation, {
      // The malformed latest entry must block fallback to this older valid one.
      branchEntries: [
        firstEntry,
        {
          type: "compaction",
          fromHook: true,
          summary: first.summary,
          details: candidate.details,
        },
      ],
    });
    assert.ok(uncovered, candidate.name);
    const previousSummaryRoot = uncovered.details.contextWindowArchive.entries
      .find((entry) => entry.kind === "archive-previous-summary");
    assert.ok(previousSummaryRoot, candidate.name);
    assert.equal(
      reconstructCheckpointSource(candidateArchive, previousSummaryRoot.rootId).text,
      first.summary,
      candidate.name,
    );
    const protectedIds = new Set(candidateArchive.protectionRequests.at(-1).documentIds);
    assert.equal(protectedIds.has(fakeRootId), false, candidate.name);
    assert.ok(protectedIds.size < 20, candidate.name);
  }
});

test("compaction archives the prior summary when a catalog source is no longer reconstructable", () => {
  const archive = trackingMemoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "missing-prior-part-session",
    project: "/project",
  });
  const first = session.checkpointCompaction({
    firstKeptEntryId: "kept-first",
    messagesToSummarize: [user("first exact compaction source", 1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: {},
    settings: {},
  }, { branchEntries: [] });
  assert.ok(first);
  const broken = first.details.contextWindowArchive.entries[0];
  archive.documents.delete(broken.partIds[0]);

  const second = session.checkpointCompaction({
    firstKeptEntryId: "kept-second",
    messagesToSummarize: [user("second exact compaction source", 2)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 200,
    previousSummary: first.summary,
    fileOps: {},
    settings: {},
  }, {
    branchEntries: [{
      type: "compaction",
      fromHook: true,
      summary: first.summary,
      details: first.details,
    }],
  });

  assert.ok(second);
  assert.equal(
    second.details.contextWindowArchive.entries.some(({ rootId }) => rootId === broken.rootId),
    false,
  );
  const summaryRoot = second.details.contextWindowArchive.entries
    .find(({ kind }) => kind === "archive-previous-summary");
  assert.ok(summaryRoot);
  assert.equal(
    reconstructCheckpointSource(archive, summaryRoot.rootId).text,
    first.summary,
  );
});

test("combined catalog overflow fails before any real checkpoint write", () => {
  const archive = trackingMemoryArchive();
  let priorCount = 0;
  for (let index = 0; index < 100; index += 1) {
    const digest = createHash("sha256").update(`bounded-root-${index}`).digest("hex");
    const next = Array.from({ length: index + 1 }, (_, rootIndex) => ({
      rootId: `checkpoint-root:${createHash("sha256")
        .update(`bounded-root-${rootIndex}`)
        .digest("hex")}`,
      publicationId: `checkpoint-publication:${"a".repeat(64)}`,
      kind: "compaction-span",
      topic: "",
      terms: [],
      byteCount: 0,
      hash: digest,
      partCount: 1,
      partIds: [`checkpoint-part:${digest}`],
    }));
    try {
      createCompactionCatalog(next, { maxTokens: 1_000 });
      priorCount = next.length;
    } catch {
      break;
    }
  }
  assert.ok(priorCount > 0);
  const priorEntries = seedVerifiedCheckpointEntries(
    archive,
    Array.from({ length: priorCount }, () => 1),
    { sessionId: "combined-catalog-overflow-session" },
  );
  const priorSummary = createCompactionCatalog(priorEntries, { maxTokens: 1_000 });
  const documentsBefore = archive.documents.size;
  archive.putCalls = 0;

  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "combined-catalog-overflow-session",
    project: "/project",
  });
  const result = session.checkpointCompaction({
    firstKeptEntryId: "kept-overflow",
    messagesToSummarize: [user("one more exact source", 1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    previousSummary: priorSummary,
    fileOps: {},
    settings: {},
  }, {
    branchEntries: [{
      type: "compaction",
      fromHook: true,
      summary: priorSummary,
      details: {
        contextWindowArchive: {
          version: CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
          entries: priorEntries,
        },
      },
    }],
  });

  assert.equal(result, undefined);
  assert.equal(archive.putCalls, 0);
  assert.equal(archive.documents.size, documentsBefore);
});

test("combined compaction part IDs are bounded before any real checkpoint write", () => {
  const archive = trackingMemoryArchive();
  const priorEntries = seedVerifiedCheckpointEntries(
    archive,
    [1_000, 1_000, 1_000, 1_000, 96],
    { sessionId: "combined-part-bound-session" },
  );
  const priorSummary = createCompactionCatalog(priorEntries, { maxTokens: 1_000 });
  const documentsBefore = archive.documents.size;
  archive.putCalls = 0;
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "combined-part-bound-session",
    project: "/project",
  });

  const result = session.checkpointCompaction({
    firstKeptEntryId: "kept-part-bound",
    messagesToSummarize: [user("one exact new source adds one part", 1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    previousSummary: priorSummary,
    fileOps: {},
    settings: {},
  }, {
    branchEntries: [{
      type: "compaction",
      fromHook: true,
      summary: priorSummary,
      details: {
        contextWindowArchive: {
          version: CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
          entries: priorEntries,
        },
      },
    }],
  });

  assert.equal(result, undefined);
  assert.equal(archive.putCalls, 0);
  assert.equal(archive.documents.size, documentsBefore);
});

test("compaction checkpoint write failure returns no custom result", () => {
  const archive = trackingMemoryArchive();
  archive.put = () => {
    archive.putCalls += 1;
    return undefined;
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "compaction-write-failure-session",
    project: "/project",
  });
  const result = session.checkpointCompaction({
    firstKeptEntryId: "kept-failure",
    messagesToSummarize: [user("must remain exact", 1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: {},
    settings: {},
  }, { branchEntries: [] });

  assert.equal(result, undefined);
  assert.equal(archive.documents.size, 0);
  assert.deepEqual(session.compactionArchiveEntries, []);
});
