#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StoreClient } from "../../src/store/store-client.js";

const DEFAULT_CASE_IDS = Object.freeze(["06f04340", "0977f2af"]);
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST });
export const SAFE_UNIX_SOCKET_PATH_BYTES = 100;

export function temporaryRootForSocket({
  platform = process.platform,
  preferredRoot = tmpdir(),
} = {}) {
  if (platform === "win32") return preferredRoot;
  const prospective = join(preferredRoot, "cwlme-XXXXXX", "s", "d.sock");
  return Buffer.byteLength(prospective, "utf8") <= SAFE_UNIX_SOCKET_PATH_BYTES
    ? preferredRoot
    : "/tmp";
}

export function createCaseWorkspace(options = {}) {
  const temporaryRoot = options.temporaryRoot ?? temporaryRootForSocket(options);
  const root = mkdtempSync(join(temporaryRoot, "cwlme-"));
  const workspace = Object.freeze({
    root,
    cwd: join(root, "p"),
    storePath: join(root, "r"),
    socketPath: join(root, "s", "d.sock"),
    sqlitePath: join(root, "x", "a.db"),
    semanticIndexPath: join(root, "v"),
  });
  mkdirSync(workspace.cwd, { recursive: true });
  if (process.platform !== "win32"
    && Buffer.byteLength(workspace.socketPath, "utf8") > SAFE_UNIX_SOCKET_PATH_BYTES) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`Benchmark daemon socket path is too long: ${workspace.socketPath}`);
  }
  return workspace;
}

export function benchmarkEnvironment(workspace) {
  return Object.freeze({
    CONTEXT_WINDOW_BACKEND: "rocksdb",
    CONTEXT_WINDOW_ROCKSDB: workspace.storePath,
    CONTEXT_WINDOW_SOCKET: workspace.socketPath,
    CONTEXT_WINDOW_DB: workspace.sqlitePath,
    CONTEXT_WINDOW_ROTATION_TURNS: "2",
    CONTEXT_WINDOW_RETAIN_TURNS: "1",
    CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION: "0",
    CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS: "0",
    // Preserve fixture chronology; do not rewrite historical dates to evade
    // production semantic-retention policy.
    CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS: "10000",
    CONTEXT_WINDOW_DERIVED_RETENTION_DAYS: "10000",
    CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS: "10000",
    CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS: "10000",
    CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL: "1",
    CONTEXT_WINDOW_SEMANTIC_RETRIEVAL: "1",
    CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE: process.env.CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE
      ?? join(homedir(), ".pi", "context-window", "models"),
    CONTEXT_WINDOW_SEMANTIC_INDEX: workspace.semanticIndexPath,
    CONTEXT_WINDOW_SEMANTIC_CANDIDATES: "40",
    CONTEXT_WINDOW_SEARCH_RESULTS: "5",
    CONTEXT_WINDOW_SEARCH_RESULT_TOKENS: "2000",
  });
}

export function evaluationCasePassed(result) {
  return result?.score?.passed === true && result?.harness?.healthy === true;
}

export function boundedFailure(failure, phase = "runner") {
  const source = failure && typeof failure === "object" ? failure : {};
  const message = String(source.error ?? source.message ?? failure ?? "Unknown failure").slice(0, 4_000);
  return Object.freeze({
    phase: String(source.event ?? source.phase ?? phase).slice(0, 100),
    message,
    ...(typeof source.extensionPath === "string"
      ? { extensionPath: source.extensionPath.slice(0, 1_000) }
      : {}),
  });
}

export async function bindEvaluationSession(session, lifecycleFailures) {
  session.subscribe((event) => {
    if (event.type === "extension_error") lifecycleFailures.push(boundedFailure(event, "extension"));
  });
  await session.bindExtensions({
    mode: "json",
    onError: (failure) => lifecycleFailures.push(boundedFailure(failure, "extension")),
  });
}

export async function shutdownEvaluationSession(session) {
  if (!session) return;
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  } finally {
    session.dispose();
  }
}

function parseArguments(argv) {
  const args = {
    caseIds: [...DEFAULT_CASE_IDS],
    model: "openai-codex/gpt-5.4-mini",
    thinking: "medium",
    repetitions: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data") args.dataPath = argv[++index];
    else if (argument === "--output") args.outputPath = argv[++index];
    else if (argument === "--cases") args.caseIds = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--model") args.model = argv[++index];
    else if (argument === "--thinking") args.thinking = argv[++index];
    else if (argument === "--repetitions") args.repetitions = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.dataPath) throw new Error("--data is required");
  if (!args.outputPath) throw new Error("--output is required");
  if (!Number.isSafeInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 20) {
    throw new Error("--repetitions must be an integer from 1 to 20");
  }
  const [provider, ...modelParts] = args.model.split("/");
  if (!provider || modelParts.length === 0) throw new Error("--model must be provider/model");
  args.provider = provider;
  args.modelId = modelParts.join("/");
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseSessionDate(value, fallback) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/u.exec(String(value ?? ""));
  if (!match) return fallback;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

function assistantMessage(text, model, timestamp) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(ZERO_USAGE),
    stopReason: "stop",
    timestamp,
  };
}

export function seedHistory(sessionManager, entry, model) {
  let fallback = Date.UTC(2023, 0, 1);
  let messageCount = 0;
  for (let sessionIndex = 0; sessionIndex < entry.haystack_sessions.length; sessionIndex += 1) {
    const sessionDate = entry.haystack_dates[sessionIndex];
    const baseTimestamp = parseSessionDate(sessionDate, fallback);
    fallback = baseTimestamp + 24 * 60 * 60 * 1_000;
    const messages = entry.haystack_sessions[sessionIndex];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const source = messages[messageIndex];
      const timestamp = baseTimestamp + messageIndex;
      const datePrefix = messageIndex === 0 ? `[History session date: ${sessionDate}]\n` : "";
      const text = `${datePrefix}${String(source.content ?? "")}`;
      if (source.role === "user") {
        sessionManager.appendMessage({ role: "user", content: text, timestamp });
      } else if (source.role === "assistant") {
        sessionManager.appendMessage(assistantMessage(text, model, timestamp));
      }
      messageCount += 1;
    }
  }
  return messageCount;
}

function textContent(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function toolText(result) {
  return (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function scoreCase(questionId, answer) {
  const normalized = answer.toLowerCase();
  if (questionId === "0977f2af") {
    return { passed: normalized.includes("instant pot"), requirement: "Final answer identifies Instant Pot." };
  }
  if (questionId === "06f04340") {
    const produce = normalized.includes("tomato");
    const herbs = normalized.includes("basil") || normalized.includes("mint") || normalized.includes("herb");
    return { passed: produce && herbs, requirement: "Final answer uses homegrown cherry tomatoes and basil/mint or herbs." };
  }
  return { passed: false, requirement: "No deterministic development-gate scorer is defined for this case." };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

export async function startManagedDaemon(workspace, project, options = {}) {
  const daemonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/context-windowd.js");
  mkdirSync(dirname(workspace.storePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(workspace.socketPath), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    daemonPath,
    "--store", workspace.storePath,
    "--socket", workspace.socketPath,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Managed context-window daemon exited during startup: ${stderr || child.exitCode}`);
    }
    const client = new StoreClient({
      socketPath: workspace.socketPath,
      project,
      client: "pi-longmemeval-startup",
      requestTimeoutMs: 500,
    });
    try {
      const handshake = await client.connect();
      client.close();
      return Object.freeze({ child, processId: handshake.processId });
    } catch {
      client.close();
      await delay(25);
    }
  }
  child.kill("SIGKILL");
  await waitForChildExit(child, 2_000);
  throw new Error(`Managed context-window daemon did not become ready: ${stderr || workspace.socketPath}`);
}

export async function stopManagedDaemon(managed) {
  if (!managed) {
    return Object.freeze({ processId: null, signal: null, stopped: true, reaped: true });
  }
  const { child, processId } = managed;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Object.freeze({ processId, signal: child.signalCode, stopped: true, reaped: true });
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 10_000)) {
    return Object.freeze({ processId, signal: "SIGTERM", stopped: true, reaped: true });
  }
  child.kill("SIGKILL");
  const reaped = await waitForChildExit(child, 5_000);
  return Object.freeze({ processId, signal: "SIGKILL", stopped: reaped, reaped });
}

export async function runCase(entry, options) {
  const caseStartedAt = Date.now();
  const timings = {
    startedAt: new Date(caseStartedAt).toISOString(),
    setupMs: 0,
    promptMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
  const cleanup = { daemon: null };
  const harness = { healthy: true };
  const diagnostics = { workspaceRoot: null };
  const workspace = createCaseWorkspace(options.workspaceOptions);
  const { root, cwd } = workspace;
  const previousEnvironment = {};
  const environment = benchmarkEnvironment(workspace);
  for (const [key, value] of Object.entries(environment)) {
    previousEnvironment[key] = process.env[key];
    process.env[key] = value;
  }

  const trace = [];
  const lifecycleFailures = [];
  let managedDaemon;
  let session;
  try {
    managedDaemon = await startManagedDaemon(workspace, cwd);
    const sessionManager = SessionManager.inMemory(cwd);
    const seededMessages = seedHistory(sessionManager, entry, options.model);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const eventBus = createEventBus();
    eventBus.on("context-window:failure", (failure) => {
      lifecycleFailures.push(boundedFailure(failure, "context"));
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      eventBus,
      noExtensions: true,
      additionalExtensionPaths: [options.extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      model: options.model,
      modelRuntime: options.modelRuntime,
      thinkingLevel: options.thinking,
      noTools: "builtin",
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    // createAgentSession registers resources; SDK embedders must explicitly
    // bind a mode before session_start and context lifecycle events can run.
    await bindEvaluationSession(session, lifecycleFailures);
    timings.setupMs = Date.now() - caseStartedAt;
    if (created.extensionsResult.errors.length > 0) {
      throw new Error(`Extension load failed: ${JSON.stringify(created.extensionsResult.errors)}`);
    }
    const activeTools = session.agent.state.tools.map(({ name }) => name).sort();
    if (!activeTools.includes("context_window_search")
      || !activeTools.includes("context_window_traverse")
      || !activeTools.includes("context_recall")) {
      throw new Error(`Context tools are not active: ${activeTools.join(", ")}`);
    }
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        trace.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        trace.push({
          type: event.type,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          text: toolText(event.result),
          details: event.result?.details,
        });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        trace.push({ type: event.type, role: "assistant", text: textContent(event.message), stopReason: event.message.stopReason });
      } else if (["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "extension_error"].includes(event.type)) {
        trace.push({ type: event.type });
      }
    });

    const prompt = [
      "Answer this question using the earlier chat history.",
      "Most earlier history may have rotated into the context-window archive.",
      "Use the context-window tools iteratively as needed; do not answer from a merely related anchor if the question asks for another event or fact.",
      "For before/after questions with an unknown answer, search for the named anchor and use chronological traversal with up to 128 records per page; do not guess candidate answer terms.",
      "For conceptual wording, use one query containing 3–8 category terms or paraphrases, then recall distinct plausible results before reformulating.",
      "In the final answer, explicitly preserve every concrete user-specific entity from recalled evidence that materially answers the question; do not rely on a dish, category, or candidate name to imply it.",
      `Current Date: ${entry.question_date}`,
      `Question: ${entry.question}`,
      "Give the final answer concisely and do not discuss the evaluation.",
    ].join("\n");
    const promptStartedAt = Date.now();
    await session.prompt(prompt);
    timings.promptMs = Date.now() - promptStartedAt;
    const assistantMessages = session.messages.filter((message) => message.role === "assistant");
    const finalAnswer = textContent(assistantMessages.at(-1));
    const score = scoreCase(entry.question_id, finalAnswer);
    const toolCalls = trace.filter(({ type }) => type === "tool_execution_start");
    const toolResults = trace.filter(({ type }) => type === "tool_execution_end");
    const stats = {
      input: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.input ?? 0), 0),
      output: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.output ?? 0), 0),
      cacheRead: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cacheRead ?? 0), 0),
      cacheWrite: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cacheWrite ?? 0), 0),
      cost: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cost?.total ?? 0), 0),
    };
    return {
      questionId: entry.question_id,
      questionType: entry.question_type,
      question: entry.question,
      expectedAnswer: entry.answer,
      answerSessionIds: entry.answer_session_ids,
      seededMessages,
      prompt,
      activeTools,
      finalAnswer,
      score,
      toolCallCount: toolCalls.length,
      searchCallCount: toolCalls.filter(({ toolName }) => toolName === "context_window_search").length,
      traverseCallCount: toolCalls.filter(({ toolName }) => toolName === "context_window_traverse").length,
      recallCallCount: toolCalls.filter(({ toolName }) => toolName === "context_recall").length,
      toolErrors: toolResults.filter(({ isError }) => isError).length,
      lifecycleFailures,
      harness,
      diagnostics,
      timings,
      cleanup,
      usage: stats,
      trace,
    };
  } catch (error) {
    lifecycleFailures.push(boundedFailure(error));
    return {
      questionId: entry.question_id,
      questionType: entry.question_type,
      question: entry.question,
      expectedAnswer: entry.answer,
      answerSessionIds: entry.answer_session_ids,
      finalAnswer: "",
      score: { passed: false, requirement: "Pi evaluation case must complete without a harness failure." },
      toolCallCount: trace.filter(({ type }) => type === "tool_execution_start").length,
      searchCallCount: trace.filter(({ type, toolName }) => type === "tool_execution_start" && toolName === "context_window_search").length,
      traverseCallCount: trace.filter(({ type, toolName }) => type === "tool_execution_start" && toolName === "context_window_traverse").length,
      recallCallCount: trace.filter(({ type, toolName }) => type === "tool_execution_start" && toolName === "context_recall").length,
      toolErrors: trace.filter(({ type, isError }) => type === "tool_execution_end" && isError).length,
      lifecycleFailures,
      harness,
      diagnostics,
      timings,
      cleanup,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      trace,
    };
  } finally {
    const cleanupStartedAt = Date.now();
    try { await shutdownEvaluationSession(session); } catch (error) {
      lifecycleFailures.push(boundedFailure(error, "shutdown"));
    }
    cleanup.daemon = await stopManagedDaemon(managedDaemon);
    if (session && !cleanup.daemon.stopped) {
      lifecycleFailures.push(boundedFailure(
        cleanup.daemon.error ?? "Benchmark daemon did not stop.",
        "shutdown",
      ));
    }
    harness.healthy = lifecycleFailures.length === 0;
    if (!harness.healthy) diagnostics.workspaceRoot = root;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (lifecycleFailures.length === 0) {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else {
      console.error(`Preserving failed case workspace: ${root}`);
    }
    timings.cleanupMs = Date.now() - cleanupStartedAt;
    timings.totalMs = Date.now() - caseStartedAt;
    timings.completedAt = new Date().toISOString();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const runStartedAt = Date.now();
  const args = parseArguments(argv);
  const dataBytes = readFileSync(resolve(args.dataPath));
  const data = JSON.parse(dataBytes.toString("utf8"));
  const byId = new Map(data.map((entry) => [entry.question_id, entry]));
  const selected = args.caseIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Case not found: ${id}`);
    return entry;
  });

  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(args.provider, args.modelId);
  if (!model) throw new Error(`Model not found: ${args.model}`);
  const available = await modelRuntime.getAvailable();
  if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
    throw new Error(`Model is not authenticated: ${args.model}`);
  }
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/pi.ts");
  const manifest = {
    format: "context-window.pi-longmemeval-s-manifest.v1",
    systemUnderTest: "Pi harness + selected model + context-window extension/tools + RocksDB daemon",
    datasetSha256: sha256(dataBytes),
    caseIds: [...args.caseIds],
    model: { provider: model.provider, id: model.id, api: model.api },
    thinking: args.thinking,
    repetitions: args.repetitions,
    extensionPath,
    extensionSha256: sha256(readFileSync(extensionPath)),
    directArchiveQueries: false,
  };
  manifest.fingerprint = sha256(Buffer.from(JSON.stringify(manifest)));

  const cases = [];
  for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
    for (const entry of selected) {
      console.error(`Running ${entry.question_id} through Pi (${repetition}/${args.repetitions})...`);
      const result = await runCase(entry, { modelRuntime, model, thinking: args.thinking, extensionPath });
      result.repetition = repetition;
      cases.push(result);
    }
  }
  const reliability = Object.fromEntries(selected.map((entry) => {
    const attempts = cases.filter(({ questionId }) => questionId === entry.question_id);
    const passed = attempts.filter(evaluationCasePassed).length;
    return [entry.question_id, { passed, total: attempts.length, rate: passed / attempts.length }];
  }));
  const artifact = {
    format: "context-window.pi-longmemeval-s-result.v1",
    manifest,
    passed: cases.every(evaluationCasePassed),
    reliability,
    timing: {
      startedAt: new Date(runStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      totalMs: Date.now() - runStartedAt,
    },
    cases,
  };
  artifact.fingerprint = sha256(Buffer.from(JSON.stringify(artifact)));
  const outputPath = resolve(args.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    passed: artifact.passed,
    timing: artifact.timing,
    reliability,
    cases: cases.map(({ questionId, repetition, score, harness, searchCallCount, traverseCallCount, recallCallCount, timings, usage }) => ({
      questionId,
      repetition,
      passed: evaluationCasePassed({ score, harness }),
      answerPassed: score.passed,
      harnessHealthy: harness.healthy,
      searchCallCount,
      traverseCallCount,
      recallCallCount,
      timings,
      usage,
    })),
  }, null, 2));
  if (!artifact.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
