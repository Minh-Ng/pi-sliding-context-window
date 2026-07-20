import { parentPort, workerData } from "node:worker_threads";
import { startStoreDaemon } from "../src/daemon/server.js";
import { StoreClient } from "../src/store/store-client.js";

let daemon;
let heldClient;
let releaseTimer;
let busyExecutions = 0;
let connectionAttempts = 0;

function scheduleHeldRelease() {
  if (!heldClient || releaseTimer !== undefined) return;
  releaseTimer = setTimeout(() => {
    heldClient?.close();
    heldClient = undefined;
  }, workerData.holdConnectionMs);
}

try {
  const operationHandlers = {};
  if (workerData.busyHandlerDelayMs !== undefined) {
    operationHandlers["store.count"] = async () => {
      busyExecutions += 1;
      await new Promise((resolve) => setTimeout(resolve, workerData.busyHandlerDelayMs));
      const error = new Error("Synthetic handler capacity is busy.");
      error.code = "STORE_BUSY";
      throw error;
    };
  }
  daemon = await startStoreDaemon({
    storePath: workerData.storePath,
    socketPath: workerData.socketPath,
    createStore: () => ({ close() {} }),
    operationHandlers,
    ...(workerData.maxConnections === undefined
      ? {}
      : { maxConnections: workerData.maxConnections }),
  });
  daemon.server.on("connection", () => { connectionAttempts += 1; });
  if (workerData.holdConnectionMs !== undefined) {
    heldClient = new StoreClient({
      socketPath: workerData.socketPath,
      project: workerData.project ?? workerData.storePath,
    });
    await heldClient.connect();
    if (!workerData.armHoldRelease) scheduleHeldRelease();
  }
  parentPort.postMessage({ status: "ready" });
} catch (error) {
  parentPort.postMessage({
    status: "error",
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
  });
}

parentPort.on("message", async (message) => {
  if (message === "arm-release") {
    scheduleHeldRelease();
    return;
  }
  if (message === "stats") {
    parentPort.postMessage({
      status: "stats",
      busyExecutions,
      connectionAttempts,
      activeConnections: daemon?.connections.size ?? 0,
    });
    return;
  }
  if (message !== "stop") return;
  clearTimeout(releaseTimer);
  heldClient?.close();
  await daemon?.close();
  parentPort.postMessage({ status: "stopped" });
  parentPort.close();
});
