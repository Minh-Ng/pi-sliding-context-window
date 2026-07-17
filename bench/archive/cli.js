#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARCHIVE_BENCHMARK_GATE_NAMES,
  validateArchiveBenchmarkArtifact,
} from "./artifact.js";
import {
  ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES,
  ARCHIVE_BENCHMARK_SCALES,
} from "./fixture.js";
import { runArchiveBenchmark } from "./runner.js";

function usage() {
  return [
    "Usage: node bench/archive/cli.js [options]",
    "",
    "Modes:",
    "  --baseline                 Record the SQLite baseline only",
    "  --retention                Run the RocksDB deletion/compaction probe",
    "  (no mode flag)             Compare SQLite and RocksDB",
    "",
    "Corpus:",
    "  --scale <quick|10000|100000|1000000>",
    "  --count <n>                Quick-mode canonical windows (default: 100; minimum: 8)",
    `  --large-samples <n>        Quick-mode focused samples (default: 8; official: ${ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES})`,
    "  --retention-records <n>    Even record count for retention (default: 64)",
    "  --retention-bytes <n>      Bytes per retention record (default: 65536)",
    "  --seed <n>                 Deterministic non-negative seed",
    "",
    "Artifacts:",
    "  --output <path>            Also write the JSON artifact to a file",
    "  --validate-artifact <path> Validate an existing artifact without running",
    "  --allow-partial            Development only: exit zero for valid partial evidence",
    "  --help                     Show this help",
  ].join("\n");
}

function integer(value, name, { minimum = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

export function parseArchiveBenchmarkArguments(argv) {
  const options = {
    mode: "comparison",
    scale: "quick",
    count: 100,
    countExplicit: false,
    largeSamples: 8,
    largeSamplesExplicit: false,
    retentionRecords: 64,
    retentionRecordBytes: 64 * 1024,
    allowPartial: false,
  };
  const modeFlags = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new TypeError(`${name} requires a value`);
      }
      return argv[index];
    };
    if (name === "--help") options.help = true;
    else if (name === "--baseline") modeFlags.push(options.mode = "baseline");
    else if (name === "--retention") modeFlags.push(options.mode = "retention");
    else if (name === "--scale") {
      const value = takeValue();
      options.scale = value === "quick" ? value : integer(value, "--scale");
    } else if (name === "--count") {
      options.count = integer(takeValue(), "--count", { minimum: 8 });
      options.countExplicit = true;
    } else if (name === "--large-samples") {
      options.largeSamples = integer(takeValue(), "--large-samples");
      options.largeSamplesExplicit = true;
    } else if (name === "--retention-records") {
      options.retentionRecords = integer(takeValue(), "--retention-records");
    } else if (name === "--retention-bytes") {
      options.retentionRecordBytes = integer(takeValue(), "--retention-bytes");
    } else if (name === "--seed") {
      options.seed = integer(takeValue(), "--seed", { minimum: 0 });
    } else if (name === "--output") options.output = takeValue();
    else if (name === "--validate-artifact") options.validateArtifact = takeValue();
    else if (name === "--allow-partial") options.allowPartial = true;
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  if (modeFlags.length > 1) throw new TypeError("--baseline and --retention are mutually exclusive");
  if (options.scale !== "quick") {
    if (!ARCHIVE_BENCHMARK_SCALES.includes(options.scale)) {
      throw new TypeError(`--scale must be quick, ${ARCHIVE_BENCHMARK_SCALES.join(", ")}`);
    }
    if (options.countExplicit) throw new TypeError("--count cannot be combined with an official --scale");
    if (options.largeSamplesExplicit
      && options.largeSamples !== ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES) {
      throw new TypeError(
        `official scales require --large-samples ${ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES}`,
      );
    }
    options.count = options.scale;
    options.largeSamples = ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES;
  }
  if (options.retentionRecords % 2 !== 0) throw new TypeError("--retention-records must be even");
  delete options.countExplicit;
  delete options.largeSamplesExplicit;
  return options;
}

function summary(artifact) {
  const measured = Object.entries(artifact.gates)
    .filter(([, gate]) => gate.status !== "not-measured")
    .map(([name, gate]) => `${name}=${gate.status}`);
  const suffix = measured.length > 0 ? measured.join(" ") : "no performance gates scored";
  return `archive benchmark ${artifact.mode} ${artifact.outcome}: ${suffix}`;
}

function emit(artifact, output) {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) {
    const path = resolve(output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
  }
  process.stdout.write(json);
  process.stderr.write(`${summary(artifact)}\n`);
}

export function archiveBenchmarkExitCode(artifact, { allowPartial = false } = {}) {
  const statuses = ARCHIVE_BENCHMARK_GATE_NAMES.map(
    (name) => artifact.gates?.[name]?.status,
  );
  if (statuses.includes("failed") || artifact.outcome === "failed") return 1;
  if (statuses.every((status) => status === "passed")
    && artifact.outcome === "passed") return 0;
  return allowPartial ? 0 : 2;
}

async function main(argv) {
  const options = parseArchiveBenchmarkArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.validateArtifact) {
    const artifact = validateArchiveBenchmarkArtifact(
      JSON.parse(readFileSync(resolve(options.validateArtifact), "utf8")),
    );
    process.stderr.write(`${summary(artifact)}\n`);
    return archiveBenchmarkExitCode(artifact, options);
  }
  const artifact = await runArchiveBenchmark(options);
  emit(artifact, options.output);
  return archiveBenchmarkExitCode(artifact, options);
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
