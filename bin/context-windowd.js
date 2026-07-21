#!/usr/bin/env node
import { resolve } from "node:path";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { DAEMON_RUNTIME_VERSION } from "../src/daemon/runtime-version.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { defaultDaemonLogPath } from "../src/daemon/log-file.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { SEMANTIC_TIER_ALIASES, semanticModelProfile } from "../src/semantic/model-catalog.js";
import {
  DEFAULT_RERANKER_CANDIDATE_WINDOW,
  DEFAULT_RERANKER_MODEL,
  DEFAULT_RERANKER_MODEL_REVISION,
} from "../src/semantic/reranker-model.js";
import {
  DaemonWatchdog,
  DEFAULT_SLOW_REQUEST_MS,
  DEFAULT_STALL_THRESHOLD_MS,
} from "../src/daemon/watchdog.js";
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
  "--log",
  "--stall-threshold-ms",
  "--slow-request-ms",
  "--idle-shutdown-ms",
  "--maintenance-interval-ms",
  "--retention-batch-size",
  "--retention-waves",
  "--compaction-deleted-keys",
  "--compaction-reclaimable-bytes",
  "--critical-free-bytes",
  "--admission-reserve-bytes",
  "--semantic-model",
  "--semantic-revision",
  "--semantic-cache",
  "--semantic-index",
  "--semantic-candidates",
  "--semantic-dimensions",
  "--semantic-pooling",
  "--reranker-model",
  "--reranker-revision",
  "--reranker-cache",
  "--reranker-candidates",
  "--user-settings",
]);
const FLAG_OPTIONS = new Set(["--allow-shutdown", "--semantic", "--reranker", "--help"]);

function usage() {
  return [
    "Usage: context-windowd [options]",
    "  --store PATH                       RocksDB directory",
    "  --socket PATH                      Unix socket path",
    "  --log PATH                         Bounded daemon JSONL diagnostics",
    "  --stall-threshold-ms N             Event-loop watchdog threshold",
    "  --slow-request-ms N                Slow-operation logging threshold",
    "  --allow-shutdown                   Permit the remote shutdown operation",
    "  --idle-shutdown-ms N               Exit after the last client is gone (default: 300000)",
    "  --maintenance-interval-ms N        Maintenance interval",
    "  --retention-batch-size N           Retention records per wave",
    "  --retention-waves N                Retention waves per tick",
    "  --compaction-deleted-keys N        Deleted-key compaction threshold",
    "  --compaction-reclaimable-bytes N   Reclaimable-byte compaction threshold",
    "  --critical-free-bytes N            Low-disk emergency threshold",
    "  --admission-reserve-bytes N        Required free space after admission",
    "  --semantic                         Enable local semantic fallback",
    "  --semantic-model ID                Local embedding model id",
    "  --semantic-revision REVISION       Pinned embedding model revision",
    "  --semantic-cache PATH              Library-managed local model cache",
    "  --semantic-index PATH              Library-managed local ANN indexes",
    "  --semantic-candidates N            ANN candidates before filtering",
    "  --semantic-dimensions N            Override the model's catalog dimensions",
    "  --semantic-pooling MODE            Override the model's catalog pooling strategy",
    "  --reranker                         Enable cross-encoder rerank for explicit search/gather",
    "  --reranker-model ID                Local cross-encoder reranker model id",
    "  --reranker-revision REVISION       Pinned reranker model revision",
    "  --reranker-cache PATH              Library-managed local reranker model cache",
    "  --reranker-candidates N            Fused candidates reranked per query",
    "  --user-settings PATH               User-global settings file for the granted read ceiling",
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
const logPath = resolve(argument("--log", process.env.CONTEXT_WINDOW_DAEMON_LOG
  ?? defaultDaemonLogPath(storePath)));
const stallThresholdMs = Number(argument(
  "--stall-threshold-ms",
  process.env.CONTEXT_WINDOW_STALL_THRESHOLD_MS ?? DEFAULT_STALL_THRESHOLD_MS,
));
const slowRequestMs = Number(argument(
  "--slow-request-ms",
  process.env.CONTEXT_WINDOW_SLOW_REQUEST_MS ?? DEFAULT_SLOW_REQUEST_MS,
));
const idleShutdownMs = Number(argument(
  "--idle-shutdown-ms",
  process.env.CONTEXT_WINDOW_IDLE_SHUTDOWN_MS ?? 5 * 60 * 1_000,
));
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
const semanticDimensions = argument(
  "--semantic-dimensions",
  process.env.CONTEXT_WINDOW_SEMANTIC_MODEL_DIMENSIONS,
);
const semanticPooling = argument("--semantic-pooling", process.env.CONTEXT_WINDOW_SEMANTIC_MODEL_POOLING);
// A direct daemon launch (unlike the config-driven paths, which resolve
// aliases in loadConfig) is the only place a tier alias like "quality" can
// still reach --semantic-model as a raw CLI/env value, so resolve it here
// too — otherwise it's treated as a literal HF model id and misses the
// catalog entirely.
const rawSemanticModel = argument("--semantic-model", process.env.CONTEXT_WINDOW_SEMANTIC_MODEL);
const resolvedSemanticModel = rawSemanticModel === undefined
  ? "Xenova/all-MiniLM-L6-v2"
  : SEMANTIC_TIER_ALIASES[rawSemanticModel] ?? rawSemanticModel;
const semantic = {
  enabled: parsed.flags.has("--semantic")
    || ["1", "true", "yes", "on"].includes(String(process.env.CONTEXT_WINDOW_SEMANTIC_RETRIEVAL).toLowerCase()),
  model: resolvedSemanticModel,
  revision: argument("--semantic-revision", process.env.CONTEXT_WINDOW_SEMANTIC_MODEL_REVISION
    ?? semanticModelProfile(resolvedSemanticModel)?.revision
    ?? "751bff37182d3f1213fa05d7196b954e230abad9"),
  cachePath: resolve(argument("--semantic-cache", process.env.CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE
    ?? ".context-window/models")),
  indexPath: resolve(argument("--semantic-index", process.env.CONTEXT_WINDOW_SEMANTIC_INDEX
    ?? ".context-window/semantic-index")),
  candidates: Number(argument("--semantic-candidates", process.env.CONTEXT_WINDOW_SEMANTIC_CANDIDATES
    ?? 40)),
  // Left unset unless explicitly overridden, so LocalSemanticIndex derives
  // both from the model above via its catalog (see model-catalog.js).
  ...(semanticDimensions === undefined ? {} : { dimensions: Number(semanticDimensions) }),
  ...(semanticPooling === undefined ? {} : { pooling: semanticPooling }),
};
const reranker = {
  enabled: parsed.flags.has("--reranker")
    || ["1", "true", "yes", "on"].includes(String(process.env.CONTEXT_WINDOW_RERANKER_ENABLED).toLowerCase()),
  model: argument("--reranker-model", process.env.CONTEXT_WINDOW_RERANKER_MODEL ?? DEFAULT_RERANKER_MODEL),
  revision: argument(
    "--reranker-revision",
    process.env.CONTEXT_WINDOW_RERANKER_MODEL_REVISION ?? DEFAULT_RERANKER_MODEL_REVISION,
  ),
  cachePath: resolve(argument("--reranker-cache", process.env.CONTEXT_WINDOW_RERANKER_MODEL_CACHE
    ?? ".context-window/reranker-models")),
  candidateWindow: Number(argument(
    "--reranker-candidates",
    process.env.CONTEXT_WINDOW_RERANKER_CANDIDATES ?? DEFAULT_RERANKER_CANDIDATE_WINDOW,
  )),
};

let daemon;
let runtime;
let watchdog;
let runtimeClosing;
function closeRuntime() {
  if (!runtimeClosing) runtimeClosing = runtime?.close() ?? Promise.resolve();
  return runtimeClosing;
}
const runtimeOperations = [
  "store.put",
  "store.get",
  "store.search",
  "store.gather",
  "store.traverse",
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
  "feedback.stats",
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
  try {
    watchdog = new DaemonWatchdog({ logPath, stallThresholdMs, slowRequestMs });
    await watchdog.ready();
    watchdog.log("daemon-starting", { storePath, socketPath });
  } catch (error) {
    await watchdog?.close().catch(() => {});
    watchdog = undefined;
    process.stderr.write(`${JSON.stringify({
      status: "diagnostics-unavailable",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
  const { RocksStore } = await import("../src/rocksdb/store.js");
  daemon = await startStoreDaemon({
    storePath,
    socketPath,
    serverVersion: DAEMON_RUNTIME_VERSION,
    allowShutdown: parsed.flags.has("--allow-shutdown"),
    // The granted read ceiling (context-window.maxReadScope) is read by the
    // daemon from the user-global settings file only; project-local settings
    // cannot widen authorization. Overridable for tests.
    ...(parsed.values.has("--user-settings")
      ? { userSettingsPath: resolve(parsed.values.get("--user-settings")) }
      : {}),
    operationHandlers,
    beforeStoreClose: closeRuntime,
    requestObserver: watchdog,
    slowRequestMs,
    idleShutdownMs,
    createStore: async (path) => {
      const store = await RocksStore.open(path);
      try {
        runtime = await createDaemonOperations(store, { maintenance, semantic, reranker });
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
    logPath,
  })}\n`);
  watchdog?.log("daemon-ready", { storePath, socketPath });
} catch (error) {
  watchdog?.log("daemon-start-error", {
    code: error?.code ?? "INTERNAL",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 8_192),
  });
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

async function stop() {
  watchdog?.log("daemon-stopping");
  try {
    if (daemon) await daemon.close();
    else await closeRuntime();
  } finally {
    await watchdog?.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}

process.once("beforeExit", stop);
