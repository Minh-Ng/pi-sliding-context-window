import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_OPERATIONS } from "../store/store-contract.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DAEMON_SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
const DAEMON_ENTRYPOINT = resolve(PACKAGE_ROOT, "bin/context-windowd.js");

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function computeRuntimeVersion() {
  const hash = createHash("sha256");
  const files = [DAEMON_ENTRYPOINT, ...sourceFiles(DAEMON_SOURCE_ROOT)]
    .sort((left, right) => left.localeCompare(right));
  for (const path of files) {
    hash.update(relative(PACKAGE_ROOT, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `context-windowd:${hash.digest("hex").slice(0, 24)}`;
}

/**
 * Fingerprint of the shipped daemon entrypoint and production JavaScript.
 * It is evaluated once per process, so a daemon keeps the generation it
 * actually loaded while a reloaded client sees the newly installed files.
 */
export const DAEMON_RUNTIME_VERSION = computeRuntimeVersion();

/** Every normal operation a DaemonArchive facade may issue. */
export const DAEMON_REQUIRED_CAPABILITIES = Object.freeze(
  STORE_OPERATIONS.filter((operation) => operation !== "daemon.shutdown"),
);
