import assert from "node:assert/strict";
import test from "node:test";
import {
  EpochWindowSession,
  ROTATION_STATE_ENTRY,
} from "../src/session/epoch-window.js";
import { archiveDocumentProvenance } from "../src/identity/provenance.js";
import { messageKey } from "../src/session/window.js";
import {
  config,
  user,
  assistant,
  memoryArchive,
  pressureArchive,
} from "./epoch-window-helpers.js";

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

function toolResult(text, timestamp, id) {
  return { role: "toolResult", content: [{ type: "text", text }], timestamp, toolCallId: id, toolName: "read" };
}

test("over-budget epoch externalizes new tool results below the base gate", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      rotationTurns: 50,
      maxToolResultTokens: 4_000, // base gate 16000 chars
      toolResultBudgetRatio: 0.02, // budget = 2000 tokens = 8000 chars
      toolResultBudgetFloorTokens: 500, // floor gate 2000 chars
    },
    sessionId: "budget-session",
    project: "/project",
  });
  const messages = [
    user("run tools", 1),
    toolResult("a".repeat(12_000), 2, "r1"), // under base gate; pushes epoch over budget
    toolResult("b".repeat(3_000), 3, "r2"), // clears base gate but trips the lowered floor gate
  ];

  const result = session.process(messages, { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 0);
  // r1 is admitted whole and drives the epoch over the 8000-char budget.
  assert.equal(result[1].content[0].text.length, 12_000);
  // r2 would clear the 16000-char base gate but is externalized because the
  // epoch is already over budget and its 3000 chars exceed the 2000-char floor.
  assert.match(result[2].content[0].text, /tool-[a-f0-9]{16}/);
  assert.equal(archive.documents.size, 1);
  const status = session.status();
  assert.equal(status.toolResultOverBudget, true);
  assert.equal(status.toolResultBudgetTokens, 2_000);
  assert.equal(status.toolResultBudgetFloorTokens, 500);
  assert.ok(status.toolResultTokens >= 3_000);
});

test("resume reproduces the tool-result budget counter from the filtered prefix", () => {
  const budgetConfig = {
    ...config,
    rotationTurns: 2,
    retainTurns: 1,
    maxToolResultTokens: 4_000, // base gate 16000 chars
    toolResultBudgetRatio: 0.001, // budget = 100 tokens = 400 chars
    toolResultBudgetFloorTokens: 500, // floor gate 2000 chars
  };
  const messages = [
    user("one", 1), toolResult("a".repeat(2_000), 2, "tr1"), assistant("answer one", 3),
    user("two", 4), toolResult("b".repeat(2_000), 5, "tr2"), toolResult("c".repeat(2_500), 6, "tr3"), assistant("answer two", 7),
  ];

  const archive = memoryArchive();
  const rotations = [];
  const session = new EpochWindowSession({
    archive,
    config: budgetConfig,
    sessionId: "resume-budget",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });
  const first = session.process(messages, { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 1);
  assert.equal(rotations.at(-1).boundaryKey, messageKey(messages[3]));
  // Retained epoch keeps tr2 (2000 chars, at the floor gate) and externalizes
  // tr3 (2500 chars, over the floor gate) because the epoch is over budget.
  const firstStatus = session.status();
  assert.equal(firstStatus.toolResultOverBudget, true);
  assert.ok(firstStatus.toolResultTokens > 0);

  const restored = new EpochWindowSession({
    archive: memoryArchive(),
    config: budgetConfig,
    sessionId: "resume-budget",
    project: "/project",
  });
  restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: rotations.at(-1) }]);
  const resumed = restored.process(messages, { contextWindow: 200_000 });

  // The filtered-prefix rebuild recomputes an identical window and counter.
  assert.deepEqual(resumed, first);
  const resumedStatus = restored.status();
  assert.equal(resumedStatus.toolResultTokens, firstStatus.toolResultTokens);
  assert.equal(resumedStatus.toolResultOverBudget, firstStatus.toolResultOverBudget);
  assert.equal(resumedStatus.toolResultBudgetTokens, firstStatus.toolResultBudgetTokens);
});

test("rotation resets the tool-result budget counter to the retained epoch", () => {
  const budgetConfig = {
    ...config,
    rotationTurns: 2,
    retainTurns: 1,
    maxToolResultTokens: 4_000,
    toolResultBudgetRatio: 0.001, // budget = 100 tokens = 400 chars
    toolResultBudgetFloorTokens: 500,
  };
  const heavyTurn = [
    user("heavy", 1),
    toolResult("a".repeat(8_000), 2, "h1"),
    assistant("done heavy", 3),
  ];

  // A single heavy turn alone is over budget.
  const heavyOnly = new EpochWindowSession({
    archive: memoryArchive(),
    config: budgetConfig,
    sessionId: "reset-budget",
    project: "/project",
  });
  heavyOnly.process(heavyTurn, { contextWindow: 200_000 });
  const heavyTokens = heavyOnly.status().toolResultTokens;
  assert.equal(heavyOnly.status().rotations, 0);
  assert.equal(heavyOnly.status().toolResultOverBudget, true);
  assert.equal(heavyTokens, Math.ceil(8_000 / 4));

  // Adding a light second turn rotates the heavy turn out; the counter is
  // recomputed over the retained light epoch only.
  const session = new EpochWindowSession({
    archive: memoryArchive(),
    config: budgetConfig,
    sessionId: "reset-budget",
    project: "/project",
  });
  const messages = [
    ...heavyTurn,
    user("light", 4),
    toolResult("b".repeat(200), 5, "l1"),
    assistant("done light", 6),
  ];
  session.process(messages, { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 1);
  const retainedTokens = session.status().toolResultTokens;
  assert.ok(retainedTokens < heavyTokens);
  assert.equal(retainedTokens, Math.ceil(200 / 4));
  assert.equal(session.status().toolResultOverBudget, false);
});

test("an exact-duplicate tool result is suppressed and archived regardless of size, leaving the earlier one untouched", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "dedup-session",
    project: "/project",
  });
  const messages = [
    user("read the file twice", 1),
    toolResult("shared bytes", 2, "call-1"),
    toolResult("shared bytes", 3, "call-2"),
  ];

  const result = session.process(messages, { contextWindow: 200_000 });

  // The earlier occurrence is byte-identical to the source message.
  assert.equal(result[1].content[0].text, "shared bytes");
  const [document] = [...archive.documents.values()];
  assert.equal(document.kind, "tool-result");
  // Archived regardless of size: "shared bytes" is far below any size gate.
  assert.equal(document.text, "shared bytes");
  assert.match(result[2].content[0].text, /identical to earlier result call-1 in this conversation/i);
  assert.match(result[2].content[0].text, new RegExp(`archived as ${document.id}`));
  // The marker's own archive ID recalls the exact duplicate content.
  assert.equal(session.recall(document.id).text, "shared bytes");
});

test("a near-match tool result (same tool, changed content) is never suppressed", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "near-match-session",
    project: "/project",
  });
  const messages = [
    user("read the file, then read it again after editing", 1),
    toolResult("file contents v1", 2, "call-1"),
    toolResult("file contents v2", 3, "call-2"),
  ];

  const result = session.process(messages, { contextWindow: 200_000 });

  assert.equal(result[1].content[0].text, "file contents v1");
  assert.equal(result[2].content[0].text, "file contents v2");
  assert.equal([...archive.documents.values()].some((document) => document.kind === "tool-result"), false);
});

test("dedupToolResults: false keeps every duplicate tool result in full", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: { ...config, dedupToolResults: false },
    sessionId: "dedup-disabled-session",
    project: "/project",
  });
  const messages = [
    user("read the file twice", 1),
    toolResult("shared bytes", 2, "call-1"),
    toolResult("shared bytes", 3, "call-2"),
  ];

  const result = session.process(messages, { contextWindow: 200_000 });

  assert.equal(result[1].content[0].text, "shared bytes");
  assert.equal(result[2].content[0].text, "shared bytes");
  assert.equal([...archive.documents.values()].some((document) => document.kind === "tool-result"), false);
});

test("resume rebuilds the per-epoch duplicate map deterministically from the retained slice", () => {
  const dedupConfig = { ...config, rotationTurns: 3, retainTurns: 2 };
  const messages = [
    user("one", 1), assistant("ack one", 2),
    user("two", 3), toolResult("payload", 4, "call-1"), assistant("ack two", 5),
    user("three", 6), toolResult("payload", 7, "call-2"), assistant("ack three", 8),
  ];

  const archive = memoryArchive();
  const rotations = [];
  const session = new EpochWindowSession({
    archive,
    config: dedupConfig,
    sessionId: "resume-dedup-session",
    project: "/project",
    onRotation: (state) => rotations.push(state),
  });
  const first = session.process(messages, { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 1);

  const toolMessages = first.filter((message) => message.role === "toolResult");
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0].content[0].text, "payload");
  assert.match(toolMessages[1].content[0].text, /identical to earlier result call-1/i);
  const [dupId] = [...archive.documents.values()]
    .filter((document) => document.kind === "tool-result")
    .map((document) => document.id);
  assert.match(toolMessages[1].content[0].text, new RegExp(`archived as ${dupId}`));

  const restored = new EpochWindowSession({
    archive: memoryArchive(),
    config: dedupConfig,
    sessionId: "resume-dedup-session",
    project: "/project",
  });
  restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: rotations.at(-1) }]);
  const resumed = restored.process(messages, { contextWindow: 200_000 });

  // The comparison map is not persisted; it is rebuilt from the same
  // boundary-filtered active slice and reproduces byte-identical output.
  assert.deepEqual(resumed, first);
  const resumedToolMessages = resumed.filter((message) => message.role === "toolResult");
  assert.equal(resumedToolMessages[0].content[0].text, "payload");
  assert.match(resumedToolMessages[1].content[0].text, new RegExp(`archived as ${dupId}`));
});

test("rotation resets the duplicate map: a repeat in a new epoch is not suppressed", () => {
  // Within the one call that decides to rotate, the pre-rotation active set
  // (all turns present so far) is what dedup and the size-based gates both
  // compare against — the same forward-only shape the tool-result budget
  // already uses. What "resets on rotation" means is the NEXT call: once the
  // boundary has actually advanced, the rotated-out turn is genuinely absent
  // from every later call's active slice, so a later repeat of its content
  // has no earlier occurrence to match.
  const dedupConfig = { ...config, rotationTurns: 3, retainTurns: 1 };
  const turnA = [user("one", 1), toolResult("payload", 2, "call-1"), assistant("ack one", 3)];
  const turnB = [user("two", 4), assistant("ack two", 5)];
  const turnC = [user("three", 6), assistant("ack three", 7)];
  const turnD = [user("four", 8), toolResult("payload", 9, "call-2"), assistant("ack four", 10)];

  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: dedupConfig,
    sessionId: "reset-dedup-session",
    project: "/project",
  });

  // First call: three turns trip rotationTurns=3; retainTurns=1 keeps only
  // turnC, so turnA's "payload" tool result leaves the active window for
  // every later call.
  session.process([...turnA, ...turnB, ...turnC], { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 1);
  assert.equal([...archive.documents.values()].some((document) => document.kind === "tool-result"), false);

  // Second call: turnD repeats turnA's exact tool-result text, but the
  // active slice (turnC + turnD, below rotationTurns=3) no longer contains
  // turnA at all, so the map has reset and this is not suppressed.
  const result = session.process([...turnA, ...turnB, ...turnC, ...turnD], { contextWindow: 200_000 });
  assert.equal(session.status().rotations, 1);
  const toolMessages = result.filter((message) => message.role === "toolResult");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content[0].text, "payload");
  assert.equal([...archive.documents.values()].some((document) => document.kind === "tool-result"), false);
});

test("a suppressed duplicate does not count toward the cumulative tool-result budget", () => {
  const budgetConfig = {
    ...config,
    rotationTurns: 50,
    maxToolResultTokens: 4_000, // base gate 16,000 chars; one 6,000-char payload clears it
    toolResultBudgetRatio: 0.02, // budget = 2,000 tokens = 8,000 chars
    toolResultBudgetFloorTokens: 500,
  };
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config: budgetConfig,
    sessionId: "dedup-budget-session",
    project: "/project",
  });
  const payload = "x".repeat(6_000); // 1,500 tokens; two raw copies would be 3,000 (over budget)
  const messages = [
    user("run tools", 1),
    toolResult(payload, 2, "call-1"),
    toolResult(payload, 3, "call-2"), // exact duplicate; must collapse to a short marker
  ];

  session.process(messages, { contextWindow: 200_000 });
  const status = session.status();
  // If the duplicate were admitted in full, two 6,000-char copies (3,000
  // tokens) would exceed the 2,000-token budget. Collapsed to a marker, only
  // one real copy plus a short marker is admitted, staying well under it.
  assert.equal(status.toolResultOverBudget, false);
  assert.ok(status.toolResultTokens < 1_700);
  assert.ok(status.toolResultTokens < Math.ceil((payload.length * 2) / 4));
});
