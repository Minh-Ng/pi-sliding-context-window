import { createDaemonOperations } from "../src/daemon/operations.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { StoreClient } from "../src/store-client.js";

if (typeof global.gc !== "function") {
  throw new Error("daemon egress memory verifier requires --expose-gc");
}

const [mode, storePath, socketPath] = process.argv.slice(2);
if (!new Set(["prepare", "measure"]).has(mode) || !storePath || !socketPath) {
  throw new Error("usage: daemon-egress-memory-child.js prepare|measure STORE SOCKET");
}
const project = "/egress-memory";
const operationNames = [
  "store.put",
  "store.get",
  "store.search",
  "store.recall",
  "store.count",
  "store.preflight",
  "store.remove-hints",
  "store.protect",
  "store.release-protection",
  "store.pin",
  "store.unpin",
  "retention.run",
  "retention.status",
  "store.compact",
];

let runtime;
let daemon;
let sampledPeakRssBytes = 0;
const sample = () => {
  const rssBytes = process.memoryUsage().rss;
  if (rssBytes > sampledPeakRssBytes) sampledPeakRssBytes = rssBytes;
  return rssBytes;
};

try {
  const operationHandlers = Object.fromEntries(operationNames.map((operation) => [
    operation,
    (payload, context) => runtime.handlers()[operation](payload, context),
  ]));
  daemon = await startStoreDaemon({
    storePath,
    socketPath,
    operationHandlers,
    createStore: async (path) => {
      const store = await RocksStore.open(path);
      runtime = await createDaemonOperations(store);
      return store;
    },
    beforeStoreClose: () => runtime?.close(),
    statusProvider: () => runtime.status(),
  });

  if (mode === "prepare") {
    const escapedText = "\0".repeat(240_000);
    const writer = new StoreClient({ socketPath, project, requestTimeoutMs: 30_000 });
    await writer.request("store.put", {
      idempotencyKey: "egress-memory-0",
      document: {
        documentId: "egress-memory-0",
        version: 1,
        sourceKey: "egress-memory-0",
        sessionId: "egress-memory",
        project,
        kind: "turn",
        createdAt: 1,
        text: escapedText,
        metadata: {},
        sourceMessageKeys: [],
        sourceKeyStatus: "preserved",
      },
      retentionClass: "conversation-source",
    }, { requestId: "egress-memory-put-0", retry: false });
    writer.close();
    process.stdout.write(`${JSON.stringify({ prepared: true })}\n`);
  } else {
    global.gc();
    const baselineRssBytes = sample();

  const clients = Array.from({ length: 16 }, () => new StoreClient({
    socketPath,
    project,
    requestTimeoutMs: 30_000,
  }));
  await Promise.all(clients.map((client) => client.connect()));
  for (const client of clients) client.socket.pause();
  const requests = clients.map((client, index) => client.request(
    "store.get",
    { documentId: "egress-memory-0" },
    { requestId: `egress-memory-get-${index}`, retry: false },
  ).catch((error) => error));

  let gated = false;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    sample();
    if (daemon.outputWaiters.length > 0
      && daemon.outputReservations.size + daemon.outputWaiters.length === 16) {
      gated = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!gated) {
    throw new Error(
      `egress gate did not stabilize: ${daemon.outputReservations.size} reservations, `
      + `${daemon.outputWaiters.length} waiters, ${daemon.bufferedOutputBytes} bytes`,
    );
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    sample();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const gatedOutputBytes = daemon.bufferedOutputBytes;
  const gatedReservations = daemon.outputReservations.size;
  const gatedWaiters = daemon.outputWaiters.length;

  for (const client of clients) client.close();
  await Promise.all(requests);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    sample();
    if (daemon.outputReservations.size === 0
      && daemon.outputWaiters.length === 0
      && daemon.bufferedOutputBytes === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

    const peakRssBytes = process.resourceUsage().maxRSS * 1_024;
    process.stdout.write(`${JSON.stringify({
      baselineRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - baselineRssBytes,
      sampledPeakRssBytes,
      gatedOutputBytes,
      gatedReservations,
      gatedWaiters,
      maxBufferedOutputBytes: daemon.maxBufferedOutputBytes,
      releasedOutputBytes: daemon.bufferedOutputBytes,
      releasedReservations: daemon.outputReservations.size,
      releasedWaiters: daemon.outputWaiters.length,
    })}\n`);
  }
} finally {
  await daemon?.close();
}
