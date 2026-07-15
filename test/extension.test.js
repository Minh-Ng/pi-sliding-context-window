import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import contextEpochWindow, { createContextEpochWindow } from "../extensions/pi.ts";
import {
  EVIDENCE_ROUTING_GUIDELINES,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { Archive } from "../src/archive.js";
import { loadConfig } from "../src/config.js";
import { EpochWindowSession, ROTATION_STATE_ENTRY } from "../src/epoch-window.js";
import { messageKey } from "../src/window.js";

test("archive tools advertise evidence-source routing", async () => {
  const tools = new Map();
  await contextEpochWindow({
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });

  const search = tools.get("context_window_search");
  const recall = tools.get("context_recall");
  assert.ok(search);
  assert.ok(recall);
  assert.equal(tools.has("context_window_recall"), false);

  assert.equal(search.description, SEARCH_TOOL_DESCRIPTION);
  assert.equal(recall.description, RECALL_TOOL_DESCRIPTION);
  assert.deepEqual(search.promptGuidelines, EVIDENCE_ROUTING_GUIDELINES);
  assert.equal(search.promptSnippet, undefined);
  assert.equal(recall.promptGuidelines, undefined);

  for (const guideline of search.promptGuidelines) {
    assert.match(
      guideline,
      /context_window_search|context_recall/,
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
});

test("custom archive factories can replace the SQLite backend", async () => {
  const handlers = new Map();
  let openedPath;
  let closed = false;
  const tools = new Map();
  const sourceKeys = Array.from({ length: 200 }, (_, index) =>
    `user:${index}::${"long-source-key".repeat(12)}`,
  );
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
    search() { return []; },
    get(id) { return id === recalledDocument.id ? recalledDocument : undefined; },
    count() { return 0; },
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
      preventAutoCompaction: true,
      statusLabelAccent: false,
      dbPath: "/virtual/archive",
      models: {},
      environmentOverrides: {},
    }),
    archiveFactory: (path) => {
      openedPath = path;
      return archive;
    },
  });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  });
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { contextWindow: 100_000 },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "custom", getBranch: () => [] },
    ui: { setStatus() {} },
  };

  handlers.get("session_start")({}, ctx);
  assert.equal(openedPath, "/virtual/archive");

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

  handlers.get("session_shutdown")({}, ctx);
  assert.equal(closed, true);
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
    assert.equal(projectResult.details.ids.includes("unrelated-doc"), true);

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

test("threshold compaction trusts provider-aware usage over an optimistic epoch estimate", async () => {
  const handlers = new Map();
  const archive = {
    put() {},
    search() { return []; },
    get() { return undefined; },
    count() { return 0; },
    close() {},
  };
  const config = {
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
    preventAutoCompaction: true,
    statusLabelAccent: false,
    dbPath: "/virtual/archive",
    models: {},
    environmentOverrides: {},
  };
  const extension = createContextEpochWindow({
    configLoader: () => config,
    archiveFactory: () => archive,
  });
  await extension({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
  });

  let providerTokens = 70_000;
  const ctx = {
    cwd: "/project",
    hasUI: false,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 100_000 },
    isProjectTrusted: () => false,
    getContextUsage: () => ({ tokens: providerTokens, contextWindow: 100_000, percent: providerTokens / 1_000 }),
    sessionManager: { getSessionId: () => "compaction-test", getBranch: () => [] },
    ui: { setStatus() {} },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("context")({
    messages: [{ role: "user", content: [{ type: "text", text: "small visible epoch" }], timestamp: 1 }],
  }, ctx);

  const event = (tokensBefore) => ({
    reason: "threshold",
    preparation: { tokensBefore },
  });
  assert.deepEqual(handlers.get("session_before_compact")(event(70_000), ctx), { cancel: true });

  // Reproduces the failure mode: the extension's chars/4 estimate is tiny,
  // while Pi reports a provider payload beyond the 80K hard limit.
  providerTokens = 95_000;
  assert.equal(handlers.get("session_before_compact")(event(70_000), ctx), undefined);

  providerTokens = 70_000;
  assert.equal(handlers.get("session_before_compact")(event(95_000), ctx), undefined);
  assert.equal(handlers.get("session_before_compact")({
    reason: "threshold",
    preparation: { tokensBefore: undefined },
  }, { ...ctx, getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }) }), undefined);
  handlers.get("session_shutdown")({}, ctx);
});

test("unsafe epoch fallback allows native compaction and persists a post-compaction reset", async () => {
  const handlers = new Map();
  const appended = [];
  const archive = {
    put() {}, search() { return []; }, get() {}, count() { return 0; }, close() {},
  };
  const config = {
    rotationContextRatio: 0.65,
    hardLimitContextRatio: 0.8,
    rotationTokens: 65_000,
    rotationTokensExplicit: true,
    rotationTurns: 20,
    hardLimitTokens: 80_000,
    hardLimitTokensExplicit: true,
    retainTurns: 10,
    maxToolResultTokens: 4_000,
    searchResults: 3,
    searchResultTokens: 1_500,
    preventAutoCompaction: true,
    statusLabelAccent: false,
    dbPath: "/virtual/archive",
    models: {},
    environmentOverrides: {},
  };
  await createContextEpochWindow({
    configLoader: () => config,
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
  handlers.get("session_start")({}, ctx);
  handlers.get("context")({
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "current" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }], timestamp: 4 },
    ],
  }, ctx);

  const event = { reason: "threshold", preparation: { tokensBefore: 70_000 } };
  assert.equal(handlers.get("session_before_compact")(event, ctx), undefined);
  assert.equal(handlers.get("session_before_compact")({ ...event, reason: "overflow" }, ctx), undefined);
  assert.equal(handlers.get("session_before_compact")({ ...event, reason: "manual" }, ctx), undefined);

  handlers.get("session_compact")({}, ctx);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], ROTATION_STATE_ENTRY);
  assert.equal(appended[0][1].boundaryKey, undefined);
  assert.deepEqual(appended[0][1].toc, []);
  handlers.get("session_shutdown")({}, ctx);
});

test("reload excludes an empty failed retry attempt from provider context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retry-"));
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
        env: { CONTEXT_WINDOW_DB: join(directory, "archive.db") },
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
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tree navigation restores the destination branch epoch boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-tree-"));
  const previousDb = process.env.CONTEXT_WINDOW_DB;
  process.env.CONTEXT_WINDOW_DB = join(directory, "archive.db");
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
    if (previousDb === undefined) delete process.env.CONTEXT_WINDOW_DB;
    else process.env.CONTEXT_WINDOW_DB = previousDb;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("footer surfaces an over-limit retention floor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-target-"));
  const envKeys = [
    "CONTEXT_WINDOW_DB",
    "CONTEXT_WINDOW_HARD_LIMIT_TOKENS",
    "CONTEXT_WINDOW_RETAIN_TURNS",
    "CONTEXT_WINDOW_ROTATION_TOKENS",
    "CONTEXT_WINDOW_ROTATION_TURNS",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CONTEXT_WINDOW_DB: join(directory, "archive.db"),
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
    assert.equal(appendedEntries.length, 0);
    assert.match(statuses.at(-1), /^Epoch · 10\/20 turns · ~\d+\/100 tokens · at limit · native compaction needed$/);
    const [, active, limit] = statuses.at(-1).match(/~(\d+)\/(\d+) tokens/);
    assert.ok(Number(active) > Number(limit));
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
