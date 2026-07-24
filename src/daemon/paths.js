import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

export class UnsafeSocketPathError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnsafeSocketPathError";
    this.code = "UNSAFE_SOCKET_PATH";
    this.retryable = false;
    this.details = details;
  }
}

export class UnsafeStorePathError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnsafeStorePathError";
    this.code = "UNSAFE_STORE_PATH";
    this.retryable = false;
    this.details = details;
  }
}

export class UnsupportedDaemonPlatformError extends Error {
  constructor(platform) {
    super(`Context Window's local daemon requires Unix-domain sockets; platform ${platform} is unsupported.`);
    this.name = "UnsupportedDaemonPlatformError";
    this.code = "UNSUPPORTED_DAEMON_PLATFORM";
    this.retryable = false;
    this.details = { platform };
  }
}

export function assertDaemonPlatform(platform = process.platform) {
  if (platform === "win32") throw new UnsupportedDaemonPlatformError(platform);
}

function canonicalPathWithMissingTail(path) {
  let cursor = path;
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(cursor), ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return path;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Resolve the database directory once so every owner competes for one lock. */
export function resolveStorePath(path) {
  if (typeof path !== "string" || !path.trim()) {
    throw new TypeError("A non-empty RocksDB store path is required.");
  }
  return canonicalPathWithMissingTail(resolve(path));
}

/**
 * Create a current-user-only trust boundary around persisted conversation data.
 * Existing user-owned directories are tightened before RocksDB can open them.
 */
export function ensureSecureStoreDirectory(storePath) {
  const directory = resolveStorePath(storePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = realpathSync.native(directory);
  const stat = lstatSync(canonicalDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} must be a real directory, not a symlink or file.`,
      { directory: canonicalDirectory },
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} is owned by uid ${stat.uid}, not the current uid ${uid}.`,
      { directory: canonicalDirectory, ownerUid: stat.uid, expectedUid: uid },
    );
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(canonicalDirectory, 0o700);
  const mode = lstatSync(canonicalDirectory).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} must not grant group or other access.`,
      { directory: canonicalDirectory, mode },
    );
  }
  return canonicalDirectory;
}

/**
 * Validate an existing store trust boundary without creating or chmodding it.
 * Offline report-only maintenance uses this path so inspection has no
 * filesystem side effects.
 */
export function inspectSecureStoreDirectory(storePath) {
  const directory = resolveStorePath(storePath);
  const canonicalDirectory = realpathSync.native(directory);
  const stat = lstatSync(canonicalDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} must be a real directory, not a symlink or file.`,
      { directory: canonicalDirectory },
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} is owned by uid ${stat.uid}, not the current uid ${uid}.`,
      { directory: canonicalDirectory, ownerUid: stat.uid, expectedUid: uid },
    );
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new UnsafeStorePathError(
      `RocksDB store ${canonicalDirectory} must not grant group or other access.`,
      { directory: canonicalDirectory, mode },
    );
  }
  return canonicalDirectory;
}

function socketNamespace() {
  const identity = `${process.getuid?.() ?? "nouid"}:${homedir()}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return join(tmpdir(), `cw-${digest}`);
}

function assertTrustedOwner(stat, path, uid) {
  if (uid === undefined || stat.uid === uid || stat.uid === 0) return;
  throw new UnsafeSocketPathError(
    `Daemon socket path ancestor ${path} is owned by untrusted uid ${stat.uid}.`,
    { path, ownerUid: stat.uid, expectedUid: uid },
  );
}

function assertSafeAncestors(directory) {
  const uid = process.getuid?.();
  const { root } = parse(directory);
  const relative = directory.slice(root.length).split(/[/\\]+/u).filter(Boolean);
  let cursor = root;
  // The leaf receives the stricter current-user 0700 check below. Ancestors
  // may be root-owned and read-only to other users, or a sticky shared root
  // such as /tmp, but never controlled by an unrelated uid.
  for (const segment of relative.slice(0, -1)) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    assertTrustedOwner(stat, cursor, uid);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      throw new UnsafeSocketPathError(
        `Daemon socket path ancestor ${cursor} is not a directory.`,
        { path: cursor },
      );
    }
    const groupOrOtherWritable = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (groupOrOtherWritable && !sticky) {
      throw new UnsafeSocketPathError(
        `Daemon socket path ancestor ${cursor} is writable by other users without sticky protection.`,
        { path: cursor, mode: stat.mode & 0o7777 },
      );
    }
  }
}

function assertSafeDirectory(directory) {
  assertSafeAncestors(directory);
  const canonicalDirectory = realpathSync.native(directory);
  if (canonicalDirectory !== directory) assertSafeAncestors(canonicalDirectory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeSocketPathError(
      `Daemon socket directory ${directory} must be a real directory, not a symlink or file.`,
      { directory },
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeSocketPathError(
      `Daemon socket directory ${directory} is owned by uid ${stat.uid}, not the current uid ${uid}.`,
      { directory, ownerUid: stat.uid, expectedUid: uid },
    );
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new UnsafeSocketPathError(
      `Daemon socket directory ${directory} must not grant group or other access.`,
      { directory, mode },
    );
  }
  return directory;
}

/**
 * Create and validate the socket's private trust boundary before either a
 * client connects or a daemon removes/binds a path inside it. This prevents a
 * different local user from pre-binding the predictable socket name in a
 * world-writable temporary directory and impersonating context-windowd.
 */
export function ensureSecureSocketDirectory(socketPath) {
  assertDaemonPlatform();
  if (typeof socketPath !== "string" || !socketPath.trim()) {
    throw new TypeError("A non-empty daemon socket path is required.");
  }
  const directory = dirname(resolve(socketPath));
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new UnsafeSocketPathError(
      `Daemon socket directory ${directory} could not be created safely.`,
      { directory, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  return assertSafeDirectory(directory);
}

/**
 * Unix domain sockets have short platform-specific path limits. Keep the
 * human-readable basename while binding identity to the full resolved path.
 */
export function defaultSocketPath(storePath) {
  assertDaemonPlatform();
  const resolved = resolveStorePath(storePath);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return join(socketNamespace(), `d-${digest}.sock`);
}
