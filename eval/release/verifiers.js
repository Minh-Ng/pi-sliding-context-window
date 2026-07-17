#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectEvaluationEnvironment,
  repositoryRoot,
  validateEvaluationEnvironment,
} from "../retrieval/environment.js";
import { canonicalJson, hashJson } from "../retrieval/schema.js";

export const RELEASE_VERIFIER_ARTIFACT_VERSION = 1;

export const LOCAL_AGGREGATE_EVIDENCE_VERSION = 1;
export const LOCAL_AGGREGATE_EVIDENCE_HEADING = "**Local aggregate verification evidence**";

const LOCAL_AGGREGATE_FIELD_NAME_PATTERN = "^[a-z][A-Za-z0-9]{0,63}$";
const LOCAL_AGGREGATE_VERSION_PATTERN = "^v?\\d+(?:\\.\\d+){0,3}(?:-[0-9A-Za-z.-]+)?$";
const LOCAL_AGGREGATE_HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
const LOCAL_AGGREGATE_FORBIDDEN_FIELD_PARTS = Object.freeze([
  "environment",
  "credential",
  "secret",
  "password",
  "apikey",
  "authorization",
  "username",
  "homepath",
  "homedirectory",
  "sourcepath",
  "absolutesourcepath",
  "sessionid",
  "sessionidentifier",
  "rawdatabasekey",
  "rawdbkey",
  "databasekey",
  "dbkey",
  "prompttext",
  "promptcontent",
  "promptpayload",
  "recalltext",
  "recalledtext",
  "recallcontent",
  "recallpayload",
]);

export const LOCAL_AGGREGATE_EVIDENCE_SCHEMA = Object.freeze({
  schemaVersion: LOCAL_AGGREGATE_EVIDENCE_VERSION,
  document: Object.freeze({
    heading: LOCAL_AGGREGATE_EVIDENCE_HEADING,
    body: "one canonical JSON code block",
  }),
  fieldNames: Object.freeze({
    pattern: LOCAL_AGGREGATE_FIELD_NAME_PATTERN,
    forbiddenParts: LOCAL_AGGREGATE_FORBIDDEN_FIELD_PARTS,
    forbiddenBareOrSuffix: "key",
  }),
  sections: Object.freeze({
    versions: Object.freeze({
      value: "non-negative integer or dotted version string",
      pattern: LOCAL_AGGREGATE_VERSION_PATTERN,
    }),
    hashes: Object.freeze({
      value: "sha256 fingerprint",
      pattern: LOCAL_AGGREGATE_HASH_PATTERN,
    }),
    counts: "non-negative safe integer",
    durationsMilliseconds: "non-negative finite number",
    byteTotals: "non-negative safe integer",
    exitStatuses: "non-negative safe integer",
    gates: Object.freeze(["passed", "failed", "pending"]),
  }),
});

// Deliberately frozen. Local evidence contract edits require review.
export const LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT =
  "sha256:f0f9dc220b318850b29505a507a4cbed98ba31cbb694a96cdc152d279ac62053";

const LOCAL_AGGREGATE_EVIDENCE_SECTIONS = Object.freeze(
  Object.keys(LOCAL_AGGREGATE_EVIDENCE_SCHEMA.sections),
);
const LOCAL_AGGREGATE_GATE_RESULTS = new Set(LOCAL_AGGREGATE_EVIDENCE_SCHEMA.sections.gates);
const LOCAL_AGGREGATE_FIELD_NAME = new RegExp(LOCAL_AGGREGATE_FIELD_NAME_PATTERN, "u");
const DOTTED_VERSION = new RegExp(LOCAL_AGGREGATE_VERSION_PATTERN, "u");
const SHA256_FINGERPRINT = new RegExp(LOCAL_AGGREGATE_HASH_PATTERN, "u");

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertLocalAggregateFieldName(name) {
  const normalized = String(name).toLowerCase();
  if (!LOCAL_AGGREGATE_FIELD_NAME.test(name)
    || normalized === "key"
    || normalized.endsWith(LOCAL_AGGREGATE_EVIDENCE_SCHEMA.fieldNames.forbiddenBareOrSuffix)
    || LOCAL_AGGREGATE_EVIDENCE_SCHEMA.fieldNames.forbiddenParts
      .some((part) => normalized.includes(part))) {
    throw new TypeError("local aggregate evidence contains a forbidden field name");
  }
}

function assertLocalAggregateSection(section, validator, message) {
  if (!isPlainRecord(section)) throw new TypeError(message);
  for (const key of Reflect.ownKeys(section)) {
    if (typeof key !== "string") {
      throw new TypeError("local aggregate evidence contains a forbidden field name");
    }
    assertLocalAggregateFieldName(key);
    if (!validator(section[key])) throw new TypeError(message);
  }
}

export function assertFrozenLocalAggregateEvidenceContract() {
  const fingerprint = hashJson(LOCAL_AGGREGATE_EVIDENCE_SCHEMA);
  if (fingerprint !== LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Frozen local aggregate evidence schema fingerprint mismatch: expected ${LOCAL_AGGREGATE_EVIDENCE_SCHEMA_FINGERPRINT}, got ${fingerprint}`,
    );
  }
}

export function validateLocalAggregateEvidence(evidence) {
  assertFrozenLocalAggregateEvidenceContract();
  if (!isPlainRecord(evidence)) {
    throw new TypeError("local aggregate evidence must be a plain object");
  }
  const keys = Reflect.ownKeys(evidence);
  if (keys.length !== LOCAL_AGGREGATE_EVIDENCE_SECTIONS.length
    || keys.some((key) => typeof key !== "string"
      || !LOCAL_AGGREGATE_EVIDENCE_SECTIONS.includes(key))) {
    throw new TypeError("local aggregate evidence contains an unsupported section");
  }

  assertLocalAggregateSection(
    evidence.versions,
    (value) => (Number.isSafeInteger(value) && value >= 0)
      || (typeof value === "string" && DOTTED_VERSION.test(value)),
    "local aggregate evidence contains an invalid version",
  );
  assertLocalAggregateSection(
    evidence.hashes,
    (value) => typeof value === "string" && SHA256_FINGERPRINT.test(value),
    "local aggregate evidence contains an invalid hash",
  );
  assertLocalAggregateSection(
    evidence.counts,
    (value) => Number.isSafeInteger(value) && value >= 0,
    "local aggregate evidence contains an invalid count",
  );
  assertLocalAggregateSection(
    evidence.durationsMilliseconds,
    (value) => Number.isFinite(value) && value >= 0,
    "local aggregate evidence contains an invalid duration",
  );
  assertLocalAggregateSection(
    evidence.byteTotals,
    (value) => Number.isSafeInteger(value) && value >= 0,
    "local aggregate evidence contains an invalid byte total",
  );
  assertLocalAggregateSection(
    evidence.exitStatuses,
    (value) => Number.isSafeInteger(value) && value >= 0,
    "local aggregate evidence contains an invalid exit status",
  );
  assertLocalAggregateSection(
    evidence.gates,
    (value) => LOCAL_AGGREGATE_GATE_RESULTS.has(value),
    "local aggregate evidence contains an invalid gate result",
  );
  return evidence;
}

export function formatLocalAggregateEvidenceDocument(evidence) {
  validateLocalAggregateEvidence(evidence);
  return `${LOCAL_AGGREGATE_EVIDENCE_HEADING}\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`;
}

export function validateLocalAggregateEvidenceDocument(document) {
  if (typeof document !== "string") {
    throw new TypeError("local aggregate evidence document must be text");
  }
  const prefix = `${LOCAL_AGGREGATE_EVIDENCE_HEADING}\n\n\`\`\`json\n`;
  const suffix = "\n```\n";
  if (!document.startsWith(prefix) || !document.endsWith(suffix)) {
    throw new TypeError("local aggregate evidence document framing is invalid");
  }
  const encoded = document.slice(prefix.length, -suffix.length);
  let evidence;
  try {
    evidence = JSON.parse(encoded);
  } catch {
    throw new TypeError("local aggregate evidence document JSON is invalid");
  }
  validateLocalAggregateEvidence(evidence);
  if (encoded !== JSON.stringify(evidence, null, 2)) {
    throw new TypeError("local aggregate evidence document is not canonical");
  }
  return evidence;
}

export const RELEASE_VERIFIER_COMMANDS = Object.freeze([
  Object.freeze({ id: "rocksdb-tests", command: "npm", args: Object.freeze(["run", "test:rocksdb"]) }),
  Object.freeze({ id: "daemon-tests", command: "npm", args: Object.freeze(["run", "test:daemon"]) }),
  Object.freeze({ id: "migration-tests", command: "npm", args: Object.freeze(["run", "test:migration"]) }),
  Object.freeze({ id: "full-check", command: "npm", args: Object.freeze(["run", "check"]) }),
]);

const VERIFIER_DESCRIPTOR = Object.freeze({
  artifactVersion: RELEASE_VERIFIER_ARTIFACT_VERSION,
  kind: "release-verifier-results",
  commands: RELEASE_VERIFIER_COMMANDS,
  resultFields: Object.freeze([
    "id",
    "command",
    "args",
    "durationMilliseconds",
    "exitCode",
    "signal",
    "error",
    "status",
  ]),
  outcomes: Object.freeze(["passed", "failed"]),
});

// Deliberately frozen. Command or artifact-contract edits require review.
export const RELEASE_VERIFIER_SCHEMA_FINGERPRINT =
  "sha256:12a7becc835a8349c96932d4bba4f20e7fba7636a4653c9b7a0f3785ac16446c";

export function assertFrozenReleaseVerifierContract() {
  const fingerprint = hashJson(VERIFIER_DESCRIPTOR);
  if (fingerprint !== RELEASE_VERIFIER_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Frozen release verifier schema fingerprint mismatch: expected ${RELEASE_VERIFIER_SCHEMA_FINGERPRINT}, got ${fingerprint}`,
    );
  }
}

function artifactHash(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  return hashJson(unsigned);
}

function commandMatches(actual, expected) {
  return actual?.id === expected.id
    && actual?.command === expected.command
    && canonicalJson(actual?.args) === canonicalJson(expected.args);
}

function resultStatus(result) {
  return result.exitCode === 0 && result.signal === null && result.error === null
    ? "passed"
    : "failed";
}

export function validateReleaseVerifierArtifact(artifact) {
  assertFrozenReleaseVerifierContract();
  if (!artifact || artifact.kind !== "release-verifier-results"
    || artifact.schemaVersion !== RELEASE_VERIFIER_ARTIFACT_VERSION) {
    throw new TypeError("artifact must be a release-verifier-results v1 artifact");
  }
  if (artifact.schemaFingerprint !== RELEASE_VERIFIER_SCHEMA_FINGERPRINT) {
    throw new Error("release verifier schema fingerprint is stale");
  }
  validateEvaluationEnvironment(artifact.environment);
  if (artifact.generatedAt !== artifact.environment.capturedAt) {
    throw new Error("release verifier generatedAt must match its environment capture");
  }
  if (!Array.isArray(artifact.results)
    || artifact.results.length !== RELEASE_VERIFIER_COMMANDS.length) {
    throw new Error("release verifier results do not cover every required command");
  }
  for (const [index, result] of artifact.results.entries()) {
    const expected = RELEASE_VERIFIER_COMMANDS[index];
    if (!commandMatches(result, expected)) {
      throw new Error(`release verifier command ${index} does not match ${expected.id}`);
    }
    if (!Number.isFinite(result.durationMilliseconds) || result.durationMilliseconds < 0) {
      throw new TypeError(`release verifier ${expected.id} duration is invalid`);
    }
    if (result.exitCode !== null
      && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0)) {
      throw new TypeError(`release verifier ${expected.id} exitCode is invalid`);
    }
    if (result.signal !== null && typeof result.signal !== "string") {
      throw new TypeError(`release verifier ${expected.id} signal is invalid`);
    }
    if (result.error !== null && typeof result.error !== "string") {
      throw new TypeError(`release verifier ${expected.id} error is invalid`);
    }
    if (result.status !== resultStatus(result)) {
      throw new Error(`release verifier ${expected.id} status does not match its process result`);
    }
  }
  const expectedOutcome = artifact.results.every(({ status }) => status === "passed")
    ? "passed"
    : "failed";
  if (artifact.outcome !== expectedOutcome) {
    throw new Error("release verifier outcome does not match command results");
  }
  if (artifact.artifactHash !== artifactHash(artifact)) {
    throw new Error("release verifier artifact hash does not match its canonical content");
  }
  return artifact;
}

export function runReleaseVerifiers({
  outputPath,
  environment = collectEvaluationEnvironment(),
  runner = spawnSync,
  onResult,
} = {}) {
  assertFrozenReleaseVerifierContract();
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required");
  }
  validateEvaluationEnvironment(environment);
  const results = [];
  for (const required of RELEASE_VERIFIER_COMMANDS) {
    const started = process.hrtime.bigint();
    const execution = runner(required.command, [...required.args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
    const durationMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
    const result = {
      id: required.id,
      command: required.command,
      args: [...required.args],
      durationMilliseconds,
      exitCode: execution.status ?? null,
      signal: execution.signal ?? null,
      error: execution.error === undefined
        ? null
        : execution.error instanceof Error
          ? execution.error.message
          : String(execution.error),
    };
    result.status = resultStatus(result);
    results.push(Object.freeze(result));
    onResult?.(result);
  }
  const artifact = {
    kind: "release-verifier-results",
    schemaVersion: RELEASE_VERIFIER_ARTIFACT_VERSION,
    schemaFingerprint: RELEASE_VERIFIER_SCHEMA_FINGERPRINT,
    generatedAt: environment.capturedAt,
    environment,
    results: Object.freeze(results),
    outcome: results.every(({ status }) => status === "passed") ? "passed" : "failed",
  };
  const signed = Object.freeze({ ...artifact, artifactHash: artifactHash(artifact) });
  validateReleaseVerifierArtifact(signed);
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(signed, null, 2)}\n`);
  return signed;
}

function option(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new TypeError(`${name} is required`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

function assertKnownArguments(args) {
  const valueOptions = new Set(["--output", "--validate-artifact"]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") continue;
    if (!valueOptions.has(argument)) throw new TypeError(`unknown argument: ${argument}`);
    if (seen.has(argument)) throw new TypeError(`${argument} may only be provided once`);
    seen.add(argument);
    index += 1;
    if (index >= args.length || args[index].startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
  }
}

function usage() {
  return [
    "Usage:",
    "  node eval/release/verifiers.js --output FILE",
    "  node eval/release/verifiers.js --validate-artifact FILE",
    "",
    "Runs the required test commands exactly once and records their process results.",
    "Run from a clean revision and write the artifact outside the repository.",
  ].join("\n");
}

function main(args) {
  assertKnownArguments(args);
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const validationPath = option(args, "--validate-artifact");
  if (validationPath !== undefined) {
    if (args.includes("--output")) {
      throw new TypeError("--output cannot be combined with --validate-artifact");
    }
    const artifact = validateReleaseVerifierArtifact(
      JSON.parse(readFileSync(resolve(validationPath), "utf8")),
    );
    process.stderr.write(`release verifiers ${artifact.outcome}\n`);
    return artifact.outcome === "passed" ? 0 : 1;
  }
  const outputPath = option(args, "--output", { required: true });
  const artifact = runReleaseVerifiers({
    outputPath,
    onResult(result) {
      process.stderr.write(`${result.id}=${result.status}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({
    outcome: artifact.outcome,
    artifact: resolve(outputPath),
    artifactHash: artifact.artifactHash,
  })}\n`);
  return artifact.outcome === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
