import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createContextEpochWindow } from "../extensions/pi.ts";
import {
  ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
  ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES,
  reconstructCheckpointSource,
} from "../src/archive-checkpoint.js";
import { DaemonArchive } from "../src/daemon-archive.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  EpochWindowSession,
  OversizedInputArchiveError,
} from "../src/epoch-window.js";
import { estimateModelVisibleTokens } from "../src/model-token-budget.js";
import { contentHash } from "../src/rocksdb/chunks.js";
import {
  contentToText,
  messageKey,
  serializeMessage,
  serializeMessages,
} from "../src/window.js";

const ROOT_REFERENCE = /root=(checkpoint-root:[a-f0-9]{64})/u;

function processExists(processId) {
  try {
    const state = execFileSync(
      "/bin/ps",
      ["-o", "stat=", "-p", String(processId)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // A killed child may remain briefly as a zombie until its launcher reaps
    // it. It is no longer running and cannot own the socket or store.
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function stopExactProcess(processId) {
  if (!Number.isSafeInteger(processId) || !processExists(processId)) return;
  try { process.kill(processId, "SIGTERM"); } catch {}
  let deadline = Date.now() + 2_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) {
    try { process.kill(processId, "SIGKILL"); } catch {}
    deadline = Date.now() + 2_000;
    while (processExists(processId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(processExists(processId), false, "the exact daemon process did not stop");
}

function openArchive({ storePath, socketPath, project }) {
  try {
    return new DaemonArchive({
      storePath,
      socketPath,
      project,
      requestTimeoutMs: 30_000,
      daemonStartTimeoutMs: 20_000,
    });
  } catch {
    assert.fail("the isolated real daemon archive did not open");
  }
}

function archiveFacade(archive, { observePut, putMode } = {}) {
  return new Proxy(archive, {
    get(target, property) {
      if (property === "put") {
        return (document, options) => {
          observePut?.(document);
          const mode = putMode?.(document);
          if (mode === "falsy") return undefined;
          if (mode === "throw") throw new Error("injected archive write failure");
          return target.put(document, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function configFor({ storePath, socketPath }) {
  return {
    rotationContextRatio: 0.65,
    hardLimitContextRatio: 0.8,
    rotationTokens: 400_000,
    rotationTokensExplicit: true,
    rotationTurns: 2,
    hardLimitTokens: 600_000,
    hardLimitTokensExplicit: true,
    retainTurns: 1,
    maxToolResultTokens: 2_000,
    maxInlineUserTokens: 1_000,
    automaticRetrieval: false,
    searchResults: 3,
    searchResultTokens: 1_500,
    maxArchiveBytes: 128 * 1_024 * 1_024,
    targetArchiveBytes: 96 * 1_024 * 1_024,
    recentDocumentProtectionDays: 3,
    minimumTurnsPerSession: 4,
    preventAutoCompaction: true,
    statusLabelAccent: false,
    archiveBackend: "rocksdb",
    rocksdbPath: storePath,
    socketPath,
    dbPath: join(storePath, "unused.db"),
    models: {},
    environmentOverrides: {},
  };
}

function buildFixtureMessages(timestamp) {
  const userSentinel = "USER_MIDDLE_SENTINEL_6B_8f4e2c";
  const toolSentinel = "TOOL_MIDDLE_SENTINEL_6B_39ad71";
  const halfUserBytes = Math.ceil(ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES / 2) + 8_192;
  const userText = `UTF-8 admission head é🙂\n${"u".repeat(halfUserBytes)}`
    + `${userSentinel}${"v".repeat(halfUserBytes)}\nUTF-8 admission tail 尾`;
  const toolText = `tool head\n${"a".repeat(32_000)}${toolSentinel}`
    + `${"b".repeat(32_000)}\ntool tail`;
  const priorUser = {
    role: "user",
    content: [{ type: "text", text: "Prior complete turn request." }],
    timestamp: timestamp - 1,
  };
  const priorAnswer = {
    role: "assistant",
    content: [{ type: "text", text: "Prior complete turn answer." }],
    timestamp,
  };
  const user = {
    role: "user",
    content: [{ type: "text", text: userText }],
    timestamp: timestamp + 1,
  };
  const toolCall = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "bounded-tool-call",
      name: "inspect_fixture",
      arguments: { mode: "exact" },
    }],
    timestamp: timestamp + 2,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "bounded-tool-call",
    toolName: "inspect_fixture",
    content: [{ type: "text", text: toolText }],
    isError: false,
    timestamp: timestamp + 3,
  };
  const firstAnswer = {
    role: "assistant",
    content: [{ type: "text", text: "The exact evidence was inspected." }],
    timestamp: timestamp + 4,
  };
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Continue with the bounded current turn." }],
    timestamp: timestamp + 5,
  };
  const currentAnswer = {
    role: "assistant",
    content: [{ type: "text", text: "Current bounded answer." }],
    timestamp: timestamp + 6,
  };
  return {
    userSentinel,
    toolSentinel,
    priorUser,
    priorAnswer,
    user,
    toolCall,
    toolResult,
    firstAnswer,
    firstTurn: [user, toolCall, toolResult, firstAnswer],
    messages: [user, toolCall, toolResult, firstAnswer, currentUser, currentAnswer],
  };
}

function compactionPreparation(fixture) {
  return {
    firstKeptEntryId: "kept-split-entry",
    // Pi summarizes prior complete history separately from the prefix of the
    // current turn. The kept entry would follow this user/tool prefix.
    messagesToSummarize: [fixture.priorUser, fixture.priorAnswer],
    turnPrefixMessages: [fixture.user, fixture.toolCall, fixture.toolResult],
    isSplitTurn: true,
    tokensBefore: 500_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  };
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) === 0;
}

function providerOmits(messages, sentinels) {
  const rendered = JSON.stringify(messages);
  return sentinels.every((sentinel) => !rendered.includes(sentinel));
}

function mustReconstruct(archive, rootId) {
  try {
    return reconstructCheckpointSource(archive, rootId);
  } catch {
    assert.fail("a published checkpoint root did not reconstruct");
  }
}

function rejectsUnpublishedRoot(archive, rootId) {
  try {
    reconstructCheckpointSource(archive, rootId);
    return false;
  } catch (error) {
    return error instanceof Error && /publication is missing/u.test(error.message);
  }
}

function verifyRoot(archive, rootId, expectedText, expectedKeys, { multipart = false } = {}) {
  const reconstructed = mustReconstruct(archive, rootId);
  assert.ok(sameBytes(reconstructed.text, expectedText), "reconstructed UTF-8 bytes changed");
  assert.ok(
    reconstructed.root.hash === contentHash(expectedText),
    "the reconstructed source hash changed",
  );
  assert.equal(
    reconstructed.root.byteCount,
    Buffer.byteLength(expectedText, "utf8"),
    "the reconstructed source byte count changed",
  );
  assert.ok(
    sameStrings(
      reconstructed.root.sourceMessageKeys ?? [reconstructed.root.sourceKey],
      expectedKeys,
    ),
    "ordered source-message provenance changed",
  );
  if (multipart) {
    assert.ok(reconstructed.root.parts.length > 1, "the oversized source did not span parts");
  }
  return reconstructed;
}

function rootAddresses(reconstructed) {
  return [
    reconstructed.root.rootId,
    reconstructed.root.publicationId,
    ...reconstructed.root.parts.map((part) => part.id),
  ];
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

test("real daemon restart preserves oversized provider and split compaction checkpoints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-oversized-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = join(directory, "project");
  const sessionId = "oversized-restart-session";
  const model = { contextWindow: 1_000_000 };
  const config = configFor({ storePath, socketPath });
  const fixture = buildFixtureMessages(Date.now());
  const sentinels = [fixture.userSentinel, fixture.toolSentinel];
  const sourceSnapshot = Buffer.from(JSON.stringify(fixture.messages), "utf8");
  const preparation = compactionPreparation(fixture);
  let daemonArchive;
  let daemonProcessId;

  try {
    daemonArchive = openArchive({ storePath, socketPath, project });
    daemonProcessId = daemonArchive.stats().processId;
    const firstToolIds = [];
    const firstFacade = archiveFacade(daemonArchive, {
      observePut(document) {
        if (document?.kind === "tool-result" && typeof document.id === "string") {
          firstToolIds.push(document.id);
        }
      },
    });
    const firstRotations = [];
    const firstSession = new EpochWindowSession({
      archive: firstFacade,
      config,
      sessionId,
      project,
      model,
      onRotation(state) { firstRotations.push(state); },
    });

    const admissionProvider = firstSession.process([fixture.user], model);
    assert.ok(providerOmits(admissionProvider, sentinels), "admission exposed middle source text");
    const admissionMatch = contentToText(admissionProvider[0]?.content).match(ROOT_REFERENCE);
    assert.ok(admissionMatch, "the oversized provider preview omitted its root reference");
    const admissionRootId = admissionMatch[1];
    const admissionExpected = serializeMessage(fixture.user);
    assert.ok(
      Buffer.byteLength(admissionExpected, "utf8") > ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES,
      "the oversized user fixture did not exceed one checkpoint part",
    );
    const admissionRoot = verifyRoot(
      firstFacade,
      admissionRootId,
      admissionExpected,
      [messageKey(fixture.user)],
      { multipart: true },
    );
    assert.ok(
      admissionRoot.text.includes(fixture.userSentinel),
      "the exact oversized user reconstruction omitted its middle source text",
    );

    const firstProvider = firstSession.process(fixture.messages, model);
    assert.ok(providerOmits(firstProvider, sentinels), "rotated provider context exposed middle text");
    assert.equal(
      Buffer.compare(Buffer.from(JSON.stringify(fixture.messages), "utf8"), sourceSnapshot),
      0,
      "provider processing mutated persisted inputs",
    );
    assert.equal(firstRotations.length, 1, "provider rotation did not persist exactly one state");
    const firstRotationEntry = firstRotations[0]?.toc?.[0];
    assert.ok(firstRotationEntry?.id, "provider rotation omitted its exact archive root");
    const rotationExpected = serializeMessages(fixture.firstTurn);
    const rotationRoot = verifyRoot(
      firstFacade,
      firstRotationEntry.id,
      rotationExpected,
      fixture.firstTurn.map(messageKey),
      { multipart: true },
    );
    assert.ok(
      sentinels.every((sentinel) => rotationRoot.text.includes(sentinel)),
      "the exact rotated-turn reconstruction omitted middle source text",
    );
    assert.equal(firstToolIds.length, 1, "oversized tool externalization was not singular");
    const firstToolId = firstToolIds[0];
    const toolDocument = firstSession.recall(firstToolId);
    assert.ok(
      sameBytes(toolDocument?.text, contentToText(fixture.toolResult.content)),
      "the exact oversized tool result changed",
    );
    assert.ok(
      toolDocument.text.includes(fixture.toolSentinel),
      "the exact oversized tool result omitted its middle source text",
    );
    assert.ok(
      sameStrings(toolDocument?.sourceMessageKeys, [messageKey(fixture.toolResult)]),
      "tool-result source provenance changed",
    );

    const firstCompaction = firstSession.checkpointCompaction(preparation, { branchEntries: [] });
    assert.ok(firstCompaction, "split-turn checkpointing did not return a custom result");
    assert.ok(
      estimateModelVisibleTokens(firstCompaction.summary)
        <= ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
      "the compaction catalog exceeded its model-visible bound",
    );
    assert.ok(
      sentinels.every((sentinel) => !firstCompaction.summary.includes(sentinel)),
      "the compaction catalog exposed middle source text",
    );
    assert.equal(
      firstCompaction.details?.contextWindowArchive?.version,
      1,
      "the compaction details version changed",
    );
    const firstEntries = firstCompaction.details.contextWindowArchive.entries;
    assert.equal(firstEntries.length, 2, "split-turn checkpointing did not publish both spans");
    const expectedByKind = new Map([
      ["compaction-span", {
        text: serializeMessages(preparation.messagesToSummarize),
        keys: preparation.messagesToSummarize.map(messageKey),
        multipart: false,
      }],
      ["compaction-turn-prefix", {
        text: serializeMessages(preparation.turnPrefixMessages),
        keys: preparation.turnPrefixMessages.map(messageKey),
        multipart: true,
      }],
    ]);
    const compactionRoots = [];
    for (const entry of firstEntries) {
      const expected = expectedByKind.get(entry.kind);
      assert.ok(expected, "the split-turn checkpoint published an unexpected source kind");
      const reconstructed = verifyRoot(
        firstFacade,
        entry.rootId,
        expected.text,
        expected.keys,
        { multipart: expected.multipart },
      );
      assert.ok(
        entry.hash === reconstructed.root.hash
          && entry.byteCount === reconstructed.root.byteCount
          && entry.publicationId === reconstructed.root.publicationId
          && sameStrings(entry.partIds, reconstructed.root.parts.map((part) => part.id)),
        "compaction details diverged from the exact root manifest",
      );
      compactionRoots.push(reconstructed);
    }
    assert.ok(
      sentinels.every((sentinel) =>
        compactionRoots.some((root) => root.text.includes(sentinel))),
      "split-turn reconstruction omitted middle source text",
    );
    const firstRootExpectations = new Map([
      [admissionRootId, {
        text: admissionExpected,
        keys: [messageKey(fixture.user)],
        multipart: true,
      }],
      [firstRotationEntry.id, {
        text: rotationExpected,
        keys: fixture.firstTurn.map(messageKey),
        multipart: true,
      }],
      ...firstEntries.map((entry) => [entry.rootId, expectedByKind.get(entry.kind)]),
    ]);
    const firstAddresses = sortedUnique([
      ...rootAddresses(admissionRoot),
      ...rootAddresses(rotationRoot),
      ...compactionRoots.flatMap(rootAddresses),
      firstToolId,
    ]);
    const firstDocumentCount = firstFacade.count({ project, scope: "project" });
    assert.ok(firstDocumentCount > 0, "the real daemon did not persist checkpoint documents");

    firstSession.close();
    daemonArchive = undefined;
    await stopExactProcess(daemonProcessId);
    daemonProcessId = undefined;
    rmSync(socketPath, { force: true });

    daemonArchive = openArchive({ storePath, socketPath, project });
    daemonProcessId = daemonArchive.stats().processId;
    const replayToolIds = [];
    const replayFacade = archiveFacade(daemonArchive, {
      observePut(document) {
        if (document?.kind === "tool-result" && typeof document.id === "string") {
          replayToolIds.push(document.id);
        }
      },
    });
    const replayRotations = [];
    const replaySession = new EpochWindowSession({
      archive: replayFacade,
      config,
      sessionId,
      project,
      model,
      onRotation(state) { replayRotations.push(state); },
    });
    assert.equal(
      replayFacade.count({ project, scope: "project" }),
      firstDocumentCount,
      "daemon restart changed the logical document count",
    );
    for (const [rootId, expected] of firstRootExpectations) {
      verifyRoot(replayFacade, rootId, expected.text, expected.keys, {
        multipart: expected.multipart,
      });
      let recalled;
      try { recalled = replaySession.recall(rootId); } catch {
        assert.fail("session root recall failed after daemon restart");
      }
      assert.ok(sameBytes(recalled?.text, expected.text), "session root recall changed exact bytes");
      assert.ok(
        sameStrings(recalled?.sourceMessageKeys, expected.keys),
        "session root recall changed ordered provenance",
      );
    }
    const reopenedTool = replaySession.recall(firstToolId);
    assert.ok(
      sameBytes(reopenedTool?.text, contentToText(fixture.toolResult.content)),
      "tool-result recall changed after daemon restart",
    );

    const replayAdmission = replaySession.process([fixture.user], model);
    const replayAdmissionMatch = contentToText(replayAdmission[0]?.content).match(ROOT_REFERENCE);
    assert.ok(
      replayAdmissionMatch && replayAdmissionMatch[1] === admissionRootId,
      "oversized admission root identity changed on replay",
    );
    const replayProvider = replaySession.process(fixture.messages, model);
    assert.ok(providerOmits(replayProvider, sentinels), "replay provider context exposed middle text");
    assert.ok(
      contentHash(JSON.stringify(replayProvider)) === contentHash(JSON.stringify(firstProvider)),
      "provider-only rotation output changed on replay",
    );
    assert.equal(replayRotations.length, 1, "replay persisted an unexpected rotation count");
    assert.ok(
      replayRotations[0]?.toc?.[0]?.id === firstRotationEntry.id
        && sameStrings(replayRotations[0]?.toc?.[0]?.archiveIds, firstRotationEntry.archiveIds),
      "rotation checkpoint addresses changed on replay",
    );
    assert.equal(replayToolIds.length, 1, "tool-result replay did not use one stable document");
    assert.ok(replayToolIds[0] === firstToolId, "tool-result identity changed on replay");
    const replayCompaction = replaySession.checkpointCompaction(preparation, { branchEntries: [] });
    assert.ok(replayCompaction, "split-turn compaction replay did not return a result");
    assert.ok(
      replayCompaction.summary === firstCompaction.summary,
      "the bounded compaction catalog changed on replay",
    );
    const replayEntries = replayCompaction.details.contextWindowArchive.entries;
    assert.ok(
      sameStrings(
        replayEntries.flatMap((entry) => [
          entry.rootId,
          entry.publicationId,
          ...entry.partIds,
        ]),
        firstEntries.flatMap((entry) => [
          entry.rootId,
          entry.publicationId,
          ...entry.partIds,
        ]),
      ),
      "compaction publication, root, or part identities changed on replay",
    );
    const replayAddresses = sortedUnique([
      ...[...firstRootExpectations.keys()].flatMap((rootId) =>
        rootAddresses(mustReconstruct(replayFacade, rootId))),
      replayToolIds[0],
    ]);
    assert.ok(sameStrings(replayAddresses, firstAddresses), "checkpoint addresses changed after restart");
    assert.equal(
      replayFacade.count({ project, scope: "project" }),
      firstDocumentCount,
      "replay created new logical documents",
    );
    assert.equal(
      Buffer.compare(Buffer.from(JSON.stringify(fixture.messages), "utf8"), sourceSnapshot),
      0,
      "replay mutated persisted inputs",
    );

    replaySession.close();
    daemonArchive = undefined;
    await stopExactProcess(daemonProcessId);
    daemonProcessId = undefined;
    rmSync(socketPath, { force: true });
  } finally {
    try { daemonArchive?.close(); } catch {}
    await stopExactProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real daemon archive wrapper failures never expose raw input or custom compaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-failure-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = join(directory, "project");
  const model = { contextWindow: 1_000_000 };
  const config = configFor({ storePath, socketPath });
  const fixture = buildFixtureMessages(Date.now());
  const preparation = compactionPreparation(fixture);
  let daemonArchive;
  let daemonProcessId;

  try {
    daemonArchive = openArchive({ storePath, socketPath, project });
    daemonProcessId = daemonArchive.stats().processId;
    let failureMode = "none";
    const stagedRootIds = new Set();
    const rejectedPublicationIds = new Set();
    const failingFacade = archiveFacade(daemonArchive, {
      putMode(document) {
        if (failureMode === "none") return "none";
        if (document?.kind === "archive-checkpoint-root" && typeof document.id === "string") {
          stagedRootIds.add(document.id);
        }
        if (document?.kind !== "archive-checkpoint-publication") return "none";
        if (typeof document.id === "string") rejectedPublicationIds.add(document.id);
        return failureMode === "falsy-publication" ? "falsy" : "throw";
      },
    });
    const seedId = failingFacade.put({
      id: "real-daemon-failure-seed",
      sessionId: "failure-seed-session",
      project,
      kind: "manual",
      text: "bounded real-daemon seed",
      createdAt: Date.now(),
    });
    assert.ok(seedId, "the forwarding facade did not reach the real daemon");
    const baselineCount = failingFacade.count({ project, scope: "project" });

    const directSession = new EpochWindowSession({
      archive: failingFacade,
      config,
      sessionId: "direct-failure-session",
      project,
      model,
    });
    failureMode = "falsy-publication";
    assert.throws(
      () => directSession.process([fixture.user], model),
      (error) => error instanceof OversizedInputArchiveError,
      "a falsy archive result did not abort oversized processing",
    );
    failureMode = "throw-publication";
    assert.equal(
      directSession.checkpointCompaction(preparation, { branchEntries: [] }),
      undefined,
      "a throwing archive returned a custom compaction result",
    );

    const handlers = new Map();
    let abortCalls = 0;
    const notifications = [];
    await createContextEpochWindow({
      configLoader: () => config,
      archiveFactory: () => failingFacade,
    })({
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    });
    const ctx = {
      cwd: project,
      hasUI: false,
      model,
      isProjectTrusted: () => false,
      abort() { abortCalls += 1; },
      getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
      sessionManager: {
        getSessionId: () => "adapter-failure-session",
        getBranch: () => [],
      },
      ui: {
        setStatus() {},
        notify(message, level) { notifications.push({ message, level }); },
      },
    };
    handlers.get("session_start")({ reason: "new" }, ctx);
    failureMode = "falsy-publication";
    const failedProvider = handlers.get("context")({ messages: [fixture.user] }, ctx);
    assert.deepEqual(failedProvider, { messages: [] });
    assert.equal(abortCalls, 1, "the adapter did not abort after a falsy archive result");
    assert.ok(
      providerOmits(failedProvider.messages, [fixture.userSentinel]),
      "the adapter returned raw oversized source after failure",
    );
    assert.ok(
      notifications.length === 1
        && !notifications[0].message.includes(fixture.userSentinel)
        && notifications[0].message.length <= 120,
      "the failure notification exposed source or unbounded error text",
    );

    failureMode = "throw-publication";
    const beforeCompact = handlers.get("session_before_compact")({
      type: "session_before_compact",
      preparation,
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    }, ctx);
    assert.deepEqual(beforeCompact, { cancel: true });
    assert.equal("compaction" in beforeCompact, false, "failure returned custom compaction");
    assert.ok(
      stagedRootIds.size >= 4,
      "the fault wrapper did not forward staged roots to real RocksDB",
    );
    assert.ok(
      [...stagedRootIds].every((rootId) =>
        failingFacade.get(rootId)?.kind === "archive-checkpoint-root"),
      "a staged root was not readable from real RocksDB",
    );
    assert.ok(
      rejectedPublicationIds.size >= 4
        && [...rejectedPublicationIds].every((publicationId) =>
          failingFacade.get(publicationId) === undefined),
      "a rejected checkpoint publication became readable",
    );
    assert.ok(
      [...stagedRootIds].every((rootId) => rejectsUnpublishedRoot(failingFacade, rootId)),
      "a staged root became usable without its complete publication",
    );
    assert.ok(
      failingFacade.count({ project, scope: "project" }) > baselineCount,
      "real RocksDB did not retain the intentionally staged failure records",
    );

    handlers.get("session_shutdown")({}, ctx);
    daemonArchive = undefined;
    await stopExactProcess(daemonProcessId);
    daemonProcessId = undefined;
    rmSync(socketPath, { force: true });
  } finally {
    try { daemonArchive?.close(); } catch {}
    await stopExactProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
