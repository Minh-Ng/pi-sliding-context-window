#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getMigrationStatus,
  startMigration,
  verifyMigration,
} from "../src/migration/index.js";
import { StoreClient } from "../src/store-client.js";
import { RocksStore } from "../src/rocksdb/store.js";

const USAGE = `Usage:
  context-window-migrate status (--store PATH | --socket PATH)
  context-window-migrate start (--store PATH | --socket PATH) --source ARCHIVE.db --offline [--batch-size N]
  context-window-migrate verify (--store PATH | --socket PATH) [--source ARCHIVE.db] [--sample-limit N] [--allowlist FILE] [--artifact FILE]`;

function argument(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new TypeError(`${name} is required.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value.`);
  }
  return value;
}

function integerArgument(args, name) {
  const raw = argument(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer.`);
  return value;
}

function allowlistArgument(args) {
  const path = argument(args, "--allowlist");
  if (path === undefined) return [];
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(value)) throw new TypeError("--allowlist must contain a JSON array.");
  return value;
}

function resolvedArgument(args, name) {
  const value = argument(args, name);
  return value === undefined ? undefined : resolve(value);
}

function targetArguments(args) {
  const storePath = resolvedArgument(args, "--store");
  const socketPath = resolvedArgument(args, "--socket");
  if ((storePath === undefined) === (socketPath === undefined)) {
    throw new TypeError("Exactly one of --store or --socket is required.");
  }
  return { storePath, socketPath };
}

function startOptions(args) {
  if (!args.includes("--offline")) {
    throw new TypeError(
      "--offline is required and asserts that every process writing the SQLite archive has been stopped.",
    );
  }
  const batchSize = integerArgument(args, "--batch-size");
  return {
    sourcePath: resolve(argument(args, "--source", { required: true })),
    ...(batchSize === undefined ? {} : { batchSize }),
    offline: true,
  };
}

function verifyOptions(args) {
  const sourcePath = resolvedArgument(args, "--source");
  const artifactPath = resolvedArgument(args, "--artifact");
  const sampleLimit = integerArgument(args, "--sample-limit");
  return {
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(sampleLimit === undefined ? {} : { sampleLimit }),
    allowlist: allowlistArgument(args),
  };
}

async function remoteCommand(command, args, socketPath) {
  const client = new StoreClient({
    socketPath,
    project: argument(args, "--project") ?? process.cwd(),
    client: "context-window-migrate",
  });
  try {
    if (command === "status") return await client.request("migration.status", {});
    if (command === "start") return await client.request("migration.start", startOptions(args));
    return await client.request("migration.verify", verifyOptions(args));
  } finally {
    client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === undefined || command === "help" || args.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!new Set(["status", "start", "verify"]).has(command)) {
    throw new TypeError(`Unknown migration command ${command}.\n${USAGE}`);
  }
  const { storePath, socketPath } = targetArguments(args);
  if (socketPath !== undefined) {
    const result = await remoteCommand(command, args, socketPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const store = await RocksStore.open(storePath);
  try {
    let result;
    if (command === "status") {
      result = await getMigrationStatus(store);
    } else if (command === "start") {
      result = await startMigration(store, startOptions(args));
    } else {
      result = await verifyMigration(store, verifyOptions(args));
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "ERR_MIGRATION_CLI",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
