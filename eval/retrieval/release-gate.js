#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./environment.js";

const cli = resolve(repositoryRoot, "eval/retrieval/cli.js");
const rocksBackend = resolve(repositoryRoot, "eval/retrieval/rocksdb-backend.js");
const artifactDirectory = resolve(repositoryRoot, "artifacts/retrieval");
export const RELEASE_RETRIEVAL_SUITES = Object.freeze([
  "exact",
  "lexical",
  "structural",
  "chunks",
]);

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) values.push(args[index + 1]);
  }
  return values;
}

function runCli(args, stdio = "inherit") {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    stdio,
  });
  if (result.error) throw result.error;
  return result;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function usage() {
  return [
    "Usage: node eval/retrieval/release-gate.js [options]",
    "  --artifact-directory PATH Write canonical baseline and RocksDB artifacts under PATH",
    "  --suite NAME[,NAME]        Override the default exact, lexical, structural, chunks suites",
    "  --output PATH              Override the RocksDB artifact path",
    "  --require-all              Forwarded automatically",
    "  --help                     Show this help",
  ].join("\n");
}

function releaseGateArguments(args) {
  const forwarded = [];
  let directory = artifactDirectory;
  let sawDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--artifact-directory") {
      forwarded.push(argument);
      continue;
    }
    if (sawDirectory) throw new TypeError("--artifact-directory may only be provided once");
    sawDirectory = true;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError("--artifact-directory requires a value");
    }
    directory = resolve(value);
    index += 1;
  }
  return Object.freeze({ forwarded: Object.freeze(forwarded), directory, sawDirectory });
}

export function releaseGateArtifactPaths({
  selectedSuites = RELEASE_RETRIEVAL_SUITES,
  requestedOutput,
  directory = artifactDirectory,
} = {}) {
  const canonicalReleaseSelection = selectedSuites.length === RELEASE_RETRIEVAL_SUITES.length
    && selectedSuites.every((suite, index) => suite === RELEASE_RETRIEVAL_SUITES[index]);
  const suiteSlug = canonicalReleaseSelection || selectedSuites.length === 0
    ? undefined
    : selectedSuites.join("-").replaceAll(/[^a-z0-9-]/giu, "_");
  const baselineArtifact = resolve(directory, "sqlite-baseline.json");
  const rocksArtifact = requestedOutput === undefined
    ? (suiteSlug === undefined
        ? resolve(directory, "rocksdb-evaluation.json")
        : resolve(directory, `rocksdb-${suiteSlug}.json`))
    : resolve(repositoryRoot, requestedOutput);
  return Object.freeze({ baselineArtifact, rocksArtifact, suiteSlug });
}

export function createReleaseGateRunPlan(args, { directory = artifactDirectory } = {}) {
  const suiteValues = optionValues(args, "--suite");
  if (suiteValues.some((value) => !value || value.startsWith("--"))) {
    throw new TypeError("--suite requires a value");
  }
  const explicitlySelectedSuites = suiteValues.flatMap((value) => value.split(",").filter(Boolean));
  const selectedSuites = explicitlySelectedSuites.length === 0
    ? [...RELEASE_RETRIEVAL_SUITES]
    : explicitlySelectedSuites;
  const requestedOutput = optionValue(args, "--output");
  if (args.includes("--output") && !requestedOutput) {
    throw new TypeError("--output requires a value");
  }
  const { baselineArtifact, rocksArtifact } = releaseGateArtifactPaths({
    selectedSuites,
    requestedOutput,
    directory,
  });
  const evaluatesLexical = selectedSuites.includes("lexical");
  const baselineArguments = evaluatesLexical
    ? [
        "--backend", "sqlite",
        "--suite", "lexical",
        "--output", baselineArtifact,
        "--require-all",
      ]
    : null;
  const rocksArguments = [
    "--backend", rocksBackend,
    "--require-all",
    ...(explicitlySelectedSuites.length === 0
      ? ["--suite", RELEASE_RETRIEVAL_SUITES.join(",")]
      : []),
    ...args,
  ];
  if (evaluatesLexical) rocksArguments.push("--baseline-artifact", baselineArtifact);
  if (requestedOutput === undefined) rocksArguments.push("--output", rocksArtifact);
  return Object.freeze({
    selectedSuites: Object.freeze(selectedSuites),
    baselineArtifact,
    rocksArtifact,
    baselineArguments: baselineArguments === null ? null : Object.freeze(baselineArguments),
    rocksArguments: Object.freeze(rocksArguments),
  });
}

function main(args) {
  if (args.includes("--backend") || args.includes("--baseline-artifact")) {
    fail("release-gate owns --backend and --baseline-artifact; invoke cli.js directly for custom inputs");
    return;
  }
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let owned;
  try {
    owned = releaseGateArguments(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (owned.forwarded.includes("--validate-only") || owned.forwarded.includes("--validate-artifact")) {
    if (owned.sawDirectory) {
      fail("--artifact-directory is only valid when generating release artifacts");
      return;
    }
    const result = runCli(owned.forwarded);
    process.exitCode = result.status ?? 1;
    return;
  }

  let plan;
  try {
    plan = createReleaseGateRunPlan(owned.forwarded, { directory: owned.directory });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  // Lexical scoring is always bound to the same frozen SQLite suite. Keep one
  // canonical baseline path so every release-shaped RocksDB artifact names the
  // standard baseline hash, even when non-lexical suites are selected too.
  mkdirSync(dirname(plan.baselineArtifact), { recursive: true });
  mkdirSync(dirname(plan.rocksArtifact), { recursive: true });

  if (plan.baselineArguments !== null) {
    const baseline = runCli(plan.baselineArguments, ["ignore", "ignore", "inherit"]);
    if (baseline.status !== 0) {
      process.exitCode = baseline.status ?? 1;
      return;
    }
  }

  const rocks = runCli(plan.rocksArguments);
  process.exitCode = rocks.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
