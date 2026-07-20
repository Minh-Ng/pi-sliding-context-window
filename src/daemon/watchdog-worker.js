import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import {
  MAX_DAEMON_SAMPLE_BYTES,
  capDaemonArtifact,
  closeDaemonLog,
  openDaemonLog,
  rotateDaemonArtifact,
  writeDaemonLog,
} from "./log-file.js";
import { createWatchdogState, inspectWatchdogState } from "./watchdog-state.js";

const heartbeat = new Int32Array(workerData.heartbeat);
const activeRequests = new Map();
const writer = openDaemonLog(workerData.logPath);
const logPath = writer.path;
let watchdogState = createWatchdogState(Atomics.load(heartbeat, 0), Date.now());
let sampleInFlight = false;
let lastSampleAt = 0;
let shuttingDown = false;

function log(event, details = {}) {
  writeDaemonLog(writer, {
    timestamp: new Date().toISOString(),
    processId: workerData.processId,
    event,
    ...details,
  });
}

function captureSample(stallMs) {
  if (!workerData.sampleOnStall
    || sampleInFlight
    || Date.now() - lastSampleAt < 60_000) return;
  sampleInFlight = true;
  lastSampleAt = Date.now();
  const samplePath = `${logPath}.sample.txt`;
  try {
    rotateDaemonArtifact(samplePath, { maxBytes: MAX_DAEMON_SAMPLE_BYTES });
  } catch (error) {
    log("stall-sample-rotation-error", { message: String(error?.message ?? error).slice(0, 1_024) });
  }
  const child = spawn(workerData.sampleCommand, [
    ...workerData.sampleCommandArguments,
    String(workerData.processId),
    "1",
    "1",
    "-file",
    samplePath,
  ], { stdio: "ignore", windowsHide: true });
  child.once("error", (error) => {
    sampleInFlight = false;
    if (shuttingDown) return;
    log("stall-sample-error", {
      stallMs,
      message: String(error?.message ?? error).slice(0, 1_024),
    });
  });
  child.once("exit", (code, signal) => {
    sampleInFlight = false;
    if (shuttingDown) return;
    try {
      capDaemonArtifact(samplePath, { maxBytes: MAX_DAEMON_SAMPLE_BYTES });
    } catch (error) {
      log("stall-sample-cap-error", {
        message: String(error?.message ?? error).slice(0, 1_024),
      });
    }
    log("stall-sample-complete", {
      stallMs,
      samplePath,
      code: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
    });
  });
  child.unref();
}

function inspectHeartbeat() {
  const inspected = inspectWatchdogState(watchdogState, {
    heartbeat: Atomics.load(heartbeat, 0),
    now: Date.now(),
    stallThresholdMs: workerData.stallThresholdMs,
    maxInspectionGapMs: Math.max(
      workerData.stallThresholdMs,
      workerData.checkIntervalMs * 8,
    ),
  });
  watchdogState = inspected.state;
  if (inspected.event?.type === "inspection-gap") {
    log("watchdog-inspection-gap", { inspectionGapMs: inspected.event.inspectionGapMs });
    return;
  }
  if (inspected.event?.type !== "stall") return;
  const { stallMs } = inspected.event;
  log("event-loop-stall", {
    stallMs,
    activeRequests: [...activeRequests.values()].map((request) => ({
      operation: request.operation,
      requestBytes: request.requestBytes,
      elapsedMs: Math.max(0, Date.now() - request.startedAt),
    })),
  });
  captureSample(stallMs);
}

const timer = setInterval(inspectHeartbeat, workerData.checkIntervalMs);

parentPort.on("message", (message) => {
  if (message.type === "request-start") {
    activeRequests.set(message.token, {
      operation: message.operation,
      requestBytes: message.requestBytes,
      startedAt: message.startedAt,
    });
    return;
  }
  if (message.type === "request-finish") {
    activeRequests.delete(message.token);
    if (message.durationMs >= workerData.slowRequestMs) {
      log("slow-request", {
        operation: message.operation,
        requestBytes: message.requestBytes,
        durationMs: message.durationMs,
        ok: message.ok,
      });
    }
    return;
  }
  if (message.type === "log") {
    log(message.event, message.details);
    return;
  }
  if (message.type === "shutdown") {
    clearInterval(timer);
    log("watchdog-stopped");
    shuttingDown = true;
    closeDaemonLog(writer);
    parentPort.close();
  }
});

log("watchdog-started", {
  stallThresholdMs: workerData.stallThresholdMs,
  slowRequestMs: workerData.slowRequestMs,
});
parentPort.postMessage({ type: "ready", logPath });
