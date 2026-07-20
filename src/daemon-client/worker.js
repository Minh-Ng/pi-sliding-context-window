import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerData } from "node:worker_threads";
import { StoreClient } from "../store-client.js";
import { ensureSecureSocketDirectory } from "../daemon/paths.js";
import { semanticLaunchArguments } from "./semantic-launch-arguments.js";
import {
  appendDaemonLog,
  defaultDaemonLaunchLogPath,
  defaultDaemonLogPath,
} from "../daemon/log-file.js";

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
const STALE = "stale";
const UNAVAILABLE = "unavailable";
const upgradeSignals = new Set();

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

function recordLifecycle(event, { processId = null, ...details } = {}) {
  const launchLogPath = options.daemonLaunchLogPath
    ?? defaultDaemonLaunchLogPath(options.storePath);
  try {
    appendDaemonLog(launchLogPath, {
      timestamp: new Date().toISOString(),
      event,
      processId,
      ...details,
    });
  } catch { /* diagnostics must not affect daemon ownership retries */ }
}

function upgradeMarkerPath() {
  return `${options.socketPath}.upgrade`;
}

function clearUpgradeMarker() {
  try { rmSync(upgradeMarkerPath(), { force: true }); } catch {}
}

function claimUpgrade(processId, incompatibility) {
  const path = upgradeMarkerPath();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeSync(descriptor, JSON.stringify({
        processId,
        createdAt: Date.now(),
        expectedRuntime: incompatibility.expectedRuntime,
      }));
      closeSync(descriptor);
      return true;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      try {
        const marker = JSON.parse(readFileSync(path, "utf8"));
        const fresh = marker.processId === processId
          && Number.isSafeInteger(marker.createdAt)
          && Date.now() - marker.createdAt < options.daemonStartTimeoutMs;
        if (fresh) return false;
      } catch { /* malformed markers are replaced below */ }
      try { rmSync(path, { force: true }); } catch {}
    }
  }
  return false;
}

function daemonIncompatibility(server) {
  const missingCapabilities = (options.requiredCapabilities ?? [])
    .filter((capability) => !server.capabilities.includes(capability));
  const runtimeMismatch = typeof options.daemonRuntimeVersion === "string"
    && options.daemonRuntimeVersion.length > 0
    && server.serverVersion !== options.daemonRuntimeVersion;
  if (!runtimeMismatch && missingCapabilities.length === 0) return undefined;
  return {
    runtimeMismatch,
    expectedRuntime: options.daemonRuntimeVersion ?? null,
    observedRuntime: server.serverVersion,
    missingCapabilities,
  };
}

function retireStaleDaemon(candidate, server, incompatibility) {
  candidate.close();
  const processId = Number(server.processId);
  if (!Number.isSafeInteger(processId) || processId <= 1 || processId === process.pid) {
    const error = new Error("Verified stale context-windowd reported an unsafe process identity.");
    error.code = "DAEMON_UPGRADE_BLOCKED";
    error.retryable = false;
    error.details = { processId, ...incompatibility };
    throw error;
  }
  if (upgradeSignals.has(processId)) return STALE;
  let claimed;
  try {
    claimed = claimUpgrade(processId, incompatibility);
  } catch (error) {
    const blocked = new Error("Unable to coordinate a stale context-windowd replacement.");
    blocked.code = "DAEMON_UPGRADE_BLOCKED";
    blocked.retryable = false;
    blocked.details = {
      processId,
      cause: error instanceof Error ? error.message : String(error),
      ...incompatibility,
    };
    throw blocked;
  }
  if (!claimed) return STALE;
  upgradeSignals.add(processId);
  recordLifecycle("daemon-upgrade-requested", {
    processId,
    ...incompatibility,
  });
  try {
    process.kill(processId, "SIGTERM");
  } catch (error) {
    clearUpgradeMarker();
    if (error?.code === "ESRCH") return STALE;
    const blocked = new Error(`Unable to terminate stale context-windowd process ${processId}.`);
    blocked.code = "DAEMON_UPGRADE_BLOCKED";
    blocked.retryable = false;
    blocked.details = {
      processId,
      cause: error instanceof Error ? error.message : String(error),
      ...incompatibility,
    };
    throw blocked;
  }
  return STALE;
}

function createClient() {
  return new StoreClient({
    socketPath: options.socketPath,
    project: options.project,
    ...(Array.isArray(options.aliasProjects) && options.aliasProjects.length > 0
      ? { aliasProjects: options.aliasProjects }
      : {}),
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
    const incompatibility = daemonIncompatibility(server);
    if (options.autoUpgradeDaemon === true
      && incompatibility?.missingCapabilities.length > 0) {
      return retireStaleDaemon(candidate, server, incompatibility);
    }
    if (options.autoUpgradeDaemon === true) clearUpgradeMarker();
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
  const semanticArguments = semanticLaunchArguments(options.semantic);
  const logPath = options.daemonLogPath ?? defaultDaemonLogPath(options.storePath);
  const child = spawn(nodeExecutable, [
    daemonPath,
    "--store",
    options.storePath,
    "--socket",
    options.socketPath,
    "--log",
    logPath,
    "--allow-shutdown",
    ...semanticArguments,
  ], {
    // Worker.terminate() tears down subprocesses that remain in the worker's
    // process session on some Node/platform combinations. The store daemon
    // is shared infrastructure, so give it an independent session before
    // releasing the ChildProcess handle below. Daemon diagnostics use their
    // own bounded JSONL writer; never attach unbounded child stdio to a file.
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  // The daemon is shared by every facade for this store and must outlive the
  // worker that happened to win startup. The store lock arbitrates concurrent
  // launch attempts; losing processes exit while every client retries the
  // shared socket.
  recordLifecycle("daemon-spawned", { processId: child.pid ?? null });
  child.on("error", (error) => {
    recordLifecycle("daemon-spawn-error", {
      processId: child.pid ?? null,
      code: error?.code ?? null,
      message: String(error?.message ?? error).slice(0, 1_024),
    });
  });
  child.on("exit", (code, exitSignal) => {
    recordLifecycle("daemon-exit", {
      processId: child.pid ?? null,
      code: Number.isInteger(code) ? code : null,
      signal: exitSignal ?? null,
      abnormal: code !== 0 || exitSignal !== null,
    });
  });
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

function signalTermination(processId) {
  try {
    process.kill(processId, "SIGTERM");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function restartDaemon(reason) {
  const active = await ensureClient();
  const server = active.server;
  const processId = Number(server.processId);
  if (!Number.isSafeInteger(processId) || processId <= 1 || processId === process.pid) {
    const error = new Error("Verified context-windowd reported an unsafe process identity.");
    error.code = "DAEMON_RESTART_BLOCKED";
    error.retryable = false;
    error.details = { processId };
    throw error;
  }

  const graceful = server.capabilities.includes("daemon.shutdown");
  let forced = !graceful;
  if (graceful) {
    const shutdown = active.request("daemon.shutdown", { reason }, {
      retry: false,
      requestId: `daemon-restart:${processId}:${Date.now()}`,
    }).then(
      () => ({ accepted: true }),
      (error) => ({ accepted: connectionFailure(error), error }),
    );
    const outcome = await Promise.race([
      shutdown,
      delay(2_000).then(() => undefined),
    ]);
    if (outcome?.error && !outcome.accepted) throw outcome.error;
    if (outcome?.accepted !== true) {
      discardClient();
      signalTermination(processId);
      forced = true;
    }
  } else {
    discardClient();
    signalTermination(processId);
  }
  discardClient();

  const deadline = Date.now() + options.daemonStartTimeoutMs;
  const gracefulDeadline = Math.min(deadline, Date.now() + 5_000);
  let oldDaemonReachable = true;
  while (Date.now() < gracefulDeadline) {
    const outcome = await tryConnect();
    if (outcome !== CONNECTED) {
      oldDaemonReachable = false;
      break;
    }
    if (Number(client.server.processId) !== processId) break;
    discardClient();
    await delay(25);
  }
  if (oldDaemonReachable && client && Number(client.server.processId) === processId) {
    discardClient();
    if (graceful) {
      signalTermination(processId);
      forced = true;
    }
  }

  const replacement = client && Number(client.server.processId) !== processId
    ? client
    : await ensureClient({ deadline });
  const replacementProcessId = Number(replacement.server.processId);
  if (!Number.isSafeInteger(replacementProcessId) || replacementProcessId === processId) {
    const error = new Error("context-windowd replacement did not acquire a new process identity.");
    error.code = "DAEMON_RESTART_BLOCKED";
    error.retryable = false;
    error.details = { processId, replacementProcessId };
    throw error;
  }
  return {
    previousProcessId: processId,
    processId: replacementProcessId,
    runtimeVersion: replacement.server.serverVersion,
    graceful,
    forced,
  };
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
    if (method === "restart") {
      const value = await restartDaemon(message.reason);
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
