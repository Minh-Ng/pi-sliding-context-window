import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_DAEMON_LOG_BYTES = 4 * 1_024 * 1_024;
export const MAX_DAEMON_LOG_RECORD_BYTES = 64 * 1_024;
export const MAX_DAEMON_SAMPLE_BYTES = 4 * 1_024 * 1_024;
const LOG_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const LOG_LOCK_TIMEOUT_MS = 2_000;
const LOG_LOCK_STALE_MS = 10_000;

export function defaultDaemonLogPath(storePath) {
  return join(dirname(resolve(storePath)), "daemon-events.jsonl");
}

export function defaultDaemonLaunchLogPath(storePath) {
  return join(dirname(resolve(storePath)), "daemon-launch.log");
}

function positiveBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 1_024) {
    throw new TypeError(`${label} must be a safe integer of at least 1024 bytes.`);
  }
  return value;
}

function regularFileStatus(path) {
  if (!existsSync(path)) return undefined;
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Daemon log path must be a regular file: ${path}`);
  }
  return status;
}

function boundedTail(path, maxBytes) {
  const status = regularFileStatus(path);
  if (!status || status.size <= maxBytes) {
    if (status) chmodSync(path, 0o600);
    return status?.size ?? 0;
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let buffer;
  try {
    const bytes = Math.min(status.size, maxBytes);
    buffer = Buffer.allocUnsafe(bytes);
    readSync(descriptor, buffer, 0, bytes, status.size - bytes);
  } finally {
    closeSync(descriptor);
  }
  const newline = buffer.indexOf(0x0a);
  if (newline >= 0 && newline + 1 < buffer.length) buffer = buffer.subarray(newline + 1);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, buffer, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  chmodSync(path, 0o600);
  return buffer.length;
}

/** Keep one bounded previous generation of a daemon-owned text artifact. */
export function rotateDaemonArtifact(path, { maxBytes = MAX_DAEMON_LOG_BYTES } = {}) {
  const resolved = resolve(path);
  const maximum = positiveBytes(maxBytes, "maxBytes");
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const status = regularFileStatus(resolved);
  if (!status) return false;
  const previous = `${resolved}.1`;
  rmSync(previous, { force: true });
  renameSync(resolved, previous);
  boundedTail(previous, maximum);
  return true;
}

/** Enforce a strict byte cap and private permissions on an existing artifact. */
export function capDaemonArtifact(path, { maxBytes = MAX_DAEMON_SAMPLE_BYTES } = {}) {
  return boundedTail(resolve(path), positiveBytes(maxBytes, "maxBytes"));
}

function openDescriptor(path) {
  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  chmodSync(path, 0o600);
  return descriptor;
}

export function openDaemonLog(path, { maxBytes = MAX_DAEMON_LOG_BYTES } = {}) {
  const resolved = resolve(path);
  const maximum = positiveBytes(maxBytes, "maxBytes");
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const status = regularFileStatus(resolved);
  if (status?.size > maximum) rotateDaemonArtifact(resolved, { maxBytes: maximum });
  const descriptor = openDescriptor(resolved);
  return { descriptor, path: resolved, maxBytes: maximum };
}

function serializedRecord(event, maxBytes) {
  let text = `${JSON.stringify(event)}\n`;
  const originalBytes = Buffer.byteLength(text, "utf8");
  const recordLimit = Math.min(maxBytes, MAX_DAEMON_LOG_RECORD_BYTES);
  if (originalBytes <= recordLimit) return text;
  text = `${JSON.stringify({
    timestamp: event?.timestamp,
    processId: event?.processId,
    event: "log-record-truncated",
    originalEvent: String(event?.event ?? "unknown").slice(0, 256),
    originalBytes,
  })}\n`;
  if (Buffer.byteLength(text, "utf8") > recordLimit) {
    throw new RangeError("Daemon log truncation record exceeds the configured log bound.");
  }
  return text;
}

/** Write one complete JSONL record while keeping active and backup files bounded. */
export function writeDaemonLog(writer, event) {
  if (!writer || typeof writer !== "object" || !Number.isSafeInteger(writer.descriptor)) {
    throw new TypeError("writeDaemonLog requires an open daemon log writer.");
  }
  const text = serializedRecord(event, writer.maxBytes);
  const bytes = Buffer.byteLength(text, "utf8");
  const status = fstatSync(writer.descriptor);
  if (status.size + bytes > writer.maxBytes) {
    closeSync(writer.descriptor);
    rotateDaemonArtifact(writer.path, { maxBytes: writer.maxBytes });
    writer.descriptor = openDescriptor(writer.path);
  }
  writeSync(writer.descriptor, text, undefined, "utf8");
}

export function closeDaemonLog(writer) {
  const descriptor = typeof writer === "number" ? writer : writer?.descriptor;
  if (!Number.isSafeInteger(descriptor)) return;
  try { closeSync(descriptor); } catch { /* best-effort diagnostics */ }
}

function acquireLogLock(path) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOG_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeSync(descriptor, `${process.pid}\n`, undefined, "utf8");
      return { descriptor, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const status = lstatSync(lockPath);
        if (!status.isFile() || status.isSymbolicLink() || Date.now() - status.mtimeMs > LOG_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== "ENOENT") throw inspectionError;
      }
      Atomics.wait(LOG_LOCK_WAIT, 0, 0, 2);
    }
  }
  throw new Error(`Timed out waiting for daemon log rotation lock: ${lockPath}`);
}

/** Serialize multi-process lifecycle appends around rotation. */
export function appendDaemonLog(path, event, options = {}) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const lock = acquireLogLock(resolved);
  try {
    const writer = openDaemonLog(resolved, options);
    try { writeDaemonLog(writer, event); } finally { closeDaemonLog(writer); }
  } finally {
    closeSync(lock.descriptor);
    rmSync(lock.lockPath, { force: true });
  }
}
