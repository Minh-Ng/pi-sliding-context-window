import { randomUUID } from "node:crypto";
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from "node:worker_threads";
import { DAEMON_RUNTIME_VERSION } from "../daemon/runtime-version.js";

const POLL_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function positiveInteger(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function remoteError(value) {
  const error = new Error(value?.message ?? "Synchronous daemon request failed.");
  error.name = value?.name ?? "Error";
  if (value?.code !== undefined) error.code = value.code;
  if (value?.retryable !== undefined) error.retryable = value.retryable;
  if (value?.details !== undefined) error.details = value.details;
  if (value?.stack) error.stack = value.stack;
  return error;
}

/**
 * Blocking bridge for legacy synchronous hosts. Network I/O and daemon
 * lifecycle work remain asynchronous inside a dedicated worker thread.
 */
export class SynchronousStoreBridge {
  constructor({
    storePath,
    socketPath,
    project,
    aliasProjects,
    clientVersion = "0.1.0",
    requestTimeoutMs = 90_000,
    daemonStartTimeoutMs = 30_000,
    semantic,
    daemonLogPath,
    autoUpgradeDaemon = false,
    daemonRuntimeVersion = DAEMON_RUNTIME_VERSION,
    requiredCapabilities = [],
    daemonLaunchLogPath,
  }) {
    if (typeof storePath !== "string" || !storePath) throw new TypeError("storePath is required.");
    if (typeof socketPath !== "string" || !socketPath) throw new TypeError("socketPath is required.");
    if (typeof project !== "string" || !project) throw new TypeError("project is required.");
    this.requestTimeoutMs = positiveInteger(requestTimeoutMs, 90_000, "requestTimeoutMs");
    this.daemonStartTimeoutMs = positiveInteger(
      daemonStartTimeoutMs,
      30_000,
      "daemonStartTimeoutMs",
    );
    this.workerOptions = {
      storePath,
      socketPath,
      project,
      ...(Array.isArray(aliasProjects) && aliasProjects.length > 0
        ? { aliasProjects }
        : {}),
      clientVersion,
      requestTimeoutMs: this.requestTimeoutMs,
      daemonStartTimeoutMs: this.daemonStartTimeoutMs,
      autoUpgradeDaemon: autoUpgradeDaemon === true,
      daemonRuntimeVersion,
      requiredCapabilities: [...new Set(requiredCapabilities)],
      ...(semantic === undefined ? {} : { semantic }),
      ...(daemonLogPath === undefined ? {} : { daemonLogPath }),
      ...(daemonLaunchLogPath === undefined ? {} : { daemonLaunchLogPath }),
    };
    this.sequence = 0;
    this.closed = false;
    this.failed = false;
    this.#initializeWorker();
  }

  #initializeWorker() {
    this.signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.start();
    this.worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: {
        port: channel.port2,
        signal: this.signal.buffer,
        options: this.workerOptions,
      },
      transferList: [channel.port2],
      // Do not forward host/test-runner process flags. Several valid parent
      // flags are forbidden for workers, and the bridge needs no CLI flags.
      execArgv: [],
    });
    // All operational failures are returned through the shared bridge. This
    // listener prevents an asynchronous worker error from becoming uncaught
    // while a synchronous caller waits for its timeout.
    this.worker.on("error", () => {});
    try {
      this.call("initialize", {}, {
        timeoutMs: Math.max(this.requestTimeoutMs, this.daemonStartTimeoutMs + 5_000),
      });
    } catch (error) {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
      throw error;
    }
  }

  #recoverFailedWorker() {
    this.port.close();
    void this.worker.terminate();
    this.failed = false;
    this.closed = false;
    this.#initializeWorker();
  }

  call(method, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) throw new Error("Synchronous store bridge is closed.");
    if (this.failed) throw new Error("Synchronous store bridge is unusable after a timed-out request.");
    const id = ++this.sequence;
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage({ id, method, ...payload });
    const wait = Atomics.wait(this.signal, 0, 0, positiveInteger(timeoutMs, this.requestTimeoutMs, "timeoutMs"));
    if (wait === "timed-out") {
      this.failed = true;
      void this.worker.terminate();
      const error = new Error(`Synchronous store request ${method} timed out.`);
      error.code = "CONNECTION_CLOSED";
      error.retryable = true;
      throw error;
    }

    // postMessage queues the structured response before the worker publishes
    // the atomic completion signal. Keep a narrow defensive poll for runtime
    // implementations that expose the queue one tick later.
    const receiveDeadline = Date.now() + 1_000;
    let received = receiveMessageOnPort(this.port);
    while (!received && Date.now() < receiveDeadline) {
      Atomics.wait(POLL_SIGNAL, 0, 0, 1);
      received = receiveMessageOnPort(this.port);
    }
    if (!received || received.message?.id !== id) {
      this.failed = true;
      void this.worker.terminate();
      throw new Error(`Synchronous store response ${id} was not available after notification.`);
    }
    if (!received.message.ok) throw remoteError(received.message.error);
    return received.message.value;
  }

  request(operation, payload, {
    requestId = randomUUID(),
    timeoutMs = this.requestTimeoutMs + this.daemonStartTimeoutMs + 5_000,
  } = {}) {
    return this.call("request", { operation, payload, requestId }, { timeoutMs });
  }

  restart(reason = "operator requested restart") {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 4_096) {
      throw new TypeError("restart reason must contain 1 to 4,096 characters.");
    }
    if (this.failed) this.#recoverFailedWorker();
    return this.call("restart", { reason }, {
      timeoutMs: this.requestTimeoutMs + this.daemonStartTimeoutMs + 10_000,
    });
  }

  close() {
    if (this.closed) return;
    try {
      if (!this.failed) this.call("close");
    } finally {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
    }
  }
}
