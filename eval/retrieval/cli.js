#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEvaluationArtifact,
  createFixtureValidationArtifact,
  validateRetrievalArtifact,
} from "./artifact.js";
import { collectEvaluationEnvironment } from "./environment.js";
import {
  RETRIEVAL_REGRESSION_FIXTURE,
  assertFrozenRegressionFixture,
} from "./fixtures.js";
import { closeEvaluationBackend, runRetrievalEvaluation } from "./runner.js";
import { RETRIEVAL_SUITES, authorizeFixtureEvaluation } from "./schema.js";
import { scoreRetrievalSuite } from "./scoring.js";
import { createSqliteEvaluationBackend } from "./sqlite-backend.js";

function usage() {
  return [
    "Usage: node eval/retrieval/cli.js [options]",
    "  --validate-only             Validate frozen fixtures without opening a backend",
    "  --validate-artifact PATH    Validate an existing JSON artifact",
    "  --suite NAME[,NAME]         Run one or more exact, lexical, structural, chunks, or hints suites",
    "  --backend sqlite|PATH       Use SQLite baseline or an ESM backend adapter module",
    "  --baseline-artifact PATH    Compare lexical metrics with a validated SQLite artifact",
    "  --output PATH               Also write the JSON artifact to PATH",
    "  --require-all               Fail if any selected gate is not evaluated",
    "  --help                      Show this help",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    backend: "sqlite",
    suites: [],
    validateOnly: false,
    requireAll: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if (argument === "--require-all") options.requireAll = true;
    else if (["--suite", "--backend", "--baseline-artifact", "--validate-artifact", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      index += 1;
      if (argument === "--suite") options.suites.push(...value.split(",").filter(Boolean));
      else if (argument === "--backend") options.backend = value;
      else if (argument === "--baseline-artifact") options.baselineArtifact = value;
      else if (argument === "--validate-artifact") options.validateArtifact = value;
      else options.output = value;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (options.suites.length === 0) options.suites = [...RETRIEVAL_SUITES];
  const unique = new Set(options.suites);
  if (unique.size !== options.suites.length || options.suites.some((suite) => !RETRIEVAL_SUITES.includes(suite))) {
    throw new TypeError("--suite values must be unique known retrieval suites");
  }
  return options;
}

async function loadBackend(value, fixture) {
  if (value === "sqlite") return createSqliteEvaluationBackend();
  const moduleUrl = pathToFileURL(resolve(value)).href;
  const adapterModule = await import(moduleUrl);
  const factory = adapterModule.createEvaluationBackend ?? adapterModule.default;
  if (typeof factory !== "function") {
    throw new TypeError("backend module must export createEvaluationBackend() or a default factory");
  }
  return factory({ fixture });
}

function readArtifact(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function lexicalBaselineFromArtifact(path, fixture) {
  const artifact = validateRetrievalArtifact(readArtifact(path), fixture);
  if (artifact.kind !== "retrieval-evaluation") {
    throw new TypeError("lexical baseline must be a retrieval-evaluation artifact");
  }
  if (artifact.backend.id !== "sqlite-fts5-baseline") {
    throw new TypeError("lexical baseline artifact must identify sqlite-fts5-baseline");
  }
  const metrics = artifact.results?.lexical?.scored?.metrics;
  if (!metrics) throw new TypeError("lexical baseline artifact does not contain lexical metrics");
  return {
    recallAt3: metrics.recallAt3,
    meanReciprocalRank: metrics.meanReciprocalRank,
    artifactHash: artifact.artifactHash,
  };
}

function emitArtifact(artifact, output) {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) writeFileSync(resolve(output), json);
  process.stdout.write(json);
}

function summarize(artifact) {
  if (artifact.kind === "retrieval-fixture-validation") {
    return `retrieval fixtures valid: ${artifact.fixture.fixtureId} ${artifact.fixture.fixtureFingerprint}`;
  }
  const suites = artifact.selectedSuites.map((suite) => {
    const result = artifact.results[suite];
    return `${suite}=${result.scored.gate.status}`;
  });
  return `retrieval evaluation ${artifact.outcome}: ${suites.join(" ")}`;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const fixture = assertFrozenRegressionFixture();
  if (options.validateArtifact) {
    const artifact = validateRetrievalArtifact(readArtifact(options.validateArtifact), fixture);
    process.stderr.write(`${summarize(artifact)}\n`);
    return 0;
  }
  const environment = collectEvaluationEnvironment();
  if (options.validateOnly) {
    const artifact = createFixtureValidationArtifact({ fixture, environment });
    validateRetrievalArtifact(artifact, fixture);
    emitArtifact(artifact, options.output);
    process.stderr.write(`${summarize(artifact)}\n`);
    return 0;
  }
  authorizeFixtureEvaluation(fixture);
  const backend = await loadBackend(options.backend, fixture);
  try {
    const runs = await runRetrievalEvaluation({ backend, fixture, suites: options.suites });
    let lexicalBaseline = options.baselineArtifact
      ? lexicalBaselineFromArtifact(options.baselineArtifact, fixture)
      : undefined;
    if (!lexicalBaseline && backend.metadata.id === "sqlite-fts5-baseline" && runs.lexical?.status === "completed") {
      const metrics = scoreRetrievalSuite("lexical", fixture, runs.lexical.observations).metrics;
      lexicalBaseline = { ...metrics, artifactHash: "self-baseline" };
    }
    const artifact = createEvaluationArtifact({
      fixture,
      environment,
      backend: backend.metadata,
      selectedSuites: options.suites,
      runs,
      lexicalBaseline,
    });
    validateRetrievalArtifact(artifact, fixture);
    emitArtifact(artifact, options.output);
    process.stderr.write(`${summarize(artifact)}\n`);
    if (artifact.outcome === "failed") return 1;
    if (options.requireAll && artifact.outcome !== "passed") return 1;
    return 0;
  } finally {
    await closeEvaluationBackend(backend);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
