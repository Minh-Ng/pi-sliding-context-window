import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { StoreClient } from "../src/store/store-client.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const piExecutable = join(repositoryRoot, "node_modules", ".bin", "pi");
const extensionPath = join(repositoryRoot, "extensions", "pi.ts");

function processAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(processId, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processAlive(processId)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !processAlive(processId);
}

function filesBelow(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

test("Pi launches the explicit local extension offline without persistent session or model work", {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-pi-launch-"));
  const home = join(root, "home");
  const agentDirectory = join(root, "pi-agent");
  const sessionDirectory = join(root, "sessions");
  const projectDirectory = join(root, "project");
  const storePath = join(root, "store", "archive.rocks");
  const socketPath = join(root, "socket", "daemon.sock");
  const sqlitePath = join(root, "legacy", "archive.db");
  for (const directory of [home, agentDirectory, sessionDirectory, projectDirectory, dirname(storePath), dirname(socketPath)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  let modelRequestCount = 0;
  const modelServer = createServer((_request, response) => {
    modelRequestCount += 1;
    response.writeHead(503).end();
  });
  const modelPort = await listen(modelServer);
  writeFileSync(join(agentDirectory, "models.json"), `${JSON.stringify({
    providers: {
      "offline-fixture": {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: "openai-completions",
        apiKey: "offline-fixture-placeholder",
        models: [{
          id: "dummy",
          name: "Offline fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 32_000,
          maxTokens: 1_024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`);

  const stdoutLines = [];
  const parsedStdout = [];
  let stdoutBuffer = "";
  let stderr = "";
  let child;
  let daemonProcessId;
  let daemonCleaned = false;
  let inspector;

  try {
    child = spawn(piExecutable, [
      "--mode", "rpc",
      "--offline",
      "--no-session",
      "--session-dir", sessionDirectory,
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--no-tools",
      "--model", "offline-fixture/dummy",
    ], {
      cwd: projectDirectory,
      env: {
        PATH: process.env.PATH ?? dirname(process.execPath),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: root,
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        CONTEXT_WINDOW_BACKEND: "rocksdb",
        CONTEXT_WINDOW_ROCKSDB: storePath,
        CONTEXT_WINDOW_SOCKET: socketPath,
        CONTEXT_WINDOW_DB: sqlitePath,
        CONTEXT_WINDOW_NODE: process.execPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const processExit = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const requestId = "offline-launch-state";
    const stateResponse = new Promise((resolveResponse, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("Pi get_state response timed out"));
      }, 30_000);
      const failBeforeResponse = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Pi exited before the get_state response"));
      };
      child.once("error", failBeforeResponse);
      child.once("exit", failBeforeResponse);
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          stdoutLines.push(line);
          try {
            const record = JSON.parse(line);
            parsedStdout.push(record);
            if (record?.id === requestId && record?.type === "response") {
              settled = true;
              clearTimeout(timer);
              resolveResponse(record);
            }
          } catch {
            // Every collected line is rejected after the child exits; retain it verbatim here.
          }
        }
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);
    const response = await stateResponse;

    inspector = new StoreClient({
      socketPath,
      project: projectDirectory,
      client: "pi-launch-verifier",
      requestTimeoutMs: 5_000,
    });
    const daemonHandshake = await inspector.connect();
    daemonProcessId = daemonHandshake.processId;
    assert.equal(Number.isSafeInteger(daemonProcessId) && daemonProcessId > 0, true);
    inspector.close();
    inspector = undefined;

    child.stdin.end();
    const exit = await processExit;
    if (stdoutBuffer.length > 0) {
      stdoutLines.push(stdoutBuffer);
      try { parsedStdout.push(JSON.parse(stdoutBuffer)); } catch {}
      stdoutBuffer = "";
    }

    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(stderr, "");
    assert.equal(stdoutLines.length > 0, true);
    assert.equal(parsedStdout.length, stdoutLines.length, "every stdout line must be JSON");
    assert.equal(response.command, "get_state");
    assert.equal(response.success, true);
    assert.equal(response.data.model.provider, "offline-fixture");
    assert.equal(response.data.model.id, "dummy");
    assert.equal(response.data.sessionFile == null, true);
    assert.equal(response.data.messageCount, 0);
    assert.equal(response.data.pendingMessageCount, 0);
    assert.equal(response.data.isStreaming, false);
    assert.equal(response.data.isCompacting, false);
    assert.deepEqual(filesBelow(sessionDirectory), []);
    assert.equal(modelRequestCount, 0);
    assert.equal(parsedStdout.some((record) =>
      record?.type === "extension_ui_request"
      && record?.method === "setStatus"
      && record?.statusKey === "context-window"
      && typeof record?.statusText === "string"
      && record.statusText.includes("Epoch")), true);

    assert.equal(processAlive(daemonProcessId), true);
    process.kill(daemonProcessId, "SIGTERM");
    daemonCleaned = await waitForProcessExit(daemonProcessId);
    assert.equal(daemonCleaned, true, "the exact context-window daemon PID must exit after SIGTERM");
  } finally {
    inspector?.close();
    if (child?.exitCode === null && child?.signalCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    if (daemonProcessId && !daemonCleaned && processAlive(daemonProcessId)) {
      process.kill(daemonProcessId, "SIGTERM");
      if (!await waitForProcessExit(daemonProcessId, 2_000) && processAlive(daemonProcessId)) {
        process.kill(daemonProcessId, "SIGKILL");
        await waitForProcessExit(daemonProcessId, 2_000);
      }
    }
    await closeServer(modelServer);
    rmSync(root, { recursive: true, force: true });
  }
});
