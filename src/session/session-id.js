import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_LINEAGE_DEPTH = 64;
const MAX_SUPPORTED_SESSION_VERSION = 3;

export function stablePathSessionId(path) {
  return createHash("sha256").update(String(path)).digest("hex").slice(0, 20);
}

export function stableSessionId(sessionManager, cwd) {
  const direct = sessionManager?.getSessionId?.();
  if (direct) return String(direct);
  const file = sessionManager?.getSessionFile?.();
  return stablePathSessionId(file ?? cwd);
}

function readSessionHeader(file) {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, length).indexOf(10);
    const text = buffer.subarray(0, newline < 0 ? length : newline).toString("utf8").trim();
    if (!text || (newline < 0 && length === buffer.length)) return undefined;
    const header = JSON.parse(text);
    return header && typeof header === "object" && !Array.isArray(header) ? header : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* startup lineage is best-effort */ }
    }
  }
}

function resolvedParentPath(parentSession, childFile) {
  if (typeof parentSession !== "string" || !parentSession.trim()) return undefined;
  try {
    return resolve(isAbsolute(parentSession) ? parentSession : resolve(dirname(childFile), parentSession));
  } catch {
    return undefined;
  }
}

function canonicalCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim() || !isAbsolute(cwd)) return undefined;
  try {
    const absolute = resolve(cwd);
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  } catch {
    return undefined;
  }
}

function sameCwd(left, right) {
  if (!left || !right) return false;
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validSessionHeader(header, expectedCwd) {
  if (header?.type !== "session"
    || typeof header.id !== "string"
    || !header.id.trim()
    || typeof header.timestamp !== "string"
    || !header.timestamp.trim()
    || !Number.isFinite(Date.parse(header.timestamp))) return false;

  const headerCwd = canonicalCwd(header.cwd);
  if (!headerCwd || (expectedCwd && !sameCwd(headerCwd, expectedCwd))) return false;

  // Pi treats an omitted version as legacy v1. Persisted explicit versions
  // range from v1 through the current v3 session format.
  return header.version === undefined
    || (Number.isSafeInteger(header.version)
      && header.version >= 1
      && header.version <= MAX_SUPPORTED_SESSION_VERSION);
}

/**
 * Derive archive identities inherited from parent session-file headers.
 * Failures deliberately terminate that branch rather than disrupting startup.
 * @param {string | undefined} sessionFile
 * @param {{ fallbackParentFile?: string, maxDepth?: number, expectedCwd?: string }} [options]
 * @returns {string[]}
 */
export function ancestorSessionIds(
  sessionFile,
  { fallbackParentFile, maxDepth = MAX_LINEAGE_DEPTH, expectedCwd } = {},
) {
  const initialFile = typeof sessionFile === "string" && sessionFile.trim()
    ? resolve(sessionFile)
    : undefined;
  const fallbackFile = typeof fallbackParentFile === "string" && fallbackParentFile.trim()
    ? resolve(fallbackParentFile)
    : undefined;
  const depthLimit = Math.min(
    MAX_LINEAGE_DEPTH,
    Number.isSafeInteger(maxDepth) && maxDepth > 0 ? maxDepth : MAX_LINEAGE_DEPTH,
  );
  const suppliedCwd = expectedCwd === undefined ? undefined : canonicalCwd(expectedCwd);
  if (expectedCwd !== undefined && !suppliedCwd) return [];

  const ids = [];
  const seenIds = new Set();
  const seenPaths = new Set(initialFile ? [initialFile] : []);
  let childFile = initialFile;
  let header = childFile ? readSessionHeader(childFile) : undefined;
  const childIsValid = childFile && validSessionHeader(header, suppliedCwd);
  let projectCwd = suppliedCwd ?? (childIsValid ? canonicalCwd(header.cwd) : undefined);
  let parentFile = childIsValid
    ? resolvedParentPath(header.parentSession, childFile)
    : undefined;

  if (!parentFile && fallbackFile && fallbackFile !== initialFile) parentFile = fallbackFile;

  for (let depth = 0; parentFile && depth < depthLimit; depth += 1) {
    if (seenPaths.has(parentFile)) break;
    seenPaths.add(parentFile);

    header = readSessionHeader(parentFile);
    if (!validSessionHeader(header, projectCwd)) break;
    projectCwd ??= canonicalCwd(header.cwd);
    const id = header.id.trim();
    if (!seenIds.has(id)) {
      seenIds.add(id);
      ids.push(id);
    }

    childFile = parentFile;
    parentFile = resolvedParentPath(header.parentSession, childFile);
  }

  return ids;
}
