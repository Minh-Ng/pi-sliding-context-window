import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { defaultDaemonLaunchLogPath } from "../src/daemon/log-file.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  DAEMON_REQUIRED_CAPABILITIES,
  DAEMON_RUNTIME_VERSION,
} from "../src/daemon/runtime-version.js";

const staleFixture = fileURLToPath(new URL("../test-support/stale-store-daemon.js", import.meta.url));
const clientFixture = fileURLToPath(new URL("../test-support/daemon-archive-client.js", import.meta.url));

function fixture(prefix = "context-window-upgrade-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const storePath = join(directory, "archive.rocks");
  return {
    directory,
    storePath,
    socketPath: defaultSocketPath(storePath),
    project: join(directory, "project"),
  };
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(processId) {
  if (!processExists(processId)) return;
  process.kill(processId, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) process.kill(processId, "SIGKILL");
}

async function startStale(paths, {
  storePath = paths.storePath,
  compatible = false,
} = {}) {
  const child = spawn(process.execPath, [
    staleFixture,
    storePath,
    paths.socketPath,
    "context-windowd:stale-fixture",
    compatible ? "compatible" : "minimal",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exit = once(child, "exit");
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    exit.then(([code, signal]) => {
      throw new Error(`stale daemon exited before ready: ${code}/${signal}: ${stderr}`);
    }),
  ]);
  lines.close();
  return { child, processId: ready.processId, exit };
}

function runCurrentClient(paths) {
  const child = spawn(process.execPath, [
    clientFixture,
    paths.storePath,
    paths.socketPath,
    paths.project,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return once(child, "exit").then(([code, signal]) => {
    assert.equal(code, 0, `${signal ?? "no-signal"}: ${stderr}`);
    return JSON.parse(stdout.trim());
  });
}

function upgradeEvents(storePath) {
  const path = defaultDaemonLaunchLogPath(storePath);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(({ event }) => event === "daemon-upgrade-requested");
}

test("a current facade transparently replaces a verified stale daemon", async (t) => {
  const paths = fixture();
  const stale = await startStale(paths);
  let archive;
  let replacementProcessId;
  t.after(async () => {
    try { archive?.close({ releaseProtection: false }); } catch {}
    await stopProcess(replacementProcessId);
    await stopProcess(stale.processId);
    rmSync(paths.directory, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  archive = new DaemonArchive({
    ...paths,
    requestTimeoutMs: 10_000,
    daemonStartTimeoutMs: 10_000,
  });
  const status = archive.stats();
  replacementProcessId = status.processId;
  assert.notEqual(replacementProcessId, stale.processId);
  assert.equal(status.runtimeVersion, DAEMON_RUNTIME_VERSION);
  assert.ok(Date.now() - startedAt < 10_000);
  const [staleExitCode] = await stale.exit;
  assert.equal(staleExitCode, 0);
  assert.equal(processExists(stale.processId), false);

  const second = new DaemonArchive({
    ...paths,
    requestTimeoutMs: 10_000,
    daemonStartTimeoutMs: 10_000,
  });
  try {
    assert.equal(second.stats().processId, replacementProcessId);
    assert.equal(second.stats().runtimeVersion, DAEMON_RUNTIME_VERSION);
  } finally {
    second.close({ releaseProtection: false });
  }

  const events = upgradeEvents(paths.storePath);
  assert.equal(events.length, 1);
  assert.equal(events[0].processId, stale.processId);
  assert.equal(events[0].observedRuntime, "context-windowd:stale-fixture");
  assert.equal(events[0].expectedRuntime, DAEMON_RUNTIME_VERSION);
  assert.deepEqual(
    events[0].missingCapabilities,
    DAEMON_REQUIRED_CAPABILITIES.filter((capability) => ![
      "daemon.status",
      "daemon.ping",
    ].includes(capability)),
  );
});

test("a runtime mismatch alone does not replace a capability-compatible shared daemon", async (t) => {
  const paths = fixture("context-window-upgrade-compatible-");
  const stale = await startStale(paths, { compatible: true });
  let archive;
  t.after(async () => {
    try { archive?.close({ releaseProtection: false }); } catch {}
    await stopProcess(stale.processId);
    rmSync(paths.directory, { recursive: true, force: true });
  });

  archive = new DaemonArchive({
    ...paths,
    requestTimeoutMs: 10_000,
    daemonStartTimeoutMs: 10_000,
  });
  const status = archive.daemonStatus();
  assert.equal(status.processId, stale.processId);
  assert.equal(status.runtimeVersion, "context-windowd:stale-fixture");
  assert.equal(status.runtimeMatches, false);
  assert.equal(processExists(stale.processId), true);
  assert.equal(upgradeEvents(paths.storePath).length, 0);
});

test("concurrent current clients converge on one replacement daemon", async (t) => {
  const paths = fixture("context-window-upgrade-concurrent-");
  const stale = await startStale(paths);
  let replacementProcessId;
  t.after(async () => {
    await stopProcess(replacementProcessId);
    await stopProcess(stale.processId);
    rmSync(paths.directory, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runCurrentClient(paths),
    runCurrentClient(paths),
  ]);
  replacementProcessId = first.processId;
  assert.equal(first.processId, second.processId);
  assert.notEqual(first.processId, stale.processId);
  assert.equal(first.runtimeVersion, DAEMON_RUNTIME_VERSION);
  assert.equal(second.runtimeVersion, DAEMON_RUNTIME_VERSION);
  const [staleExitCode, staleExitSignal] = await stale.exit;
  assert.equal(staleExitCode, 0, `unexpected stale-daemon signal: ${staleExitSignal}`);
  assert.equal(processExists(stale.processId), false);
  assert.equal(upgradeEvents(paths.storePath).length, 1);
});

test("a wrong-store socket is rejected without signaling its daemon", async (t) => {
  const paths = fixture("context-window-upgrade-wrong-store-");
  const ownedStorePath = join(paths.directory, "owned.rocks");
  const stale = await startStale(paths, { storePath: ownedStorePath });
  t.after(async () => {
    await stopProcess(stale.processId);
    rmSync(paths.directory, { recursive: true, force: true });
  });

  assert.throws(() => new DaemonArchive({
    ...paths,
    requestTimeoutMs: 2_000,
    daemonStartTimeoutMs: 2_000,
  }), /owns .*owned\.rocks, not .*archive\.rocks/u);
  assert.equal(processExists(stale.processId), true);
  assert.equal(upgradeEvents(paths.storePath).length, 0);
});
