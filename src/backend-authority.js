import { defaultSocketPath, resolveStorePath } from "./daemon/paths.js";
import { SynchronousStoreBridge } from "./daemon-client/sync-bridge.js";

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Claim SQLite before its writable connection opens. The claim is stored in
 * the configured RocksDB destination even when that destination did not exist,
 * so a concurrent fresh RocksDB activation cannot create split authority.
 */
export function claimSqliteBackendAuthority({
  storePath,
  socketPath,
  sourcePath,
  project,
  requestTimeoutMs,
  daemonStartTimeoutMs,
}) {
  const resolvedStorePath = resolveStorePath(storePath);
  const bridge = new SynchronousStoreBridge({
    storePath: resolvedStorePath,
    socketPath: socketPath ?? defaultSocketPath(resolvedStorePath),
    project: requiredString(project, "project"),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(daemonStartTimeoutMs === undefined ? {} : { daemonStartTimeoutMs }),
  });
  try {
    return bridge.request("migration.claim-sqlite", {
      sourcePath: requiredString(sourcePath, "sourcePath"),
    });
  } finally {
    bridge.close();
  }
}
