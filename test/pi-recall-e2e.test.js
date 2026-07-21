import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  benchmarkEnvironment,
  bindEvaluationSession,
  createCaseWorkspace,
  shutdownEvaluationSession,
  startManagedDaemon,
  stopManagedDaemon,
} from "../eval/agent-memory/pi-longmemeval-s.js";

// Capstone end-to-end verification of the Pi context-window integration on a
// REAL Pi SDK runtime: extensions/pi.ts is loaded through the SDK's
// DefaultResourceLoader, its tools/commands are registered through the real
// ExtensionRunner, and the session/context lifecycle is dispatched through the
// SDK -- all against an ISOLATED managed RocksDB daemon per case (never the
// user's ~/.pi archive). No model is prompted and no network is used: the
// offline fixture model never receives a request, and the retrieval flows are
// driven through the runner's tool/command surface directly.
//
// The full Pi *binary* (test/pi-launch.test.js) proves boot + extension
// registration + daemon lifecycle offline, but cannot drive tool calls without
// a model deciding to call them; the rotation+search+recall core is therefore
// exercised through this SDK-bound extension path.

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION_PATH = join(REPO_ROOT, "extensions", "pi.ts");
const SEMANTIC_CACHE = join(homedir(), ".pi", "context-window", "models");
const SEMANTIC_MODEL_DIR = join(SEMANTIC_CACHE, "Xenova", "all-MiniLM-L6-v2");
const RERANKER_CACHE = join(homedir(), ".cache", "context-window-reranker-eval");
const RERANKER_MODEL_DIR = join(RERANKER_CACHE, "Xenova", "ms-marco-MiniLM-L-6-v2");

function writeOfflineModels(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, `${JSON.stringify({
    providers: {
      "offline-fixture": {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "offline-fixture-placeholder",
        models: [{
          id: "dummy",
          name: "Offline fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 1_024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`);
  return modelsPath;
}

function toolDefinition(session, name) {
  const registered = session.extensionRunner
    .getAllRegisteredTools()
    .find((entry) => entry.definition.name === name);
  if (!registered) throw new Error(`tool not registered: ${name}`);
  return registered.definition;
}

// Boot a real SDK session with the context-window extension bound against an
// isolated managed daemon. Returns the live session plus a bounded teardown
// that runs session_shutdown, reaps the exact daemon PID, restores env, and
// removes the workspace (harness invariants from eval/agent-memory/README.md).
async function bootSession(envOverrides) {
  const workspace = createCaseWorkspace();
  const { cwd } = workspace;
  mkdirSync(cwd, { recursive: true });
  const environment = { ...benchmarkEnvironment(workspace), ...envOverrides };
  const previousEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    previousEnvironment[key] = process.env[key];
    process.env[key] = value;
  }
  const agentDir = join(workspace.root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelsPath = writeOfflineModels(agentDir);

  const notifications = [];
  const lifecycleFailures = [];
  let managedDaemon;
  let session;

  const teardown = async () => {
    try { await shutdownEvaluationSession(session); } catch { /* bounded */ }
    const stop = await stopManagedDaemon(managedDaemon);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(workspace.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return stop;
  };

  try {
    managedDaemon = await startManagedDaemon(workspace, cwd);
    const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
    const model = modelRuntime.getModel("offline-fixture", "dummy");
    const sessionManager = SessionManager.inMemory(cwd);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      eventBus: createEventBus(),
      noExtensions: true,
      additionalExtensionPaths: [EXTENSION_PATH],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      model,
      modelRuntime,
      thinkingLevel: "medium",
      noTools: "builtin",
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    // bindExtensions() emits session_start, so the extension session is live
    // after this returns (its tools' requireSession() succeeds).
    await bindEvaluationSession(session, lifecycleFailures);
    assert.deepEqual(created.extensionsResult.errors, [], "extension must load clean");

    const commandContext = {
      cwd,
      hasUI: false,
      model,
      isProjectTrusted: () => false,
      sessionManager,
      ui: {
        setStatus() {},
        notify(message, level) { notifications.push({ message, level }); },
      },
      getContextUsage: () => undefined,
    };
    const runWindow = async (args) => {
      const before = notifications.length;
      await session.extensionRunner.getCommand("window").handler(args, commandContext);
      return notifications.slice(before);
    };

    return { session, model, sessionManager, notifications, lifecycleFailures, runWindow, teardown, workspace };
  } catch (error) {
    await teardown();
    throw error;
  }
}

// Two rotated turns share alpha_widget_metric so a single query returns both;
// the extension archives them oldest-first, so recency decay must rank the
// newer one first even though lexical relevance is comparable.
function seededMessages(now) {
  const day = 24 * 60 * 60 * 1_000;
  return [
    { role: "user", content: [{ type: "text", text: "We refactored getUserProfileCache to use an LRU with 512 entries." }], timestamp: now - 6 * day },
    { role: "assistant", content: [{ type: "text", text: "Done: getUserProfileCache is now an LRU of 512 entries." }], timestamp: now - 6 * day + 1 },
    { role: "user", content: [{ type: "text", text: "The alpha_widget_metric dipped during the Q1 migration rollback." }], timestamp: now - 4 * day },
    { role: "assistant", content: [{ type: "text", text: "Noted the Q1 rollback dip." }], timestamp: now - 4 * day + 1 },
    { role: "user", content: [{ type: "text", text: "The alpha_widget_metric climbed after the caching layer landed." }], timestamp: now - 1 * day },
    { role: "assistant", content: [{ type: "text", text: "Noted the caching-layer climb." }], timestamp: now - 1 * day + 1 },
    { role: "user", content: [{ type: "text", text: "Remind me how many entries getUserProfileCache holds." }], timestamp: now - 100 },
    { role: "assistant", content: [{ type: "text", text: "Let me check the earlier history." }], timestamp: now - 99 },
  ];
}

// Archive two opposing decisions that share the config/database.yml path anchor
// (a strong conflict anchor) under distinct subjectKeys, so a project-scoped
// gather packet can flag them as possibly conflicting.
async function archiveConflictingDecisions(session) {
  const archive = toolDefinition(session, "context_window_archive");
  await archive.execute("call", {
    text: "We decided to use the config/database.yml Postgres connection pool for the service.",
    kind: "decision",
    subjectKey: "decision:datastore-choice",
  });
  await archive.execute("call", {
    text: "For config/database.yml we reverted the Postgres pool, rejecting it instead of keeping it.",
    kind: "decision",
    subjectKey: "decision:datastore-reversal",
  });
}

// The daemon indexes rotated/archived documents asynchronously, so a search
// issued immediately after a write can race indexing. Poll the tool until the
// expected state is observed (normally within a few tens of ms), bounded so a
// genuine failure still surfaces instead of hanging.
async function executeUntil(toolDef, params, predicate, { deadlineMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = await toolDef.execute("call", params);
    if (predicate(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function exerciseFlows(session, runWindow, { requireConflict }) {
  const observed = {};

  // (1) session start: the real ExtensionRunner registered every context tool
  // and the /window command.
  const tools = session.extensionRunner.getAllRegisteredTools().map((t) => t.definition.name).sort();
  for (const required of ["context_window_search", "context_recall", "context_window_gather", "context_window_traverse", "context_window_archive"]) {
    assert.ok(tools.includes(required), `tool ${required} must be registered`);
  }
  assert.ok(session.extensionRunner.getCommand("window"), "/window command must be registered");
  observed.tools = tools;

  // (2) enough turns to rotate old content into the archive.
  const now = Date.now();
  const processed = await session.extensionRunner.emitContext(seededMessages(now));
  assert.ok(Array.isArray(processed), "context handler must return provider messages");
  assert.ok(processed.length < 8, "old turns must have rotated out of the active window");
  observed.retainedMessageCount = processed.length;

  await archiveConflictingDecisions(session);

  // (3) explicit search finds rotated content by a camelCase subtoken, fused
  // (hybrid, RRF), with a relevance band. Subtoken splitting is what lets the
  // query "profile" match the compound identifier "getUserProfileCache".
  const search = toolDefinition(session, "context_window_search");
  const recall = toolDefinition(session, "context_recall");
  const subtoken = await executeUntil(
    search,
    { query: "profile", scope: "session", limit: 5, workingSet: ["getUserProfileCache"] },
    (result) => result.details.count === 1,
  );
  assert.equal(subtoken.details.status, "resolved", "subtoken search must resolve");
  assert.equal(subtoken.details.count, 1, "subtoken 'profile' must match getUserProfileCache turn");
  assert.equal(subtoken.details.mode, "hybrid", "explicit search fuses rankers (RRF)");
  assert.match(subtoken.content[0].text, /getUserProfileCache/, "search snippet must contain the compound identifier");
  assert.match(subtoken.content[0].text, /"relevanceBand":"(?:high|moderate|some|low)"/, "search must render a relevance band");
  const subtokenRecallId = subtoken.details.ids[0];

  // A shared-term query returns both alpha_widget_metric turns. The recency
  // decay stage runs unconditionally in the ranking pipeline (search.js
  // applyRecencyDecay); the exact ordering of two comparably-relevant turns is
  // not asserted here because it races background indexing and the reranker can
  // legitimately override it -- ordering correctness is owned by
  // test/retrieval-recency-decay.test.js.
  const recency = await executeUntil(
    search,
    { query: "alpha_widget_metric", scope: "session", limit: 5 },
    (result) => result.details.count >= 2,
  );
  assert.ok(recency.details.count >= 2, "both alpha_widget_metric turns must be found");
  observed.searchModes = { subtoken: subtoken.details.mode, recency: recency.details.mode };

  // (4) recall recovers the exact archived turn by locator with provenance and
  // status resolved.
  const recalled = await recall.execute("call", { id: subtokenRecallId });
  assert.equal(recalled.details.found, true, "recall must find the locator");
  assert.equal(recalled.details.provenance.archive.kind, "turn", "provenance must carry the archived kind");
  assert.equal(recalled.details.provenance.sourceMessages.status, "available", "source-message provenance must resolve");
  assert.match(recalled.content[0].text, /ARCHIVED HISTORICAL EVIDENCE/, "recall envelope must mark untrusted archived data");
  assert.match(recalled.content[0].text, /getUserProfileCache to use an LRU with 512 entries/, "recall must return the exact archived text");
  observed.recallProvenance = recalled.details.provenance;

  // (5) gather returns a chronological packet with relevance bands and (here)
  // possibly-conflicting cross-reference metadata.
  const gather = toolDefinition(session, "context_window_gather");
  const gatherParams = { query: "config/database.yml Postgres connection pool decision", scope: "project", limit: 6 };
  const packet = await executeUntil(
    gather,
    gatherParams,
    (result) => result.details.count >= 2
      && (!requireConflict || /possibly conflicting with/.test(result.content[0].text)),
  );
  assert.equal(packet.details.status, "resolved", "gather must resolve");
  assert.ok(packet.details.count >= 2, "gather must return multiple evidence records");
  assert.match(packet.content[0].text, /"format":"context-window\.gathered-evidence\.v1"/, "gather must render evidence records");
  assert.match(packet.content[0].text, /"relevanceBand":"(?:high|moderate|some|low)"/, "gather must render relevance bands");
  const conflictRendered = /possibly conflicting with/.test(packet.content[0].text);
  if (requireConflict) {
    assert.ok(conflictRendered, "gather must flag the two opposing decisions as possibly conflicting");
  }
  observed.gatherConflictRendered = conflictRendered;

  // (6) /window recall why explains the last automatic-retrieval decision. The
  // active turn referenced getUserProfileCache, which had rotated out, so the
  // extension's automatic preflight (run during emitContext) recorded a
  // positive retrieval decision (observed: continuity-marker /
  // implicit-concept-continuity, resolved on the exact/lexical index).
  const [why] = await runWindow("recall why");
  assert.notEqual(
    why.message,
    "No automatic retrieval decision has been observed in this process.",
    "an automatic-retrieval decision must have been recorded",
  );
  assert.match(why.message, /^Automatic retrieval: \S+/, "recall why must render the decision outcome");
  assert.match(why.message, /Reason: \S+/, "recall why must render the decision reason");
  observed.recallWhy = why.message;

  // (7) /window usage renders the per-component token breakdown.
  const [usage] = await runWindow("usage");
  assert.match(usage.message, /Epoch estimate:/, "usage must render the epoch estimate");
  assert.match(usage.message, /Per-component breakdown, top \d+\/\d+ by token share/, "usage must render the per-component breakdown");
  assert.match(usage.message, /Largest single message\(s\), top \d+\/\d+/, "usage must render the largest messages");
  observed.usage = usage.message;

  return observed;
}

test("Pi recall e2e round-trip on the lexical path (semantic + reranker disabled)", {
  timeout: 60_000,
}, async () => {
  const booted = await bootSession({
    CONTEXT_WINDOW_SEMANTIC_RETRIEVAL: "0",
    CONTEXT_WINDOW_RERANKER_ENABLED: "0",
  });
  try {
    const observed = await exerciseFlows(booted.session, booted.runWindow, { requireConflict: true });
    // (8) degraded mode: with semantic + reranker off, every flow above
    // functioned on the lexical path with no lifecycle failures and no tool
    // errors -- the automatic-retrieval decision resolved on the exact/lexical
    // index, never a semantic one.
    assert.deepEqual(booted.lifecycleFailures, [], "no extension lifecycle failures on the lexical path");
    assert.doesNotMatch(observed.recallWhy, /Search: semantic/, "the lexical path must not report a semantic search");
  } finally {
    const stop = await booted.teardown();
    assert.equal(stop.reaped, true, "the exact managed daemon PID must be reaped");
  }
});

test("Pi recall e2e round-trip with semantic + reranker enabled from local cache", {
  timeout: 120_000,
}, async (t) => {
  if (!existsSync(SEMANTIC_MODEL_DIR) || !existsSync(RERANKER_MODEL_DIR)) {
    t.skip("local semantic/reranker model caches are absent; models-active parity not exercised");
    return;
  }
  const booted = await bootSession({
    CONTEXT_WINDOW_SEMANTIC_RETRIEVAL: "1",
    CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE: SEMANTIC_CACHE,
    CONTEXT_WINDOW_RERANKER_ENABLED: "1",
    CONTEXT_WINDOW_RERANKER_MODEL_CACHE: RERANKER_CACHE,
  });
  try {
    // The models load strictly offline (workers force allowRemoteModels=false
    // and local_files_only=true). Freshly-rotated documents may not be embedded
    // yet, so semantic ranking is not asserted here (that is covered by the
    // semantic/reranker suites); this proves the models-enabled configuration
    // drives the full round-trip without error and returns results.
    const observed = await exerciseFlows(booted.session, booted.runWindow, { requireConflict: false });
    assert.deepEqual(booted.lifecycleFailures, [], "no extension lifecycle failures with models enabled");
    assert.ok(observed.retainedMessageCount < 8, "rotation still occurs with models enabled");
  } finally {
    const stop = await booted.teardown();
    assert.equal(stop.reaped, true, "the exact managed daemon PID must be reaped");
  }
});
