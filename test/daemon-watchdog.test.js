import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonWatchdog } from "../src/daemon/watchdog.js";
import { createWatchdogState, inspectWatchdogState } from "../src/daemon/watchdog-state.js";
import {
  MAX_DAEMON_LOG_BYTES,
  MAX_DAEMON_SAMPLE_BYTES,
  appendDaemonLog,
  openDaemonLog,
} from "../src/daemon/log-file.js";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

test("daemon watchdog logs stalls and slow operations without request payloads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-watchdog-"));
  const logPath = join(directory, "daemon.jsonl");
  const watchdog = new DaemonWatchdog({
    logPath,
    stallThresholdMs: 40,
    slowRequestMs: 10,
    heartbeatIntervalMs: 5,
    sampleOnStall: false,
  });
  try {
    await watchdog.ready();
    const token = watchdog.requestStarted({
      operation: "store.search",
      requestBytes: 512,
      startedAt: Date.now(),
    });
    const secondToken = watchdog.requestStarted({
      operation: "store.put",
      requestBytes: 1_024,
      startedAt: Date.now(),
    });
    const blockedUntil = Date.now() + 150;
    while (Date.now() < blockedUntil) { /* deliberately block the main thread */ }
    watchdog.requestFinished(token, {
      operation: "store.search",
      requestBytes: 512,
      durationMs: 150,
      completedAt: Date.now(),
      ok: true,
      stageTimings: { candidateSearchMs: 40, requestOtherMs: 110 },
    });
    watchdog.requestFinished(secondToken, {
      operation: "store.put",
      requestBytes: 1_024,
      durationMs: 151,
      completedAt: Date.now(),
      ok: false,
    });
    await delay(80);
    const secondBlockedUntil = Date.now() + 150;
    while (Date.now() < secondBlockedUntil) { /* background main-thread stall */ }
    await delay(80);
  } finally {
    await watchdog.close();
  }

  const events = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  const stalls = events.filter(({ event }) => event === "event-loop-stall");
  const stall = stalls[0];
  assert.ok(stall, "watchdog did not record the main-thread stall");
  assert.ok(stall.stallMs >= 40);
  assert.deepEqual(stall.activeRequests.map(({ operation, requestBytes }) => ({
    operation,
    requestBytes,
  })), [
    { operation: "store.search", requestBytes: 512 },
    { operation: "store.put", requestBytes: 1_024 },
  ]);
  assert.equal(stalls.length, 2);
  assert.deepEqual(stalls[1].activeRequests, []);
  assert.ok(events.some(({ event, operation, durationMs, stageTimings }) =>
    event === "slow-request"
      && operation === "store.search"
      && durationMs === 150
      && stageTimings?.candidateSearchMs === 40));
  assert.ok(events.some(({ event, operation, ok }) =>
    event === "slow-request" && operation === "store.put" && ok === false));
  assert.doesNotMatch(readFileSync(logPath, "utf8"), /payload|secret/iu);
  rmSync(directory, { recursive: true, force: true });
});

test("watchdog state suppresses system-suspend gaps and rearms after recovery", () => {
  let state = createWatchdogState(1, 1_000);
  let inspected = inspectWatchdogState(state, {
    heartbeat: 1,
    now: 1_050,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  });
  assert.equal(inspected.event, undefined);
  state = inspected.state;

  inspected = inspectWatchdogState(state, {
    heartbeat: 1,
    now: 1_100,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  });
  assert.deepEqual(inspected.event, { type: "stall", stallMs: 100 });
  state = inspected.state;
  assert.equal(inspectWatchdogState(state, {
    heartbeat: 1,
    now: 1_150,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  }).event, undefined);

  state = inspectWatchdogState(state, {
    heartbeat: 2,
    now: 1_175,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  }).state;
  inspected = inspectWatchdogState(state, {
    heartbeat: 2,
    now: 1_275,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  });
  assert.deepEqual(inspected.event, { type: "stall", stallMs: 100 });

  inspected = inspectWatchdogState(inspected.state, {
    heartbeat: 2,
    now: 11_275,
    stallThresholdMs: 100,
    maxInspectionGapMs: 200,
  });
  assert.deepEqual(inspected.event, { type: "inspection-gap", inspectionGapMs: 10_000 });
  assert.equal(inspected.state.stallReported, false);
});

test("daemon logs stay strictly size-bounded, private, complete, and symlink-safe", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-log-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, "daemon.jsonl");
  const maxBytes = 1_024;
  writeFileSync(logPath, "x".repeat(MAX_DAEMON_LOG_BYTES + 1), { mode: 0o666 });
  appendDaemonLog(logPath, { event: "legacy-rotated" }, { maxBytes });
  assert.ok(statSync(`${logPath}.1`).size <= maxBytes);

  for (let index = 0; index < 200; index += 1) {
    appendDaemonLog(logPath, {
      event: `event-${index}`,
      payload: "detail ".repeat(12),
    }, { maxBytes });
  }
  for (const path of [logPath, `${logPath}.1`]) {
    assert.ok(statSync(path).size <= maxBytes, path);
    assert.equal(statSync(path).mode & 0o077, 0);
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
  assert.ok(statSync(logPath).size + statSync(`${logPath}.1`).size <= maxBytes * 2);

  const secret = "OVERSIZED_LOG_SECRET_MUST_NOT_PERSIST";
  appendDaemonLog(logPath, {
    timestamp: new Date(0).toISOString(),
    processId: process.pid,
    event: "oversized",
    payload: secret.repeat(1_000),
  }, { maxBytes });
  const rendered = [logPath, `${logPath}.1`]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(rendered, new RegExp(secret, "u"));
  assert.match(rendered, /"event":"log-record-truncated"/u);

  if (process.platform !== "win32") {
    const target = join(directory, "target.log");
    const link = join(directory, "linked.log");
    writeFileSync(target, "target");
    symlinkSync(target, link);
    assert.throws(() => openDaemonLog(link), /regular file/u);
  }
});

test("concurrent lifecycle writers coordinate rotation without exceeding disk bounds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-log-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, "daemon-launch.log");
  const maxBytes = 4_096;
  const fixture = new URL("../test-support/daemon-log-writer.js", import.meta.url).pathname;
  const children = Array.from({ length: 4 }, (_, index) => spawn(process.execPath, [
    fixture,
    logPath,
    `writer-${index}`,
    "200",
    String(maxBytes),
  ], { stdio: "ignore" }));
  const exits = await Promise.all(children.map((child) => once(child, "exit")));
  assert.deepEqual(exits.map(([code]) => code), [0, 0, 0, 0]);
  for (const path of [logPath, `${logPath}.1`]) {
    assert.ok(statSync(path).size <= maxBytes, path);
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
  assert.ok(statSync(logPath).size + statSync(`${logPath}.1`).size <= maxBytes * 2);
  assert.equal(existsSync(`${logPath}.lock`), false);
});

test("watchdog captures and rotates an external stall sample", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-watchdog-sample-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, "daemon.jsonl");
  const samplePath = `${logPath}.sample.txt`;
  writeFileSync(samplePath, "previous sample\n");
  const watchdog = new DaemonWatchdog({
    logPath,
    stallThresholdMs: 40,
    slowRequestMs: 10,
    heartbeatIntervalMs: 5,
    sampleOnStall: true,
    sampleCommand: process.execPath,
    sampleCommandArguments: [
      new URL("../test-support/fake-sample.js", import.meta.url).pathname,
      "--bytes",
      String(MAX_DAEMON_SAMPLE_BYTES + 1_024),
    ],
  });
  try {
    await watchdog.ready();
    const blockedUntil = Date.now() + 150;
    while (Date.now() < blockedUntil) { /* trigger independent sampling */ }
    await waitFor(() => {
      if (!existsSync(logPath)) return false;
      return readFileSync(logPath, "utf8").includes('"event":"stall-sample-complete"');
    }, "watchdog sample did not complete");
  } finally {
    await watchdog.close();
  }
  assert.match(readFileSync(samplePath, "utf8"), /sampled process/u);
  assert.equal(readFileSync(`${samplePath}.1`, "utf8"), "previous sample\n");
  assert.ok(statSync(samplePath).size <= MAX_DAEMON_SAMPLE_BYTES);
  assert.ok(statSync(`${samplePath}.1`).size <= MAX_DAEMON_SAMPLE_BYTES);
  assert.equal(statSync(samplePath).mode & 0o077, 0);
});
