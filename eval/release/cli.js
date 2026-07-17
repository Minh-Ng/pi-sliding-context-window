#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateReleaseReportArtifact,
  writeReleaseReport,
} from "./report.js";

const VALUE_OPTIONS = new Set(["--evidence-dir", "--output", "--validate-artifact"]);

function assertKnownArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") continue;
    if (!VALUE_OPTIONS.has(argument)) throw new TypeError(`unknown argument: ${argument}`);
    index += 1;
    if (index >= args.length || args[index].startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
  }
}

function option(args, name, { required = false } = {}) {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new TypeError(`${name} may only be provided once`);
  if (indexes.length === 0) {
    if (required) throw new TypeError(`${name} is required`);
    return undefined;
  }
  const value = args[indexes[0] + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  node eval/release/cli.js --evidence-dir DIR --output FILE",
    "  node eval/release/cli.js --validate-artifact FILE --evidence-dir DIR",
    "",
    "There is no partial-success option. A failed report is still written for audit.",
  ].join("\n");
}

export function releaseReportExitCode(report) {
  return report.outcome === "passed" ? 0 : 1;
}

export function main(args) {
  assertKnownArguments(args);
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const validationPath = option(args, "--validate-artifact");
  const evidenceDirectory = option(args, "--evidence-dir", { required: true });
  if (validationPath !== undefined) {
    if (args.includes("--output")) {
      throw new TypeError("--output cannot be combined with --validate-artifact");
    }
    const report = validateReleaseReportArtifact(
      JSON.parse(readFileSync(resolve(validationPath), "utf8")),
      { evidenceDirectory },
    );
    process.stderr.write(`RocksDB archive release ${report.outcome}: ${report.blockers.length} blocker(s)\n`);
    return releaseReportExitCode(report);
  }
  const outputPath = option(args, "--output", { required: true });
  const report = writeReleaseReport({ evidenceDirectory, outputPath });
  process.stdout.write(`${JSON.stringify({
    outcome: report.outcome,
    blockers: report.blockers,
    artifact: resolve(outputPath),
    artifactHash: report.artifactHash,
  })}\n`);
  process.stderr.write(`RocksDB archive release ${report.outcome}: ${report.blockers.length} blocker(s)\n`);
  return releaseReportExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
