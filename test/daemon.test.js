import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DaemonArchive } from "../src/daemon-archive.js";
import { SynchronousStoreBridge } from "../src/daemon-client/sync-bridge.js";
import {
  DEFAULT_MAX_BUFFERED_FRAME_BYTES,
  DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
  DEFAULT_MAX_CONNECTION_BUFFERED_FRAME_BYTES,
  DEFAULT_MAX_CONNECTION_BUFFERED_OUTPUT_BYTES,
  StoreDaemon,
  startStoreDaemon,
} from "../src/daemon/server.js";
import { StoreClient } from "../src/store-client.js";
import { DEFAULT_MAX_FRAME_BYTES, LineFramer } from "../src/daemon/framing.js";
import {
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STORE_IDENTIFIER_LENGTH,
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
} from "../src/store-contract.js";
import {
  assertDaemonPlatform,
  defaultSocketPath,
  ensureSecureSocketDirectory,
  ensureSecureStoreDirectory,
  resolveStorePath,
  UnsafeSocketPathError,
  UnsafeStorePathError,
  UnsupportedDaemonPlatformError,
} from "../src/daemon/paths.js";

const childFixture = new URL("../test-support/daemon-client-child.js", import.meta.url);
const egressMemoryFixture = new URL(
  "../test-support/daemon-egress-memory-child.js",
  import.meta.url,
);
const framingMemoryFixture = new URL("../test-support/framing-memory-child.js", import.meta.url);
const workerFixture = new URL("../test-support/daemon-worker.js", import.meta.url);
const daemonExecutable = new URL("../bin/context-windowd.js", import.meta.url).pathname;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-window-daemon-"));
  return {
    directory,
    storePath: join(directory, "archive.rocks"),
    socketPath: join(directory, "daemon.sock"),
  };
}

function fakeStore() {
  let closed = false;
  return {
    status() {
      return { counts: { documents: 0, events: 0, chunks: 0, logicalBytes: 0 } };
    },
    close() { closed = true; },
    get closed() { return closed; },
  };
}

function childPing(socketPath, project, nonce) {
  return new Promise((resolve, reject) => {
    const child = fork(childFixture, [socketPath, project, nonce], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("message", (message) => {
      if (message.ok) resolve(message.reply);
      else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code && !stderr.includes("ExperimentalWarning")) {
        reject(new Error(`Child client exited ${code}: ${stderr}`));
      }
    });
  });
}

function startDaemonProcess(storePath, socketPath) {
  const child = spawn(process.execPath, [
    daemonExecutable,
    "--store",
    storePath,
    "--socket",
    socketPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const firstJson = (stream) => new Promise((resolve, reject) => {
    const read = () => {
      const line = stream().split("\n").find((candidate) => candidate.trim());
      if (!line) return false;
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      return true;
    };
    if (read()) return;
    const onData = () => {
      if (!read()) return;
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.trim() && !stderr.trim()) reject(new Error(`Daemon exited ${code} without status.`));
    });
  });
  return {
    child,
    ready: firstJson(() => stdout),
    error: firstJson(() => stderr),
    stop: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

test("daemon CLI help and invalid options exit without creating default state", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-daemon-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.CONTEXT_WINDOW_ROCKSDB;
  delete env.CONTEXT_WINDOW_SOCKET;

  const help = spawnSync(process.execPath, [daemonExecutable, "--help"], {
    cwd: directory,
    env,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: context-windowd/u);
  assert.equal(help.stderr, "");

  for (const args of [["--unknown"], ["--store"]]) {
    const invalid = spawnSync(process.execPath, [daemonExecutable, ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown option|requires a value/u);
    assert.equal(invalid.stdout, "");
  }
  assert.equal(existsSync(join(directory, ".context-window")), false);
});

function workerMessage(worker) {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function framingMemoryReport() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", framingMemoryFixture.pathname], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Framing memory verifier exited ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

function runEgressMemoryChild(mode, storePath, socketPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--expose-gc",
      egressMemoryFixture.pathname,
      mode,
      storePath,
      socketPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Daemon egress ${mode} verifier exited ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function daemonEgressMemoryReport() {
  const paths = fixture();
  try {
    const prepared = await runEgressMemoryChild(
      "prepare",
      paths.storePath,
      join(paths.directory, "prepare.sock"),
    );
    assert.equal(prepared.prepared, true);
    return await runEgressMemoryChild(
      "measure",
      paths.storePath,
      join(paths.directory, "measure.sock"),
    );
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      socket.on("error", () => {});
      resolve(socket);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function readJsonFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.subarray(0, newline).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before returning a protocol frame."));
    };
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function settlesWithin(promise, milliseconds, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test("eight concurrent clients share one daemon and client close does not stop it", async (t) => {
  const paths = fixture();
  const store = fakeStore();
  const daemon = await startStoreDaemon({ ...paths, createStore: () => store });
  t.after(() => daemon.close());
  const clients = Array.from({ length: 8 }, (_, index) => new StoreClient({
    socketPath: paths.socketPath,
    client: `test-${index}`,
    clientVersion: "1.0.0",
    project: paths.directory,
  }));
  t.after(() => clients.forEach((client) => client.close()));

  const replies = await Promise.all(clients.map((client, index) => client.ping(`n-${index}`)));
  assert.deepEqual(replies.map(({ nonce }) => nonce), Array.from({ length: 8 }, (_, i) => `n-${i}`));
  clients[0].close();
  assert.equal((await clients[1].ping("still-live")).nonce, "still-live");
  assert.equal(store.closed, false);
});

test("StoreClient.close rejects initial connection and handshake waits immediately", async (t) => {
  const paths = fixture();
  let markHandshakeSeen;
  const handshakeSeen = new Promise((resolve) => { markHandshakeSeen = resolve; });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", markHandshakeSeen);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const initialClient = new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    requestTimeoutMs: 30_000,
  });
  const initialConnect = initialClient.connect().catch((error) => error);
  initialClient.close();
  const initialError = await settlesWithin(
    initialConnect,
    250,
    "close() left the initial connection pending",
  );
  assert.equal(initialError.code, "CONNECTION_CLOSED");

  const client = new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    requestTimeoutMs: 30_000,
  });
  const connecting = client.connect().catch((error) => error);
  await handshakeSeen;
  client.close();
  const error = await settlesWithin(
    connecting,
    250,
    "close() left the handshake pending until its RPC timeout",
  );
  assert.equal(error.code, "CONNECTION_CLOSED");
});

test("a stale old-socket close cannot reject a replacement request", async (t) => {
  const paths = fixture();
  let markStarted;
  let releaseHandler;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const handlerGate = new Promise((resolve) => { releaseHandler = resolve; });
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    operationHandlers: {
      "store.count": async () => {
        markStarted();
        await handlerGate;
        return { count: 1 };
      },
    },
  });
  t.after(async () => {
    releaseHandler();
    await daemon.close();
  });
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  await client.connect();
  const oldSocket = client.socket;
  const oldClosed = new Promise((resolve) => oldSocket.once("close", resolve));
  oldSocket.destroy();
  await oldClosed;
  await client.connect();
  const replacementSocket = client.socket;
  const request = client.request("store.count", { scope: "project" }, {
    requestId: "stale-socket-close",
    retry: false,
  });
  await started;
  oldSocket.emit("close");
  assert.equal(client.socket, replacementSocket);
  releaseHandler();
  assert.deepEqual(await request, { count: 1 });
});

test("eight child-process clients concurrently use one daemon", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => daemon.close());
  const replies = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    childPing(paths.socketPath, paths.directory, `child-${index}`)));
  assert.deepEqual(replies.map(({ nonce }) => nonce),
    Array.from({ length: 8 }, (_, index) => `child-${index}`));
});

test("excess connections receive a retryable bounded-capacity rejection", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxConnections: 1,
  });
  t.after(() => daemon.close());
  const first = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  const excess = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => { first.close(); excess.close(); });
  await first.connect();
  await assert.rejects(excess.connect(), (error) => (
    error.code === "STORE_BUSY" && error.retryable === true
  ));
  assert.equal(daemon.connections.size, 1);
});

test("the synchronous facade retries retryable connection capacity until a slot releases", async (t) => {
  const paths = fixture();
  const childLaunchLog = join(paths.directory, "unexpected-child-launches.log");
  const nodeProbe = join(paths.directory, "node-launch-probe");
  writeFileSync(nodeProbe, [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(childLaunchLog)}, 'launch\\n');`,
  ].join("\n"), { mode: 0o755 });
  chmodSync(nodeProbe, 0o755);
  const owner = new Worker(workerFixture, {
    workerData: {
      ...paths,
      project: paths.directory,
      maxConnections: 1,
      holdConnectionMs: 600,
      armHoldRelease: true,
    },
  });
  let ownerStopped = false;
  t.after(async () => {
    if (ownerStopped) return;
    owner.postMessage("stop");
    await workerMessage(owner);
  });
  assert.deepEqual(await workerMessage(owner), { status: "ready" });

  owner.postMessage("arm-release");
  const startedAt = Date.now();
  const priorNodeExecutable = process.env.CONTEXT_WINDOW_NODE;
  process.env.CONTEXT_WINDOW_NODE = nodeProbe;
  let archive;
  try {
    archive = new DaemonArchive({
      ...paths,
      project: paths.directory,
      requestTimeoutMs: 2_000,
      daemonStartTimeoutMs: 2_000,
      autoUpgradeDaemon: false,
    });
  } finally {
    if (priorNodeExecutable === undefined) delete process.env.CONTEXT_WINDOW_NODE;
    else process.env.CONTEXT_WINDOW_NODE = priorNodeExecutable;
  }
  t.after(() => archive.close({ releaseProtection: false }));
  assert.ok(Date.now() - startedAt >= 300, "facade connected before the held slot was released");
  assert.ok(archive.stats().processId > 0);
  const childLaunchCount = existsSync(childLaunchLog)
    ? readFileSync(childLaunchLog, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  assert.equal(childLaunchCount, 0, "capacity retries must not launch competing daemons");

  archive.close({ releaseProtection: false });
  owner.postMessage("stop");
  assert.deepEqual(await workerMessage(owner), { status: "stopped" });
  ownerStopped = true;
});

test("correlated handler capacity surfaces once without reconnecting a healthy facade", async (t) => {
  const paths = fixture();
  const owner = new Worker(workerFixture, {
    workerData: {
      ...paths,
      busyHandlerDelayMs: 150,
    },
  });
  let ownerStopped = false;
  t.after(async () => {
    if (ownerStopped) return;
    owner.postMessage("stop");
    await workerMessage(owner);
  });
  assert.deepEqual(await workerMessage(owner), { status: "ready" });

  const archive = new DaemonArchive({
    ...paths,
    project: paths.directory,
    requestTimeoutMs: 2_000,
    daemonStartTimeoutMs: 2_000,
    autoUpgradeDaemon: false,
  });
  t.after(() => archive.close({ releaseProtection: false }));
  const startedAt = Date.now();
  assert.throws(
    () => archive.count({ scope: "project" }),
    (error) => error.code === "STORE_BUSY" && error.retryable === true,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 100, "busy handler did not execute its bounded delay");
  assert.ok(elapsedMs < 1_000, "correlated busy response entered a reconnect loop");
  assert.ok(archive.stats().processId > 0, "facade did not retain its healthy connection");

  owner.postMessage("stats");
  assert.deepEqual(await workerMessage(owner), {
    status: "stats",
    busyExecutions: 1,
    connectionAttempts: 1,
    activeConnections: 1,
  });

  archive.close({ releaseProtection: false });
  owner.postMessage("stop");
  assert.deepEqual(await workerMessage(owner), { status: "stopped" });
  ownerStopped = true;
});

test("a silent client loses its connection slot at the handshake deadline", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxConnections: 1,
    handshakeTimeoutMs: 20,
  });
  t.after(() => daemon.close());
  const silent = createConnection(paths.socketPath);
  t.after(() => silent.destroy());
  await new Promise((resolve, reject) => {
    silent.once("connect", resolve);
    silent.once("error", reject);
  });
  silent.resume();
  assert.equal(daemon.connections.size, 1);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("silent connection did not time out")), 500);
    silent.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  for (let attempt = 0; attempt < 100 && daemon.connections.size !== 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(daemon.connections.size, 0);

  const replacement = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => replacement.close());
  await replacement.connect();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await replacement.ping("handshake-timer-cleared")).nonce, "handshake-timer-cleared");
});

test("partial frames consume strict per-connection and global bytes before JSON parsing", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxFrameBytes: 1_024,
    maxQueuedInputBytes: 256,
    maxConnectionBufferedFrameBytes: 1_100,
    maxBufferedFrameBytes: 1_500,
    maxConnections: 3,
  });
  t.after(() => daemon.close());
  const first = await connectSocket(paths.socketPath);
  const second = await connectSocket(paths.socketPath);
  let oversized;
  t.after(() => {
    first.destroy();
    second.destroy();
    oversized?.destroy();
  });

  first.write(Buffer.alloc(900, 0x78));
  await waitFor(
    () => daemon.bufferedFrameBytes === 900,
    "the first partial frame was not charged",
  );

  const globalRejection = readJsonFrame(second);
  second.write(Buffer.alloc(601, 0x79));
  const globalFrame = await globalRejection;
  assert.equal(globalFrame.accepted, false);
  assert.equal(globalFrame.error.code, "STORE_BUSY");
  assert.equal(globalFrame.error.retryable, true);
  assert.equal(daemon.bufferedFrameBytes, 900);
  assert.ok(daemon.bufferedFrameBytes <= daemon.maxBufferedFrameBytes);

  const connectionRejection = readJsonFrame(first);
  first.write(Buffer.alloc(201, 0x7a));
  const connectionFrame = await connectionRejection;
  assert.equal(connectionFrame.accepted, false);
  assert.equal(connectionFrame.error.code, "STORE_BUSY");
  assert.equal(connectionFrame.error.retryable, true);
  await waitFor(
    () => daemon.bufferedFrameBytes === 0,
    "closing bounded partial frames did not release their byte charge",
  );

  oversized = await connectSocket(paths.socketPath);
  const oversizedRejection = readJsonFrame(oversized);
  oversized.write(Buffer.alloc(1_025, 0x71));
  const oversizedFrame = await oversizedRejection;
  assert.equal(oversizedFrame.accepted, false);
  assert.equal(oversizedFrame.error.code, "INVALID_REQUEST");
  await waitFor(
    () => daemon.bufferedFrameBytes === 0,
    "oversized frame rejection did not release its byte charge",
  );
});

test("single-pass request validation preserves malformed envelope correlation", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => daemon.close());
  const socket = await connectSocket(paths.socketPath);
  t.after(() => socket.destroy());

  const handshakeResponse = readJsonFrame(socket);
  socket.write(`${JSON.stringify({
    protocolVersion: 1,
    type: "handshake",
    client: "raw-validation-test",
    clientVersion: "1.0.0",
    project: paths.directory,
  })}\n`);
  assert.equal((await handshakeResponse).accepted, true);

  const response = readJsonFrame(socket);
  socket.write(`${JSON.stringify({
    protocolVersion: 1,
    type: "request",
    requestId: "correlated-invalid-request",
    operation: "daemon.ping",
    payload: { nonce: 42 },
  })}\n`);
  const frame = await response;
  assert.equal(frame.requestId, "correlated-invalid-request");
  assert.equal(frame.operation, "daemon.ping");
  assert.equal(frame.ok, false);
  assert.equal(frame.error.code, "INVALID_REQUEST");
  await waitFor(
    () => daemon.bufferedFrameBytes === 0,
    "malformed active frame did not release its byte charge",
  );
});

test("the encoded frame budget admits ordinary maxima and rejects escape amplification", () => {
  const ordinaryAggregateBytes =
    MAX_DOCUMENT_TEXT_BYTES
    + MAX_DOCUMENT_METADATA_BYTES
    + MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT
    + MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT
    + MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT;
  const worstEscapedAggregateBytes = 6 * (
    ordinaryAggregateBytes
  );
  const worstNonAggregateEnvelopeBytes =
    (7 * 6 * MAX_STORE_IDENTIFIER_LENGTH)
    + (512 * MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT)
    + (1 * 1_024 * 1_024);
  assert.equal(ordinaryAggregateBytes, 12 * 1_024 * 1_024);
  assert.equal(worstEscapedAggregateBytes, 72 * 1_024 * 1_024);
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 16 * 1_024 * 1_024);
  assert.equal(
    DEFAULT_MAX_CONNECTION_BUFFERED_FRAME_BYTES,
    32 * 1_024 * 1_024,
  );
  assert.equal(DEFAULT_MAX_BUFFERED_FRAME_BYTES, 32 * 1_024 * 1_024);
  assert.equal(
    DEFAULT_MAX_CONNECTION_BUFFERED_OUTPUT_BYTES,
    DEFAULT_MAX_FRAME_BYTES + 1,
  );
  assert.equal(DEFAULT_MAX_BUFFERED_OUTPUT_BYTES, (32 * 1_024 * 1_024) + 2);
  assert.ok(worstNonAggregateEnvelopeBytes < 4 * 1_024 * 1_024);
  assert.ok(ordinaryAggregateBytes + worstNonAggregateEnvelopeBytes < DEFAULT_MAX_FRAME_BYTES);
  assert.ok(worstEscapedAggregateBytes > DEFAULT_MAX_FRAME_BYTES);
});

test("a fresh fragmented ordinary-maximum put stays below the ingress RSS gate", async () => {
  const report = await framingMemoryReport();
  assert.ok(report.frameBytes > 12 * 1_024 * 1_024);
  assert.ok(report.frameBytes < report.frameLimitBytes);
  assert.equal(report.frameLimitBytes, DEFAULT_MAX_FRAME_BYTES);
  assert.ok(
    report.rssDeltaBytes < 96 * 1_024 * 1_024,
    `fragmented decode RSS grew by ${report.rssDeltaBytes} bytes`,
  );
  assert.ok(report.peakRssBytes >= report.sampledPeakRssBytes);
  assert.ok(report.peakRssBytes < 192 * 1_024 * 1_024);
});

test("fresh RocksDB slow readers stay below the bounded egress RSS gate", async () => {
  const report = await daemonEgressMemoryReport();
  assert.ok(report.gatedWaiters > 0, "slow readers did not reach the global output gate");
  assert.equal(report.gatedReservations + report.gatedWaiters, 16);
  assert.ok(report.gatedOutputBytes > 0);
  assert.ok(report.gatedOutputBytes <= report.maxBufferedOutputBytes);
  assert.equal(report.maxBufferedOutputBytes, DEFAULT_MAX_BUFFERED_OUTPUT_BYTES);
  assert.equal(report.releasedOutputBytes, 0);
  assert.equal(report.releasedReservations, 0);
  assert.equal(report.releasedWaiters, 0);
  assert.ok(
    report.rssDeltaBytes < 128 * 1_024 * 1_024,
    `slow-reader response RSS grew by ${report.rssDeltaBytes} bytes`,
  );
  assert.ok(report.peakRssBytes >= report.sampledPeakRssBytes);
  assert.ok(report.peakRssBytes < 256 * 1_024 * 1_024);
});

test("fragmented frames use fixed-size accumulation and preserve exact bytes", () => {
  const payload = Buffer.from("x".repeat(1_024 * 1_024), "utf8");
  const framer = new LineFramer({ maxFrameBytes: payload.length });
  for (let offset = 0; offset < payload.length; offset += 7) {
    if (framer.push(payload.subarray(offset, offset + 7)).length !== 0) {
      assert.fail("fragment without a newline produced a frame");
    }
  }
  assert.ok(framer.blocks.length <= 16);
  const [line] = framer.push(Buffer.from("\n"));
  assert.equal(line.equals(payload), true);
  assert.equal(framer.bufferedBytes, 0);

  const exact = new LineFramer({ maxFrameBytes: 32 });
  exact.push(Buffer.alloc(31, 0x78));
  const exactBlock = exact.tail;
  const [exactLine] = exact.push(Buffer.from("x\n"));
  assert.equal(exactLine, exactBlock, "an exactly-sized block should not be copied");

  const discarded = new LineFramer({ maxFrameBytes: 32 });
  discarded.push(Buffer.from("partial"));
  assert.equal(discarded.discard(), 7);
  assert.equal(discarded.bufferedBytes, 0);
});

test("clients reject oversized requests before writing or retrying them", async (t) => {
  const paths = fixture();
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    operationHandlers: {
      "store.preflight": () => {
        executions += 1;
        throw new Error("oversized request reached the daemon");
      },
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    maxFrameBytes: 1_024,
  });
  t.after(() => client.close());
  await assert.rejects(client.request("store.preflight", {
    messageKey: "user:oversized",
    message: "x".repeat(2_048),
    scope: "session",
    sessionId: "session-oversized",
    sessionIds: ["session-oversized"],
    project: paths.directory,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  }), (error) => error.code === "INVALID_REQUEST" && /frame limit/iu.test(error.message));
  assert.equal(executions, 0);
  assert.equal((await client.ping("still-connected")).nonce, "still-connected");
});

test("the resolved store path has one live daemon owner", async (t) => {
  const paths = fixture();
  const first = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => first.close());
  await assert.rejects(
    startStoreDaemon({
      storePath: join(paths.directory, ".", "archive.rocks"),
      socketPath: join(paths.directory, "second.sock"),
      createStore: fakeStore,
    }),
    (error) => error.code === "STORE_BUSY",
  );
});

test("native ownership canonicalizes symlink aliases", async (t) => {
  const paths = fixture();
  const first = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => first.close());
  const alias = join(paths.directory, "archive-alias.rocks");
  symlinkSync(paths.storePath, alias);
  await assert.rejects(startStoreDaemon({
    storePath: alias,
    socketPath: join(paths.directory, "alias.sock"),
    createStore: fakeStore,
  }), (error) => error.code === "STORE_BUSY");
});

test("default socket identity canonicalizes symlinked parents before the store exists", () => {
  const paths = fixture();
  const realParent = join(paths.directory, "real-parent");
  const aliasParent = join(paths.directory, "alias-parent");
  mkdirSync(realParent);
  symlinkSync(realParent, aliasParent, "dir");

  const realStore = join(realParent, "missing", "archive.rocks");
  const aliasStore = join(aliasParent, "missing", "archive.rocks");
  assert.equal(resolveStorePath(aliasStore), resolveStorePath(realStore));
  assert.equal(defaultSocketPath(aliasStore), defaultSocketPath(realStore));
});

test("the Unix-socket daemon fails clearly on Windows", () => {
  assert.throws(
    () => assertDaemonPlatform("win32"),
    (error) => error instanceof UnsupportedDaemonPlatformError
      && error.code === "UNSUPPORTED_DAEMON_PLATFORM"
      && error.retryable === false,
  );
  assert.doesNotThrow(() => assertDaemonPlatform("darwin"));
  assert.doesNotThrow(() => assertDaemonPlatform("linux"));
});

test("default sockets live in a current-user private directory", () => {
  const paths = fixture();
  const socketPath = defaultSocketPath(paths.storePath);
  const directory = ensureSecureSocketDirectory(socketPath);
  const stat = lstatSync(directory);
  assert.equal(dirname(socketPath), directory);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(stat.uid, process.getuid());
});

test("RocksDB stores tighten existing directories around private archive data", () => {
  const paths = fixture();
  mkdirSync(paths.storePath, { mode: 0o700 });
  chmodSync(paths.storePath, 0o755);
  const directory = ensureSecureStoreDirectory(paths.storePath);
  const stat = lstatSync(directory);
  assert.equal(directory, realpathSync.native(paths.storePath));
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(stat.uid, process.getuid());
});

test("RocksDB store paths must resolve to real directories", () => {
  const paths = fixture();
  writeFileSync(paths.storePath, "not a directory");
  assert.throws(
    () => ensureSecureStoreDirectory(paths.storePath),
    (error) => error instanceof UnsafeStorePathError || error.code === "EEXIST",
  );
});

test("an unsafe socket directory is rejected before storage opens", async () => {
  const paths = fixture();
  const unsafeDirectory = join(paths.directory, "world-readable-run");
  mkdirSync(unsafeDirectory, { mode: 0o700 });
  chmodSync(unsafeDirectory, 0o755);
  const socketPath = join(unsafeDirectory, "daemon.sock");
  assert.throws(
    () => ensureSecureSocketDirectory(socketPath),
    (error) => error instanceof UnsafeSocketPathError && error.code === "UNSAFE_SOCKET_PATH",
  );
  let opened = false;
  await assert.rejects(startStoreDaemon({
    storePath: paths.storePath,
    socketPath,
    createStore: () => {
      opened = true;
      return fakeStore();
    },
  }), (error) => error.code === "UNSAFE_SOCKET_PATH" && error.retryable === false);
  assert.equal(opened, false);

  const sharedAncestor = join(paths.directory, "shared-ancestor");
  const privateLeaf = join(sharedAncestor, "private-leaf");
  mkdirSync(privateLeaf, { recursive: true, mode: 0o700 });
  chmodSync(sharedAncestor, 0o777);
  assert.throws(
    () => ensureSecureSocketDirectory(join(privateLeaf, "daemon.sock")),
    (error) => error instanceof UnsafeSocketPathError
      && /ancestor .*writable by other users/iu.test(error.message),
  );
});

test("native ownership spans Worker isolates", async (t) => {
  const paths = fixture();
  const first = new Worker(workerFixture, { workerData: paths });
  t.after(() => first.terminate());
  assert.deepEqual(await workerMessage(first), { status: "ready" });
  const second = new Worker(workerFixture, {
    workerData: { ...paths, socketPath: join(paths.directory, "worker-2.sock") },
  });
  t.after(() => second.terminate());
  const failure = await workerMessage(second);
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "STORE_BUSY");
  first.postMessage("stop");
  assert.deepEqual(await workerMessage(first), { status: "stopped" });
});

test("RocksDB native locking excludes a second daemon process", async (t) => {
  const paths = fixture();
  const first = startDaemonProcess(paths.storePath, paths.socketPath);
  t.after(first.stop);
  const ready = await first.ready;
  assert.equal(ready.status, "ready");
  const second = startDaemonProcess(paths.storePath, join(paths.directory, "second.sock"));
  t.after(second.stop);
  const failure = await second.error;
  assert.equal(failure.status, "error");
  assert.equal(failure.code, "STORE_BUSY");
});

test("the launcher persists an abnormal daemon exit signal", async (t) => {
  if (process.platform === "win32") return t.skip("Unix signals are required.");
  const paths = fixture();
  const daemonLogPath = join(paths.directory, "daemon-events.jsonl");
  const daemonLaunchLogPath = join(paths.directory, "daemon-launch.log");
  const bridge = new SynchronousStoreBridge({
    ...paths,
    project: paths.directory,
    daemonLogPath,
    daemonLaunchLogPath,
  });
  t.after(() => {
    bridge.close();
    rmSync(paths.directory, { recursive: true, force: true });
  });
  const status = bridge.request("daemon.status", {});
  process.kill(status.processId, "SIGKILL");
  await waitFor(() => {
    if (!existsSync(daemonLaunchLogPath)) return false;
    return readFileSync(daemonLaunchLogPath, "utf8").split("\n").some((line) => {
      if (!line.trim().startsWith("{")) return false;
      const event = JSON.parse(line);
      return event.event === "daemon-exit"
        && event.processId === status.processId
        && event.signal === "SIGKILL"
        && event.abnormal === true;
    });
  }, "launcher did not persist the daemon SIGKILL exit");
  assert.equal(lstatSync(daemonLaunchLogPath).mode & 0o077, 0);
});

test("a shared daemon outlives the bridge worker that launched it", async (t) => {
  if (process.platform === "win32") return t.skip("Detached Unix process sessions are required.");
  const paths = fixture();
  const bridge = new SynchronousStoreBridge({
    ...paths,
    project: paths.directory,
    daemonLogPath: join(paths.directory, "daemon-events.jsonl"),
    daemonLaunchLogPath: join(paths.directory, "daemon-launch.log"),
  });
  const status = bridge.request("daemon.status", {});
  t.after(() => {
    bridge.close();
    try { process.kill(status.processId, "SIGKILL"); } catch { /* already stopped */ }
    rmSync(paths.directory, { recursive: true, force: true });
  });

  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotThrow(
    () => process.kill(status.processId, 0),
    "the daemon stopped when its launching bridge worker terminated",
  );

  process.kill(status.processId, "SIGTERM");
  await waitFor(
    () => !existsSync(paths.socketPath),
    "the detached daemon did not release its socket after SIGTERM",
  );
});

test("closed daemon instances are terminal", async () => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore });
  await daemon.close();
  await assert.rejects(daemon.start(), (error) => error.code === "CONNECTION_CLOSED");
});

test("startup is single-flight and does not leak native ownership", async () => {
  const paths = fixture();
  let opens = 0;
  const daemon = new StoreDaemon({
    ...paths,
    createStore: async () => {
      opens += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fakeStore();
    },
  });
  const [left, right] = await Promise.all([daemon.start(), daemon.start()]);
  assert.equal(left, daemon);
  assert.equal(right, daemon);
  assert.equal(opens, 1);
  await daemon.close();
  const replacement = await startStoreDaemon({ ...paths, createStore: fakeStore });
  await replacement.close();
});

test("close cancels pending startup before it can listen", async () => {
  const paths = fixture();
  let releaseOpen;
  const opening = new Promise((resolve) => { releaseOpen = resolve; });
  const daemon = new StoreDaemon({
    ...paths,
    createStore: async () => {
      await opening;
      return fakeStore();
    },
  });
  const starting = daemon.start();
  const closing = daemon.close();
  releaseOpen();
  await assert.rejects(starting, (error) => error.code === "CONNECTION_CLOSED");
  await closing;
  assert.equal(daemon.closed, true);
  assert.equal(daemon.server, undefined);
  const replacement = await startStoreDaemon({ ...paths, createStore: fakeStore });
  await replacement.close();
});

test("listen failure clears partial startup state and ownership", async () => {
  const paths = fixture();
  const daemon = new StoreDaemon({
    ...paths,
    socketPath: join(paths.directory, "x".repeat(180)),
    createStore: fakeStore,
  });
  await assert.rejects(daemon.start());
  assert.equal(daemon.server, undefined);
  assert.equal(daemon.store, undefined);
  assert.equal(daemon.state, "idle");
  daemon.socketPath = paths.socketPath;
  await daemon.start();
  await daemon.close();
});

test("path preflight failure resets startup for a later retry", async () => {
  const paths = fixture();
  writeFileSync(paths.storePath, "temporarily a file");
  const daemon = new StoreDaemon({ ...paths, createStore: fakeStore });
  await assert.rejects(daemon.start(), (error) => error.code === "EEXIST");
  assert.equal(daemon.state, "idle");
  assert.equal(daemon.starting, undefined);
  rmSync(paths.storePath);
  await daemon.start();
  await daemon.close();
});

test("a dropped connection reconnects without stopping the daemon", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  await client.ping("before-drop");
  client.socket.destroy();
  await new Promise((resolve) => client.socket?.once("close", resolve) ?? resolve());
  assert.equal((await client.ping("after-drop")).nonce, "after-drop");
});

test("status is schema-valid and shutdown is explicitly gated", async (t) => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  const status = await client.request("daemon.status", {});
  assert.equal(status.ready, true);
  assert.equal(status.storePath, realpathSync(paths.storePath));
  assert.deepEqual(status.counts, { documents: 0, events: 0, chunks: 0, logicalBytes: 0 });
  await assert.rejects(
    client.request("daemon.shutdown", { reason: "test" }),
    (error) => error.code === "UNAUTHORIZED",
  );
});

test("slow requests are exposed in status and reported to the watchdog observer", async (t) => {
  const paths = fixture();
  const observed = [];
  const requestObserver = {
    requestStarted(details) {
      observed.push({ phase: "start", ...details });
      return 7;
    },
    requestFinished(token, details) {
      observed.push({ phase: "finish", token, ...details });
    },
  };
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    slowRequestMs: 5,
    requestObserver,
    operationHandlers: {
      "store.count": async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { count: 1 };
      },
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  assert.deepEqual(await client.request("store.count", { scope: "project" }), { count: 1 });
  const status = await client.request("daemon.status", {});
  const slow = status.slowRequests.find(({ operation }) => operation === "store.count");
  assert.ok(slow);
  assert.ok(slow.durationMs >= 5);
  assert.equal(slow.ok, true);
  assert.ok(observed.some(({ phase, token, operation, ok }) =>
    phase === "finish" && token === 7 && operation === "store.count" && ok === true));
  assert.equal(JSON.stringify(observed).includes("payload"), false);
});

test("slow-request history is bounded and records failed operations", async (t) => {
  const paths = fixture();
  let failNext = false;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    slowRequestMs: 1,
    operationHandlers: {
      "store.count": async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (failNext) throw new Error("injected slow failure");
        return { count: 1 };
      },
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  for (let index = 0; index < 105; index += 1) {
    assert.deepEqual(await client.request("store.count", { scope: "project" }), { count: 1 });
  }
  failNext = true;
  await assert.rejects(client.request("store.count", { scope: "project" }), /injected slow failure/u);
  const status = await client.request("daemon.status", {});
  assert.equal(status.slowRequests.length, 100);
  assert.equal(status.slowRequests.at(-1).operation, "store.count");
  assert.equal(status.slowRequests.at(-1).ok, false);
  assert.ok(status.slowRequests.every(({ durationMs }) => durationMs >= 1));
});

test("request observer failures never affect daemon requests", async (t) => {
  const paths = fixture();
  let starts = 0;
  let finishes = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    requestObserver: {
      requestStarted() {
        starts += 1;
        throw new Error("observer start failure");
      },
      requestFinished() {
        finishes += 1;
        throw new Error("observer finish failure");
      },
    },
    operationHandlers: { "store.count": () => ({ count: 1 }) },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  assert.deepEqual(await client.request("store.count", { scope: "project" }), { count: 1 });
  assert.equal(starts, 1);
  assert.equal(finishes, 1);
});

test("duplicate in-flight request IDs coalesce and mutation timeouts do not auto-retry", async (t) => {
  const paths = fixture();
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    operationHandlers: {
      "store.pin": async (payload) => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { status: "pinned", pinId: payload.pinId };
      },
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    requestTimeoutMs: 10,
  });
  const peer = new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    requestTimeoutMs: 100,
  });
  t.after(() => {
    client.close();
    peer.close();
  });
  const duplicatePayload = {
    pinId: "pin-coalesced",
    documentId: "document-coalesced",
    version: 1,
    reason: "test",
  };
  const duplicateOptions = { requestId: "same-request-id", retry: false };
  const [left, right] = await Promise.all([
    peer.request("store.pin", duplicatePayload, duplicateOptions),
    client.request("store.pin", duplicatePayload, { ...duplicateOptions, retry: false })
      .catch((error) => {
        // The 10 ms client can time out while the 100 ms peer receives the
        // shared result. The daemon must still execute the mutation once.
        assert.equal(error.code, "CONNECTION_CLOSED");
        return undefined;
      }),
  ]);
  assert.equal(left.pinId, "pin-coalesced");
  assert.equal(right, undefined);
  assert.equal(executions, 1);

  executions = 0;
  const localOptions = { requestId: "same-client-request", retry: false };
  const localPayload = { ...duplicatePayload, pinId: "pin-same-client" };
  const [localLeft, localRight] = await Promise.all([
    peer.request("store.pin", localPayload, localOptions),
    peer.request("store.pin", localPayload, localOptions),
  ]);
  assert.deepEqual(localLeft, localRight);
  assert.equal(executions, 1);

  await assert.rejects(client.request("store.pin", {
    pinId: "pin-1",
    documentId: "document-1",
    version: 1,
    reason: "test",
  }), (error) => error.code === "CONNECTION_CLOSED");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(executions, 2);
});

test("request replay is isolated by handshake project", async (t) => {
  const paths = fixture();
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    operationHandlers: {
      "store.count": (_payload, context) => ({
        count: context.project.endsWith("project-a") ? ++executions : ++executions + 100,
      }),
    },
  });
  t.after(() => daemon.close());
  const left = new StoreClient({ socketPath: paths.socketPath, project: join(paths.directory, "project-a") });
  const right = new StoreClient({ socketPath: paths.socketPath, project: join(paths.directory, "project-b") });
  t.after(() => { left.close(); right.close(); });
  const options = { requestId: "shared-across-projects", retry: false };
  assert.deepEqual(await left.request("store.count", { scope: "project" }, options), { count: 1 });
  assert.deepEqual(await right.request("store.count", { scope: "project" }, options), { count: 102 });
  assert.equal(executions, 2);
});

test("settled request replay is bounded by encoded response bytes", async (t) => {
  const paths = fixture();
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxReplayOutcomeBytes: 1,
    operationHandlers: {
      "store.count": () => ({ count: ++executions }),
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  const options = { requestId: "byte-bounded-replay", retry: false };

  assert.deepEqual(await client.request("store.count", { scope: "project" }, options), { count: 1 });
  assert.equal(daemon.requestOutcomes.size, 0);
  assert.equal(daemon.replayOutcomeBytes, 0);
  assert.deepEqual(await client.request("store.count", { scope: "project" }, options), { count: 2 });
  assert.equal(executions, 2);
});

test("active request concurrency remains globally bounded across connections", async (t) => {
  const paths = fixture();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxActiveRequests: 1,
    operationHandlers: {
      "store.count": async () => {
        markFirstStarted();
        await firstGate;
        return { count: 1 };
      },
    },
  });
  t.after(() => daemon.close());
  const first = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  const second = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => { first.close(); second.close(); });
  const active = first.request("store.count", { scope: "project" }, {
    requestId: "active-request-first",
    retry: false,
  });
  await firstStarted;
  await assert.rejects(second.request("store.count", { scope: "project" }, {
    requestId: "active-request-excess",
    retry: false,
  }), (error) => error.code === "STORE_BUSY" && error.retryable === true);
  assert.equal(daemon.activeRequests, 1);
  assert.ok(daemon.activeRequestBytes > 0);
  assert.ok(daemon.bufferedFrameBytes > 0, "the active frame must remain globally charged");
  releaseFirst();
  assert.deepEqual(await active, { count: 1 });
  assert.equal(daemon.activeRequests, 0);
  assert.equal(daemon.activeRequestBytes, 0);
  await waitFor(
    () => daemon.bufferedFrameBytes === 0,
    "the completed active frame did not release its byte charge",
  );
});

test("active request payload bytes remain globally bounded", async (t) => {
  const paths = fixture();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxActiveRequests: 10,
    maxActiveRequestBytes: 180,
    operationHandlers: {
      "store.count": async () => {
        markFirstStarted();
        await firstGate;
        return { count: 1 };
      },
    },
  });
  t.after(() => daemon.close());
  const first = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  const second = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => { first.close(); second.close(); });
  const active = first.request("store.count", { scope: "project" }, {
    requestId: "active-byte-first",
    retry: false,
  });
  await firstStarted;
  await assert.rejects(second.request("store.count", { scope: "project" }, {
    requestId: "active-byte-excess",
    retry: false,
  }), (error) => error.code === "STORE_BUSY" && error.retryable === true);
  assert.equal(daemon.activeRequests, 1);
  assert.ok(daemon.activeRequestBytes < daemon.maxActiveRequestBytes);
  releaseFirst();
  await active;
});

test("a busy connection pauses and resumes its byte-bounded input queue", async (t) => {
  const paths = fixture();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxQueuedInputBytes: 2_048,
    operationHandlers: {
      "store.count": async () => {
        executions += 1;
        if (executions === 1) {
          markFirstStarted();
          await firstGate;
        }
        return { count: executions };
      },
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());

  const first = client.request("store.count", { scope: "project" }, {
    requestId: "queued-request-0",
    retry: false,
  });
  await firstStarted;
  const queued = Array.from({ length: 9 }, (_, index) => client.request(
    "store.count",
    { scope: "project" },
    { requestId: `queued-request-${index + 1}`, retry: false },
  ));
  const serverSocket = [...daemon.connections][0];
  for (let attempt = 0; attempt < 100 && !serverSocket.isPaused(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(serverSocket.isPaused(), true);
  assert.equal(executions, 1);

  releaseFirst();
  await Promise.all([first, ...queued]);
  for (let attempt = 0; attempt < 100 && serverSocket.isPaused(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(serverSocket.isPaused(), false);
  assert.equal(executions, 10);
});

test("a slow reader applies output backpressure before the next handler", async (t) => {
  const paths = fixture();
  const largeText = "x".repeat(4 * 1_024 * 1_024);
  let getExecutions = 0;
  let countExecutions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    operationHandlers: {
      "store.get": (_payload, context) => {
        getExecutions += 1;
        return {
          status: "resolved",
          document: {
            documentId: "large-response",
            version: 1,
            sourceKey: "large-response",
            sessionId: "slow-reader",
            project: context.project,
            kind: "turn",
            createdAt: 1,
            text: largeText,
            metadata: {},
            sourceMessageKeys: [],
            sourceKeyStatus: "preserved",
          },
        };
      },
      "store.count": () => ({ count: ++countExecutions }),
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  await client.connect();
  client.socket.pause();

  try {
    const large = client.request("store.get", { documentId: "large-response" }, {
      requestId: "slow-reader-large",
      retry: false,
    });
    const later = client.request("store.count", { scope: "project" }, {
      requestId: "slow-reader-later",
      retry: false,
    });
    const serverSocket = [...daemon.connections][0];
    for (let attempt = 0; attempt < 100 && serverSocket.writableLength === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(getExecutions, 1);
    assert.ok(serverSocket.writableLength > 0);
    assert.ok(daemon.bufferedOutputBytes > 4 * 1_024 * 1_024);
    assert.ok(daemon.bufferedOutputBytes <= daemon.maxBufferedOutputBytes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(countExecutions, 0);

    client.socket.resume();
    assert.equal((await large).document.text.length, largeText.length);
    assert.deepEqual(await later, { count: 1 });
    await waitFor(
      () => daemon.bufferedOutputBytes === 0,
      "drained response did not release its output byte charge",
    );
  } finally {
    client.socket?.resume();
  }
});

test("multiple slow readers remain behind the global response materialization gate", async (t) => {
  const paths = fixture();
  const mebibyte = 1_024 * 1_024;
  const largeText = "x".repeat(4 * mebibyte);
  let executions = 0;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxFrameBytes: 5 * mebibyte,
    maxConnectionBufferedOutputBytes: (5 * mebibyte) + 1,
    maxBufferedOutputBytes: 10 * mebibyte,
    operationHandlers: {
      "store.get": (_payload, context) => {
        executions += 1;
        return {
          status: "resolved",
          document: {
            documentId: `slow-global-${executions}`,
            version: 1,
            sourceKey: `slow-global-${executions}`,
            sessionId: "slow-global",
            project: context.project,
            kind: "turn",
            createdAt: 1,
            text: largeText,
            metadata: {},
            sourceMessageKeys: [],
            sourceKeyStatus: "preserved",
          },
        };
      },
    },
  });
  t.after(() => daemon.close());
  const clients = Array.from({ length: 3 }, () => new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
    requestTimeoutMs: 5_000,
  }));
  t.after(() => clients.forEach((client) => client.close()));
  await Promise.all(clients.map((client) => client.connect()));
  for (const client of clients) client.socket.pause();

  const requests = clients.map((client, index) => client.request(
    "store.get",
    { documentId: `slow-global-${index + 1}` },
    { requestId: `slow-global-${index + 1}`, retry: false },
  ).catch((error) => error));
  await waitFor(
    () => daemon.outputReservations.size === 2 && daemon.outputWaiters.length === 1,
    "slow readers did not reach the bounded response materialization gate",
  );
  assert.equal(executions, 2, "a handler ran before reserving response capacity");
  assert.ok(daemon.bufferedOutputBytes <= daemon.maxBufferedOutputBytes);
  assert.ok([...daemon.outputBytesBySocket.values()].every(
    (bytes) => bytes <= daemon.maxConnectionBufferedOutputBytes,
  ));

  for (const client of clients) client.close();
  await Promise.all(requests);
  await waitFor(
    () => daemon.bufferedOutputBytes === 0
      && daemon.outputReservations.size === 0
      && daemon.outputWaiters.length === 0,
    "closing slow readers did not release output reservations",
  );
});

test("client close cannot release a materialization slot while its handler is active", async (t) => {
  const paths = fixture();
  let executions = 0;
  let markStarted;
  let releaseHandler;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const handlerGate = new Promise((resolve) => { releaseHandler = resolve; });
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: fakeStore,
    maxFrameBytes: 1_024,
    maxConnectionBufferedOutputBytes: 1_025,
    maxBufferedOutputBytes: 1_025,
    operationHandlers: {
      "store.count": async () => {
        executions += 1;
        markStarted();
        await handlerGate;
        return { count: executions };
      },
    },
  });
  t.after(async () => {
    releaseHandler();
    await daemon.close();
  });

  const clients = Array.from({ length: 6 }, () => new StoreClient({
    socketPath: paths.socketPath,
    project: paths.directory,
  }));
  t.after(() => clients.forEach((client) => client.close()));
  await Promise.all(clients.map((client) => client.connect()));
  const [first, ...waiterClients] = clients;
  const active = first.request("store.count", { scope: "project" }, {
    requestId: "materialization-close-active",
    retry: false,
  }).catch((error) => error);
  await started;
  first.close();
  assert.equal((await settlesWithin(
    active,
    250,
    "close() left an in-flight request pending until its RPC timeout",
  )).code, "CONNECTION_CLOSED");

  for (let index = 0; index < waiterClients.length; index += 1) {
    const client = waiterClients[index];
    const request = client.request("store.count", { scope: "project" }, {
      requestId: `materialization-close-waiter-${index}`,
      retry: false,
    }).catch((error) => error);
    await waitFor(
      () => daemon.outputWaiters.length === 1,
      "reconnected request did not wait for materialization capacity",
    );
    client.close();
    assert.equal((await settlesWithin(
      request,
      250,
      "close() left a materialization waiter pending until its RPC timeout",
    )).code, "CONNECTION_CLOSED");
    await waitFor(
      () => daemon.outputWaiters.length === 0,
      "closed materialization waiter was not removed",
    );
  }
  assert.equal(executions, 1);
  assert.equal(daemon.outputReservations.size, 1);
  assert.equal(daemon.bufferedOutputBytes, 1_025);

  releaseHandler();
  await waitFor(
    () => daemon.outputReservations.size === 0 && daemon.bufferedOutputBytes === 0,
    "completed closed-client handler did not release materialization capacity",
  );
});

test("shutdown has a deadline for a blocked socket drain", async (t) => {
  const paths = fixture();
  const store = fakeStore();
  const largeText = "x".repeat(4 * 1_024 * 1_024);
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: () => store,
    shutdownSocketDrainMs: 20,
    operationHandlers: {
      "store.get": (_payload, context) => ({
        status: "resolved",
        document: {
          documentId: "blocked-shutdown",
          version: 1,
          sourceKey: "blocked-shutdown",
          sessionId: "blocked-shutdown",
          project: context.project,
          kind: "turn",
          createdAt: 1,
          text: largeText,
          metadata: {},
          sourceMessageKeys: [],
          sourceKeyStatus: "preserved",
        },
      }),
    },
  });
  t.after(() => daemon.close());
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  t.after(() => client.close());
  await client.connect();
  client.socket.pause();
  const pending = client.request("store.get", { documentId: "blocked-shutdown" }, {
    retry: false,
  }).catch((error) => error);
  const serverSocket = [...daemon.connections][0];
  for (let attempt = 0; attempt < 100 && serverSocket.writableLength === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(serverSocket.writableLength > 0);

  await daemon.close();
  assert.equal(store.closed, true);
  client.socket?.resume();
  assert.equal((await pending).code, "CONNECTION_CLOSED");
});

test("shutdown has a deadline for an idle half-open socket", async () => {
  const paths = fixture();
  const store = fakeStore();
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: () => store,
    handshakeTimeoutMs: 5_000,
    shutdownSocketDrainMs: 20,
  });
  const idle = createConnection({ path: paths.socketPath, allowHalfOpen: true });
  await new Promise((resolve, reject) => {
    idle.once("connect", resolve);
    idle.once("error", reject);
  });
  idle.resume();

  let timeout;
  try {
    await Promise.race([
      daemon.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("idle half-open socket blocked shutdown")), 500);
      }),
    ]);
    assert.equal(store.closed, true);
    assert.equal(daemon.connections.size, 0);
  } finally {
    clearTimeout(timeout);
    idle.destroy();
    await daemon.close();
  }
});

test("shutdown drains an active handler before closing storage", async () => {
  const paths = fixture();
  const store = fakeStore();
  let observedClosed;
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: () => store,
    operationHandlers: {
      "store.pin": async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        observedClosed = store.closed;
        return { status: "pinned", pinId: payload.pinId };
      },
    },
  });
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  const pending = client.request("store.pin", {
    pinId: "pin-drain",
    documentId: "document-drain",
    version: 1,
    reason: "test drain",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const closing = daemon.close();
  await pending;
  await closing;
  client.close();
  assert.equal(observedClosed, false);
  assert.equal(store.closed, true);
});

test("a close error leaves the daemon terminal and releases native ownership", async () => {
  const paths = fixture();
  const daemon = await startStoreDaemon({
    ...paths,
    createStore: () => ({ close() { throw new Error("close fault"); } }),
  });
  await assert.rejects(daemon.close(), /close fault/u);
  assert.equal(daemon.closed, true);
  await assert.rejects(daemon.start(), (error) => error.code === "CONNECTION_CLOSED");

  const replacement = await startStoreDaemon({ ...paths, createStore: fakeStore });
  await replacement.close();
});

test("explicitly enabled remote shutdown closes the daemon", async () => {
  const paths = fixture();
  const daemon = await startStoreDaemon({ ...paths, createStore: fakeStore, allowShutdown: true });
  const client = new StoreClient({ socketPath: paths.socketPath, project: paths.directory });
  const result = await client.request("daemon.shutdown", { reason: "test complete" });
  assert.deepEqual(result, { accepted: true });
  for (let attempt = 0; attempt < 100 && !daemon.closed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  client.close();
  assert.equal(daemon.closed, true);
});
