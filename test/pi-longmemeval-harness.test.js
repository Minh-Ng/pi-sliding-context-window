import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import {
  benchmarkEnvironment,
  bindEvaluationSession,
  boundedFailure,
  createCaseWorkspace,
  evaluationCasePassed,
  parseSessionDate,
  SAFE_UNIX_SOCKET_PATH_BYTES,
  seedHistory,
  shutdownEvaluationSession,
  startManagedDaemon,
  stopManagedDaemon,
  temporaryRootForSocket,
} from "../eval/agent-memory/pi-longmemeval-s.js";

test("benchmark workspace keeps daemon socket paths portable and disposable", (t) => {
  const workspace = createCaseWorkspace();
  t.after(() => rmSync(workspace.root, { recursive: true, force: true }));

  assert.equal(existsSync(workspace.cwd), true);
  if (process.platform !== "win32") {
    assert.ok(Buffer.byteLength(workspace.socketPath, "utf8") <= SAFE_UNIX_SOCKET_PATH_BYTES);
  }
  assert.equal(
    temporaryRootForSocket({ platform: "darwin", preferredRoot: `/${"long/".repeat(30)}` }),
    "/tmp",
  );
});

test("benchmark environment preserves historical dates through explicit retention", () => {
  const workspace = {
    storePath: "/tmp/store",
    socketPath: "/tmp/socket",
    sqlitePath: "/tmp/source",
    semanticIndexPath: "/tmp/semantic-index",
  };
  const environment = benchmarkEnvironment(workspace);

  assert.equal(environment.CONTEXT_WINDOW_BACKEND, "rocksdb");
  assert.equal(environment.CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS, "10000");
  assert.equal(environment.CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS, "10000");
  assert.equal(environment.CONTEXT_WINDOW_SEMANTIC_RETRIEVAL, "1");
  assert.equal(environment.CONTEXT_WINDOW_SEMANTIC_INDEX, "/tmp/semantic-index");
  assert.equal(parseSessionDate("2023/05/21 (Sun) 05:48", 0), Date.UTC(2023, 4, 21, 5, 48));
});

test("history seeding retains source chronology without model calls", () => {
  const messages = [];
  const sessionManager = { appendMessage: (message) => messages.push(message) };
  const count = seedHistory(sessionManager, {
    haystack_dates: ["2023/05/21 (Sun) 05:48"],
    haystack_sessions: [[
      { role: "user", content: "I bought a pressure cooker." },
      { role: "assistant", content: "Noted." },
    ]],
  }, { api: "test", provider: "test", id: "test-model" });

  assert.equal(count, 2);
  assert.equal(messages[0].timestamp, Date.UTC(2023, 4, 21, 5, 48));
  assert.match(messages[0].content, /^\[History session date: 2023\/05\/21/);
  assert.equal(messages[1].timestamp, messages[0].timestamp + 1);
});

test("managed benchmark daemon is owned and reaped by the harness", { timeout: 30_000 }, async (t) => {
  const workspace = createCaseWorkspace();
  let managed;
  t.after(async () => {
    if (managed) await stopManagedDaemon(managed);
    rmSync(workspace.root, { recursive: true, force: true });
  });

  managed = await startManagedDaemon(workspace, workspace.cwd);
  assert.ok(Number.isSafeInteger(managed.processId) && managed.processId > 0);
  const stopped = await stopManagedDaemon(managed);
  managed = undefined;

  assert.equal(stopped.stopped, true);
  assert.equal(stopped.reaped, true);
});

test("Pi lifecycle binding precedes graceful extension shutdown", async () => {
  const order = [];
  const failures = [];
  let listener;
  const session = {
    subscribe(callback) {
      listener = callback;
      order.push("subscribe");
    },
    async bindExtensions({ mode, onError }) {
      order.push(`bind:${mode}`);
      listener({ type: "extension_error", event: "fixture", error: "first" });
      onError({ event: "fixture", error: "second" });
    },
    extensionRunner: {
      hasHandlers: (event) => event === "session_shutdown",
      async emit(event) { order.push(`emit:${event.type}:${event.reason}`); },
    },
    dispose() { order.push("dispose"); },
  };

  await bindEvaluationSession(session, failures);
  await shutdownEvaluationSession(session);

  assert.deepEqual(order, ["subscribe", "bind:json", "emit:session_shutdown:quit", "dispose"]);
  assert.deepEqual(failures.map(({ message }) => message), ["first", "second"]);
});

test("answer success cannot mask an unhealthy Pi harness", () => {
  assert.equal(evaluationCasePassed({ score: { passed: true }, harness: { healthy: true } }), true);
  assert.equal(evaluationCasePassed({ score: { passed: true }, harness: { healthy: false } }), false);
  assert.equal(evaluationCasePassed({ score: { passed: false }, harness: { healthy: true } }), false);
});

test("harness failure diagnostics are bounded and omit stacks", () => {
  const failure = boundedFailure({
    event: "session_start",
    error: "x".repeat(10_000),
    stack: "secret stack",
    extensionPath: "/tmp/extension.ts",
  });

  assert.equal(failure.phase, "session_start");
  assert.equal(failure.message.length, 4_000);
  assert.equal(failure.extensionPath, "/tmp/extension.ts");
  assert.equal("stack" in failure, false);
});
