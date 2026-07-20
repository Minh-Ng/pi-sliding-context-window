import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
  EpochWindowSession,
  OversizedInputArchiveError,
  ROTATION_STATE_ENTRY,
} from "../src/session/epoch-window.js";
import {
  createCompactionCatalog,
  reconstructCheckpointSource,
} from "../src/archive/archive-checkpoint.js";
import { estimateModelVisibleTokens } from "../src/session/model-token-budget.js";
import { archiveDocumentProvenance } from "../src/identity/provenance.js";
import { estimateTokens, messageKey, serializeMessage, serializeMessages } from "../src/session/window.js";
import {
  config,
  user,
  assistant,
  trackingMemoryArchive,
  archiveEntryIds,
  seedLegacyCheckpoint,
  seedVerifiedCheckpointEntries,
} from "./epoch-window-helpers.js";

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
