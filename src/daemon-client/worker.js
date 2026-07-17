import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerData } from "node:worker_threads";
import { StoreClient } from "../store-client.js";
import { ensureSecureSocketDirectory } from "../daemon/paths.js";

const daemonPath = fileURLToPath(new URL("../../bin/context-windowd.js", import.meta.url));
const port = workerData.port;
const signal = new Int32Array(workerData.signal);
const options = workerData.options;
const nodeExecutable = process.env.CONTEXT_WINDOW_NODE?.trim()
  || (process.versions?.bun === undefined && process.release?.name === "node"
    ? process.execPath
    : "node");

let client;
let socketDirectoryValidated = false;

const CONNECTED = "connected";
const CAPACITY_BUSY = "capacity-busy";
const UNAVAILABLE = "unavailable";

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createClient() {
  return new StoreClient({
    socketPath: options.socketPath,
    project: options.project,
    client: "context-window-sync-archive",
    clientVersion: options.clientVersion,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

function connectionFailure(error) {
  if (error?.retryable === false) return false;
  // Correlated STORE_BUSY responses come from a healthy request channel and
  // must not trigger reconnect/replay. Handshake capacity is classified
  // separately by tryConnect(), where there is no established client yet.
  if (error?.code === "STORE_BUSY") return false;
  return error?.code === "CONNECTION_CLOSED"
    || error?.code === "ENOENT"
    || error?.code === "ECONNREFUSED"
    || /connect|connection|socket|handshake/iu.test(error instanceof Error ? error.message : String(error));
}

function discardClient() {
  client?.close();
  client = undefined;
}

async function tryConnect() {
  discardClient();
  const candidate = createClient();
  try {
    const server = await candidate.connect();
    if (canonicalPath(server.storePath) !== canonicalPath(options.storePath)) {
      const error = new Error(
        `Daemon socket ${options.socketPath} owns ${server.storePath}, not ${options.storePath}.`,
      );
      error.code = "STORE_BUSY";
      error.retryable = false;
      throw error;
    }
    client = candidate;
    return CONNECTED;
  } catch (error) {
    candidate.close();
    if (error?.code === "STORE_BUSY" && error?.retryable === true) {
      return CAPACITY_BUSY;
    }
    if (!connectionFailure(error)) throw error;
    return UNAVAILABLE;
  }
}

function launchDaemon() {
  // The adapter host may itself be Bun. RocksDB support is intentionally tied
  // to the package's declared Node runtime, so never inherit the host binary.
  const child = spawn(nodeExecutable, [
    daemonPath,
    "--store",
    options.storePath,
    "--socket",
    options.socketPath,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  // The daemon is shared by every facade for this store and must outlive the
  // worker that happened to win startup. The store lock arbitrates concurrent
  // launch attempts; losing processes exit while every client retries the
  // shared socket.
  child.on("error", () => {});
  child.unref();
}

async function ensureClient({
  launch = true,
  deadline = Date.now() + options.daemonStartTimeoutMs,
} = {}) {
  if (!socketDirectoryValidated) {
    ensureSecureSocketDirectory(options.socketPath);
    socketDirectoryValidated = true;
  }
  let initialOutcome;
  if (client) {
    try {
      await client.connect();
      return client;
    } catch (error) {
      discardClient();
      if (error?.code === "STORE_BUSY" && error?.retryable === true) {
        initialOutcome = CAPACITY_BUSY;
      } else if (!connectionFailure(error)) throw error;
    }
  }
  initialOutcome ??= await tryConnect();
  if (initialOutcome === CONNECTED) return client;
  let nextLaunchAt = launch && initialOutcome !== CAPACITY_BUSY
    ? Date.now()
    : Number.POSITIVE_INFINITY;
  let backoffMs = 10;
  while (Date.now() < deadline) {
    if (Date.now() >= nextLaunchAt) {
      launchDaemon();
      // A launch may lose the store lock to a daemon that is still shutting
      // down. Retry ownership periodically until the shared readiness
      // deadline instead of assuming the first child survives.
      nextLaunchAt = Date.now() + 500;
    }
    const outcome = await tryConnect();
    if (outcome === CONNECTED) return client;
    if (outcome === CAPACITY_BUSY) {
      // A live daemon owns the socket and store. Wait for a connection slot;
      // launching competitors only creates lock churn while it is saturated.
      nextLaunchAt = Number.POSITIVE_INFINITY;
    } else if (launch && !Number.isFinite(nextLaunchAt)) {
      // The previously saturated daemon disappeared. Resume ownership probes.
      nextLaunchAt = Date.now();
    }
    await delay(backoffMs);
    backoffMs = Math.min(100, backoffMs * 2);
  }
  const error = new Error(`context-windowd did not become ready at ${options.socketPath}.`);
  error.code = "CONNECTION_CLOSED";
  error.retryable = true;
  throw error;
}

function blockingIoTransient(error) {
  return error?.code === "INTERNAL" && /no blocking io/iu.test(error.message);
}

async function send(active, operation, payload, requestId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await active.request(operation, payload, {
        retry: false,
        requestId: attempt === 0 ? requestId : `${requestId}:blocking-io-${attempt}`,
      });
    } catch (error) {
      lastError = error;
      if (!blockingIoTransient(error) || attempt === 2) throw error;
      await delay(0);
    }
  }
  throw lastError;
}

async function request(operation, payload, requestId) {
  let reconnectDeadline;
  for (;;) {
    const active = reconnectDeadline === undefined
      ? await ensureClient()
      : await ensureClient({ deadline: reconnectDeadline });
    try {
      return await send(active, operation, payload, requestId);
    } catch (error) {
      if (!connectionFailure(error)) throw error;
      discardClient();
      reconnectDeadline ??= Date.now() + options.daemonStartTimeoutMs;
      if (Date.now() >= reconnectDeadline) throw error;
      // Preserve the envelope identity across every reconnect attempt so a
      // daemon that survived the socket loss can replay its prior outcome.
    }
  }
}

function serializedError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

function respond(id, response) {
  port.postMessage({ id, ...response });
  Atomics.store(signal, 0, id);
  Atomics.notify(signal, 0);
}

async function handle(message) {
  const { id, method } = message;
  try {
    if (method === "initialize") {
      const active = await ensureClient();
      respond(id, { ok: true, value: active.server });
      return;
    }
    if (method === "request") {
      const value = await request(message.operation, message.payload, message.requestId);
      respond(id, { ok: true, value });
      return;
    }
    if (method === "close") {
      discardClient();
      respond(id, { ok: true });
      return;
    }
    throw new TypeError(`Unknown synchronous bridge method ${JSON.stringify(method)}.`);
  } catch (error) {
    respond(id, { ok: false, error: serializedError(error) });
  }
}

let queue = Promise.resolve();
port.on("message", (message) => {
  queue = queue.then(() => handle(message), () => handle(message));
});
port.start();
