#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createArchiveReleaseArtifact,
  validateArchiveReleaseArtifact,
} from "./release-artifact.js";

function usage() {
  return [
    "Usage: node bench/archive/release-cli.js [options]",
    "",
    "Required component artifacts:",
    "  --comparison <path>        Repeat for the 10k, 100k, and 1m comparisons",
    "  --system <path>            Official one-million-window system probe",
    "  --retention <path>         Retention/compaction artifact",
    "",
    "Aggregate:",
    "  --output <path>            Write the strict performance aggregate",
    "  --validate-artifact <path> Validate an aggregate against all components",
    "  --help                     Show this help",
  ].join("\n");
}

export function parseArchiveReleaseArguments(argv) {
  const options = { comparisons: [] };
  const singletonOptions = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new TypeError(`${name} requires a value`);
      }
      return argv[index];
    };
    if (name === "--help") options.help = true;
    else if (name === "--comparison") options.comparisons.push(takeValue());
    else if (["--system", "--retention", "--output", "--validate-artifact"].includes(name)) {
      if (singletonOptions.has(name)) throw new TypeError(`${name} may only be provided once`);
      singletonOptions.add(name);
      const value = takeValue();
      if (name === "--system") options.system = value;
      else if (name === "--retention") options.retention = value;
      else if (name === "--output") options.output = value;
      else options.validateArtifact = value;
    }
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (options.comparisons.length !== 3) {
    throw new TypeError("exactly three --comparison artifacts are required");
  }
  if (!options.system) throw new TypeError("--system is required");
  if (!options.retention) throw new TypeError("--retention is required");
  if (!options.validateArtifact && !options.output) {
    throw new TypeError("--output is required when creating an aggregate");
  }
  if (options.validateArtifact && options.output) {
    throw new TypeError("--validate-artifact and --output are mutually exclusive");
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function componentBundle(options) {
  return {
    comparisonArtifacts: options.comparisons.map(readJson),
    systemArtifact: readJson(options.system),
    retentionArtifact: readJson(options.retention),
  };
}

function summary(artifact) {
  const scales = artifact.components.comparisons.map(({ scale }) => scale).join(",");
  const statuses = Object.entries(artifact.gates)
    .map(([name, gate]) => `${name}=${gate.status}`)
    .join(" ");
  return `archive performance release ${artifact.outcome} at comparison scales ${scales}: ${statuses}`;
}

export function archiveReleaseExitCode(artifact) {
  return artifact.outcome === "passed"
    && Object.values(artifact.gates ?? {}).length === 8
    && Object.values(artifact.gates).every(({ status }) => status === "passed")
    ? 0
    : 1;
}

function emit(artifact, output) {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const path = resolve(output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  process.stdout.write(json);
  process.stderr.write(`${summary(artifact)}\n`);
}

async function main(argv) {
  const options = parseArchiveReleaseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const bundle = componentBundle(options);
  if (options.validateArtifact) {
    const artifact = validateArchiveReleaseArtifact(
      readJson(options.validateArtifact),
      bundle,
    );
    process.stderr.write(`${summary(artifact)}\n`);
    return archiveReleaseExitCode(artifact);
  }
  const artifact = createArchiveReleaseArtifact({
    comparisonArtifacts: bundle.comparisonArtifacts,
    systemArtifact: bundle.systemArtifact,
    retentionArtifact: bundle.retentionArtifact,
  });
  validateArchiveReleaseArtifact(artifact, bundle);
  emit(artifact, options.output);
  return archiveReleaseExitCode(artifact);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
