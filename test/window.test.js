import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildTocMarkerText,
  contentToText,
  deduplicateToolResults,
  ESTIMATED_IMAGE_CHARS,
  estimateMessageTokens,
  estimateTokens,
  externalizeLargeToolArguments,
  externalizeLargeToolResults,
  extractDecisionCandidates,
  extractFactCandidates,
  extractSalientTerms,
  findRetainedStart,
  groupCompleteTurns,
  messageKey,
  planEpochRotation,
  removeEmptyAssistantErrors,
  resolveContextLimits,
  serializeMessage,
  shouldRotateWindow,
  sliceFromBoundary,
} from "../src/session/window.js";

function user(text, timestamp) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}
function assistant(text, timestamp) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}
function tool(text, timestamp, id = `t-${timestamp}`) {
  return { role: "toolResult", content: [{ type: "text", text }], timestamp, toolCallId: id, toolName: "bash" };
}
function toolCall(argumentsValue, timestamp, id = `call-${timestamp}`, name = "write") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
    timestamp,
  };
}

test("removes persisted empty retry errors without changing the successful turn", () => {
  const failedAttempt = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "" }],
    stopReason: "error",
    errorMessage: "WebSocket error",
    timestamp: 2,
  };
  const successfulAttempt = assistant("recovered", 3);
  const messages = [user("continue", 1), failedAttempt, successfulAttempt];

  const filtered = removeEmptyAssistantErrors(messages);

  assert.deepEqual(filtered, [messages[0], successfulAttempt]);
  assert.equal(groupCompleteTurns(filtered).filter((turn) => turn.hasUser).length, 1);
});

test("preserves failed assistant messages that contain semantic output", () => {
  const partial = {
    role: "assistant",
    content: [{ type: "text", text: "partial response" }],
    stopReason: "error",
  };
  const messages = [user("continue", 1), partial];
  assert.equal(removeEmptyAssistantErrors(messages), messages);
});

test("groups complete user turns without splitting tool results", () => {
  const messages = [user("one", 1), assistant("call", 2), tool("result", 3), user("two", 4), assistant("done", 5)];
  const turns = groupCompleteTurns(messages);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => [turn.start, turn.end]), [[0, 3], [3, 5]]);
  assert.equal(findRetainedStart(messages, 1), 3);
});

test("retains the requested number of recent turns", () => {
  const messages = [];
  for (let index = 0; index < 8; index++) messages.push(user(`u${index}`, index * 2), assistant(`a${index}`, index * 2 + 1));
  assert.equal(findRetainedStart(messages, 5), 6);
  assert.equal(groupCompleteTurns(messages.slice(6)).filter((turn) => turn.hasUser).length, 5);
});

test("plans normal and below-floor emergency rotation at complete user boundaries", () => {
  const messages = [];
  for (let index = 0; index < 4; index++) {
    messages.push(user(`u${index}`, index * 3), assistant(`a${index}`, index * 3 + 1));
  }
  const base = {
    tokens: 1_000,
    turns: 4,
    rotationTokens: 1_000,
    rotationTurns: 20,
    markerTokenReserve: 0,
  };

  assert.deepEqual(planEpochRotation(messages, { ...base, retainTurns: 2 }), {
    action: "rotate",
    trigger: "tokens",
    mode: "normal",
    start: 4,
    retainedTurns: 2,
    configuredRetainTurns: 2,
    estimatedTokens: estimateTokens(messages.slice(4)),
    markerTokenReserve: 0,
  });
  assert.deepEqual(planEpochRotation(messages, { ...base, retainTurns: 10 }), {
    action: "rotate",
    trigger: "tokens",
    mode: "emergency-retention",
    start: 2,
    retainedTurns: 3,
    configuredRetainTurns: 10,
    estimatedTokens: estimateTokens(messages.slice(2)),
    markerTokenReserve: 0,
  });
});

test("planner progressively reduces retained turns to meet the exact target", () => {
  const messages = [
    user("old", 1), assistant("old answer", 2),
    user("large", 3), assistant("x".repeat(4_000), 4),
    user("current", 5), assistant("small", 6),
  ];
  const currentTokens = estimateTokens(messages.slice(4));
  const options = {
    tokens: 10_000,
    turns: 3,
    rotationTurns: 20,
    retainTurns: 5,
    markerTokenReserve: 10,
  };
  const exact = planEpochRotation(messages, {
    ...options,
    rotationTokens: currentTokens + 10,
  });
  assert.equal(exact.action, "rotate");
  assert.equal(exact.start, 4);
  assert.equal(exact.retainedTurns, 1);
  assert.equal(exact.estimatedTokens, currentTokens + 10);

  const tooSmall = planEpochRotation(messages, {
    ...options,
    rotationTokens: currentTokens + 9,
  });
  assert.equal(tooSmall.action, "native-compaction");
  assert.equal(tooSmall.reason, "oversized-latest-turn");
});

test("planner falls back safely without a complete user boundary", () => {
  const trigger = {
    force: true,
    tokens: 10_000,
    turns: 1,
    rotationTokens: 100,
    rotationTurns: 20,
    retainTurns: 5,
  };
  assert.deepEqual(planEpochRotation([user("only", 1), assistant("huge", 2)], trigger), {
    action: "native-compaction",
    trigger: "forced",
    reason: "no-user-boundary",
  });
  assert.deepEqual(planEpochRotation([{ role: "unknown", content: null }], trigger), {
    action: "native-compaction",
    trigger: "forced",
    reason: "no-user-boundary",
  });
});

test("planner never splits assistant tool calls from their results", () => {
  const messages = [
    user("old", 1),
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], timestamp: 2 },
    tool("result", 3, "call-1"),
    user("current", 4), assistant("done", 5),
  ];
  const plan = planEpochRotation(messages, {
    force: true,
    tokens: 1_000,
    turns: 2,
    rotationTokens: 10_000,
    rotationTurns: 20,
    retainTurns: 5,
    markerTokenReserve: 0,
  });
  assert.equal(plan.action, "rotate");
  assert.equal(plan.start, 3);
  assert.equal(messages[plan.start].role, "user");
  assert.equal(messages.slice(0, plan.start).at(-1).role, "toolResult");
});

test("planner separates no-op and provider-hard-limit fallback deterministically", () => {
  const messages = [user("one", 1), user("two", 2)];
  const below = {
    tokens: 99,
    turns: 2,
    rotationTokens: 100,
    rotationTurns: 20,
    retainTurns: 1,
  };
  assert.deepEqual(planEpochRotation(messages, below), { action: "none", reason: "below-threshold" });

  const hard = {
    ...below,
    tokens: 100,
    observedContextTokens: 800,
    hardLimitTokens: 800,
  };
  const first = planEpochRotation(messages, hard);
  assert.deepEqual(first, {
    action: "native-compaction",
    trigger: "tokens",
    reason: "provider-hard-limit",
    observedContextTokens: 800,
  });
  assert.deepEqual(planEpochRotation(structuredClone(messages), hard), first);
});

test("derives token limits from the selected model with legacy absolute caps", () => {
  const config = { rotationTokens: 128_000, hardLimitTokens: 160_000 };
  assert.deepEqual(resolveContextLimits(config, { contextWindow: 64_000 }), {
    rotationTokens: 41_600,
    hardLimitTokens: 51_200,
    rotationTurns: 20,
    modelPattern: undefined,
  });
  assert.deepEqual(resolveContextLimits(config, { contextWindow: 372_000 }), {
    rotationTokens: 128_000,
    hardLimitTokens: 160_000,
    rotationTurns: 20,
    modelPattern: undefined,
  });
  assert.deepEqual(resolveContextLimits(config, undefined), {
    rotationTokens: 128_000,
    hardLimitTokens: 160_000,
    rotationTurns: 20,
    modelPattern: undefined,
  });
});

test("rotates at either the token or turn threshold", () => {
  const policy = { rotationTokens: 96_000, rotationTurns: 20 };
  assert.equal(shouldRotateWindow({ ...policy, tokens: 95_999, turns: 19 }), false);
  assert.equal(shouldRotateWindow({ ...policy, tokens: 96_000, turns: 2 }), true);
  assert.equal(shouldRotateWindow({ ...policy, tokens: 1_000, turns: 20 }), true);
  assert.equal(shouldRotateWindow({ ...policy, force: true, tokens: 0, turns: 0 }), true);
});

test("externalizes large tool results deterministically", () => {
  const stored = [];
  const original = [user("run", 1), tool("x".repeat(10_000), 2, "abc")];
  const result = externalizeLargeToolResults(original, {
    maxTokens: 100,
    previewTokens: 40,
    store(message, text) {
      stored.push([message.toolCallId, text]);
      return "tool-archive-id";
    },
  });
  assert.equal(result.changed, true);
  assert.equal(stored.length, 1);
  assert.match(result.messages[1].content[0].text, /tool-archive-id/);
  assert.ok(estimateTokens(result.messages) < estimateTokens(original));
});

test("failed tool-result archival leaves the original provider content intact", () => {
  const original = [user("run", 1), tool("x".repeat(10_000), 2, "abc")];
  const result = externalizeLargeToolResults(original, {
    maxTokens: 100,
    previewTokens: 40,
    store() { return undefined; },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages, original);
  assert.equal(result.messages[1].content[0].text, "x".repeat(10_000));
});

test("reports admitted tool-result tokens and omits budget fields when unbudgeted", () => {
  const result = externalizeLargeToolResults([tool("a".repeat(400), 1, "a")], {
    maxTokens: 1_000,
    store: () => "unused",
  });
  assert.equal(result.changed, false);
  assert.equal(result.admittedTokens, Math.ceil(400 / 4));
  assert.equal("overBudget" in result, false);
  assert.equal("budgetTokens" in result, false);
});

test("cumulative tool-result budget lowers the per-result gate exactly at the boundary", () => {
  // Base gate 1000 tokens (4000 chars); floor gate 100 tokens (400 chars);
  // budget 500 tokens (2000 chars). The mid result (1000 chars) clears the
  // base gate but trips the floor gate.
  const gate = { maxTokens: 1_000, floorTokens: 100, budgetTokens: 500, previewTokens: 40 };
  const mid = tool("m".repeat(1_000), 2, "mid");

  // Prefix admits 1999 chars — one below the 2000-char budget — so the mid
  // result is still gated at the base threshold and kept whole.
  const below = externalizeLargeToolResults(
    [tool("p".repeat(1_999), 1, "pre"), mid],
    { ...gate, store: () => "arc-below" },
  );
  assert.equal(below.changed, false);
  assert.equal(below.messages[1], mid);

  // Prefix admits exactly 2000 chars — the budget is now reached, so the same
  // mid result trips the lowered floor gate and is externalized.
  const atBoundary = externalizeLargeToolResults(
    [tool("p".repeat(2_000), 1, "pre"), mid],
    { ...gate, store: () => "arc-mid" },
  );
  assert.equal(atBoundary.changed, true);
  assert.equal(atBoundary.overBudget, true);
  assert.match(atBoundary.messages[1].content[0].text, /arc-mid/);
  // The prefix result (2000 chars, under the base gate) is never rewritten.
  assert.equal(atBoundary.messages[0].content[0].text, "p".repeat(2_000));
});

test("cumulative tool-result budget is forward-only within an epoch", () => {
  const gate = { maxTokens: 1_000, floorTokens: 100, budgetTokens: 500, previewTokens: 40 };
  const early = tool("e".repeat(1_000), 1, "early"); // admitted while under budget
  const filler = tool("f".repeat(1_600), 2, "filler"); // pushes the total over budget
  const late = tool("l".repeat(1_000), 3, "late"); // same size as early, arrives over budget
  const result = externalizeLargeToolResults([early, filler, late], {
    ...gate,
    store: (message) => `arc-${message.toolCallId}`,
  });

  // early and filler were admitted before the budget was crossed, so both stay
  // inline even though the epoch ends over budget — the exposed prefix is not
  // rewritten. late, the same size as early, is externalized because it arrives
  // after the crossing.
  assert.equal(result.messages[0], early);
  assert.equal(result.messages[1], filler);
  assert.match(result.messages[2].content[0].text, /arc-late/);
  assert.equal(result.overBudget, true);
});

test("suppresses an exact-duplicate tool result regardless of size and never touches the earlier one", () => {
  const first = tool("same output", 1, "call-1");
  const second = tool("same output", 2, "call-2");
  const stored = [];
  const result = deduplicateToolResults([first, second], {
    store(message, text) {
      stored.push([message.toolCallId, text]);
      return "tool-dup-id";
    },
  });

  assert.equal(result.changed, true);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], ["call-2", "same output"]);
  // The earlier occurrence is byte-identical: never rewritten.
  assert.equal(result.messages[0], first);
  assert.match(result.messages[1].content[0].text, /identical to earlier result call-1/i);
  assert.match(result.messages[1].content[0].text, /archived as tool-dup-id/);
  assert.deepEqual(result.archiveIds, ["tool-dup-id"]);
});

test("leaves a near-match tool result (changed content) fully in place", () => {
  const first = tool("output v1", 1, "call-1");
  const second = tool("output v2", 2, "call-2"); // one byte different
  const result = deduplicateToolResults([first, second], {
    store() { throw new Error("must not archive a near-match"); },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages[0], first);
  assert.equal(result.messages[1], second);
  assert.equal(result.messages[1].content[0].text, "output v2");
  assert.deepEqual(result.archiveIds, []);
});

test("matches on tool name and normalized call arguments, not content alone", () => {
  const readCall1 = toolCall({ path: "/a" }, 1, "call-1", "read");
  const readResult1 = tool("shared bytes", 2, "call-1");
  const readCall2 = toolCall({ path: "/b" }, 3, "call-2", "read"); // different arguments
  const readResult2 = tool("shared bytes", 4, "call-2");

  const result = deduplicateToolResults(
    [readCall1, readResult1, readCall2, readResult2],
    { store() { throw new Error("must not archive: arguments differ"); } },
  );
  assert.equal(result.changed, false);

  // Same tool, same arguments (key order swapped), same content: this is a
  // genuine duplicate even though the argument object's keys are reordered.
  const writeCall1 = toolCall({ path: "/x", mode: "a" }, 5, "call-3", "write");
  const writeResult1 = tool("wrote 3 bytes", 6, "call-3");
  const writeCall2 = toolCall({ mode: "a", path: "/x" }, 7, "call-4", "write");
  const writeResult2 = tool("wrote 3 bytes", 8, "call-4");

  let archived;
  const duplicate = deduplicateToolResults(
    [writeCall1, writeResult1, writeCall2, writeResult2],
    { store: () => { archived = true; return "tool-write-dup"; } },
  );
  assert.equal(archived, true);
  assert.match(duplicate.messages[3].content[0].text, /archived as tool-write-dup/);
});

test("chains every later duplicate back to the same never-rewritten first occurrence", () => {
  const first = tool("same output", 1, "call-1");
  const second = tool("same output", 2, "call-2");
  const third = tool("same output", 3, "call-3");
  let calls = 0;
  const result = deduplicateToolResults([first, second, third], {
    store: () => `tool-dup-${(calls += 1)}`,
  });

  assert.equal(result.messages[0], first);
  assert.match(result.messages[1].content[0].text, /identical to earlier result call-1.*archived as tool-dup-1/is);
  assert.match(result.messages[2].content[0].text, /identical to earlier result call-1.*archived as tool-dup-2/is);
  assert.deepEqual(result.archiveIds, ["tool-dup-1", "tool-dup-2"]);
});

test("externalizes large tool-call arguments deterministically without disturbing other content", () => {
  const stored = [];
  const original = [
    user("run", 1),
    toolCall({ path: "/tmp/big.txt", content: "x".repeat(10_000) }, 2, "call-big"),
  ];
  const result = externalizeLargeToolArguments(original, {
    maxTokens: 100,
    previewTokens: 40,
    store(message, part, text) {
      stored.push([message.timestamp, part.id, text]);
      return "tool-arg-archive-id";
    },
  });

  assert.equal(result.changed, true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0][0], 2);
  assert.equal(stored[0][1], "call-big");
  assert.match(stored[0][2], /"path":"\/tmp\/big\.txt"/);
  const [call] = result.messages[1].content;
  assert.equal(call.type, "toolCall");
  assert.equal(call.id, "call-big");
  // Providers require tool_use/toolCall input to stay a JSON object, so the
  // externalized field must be object-shaped, not a bare preview string.
  assert.equal(typeof call.arguments, "object");
  assert.equal(call.arguments.archivedAs, "tool-arg-archive-id");
  assert.match(call.arguments.preview, /tool-arg-archive-id/);
  assert.ok(estimateTokens(result.messages) < estimateTokens(original));
  // The original message array is untouched; only the returned copy changed.
  assert.equal(typeof original[1].content[0].arguments, "object");
});

test("small tool-call arguments are left untouched", () => {
  const original = [toolCall({ path: "a.txt" }, 1, "call-small")];
  const result = externalizeLargeToolArguments(original, { maxTokens: 100, store() { return "unused"; } });
  assert.equal(result.changed, false);
  assert.equal(result.messages, original);
});

test("failed tool-argument archival leaves the original provider content intact", () => {
  const original = [toolCall({ content: "x".repeat(10_000) }, 1, "call-fail")];
  const result = externalizeLargeToolArguments(original, {
    maxTokens: 100,
    previewTokens: 40,
    store() { return undefined; },
  });

  assert.equal(result.changed, false);
  assert.equal(result.messages, original);
  assert.deepEqual(result.messages[0].content[0].arguments, { content: "x".repeat(10_000) });
});

test("tool-call arguments carried under `input` are externalized in place", () => {
  const original = [{
    role: "assistant",
    content: [{ type: "tool_call", id: "call-input", name: "write", input: { content: "y".repeat(10_000) } }],
    timestamp: 1,
  }];
  const result = externalizeLargeToolArguments(original, {
    maxTokens: 100,
    previewTokens: 40,
    store: () => "input-archive-id",
  });

  assert.equal(result.changed, true);
  const [call] = result.messages[0].content;
  assert.equal(call.arguments, undefined);
  assert.equal(typeof call.input, "object");
  assert.equal(call.input.archivedAs, "input-archive-id");
  assert.match(call.input.preview, /input-archive-id/);
});

test("message keys hash the complete deterministic serialization", () => {
  const prefix = "x".repeat(8_100);
  const first = user(`${prefix}a`, 1);
  const second = user(`${prefix}b`, 1);

  assert.notEqual(messageKey(first), messageKey(second));
  assert.match(messageKey(first), /^user:1::[a-f0-9]{12}$/);
});

test("serializes and counts Pi synthetic message payloads", () => {
  const large = "x".repeat(10_000);
  const messages = [
    {
      role: "bashExecution",
      command: "printf payload",
      output: large,
      exitCode: 7,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/tmp/full-output",
      excludeFromContext: false,
      timestamp: 1,
    },
    { role: "compactionSummary", summary: large, tokensBefore: 371_566, timestamp: 2 },
    { role: "branchSummary", summary: large, fromId: "branch-source", timestamp: 3 },
  ];

  assert.match(serializeMessage(messages[0]), /\[command\] printf payload/);
  assert.match(serializeMessage(messages[0]), /"exitCode":7/);
  assert.match(serializeMessage(messages[1]), /tokensBefore=371566/);
  assert.match(serializeMessage(messages[2]), /fromId="branch-source"/);
  assert.ok(estimateTokens(messages) >= 7_500);

  for (const message of messages) {
    assert.equal(messageKey(message), messageKey(structuredClone(message)));
  }
  assert.notEqual(messageKey(messages[0]), messageKey({ ...messages[0], output: `${large}!` }));
  assert.notEqual(messageKey(messages[1]), messageKey({ ...messages[1], summary: `${large}!` }));
  assert.notEqual(messageKey(messages[2]), messageKey({ ...messages[2], fromId: "other-branch" }));
});

test("estimateMessageTokens shares its per-message accounting with estimateTokens' array aggregate", () => {
  const messages = [
    user("short question", 1),
    assistant("a longer answer with more characters to weigh", 2),
    tool("some tool output text", 3, "call-1"),
  ];

  // estimateTokens' array path ceils once over the summed characters (plus a
  // small n-1 join-character term), while summing estimateMessageTokens ceils
  // once per message; the two can drift by at most about one token per
  // message from that independent per-message rounding.
  const summedTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  assert.ok(Math.abs(estimateTokens(messages) - summedTokens) <= messages.length);

  assert.equal(estimateMessageTokens(tool("x", 4, "call-2")), estimateMessageTokens(tool("x", 5, "call-3")));
  assert.ok(estimateMessageTokens(assistant("x".repeat(400), 6)) > estimateMessageTokens(assistant("x", 7)));
});

test("multimodal serialization is bounded, content-sensitive, and provider-conservative", () => {
  const data = Buffer.alloc(100_000, 7).toString("base64");
  const image = { type: "image", data, mimeType: "image/png" };
  const message = {
    role: "user",
    content: [{ type: "text", text: "inspect this" }, image],
    timestamp: 10,
  };
  const serialized = serializeMessage(message);

  assert.match(serialized, /inspect this/);
  assert.match(serialized, /\[image mimeType="image\/png" bytes=100000 sha256=[a-f0-9]{16}\]/);
  assert.equal(serialized.includes(data), false);
  assert.ok(serialized.length < 250, "base64 must not leak into deterministic archive text");
  assert.ok(estimateTokens([message]) >= ESTIMATED_IMAGE_CHARS / 4);
  assert.equal(messageKey(message), messageKey(structuredClone(message)));
  assert.notEqual(messageKey(message), messageKey({
    ...message,
    content: [{ type: "text", text: "inspect this" }, { ...image, data: `${data.slice(0, -4)}AAAA` }],
  }));
  assert.notEqual(messageKey(message), messageKey({
    ...message,
    content: [{ type: "text", text: "inspect this" }, { ...image, mimeType: "image/jpeg" }],
  }));

  const unknownA = contentToText([{ type: "audio", data: "a".repeat(10_000) }]);
  const unknownB = contentToText([{ type: "audio", data: "b".repeat(10_000) }]);
  assert.ok(unknownA.length < 100);
  assert.notEqual(unknownA, unknownB);
});

test("externalizing mixed tool output preserves image blocks", () => {
  const image = { type: "image", data: Buffer.from("pixels").toString("base64"), mimeType: "image/png" };
  const original = {
    role: "toolResult",
    content: [{ type: "text", text: "x".repeat(10_000) }, image],
    timestamp: 2,
    toolCallId: "mixed",
    toolName: "read",
  };
  const result = externalizeLargeToolResults([original], {
    maxTokens: 100,
    previewTokens: 40,
    store: () => "mixed-archive",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.messages[0].content[1], image);
  assert.match(result.messages[0].content[0].text, /mixed-archive/);
});

test("restores current and pre-multimodal epoch boundaries", () => {
  const messages = [user("old", 1), assistant("old answer", 2), user("new", 3)];
  const key = messageKey(messages[2]);
  assert.deepEqual(sliceFromBoundary(messages, key).messages, [messages[2]]);
  assert.equal(sliceFromBoundary(messages, "missing").found, false);

  const imageMessage = {
    role: "user",
    content: [{ type: "text", text: "legacy caption" }, {
      type: "image",
      data: Buffer.from("legacy image").toString("base64"),
      mimeType: "image/png",
    }],
    timestamp: 4,
  };
  const oldSerialization = "[user] legacy caption";
  const oldDigest = createHash("sha256").update(oldSerialization).digest("hex").slice(0, 12);
  const oldKey = `user:4::${oldDigest}`;
  assert.deepEqual(sliceFromBoundary([imageMessage], oldKey).messages, [imageMessage]);
});

test("extractSalientTerms captures identifiers, paths, and quoted spans without duplicates", () => {
  const terms = extractSalientTerms(
    "Set `branchSummary.skipPrompt` in src/config.js; rotationContextRatio and retry_count matter. Also branchSummary.skipPrompt again.",
  );
  assert.deepEqual(terms, [
    "branchSummary.skipPrompt",
    "src/config.js",
    "rotationContextRatio",
    "retry_count",
  ]);
  assert.deepEqual(extractSalientTerms("no jargon here at all"), []);
  assert.equal(extractSalientTerms("a_1 b_2 c_3 d_4 e_5 f_6 g_7 h_8 i_9 j_10", 3).length, 3);
});

test("buildTocMarkerText renders entries and drops oldest first under budget pressure", () => {
  assert.equal(buildTocMarkerText([]), undefined);
  assert.equal(buildTocMarkerText(undefined), undefined);

  const entries = [
    { id: "doc-1", topic: "first", terms: ["alpha_one"] },
    { id: "doc-2", topic: "second", terms: [] },
  ];
  const text = buildTocMarkerText(entries);
  assert.match(text, /rotated out/);
  assert.match(text, /- doc-1 "first" — alpha_one/);
  assert.match(text, /- doc-2 "second"$/m);

  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `doc-${index}`,
    topic: `topic ${index} ${"x".repeat(60)}`,
    terms: [`term_${index}`],
  }));
  const capped = buildTocMarkerText(many, 200);
  assert.ok(!capped.includes("doc-0 "));
  assert.ok(capped.includes(`doc-${many.length - 1} `));
  assert.ok(capped.length / 4 <= 220);
});

test("extractDecisionCandidates quotes decision-shaped sentences verbatim", () => {
  const text = [
    "[user] Should we keep the queue?",
    "[assistant] We agreed to keep the queue rather than callbacks. It processes jobs in order.",
    "The sliding-window approach was rejected because it broke caching. Purely descriptive sentence here.",
    "We agreed to keep the queue rather than callbacks.",
  ].join("\n");
  const candidates = extractDecisionCandidates(text);
  assert.deepEqual(candidates, [
    "[assistant] We agreed to keep the queue rather than callbacks.",
    "The sliding-window approach was rejected because it broke caching.",
    "We agreed to keep the queue rather than callbacks.",
  ]);
  // Every candidate is a verbatim span of the source.
  for (const candidate of candidates) {
    assert.ok(text.includes(candidate), `not verbatim: ${candidate}`);
  }

  assert.deepEqual(extractDecisionCandidates("Nothing conclusive was discussed today."), []);
  assert.deepEqual(
    extractDecisionCandidates("Can you remember what we chose for canary deploys?"),
    [],
    "an interrogative reference to a choice is not itself a decision",
  );
  assert.deepEqual(
    extractDecisionCandidates("We chose cobalt for canary deploys."),
    ["We chose cobalt for canary deploys."],
    "the equivalent declarative choice remains eligible",
  );
  assert.deepEqual(extractDecisionCandidates(`We decided that ${"x".repeat(400)}.`), [], "over-length sentences are skipped");
  const many = Array.from({ length: 9 }, (_, i) => `We decided option ${i} works.`).join(" ");
  assert.equal(extractDecisionCandidates(many).length, 5, "caps candidates per turn");
});

test("extractFactCandidates quotes fact-shaped sentences verbatim with a structured anchor", () => {
  const text = [
    "[user] What node version and socket path do we use?",
    "[assistant] The build uses node v20.11.0 for this project.",
    "The socket lives in /tmp/app.sock. Purely descriptive sentence here.",
    "The config value is timeout=30.",
    "The default queue is named jobs-primary.",
  ].join("\n");
  const candidates = extractFactCandidates(text);
  assert.deepEqual(candidates, [
    { text: "[assistant] The build uses node v20.11.0 for this project.", anchor: { type: "value", value: "v20.11.0" } },
    // The path anchor sits at the end of its sentence, so its value carries
    // that sentence's own trailing "." -- exact.js's classifier includes "."
    // in a path's character class, and this is deliberately reported as-is
    // (never re-trimmed) so it matches this document's own exact-index
    // posting byte-for-byte; see extractFactCandidates' doc comment.
    { text: "The socket lives in /tmp/app.sock.", anchor: { type: "path", value: "/tmp/app.sock." } },
    { text: "The config value is timeout=30.", anchor: { type: "value", value: "timeout=30" } },
    { text: "The default queue is named jobs-primary.", anchor: { type: "value", value: "jobs-primary" } },
  ]);
  // Every candidate's text is a verbatim span of the source turn.
  for (const candidate of candidates) {
    assert.ok(text.includes(candidate.text), `not verbatim: ${candidate.text}`);
  }
});

test("extractFactCandidates requires both a typed anchor and a binding cue", () => {
  // Anchor present (a path), but no binding cue anywhere in the sentence.
  assert.deepEqual(
    extractFactCandidates("The file /tmp/app.sock changed permissions recently."),
    [],
    "an anchor without a binding cue is not extracted",
  );
  // Binding cue present ("is"), but no typed value/path/url anchor.
  assert.deepEqual(
    extractFactCandidates("This retention setting is important to review."),
    [],
    "a binding cue without a typed anchor is not extracted",
  );
  assert.deepEqual(extractFactCandidates("Nothing conclusive was discussed today."), []);
  assert.deepEqual(
    extractFactCandidates(`The config value is ${"x".repeat(400)}=1.`),
    [],
    "over-length sentences are skipped",
  );
  // "is" also opens an interrogative; a question is never itself a bound
  // fact even when it names a typed anchor (observed as a false positive
  // against the eval retrieval fixtures -- see task notes).
  assert.deepEqual(
    extractFactCandidates("Is the migration checkpoint restart-safe?"),
    [],
    "an interrogative sentence is not extracted even with an anchor and a cue",
  );
});

test("extractFactCandidates caps candidates per turn independently of decisions", () => {
  const manyFacts = Array.from({ length: 9 }, (_, i) => `The port for service-${i} is set to service-${i}-8080.`).join(" ");
  assert.equal(extractFactCandidates(manyFacts).length, 5, "caps fact candidates per turn");

  const mixed = [
    ...Array.from({ length: 9 }, (_, i) => `We decided option ${i} works.`),
    ...Array.from({ length: 9 }, (_, i) => `The port for service-${i} is set to service-${i}-8080.`),
  ].join(" ");
  assert.equal(extractDecisionCandidates(mixed).length, 5, "decision cap is unaffected by fact-shaped sentences");
  assert.equal(extractFactCandidates(mixed).length, 5, "fact cap is unaffected by decision-shaped sentences");
});
