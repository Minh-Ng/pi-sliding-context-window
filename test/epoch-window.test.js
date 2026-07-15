import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EpochWindowSession, ROTATION_STATE_ENTRY, TOC_MAX_ENTRIES } from "../src/epoch-window.js";
import { archiveDocumentProvenance } from "../src/provenance.js";
import { estimateTokens, messageKey, serializeMessage, serializeMessages } from "../src/window.js";

const config = {
  rotationTokens: 100_000,
  rotationTurns: 3,
  hardLimitTokens: 120_000,
  retainTurns: 1,
  maxToolResultTokens: 4_000,
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

test("an oversized latest turn falls back to native compaction without mutating epoch state", () => {
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
  assert.equal(session.shouldCancelCompaction("threshold", 100), false);
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

test("session controller cancels threshold compaction only when both measurements are safe", () => {
  const session = new EpochWindowSession({
    archive: memoryArchive(),
    config,
    sessionId: "session-1",
    project: "/project",
  });
  session.process([user("measured", 1)]);

  assert.equal(session.shouldCancelCompaction("threshold", 100_000), true);
  assert.equal(session.shouldCancelCompaction("threshold"), false);
  assert.equal(session.shouldCancelCompaction("threshold", 120_000), false);
  assert.equal(session.shouldCancelCompaction("threshold", 371_566), false);
  assert.equal(session.shouldCancelCompaction("overflow", 100_000), false);
  assert.equal(session.shouldCancelCompaction("manual", 100_000), false);
});

test("rotation archives verbatim decision candidates with turn provenance", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: () => {},
  });
  const decisionText = "We agreed to keep the queue rather than callbacks.";
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
