import { createHash } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { join } from "node:path";
import { fileLockRelease, tryFileLock } from "@harperfast/rocksdb-js";
import { ContractError } from "../store-contract.js";
import {
  STORE_OPERATIONS,
  STORE_PROTOCOL_VERSION,
  STORE_SCHEMA_VERSION,
  assertHandshakeRequest,
  assertRequestFrame,
  assertResponseFrame,
  createErrorResponse,
  createHandshakeAccepted,
  createHandshakeRejected,
  encodeProtocolFrame,
} from "../store-protocol.js";
import { DEFAULT_MAX_FRAME_BYTES, LineFramer } from "./framing.js";
import {
  defaultSocketPath,
  ensureSecureSocketDirectory,
  ensureSecureStoreDirectory,
  resolveStorePath,
} from "./paths.js";

const MAX_REPLAY_OUTCOMES = 10_000;
const MAX_REPLAY_OUTCOME_BYTES = 16 * 1_024 * 1_024;
const MAX_QUEUED_INPUT_BYTES = 16 * 1_024 * 1_024;
export const DEFAULT_MAX_CONNECTION_BUFFERED_FRAME_BYTES =
  DEFAULT_MAX_FRAME_BYTES + MAX_QUEUED_INPUT_BYTES;
export const DEFAULT_MAX_BUFFERED_FRAME_BYTES =
  DEFAULT_MAX_CONNECTION_BUFFERED_FRAME_BYTES;
export const DEFAULT_MAX_CONNECTION_BUFFERED_OUTPUT_BYTES =
  DEFAULT_MAX_FRAME_BYTES + 1;
// At most two full-frame materializations may run concurrently. Reserving
// before dispatch keeps handler objects under this gate as well as encoded
// socket buffers; shrinking to actual wire bytes admits only bounded followers.
export const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = (32 * 1_024 * 1_024) + 2;
const MAX_CONNECTIONS = 16;
const MAX_ACTIVE_REQUESTS = 32;
const MAX_ACTIVE_REQUEST_BYTES = 256 * 1_024 * 1_024;
const SHUTDOWN_SOCKET_DRAIN_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_SLOW_REQUESTS = 100;
const DEFAULT_SLOW_REQUEST_MS = 250;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

async function socketIsLive(path) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (live) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function prepareSocket(path) {
  ensureSecureSocketDirectory(path);
  if (!existsSync(path)) return;
  if (await socketIsLive(path)) {
    throw codedError("STORE_BUSY", `Daemon socket is already active at ${path}.`);
  }
  rmSync(path, { force: true });
}

function positiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function combinedLimit(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function parseRequestLine(line) {
  const source = line.toString("utf8");
  if (!source || /[\r\n]/u.test(source)) {
    throw new ContractError(
      "INVALID_REQUEST",
      "$",
      "must contain exactly one non-empty protocol line",
    );
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new ContractError("INVALID_REQUEST", "$", "must contain valid JSON");
  }
}

function createValidatedSuccessResponse(request, result) {
  return assertResponseFrame({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "response",
    requestId: request.requestId,
    operation: request.operation,
    ok: true,
    result,
  });
}

function normalizeStoreStatus(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Single-process owner for one RocksDB directory. Operation handlers are
 * injected so transport tests do not need a native database and later layers
 * can add indexing, recall, retention, and migration without changing IPC.
 */
export class StoreDaemon {
  constructor({
    storePath,
    socketPath,
    serverVersion = "0.1.0",
    createStore,
    operationHandlers = {},
    statusProvider,
    allowShutdown = false,
    maxFrameBytes,
    maxReplayOutcomes = MAX_REPLAY_OUTCOMES,
    maxReplayOutcomeBytes = MAX_REPLAY_OUTCOME_BYTES,
    maxQueuedInputBytes = MAX_QUEUED_INPUT_BYTES,
    maxConnectionBufferedFrameBytes,
    maxBufferedFrameBytes,
    maxConnectionBufferedOutputBytes,
    maxBufferedOutputBytes,
    maxConnections = MAX_CONNECTIONS,
    maxActiveRequests = MAX_ACTIVE_REQUESTS,
    maxActiveRequestBytes = MAX_ACTIVE_REQUEST_BYTES,
    shutdownSocketDrainMs = SHUTDOWN_SOCKET_DRAIN_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    beforeStoreClose,
    requestObserver,
    slowRequestMs = DEFAULT_SLOW_REQUEST_MS,
  }) {
    if (typeof createStore !== "function") {
      throw new TypeError("StoreDaemon requires an exclusive createStore function.");
    }
    this.storePath = resolveStorePath(storePath);
    this.socketPath = socketPath ?? defaultSocketPath(this.storePath);
    this.socketPathExplicit = socketPath !== undefined;
    this.serverVersion = serverVersion;
    this.createStore = createStore;
    this.operationHandlers = { ...operationHandlers };
    if (statusProvider !== undefined && typeof statusProvider !== "function") {
      throw new TypeError("statusProvider must be a function.");
    }
    this.statusProvider = statusProvider;
    if (beforeStoreClose !== undefined && typeof beforeStoreClose !== "function") {
      throw new TypeError("beforeStoreClose must be a function.");
    }
    this.beforeStoreClose = beforeStoreClose;
    if (requestObserver !== undefined
      && (typeof requestObserver !== "object"
        || typeof requestObserver.requestStarted !== "function"
        || typeof requestObserver.requestFinished !== "function")) {
      throw new TypeError("requestObserver must expose requestStarted and requestFinished functions.");
    }
    this.requestObserver = requestObserver;
    this.slowRequestMs = positiveLimit(slowRequestMs, "slowRequestMs");
    this.allowShutdown = allowShutdown;
    this.maxFrameBytes = positiveLimit(
      maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.maxReplayOutcomes = positiveLimit(maxReplayOutcomes, "maxReplayOutcomes");
    this.maxReplayOutcomeBytes = positiveLimit(
      maxReplayOutcomeBytes,
      "maxReplayOutcomeBytes",
    );
    this.maxQueuedInputBytes = positiveLimit(maxQueuedInputBytes, "maxQueuedInputBytes");
    const defaultConnectionBufferedFrameBytes = combinedLimit(
      this.maxFrameBytes,
      this.maxQueuedInputBytes,
      "maxConnectionBufferedFrameBytes",
    );
    this.maxConnectionBufferedFrameBytes = positiveLimit(
      maxConnectionBufferedFrameBytes ?? defaultConnectionBufferedFrameBytes,
      "maxConnectionBufferedFrameBytes",
    );
    this.maxBufferedFrameBytes = positiveLimit(
      maxBufferedFrameBytes ?? this.maxConnectionBufferedFrameBytes,
      "maxBufferedFrameBytes",
    );
    if (this.maxConnectionBufferedFrameBytes < this.maxFrameBytes) {
      throw new RangeError("maxConnectionBufferedFrameBytes must be at least maxFrameBytes.");
    }
    if (this.maxBufferedFrameBytes < this.maxFrameBytes) {
      throw new RangeError("maxBufferedFrameBytes must be at least maxFrameBytes.");
    }
    const maximumEncodedFrameBytes = combinedLimit(
      this.maxFrameBytes,
      1,
      "maxConnectionBufferedOutputBytes",
    );
    this.maxEncodedFrameBytes = maximumEncodedFrameBytes;
    this.maxConnectionBufferedOutputBytes = positiveLimit(
      maxConnectionBufferedOutputBytes ?? maximumEncodedFrameBytes,
      "maxConnectionBufferedOutputBytes",
    );
    this.maxBufferedOutputBytes = positiveLimit(
      maxBufferedOutputBytes ?? Math.max(DEFAULT_MAX_BUFFERED_OUTPUT_BYTES, maximumEncodedFrameBytes),
      "maxBufferedOutputBytes",
    );
    if (this.maxConnectionBufferedOutputBytes < maximumEncodedFrameBytes) {
      throw new RangeError(
        "maxConnectionBufferedOutputBytes must be at least maxFrameBytes + 1.",
      );
    }
    if (this.maxBufferedOutputBytes < maximumEncodedFrameBytes) {
      throw new RangeError("maxBufferedOutputBytes must be at least maxFrameBytes + 1.");
    }
    this.maxConnections = positiveLimit(maxConnections, "maxConnections");
    this.maxActiveRequests = positiveLimit(maxActiveRequests, "maxActiveRequests");
    this.maxActiveRequestBytes = positiveLimit(
      maxActiveRequestBytes,
      "maxActiveRequestBytes",
    );
    this.shutdownSocketDrainMs = positiveLimit(
      shutdownSocketDrainMs,
      "shutdownSocketDrainMs",
    );
    this.handshakeTimeoutMs = positiveLimit(handshakeTimeoutMs, "handshakeTimeoutMs");
    this.pauseQueuedInputBytes = Math.max(1, Math.floor(this.maxQueuedInputBytes / 2));
    this.resumeQueuedInputBytes = Math.floor(this.pauseQueuedInputBytes / 2);
    this.startedAt = Date.now();
    this.server = undefined;
    this.store = undefined;
    this.connections = new Set();
    this.rejectingConnections = new Set();
    this.inflight = new Set();
    this.requestOutcomes = new Map();
    this.replayOutcomeBytes = 0;
    this.activeRequests = 0;
    this.activeRequestBytes = 0;
    this.bufferedFrameBytes = 0;
    this.bufferedOutputBytes = 0;
    this.outputBytesBySocket = new Map();
    this.outputReservations = new Set();
    this.outputWaiters = [];
    this.backgroundErrors = [];
    this.slowRequests = [];
    this.starting = undefined;
    this.closing = undefined;
    this.state = "idle";
    this.closeRequested = false;
    this.closed = false;
    this.ownerLockToken = 0;
    this.draining = false;
    this.storeClosePrepared = false;
  }

  get capabilities() {
    return [...new Set([
      "daemon.ping",
      "daemon.status",
      ...(this.allowShutdown ? ["daemon.shutdown"] : []),
      ...Object.keys(this.operationHandlers),
    ])].filter((operation) => STORE_OPERATIONS.includes(operation));
  }

  start() {
    if (this.state === "running") return Promise.resolve(this);
    if (this.starting) return this.starting;
    if (this.state === "closing" || this.state === "closed" || this.closed) {
      return Promise.reject(codedError("CONNECTION_CLOSED", "A closed daemon instance cannot be restarted."));
    }
    this.state = "starting";
    this.starting = this.#start();
    return this.starting;
  }

  async #start() {
    try {
      ensureSecureSocketDirectory(this.socketPath);
      this.storePath = ensureSecureStoreDirectory(this.storePath);
      if (!this.socketPathExplicit) this.socketPath = defaultSocketPath(this.storePath);
      // The binding's native file lock spans processes, worker isolates, and
      // symlink aliases and is released by the kernel on process death.
      this.ownerLockToken = tryFileLock(join(this.storePath, ".context-windowd.lock"));
      if (!this.ownerLockToken) {
        throw codedError("STORE_BUSY", `RocksDB store is already owned: ${this.storePath}.`);
      }
      this.storeClosePrepared = false;
      try {
        this.store = await this.createStore(this.storePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/\bLOCK\b|lock hold by|resource temporarily unavailable|another process/iu.test(message)) {
          throw codedError("STORE_BUSY", `RocksDB store is already owned: ${this.storePath}.`, {
            cause: message,
          });
        }
        throw error;
      }
      this.#assertStartActive();
      await prepareSocket(this.socketPath);
      this.#assertStartActive();
      this.server = createServer((socket) => this.#accept(socket));
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server?.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(this.socketPath);
      });
      this.#assertStartActive();
      chmodSync(this.socketPath, 0o600);
      this.state = "running";
      return this;
    } catch (error) {
      let cleanupError;
      try {
        await this.#discardServer();
        await this.#releaseResources();
      } catch (failure) {
        cleanupError = failure;
      } finally {
        this.state = this.closeRequested ? "closing" : "idle";
      }
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], "Daemon startup and cleanup both failed.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  #assertStartActive() {
    if (this.closeRequested || this.state !== "starting") {
      throw codedError("CONNECTION_CLOSED", "Daemon startup was cancelled by close().");
    }
  }

  close() {
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    this.closeRequested = true;
    this.state = "closing";
    this.closing = this.#closeLifecycle();
    return this.closing;
  }

  async #closeLifecycle() {
    this.closed = true;
    try {
      if (this.starting) {
        try { await this.starting; } catch { /* startup performs its own cleanup */ }
      }
      await this.#closeRunningResources();
    } finally {
      this.state = "closed";
    }
  }

  async #discardServer() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const socket of [...this.connections, ...this.rejectingConnections]) socket.destroy();
    this.connections.clear();
    this.rejectingConnections.clear();
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  async #closeRunningResources() {
    const server = this.server;
    this.server = undefined;
    this.draining = true;
    const serverClosed = server
      ? new Promise((resolve) => {
          try { server.close(() => resolve()); } catch { resolve(); }
        })
      : Promise.resolve();
    for (const socket of this.connections) socket.pause();
    for (const socket of this.rejectingConnections) socket.destroy();
    this.rejectingConnections.clear();
    const forceSocketDrain = setTimeout(() => {
      for (const socket of this.connections) socket.destroy();
    }, this.shutdownSocketDrainMs);
    try {
      while (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight]);
      }
      for (const socket of this.connections) socket.end();
      if (server) {
        await serverClosed;
      }
    } finally {
      // server.close() waits for accepted sockets, including idle peers that
      // intentionally keep their writable half open after our FIN. Keep the
      // socket deadline armed until the server has actually released them.
      clearTimeout(forceSocketDrain);
    }
    this.connections.clear();
    await this.#releaseResources();
  }

  async #releaseResources() {
    const failures = [];
    try {
      if (!this.storeClosePrepared) {
        this.storeClosePrepared = true;
        try {
          await this.beforeStoreClose?.({ store: this.store, daemon: this });
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.store?.close?.();
      } catch (error) {
        failures.push(error);
      }
    } finally {
      this.store = undefined;
      try {
        if (existsSync(this.socketPath) && !(await socketIsLive(this.socketPath))) {
          rmSync(this.socketPath, { force: true });
        }
      } finally {
        fileLockRelease(this.ownerLockToken);
        this.ownerLockToken = 0;
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Daemon runtime and store close both failed.");
    }
  }

  #tryReserveOutputBytes(socket, bytes, { retainOnClose = false } = {}) {
    if (socket.destroyed || !socket.writable) return undefined;
    const connectionBytes = this.outputBytesBySocket.get(socket) ?? 0;
    if (bytes > this.maxConnectionBufferedOutputBytes - connectionBytes
      || bytes > this.maxBufferedOutputBytes - this.bufferedOutputBytes) {
      return undefined;
    }
    const reservation = { socket, bytes, released: false, retainOnClose };
    this.outputReservations.add(reservation);
    this.outputBytesBySocket.set(socket, connectionBytes + bytes);
    this.bufferedOutputBytes += bytes;
    return reservation;
  }

  #acquireOutputReservation(socket, { retainOnClose = false } = {}) {
    const reservation = this.#tryReserveOutputBytes(
      socket,
      this.maxEncodedFrameBytes,
      { retainOnClose },
    );
    if (reservation) return Promise.resolve(reservation);
    if (socket.destroyed || !socket.writable) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.outputWaiters.push({ socket, resolve, retainOnClose });
    });
  }

  #resizeOutputReservation(reservation, bytes) {
    if (reservation.released) return;
    if (bytes <= 0 || bytes > reservation.bytes) {
      throw new RangeError("Buffered output reservation cannot grow or become empty.");
    }
    const releasedBytes = reservation.bytes - bytes;
    if (releasedBytes === 0) return;
    reservation.bytes = bytes;
    const connectionBytes = (this.outputBytesBySocket.get(reservation.socket) ?? 0)
      - releasedBytes;
    this.outputBytesBySocket.set(reservation.socket, connectionBytes);
    this.bufferedOutputBytes -= releasedBytes;
    this.#wakeOutputWaiters();
  }

  #releaseOutputReservation(reservation, { wake = true } = {}) {
    if (!reservation || reservation.released) return;
    reservation.released = true;
    this.outputReservations.delete(reservation);
    const connectionBytes = (this.outputBytesBySocket.get(reservation.socket) ?? 0)
      - reservation.bytes;
    if (connectionBytes > 0) {
      this.outputBytesBySocket.set(reservation.socket, connectionBytes);
    } else {
      this.outputBytesBySocket.delete(reservation.socket);
    }
    this.bufferedOutputBytes -= reservation.bytes;
    if (this.bufferedOutputBytes < 0) {
      throw new RangeError("Buffered output byte accounting underflow.");
    }
    if (wake) this.#wakeOutputWaiters();
  }

  #wakeOutputWaiters() {
    for (let index = 0; index < this.outputWaiters.length;) {
      const waiter = this.outputWaiters[index];
      if (waiter.socket.destroyed || !waiter.socket.writable) {
        this.outputWaiters.splice(index, 1);
        waiter.resolve(undefined);
        continue;
      }
      const reservation = this.#tryReserveOutputBytes(
        waiter.socket,
        this.maxEncodedFrameBytes,
        { retainOnClose: waiter.retainOnClose },
      );
      if (!reservation) {
        index += 1;
        continue;
      }
      this.outputWaiters.splice(index, 1);
      waiter.resolve(reservation);
    }
  }

  #releaseSocketOutput(socket) {
    for (const reservation of [...this.outputReservations]) {
      if (reservation.socket === socket && !reservation.retainOnClose) {
        this.#releaseOutputReservation(reservation, { wake: false });
      }
    }
    for (let index = this.outputWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.outputWaiters[index];
      if (waiter.socket !== socket) continue;
      this.outputWaiters.splice(index, 1);
      waiter.resolve(undefined);
    }
    this.#wakeOutputWaiters();
  }

  async #writeFrame(socket, frame, { reservation: suppliedReservation } = {}) {
    const reservation = suppliedReservation
      ?? await this.#acquireOutputReservation(socket);
    if (!reservation) return false;
    if (reservation.released || reservation.socket !== socket) return false;
    // A pre-dispatch materialization reservation survives peer close while
    // the handler runs. Once it reaches the writer, normal socket lifecycle
    // owns release again.
    reservation.retainOnClose = false;
    if (socket.destroyed || !socket.writable) {
      this.#releaseOutputReservation(reservation);
      return false;
    }
    let bytes;
    try {
      bytes = Buffer.from(encodeProtocolFrame(frame), "utf8");
      if (bytes.byteLength > this.maxEncodedFrameBytes) {
        throw new ContractError(
          "INVALID_RESPONSE",
          "$",
          `encoded response exceeds the ${this.maxFrameBytes}-byte protocol frame limit`,
        );
      }
      this.#resizeOutputReservation(reservation, bytes.byteLength);
    } catch (error) {
      this.#releaseOutputReservation(reservation);
      throw error;
    }
    if (socket.destroyed || !socket.writable) {
      this.#releaseOutputReservation(reservation);
      return false;
    }
    return new Promise((resolve) => {
      let settled = false;
      const release = () => this.#releaseOutputReservation(reservation);
      const finish = (written) => {
        if (settled) return;
        settled = true;
        socket.off("drain", onDrain);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve(written);
      };
      const onDrain = () => {
        release();
        finish(true);
      };
      const onClose = () => {
        release();
        finish(false);
      };
      const onError = () => {
        release();
        finish(false);
      };
      socket.once("drain", onDrain);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        const writableImmediately = socket.write(bytes, (error) => {
          release();
          if (error) finish(false);
        });
        if (writableImmediately) finish(true);
      } catch {
        release();
        finish(false);
      }
    });
  }

  #accept(socket) {
    socket.once("close", () => this.#releaseSocketOutput(socket));
    if (this.connections.size >= this.maxConnections) {
      if (this.rejectingConnections.size >= this.maxConnections) {
        socket.destroy();
        return;
      }
      this.rejectingConnections.add(socket);
      const cleanup = () => this.rejectingConnections.delete(socket);
      socket.once("close", cleanup);
      socket.setTimeout(1_000, () => socket.destroy());
      // Read the handshake first so the client has installed its response
      // waiter before receiving the capacity rejection.
      socket.once("data", () => {
        socket.setTimeout(0);
        const rejected = this.#writeFrame(socket, createHandshakeRejected(
          codedError("STORE_BUSY", "Daemon connection limit reached."),
        )).finally(() => {
          if (!socket.destroyed) socket.end();
        });
        this.#trackWork(rejected);
      });
      socket.on("error", () => {});
      return;
    }
    this.connections.add(socket);
    const framer = new LineFramer({ maxFrameBytes: this.maxFrameBytes });
    const state = {
      framer,
      handshaken: false,
      project: undefined,
      pendingLines: [],
      queuedBytes: 0,
      pendingFrameBytes: 0,
      activeFrameBytes: 0,
      partialFrameBytes: 0,
      bufferedFrameBytes: 0,
      processing: false,
      activeWork: undefined,
      pausedForQueue: false,
      closing: false,
      handshakeTimer: undefined,
    };
    state.handshakeTimer = setTimeout(() => {
      if (state.handshaken || state.closing) return;
      this.#terminateConnection(socket, state, createHandshakeRejected(
        codedError("CONNECTION_CLOSED", "Daemon handshake timed out."),
      ));
    }, this.handshakeTimeoutMs);
    socket.on("data", (chunk) => {
      if (this.draining || state.closing) return;
      if (!this.#reserveBufferedFrameBytes(state, chunk.byteLength)) {
        this.#terminateConnection(socket, state, state.handshaken
          ? createErrorResponse(
              {},
              codedError("STORE_BUSY", "Daemon buffered protocol-frame byte limit reached."),
            )
          : createHandshakeRejected(
              codedError("STORE_BUSY", "Daemon buffered protocol-frame byte limit reached."),
            ));
        return;
      }
      let lines;
      try {
        lines = framer.push(chunk);
      } catch (error) {
        this.#discardBufferedInput(state);
        this.#terminateConnection(socket, state, state.handshaken
          ? createErrorResponse({}, error)
          : createHandshakeRejected(error));
        return;
      }
      // Newline delimiters are consumed by the framer and never retained.
      this.#releaseBufferedFrameBytes(state, lines.length);
      state.partialFrameBytes = framer.bufferedBytes;
      for (const line of lines) {
        const lineBytes = line.byteLength + 1;
        state.pendingLines.push(line);
        state.queuedBytes += lineBytes;
        state.pendingFrameBytes += line.byteLength;
      }
      // The first pending line can start immediately. Everything behind an
      // active or immediately dispatchable line is bounded as queued input.
      const dispatchableBytes = state.processing || state.pendingLines.length === 0
        ? 0
        : state.pendingLines[0].byteLength + 1;
      if (state.queuedBytes - dispatchableBytes > this.maxQueuedInputBytes) {
        this.#terminateConnection(socket, state, createErrorResponse(
          {},
          codedError("STORE_BUSY", "Connection input queue exceeded its byte limit."),
        ));
        return;
      }
      this.#startNextLine(socket, state);
      if (state.queuedBytes >= this.pauseQueuedInputBytes && !state.pausedForQueue) {
        state.pausedForQueue = true;
        socket.pause();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = undefined;
      state.closing = true;
      this.#discardBufferedInput(state);
      this.connections.delete(socket);
    });
  }

  #reserveBufferedFrameBytes(state, bytes) {
    if (bytes > this.maxConnectionBufferedFrameBytes - state.bufferedFrameBytes
      || bytes > this.maxBufferedFrameBytes - this.bufferedFrameBytes) {
      return false;
    }
    state.bufferedFrameBytes += bytes;
    this.bufferedFrameBytes += bytes;
    return true;
  }

  #releaseBufferedFrameBytes(state, bytes) {
    if (bytes === 0) return;
    if (bytes < 0
      || bytes > state.bufferedFrameBytes
      || bytes > this.bufferedFrameBytes) {
      throw new RangeError("Buffered protocol-frame byte accounting underflow.");
    }
    state.bufferedFrameBytes -= bytes;
    this.bufferedFrameBytes -= bytes;
  }

  #discardBufferedInput(state) {
    const discardedBytes = state.bufferedFrameBytes - state.activeFrameBytes;
    if (discardedBytes > 0) this.#releaseBufferedFrameBytes(state, discardedBytes);
    state.framer.discard();
    state.partialFrameBytes = 0;
    state.pendingLines.length = 0;
    state.pendingFrameBytes = 0;
    state.queuedBytes = 0;
  }

  #trackWork(work) {
    this.inflight.add(work);
    work.then(
      () => this.inflight.delete(work),
      () => this.inflight.delete(work),
    );
  }

  #startNextLine(socket, state) {
    if (state.processing || state.closing || this.draining) return;
    const line = state.pendingLines.shift();
    if (line === undefined) return;
    state.queuedBytes -= line.byteLength + 1;
    state.pendingFrameBytes -= line.byteLength;
    state.activeFrameBytes = line.byteLength;
    state.processing = true;
    const work = this.#handleLine(socket, state, line);
    state.activeWork = work;
    this.#trackWork(work);
    const complete = () => {
      if (state.activeWork === work) state.activeWork = undefined;
      this.#releaseBufferedFrameBytes(state, state.activeFrameBytes);
      state.activeFrameBytes = 0;
      state.processing = false;
      if (state.pausedForQueue
        && state.queuedBytes <= this.resumeQueuedInputBytes
        && !state.closing
        && !this.draining
        && !socket.destroyed) {
        state.pausedForQueue = false;
        socket.resume();
      }
      this.#startNextLine(socket, state);
    };
    work.then(complete, complete);
  }

  #terminateConnection(socket, state, frame) {
    if (state.closing) return;
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = undefined;
    state.closing = true;
    this.#discardBufferedInput(state);
    socket.pause();
    const prior = state.activeWork ?? Promise.resolve();
    const terminal = prior.catch(() => {}).then(async () => {
      await this.#writeFrame(socket, frame);
      if (!socket.destroyed) socket.end();
    });
    this.#trackWork(terminal);
  }

  async #handleLine(socket, state, line) {
    if (!state.handshaken) {
      try {
        const handshake = parseRequestLine(line);
        assertHandshakeRequest(handshake);
        clearTimeout(state.handshakeTimer);
        state.handshakeTimer = undefined;
        state.handshaken = true;
        state.project = handshake.project;
        await this.#writeFrame(socket, createHandshakeAccepted({
          serverVersion: this.serverVersion,
          storePath: this.storePath,
          capabilities: this.capabilities,
        }));
      } catch (error) {
        clearTimeout(state.handshakeTimer);
        state.handshakeTimer = undefined;
        state.closing = true;
        this.#discardBufferedInput(state);
        socket.pause();
        await this.#writeFrame(socket, createHandshakeRejected(error));
        if (!socket.destroyed) socket.end();
      }
      return;
    }

    let request;
    try {
      // Capture envelope identifiers before payload validation so a malformed
      // request still receives a response the client can correlate.
      request = parseRequestLine(line);
      assertRequestFrame(request);
    } catch (error) {
      await this.#writeFrame(
        socket,
        createErrorResponse(request ?? {}, error, { details: error?.details }),
      );
      return;
    }

    // Reserve the worst-case encoded response before dispatch. This gates
    // RocksDB reconstruction, handler result objects, replay sizing, and JSON
    // encoding behind the same daemon-wide RSS boundary.
    const reservation = await this.#acquireOutputReservation(socket, {
      retainOnClose: true,
    });
    if (!reservation) return;
    let response;
    try {
      response = await this.#executeRequest(request, {
        project: state.project,
        requestBytes: line.byteLength + 1,
        requestFingerprint: createHash("sha256").update(line).digest("hex"),
        socket,
        store: this.store,
      });
    } catch (error) {
      response = createErrorResponse(request, error, { details: error?.details });
    }
    try {
      await this.#writeFrame(socket, response, { reservation });
    } catch (error) {
      await this.#writeFrame(
        socket,
        createErrorResponse(request, error, { details: error?.details }),
      );
    }
    if (request.operation === "daemon.shutdown" && response.ok && response.result.accepted) {
      setImmediate(() => this.close());
    }
  }

  #executeRequest(request, context) {
    const replayKey = `${context.project}\0${request.requestId}`;
    const fingerprint = context.requestFingerprint;
    const previous = this.requestOutcomes.get(replayKey);
    if (previous) {
      if (previous.operation !== request.operation || previous.fingerprint !== fingerprint) {
        return Promise.resolve(createErrorResponse(
          request,
          codedError("CONFLICT", `Request ID ${request.requestId} was reused with different content.`),
        ));
      }
      return previous.promise;
    }

    // Settled outcomes are expendable cache entries; active requests are not.
    // Refuse excess concurrency rather than allowing idempotency state to grow
    // without a bound when every retained entry is still in flight.
    this.#trimRequestOutcomes({ reserveEntries: 1 });
    if (this.requestOutcomes.size >= this.maxReplayOutcomes) {
      return Promise.resolve(createErrorResponse(
        request,
        codedError("STORE_BUSY", "Daemon request concurrency limit reached."),
      ));
    }
    const requestBytes = context.requestBytes
      ?? Buffer.byteLength(JSON.stringify(request), "utf8") + 1;
    if (this.activeRequests >= this.maxActiveRequests
      || requestBytes > this.maxActiveRequestBytes - this.activeRequestBytes) {
      return Promise.resolve(createErrorResponse(
        request,
        codedError("STORE_BUSY", "Daemon active request byte or concurrency limit reached."),
      ));
    }
    this.activeRequests += 1;
    this.activeRequestBytes += requestBytes;
    const requestStartedAt = Date.now();
    let observationToken;
    try {
      observationToken = this.requestObserver?.requestStarted({
        operation: request.operation,
        requestBytes,
        startedAt: requestStartedAt,
      });
    } catch { /* diagnostics must not affect request handling */ }

    const promise = (async () => {
      try {
        const result = await this.#dispatch(request.operation, request.payload, context);
        return createValidatedSuccessResponse(request, result);
      } catch (error) {
        return createErrorResponse(request, error, { details: error?.details });
      }
    })();
    const entry = {
      operation: request.operation,
      fingerprint,
      promise,
      settled: false,
      byteLength: 0,
    };
    this.requestOutcomes.set(replayKey, entry);
    const settleActiveRequest = (ok) => {
      this.activeRequests -= 1;
      this.activeRequestBytes -= requestBytes;
      if (this.activeRequests < 0) this.activeRequests = 0;
      if (this.activeRequestBytes < 0) this.activeRequestBytes = 0;
      const completedAt = Date.now();
      const durationMs = Math.max(0, completedAt - requestStartedAt);
      if (durationMs >= this.slowRequestMs) {
        this.slowRequests.push(Object.freeze({
          operation: request.operation,
          requestBytes,
          durationMs,
          completedAt,
          ok,
        }));
        if (this.slowRequests.length > MAX_SLOW_REQUESTS) {
          this.slowRequests.splice(0, this.slowRequests.length - MAX_SLOW_REQUESTS);
        }
      }
      try {
        this.requestObserver?.requestFinished(observationToken, {
          operation: request.operation,
          requestBytes,
          durationMs,
          completedAt,
          ok,
        });
      } catch { /* diagnostics must not affect request handling */ }
    };
    promise.then((response) => {
      settleActiveRequest(response.ok === true);
      entry.settled = true;
      entry.byteLength = Buffer.byteLength(JSON.stringify(response), "utf8");
      this.replayOutcomeBytes += entry.byteLength;
      this.#trimRequestOutcomes();
    }, () => {
      settleActiveRequest(false);
      // Dispatch is normalized to a response, but preserve the accounting
      // invariant if that implementation detail changes.
      entry.settled = true;
      this.#trimRequestOutcomes();
    });
    return promise;
  }

  #trimRequestOutcomes({ reserveEntries = 0 } = {}) {
    const targetEntries = Math.max(0, this.maxReplayOutcomes - reserveEntries);
    if (this.requestOutcomes.size <= targetEntries
      && this.replayOutcomeBytes <= this.maxReplayOutcomeBytes) return;
    for (const [requestId, entry] of this.requestOutcomes) {
      if (!entry.settled) continue;
      this.requestOutcomes.delete(requestId);
      this.replayOutcomeBytes -= entry.byteLength;
      if (this.requestOutcomes.size <= targetEntries
        && this.replayOutcomeBytes <= this.maxReplayOutcomeBytes) break;
    }
    // Avoid negative drift if future response-accounting paths change.
    if (this.replayOutcomeBytes < 0) this.replayOutcomeBytes = 0;
  }

  async #dispatch(operation, payload, context) {
    if (operation === "daemon.ping") {
      return { nonce: payload.nonce, serverTime: Date.now() };
    }
    if (operation === "daemon.status") return this.status(context);
    if (operation === "daemon.shutdown") {
      if (!this.allowShutdown) {
        throw codedError("UNAUTHORIZED", "Remote daemon shutdown is disabled.");
      }
      return { accepted: true };
    }
    const handler = this.operationHandlers[operation];
    if (!handler) throw codedError("UNKNOWN_OPERATION", `Operation ${operation} is unavailable.`);
    return handler(payload, context);
  }

  async status(context = {}) {
    const storeStatus = normalizeStoreStatus(await this.store?.status?.());
    const runtimeStatus = normalizeStoreStatus(await this.statusProvider?.({
      store: this.store,
      daemon: this,
      project: context.project,
    }));
    const result = {
      ready: Boolean(this.server?.listening),
      processId: process.pid,
      storePath: this.storePath,
      runtimeVersion: this.serverVersion,
      startedAt: this.startedAt,
      schemaVersion: STORE_SCHEMA_VERSION,
      protocolVersion: STORE_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      backgroundErrors: [
        ...this.backgroundErrors,
        ...(storeStatus.backgroundErrors ?? []),
        ...(runtimeStatus.backgroundErrors ?? []),
      ].slice(-100),
      slowRequests: [...this.slowRequests],
    };
    for (const field of ["counts", "outbox", "index", "retention", "rocksdb", "filesystem", "migration"]) {
      if (runtimeStatus[field] !== undefined) result[field] = runtimeStatus[field];
      else if (storeStatus[field] !== undefined) result[field] = storeStatus[field];
    }
    return result;
  }
}

export async function startStoreDaemon(options) {
  return new StoreDaemon(options).start();
}
