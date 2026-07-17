#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Archive } from "../../src/archive.js";
import { createDaemonOperations } from "../../src/daemon/operations.js";
import {
  getMigrationStatus,
  inspectSqliteArchive,
  startMigration,
  verifyMigration,
} from "../../src/migration/index.js";
import { manifestKeys } from "../../src/rocksdb/manifests.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { RocksStore } from "../../src/rocksdb/store.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store-contract.js";
import {
  collectEvaluationEnvironment,
  validateEvaluationEnvironment,
} from "../retrieval/environment.js";
import { canonicalJson, hashJson, sha256 } from "../retrieval/schema.js";

export const MIGRATION_REHEARSAL_ARTIFACT_VERSION = 1;

const ASSERTION_NAMES = Object.freeze([
  "offline-copy-completed",
  "complete-verification-passed",
  "rollback-eligible-before-authority",
  "sqlite-source-unchanged-after-verification",
  "sqlite-rollback-read-succeeded",
  "sqlite-corpus-unchanged-after-rollback-read",
  "rollback-remained-eligible-after-read",
  "first-rocksdb-write-sealed-authority",
  "authority-and-document-survived-restart",
  "duplicate-authority-write-remained-idempotent",
  "authority-write-did-not-touch-sqlite",
]);

const REHEARSAL_DOCUMENTS = Object.freeze([
  Object.freeze({
    document: Object.freeze({
      id: "sourced-turn",
      sessionId: "session-child",
      project: "/fixture/migration-rehearsal",
      kind: "turn",
      createdAt: 10,
      text: "[user] Find REAP_DRAIN 🪨\n[assistant] It is in worker.ts.",
      metadata: Object.freeze({
        sourceMessageKeys: Object.freeze(["user:1::aaa", "assistant:2::bbb"]),
        sourceFirstKey: "user:1::aaa",
        sourceLastKey: "assistant:2::bbb",
        sourceMessageCount: 2,
        turnId: "turn-1",
      }),
    }),
    options: Object.freeze({
      deferPrune: true,
      structuralMessages: Object.freeze([Object.freeze({
        messageKey: "user:1::aaa",
        messageIndex: 0,
        role: "user",
        createdAt: 10,
        text: "Find REAP_DRAIN 🪨",
        questionScore: 100,
        requestScore: 80,
        correctionScore: 0,
        answerScore: 0,
      })]),
    }),
  }),
  Object.freeze({
    document: Object.freeze({
      id: "legacy-turn",
      sessionId: "session-old",
      project: "/fixture/migration-rehearsal",
      kind: "turn",
      createdAt: 20,
      text: "legacy text with NUL \u0000 and 雪",
      metadata: Object.freeze({ startKey: "user:old", messageCount: 1 }),
    }),
    options: Object.freeze({ deferPrune: true }),
  }),
  Object.freeze({
    document: Object.freeze({
      id: "malformed-turn",
      sessionId: "session-old",
      project: "/fixture/migration-rehearsal",
      kind: "turn",
      createdAt: 30,
      text: "malformed metadata remains recallable",
      metadata: Object.freeze({}),
    }),
    options: Object.freeze({ deferPrune: true }),
  }),
  Object.freeze({
    document: Object.freeze({
      id: "tool-result",
      sessionId: "session-child",
      project: "/fixture/migration-rehearsal",
      kind: "tool-result",
      createdAt: 40,
      text: "tool bytes\r\nsecond line",
      metadata: Object.freeze({
        sourceMessageKey: "toolResult:4:call-7:ccc",
        toolCallId: "call-7",
        toolName: "read",
      }),
    }),
    options: Object.freeze({ deferPrune: true }),
  }),
]);

const FIXTURE_DESCRIPTOR = Object.freeze({
  fixtureId: "migration-rollback-rehearsal-v1",
  documents: REHEARSAL_DOCUMENTS,
  malformedMetadataDocumentId: "malformed-turn",
  rollbackDocumentId: "sourced-turn",
});

// Deliberately frozen. Fixture edits require an explicit fingerprint update.
export const MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT =
  "sha256:6c4edff1c4559624bacdb6002b23a7693f10a02566efbcc326ba3abc53d2b7a7";

const ARTIFACT_DESCRIPTOR = Object.freeze({
  artifactVersion: MIGRATION_REHEARSAL_ARTIFACT_VERSION,
  kind: "migration-rollback-rehearsal",
  fixtureFingerprint: MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT,
  assertions: ASSERTION_NAMES,
  phases: Object.freeze([
    "offline-verification",
    "offline-ready",
    "rocksdb-authority",
  ]),
  releaseFields: Object.freeze([
    "storageSchemaFingerprint",
    "storageSchemaVersion",
    "protocolVersion",
  ]),
});

// Deliberately frozen. Artifact contract edits require an explicit review point.
export const MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT =
  "sha256:9e02a798a27bf086abc1d10a44349b4ac33e5ccfc2a97a14140e9ec635c5e9a1";

export function assertFrozenMigrationRehearsalContract() {
  const fixtureFingerprint = hashJson(FIXTURE_DESCRIPTOR);
  if (fixtureFingerprint !== MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT) {
    throw new Error(
      `Frozen migration rehearsal fixture fingerprint mismatch: expected ${MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT}, got ${fixtureFingerprint}`,
    );
  }
  const schemaFingerprint = hashJson(ARTIFACT_DESCRIPTOR);
  if (schemaFingerprint !== MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT) {
    throw new Error(
      `Frozen migration rehearsal schema fingerprint mismatch: expected ${MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT}, got ${schemaFingerprint}`,
    );
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function sourceSnapshot(path) {
  const directory = dirname(path);
  const name = basename(path);
  return Object.freeze(Object.fromEntries(readdirSync(directory)
    .filter((entry) => entry === name || entry.startsWith(`${name}-`))
    .sort()
    .map((entry) => {
      const bytes = readFileSync(join(directory, entry));
      return [entry, Object.freeze({
        bytes: bytes.length,
        sha256: sha256(bytes),
      })];
    })));
}

function snapshotEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateSourceSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).length === 0) {
    throw new TypeError(`${label} must contain at least one SQLite source file`);
  }
  let hasContent = false;
  for (const [name, entry] of Object.entries(snapshot)) {
    if (typeof name !== "string" || name.length === 0
      || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0
      || !/^sha256:[a-f0-9]{64}$/u.test(entry?.sha256 ?? "")) {
      throw new TypeError(`${label}.${name} is not a valid source-file measurement`);
    }
    hasContent ||= entry.bytes > 0;
  }
  if (!hasContent) throw new TypeError(`${label} does not contain SQLite source bytes`);
}

function summarizedSource(info) {
  return Object.freeze({
    databaseId: info.databaseId,
    databaseIdentity: Object.freeze({ ...info.databaseIdentity }),
    sourceFingerprint: info.sourceFingerprint,
    schemaFingerprint: info.schemaFingerprint,
    corpusFingerprint: info.corpusFingerprint,
    orderingMode: info.orderingMode,
    documentCount: info.documentCount,
    lastSourceOrderingKey: info.lastSourceOrderingKey,
  });
}

function createSource(path) {
  const archive = new Archive(path);
  try {
    for (const { document, options } of REHEARSAL_DOCUMENTS) archive.put(document, options);
    archive.db.prepare(
      "UPDATE documents SET metadata_json = ? WHERE id = 'malformed-turn'",
    ).run("{broken");
  } finally {
    archive.close();
  }
}

function summarizedStatus(status) {
  const authorityWrite = status.checkpoint?.authorityWrite;
  return Object.freeze({
    phase: status.phase,
    migratedCount: status.migratedCount,
    failedCount: status.failedCount,
    comparisonFailures: status.comparisonFailures,
    rollbackEligible: status.rollbackEligible,
    sourceFingerprint: status.sourceFingerprint,
    verification: status.checkpoint?.verification === undefined
      ? null
      : Object.freeze({ ...status.checkpoint.verification }),
    authorityWrite: authorityWrite === undefined
      ? null
      : Object.freeze({ ...authorityWrite }),
  });
}

function authorityRequest() {
  return Object.freeze({
    idempotencyKey: "migration-rehearsal:first-rocks-authority-write",
    document: Object.freeze({
      documentId: "migration-rehearsal-authority-document",
      version: 1,
      sourceKey: "user:migration-rehearsal-authority",
      sourceMessageKeys: Object.freeze(["user:migration-rehearsal-authority"]),
      sourceKeyStatus: "preserved",
      sessionId: "migration-rehearsal-authority-session",
      project: "/fixture/migration-rehearsal",
      kind: "turn",
      createdAt: 1_700_000_000_000,
      text: "The first post-verification RocksDB write atomically seals authority.",
      metadata: Object.freeze({ fixture: FIXTURE_DESCRIPTOR.fixtureId }),
    }),
    retentionClass: "conversation-source",
  });
}

function artifactHash(artifact) {
  const { artifactHash: _ignored, ...unsigned } = artifact;
  return hashJson(unsigned);
}

function assertPassedVerification(verification) {
  invariant(verification.status === "passed", "Migration verification did not pass.");
  invariant(verification.checked === REHEARSAL_DOCUMENTS.length,
    "Migration verification did not check the complete rehearsal corpus.");
  for (const field of ["missing", "extra", "provenanceDifferences", "recallDifferences"]) {
    invariant(verification[field] === 0, `Migration verification reported ${field}.`);
  }
}

/**
 * Exercise the full offline boundary against a disposable deterministic corpus.
 * The output paths are the only durable writes; source and destination stores
 * are removed after the artifact has been assembled.
 */
export async function runMigrationRehearsal({
  outputPath,
  verificationOutputPath,
  environment = collectEvaluationEnvironment(),
} = {}) {
  assertFrozenMigrationRehearsalContract();
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required.");
  }
  validateEvaluationEnvironment(environment);
  const resolvedOutput = resolve(outputPath);
  const resolvedVerification = resolve(verificationOutputPath
    ?? join(dirname(resolvedOutput), "migration-verification.json"));
  if (resolvedVerification === resolvedOutput) {
    throw new TypeError("The rehearsal and verification artifacts require different paths.");
  }

  const temporary = mkdtempSync(join(tmpdir(), "context-window-release-migration-"));
  const sourcePath = join(temporary, "archive.db");
  const storePath = join(temporary, "archive.rocks");
  let store;
  let runtime;
  try {
    createSource(sourcePath);
    const sourceBefore = sourceSnapshot(sourcePath);
    const sourceBeforeInfo = summarizedSource(inspectSqliteArchive(sourcePath));
    store = await RocksStore.open(storePath);

    const copied = await startMigration(store, {
      sourcePath,
      offline: true,
      batchSize: 2,
    });
    const afterCopy = await getMigrationStatus(store);
    invariant(copied.accepted === true && afterCopy.phase === "offline-verification",
      "Offline copy did not finish at the verification gate.");
    invariant(afterCopy.migratedCount === REHEARSAL_DOCUMENTS.length,
      "Offline copy did not migrate the complete rehearsal corpus.");

    mkdirSync(dirname(resolvedVerification), { recursive: true });
    const verification = await verifyMigration(store, {
      sourcePath,
      artifactPath: resolvedVerification,
    });
    assertPassedVerification(verification);
    const ready = await getMigrationStatus(store);
    invariant(ready.phase === "offline-ready" && ready.rollbackEligible === true,
      "Passing verification did not open the pre-authority rollback gate.");
    const sourceAfterVerification = sourceSnapshot(sourcePath);
    invariant(snapshotEqual(sourceBefore, sourceAfterVerification),
      "Offline copy or verification changed the SQLite source bytes.");

    const rollback = new Archive(sourcePath);
    let rollbackDocument;
    try {
      rollbackDocument = rollback.get(FIXTURE_DESCRIPTOR.rollbackDocumentId);
    } finally {
      rollback.close();
    }
    invariant(rollbackDocument?.text
      === REHEARSAL_DOCUMENTS[0].document.text,
    "The untouched SQLite archive did not serve the rollback document.");
    const sourceAfterRollbackRead = sourceSnapshot(sourcePath);
    const sourceAfterRollbackInfo = summarizedSource(inspectSqliteArchive(sourcePath));
    invariant(sourceBeforeInfo.sourceFingerprint === sourceAfterRollbackInfo.sourceFingerprint
      && sourceBeforeInfo.corpusFingerprint === sourceAfterRollbackInfo.corpusFingerprint
      && canonicalJson(sourceBeforeInfo.databaseIdentity)
        === canonicalJson(sourceAfterRollbackInfo.databaseIdentity),
    "Reading the rollback source changed its canonical corpus or database identity.");
    const readyAfterRollbackRead = await getMigrationStatus(store);
    invariant(readyAfterRollbackRead.phase === "offline-ready"
      && readyAfterRollbackRead.rollbackEligible === true,
    "Reading from SQLite closed the pre-authority rollback gate.");

    const request = authorityRequest();
    runtime = await createDaemonOperations(store);
    const admitted = await runtime.put(request, { project: request.document.project });
    invariant(admitted.status === "stored", "The first authority write was not acknowledged.");
    const authority = await getMigrationStatus(store);
    invariant(authority.phase === "rocksdb-authority" && authority.rollbackEligible === false,
      "The first RocksDB write did not close the rollback gate.");
    invariant(authority.checkpoint?.authorityWrite?.requestId === request.idempotencyKey,
      "The authority seal does not identify the acknowledged request.");
    invariant(authority.checkpoint?.authorityWrite?.documentId === request.document.documentId,
      "The authority seal does not identify the acknowledged document.");

    await runtime.close();
    runtime = undefined;
    store.close();
    store = await RocksStore.open(storePath);
    const restarted = await getMigrationStatus(store);
    const manifest = await store.get(manifestKeys.document(request.document.documentId, 1));
    invariant(restarted.phase === "rocksdb-authority"
      && restarted.checkpoint?.authorityWrite?.requestId === request.idempotencyKey
      && manifest?.documentId === request.document.documentId,
    "Authority or its canonical document did not survive restart.");

    runtime = await createDaemonOperations(store);
    const duplicate = await runtime.put(request, { project: request.document.project });
    invariant(duplicate.status === "duplicate",
      "Retrying the authority write after restart was not idempotent.");
    const sourceAfterAuthority = sourceSnapshot(sourcePath);
    invariant(snapshotEqual(sourceAfterRollbackRead, sourceAfterAuthority),
      "The authority transition changed the SQLite source bytes.");

    const verificationBytes = readFileSync(resolvedVerification);
    const assertions = ASSERTION_NAMES.map((name) => Object.freeze({ name, status: "passed" }));
    const artifact = {
      kind: "migration-rollback-rehearsal",
      schemaVersion: MIGRATION_REHEARSAL_ARTIFACT_VERSION,
      schemaFingerprint: MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT,
      generatedAt: environment.capturedAt,
      environment,
      release: Object.freeze({
        storageSchemaFingerprint: SCHEMA_FINGERPRINT,
        storageSchemaVersion: STORE_SCHEMA_VERSION,
        protocolVersion: STORE_PROTOCOL_VERSION,
      }),
      fixture: Object.freeze({
        fixtureId: FIXTURE_DESCRIPTOR.fixtureId,
        fixtureFingerprint: MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT,
        documentCount: REHEARSAL_DOCUMENTS.length,
      }),
      sourceSnapshots: Object.freeze({
        before: sourceBefore,
        afterVerification: sourceAfterVerification,
        afterRollbackRead: sourceAfterRollbackRead,
        afterAuthority: sourceAfterAuthority,
        rollbackReadChangedBookkeeping: !snapshotEqual(sourceBefore, sourceAfterRollbackRead),
      }),
      sourceIdentity: Object.freeze({
        before: sourceBeforeInfo,
        afterRollbackRead: sourceAfterRollbackInfo,
      }),
      phases: Object.freeze({
        afterCopy: summarizedStatus(afterCopy),
        afterVerification: summarizedStatus(ready),
        afterRollbackRead: summarizedStatus(readyAfterRollbackRead),
        afterAuthority: summarizedStatus(authority),
        afterRestart: summarizedStatus(restarted),
      }),
      rollbackRead: Object.freeze({
        documentId: rollbackDocument.id,
        textBytes: Buffer.byteLength(rollbackDocument.text, "utf8"),
        textSha256: sha256(Buffer.from(rollbackDocument.text, "utf8")),
      }),
      verification: Object.freeze({
        status: verification.status,
        checked: verification.checked,
        missing: verification.missing,
        extra: verification.extra,
        provenanceDifferences: verification.provenanceDifferences,
        recallDifferences: verification.recallDifferences,
      }),
      verificationArtifact: Object.freeze({
        file: basename(resolvedVerification),
        bytes: verificationBytes.length,
        sha256: sha256(verificationBytes),
      }),
      authority: Object.freeze({
        requestId: request.idempotencyKey,
        documentId: request.document.documentId,
        verificationRunId: authority.checkpoint.authorityWrite.verificationRunId,
        retryStatus: duplicate.status,
      }),
      assertions: Object.freeze(assertions),
      outcome: "passed",
    };
    const signed = Object.freeze({ ...artifact, artifactHash: artifactHash(artifact) });
    validateMigrationRehearsalArtifact(signed, {
      verificationArtifactPath: resolvedVerification,
    });
    mkdirSync(dirname(resolvedOutput), { recursive: true });
    writeFileSync(resolvedOutput, `${JSON.stringify(signed, null, 2)}\n`, { flag: "w" });
    return signed;
  } finally {
    await runtime?.close().catch(() => {});
    store?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function validateMigrationRehearsalArtifact(artifact, {
  verificationArtifactPath,
} = {}) {
  assertFrozenMigrationRehearsalContract();
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new TypeError("artifact must be an object");
  }
  if (artifact.kind !== "migration-rollback-rehearsal"
    || artifact.schemaVersion !== MIGRATION_REHEARSAL_ARTIFACT_VERSION) {
    throw new TypeError("artifact must be a migration-rollback-rehearsal v1 artifact");
  }
  if (artifact.schemaFingerprint !== MIGRATION_REHEARSAL_SCHEMA_FINGERPRINT) {
    throw new Error("migration rehearsal schema fingerprint is stale");
  }
  validateEvaluationEnvironment(artifact.environment);
  if (artifact.generatedAt !== artifact.environment.capturedAt) {
    throw new Error("artifact generatedAt must match its environment capture");
  }
  if (artifact.release?.storageSchemaFingerprint !== SCHEMA_FINGERPRINT
    || artifact.release?.storageSchemaVersion !== STORE_SCHEMA_VERSION
    || artifact.release?.protocolVersion !== STORE_PROTOCOL_VERSION) {
    throw new Error("migration rehearsal release metadata is stale");
  }
  if (artifact.fixture?.fixtureId !== FIXTURE_DESCRIPTOR.fixtureId
    || artifact.fixture?.fixtureFingerprint !== MIGRATION_REHEARSAL_FIXTURE_FINGERPRINT
    || artifact.fixture?.documentCount !== REHEARSAL_DOCUMENTS.length) {
    throw new Error("migration rehearsal fixture metadata is stale or incomplete");
  }
  const snapshots = artifact.sourceSnapshots;
  if (typeof snapshots?.rollbackReadChangedBookkeeping !== "boolean") {
    throw new TypeError("sourceSnapshots.rollbackReadChangedBookkeeping must be a boolean");
  }
  for (const phase of ["before", "afterVerification", "afterRollbackRead", "afterAuthority"]) {
    validateSourceSnapshot(snapshots?.[phase], `sourceSnapshots.${phase}`);
  }
  if (!snapshotEqual(snapshots?.before, snapshots?.afterVerification)) {
    throw new Error("Offline migration or verification changed the SQLite source bytes");
  }
  if (!snapshotEqual(snapshots?.afterRollbackRead, snapshots?.afterAuthority)) {
    throw new Error("The RocksDB authority write changed the SQLite source bytes");
  }
  const sourceIdentity = artifact.sourceIdentity;
  for (const phase of ["before", "afterRollbackRead"]) {
    const identity = sourceIdentity?.[phase];
    if (!identity || identity.documentCount !== REHEARSAL_DOCUMENTS.length
      || !/^[a-f0-9]{64}$/u.test(identity.sourceFingerprint ?? "")
      || !/^[a-f0-9]{64}$/u.test(identity.corpusFingerprint ?? "")
      || !/^[a-f0-9]{64}$/u.test(identity.schemaFingerprint ?? "")) {
      throw new Error(`migration rehearsal ${phase} source identity is incomplete`);
    }
  }
  for (const field of ["databaseIdentity", "sourceFingerprint", "corpusFingerprint"]) {
    if (canonicalJson(sourceIdentity?.before?.[field])
      !== canonicalJson(sourceIdentity?.afterRollbackRead?.[field])) {
      throw new Error(`SQLite rollback read changed source identity field ${field}`);
    }
  }
  if (artifact.phases?.afterCopy?.phase !== "offline-verification"
    || artifact.phases?.afterCopy?.rollbackEligible !== false
    || artifact.phases?.afterVerification?.phase !== "offline-ready"
    || artifact.phases?.afterVerification?.rollbackEligible !== true
    || artifact.phases?.afterRollbackRead?.phase !== "offline-ready"
    || artifact.phases?.afterRollbackRead?.rollbackEligible !== true
    || artifact.phases?.afterAuthority?.phase !== "rocksdb-authority"
    || artifact.phases?.afterAuthority?.rollbackEligible !== false
    || artifact.phases?.afterRestart?.phase !== "rocksdb-authority"
    || artifact.phases?.afterRestart?.rollbackEligible !== false) {
    throw new Error("migration rehearsal phase or rollback boundary is invalid");
  }
  for (const phase of [
    "afterCopy",
    "afterVerification",
    "afterRollbackRead",
    "afterAuthority",
    "afterRestart",
  ]) {
    const status = artifact.phases[phase];
    if (status.migratedCount !== REHEARSAL_DOCUMENTS.length
      || status.failedCount !== 0
      || status.comparisonFailures !== 0
      || status.sourceFingerprint !== sourceIdentity.before.sourceFingerprint) {
      throw new Error(`migration rehearsal ${phase} status is incomplete or inconsistent`);
    }
  }
  for (const phase of ["afterVerification", "afterRollbackRead", "afterAuthority", "afterRestart"]) {
    const verification = artifact.phases[phase].verification;
    if (verification?.status !== "passed"
      || verification.checked !== REHEARSAL_DOCUMENTS.length
      || verification.failures !== 0
      || verification.sourceFingerprint !== sourceIdentity.before.sourceFingerprint
      || verification.corpusFingerprint !== sourceIdentity.before.corpusFingerprint) {
      throw new Error(`migration rehearsal ${phase} verification checkpoint is invalid`);
    }
  }
  assertPassedVerification(artifact.verification ?? {});
  if (artifact.rollbackRead?.documentId !== FIXTURE_DESCRIPTOR.rollbackDocumentId
    || artifact.rollbackRead?.textSha256
      !== sha256(Buffer.from(REHEARSAL_DOCUMENTS[0].document.text, "utf8"))) {
    throw new Error("migration rehearsal rollback read does not match the frozen fixture");
  }
  if (artifact.authority?.requestId !== authorityRequest().idempotencyKey
    || artifact.authority?.documentId !== authorityRequest().document.documentId
    || artifact.authority?.retryStatus !== "duplicate"
    || typeof artifact.authority?.verificationRunId !== "string"
    || artifact.authority.verificationRunId.length === 0) {
    throw new Error("migration rehearsal authority evidence is incomplete");
  }
  for (const phase of ["afterAuthority", "afterRestart"]) {
    const seal = artifact.phases[phase].authorityWrite;
    if (seal?.requestId !== artifact.authority.requestId
      || seal.documentId !== artifact.authority.documentId
      || seal.verificationRunId !== artifact.authority.verificationRunId
      || seal.sourceFingerprint !== sourceIdentity.before.sourceFingerprint) {
      throw new Error(`migration rehearsal ${phase} authority seal is inconsistent`);
    }
  }
  if (!Array.isArray(artifact.assertions)
    || canonicalJson(artifact.assertions.map(({ name }) => name)) !== canonicalJson(ASSERTION_NAMES)
    || artifact.assertions.some(({ status }) => status !== "passed")) {
    throw new Error("migration rehearsal assertions are missing or failed");
  }
  if (artifact.outcome !== "passed") throw new Error("migration rehearsal outcome must be passed");
  if (!/^sha256:[a-f0-9]{64}$/u.test(artifact.verificationArtifact?.sha256 ?? "")
    || !Number.isSafeInteger(artifact.verificationArtifact?.bytes)
    || artifact.verificationArtifact.bytes <= 0) {
    throw new Error("migration verification artifact metadata is invalid");
  }
  if (verificationArtifactPath !== undefined) {
    const path = resolve(verificationArtifactPath);
    if (!existsSync(path)
      || fileSha256(path) !== artifact.verificationArtifact.sha256
      || readFileSync(path).length !== artifact.verificationArtifact.bytes) {
      throw new Error("migration verification artifact does not match the rehearsal evidence");
    }
  }
  if (artifact.artifactHash !== artifactHash(artifact)) {
    throw new Error("migration rehearsal artifact hash does not match its canonical content");
  }
  return artifact;
}

function option(args, name, { required = false } = {}) {
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

function assertKnownArguments(args) {
  const valueOptions = new Set([
    "--output",
    "--verification-output",
    "--validate-artifact",
    "--verification-artifact",
  ]);
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
    "  node eval/release/migration-rehearsal.js --output FILE [--verification-output FILE]",
    "  node eval/release/migration-rehearsal.js --validate-artifact FILE [--verification-artifact FILE]",
    "",
    "Run from a clean revision and write release evidence outside the repository.",
  ].join("\n");
}

async function main(args) {
  assertKnownArguments(args);
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const validatePath = option(args, "--validate-artifact");
  if (validatePath !== undefined) {
    if (args.includes("--output") || args.includes("--verification-output")) {
      throw new TypeError("run output options cannot be combined with --validate-artifact");
    }
    const artifact = JSON.parse(readFileSync(resolve(validatePath), "utf8"));
    validateMigrationRehearsalArtifact(artifact, {
      verificationArtifactPath: option(args, "--verification-artifact"),
    });
    process.stderr.write("migration rollback rehearsal artifact passed validation\n");
    return 0;
  }
  if (args.includes("--verification-artifact")) {
    throw new TypeError("--verification-artifact requires --validate-artifact");
  }
  const outputPath = option(args, "--output", { required: true });
  const artifact = await runMigrationRehearsal({
    outputPath,
    verificationOutputPath: option(args, "--verification-output"),
  });
  process.stdout.write(`${JSON.stringify({
    outcome: artifact.outcome,
    artifact: resolve(outputPath),
    verificationArtifact: artifact.verificationArtifact.file,
    artifactHash: artifact.artifactHash,
  })}\n`);
  return artifact.outcome === "passed" ? 0 : 1;
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
