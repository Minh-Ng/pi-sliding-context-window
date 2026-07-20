import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  STORE_PROTOCOL_VERSION,
  assertHandshakeResponse,
  assertRequestFrame,
  assertResponseFrame,
  decodeProtocolLine,
  encodeProtocolFrame,
} from "./store-protocol.js";
import { ContractError } from "./store-contract.js";
import { DEFAULT_MAX_FRAME_BYTES, LineFramer } from "./daemon/framing.js";

const RETRY_SAFE_OPERATIONS = new Set([
  "daemon.ping",
  "daemon.status",
  "store.get",
  "store.search",
  "store.count",
  "retention.status",
  "migration.status",
]);

export class StoreRemoteError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "StoreRemoteError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

function connectionError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "CONNECTION_CLOSED";
  error.retryable = true;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.code = "CONFLICT";
  error.retryable = false;
  return error;
}

function isAliasRejection(error) {
  return error instanceof StoreRemoteError
    && error.code === "INVALID_REQUEST"
    && error.details?.path === "$.aliasProjects";
}

function withoutAliasProjects(handshake) {
  if (!("aliasProjects" in handshake)) return handshake;
  const { aliasProjects, ...rest } = handshake;
  return rest;
}

export class StoreClient {
  constructor({
    socketPath,
    client = "context-window-client",
    clientVersion = "0.1.0",
    project,
    aliasProjects,
    requestTimeoutMs = 30_000,
    maxFrameBytes,
  }) {
    if (!socketPath) throw new TypeError("socketPath is required.");
    if (!project) throw new TypeError("project is required.");
    this.socketPath = socketPath;
    // Only well-formed and non-duplicate; realpath verification against this
    // authenticated project happens daemon-side (authorizedReadProjects in
    // src/daemon/server.js), not here.
    const declaredAliases = Array.isArray(aliasProjects)
      ? aliasProjects.filter((alias) => typeof alias === "string" && alias.length > 0 && alias !== project)
      : [];
    this.declaredAliases = declaredAliases;
    this.handshake = {
      protocolVersion: STORE_PROTOCOL_VERSION,
      type: "handshake",
      client,
      clientVersion,
      project,
      ...(declaredAliases.length > 0 ? { aliasProjects: declaredAliases } : {}),
    };
    // Set once a still-live daemon has rejected aliasProjects outright (a
    // pre-alias daemon during a rolling upgrade). Remembered for this
    // client's lifetime so later reconnects go straight to the
    // canonical-only handshake instead of repeating a doomed round trip.
    this.aliasHandshakeRejected = false;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxFrameBytes = maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new TypeError("maxFrameBytes must be a positive safe integer.");
    }
    this.socket = undefined;
    this.connecting = undefined;
    this.pending = new Map();
    this.handshakeWaiter = undefined;
    this.server = undefined;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw connectionError("Store client is closed.");
    if (this.socket && !this.socket.destroyed && this.server) return this.server;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async #connect() {
    const initialHandshake = this.aliasHandshakeRejected
      ? withoutAliasProjects(this.handshake)
      : this.handshake;
    try {
      return await this.#handshakeOnce(initialHandshake);
    } catch (error) {
      // A daemon that predates alias-widened reads rejects the aliasProjects
      // field outright (schema additionalProperties: false), which would
      // otherwise hard-fail every session against a symlink/non-canonical
      // cwd for as long as a stale pre-upgrade daemon keeps the socket.
      // Retry once, canonical-project-only: reads simply don't widen across
      // aliases until the daemon is replaced, instead of failing to connect.
      if (this.aliasHandshakeRejected || !isAliasRejection(error)) throw error;
      this.aliasHandshakeRejected = true;
      return await this.#handshakeOnce(withoutAliasProjects(this.handshake));
    }
  }

  async #handshakeOnce(handshake) {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    const framer = new LineFramer({ maxFrameBytes: this.maxFrameBytes });
    socket.on("data", (chunk) => {
      try {
        for (const line of framer.push(chunk)) this.#receive(line);
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.#disconnected(socket));

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onInitialError);
        socket.off("close", onInitialClose);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onInitialError = (error) => {
        cleanup();
        reject(connectionError(`Unable to connect to context-windowd at ${this.socketPath}.`, error));
      };
      const onInitialClose = () => {
        cleanup();
        reject(connectionError(`Connection to context-windowd at ${this.socketPath} closed.`));
      };
      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
      socket.once("close", onInitialClose);
    });

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = undefined;
        reject(connectionError("Store daemon handshake timed out."));
        socket.destroy();
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.handshakeWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      socket.write(encodeProtocolFrame(handshake));
    });
    assertHandshakeResponse(response);
    if (!response.accepted) {
      socket.destroy();
      throw new StoreRemoteError(response.error);
    }
    this.server = response;
    return response;
  }

  async request(operation, payload, {
    retry = RETRY_SAFE_OPERATIONS.has(operation),
    requestId = randomUUID(),
  } = {}) {
    await this.connect();
    const request = assertRequestFrame({
      protocolVersion: STORE_PROTOCOL_VERSION,
      type: "request",
      requestId,
      operation,
      payload,
    });
    try {
      return await this.#send(request);
    } catch (error) {
      if (!retry || error?.code !== "CONNECTION_CLOSED" || this.closed) throw error;
      await this.connect();
      return this.#send(request);
    }
  }

  async ping(nonce = randomUUID()) {
    return this.request("daemon.ping", { nonce });
  }

  #send(request) {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.server) {
      return Promise.reject(connectionError("Store daemon connection is not open."));
    }
    const encoded = encodeProtocolFrame(request);
    if (Buffer.byteLength(encoded, "utf8") - 1 > this.maxFrameBytes) {
      return Promise.reject(new ContractError(
        "INVALID_REQUEST",
        "$",
        `encoded request exceeds the ${this.maxFrameBytes}-byte protocol frame limit`,
      ));
    }
    const fingerprint = JSON.stringify([request.operation, request.payload]);
    const existing = this.pending.get(request.requestId);
    if (existing) {
      if (existing.operation !== request.operation || existing.fingerprint !== fingerprint) {
        return Promise.reject(conflictError(
          `Request ID ${request.requestId} is already in flight with different content.`,
        ));
      }
      return existing.promise;
    }
    let settleResolve;
    let settleReject;
    const promise = new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(request.requestId);
      settleReject(connectionError(`Store request ${request.operation} timed out.`));
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.pending.set(request.requestId, {
      operation: request.operation,
      fingerprint,
      promise,
      resolve: (value) => {
        clearTimeout(timer);
        settleResolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        settleReject(error);
      },
    });
    socket.write(encoded, (error) => {
      if (!error) return;
      const pending = this.pending.get(request.requestId);
      this.pending.delete(request.requestId);
      pending?.reject(connectionError("Failed to write store request.", error));
    });
    return promise;
  }

  #receive(line) {
    const frame = decodeProtocolLine(line, { direction: "response" });
    if (frame.type === "handshake-ack") {
      const waiter = this.handshakeWaiter;
      this.handshakeWaiter = undefined;
      waiter?.resolve(frame);
      return;
    }
    assertResponseFrame(frame);
    const pending = this.pending.get(frame.requestId);
    if (!pending) {
      if (!frame.ok && frame.requestId === "unknown-request") {
        const error = new StoreRemoteError(frame.error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      }
      return;
    }
    this.pending.delete(frame.requestId);
    if (pending.operation !== frame.operation) {
      pending.reject(connectionError("Store response operation does not match its request."));
      return;
    }
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new StoreRemoteError(frame.error));
  }

  #disconnected(socket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.server = undefined;
    const error = connectionError("Store daemon connection closed.");
    this.handshakeWaiter?.reject(error);
    this.handshakeWaiter = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    if (socket) {
      // Reject waiters before clearing the socket. Waiting for the asynchronous
      // close event would let close() strand requests until their RPC timeout,
      // while routing the captured socket through #disconnected preserves the
      // stale-socket guard when another connection has already replaced it.
      this.#disconnected(socket);
      socket.destroy();
      return;
    }
    this.server = undefined;
    const error = connectionError("Store client is closed.");
    this.handshakeWaiter?.reject(error);
    this.handshakeWaiter = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
