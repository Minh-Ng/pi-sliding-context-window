#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE,
  ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  validateArchiveSystemProbeArtifact,
} from "./system-artifact.js";
import { runArchiveSystemProbe } from "./system-runner.js";

function usage() {
  return [
    "Usage: node bench/archive/system-cli.js [options]",
    "",
    "Run profile (exactly one is required):",
    `  --scale ${ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE}       Run immutable release-scale evidence`,
    `  --development-scale <n>   Run a non-release probe (maximum ${ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE})`,
    "",
    "Artifacts:",
    "  --output <path>            Also write the JSON artifact to a file",
    "  --validate-artifact <path> Validate an existing artifact without running",
    "  --help                     Show this help",
  ].join("\n");
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArchiveSystemArguments(argv) {
  const options = {};
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
    if (["--scale", "--development-scale", "--output", "--validate-artifact"].includes(name)) {
      if (singletonOptions.has(name)) throw new TypeError(`${name} may only be provided once`);
      singletonOptions.add(name);
    }
    if (name === "--help") options.help = true;
    else if (name === "--scale") {
      const scale = positiveInteger(takeValue(), "--scale");
      if (scale !== ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE) {
        throw new TypeError(`--scale must be exactly ${ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE}`);
      }
      if (options.profile) throw new TypeError("--scale and --development-scale are mutually exclusive");
      options.profile = "official";
    } else if (name === "--development-scale") {
      const developmentScale = positiveInteger(takeValue(), "--development-scale");
      if (developmentScale > ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE) {
        throw new TypeError(
          `--development-scale must not exceed ${ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE}`,
        );
      }
      if (options.profile) throw new TypeError("--scale and --development-scale are mutually exclusive");
      options.profile = "development";
      options.developmentScale = developmentScale;
    } else if (name === "--output") options.output = takeValue();
    else if (name === "--validate-artifact") options.validateArtifact = takeValue();
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  if (!options.help && !options.validateArtifact && !options.profile) {
    throw new TypeError("either --scale 1000000 or --development-scale <n> is required");
  }
  if (options.validateArtifact && options.profile) {
    throw new TypeError("--validate-artifact cannot be combined with a run profile");
  }
  if (options.validateArtifact && options.output) {
    throw new TypeError("--validate-artifact cannot be combined with --output");
  }
  return options;
}

function summary(artifact) {
  const gates = Object.entries(artifact.gates)
    .map(([name, gate]) => `${name}=${gate.status}`)
    .join(" ");
  const eligibility = artifact.scale.releaseEligible ? "release-eligible" : "development-only";
  return `archive system probe ${artifact.outcome} (${eligibility}): ${gates}`;
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

export function archiveSystemExitCode(artifact) {
  return artifact.outcome === "passed"
    && Object.values(artifact.gates).every(({ status }) => status === "passed")
    ? 0
    : 1;
}

async function main(argv) {
  const options = parseArchiveSystemArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.validateArtifact) {
    const artifact = validateArchiveSystemProbeArtifact(
      JSON.parse(readFileSync(resolve(options.validateArtifact), "utf8")),
    );
    process.stderr.write(`${summary(artifact)}\n`);
    return archiveSystemExitCode(artifact);
  }
  const artifact = await runArchiveSystemProbe(options);
  emit(artifact, options.output);
  return archiveSystemExitCode(artifact);
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
