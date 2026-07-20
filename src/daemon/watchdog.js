import { Worker } from "node:worker_threads";

export const DEFAULT_STALL_THRESHOLD_MS = 1_000;
export const DEFAULT_SLOW_REQUEST_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 100;
const DEFAULT_SAMPLE_COMMAND = "/usr/bin/sample";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export class DaemonWatchdog {
  constructor({
    logPath,
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
    slowRequestMs = DEFAULT_SLOW_REQUEST_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    sampleOnStall = process.platform === "darwin",
    sampleCommand = DEFAULT_SAMPLE_COMMAND,
    sampleCommandArguments = [],
  }) {
    if (typeof logPath !== "string" || logPath.length === 0) {
      throw new TypeError("DaemonWatchdog requires logPath.");
    }
    this.stallThresholdMs = positiveInteger(stallThresholdMs, "stallThresholdMs");
    this.slowRequestMs = positiveInteger(slowRequestMs, "slowRequestMs");
    this.heartbeatIntervalMs = positiveInteger(heartbeatIntervalMs, "heartbeatIntervalMs");
    if (typeof sampleCommand !== "string" || sampleCommand.length === 0) {
      throw new TypeError("sampleCommand must be a non-empty string.");
    }
    if (!Array.isArray(sampleCommandArguments)
      || sampleCommandArguments.some((argument) => typeof argument !== "string")) {
      throw new TypeError("sampleCommandArguments must contain strings.");
    }
    this.heartbeat = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    this.nextToken = 1;
    this.closed = false;
    this.worker = new Worker(new URL("./watchdog-worker.js", import.meta.url), {
      workerData: {
        heartbeat: this.heartbeat.buffer,
        logPath,
        processId: process.pid,
        stallThresholdMs: this.stallThresholdMs,
        slowRequestMs: this.slowRequestMs,
        sampleOnStall: sampleOnStall === true,
        sampleCommand,
        sampleCommandArguments,
        checkIntervalMs: Math.max(10, Math.min(this.heartbeatIntervalMs, Math.floor(this.stallThresholdMs / 4))),
      },
    });
    this.worker.on("error", () => { /* daemon operation remains available without diagnostics */ });
    this.exitPromise = new Promise((resolve) => this.worker.once("exit", resolve));
    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        this.worker.off("error", onError);
        this.worker.unref();
        resolve(message.logPath);
      };
      const onError = (error) => {
        this.worker.off("message", onMessage);
        reject(error);
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
    });
    this.timer = setInterval(() => {
      Atomics.add(this.heartbeat, 0, 1);
    }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  ready() {
    return this.readyPromise;
  }

  requestStarted({ operation, requestBytes, startedAt }) {
    if (this.closed) return undefined;
    const token = this.nextToken;
    this.nextToken += 1;
    this.worker.postMessage({
      type: "request-start",
      token,
      operation,
      requestBytes,
      startedAt,
    });
    return token;
  }

  requestFinished(token, details) {
    if (this.closed || token === undefined) return;
    this.worker.postMessage({ type: "request-finish", token, ...details });
  }

  log(event, details = {}) {
    if (this.closed) return;
    this.worker.postMessage({ type: "log", event, details });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.worker.ref();
    if (this.worker.threadId >= 0) this.worker.postMessage({ type: "shutdown" });
    await this.exitPromise;
  }
}
