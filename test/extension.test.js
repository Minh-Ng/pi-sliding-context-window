import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import contextEpochWindow, { createContextEpochWindow } from "../extensions/pi.ts";
import {
  ARCHIVE_GATHER_TURN_GUIDANCE,
  EVIDENCE_ROUTING_GUIDELINES,
  GATHER_TOOL_DESCRIPTION,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_SCOPE_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SUPERSEDE_TOOL_DESCRIPTION,
  TRAVERSE_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { Archive } from "../src/archive.js";
import { loadConfig } from "../src/config.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { EpochWindowSession, ROTATION_STATE_ENTRY } from "../src/epoch-window.js";
import { StoreClient } from "../src/store-client.js";
import { messageKey } from "../src/window.js";

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(processId) {
  if (!processId || !processExists(processId)) return;
  process.kill(processId, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) {
    process.kill(processId, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopDaemonAt(socketPath, project) {
  const client = new StoreClient({ socketPath, project, requestTimeoutMs: 5_000 });
  let processId;
  try {
    processId = (await client.request("daemon.status", {})).processId;
  } catch {} finally {
    client.close();
  }
  await stopProcess(processId);
  rmSync(socketPath, { force: true });
}

test("archive tools advertise evidence-source routing", async () => {
  const tools = new Map();
  await contextEpochWindow({
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });

  const gather = tools.get("context_window_gather");
  const search = tools.get("context_window_search");
  const recall = tools.get("context_recall");
  const traverse = tools.get("context_window_traverse");
  const supersede = tools.get("context_window_supersede");
  assert.ok(gather);
  assert.ok(search);
  assert.ok(recall);
  assert.ok(traverse);
  assert.ok(supersede);
  assert.equal(tools.has("context_window_recall"), false);

  assert.equal(gather.description, GATHER_TOOL_DESCRIPTION);
  assert.equal(search.description, SEARCH_TOOL_DESCRIPTION);
  assert.equal(search.parameters.properties.scope.description, SEARCH_SCOPE_DESCRIPTION);
  assert.match(search.parameters.properties.scope.description, /all.*does not bypass project authorization/i);
  assert.equal(recall.description, RECALL_TOOL_DESCRIPTION);
  assert.equal(traverse.description, TRAVERSE_TOOL_DESCRIPTION);
  assert.equal(supersede.description, SUPERSEDE_TOOL_DESCRIPTION);
  assert.deepEqual(gather.promptGuidelines, EVIDENCE_ROUTING_GUIDELINES);
  assert.deepEqual(search.promptGuidelines, EVIDENCE_ROUTING_GUIDELINES);
  assert.equal(search.promptSnippet, undefined);
  assert.equal(recall.promptGuidelines, undefined);

  for (const guideline of search.promptGuidelines) {
    assert.match(
      guideline,
      /context_window_search|context_window_traverse|context_recall|context_window_supersede|AGENTS\.md/,
      `unattributed flattened guideline: ${guideline}`,
    );
  }
  assert.equal(new Set(search.promptGuidelines).size, search.promptGuidelines.length);
  assert.match(search.promptGuidelines.join("\n"), /exact original wording or source evidence/);
  assert.match(search.promptGuidelines.join("\n"), /current files.*runtime behavior.*configuration.*tests.*task status/);
  assert.match(search.promptGuidelines.join("\n"), /historical framing.*invitation to search history.*exclusively current question/);
  assert.match(search.promptGuidelines.join("\n"), /mixed questions.*archived intent first.*inspect live state.*reconcile conflicts/);
  assert.match(search.promptGuidelines.join("\n"), /already in recent context.*avoid speculative broad archive searches/);
  assert.match(search.description, /conceptually phrased historical question.*3–8 concise likely synonyms or domain terms/);
  assert.match(search.promptGuidelines.join("\n"), /exact file names.*symbols.*error strings.*commits.*PRs.*specific values.*verbatim first/);
  assert.match(search.promptGuidelines.join("\n"), /conceptual archive-required search misses.*at most one reformulated context_window_search/);
  assert.match(search.description, /plausible result.*context_recall.*before issuing more query variants/i);
  assert.match(search.promptGuidelines.join("\n"), /distinct short result id.*avoid parallel query variants.*preserve every concrete recalled entity/i);
  assert.match(recall.description, /preserve the concrete user-specific entities/i);
  assert.match(traverse.description, /bounded chronological page.*unknown.*do not guess answer-specific terms/i);
  assert.equal("limit" in traverse.parameters.properties, false);
});

test("per-turn gather guidance is fixed, tool-aware, and limited to state or workflow prompts", async () => {
  const handlers = new Map();
  await contextEpochWindow({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  const before = handlers.get("before_agent_start");
  assert.ok(before);
  const base = "BASE SYSTEM\n\nUSER APPEND MUST REMAIN";
  const options = { selectedTools: ["context_window_gather"], appendSystemPrompt: "USER APPEND MUST REMAIN" };

  assert.equal(before({
    prompt: "Quote the exact earlier sentence.",
    systemPrompt: base,
    systemPromptOptions: options,
  }), undefined);
  assert.equal(before({
    prompt: "Use the same procedure as we did before.",
    systemPrompt: base,
    systemPromptOptions: { ...options, selectedTools: ["context_window_search"] },
  }), undefined);

  const uniqueRawText = "Use the same procedure as we did before. RAW_SECRET_92741";
  const result = before({
    prompt: uniqueRawText,
    systemPrompt: base,
    systemPromptOptions: options,
  });
  assert.ok(result.systemPrompt.startsWith(base));
  assert.match(result.systemPrompt, new RegExp(ARCHIVE_GATHER_TURN_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(result.systemPrompt, /RAW_SECRET_92741/u);
  assert.equal(result.systemPrompt.match(/USER APPEND MUST REMAIN/gu)?.length, 1);
});

test("custom archive factories can replace the SQLite backend", async () => {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  let openedPath;
  let openedOptions;
  let closed = false;
  let daemonRestarts = 0;
  const tools = new Map();
  const sourceKeys = Array.from({ length: 200 }, (_, index) =>
    `user:${index}::${"long-source-key".repeat(12)}`,
  );
  const longLocatorA = `cw1.${"a".repeat(560)}.signature-a`;
  const longLocatorB = `cw1.${"a".repeat(559)}b.signature-b`;
  const priorLocatorA = `cw1.${"p".repeat(560)}.prior-a`;
  const priorLocatorB = `cw1.${"q".repeat(560)}.prior-b`;
  const recalledDocument = {
    id: "recall-id",
    sessionId: "custom",
    project: "/project",
    kind: "turn",
    createdAt: 42,
    text: "deterministic archived text that must remain model-visible",
    metadata: {
      sourceMessageKeys: sourceKeys,
      sourceFirstKey: sourceKeys[0],
      sourceLastKey: sourceKeys.at(-1),
      sourceMessageCount: sourceKeys.length,
    },
  };
  const archive = {
    put() {},
    search(query) {
      const result = (id) => ({
        ...recalledDocument,
        id,
        documentId: "stable-document",
        version: 1,
        snippet: recalledDocument.text,
      });
      if (query === "first locator") return [result(longLocatorA)];
      if (query === "second locator") return [result(longLocatorB)];
      if (query === "current locator") return [result(longLocatorA)];
      return [];
    },
    get(id) {
      return [recalledDocument.id, longLocatorA, longLocatorB, priorLocatorA, priorLocatorB].includes(id)
        ? recalledDocument
        : undefined;
    },
    traverseDetailed(id) {
      if (id === priorLocatorB) {
        return {
          mode: "chronological",
          status: "not-found",
          direction: "before",
          scanned: 2,
          truncated: false,
          hasMore: false,
          results: [],
          candidates: [],
        };
      }
      return {
        mode: "chronological",
        status: "resolved",
        direction: "before",
        scanned: 200,
        truncated: false,
        hasMore: true,
        results: [
          { ...recalledDocument, id: priorLocatorA, documentId: "prior-a", version: 1, snippet: "nearer prior event" },
          { ...recalledDocument, id: priorLocatorB, documentId: "prior-b", version: 1, snippet: "older prior event" },
        ],
        candidates: [],
      };
    },
    count() { return 0; },
    daemonStatus() {
      return {
        processId: 41,
        runtimeVersion: "context-windowd:test",
        expectedRuntimeVersion: "context-windowd:test",
        runtimeMatches: true,
        clientConnections: 2,
        activeRequests: 0,
      };
    },
    restartDaemon() {
      daemonRestarts += 1;
      return {
        previousProcessId: 41,
        processId: 42,
        runtimeVersion: "context-windowd:test",
        graceful: true,
        forced: false,
      };
    },
    close() { closed = true; },
  };
  const extension = createContextEpochWindow({
    configLoader: () => ({
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.8,
      rotationTokens: 96_000,
      rotationTokensExplicit: false,
      rotationTurns: 20,
      hardLimitTokens: 128_000,
      hardLimitTokensExplicit: false,
      retainTurns: 5,
      maxToolResultTokens: 4_000,
      searchResults: 3,
      searchResultTokens: 1_500,
      maxArchiveBytes: 10_000,
      targetArchiveBytes: 7_500,
      recentDocumentProtectionDays: 3,
      minimumTurnsPerSession: 4,
      preventAutoCompaction: true,
      statusLabelAccent: false,
      dbPath: "/virtual/archive",
      models: {},
      environmentOverrides: {},
    }),
    archiveFactory: (path, options) => {
      openedPath = path;
      openedOptions = options;
      return archive;
    },
  });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry() {},
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "custom", getBranch: () => [] },
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };

  handlers.get("session_start")({}, ctx);
  assert.equal(openedPath, "/virtual/archive");
  assert.deepEqual(openedOptions, {
    retention: {
      maxBytes: 10_000,
      targetBytes: 7_500,
      recentProtectionMs: 3 * 24 * 60 * 60 * 1_000,
      minimumTurnsPerSession: 4,
    },
  });

  const completeWindow = commands.get("window").getArgumentCompletions;
  assert.ok(completeWindow("").some(({ value }) => value === "daemon status"));
  assert.deepEqual(
    completeWindow("daemon r").map(({ value }) => value),
    ["daemon restart --force"],
  );
  assert.deepEqual(
    completeWindow("archive redact session ").map(({ value }) => value),
    ["archive redact session confirm custom"],
  );
  assert.deepEqual(
    completeWindow("archive redact project ").map(({ value }) => value),
    ["archive redact project confirm project"],
  );
  assert.equal(completeWindow("not-a-command"), null);

  const recalled = await tools.get("context_recall").execute("call", { id: "recall-id" });
  assert.equal(recalled.details.found, true);
  assert.deepEqual(recalled.details.provenance.sourceMessages, {
    status: "available",
    keys: sourceKeys,
    firstKey: sourceKeys[0],
    lastKey: sourceKeys.at(-1),
    count: sourceKeys.length,
  });
  assert.ok(recalled.content[0].text.length <= 1_500 * 2 * 4);
  assert.match(recalled.content[0].text, /deterministic archived text that must remain model-visible/);
  assert.equal(recalled.content[0].text.includes(sourceKeys[100]), false);
  const missing = await tools.get("context_recall").execute("call", { id: "missing" });
  assert.deepEqual(missing.details, { found: false, provenance: null });

  const firstSearch = await tools.get("context_window_search").execute("call", {
    query: "first locator",
  });
  const secondSearch = await tools.get("context_window_search").execute("call", {
    query: "second locator",
  });
  const currentSearch = await tools.get("context_window_search").execute("call", {
    query: "current locator",
  });
  assert.deepEqual(firstSearch.details.ids, ["r1"]);
  assert.deepEqual(secondSearch.details.ids, ["r1"]);
  assert.deepEqual(currentSearch.details.ids, ["r1"]);
  assert.match(firstSearch.content[0].text, /"recallId":"r1"/u);
  assert.match(secondSearch.content[0].text, /"recallId":"r1"/u);
  assert.equal(firstSearch.content[0].text.includes(longLocatorA), false);
  assert.equal(secondSearch.content[0].text.includes(longLocatorB), false);
  assert.match(currentSearch.content[0].text, /Time-sensitive archive query/);
  assert.match(currentSearch.content[0].text, /"sourceTimestamp":"1970-01-01T00:00:00.042Z"/);
  const handledRecall = await tools.get("context_recall").execute("call", { id: "r1" });
  assert.equal(handledRecall.details.found, true);
  assert.match(handledRecall.content[0].text, /deterministic archived text/u);

  const traversal = await tools.get("context_window_traverse").execute("call", {
    id: "stable-document",
    direction: "before",
  });
  assert.equal(traversal.details.hasMore, true);
  assert.equal(traversal.details.continuationId, "r3");
  const blockedSearch = await tools.get("context_window_search").execute("call", { query: "must wait" });
  assert.equal(blockedSearch.details.blocked, true);
  assert.equal(blockedSearch.details.continuationId, "r3");
  const blockedRecall = await tools.get("context_recall").execute("call", { id: "r1" });
  assert.equal(blockedRecall.details.blocked, true);
  assert.equal(blockedRecall.details.continuationId, "r3");
  const exhausted = await tools.get("context_window_traverse").execute("call", {
    id: "r3",
    direction: "before",
  });
  assert.equal(exhausted.details.hasMore, false);

  const structural = await tools.get("context_window_search").execute("call", {
    relation: "latest-question",
  });
  assert.equal(structural.details.mode, "structural");
  assert.equal(structural.details.status, "not-found");
  assert.equal(structural.details.relation, "latest-question");
  assert.match(structural.content[0].text, /Structural retrieval: latest-question — not-found/);
  await assert.rejects(
    tools.get("context_window_search").execute("call", {}),
    /requires query or relation/,
  );

  await commands.get("window").handler("recall why", ctx);
  await commands.get("window").handler("daemon status", ctx);
  await commands.get("window").handler("daemon restart", ctx);
  await commands.get("window").handler("daemon restart --force", ctx);
  await commands.get("window").handler("archive status", ctx);
  await commands.get("window").handler("archive prune", ctx);
  await commands.get("window").handler("archive reclaim", ctx);
  assert.deepEqual(notifications[0], {
    message: "No automatic retrieval decision has been observed in this process.",
    level: "info",
  });
  assert.match(notifications[1].message, /context-windowd pid 41/u);
  assert.match(notifications[2].message, /Confirm with/u);
  assert.match(notifications[3].message, /Restarted context-windowd 41 -> 42 \(graceful\)/u);
  assert.match(notifications[4].message, /metrics are unavailable/u);
  assert.deepEqual(notifications.slice(5), [
    { message: "Archive cleanup is unavailable for this backend.", level: "warning" },
    { message: "Archive reclamation is unavailable for this backend.", level: "warning" },
  ]);
  assert.equal(daemonRestarts, 1);

  handlers.get("session_start")({ reason: "new" }, ctx);
  const staleHandle = await tools.get("context_recall").execute("call", { id: "r1" });
  assert.equal(staleHandle.details.found, false);

  handlers.get("session_shutdown")({}, ctx);
  assert.equal(closed, true);
});

test("/window settings persists and applies turn and token caps from its TUI", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-settings-tui-"));
  const previousHome = process.env.HOME;
  process.env.HOME = directory;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  });
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = [];
  let panel;
  const extension = createContextEpochWindow({
    configLoader: ({ cwd, projectTrusted }) => loadConfig({
      cwd,
      projectTrusted,
      env: {},
      home: directory,
    }),
    // A stale hot-reload generation may supply a missing/non-callable optional
    // dependency. Production persistence must still fall back to its real saver.
    configSaver: null,
    archiveFactory: () => memoryCheckpointArchive(),
  });
  await extension({
    events: { emit() {} },
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry() {},
  });
  const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { initTheme } = await import(
    new URL("./modes/interactive/theme/theme.js", codingAgentEntry).href
  );
  initTheme("dark");
  const ctx = {
    cwd: directory,
    hasUI: true,
    mode: "tui",
    model: { contextWindow: 200_000 },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "settings", getBranch: () => [] },
    ui: {
      theme: {
        fg(_color, text) { return text; },
        bold(text) { return text; },
      },
      setStatus(_key, value) { statuses.push(value); },
      notify(message, level) { notifications.push({ message, level }); },
      async custom(factory) {
        panel = factory(
          { requestRender() {} },
          this.theme,
          {},
          () => {},
        );
      },
    },
  };

  handlers.get("session_start")({}, ctx);
  assert.equal(commands.has("context-window"), false);
  assert.ok(commands.get("window").getArgumentCompletions("set")
    .some(({ value }) => value === "settings"));
  await commands.get("window").handler("settings", ctx);
  const initialLines = panel.render(100).map(stripVTControlCharacters);
  assert.equal(initialLines[0], "─".repeat(100));
  assert.equal(initialLines.at(-1), "─".repeat(100));
  const initial = initialLines.join("\n");
  assert.match(initial, /Context Window Settings/);
  assert.match(initial, /Turn cap\s+20/);
  assert.match(initial, /Context cap\s+adaptive/);

  panel.handleInput("\r");
  const settingsPath = join(directory, ".pi", "agent", "settings.json");
  let persisted = JSON.parse(readFileSync(settingsPath, "utf8"))["context-window"];
  assert.equal(persisted.rotationTurns, 30);
  assert.match(notifications.at(-1).message, /effective 30 turns \/ 130k tokens/);
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  persisted = JSON.parse(readFileSync(settingsPath, "utf8"))["context-window"];
  assert.equal(persisted.rotationTokens, 64_000);
  assert.match(notifications.at(-1).message, /effective 30 turns \/ 64k tokens/);
  assert.match(String(statuses.at(-1)), /30 turns/);

  handlers.get("session_shutdown")({}, ctx);
});

test("Pi defaults to project-bound RocksDB search, locator recall, and protection leases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-extension-rocks-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const handlers = new Map();
  const tools = new Map();
  let daemonProcessId;
  let started = false;
  const extension = createContextEpochWindow({
    configLoader: () => loadConfig({
      cwd: directory,
      home: directory,
      projectTrusted: false,
      env: {
        CONTEXT_WINDOW_ROCKSDB: storePath,
        CONTEXT_WINDOW_SOCKET: socketPath,
        CONTEXT_WINDOW_ROTATION_TOKENS: "100000",
        CONTEXT_WINDOW_ROTATION_TURNS: "3",
        CONTEXT_WINDOW_HARD_LIMIT_TOKENS: "120000",
        CONTEXT_WINDOW_RETAIN_TURNS: "1",
        CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL: "false",
        CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS: "0",
        CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION: "0",
      },
    }),
  });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: directory,
    hasUI: false,
    model: { contextWindow: 200_000 },
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "rocks-extension-session",
      getBranch: () => [],
    },
    ui: { setStatus() {} },
  };
  const messages = [
    { role: "user", content: [{ type: "text", text: "PI_ROCKS_LOCATOR_TOKEN exact first question" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Exact first archived answer" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Second question" }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Second answer" }], timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "Current answer" }], timestamp: 6 },
  ];

  try {
    handlers.get("session_start")({}, ctx);
    started = true;
    handlers.get("context")({ messages }, ctx);

    const search = await tools.get("context_window_search").execute("call", {
      query: "PI_ROCKS_LOCATOR_TOKEN",
      scope: "session",
      limit: 3,
    });
    assert.equal(search.details.count, 1);
    assert.equal(search.details.ids[0], "r1");
    assert.match(search.content[0].text, /"recallId":"r1"/u);
    assert.doesNotMatch(search.content[0].text, /cw1\./u);
    assert.match(search.content[0].text, /PI_ROCKS_LOCATOR_TOKEN/u);

    const recall = await tools.get("context_recall").execute("call", {
      id: search.details.ids[0],
    });
    assert.equal(recall.details.found, true);
    assert.match(recall.content[0].text, /PI_ROCKS_LOCATOR_TOKEN exact first question/u);
    assert.match(recall.content[0].text, /ARCHIVED HISTORICAL EVIDENCE/u);
    const recallLines = recall.content[0].text.split("\n");
    assert.equal(recallLines.length, 2);
    const recallEnvelope = JSON.parse(recallLines[1]);
    assert.equal(recallEnvelope.trust, "untrusted-archived-data");
    assert.match(JSON.parse(recallEnvelope.bodyJson), /PI_ROCKS_LOCATOR_TOKEN/u);

    const traversal = await tools.get("context_window_traverse").execute("call", {
      id: search.details.ids[0],
      direction: "after",
      scope: "session",
    });
    assert.equal(traversal.details.status, "resolved");
    assert.ok(traversal.details.count >= 1);
    assert.match(traversal.content[0].text, /Chronological traversal: after/u);
    assert.doesNotMatch(traversal.content[0].text, /cw1\./u);

    // The normal post-run hook refreshes the active-context protection lease.
    handlers.get("agent_settled")({}, ctx);
    const rightProject = new StoreClient({ socketPath, project: directory, requestTimeoutMs: 5_000 });
    const wrongProject = new StoreClient({
      socketPath,
      project: join(directory, "other-project"),
      requestTimeoutMs: 5_000,
    });
    try {
      assert.ok((await rightProject.request("store.count", { scope: "project" })).count >= 1);
      assert.equal((await wrongProject.request("store.count", { scope: "project" })).count, 0);
      const status = await rightProject.request("daemon.status", {});
      assert.ok(status.retention.leases >= 1);
      daemonProcessId = status.processId;
    } finally {
      rightProject.close();
      wrongProject.close();
    }
  } finally {
    if (!daemonProcessId) {
      const client = new StoreClient({ socketPath, project: directory, requestTimeoutMs: 2_000 });
      try { daemonProcessId = (await client.request("daemon.status", {})).processId; } catch {}
      finally { client.close(); }
    }
    if (started) handlers.get("session_shutdown")({}, ctx);
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi context_window_archive tool admits a subjectKey and requires supersedes to replace its live document", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-extension-subject-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const handlers = new Map();
  const tools = new Map();
  let daemonProcessId;
  let started = false;
  const extension = createContextEpochWindow({
    configLoader: () => loadConfig({
      cwd: directory,
      home: directory,
      projectTrusted: false,
      env: {
        CONTEXT_WINDOW_ROCKSDB: storePath,
        CONTEXT_WINDOW_SOCKET: socketPath,
        CONTEXT_WINDOW_ROTATION_TOKENS: "100000",
        CONTEXT_WINDOW_ROTATION_TURNS: "3",
        CONTEXT_WINDOW_HARD_LIMIT_TOKENS: "120000",
        CONTEXT_WINDOW_RETAIN_TURNS: "1",
        CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL: "false",
        CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS: "0",
        CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION: "0",
      },
    }),
  });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: directory,
    hasUI: false,
    model: { contextWindow: 200_000 },
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "rocks-extension-subject-session",
      getBranch: () => [],
    },
    ui: { setStatus() {} },
  };

  try {
    handlers.get("session_start")({}, ctx);
    started = true;

    const archiveTool = tools.get("context_window_archive");
    assert.ok(archiveTool);
    assert.deepEqual(archiveTool.promptGuidelines, EVIDENCE_ROUTING_GUIDELINES);

    const first = await archiveTool.execute("call", {
      text: "The team settled on port 8443 for the admin console.",
      kind: "decision",
      subjectKey: "decision:admin-console-port",
    });
    assert.ok(first.details.id);

    await assert.rejects(
      archiveTool.execute("call", {
        text: "The team settled on port 9443 for the admin console.",
        kind: "decision",
        subjectKey: "decision:admin-console-port",
      }),
      /subjectKey.*is live at/u,
    );

    const superseding = await archiveTool.execute("call", {
      text: "The team settled on port 9443 for the admin console.",
      kind: "decision",
      subjectKey: "decision:admin-console-port",
      supersedes: { documentId: first.details.id, version: 1 },
    });
    assert.ok(superseding.details.id);

    const search = await tools.get("context_window_search").execute("call", {
      query: "admin console port",
      scope: "project",
      limit: 3,
    });
    assert.match(search.content[0].text, /9443/u);
    assert.doesNotMatch(search.content[0].text, /8443/u);
  } finally {
    if (!daemonProcessId) {
      const client = new StoreClient({ socketPath, project: directory, requestTimeoutMs: 2_000 });
      try { daemonProcessId = (await client.request("daemon.status", {})).processId; } catch {}
      finally { client.close(); }
    }
    if (started) handlers.get("session_shutdown")({}, ctx);
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relation search recovers the latest archived question from a rotated Pi session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-extension-"));
  const handlers = new Map();
  const tools = new Map();
  const config = {
    rotationTokens: 100_000,
    rotationTokensExplicit: true,
    rotationTurns: 3,
    hardLimitTokens: 120_000,
    hardLimitTokensExplicit: true,
    retainTurns: 1,
    maxToolResultTokens: 4_000,
    searchResults: 3,
    searchResultTokens: 1_500,
    maxArchiveBytes: 10_000_000,
    targetArchiveBytes: 7_500_000,
    recentDocumentProtectionDays: 0,
    minimumTurnsPerSession: 0,
    preventAutoCompaction: true,
    statusLabelAccent: false,
    archiveBackend: "sqlite",
    dbPath: join(directory, "archive.db"),
    models: {},
    environmentOverrides: {},
  };
  const extension = createContextEpochWindow({ configLoader: () => config });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: directory,
    hasUI: false,
    model: { contextWindow: 200_000 },
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "structural-extension-session",
      getBranch: () => [],
    },
    ui: { setStatus() {} },
  };
  const messages = [
    { role: "user", content: [{ type: "text", text: "Why did the worker restart?" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "First answer" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Were liveserving workloads scaled up?" }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Second answer" }], timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "Current answer" }], timestamp: 6 },
  ];

  try {
    handlers.get("session_start")({}, ctx);
    handlers.get("context")({ messages }, ctx);
    const result = await tools.get("context_window_search").execute("call", {
      relation: "latest-question",
    });
    assert.equal(result.details.mode, "structural");
    assert.equal(result.details.status, "resolved");
    assert.equal(result.details.relation, "latest-question");
    assert.match(result.content[0].text, /Were liveserving workloads scaled up\?/);
    assert.equal(result.details.candidates[0].relationConfidence, 100);
  } finally {
    handlers.get("session_shutdown")({}, ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pre-rotation fork searches externalized tool results across header lineage only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-fork-lineage-"));
  const dbPath = join(directory, "archive.db");
  const grandparentFile = join(directory, "grandparent.jsonl");
  const parentFile = join(directory, "parent.jsonl");
  const childFile = join(directory, "child.jsonl");
  const config = {
    rotationTokens: 100_000,
    rotationTurns: 20,
    hardLimitTokens: 120_000,
    retainTurns: 5,
    maxToolResultTokens: 10,
    searchResults: 10,
    searchResultTokens: 1_500,
    preventAutoCompaction: true,
    statusLabelAccent: false,
    archiveBackend: "sqlite",
    dbPath,
  };

  try {
    const sessionMetadata = {
      type: "session",
      version: 3,
      timestamp: "2026-01-02T03:04:05.000Z",
      cwd: directory,
    };
    writeFileSync(grandparentFile, `${JSON.stringify({
      ...sessionMetadata, id: "grandparent-id",
    })}\n`);
    writeFileSync(parentFile, `${JSON.stringify({
      ...sessionMetadata, id: "parent-id", parentSession: grandparentFile,
    })}\n`);
    writeFileSync(childFile, `${JSON.stringify({
      ...sessionMetadata, id: "child-id", parentSession: parentFile,
    })}\n`);

    const parent = new EpochWindowSession({
      archive: new Archive(dbPath), config, sessionId: "parent-id", project: directory,
    });
    parent.process([{
      role: "toolResult",
      toolCallId: "parent-call",
      toolName: "bash",
      content: [{ type: "text", text: `inherited-tool-evidence ${"x".repeat(200)}` }],
      timestamp: 1,
    }]);
    parent.close();

    const seed = new Archive(dbPath);
    seed.put({
      id: "unrelated-doc",
      sessionId: "unrelated-id",
      project: directory,
      kind: "tool-result",
      text: "inherited-tool-evidence from an unrelated session",
    });
    seed.close();

    const handlers = new Map();
    const tools = new Map();
    const extension = createContextEpochWindow({ configLoader: () => config });
    await extension({
      on(name, handler) { handlers.set(name, handler); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand() {},
      appendEntry() {},
    });
    let activeSessionFile = childFile;
    const ctx = {
      cwd: directory,
      hasUI: false,
      model: { contextWindow: 100_000 },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "child-id",
        getSessionFile: () => activeSessionFile,
        getBranch: () => [],
      },
      ui: { setStatus() {} },
    };
    handlers.get("session_start")({ reason: "fork", previousSessionFile: parentFile }, ctx);

    const sessionResult = await tools.get("context_window_search").execute("call", {
      query: "inherited tool evidence",
      scope: "session",
      limit: 10,
    });
    assert.equal(sessionResult.details.count, 1);
    assert.equal(sessionResult.details.ids.includes("unrelated-doc"), false);
    assert.match(sessionResult.content[0].text, /\[inherited\]-\[tool\]-\[evidence\]/);

    const projectResult = await tools.get("context_window_search").execute("call", {
      query: "inherited tool evidence",
      scope: "project",
      limit: 10,
    });
    assert.equal(projectResult.details.count, 2);
    assert.match(projectResult.content[0].text, /unrelated session/u);

    // Pi may still report the parent file during the earliest fork callback.
    activeSessionFile = parentFile;
    handlers.get("session_start")({ reason: "fork", previousSessionFile: parentFile }, ctx);
    const fallbackResult = await tools.get("context_window_search").execute("call", {
      query: "inherited tool evidence",
      scope: "session",
      limit: 10,
    });
    assert.equal(fallbackResult.details.count, 1);
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function compactionConfig(overrides = {}) {
  return {
    rotationContextRatio: 0.65,
    hardLimitContextRatio: 0.8,
    rotationTokens: 96_000,
    rotationTokensExplicit: false,
    rotationTurns: 20,
    hardLimitTokens: 128_000,
    hardLimitTokensExplicit: false,
    retainTurns: 5,
    maxToolResultTokens: 4_000,
    maxInlineUserTokens: 16_000,
    automaticRetrieval: false,
    searchResults: 3,
    searchResultTokens: 1_500,
    maxArchiveBytes: 10_000_000,
    targetArchiveBytes: 7_500_000,
    recentDocumentProtectionDays: 3,
    minimumTurnsPerSession: 4,
    preventAutoCompaction: true,
    statusLabelAccent: false,
    archiveBackend: "sqlite",
    dbPath: "/virtual/archive",
    models: {},
    environmentOverrides: {},
    ...overrides,
  };
}

function memoryCheckpointArchive() {
  const documents = new Map();
  const puts = [];
  return {
    documents,
    puts,
    put(document) {
      const stored = document.id
        ? document
        : { ...document, id: `memory-document-${puts.length + 1}` };
      puts.push(stored);
      documents.set(stored.id, stored);
      return stored.id;
    },
    search() { return []; },
    get(id) { return documents.get(id); },
    count() { return documents.size; },
    setProtectedContext() {},
    prune() {},
    close() {},
  };
}

function compactionPreparation({
  firstKeptEntryId = "kept-entry",
  messagesToSummarize = [{
    role: "user",
    content: [{ type: "text", text: "exact source for compaction" }],
    timestamp: 10,
  }],
  turnPrefixMessages = [],
  isSplitTurn = false,
  tokensBefore = 70_000,
  reserveTokens = 16_384,
  previousSummary,
} = {}) {
  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens, keepRecentTokens: 20_000 },
  };
}

function compactionEvent(reason, preparation, branchEntries = []) {
  return {
    type: "session_before_compact",
    preparation,
    branchEntries,
    reason,
    willRetry: reason === "overflow",
    signal: new AbortController().signal,
  };
}

test("startup archive failure closes its backend and fails closed for oversized context", async () => {
  const handlers = new Map();
  const notifications = [];
  const startupSecret = "STARTUP_ARCHIVE_SECRET_MUST_NOT_ESCAPE";
  let closeCalls = 0;
  const archive = {
    setProtectedContext() { throw new Error(startupSecret); },
    close() { closeCalls += 1; },
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig({ maxInlineUserTokens: 1_000 }),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() { abortCalls += 1; },
    sessionManager: { getSessionId: () => "startup-failure", getBranch: () => [] },
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };

  assert.throws(
    () => handlers.get("session_start")({ reason: "new" }, ctx),
    new RegExp(startupSecret),
  );
  assert.equal(closeCalls, 1);

  const middleSentinel = "STARTUP_OVERSIZED_MIDDLE_MUST_NOT_ESCAPE";
  const original = [{
    role: "user",
    content: `${"head ".repeat(2_000)}${middleSentinel}${" tail".repeat(2_000)}`,
    timestamp: 1,
  }];
  const snapshot = structuredClone(original);
  const result = handlers.get("context")({ messages: original }, ctx);

  assert.deepEqual(result, { messages: [] });
  assert.deepEqual(original, snapshot);
  assert.equal(abortCalls, 1);
  assert.deepEqual(notifications, [{
    message: "Context preparation failed. The turn was aborted before provider submission.",
    level: "error",
  }]);
  assert.equal(JSON.stringify({ result, notifications }).includes(middleSentinel), false);
  assert.equal(JSON.stringify({ result, notifications }).includes(startupSecret), false);
});

test("shutdown closes the session even when clearing its UI status fails", async () => {
  const handlers = new Map();
  let closeCalls = 0;
  const archive = {
    setProtectedContext() {},
    close() { closeCalls += 1; },
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "shutdown-ui-failure", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);

  assert.throws(
    () => handlers.get("session_shutdown")({}, {
      ...ctx,
      hasUI: true,
      ui: {
        setStatus() { throw new Error("injected shutdown UI failure"); },
      },
    }),
    /injected shutdown UI failure/,
  );
  assert.equal(closeCalls, 1);

  handlers.get("session_shutdown")({}, ctx);
  assert.equal(closeCalls, 1);
});

test("a post-construction transition failure closes the new session and stays fail closed", async () => {
  const handlers = new Map();
  let archiveCalls = 0;
  let replacementCloseCalls = 0;
  const previousArchive = {
    setProtectedContext() {},
    close() { throw new Error("injected previous-session close failure"); },
  };
  const replacementArchive = {
    setProtectedContext() {},
    close() { replacementCloseCalls += 1; },
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => (archiveCalls++ === 0 ? previousArchive : replacementArchive),
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() { abortCalls += 1; },
    sessionManager: { getSessionId: () => "transition-failure", getBranch: () => [] },
    ui: { setStatus() {}, notify() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);
  assert.throws(
    () => handlers.get("session_start")({ reason: "switch" }, ctx),
    /injected previous-session close failure/u,
  );
  assert.equal(replacementCloseCalls, 1);
  assert.deepEqual(
    handlers.get("context")({ messages: [{ role: "user", content: "raw" }] }, ctx),
    { messages: [] },
  );
  assert.equal(abortCalls, 1);
});

test("a timer cleanup failure clears the previous ready session and stays fail closed", async () => {
  const handlers = new Map();
  let closeCalls = 0;
  const archive = {
    setProtectedContext() {},
    close() { closeCalls += 1; },
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() { abortCalls += 1; },
    sessionManager: { getSessionId: () => "timer-cleanup-failure", getBranch: () => [] },
    ui: { setStatus() {}, notify() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);

  const originalClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = () => { throw new Error("injected startup timer cleanup failure"); };
  try {
    assert.throws(
      () => handlers.get("session_start")({ reason: "reload" }, ctx),
      /injected startup timer cleanup failure/u,
    );
  } finally {
    globalThis.clearInterval = originalClearInterval;
  }
  assert.equal(closeCalls, 1);
  assert.deepEqual(
    handlers.get("context")({ messages: [{ role: "user", content: "raw" }] }, ctx),
    { messages: [] },
  );
  assert.equal(abortCalls, 1);
});

test("oversized archival failure aborts and cannot fail open to raw provider context", async () => {
  const handlers = new Map();
  const notifications = [];
  const backendSecret = "BACKEND_SECRET_MUST_NOT_ESCAPE";
  const middleSentinel = "OVERSIZED_MIDDLE_SENTINEL_MUST_NOT_ESCAPE";
  const archive = {
    put() { throw new Error(backendSecret); },
    search() { return []; },
    get() {},
    count() { return 0; },
    setProtectedContext() {},
    close() {},
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig({ maxInlineUserTokens: 1_000 }),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() {
      abortCalls += 1;
      throw new Error("abort transport is already closed");
    },
    sessionManager: { getSessionId: () => "oversized-failure", getBranch: () => [] },
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);
  const original = [{
    role: "user",
    content: [{
      type: "text",
      text: `${"visible head ".repeat(1_000)}${middleSentinel}${" visible tail".repeat(1_000)}`,
    }],
    timestamp: 1,
  }];
  const snapshot = structuredClone(original);
  const result = handlers.get("context")({ messages: original }, ctx);

  assert.deepEqual(result, { messages: [] });
  assert.deepEqual(original, snapshot);
  assert.equal(abortCalls, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
  assert.ok(notifications[0].message.length <= 120);
  assert.equal(JSON.stringify({ result, notifications }).includes(middleSentinel), false);
  assert.equal(JSON.stringify({ result, notifications }).includes(backendSecret), false);
  handlers.get("session_shutdown")({}, ctx);
});

test("a status failure cannot restore raw input after oversized archival succeeds", async () => {
  const handlers = new Map();
  const archive = memoryCheckpointArchive();
  await createContextEpochWindow({
    configLoader: () => compactionConfig({ maxInlineUserTokens: 1_000 }),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  let statusShouldThrow = true;
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() { abortCalls += 1; },
    sessionManager: { getSessionId: () => "oversized-status", getBranch: () => [] },
    ui: {
      setStatus() {
        if (statusShouldThrow) throw new Error("STATUS_SECRET_MUST_NOT_ESCAPE");
      },
      notify() {},
    },
  };
  assert.doesNotThrow(() => handlers.get("session_start")({ reason: "new" }, ctx));
  const middleSentinel = "STATUS_PATH_MIDDLE_SENTINEL_MUST_NOT_ESCAPE";
  const original = [{
    role: "user",
    content: [{
      type: "text",
      text: `${"bounded head ".repeat(1_000)}${middleSentinel}${" bounded tail".repeat(1_000)}`,
    }],
    timestamp: 1,
  }];
  const snapshot = structuredClone(original);
  const result = handlers.get("context")({ messages: original }, ctx);

  assert.equal(result.messages.length, 1);
  assert.equal(JSON.stringify(result).includes(middleSentinel), false);
  assert.equal(JSON.stringify([...archive.documents.values()]).includes(middleSentinel), true);
  assert.deepEqual(original, snapshot);
  assert.equal(abortCalls, 0);
  handlers.get("session_shutdown")({}, { ...ctx, hasUI: false });
});

test("a post-archive processing failure also aborts oversized provider input", async () => {
  const handlers = new Map();
  const archive = memoryCheckpointArchive();
  let protectionShouldThrow = false;
  archive.setProtectedContext = () => {
    if (protectionShouldThrow) throw new Error("PROTECTION_SECRET_MUST_NOT_ESCAPE");
  };
  await createContextEpochWindow({
    configLoader: () => compactionConfig({ maxInlineUserTokens: 1_000 }),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  const notifications = [];
  let abortCalls = 0;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    abort() { abortCalls += 1; },
    sessionManager: { getSessionId: () => "post-archive-failure", getBranch: () => [] },
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);
  protectionShouldThrow = true;
  const middleSentinel = "POST_ARCHIVE_MIDDLE_SENTINEL_MUST_NOT_ESCAPE";
  const result = handlers.get("context")({
    messages: [{
      role: "user",
      content: `${"head ".repeat(2_000)}${middleSentinel}${" tail".repeat(2_000)}`,
      timestamp: 1,
    }],
  }, ctx);

  assert.deepEqual(result, { messages: [] });
  assert.equal(abortCalls, 1);
  assert.equal(JSON.stringify({ result, notifications }).includes(middleSentinel), false);
  assert.equal(JSON.stringify({ result, notifications }).includes("PROTECTION_SECRET"), false);
  protectionShouldThrow = false;
  handlers.get("session_shutdown")({}, ctx);
});

test("threshold hook commits reserve-aware rotation before cancellation", async () => {
  const handlers = new Map();
  const appended = [];
  const archive = memoryCheckpointArchive();
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry(...args) { appended.push(args); },
  });

  let providerTokens = 250_404;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 372_000 },
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: providerTokens, contextWindow: 372_000, percent: providerTokens / 3_720 }),
    sessionManager: { getSessionId: () => "compaction-test", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);
  const visibleEpoch = Array.from({ length: 12 }, (_, index) => ({
    role: "user",
    content: [{ type: "text", text: `${index + 1}:${"x".repeat(15_000)}` }],
    timestamp: index + 1,
  }));
  handlers.get("context")({ messages: visibleEpoch }, ctx);

  const preparation = compactionPreparation({ tokensBefore: 250_404 });
  assert.deepEqual(
    handlers.get("session_before_compact")(
      compactionEvent("threshold", preparation),
      ctx,
    ),
    { cancel: true },
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1].reason, "forced");
  assert.equal(appended[0][1].rotations, 1);
  const putsAfterRotation = archive.puts.length;
  assert.ok(putsAfterRotation > 0);

  // Pi checks once after the completed response and again before the next
  // prompt. A stricter reserve may reuse the committed rotation only when its
  // provider-aware projection still fits the changed threshold.
  assert.deepEqual(
    handlers.get("session_before_compact")(
      compactionEvent("threshold", compactionPreparation({
        tokensBefore: 250_404,
        reserveTokens: 128_000,
      })),
      ctx,
    ),
    { cancel: true },
  );
  assert.equal(archive.puts.length, putsAfterRotation);
  assert.equal(appended.length, 1);

  for (const getContextUsage of [
    () => ({ tokens: null, contextWindow: 372_000, percent: null }),
    () => undefined,
    () => { throw new Error("provider usage unavailable"); },
  ]) {
    const missingProviderUsage = handlers.get("session_before_compact")(
      compactionEvent("threshold", preparation),
      { ...ctx, getContextUsage },
    );
    assert.ok(missingProviderUsage.compaction);
  }
  assert.ok(archive.puts.length > 0);

  // A materially larger repeated provider measurement invalidates the prior
  // projection and must fall back to archive-first compaction.
  providerTokens = 300_000;
  const unsafe = handlers.get("session_before_compact")(
    compactionEvent("threshold", compactionPreparation({
      tokensBefore: 250_404,
      reserveTokens: 128_000,
    })),
    ctx,
  );
  assert.ok(unsafe.compaction);
  assert.ok(archive.puts.length > 0);
  handlers.get("session_shutdown")({}, ctx);
});

test("rotation admission and persistence failures immediately use custom compaction", async () => {
  for (const failure of ["archive", "persist"]) {
    const handlers = new Map();
    const archive = memoryCheckpointArchive();
    let armed = false;
    const put = archive.put.bind(archive);
    archive.put = (document, options) => {
      if (armed && failure === "archive" && document.kind === "turn") {
        throw new Error("injected turn admission failure");
      }
      return put(document, options);
    };
    await createContextEpochWindow({
      configLoader: () => compactionConfig(),
      archiveFactory: () => archive,
    })({
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      appendEntry(_type, state) {
        if (armed && failure === "persist" && state.reason === "forced") {
          throw new Error("injected rotation persistence failure");
        }
      },
    });
    const ctx = {
      cwd: "/project",
      hasUI: false,
      model: { provider: "provider", id: "model", contextWindow: 372_000 },
      isProjectTrusted: () => false,
      getContextUsage: () => ({ tokens: 250_404, contextWindow: 372_000, percent: 67.3 }),
      sessionManager: { getSessionId: () => `rotation-${failure}`, getBranch: () => [] },
      ui: { setStatus() {} },
    };
    handlers.get("session_start")({ reason: "new" }, ctx);
    handlers.get("context")({
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: "user",
        content: [{ type: "text", text: `${index + 1}:${"x".repeat(15_000)}` }],
        timestamp: index + 1,
      })),
    }, ctx);
    armed = true;

    const result = handlers.get("session_before_compact")(
      compactionEvent("threshold", compactionPreparation({
        tokensBefore: 250_404,
        reserveTokens: 128_000,
      })),
      ctx,
    );
    assert.ok(result.compaction, failure);
    assert.equal(result.cancel, undefined, failure);
    handlers.get("session_shutdown")({}, ctx);
  }
});

test("unsafe threshold, overflow, and manual compaction return the same bounded archive catalog", async () => {
  const handlers = new Map();
  const appended = [];
  const archive = memoryCheckpointArchive();
  await createContextEpochWindow({
    configLoader: () => compactionConfig({
      rotationTokens: 65_000,
      rotationTokensExplicit: true,
      hardLimitTokens: 80_000,
      hardLimitTokensExplicit: true,
      retainTurns: 10,
    }),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry(...args) { appended.push(args); },
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 100_000 },
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: 70_000, contextWindow: 100_000, percent: 70 }),
    sessionManager: { getSessionId: () => "fallback-test", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);
  handlers.get("context")({
    messages: [{ role: "user", content: [{ type: "text", text: "small live turn" }], timestamp: 1 }],
  }, ctx);

  const middleSentinel = "COMPACTION_MIDDLE_SENTINEL_MUST_NOT_ESCAPE";
  const preparation = compactionPreparation({
    messagesToSummarize: [{
      role: "user",
      content: [{
        type: "text",
        text: `${"checkpoint head ".repeat(8_000)}${middleSentinel}${" checkpoint tail".repeat(8_000)}`,
      }],
      timestamp: 2,
    }],
  });
  const results = ["threshold", "overflow", "manual"].map((reason) =>
    handlers.get("session_before_compact")(
      compactionEvent(reason, preparation),
      ctx,
    ));

  for (const result of results) {
    assert.deepEqual(Object.keys(result), ["compaction"]);
    assert.deepEqual(
      Object.keys(result.compaction).sort(),
      ["details", "firstKeptEntryId", "summary", "tokensBefore"],
    );
    assert.deepEqual(Object.keys(result.compaction.details), ["contextWindowArchive"]);
    assert.deepEqual(
      Object.keys(result.compaction.details.contextWindowArchive).sort(),
      ["entries", "version"],
    );
    assert.equal(result.compaction.details.contextWindowArchive.version, 1);
    assert.equal(result.compaction.firstKeptEntryId, preparation.firstKeptEntryId);
    assert.equal(result.compaction.tokensBefore, preparation.tokensBefore);
    assert.ok(result.compaction.summary.length <= 4_000);
    assert.equal(JSON.stringify(result).includes(middleSentinel), false);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(JSON.stringify([...archive.documents.values()]).includes(middleSentinel), true);
  assert.equal(appended.length, 0);

  handlers.get("session_compact")({ fromExtension: true }, ctx);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], ROTATION_STATE_ENTRY);
  assert.equal(appended[0][1].boundaryKey, undefined);
  assert.deepEqual(appended[0][1].toc, []);
  handlers.get("session_shutdown")({}, ctx);
});

test("compaction admission fails closed for missing, malformed, undefined, and thrown checkpoints", async () => {
  const handlers = new Map();
  const archive = memoryCheckpointArchive();
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    sessionManager: { getSessionId: () => "fail-closed", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  const validPreparation = compactionPreparation({ tokensBefore: 90_000 });
  const validEvent = compactionEvent("manual", validPreparation);
  assert.deepEqual(handlers.get("session_before_compact")(validEvent, ctx), { cancel: true });

  handlers.get("session_start")({ reason: "new" }, ctx);
  assert.deepEqual(handlers.get("session_before_compact")(undefined, ctx), { cancel: true });
  assert.deepEqual(handlers.get("session_before_compact")({
    ...validEvent,
    preparation: { ...validPreparation, fileOps: undefined },
  }, ctx), { cancel: true });
  assert.equal(archive.puts.length, 0);

  const emptyPreparation = compactionPreparation({
    messagesToSummarize: [],
    turnPrefixMessages: [],
  });
  assert.deepEqual(
    handlers.get("session_before_compact")(
      compactionEvent("manual", emptyPreparation),
      ctx,
    ),
    { cancel: true },
  );

  const originalCheckpoint = EpochWindowSession.prototype.checkpointCompaction;
  try {
    EpochWindowSession.prototype.checkpointCompaction = function checkpointThrows() {
      throw new Error("THROWN_CHECKPOINT_SECRET");
    };
    assert.deepEqual(
      handlers.get("session_before_compact")(validEvent, ctx),
      { cancel: true },
    );

    const details = { contextWindowArchive: { version: 1, entries: [{}] } };
    EpochWindowSession.prototype.checkpointCompaction = function checkpointAddsFields() {
      return {
        summary: "bounded catalog",
        firstKeptEntryId: "kept-entry",
        tokensBefore: 90_000,
        estimatedTokensAfter: 12,
        rawPayload: "RAW_PAYLOAD_MUST_BE_DROPPED",
        details,
      };
    };
    assert.deepEqual(
      handlers.get("session_before_compact")(validEvent, ctx),
      { cancel: true },
    );

    const exactResult = {
      summary: "bounded catalog",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 90_000,
      details,
    };
    EpochWindowSession.prototype.checkpointCompaction = function checkpointIsExact() {
      return exactResult;
    };
    const projected = handlers.get("session_before_compact")(validEvent, ctx);
    assert.deepEqual(Object.keys(projected.compaction).sort(), [
      "details",
      "firstKeptEntryId",
      "summary",
      "tokensBefore",
    ]);
    assert.equal(projected.compaction, exactResult);
    assert.equal(projected.compaction.details, details);

    EpochWindowSession.prototype.checkpointCompaction = function malformedDetails() {
      return {
        summary: "untrusted catalog",
        firstKeptEntryId: "kept-entry",
        tokensBefore: 90_000,
        details: { contextWindowArchive: { version: 2, entries: [{}] } },
      };
    };
    assert.deepEqual(
      handlers.get("session_before_compact")(validEvent, ctx),
      { cancel: true },
    );
  } finally {
    EpochWindowSession.prototype.checkpointCompaction = originalCheckpoint;
  }
  handlers.get("session_shutdown")({}, ctx);
});

test("only a valid versioned prior catalog is carried into the next compaction", async () => {
  const handlers = new Map();
  const archive = memoryCheckpointArchive();
  await createContextEpochWindow({
    configLoader: () => compactionConfig(),
    archiveFactory: () => archive,
  })({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    sessionManager: { getSessionId: () => "prior-catalog", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  handlers.get("session_start")({ reason: "new" }, ctx);

  const baseline = handlers.get("session_before_compact")(
    compactionEvent("manual", compactionPreparation({
      messagesToSummarize: [{ role: "user", content: "first exact span", timestamp: 1 }],
    })),
    ctx,
  ).compaction;
  const baselineEntry = baseline.details.contextWindowArchive.entries[0];
  const priorBranchEntry = {
    type: "compaction",
    id: "prior-compaction",
    fromHook: true,
    summary: baseline.summary,
    firstKeptEntryId: baseline.firstKeptEntryId,
    tokensBefore: baseline.tokensBefore,
    details: baseline.details,
  };
  const nextPreparation = compactionPreparation({
    previousSummary: baseline.summary,
    messagesToSummarize: [{ role: "user", content: "second exact span", timestamp: 2 }],
  });
  const carried = handlers.get("session_before_compact")(
    compactionEvent("manual", nextPreparation, [priorBranchEntry]),
    ctx,
  ).compaction;
  assert.equal(
    carried.details.contextWindowArchive.entries.some((entry) => entry.rootId === baselineEntry.rootId),
    true,
  );
  assert.equal(
    carried.details.contextWindowArchive.entries.some((entry) => entry.kind === "archive-previous-summary"),
    false,
  );

  const malformedPrior = {
    ...priorBranchEntry,
    details: {
      contextWindowArchive: {
        ...priorBranchEntry.details.contextWindowArchive,
        version: 2,
      },
    },
  };
  const recovered = handlers.get("session_before_compact")(
    compactionEvent("manual", nextPreparation, [malformedPrior]),
    ctx,
  ).compaction;
  assert.equal(
    recovered.details.contextWindowArchive.entries.some((entry) => entry.rootId === baselineEntry.rootId),
    false,
  );
  assert.equal(
    recovered.details.contextWindowArchive.entries.some((entry) => entry.kind === "archive-previous-summary"),
    true,
  );
  handlers.get("session_shutdown")({}, ctx);
});

test("reload excludes an empty failed retry attempt from provider context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retry-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  try {
    const handlers = new Map();
    let windowCommand;
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand(name, command) {
        if (name === "window") windowCommand = command;
      },
      appendEntry() {},
    };
    const statuses = [];
    const ctx = {
      cwd: directory,
      hasUI: true,
      model: { contextWindow: 64_000 },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "reload-test",
        getBranch: () => [],
      },
      ui: {
        setStatus(_name, value) { statuses.push(value); },
        notify() {},
      },
    };
    const extension = createContextEpochWindow({
      configLoader: () => loadConfig({
        cwd: directory,
        projectTrusted: false,
        env: {
          CONTEXT_WINDOW_BACKEND: "sqlite",
          CONTEXT_WINDOW_DB: join(directory, "archive.db"),
          CONTEXT_WINDOW_ROCKSDB: storePath,
          CONTEXT_WINDOW_SOCKET: socketPath,
        },
        home: directory,
      }),
    });
    await extension(pi);
    handlers.get("session_start")({ reason: "reload" }, ctx);
    assert.equal(statuses.at(-1), "Epoch · waiting to measure · limits 20 turns / 42K tokens");
    await windowCommand.handler("rotate", ctx);
    assert.equal(statuses.at(-1), "Epoch · waiting to measure · limits 20 turns / 42K tokens · rotation queued");

    const user = { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 };
    const failed = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }],
      stopReason: "error",
      errorMessage: "WebSocket error",
      timestamp: 2,
    };
    const recovered = { role: "assistant", content: [{ type: "text", text: "recovered" }], timestamp: 3 };
    const result = handlers.get("context")({ messages: [user, failed, recovered] }, ctx);

    assert.deepEqual(result.messages, [user, recovered]);
    handlers.get("model_select")({
      model: { provider: "openai", id: "gpt-test", contextWindow: 100_000 },
    }, ctx);
    assert.match(statuses.at(-1), /~\d+\/65K tokens$/);
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    await stopDaemonAt(socketPath, directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tree navigation restores the destination branch epoch boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-tree-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const envKeys = [
    "CONTEXT_WINDOW_BACKEND",
    "CONTEXT_WINDOW_DB",
    "CONTEXT_WINDOW_ROCKSDB",
    "CONTEXT_WINDOW_SOCKET",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CONTEXT_WINDOW_BACKEND: "sqlite",
    CONTEXT_WINDOW_DB: join(directory, "archive.db"),
    CONTEXT_WINDOW_ROCKSDB: storePath,
    CONTEXT_WINDOW_SOCKET: socketPath,
  });
  try {
    const handlers = new Map();
    const messages = [
      { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "current" }], timestamp: 3 },
    ];
    let branch = [];
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    };
    const ctx = {
      cwd: directory,
      hasUI: true,
      model: { contextWindow: 64_000 },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "tree-test",
        getBranch: () => branch,
      },
      ui: { setStatus() {} },
    };
    await contextEpochWindow(pi);
    handlers.get("session_start")({}, ctx);

    branch = [{
      type: "custom",
      customType: ROTATION_STATE_ENTRY,
      data: { sessionId: "tree-test", boundaryKey: messageKey(messages[2]), rotations: 2 },
    }];
    handlers.get("session_tree")({}, ctx);

    assert.deepEqual(handlers.get("context")({ messages }, ctx).messages, [messages[2]]);
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await stopDaemonAt(socketPath, directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("footer surfaces an over-limit retention floor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-target-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const envKeys = [
    "CONTEXT_WINDOW_BACKEND",
    "CONTEXT_WINDOW_DB",
    "CONTEXT_WINDOW_ROCKSDB",
    "CONTEXT_WINDOW_SOCKET",
    "CONTEXT_WINDOW_HARD_LIMIT_TOKENS",
    "CONTEXT_WINDOW_RETAIN_TURNS",
    "CONTEXT_WINDOW_ROTATION_TOKENS",
    "CONTEXT_WINDOW_ROTATION_TURNS",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CONTEXT_WINDOW_BACKEND: "sqlite",
    CONTEXT_WINDOW_DB: join(directory, "archive.db"),
    CONTEXT_WINDOW_ROCKSDB: storePath,
    CONTEXT_WINDOW_SOCKET: socketPath,
    CONTEXT_WINDOW_HARD_LIMIT_TOKENS: "200",
    CONTEXT_WINDOW_RETAIN_TURNS: "10",
    CONTEXT_WINDOW_ROTATION_TOKENS: "100",
    CONTEXT_WINDOW_ROTATION_TURNS: "20",
  });
  try {
    const handlers = new Map();
    const appendedEntries = [];
    const statuses = [];
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand() {},
      appendEntry(...args) { appendedEntries.push(args); },
    };
    const ctx = {
      cwd: directory,
      hasUI: true,
      model: { contextWindow: 10_000 },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "target-test",
        getBranch: () => [],
      },
      ui: { setStatus(_name, value) { statuses.push(value); } },
    };
    await contextEpochWindow(pi);
    handlers.get("session_start")({}, ctx);
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `${index}:${"x".repeat(80)}` }],
      timestamp: index + 1,
    }));
    const result = handlers.get("context")({ messages }, ctx);

    assert.deepEqual(result.messages, messages);
    assert.equal(appendedEntries.length, 1);
    assert.equal(appendedEntries[0][0], ROTATION_STATE_ENTRY);
    const { archivedAt, ...persistedHintDecision } = appendedEntries[0][1];
    assert.ok(Number.isSafeInteger(archivedAt) && archivedAt > 0);
    assert.deepEqual(persistedHintDecision, {
      sessionId: "target-test",
      sessionIds: ["target-test"],
      boundaryKey: undefined,
      rotations: 0,
      reason: undefined,
      mode: undefined,
      configuredRetainTurns: 10,
      effectiveRetainTurns: undefined,
      toc: [],
      hintState: {
        version: 1,
        reconstructOnlyMessageKeys: messages.map(messageKey),
      },
    });
    assert.match(statuses.at(-1), /^Epoch · 10\/20 turns · ~\d+\/100 tokens · at limit · history checkpoint needed$/);
    const [, active, limit] = statuses.at(-1).match(/~(\d+)\/(\d+) tokens/);
    assert.ok(Number(active) > Number(limit));
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await stopDaemonAt(socketPath, directory);
    rmSync(directory, { recursive: true, force: true });
  }
});
