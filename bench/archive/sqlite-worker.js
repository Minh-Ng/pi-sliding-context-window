import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { Archive } from "../../src/archive.js";
import { archiveWarmupOperationCount, benchmarkDocumentAt } from "./fixture.js";

const {
  clientIndex,
  clients,
  fixture,
  path,
  retention,
  workload,
} = workerData;

function profile() {
  if (workload === "tool-10kib") return "tool-10kib";
  if (workload === "tool-1mib") return "tool-1mib";
  return undefined;
}

const count = workload === "canonical"
  ? Math.max(fixture.logicalWindows, clients)
  : Math.max(fixture.largeSamples, clients);
const indices = [];
for (let index = clientIndex; index < count; index += clients) indices.push(index);
const prepared = workload === "canonical"
  ? undefined
  : new Map(indices.map((index) => [index, benchmarkDocumentAt(index, {
      count,
      seed: fixture.seed,
      officialScale: false,
      profile: profile(),
    })]));
const archive = new Archive(path, { retention });
const retryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function putWithBusyRetry(document) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { stored: archive.put(document, { deferPrune: true }), retries: attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/busy|locked/iu.test(message) || attempt >= 99) throw error;
      // The production connection already waits for SQLite's five-second busy
      // timeout. A short bounded pause prevents a hot worker from immediately
      // winning the next lock again after another worker times out.
      Atomics.wait(retryWait, 0, 0, Math.min(5, attempt + 1));
    }
  }
}

const warmupCount = archiveWarmupOperationCount(workload, clients);
for (let index = clientIndex; index < warmupCount; index += clients) {
  const document = benchmarkDocumentAt(index, {
    count: warmupCount,
    seed: fixture.seed,
    officialScale: false,
    profile: profile() ?? "short",
  });
  const warmup = {
    ...document,
    id: `warmup-${workload}-${clients}-${index}`,
    sessionId: `warmup-session-${clientIndex}`,
  };
  const { stored } = putWithBusyRetry(warmup);
  if (stored !== warmup.id) throw new Error(`SQLite did not acknowledge warmup ${warmup.id}`);
}
parentPort.postMessage({ type: "ready" });

parentPort.once("message", (message) => {
  if (message?.type !== "start") throw new Error("SQLite benchmark worker expected a start message");
  const samples = [];
  let payloadBytes = 0;
  let busyRetryCount = 0;
  try {
    for (const index of indices) {
      const document = prepared?.get(index) ?? benchmarkDocumentAt(index, {
        count,
        seed: fixture.seed,
        officialScale: workload === "canonical" && fixture.officialScale,
        profile: profile(),
      });
      payloadBytes += document.payloadBytes;
      const startedAt = performance.now();
      const outcome = putWithBusyRetry(document);
      const stored = outcome.stored;
      busyRetryCount += outcome.retries;
      const milliseconds = performance.now() - startedAt;
      if (stored !== document.id) throw new Error(`SQLite did not acknowledge ${document.id}`);
      samples.push([index, milliseconds]);
    }
  } finally {
    archive.close();
  }
  parentPort.postMessage({ type: "result", busyRetryCount, payloadBytes, samples });
  parentPort.close();
});
