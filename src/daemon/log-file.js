import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_DAEMON_LOG_BYTES = 4 * 1_024 * 1_024;

export function defaultDaemonLogPath(storePath) {
  return join(dirname(resolve(storePath)), "daemon-events.jsonl");
}

export function defaultDaemonLaunchLogPath(storePath) {
  return join(dirname(resolve(storePath)), "daemon-launch.log");
}

function rotate(path, maxBytes) {
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Daemon log path must be a regular file: ${path}`);
  }
  if (status.size <= maxBytes) return;
  const previous = `${path}.1`;
  rmSync(previous, { force: true });
  renameSync(path, previous);
}

export function openDaemonLog(path, { maxBytes = MAX_DAEMON_LOG_BYTES } = {}) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    rotate(resolved, maxBytes);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    resolved,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  chmodSync(resolved, 0o600);
  return { descriptor, path: resolved };
}

export function writeDaemonLog(descriptor, event) {
  writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
}

export function closeDaemonLog(descriptor) {
  try { closeSync(descriptor); } catch { /* best-effort diagnostics */ }
}
