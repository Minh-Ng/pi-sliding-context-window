#!/usr/bin/env node
import { startStoreDaemon } from "../src/daemon/server.js";

const [storePath, socketPath, serverVersion = "context-windowd:stale-fixture"] = process.argv.slice(2);
if (!storePath || !socketPath) throw new Error("storePath and socketPath are required.");

let daemon;
let stopping;
async function stop(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    try { await daemon?.close(); } finally { process.exit(code); }
  })();
  return stopping;
}

try {
  daemon = await startStoreDaemon({
    storePath,
    socketPath,
    serverVersion,
    createStore: async () => ({
      close() {},
      status() { return {}; },
    }),
    operationHandlers: {},
  });
  process.stdout.write(`${JSON.stringify({ status: "ready", processId: process.pid })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void stop(0); });
}
process.once("beforeExit", () => { void stop(0); });
