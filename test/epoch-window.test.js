import assert from "node:assert/strict";
import test from "node:test";
import {
  EpochWindowSession,
  ROTATION_STATE_ENTRY,
  TOC_MAX_ENTRIES,
} from "../src/session/epoch-window.js";
import { MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT } from "../src/store/store-contract.js";
import { estimateTokens, messageKey, serializeMessages } from "../src/session/window.js";
import {
  config,
  user,
  assistant,
  persistedLegacyBoundaryKey,
  memoryArchive,
  pressureArchive,
} from "./epoch-window-helpers.js";

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
    toolResultTokens: 0,
    toolResultBudgetTokens: 30_000,
    toolResultBudgetFloorTokens: 1_000,
    toolResultMaxTokens: 4_000,
    toolResultOverBudget: false,
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

test("completed-turn checkpoints persist short sessions once and skip unfinished tails", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: { ...config, rotationTurns: 2 },
    sessionId: "short-session",
    project: "/project",
  });
  const completed = [
    user("Record the cobalt deployment procedure.", 1),
    { ...assistant("The procedure uses the glacier queue.", 2), stopReason: "stop" },
  ];

  assert.deepEqual(session.archiveCompletedTurns(completed), {
    turnCount: 1,
    messageCount: 2,
  });
  assert.equal(archive.documents.size, 1);
  assert.deepEqual(session.rotationState().toc, []);
  assert.deepEqual(session.archiveCompletedTurns(completed), {
    turnCount: 0,
    messageCount: 0,
  });
  assert.equal(archive.documents.size, 1);

  const secondCompleted = [
    user("Confirm the release handoff.", 3),
    { ...assistant("The handoff is confirmed.", 4), stopReason: "stop" },
  ];
  const rotated = session.process([...completed, ...secondCompleted], { contextWindow: 200_000 });
  assert.match(rotated[0].content[0].text, /doc-1 "Record the cobalt deployment procedure."/u);
  assert.equal(archive.documents.size, 1);

  const unfinishedUser = [...completed, user("What comes next?", 5)];
  assert.deepEqual(session.archiveCompletedTurns(unfinishedUser), {
    turnCount: 0,
    messageCount: 0,
  });
  const unfinishedTool = [
    ...completed,
    user("Run the check.", 6),
    {
      ...assistant("", 7),
      content: [{ type: "toolCall", name: "read", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-1",
      content: [{ type: "text", text: "pending result" }],
      timestamp: 8,
    },
  ];
  assert.deepEqual(session.archiveCompletedTurns(unfinishedTool), {
    turnCount: 0,
    messageCount: 0,
  });
  assert.equal(archive.documents.size, 1);
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

// sessionContext (ultracode task #32): the Pi adapter's own automatic digest
// of the active epoch prefix, forwarded into searchDetailed/gatherDetailed's
// own options object. These record the exact options object handed to the
// archive client, the same way the sessionIds-lineage tests above record
// searchOptions off a spied archive.search.
function contextRichMessages() {
  // WIDGET_CALIBRATION_ENGINE recurs across every turn (local document
  // frequency 3/3, so deriveSessionContextTerms' local-IDF proxy still
  // ranks it, just not above a term concentrated in one group); it is enough
  // to prove a non-empty digest without depending on the exact ranking.
  return [
    user("Investigate the WIDGET_CALIBRATION_ENGINE regression.", 1),
    assistant("Looking into WIDGET_CALIBRATION_ENGINE now.", 2),
    user("Any update on WIDGET_CALIBRATION_ENGINE?", 3),
    assistant("Still narrowing down WIDGET_CALIBRATION_ENGINE.", 4),
  ];
}

test("searchDetailed forwards an automatically-computed sessionContext digest from the active epoch prefix", () => {
  const archive = memoryArchive();
  let searchOptions;
  archive.searchDetailed = (_query, options) => {
    searchOptions = options;
    return { mode: "lexical", status: "not-found", results: [] };
  };
  const session = new EpochWindowSession({ archive, config, sessionId: "session-1", project: "/project" });
  session.process(contextRichMessages(), { contextWindow: 200_000 });

  session.searchDetailed("some query");
  assert.ok(Array.isArray(searchOptions.sessionContext));
  assert.ok(searchOptions.sessionContext.length > 0);
  assert.ok(searchOptions.sessionContext.some((term) => term.includes("calibr")));
});

test("gatherDetailed forwards the same automatically-computed sessionContext digest as searchDetailed", () => {
  const archive = memoryArchive();
  let gatherOptions;
  archive.gatherDetailed = (_query, options) => {
    gatherOptions = options;
    return { status: "not-found", mode: "lexical", intent: "auto", anchorCount: 0, candidateCount: 0, returnedTokens: 0, truncated: false, hasMore: false, evidence: [] };
  };
  const session = new EpochWindowSession({ archive, config, sessionId: "session-1", project: "/project" });
  session.process(contextRichMessages(), { contextWindow: 200_000 });

  session.gatherDetailed("some query");
  assert.ok(Array.isArray(gatherOptions.sessionContext));
  assert.ok(gatherOptions.sessionContext.length > 0);
});

test("an explicit sessionContext option overrides the automatic digest", () => {
  const archive = memoryArchive();
  let searchOptions;
  archive.searchDetailed = (_query, options) => {
    searchOptions = options;
    return { mode: "lexical", status: "not-found", results: [] };
  };
  const session = new EpochWindowSession({ archive, config, sessionId: "session-1", project: "/project" });
  session.process(contextRichMessages(), { contextWindow: 200_000 });

  session.searchDetailed("some query", { sessionContext: ["explicit-term"] });
  assert.deepEqual(searchOptions.sessionContext, ["explicit-term"]);
});

test("sessionContextRanking: false opts out -- the digest is never computed and the field is never sent", () => {
  const archive = memoryArchive();
  let searchOptions;
  let gatherOptions;
  archive.searchDetailed = (_query, options) => {
    searchOptions = options;
    return { mode: "lexical", status: "not-found", results: [] };
  };
  archive.gatherDetailed = (_query, options) => {
    gatherOptions = options;
    return { status: "not-found", mode: "lexical", intent: "auto", anchorCount: 0, candidateCount: 0, returnedTokens: 0, truncated: false, hasMore: false, evidence: [] };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, sessionContextRanking: false },
    sessionId: "session-1",
    project: "/project",
  });
  session.process(contextRichMessages(), { contextWindow: 200_000 });

  session.searchDetailed("some query");
  assert.equal("sessionContext" in searchOptions, false);
  session.gatherDetailed("some query");
  assert.equal("sessionContext" in gatherOptions, false);
});

test("sessionContextDigest is empty before the first process() call, with no crash", () => {
  const archive = memoryArchive();
  let searchOptions;
  archive.searchDetailed = (_query, options) => {
    searchOptions = options;
    return { mode: "lexical", status: "not-found", results: [] };
  };
  const session = new EpochWindowSession({ archive, config, sessionId: "session-1", project: "/project" });

  session.searchDetailed("some query");
  assert.equal("sessionContext" in searchOptions, false);
});
