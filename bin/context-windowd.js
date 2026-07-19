#!/usr/bin/env node
import { resolve } from "node:path";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  activateRocksBackend,
  claimSqliteBackend,
  getMigrationStatus,
  startMigration,
  verifyMigration,
} from "../src/migration/index.js";

const VALUE_OPTIONS = new Set([
  "--store",
  "--socket",
  "--maintenance-interval-ms",
  "--retention-batch-size",
  "--retention-waves",
  "--compaction-deleted-keys",
  "--compaction-reclaimable-bytes",
  "--critical-free-bytes",
  "--admission-reserve-bytes",
]);
const FLAG_OPTIONS = new Set(["--allow-shutdown", "--help"]);

function usage() {
  return [
    "Usage: context-windowd [options]",
    "  --store PATH                       RocksDB directory",
    "  --socket PATH                      Unix socket path",
    "  --allow-shutdown                   Permit the remote shutdown operation",
    "  --maintenance-interval-ms N        Maintenance interval",
    "  --retention-batch-size N           Retention records per wave",
    "  --retention-waves N                Retention waves per tick",
    "  --compaction-deleted-keys N        Deleted-key compaction threshold",
    "  --compaction-reclaimable-bytes N   Reclaimable-byte compaction threshold",
    "  --critical-free-bytes N            Low-disk emergency threshold",
    "  --admission-reserve-bytes N        Required free space after admission",
    "  --help                             Show this help",
  ].join("\n");
}

function parseArguments(args) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) throw new TypeError(`Duplicate option: ${option}`);
      flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) throw new TypeError(`Unknown option: ${option}`);
    if (values.has(option)) throw new TypeError(`Duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    values.set(option, value);
    index += 1;
  }
  return { values, flags };
}

let parsed;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exit(1);
}
if (parsed.flags.has("--help")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

function argument(name, fallback) {
  return parsed.values.get(name) ?? fallback;
}

const storePath = resolve(argument("--store", process.env.CONTEXT_WINDOW_ROCKSDB
  ?? ".context-window/archive.rocks"));
const socketPath = argument("--socket", process.env.CONTEXT_WINDOW_SOCKET
  ?? defaultSocketPath(storePath));
const maintenance = {
  intervalMs: argument(
    "--maintenance-interval-ms",
    process.env.CONTEXT_WINDOW_MAINTENANCE_INTERVAL_MS,
  ),
  retentionBatchSize: argument(
    "--retention-batch-size",
    process.env.CONTEXT_WINDOW_RETENTION_BATCH_SIZE,
  ),
  maxRetentionWaves: argument(
    "--retention-waves",
    process.env.CONTEXT_WINDOW_RETENTION_WAVES,
  ),
  compactionDeletedKeys: argument(
    "--compaction-deleted-keys",
    process.env.CONTEXT_WINDOW_COMPACTION_DELETED_KEYS,
  ),
  compactionReclaimableBytes: argument(
    "--compaction-reclaimable-bytes",
    process.env.CONTEXT_WINDOW_COMPACTION_RECLAIMABLE_BYTES,
  ),
  criticalFreeBytes: argument(
    "--critical-free-bytes",
    process.env.CONTEXT_WINDOW_CRITICAL_FREE_BYTES,
  ),
  admissionReserveBytes: argument(
    "--admission-reserve-bytes",
    process.env.CONTEXT_WINDOW_ADMISSION_RESERVE_BYTES,
  ),
};

let daemon;
let runtime;
let runtimeClosing;
function closeRuntime() {
  if (!runtimeClosing) runtimeClosing = runtime?.close() ?? Promise.resolve();
  return runtimeClosing;
}
const runtimeOperations = [
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
  "store.resolve-subject",
  "store.redact",
  "retention.run",
  "retention.status",
  "store.compact",
];
const operationHandlers = Object.fromEntries(runtimeOperations.map((operation) => [
  operation,
  (payload, context) => {
    const handler = runtime?.handlers()[operation];
    if (!handler) throw new Error(`Daemon runtime operation ${operation} is not ready.`);
    return handler(payload, context);
  },
]));
operationHandlers["migration.status"] = (_payload, context) => getMigrationStatus(context.store);
operationHandlers["migration.activate-rocks"] = (payload, context) =>
  activateRocksBackend(context.store, payload);
operationHandlers["migration.claim-sqlite"] = (payload, context) =>
  claimSqliteBackend(context.store, payload);
operationHandlers["migration.start"] = (payload, context) => startMigration(context.store, payload);
operationHandlers["migration.verify"] = (payload, context) => verifyMigration(context.store, payload);

try {
  const { RocksStore } = await import("../src/rocksdb/store.js");
  daemon = await startStoreDaemon({
    storePath,
    socketPath,
    allowShutdown: parsed.flags.has("--allow-shutdown"),
    operationHandlers,
    beforeStoreClose: closeRuntime,
    createStore: async (path) => {
      const store = await RocksStore.open(path);
      try {
        runtime = await createDaemonOperations(store, { maintenance });
        return store;
      } catch (error) {
        store.close();
        throw error;
      }
    },
    statusProvider: async ({ store, project }) => ({
      ...await runtime?.status(project),
      migration: await getMigrationStatus(store),
    }),
  });
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    processId: process.pid,
    storePath,
    socketPath,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

async function stop() {
  if (daemon) await daemon.close();
  else await closeRuntime();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}

process.once("beforeExit", stop);
