import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem } from "node:os";
import { readFileSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./schema.js";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function dependencyVersion(name) {
  try {
    let directory = dirname(require.resolve(name));
    for (let depth = 0; depth < 12; depth += 1) {
      try {
        const packageJson = readJson(resolve(directory, "package.json"));
        if (packageJson.name === name && typeof packageJson.version === "string") {
          return packageJson.version;
        }
      } catch {
        // Keep walking toward the package root. Package export maps commonly
        // prevent resolving package.json directly.
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return "unknown";
  } catch {
    return "not-installed";
  }
}

function filesystemMetadata(path) {
  try {
    const stats = statfsSync(path, { bigint: true });
    return {
      path,
      type: `0x${stats.type.toString(16)}`,
      blockSize: Number(stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
      availableBytes: Number(stats.bavail * stats.bsize),
    };
  } catch (error) {
    return {
      path,
      type: "unavailable",
      blockSize: 0,
      totalBytes: 0,
      availableBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function collectEvaluationEnvironment({ now = new Date(), cwd = repositoryRoot } = {}) {
  const packageJsonPath = resolve(repositoryRoot, "package.json");
  const packageLockPath = resolve(repositoryRoot, "package-lock.json");
  const packageJson = readJson(packageJsonPath);
  const lockBytes = readFileSync(packageLockPath);
  const cpuList = cpus();
  const revision = commandOutput("git", ["rev-parse", "HEAD"]) ?? "unavailable";
  const status = commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return Object.freeze({
    capturedAt: now.toISOString(),
    node: Object.freeze({ version: process.version, abi: process.versions.modules }),
    operatingSystem: Object.freeze({ platform: platform(), release: release(), arch: process.arch }),
    cpu: Object.freeze({ model: cpuList[0]?.model ?? "unknown", count: cpuList.length }),
    totalMemoryBytes: totalmem(),
    filesystem: Object.freeze(filesystemMetadata(cwd)),
    package: Object.freeze({ name: packageJson.name, version: packageJson.version }),
    dependencyLockSha256: sha256(lockBytes),
    dependencies: Object.freeze({
      rocksdb: dependencyVersion("@harperfast/rocksdb-js"),
      typebox: dependencyVersion("typebox"),
    }),
    git: Object.freeze({ revision, dirty: status === undefined ? "unknown" : status.length > 0 }),
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateEvaluationEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (!nonEmptyString(environment.capturedAt) || !Number.isFinite(Date.parse(environment.capturedAt))) {
    throw new TypeError("environment.capturedAt must be an ISO-8601 timestamp");
  }
  for (const [path, value] of [
    ["node.version", environment.node?.version],
    ["node.abi", environment.node?.abi],
    ["operatingSystem.platform", environment.operatingSystem?.platform],
    ["operatingSystem.release", environment.operatingSystem?.release],
    ["operatingSystem.arch", environment.operatingSystem?.arch],
    ["cpu.model", environment.cpu?.model],
    ["filesystem.path", environment.filesystem?.path],
    ["filesystem.type", environment.filesystem?.type],
    ["package.name", environment.package?.name],
    ["package.version", environment.package?.version],
    ["dependencyLockSha256", environment.dependencyLockSha256],
    ["dependencies.rocksdb", environment.dependencies?.rocksdb],
    ["dependencies.typebox", environment.dependencies?.typebox],
    ["git.revision", environment.git?.revision],
  ]) {
    if (!nonEmptyString(value)) throw new TypeError(`environment.${path} must be a non-empty string`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(environment.dependencyLockSha256)) {
    throw new TypeError("environment.dependencyLockSha256 must be a SHA-256 fingerprint");
  }
  for (const [path, value] of [
    ["cpu.count", environment.cpu?.count],
    ["totalMemoryBytes", environment.totalMemoryBytes],
    ["filesystem.blockSize", environment.filesystem?.blockSize],
    ["filesystem.totalBytes", environment.filesystem?.totalBytes],
    ["filesystem.availableBytes", environment.filesystem?.availableBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`environment.${path} must be a non-negative safe integer`);
    }
  }
  if (environment.cpu.count === 0 || environment.totalMemoryBytes === 0) {
    throw new TypeError("environment CPU count and total memory must be positive");
  }
  if (typeof environment.git?.dirty !== "boolean" && environment.git?.dirty !== "unknown") {
    throw new TypeError("environment.git.dirty must be a boolean or unknown");
  }
  return environment;
}

export { repositoryRoot };
