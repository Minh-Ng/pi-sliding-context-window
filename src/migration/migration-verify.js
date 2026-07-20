import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ARCHIVED_EVIDENCE_LABEL } from "../evidence-routing.js";
import { CHUNK_FORMAT_VERSION } from "../rocksdb/chunks.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { MANIFEST_FORMAT_VERSION, manifestKeys } from "../rocksdb/manifests.js";
import { stableJson } from "../rocksdb/schema.js";
import { retentionForAdmission } from "../daemon/retention-policy.js";
import { SqliteArchiveSource } from "./sqlite-source.js";
import { applyDifferenceAllowlist, createShadowDifference } from "./shadow.js";
import {
  MIGRATION_FORMAT_VERSION,
  MIGRATION_KEYSPACE,
  MIGRATION_RETENTION_POLICY,
  MigrationBlockedError,
  MigrationSourceMismatchError,
  assertSameDatabase,
  assertSnapshotStillCurrent,
  getMigrationStatus,
  hash,
  identifier,
  migrationKeys,
  nonNegativeInteger,
  persistState,
  positiveInteger,
  retentionStartedAt,
  serializedError,
  sourceDescriptor,
  statusFor,
} from "./migration-shared.js";

// Verification: prefix revalidation on resume, and the full-corpus comparison
// audit (shadow differences, comparison history, offline-ready sealing input).

export const MIGRATION_COMPARISON_RUN_LIMIT = 8;
export const MIGRATION_COMPARISON_DETAIL_LIMIT = 256;
export const MIGRATION_COMPARISON_DETAIL_BYTES = 1_048_576;
// A source or manifest may carry several admitted MiB of metadata and
// structural provenance. Count-bounded pages therefore stay deliberately
// small so worst-case records remain below the daemon memory gate.
export const MIGRATION_VERIFICATION_PAGE_SIZE = 1;

const MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION = 1;

const STRUCTURAL_ROLES = new Set(["user", "assistant", "system", "tool", "unknown"]);

function updateUtf8String(hashValue, value) {
  const chunkCodeUnits = 64 * 1_024;
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + chunkCodeUnits);
    if (end < value.length) {
      const preceding = value.charCodeAt(end - 1);
      const following = value.charCodeAt(end);
      if (preceding >= 0xd800 && preceding <= 0xdbff
        && following >= 0xdc00 && following <= 0xdfff) end -= 1;
    }
    hashValue.update(value.slice(start, end), "utf8");
    start = end;
  }
  return hashValue;
}

function hashUtf8String(value) {
  return updateUtf8String(createHash("sha256"), value).digest("hex");
}

function canonicalCandidatePath(path) {
  const requested = resolve(identifier(path, "artifactPath"));
  let cursor = requested;
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(cursor), ...missing);
    } catch (cause) {
      if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) return requested;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathInside(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function storeContainsIdentity(root, target) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (sameFileIdentity(statSync(path, { bigint: true }), target)) return true;
      } catch {
        // RocksDB can retire files while this read-only identity check runs.
      }
    }
  }
  return false;
}

function safeVerificationArtifactPath(store, sourcePath, artifactPath) {
  const requested = resolve(artifactPath);
  const candidate = canonicalCandidatePath(requested);
  const storeRequested = resolve(store.path);
  const storeCanonical = realpathSync.native(storeRequested);
  if (pathInside(storeRequested, requested) || pathInside(storeCanonical, candidate)) {
    throw new MigrationBlockedError("Migration verification artifact cannot target the RocksDB store.", {
      artifactPath: requested,
    });
  }
  const protectedSourcePaths = ["", "-wal", "-shm", "-journal"]
    .map((suffix) => canonicalCandidatePath(`${sourcePath}${suffix}`));
  if (protectedSourcePaths.includes(candidate)) {
    throw new MigrationBlockedError("Migration verification artifact cannot overwrite SQLite source files.", {
      artifactPath: requested,
    });
  }
  if (existsSync(candidate)) {
    const target = statSync(candidate, { bigint: true });
    if (!target.isFile()) {
      throw new MigrationBlockedError("Migration verification artifact must target a regular file.");
    }
    for (const protectedPath of protectedSourcePaths) {
      if (existsSync(protectedPath)
        && sameFileIdentity(target, statSync(protectedPath, { bigint: true }))) {
        throw new MigrationBlockedError(
          "Migration verification artifact cannot alias SQLite source files.",
          { artifactPath: requested },
        );
      }
    }
    if (storeContainsIdentity(storeCanonical, target)) {
      throw new MigrationBlockedError(
        "Migration verification artifact cannot alias a RocksDB store file.",
        { artifactPath: requested },
      );
    }
  }
  return Object.freeze({ requested, target: candidate });
}

function writeVerificationArtifact(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, value, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function revalidateCheckpoint(store, source, checkpoint, info) {
  const through = checkpoint.lastStableSourceOrderingKey;
  if (through === 0) return;
  let cursor = 0;
  let count = 0;
  let last;
  const chunkCache = {};
  while (cursor < through) {
    const rows = source.readBatch(cursor, 1);
    if (rows.length === 0) break;
    let advanced = false;
    for (const row of rows) {
      if (row.sourceOrderingKey > through) break;
      advanced = true;
      cursor = row.sourceOrderingKey;
      last = row;
      count += 1;
      const expected = expectedMigratedRow(row, info, checkpoint);
      const storedSource = uncachedExactPayload(
        store,
        migrationKeys.source(info.databaseId, row.sourceOrderingKey),
      );
      if (storedSource !== undefined
        && storedSource.sourceRecordFingerprint !== expected.sourceRecord.sourceRecordFingerprint) {
        throw new MigrationSourceMismatchError(
          `A previously completed SQLite migration row changed at ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
      if (stableJson(storedSource) !== stableJson(expected.sourceRecord)) {
        throw new MigrationBlockedError(
          `Previously migrated destination record changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
      const manifest = uncachedExactPayload(store, manifestKeys.document(row.id, 1));
      let canonicalSource;
      try {
        canonicalSource = verifyCanonicalSource(store, manifest, chunkCache);
      } catch (error) {
        throw new MigrationBlockedError(
          `Previously migrated canonical document changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
          { cause: error },
        );
      }
      const expectedStatic = { ...expected.document };
      delete expectedStatic.text;
      const actualStatic = canonicalStaticDocument(manifest);
      if (stableJson(actualStatic) !== stableJson(expectedStatic)
        || canonicalSource.byteLength !== expected.sourceRecord.textByteLength
        || canonicalSource.contentHash !== expected.sourceRecord.textHash) {
        throw new MigrationBlockedError(
          `Previously migrated canonical document changed at SQLite ordering key ${row.sourceOrderingKey}.`,
          { sourceOrderingKey: row.sourceOrderingKey, documentId: row.id },
        );
      }
    }
    if (!advanced) break;
  }
  if (count !== checkpoint.migratedCount || last?.sourceOrderingKey !== through) {
    throw new MigrationSourceMismatchError("A previously completed SQLite migration range changed.", {
      expected: {
        count: checkpoint.migratedCount,
        throughOrderingKey: through,
      },
      actual: {
        count,
        throughOrderingKey: last?.sourceOrderingKey ?? 0,
      },
    });
  }
}

function structuralMessage(message) {
  return {
    messageKey: identifier(message.messageKey, "structural message key"),
    messageIndex: nonNegativeInteger(message.messageIndex, "structural message index"),
    role: STRUCTURAL_ROLES.has(message.role) ? message.role : "unknown",
    createdAt: nonNegativeInteger(message.createdAt, "structural message timestamp"),
    text: typeof message.text === "string" ? message.text : "",
    questionScore: nonNegativeInteger(message.questionScore, "question score"),
    requestScore: nonNegativeInteger(message.requestScore, "request score"),
    correctionScore: nonNegativeInteger(message.correctionScore, "correction score"),
    answerScore: nonNegativeInteger(message.answerScore, "answer score"),
  };
}

function sourceKeys(source, info) {
  const provenance = source.provenance?.sourceMessages;
  if (provenance?.status === "available" && Array.isArray(provenance.keys)
    && provenance.keys.length > 0) {
    const keys = [...provenance.keys];
    return { sourceKey: keys[0], sourceMessageKeys: keys, sourceKeyStatus: "preserved" };
  }
  const sourceKey = `sqlite:${info.databaseId}:${source.sourceOrderingKey}`;
  return { sourceKey, sourceMessageKeys: [], sourceKeyStatus: "unavailable" };
}

export function mappedSource(source, info) {
  for (const [field, value] of [
    ["id", source.id],
    ["sessionId", source.sessionId],
    ["project", source.project],
    ["kind", source.kind],
  ]) identifier(value, `SQLite document ${field}`);
  if (typeof source.text !== "string") {
    throw new TypeError(`SQLite document ${source.id} text must be a string.`);
  }
  nonNegativeInteger(source.createdAt, `SQLite document ${source.id} createdAt`);
  const keys = sourceKeys(source, info);
  const document = {
    documentId: source.id,
    version: 1,
    sourceKey: keys.sourceKey,
    sourceKeyStatus: keys.sourceKeyStatus,
    sessionId: source.sessionId,
    project: source.project,
    kind: source.kind,
    createdAt: source.createdAt,
    text: source.text,
    metadata: structuredClone(source.metadata),
    sourceMessageKeys: keys.sourceMessageKeys,
  };
  const structuralMessages = source.structuralMessages.map(structuralMessage);
  const sourceRecord = {
    migrationFormatVersion: MIGRATION_FORMAT_VERSION,
    sourceDatabaseId: info.databaseId,
    sourceOrderingKey: source.sourceOrderingKey,
    sourceRowId: source.sourceRowId,
    sourceRecordFingerprint: source.sourceRecordFingerprint,
    documentId: source.id,
    documentVersion: 1,
    sourceKey: keys.sourceKey,
    sourceKeyStatus: keys.sourceKeyStatus,
    sourceMessageKeys: structuredClone(keys.sourceMessageKeys),
    textByteLength: Buffer.byteLength(source.text, "utf8"),
    textHash: hashUtf8String(source.text),
    metadataJson: source.metadataJson,
    metadataParse: structuredClone(source.metadataParse),
    provenance: structuredClone(source.provenance),
    structuralMessages: structuredClone(source.structuralMessages),
  };
  return { document, structuralMessages, sourceRecord };
}

function expectedMigratedRow(source, info, checkpoint) {
  const mapped = mappedSource(source, info);
  const retention = retentionForAdmission(MIGRATION_RETENTION_POLICY, {
    kind: mapped.document.kind,
    now: retentionStartedAt(checkpoint),
  });
  return { ...mapped, retention };
}

function uncachedExactPayload(store, key) {
  const identity = stableJson(key);
  const page = store.scan(key, { limit: 2, fillCache: false });
  return page.find((record) => stableJson(record.key) === identity)?.payload;
}

function recallEvidenceHasher(documentId, kind) {
  return createHash("sha256").update(
    `[${ARCHIVED_EVIDENCE_LABEL}]\n\n# ${documentId} (${kind})\n\n`
      + "## Deterministic archived serialization\n",
  );
}

function expectedRecallEvidenceHash(source) {
  return updateUtf8String(
    recallEvidenceHasher(source.id, source.kind),
    source.text,
  ).digest("hex");
}

function canonicalStaticDocument(manifest) {
  return {
    documentId: manifest?.documentId,
    version: manifest?.version,
    sourceKey: manifest?.sourceKey,
    sourceKeyStatus: manifest?.sourceKeyStatus,
    sessionId: manifest?.sessionId,
    project: manifest?.project,
    kind: manifest?.kind,
    createdAt: manifest?.createdAt,
    metadata: manifest?.metadata,
    sourceMessageKeys: manifest?.sourceMessageKeys,
  };
}

/** Validate every canonical occurrence while retaining at most one physical chunk. */
function verifyCanonicalSource(store, manifest, chunkCache = {}) {
  if (!manifest || manifest.manifestFormatVersion !== MANIFEST_FORMAT_VERSION
    || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error("Canonical document manifest is missing or malformed.");
  }
  const content = createHash("sha256");
  const recall = recallEvidenceHasher(manifest.documentId, manifest.kind);
  let cursor = 0;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const reference = manifest.chunks[index];
    if (!reference || reference.ordinal !== index
      || reference.startByte !== cursor
      || !Number.isSafeInteger(reference.endByte) || reference.endByte < reference.startByte
      || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0
      || reference.byteLength !== reference.endByte - reference.startByte
      || typeof reference.chunkId !== "string") {
      throw new Error(`Canonical source chunk reference ${index} is malformed.`);
    }
    let bytes;
    let chunkHash;
    if (chunkCache.chunkId === reference.chunkId) {
      ({ bytes, chunkHash } = chunkCache);
    } else {
      const chunk = uncachedExactPayload(store, manifestKeys.chunk(reference.chunkId));
      if (!chunk || chunk.chunkFormatVersion !== CHUNK_FORMAT_VERSION
        || chunk.chunkId !== reference.chunkId
        || chunk.encoding !== "utf8"
        || typeof chunk.content !== "string") {
        throw new Error(`Canonical source chunk ${reference.chunkId} is missing or malformed.`);
      }
      bytes = Buffer.from(chunk.content, "utf8");
      chunkHash = hash(bytes);
      if (chunk.byteLength !== bytes.length
        || chunk.contentHash !== chunkHash
        || reference.chunkId !== `sha256:${chunkHash}`) {
        throw new Error(`Canonical source chunk ${reference.chunkId} failed integrity validation.`);
      }
      chunkCache.chunkId = reference.chunkId;
      chunkCache.bytes = bytes;
      chunkCache.chunkHash = chunkHash;
    }
    if (reference.byteLength !== bytes.length) {
      throw new Error(`Canonical source chunk ${reference.chunkId} failed occurrence validation.`);
    }
    content.update(bytes);
    recall.update(bytes);
    cursor = reference.endByte;
  }
  const contentHash = content.digest("hex");
  if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength !== cursor
    || manifest.contentHash !== contentHash) {
    throw new Error("Canonical source chunks do not match the document manifest.");
  }
  return {
    byteLength: cursor,
    contentHash,
    recallEvidenceHash: recall.digest("hex"),
  };
}

function pushedDifference(differences, type, fields, options) {
  differences.push(createShadowDifference(type, fields, options));
}

function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) =>
    (left < right ? -1 : left > right ? 1 : 0)));
}

function incrementCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Hash and count every evaluated mismatch while retaining only bounded samples.
 * Pass/fail never depends on whether a mismatch fit in the sample budget.
 */
class MigrationDifferenceAccumulator {
  constructor({ allowlist = [], now = Date.now() } = {}) {
    this.allowlist = allowlist;
    this.now = now;
    this.hash = createHash("sha256");
    this.differenceCount = 0;
    this.failureCount = 0;
    this.differenceCounts = new Map();
    this.failureCounts = new Map();
    this.samples = [];
    this.sampleBytes = 0;
    this.finished = undefined;
  }

  push(...candidates) {
    if (this.finished !== undefined) {
      throw new TypeError("Migration differences cannot be added after finalization.");
    }
    for (const candidate of candidates) {
      const evaluated = applyDifferenceAllowlist(
        [candidate],
        this.allowlist,
        this.now,
      )[0];
      const serialized = stableJson(evaluated);
      this.hash.update(serialized);
      this.hash.update("\n");
      this.differenceCount += 1;
      incrementCount(this.differenceCounts, evaluated.type);
      if (!evaluated.allowed) {
        this.failureCount += 1;
        incrementCount(this.failureCounts, evaluated.type);
      }
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (this.samples.length < MIGRATION_COMPARISON_DETAIL_LIMIT
        && bytes <= MIGRATION_COMPARISON_DETAIL_BYTES - this.sampleBytes) {
        this.samples.push(evaluated);
        this.sampleBytes += bytes;
      }
    }
    return this.differenceCount;
  }

  finish() {
    this.finished ??= Object.freeze({
      differenceCount: this.differenceCount,
      failureCount: this.failureCount,
      differenceCounts: Object.freeze(sortedCounts(this.differenceCounts)),
      failureCounts: Object.freeze(sortedCounts(this.failureCounts)),
      comparisonHash: `sha256:${this.hash.digest("hex")}`,
      samples: Object.freeze([...this.samples]),
      sampledDifferenceCount: this.samples.length,
      sampledDifferenceBytes: this.sampleBytes,
      samplesTruncated: this.samples.length < this.differenceCount,
    });
    return this.finished;
  }
}

export function* destinationSourceRecords(store, sourceId) {
  let after;
  while (true) {
    const page = store.scan(migrationKeys.sourcePrefix(sourceId), {
      limit: MIGRATION_VERIFICATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    yield* page;
    if (page.length < MIGRATION_VERIFICATION_PAGE_SIZE) break;
    after = page.at(-1).keyBytes;
  }
}

function* destinationCanonicalRecords(store) {
  let after;
  while (true) {
    const page = store.scan([KEYSPACE.DOCUMENT], {
      limit: MIGRATION_VERIFICATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    yield* page;
    if (page.length < MIGRATION_VERIFICATION_PAGE_SIZE) break;
    after = page.at(-1).keyBytes;
  }
}

function comparisonHistory(sourceId, value) {
  if (value === undefined) {
    return {
      migrationComparisonHistoryFormatVersion: MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION,
      sourceDatabaseId: sourceId,
      runs: [],
    };
  }
  if (!value || value.migrationComparisonHistoryFormatVersion
      !== MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION
    || value.sourceDatabaseId !== sourceId || !Array.isArray(value.runs)) {
    throw new MigrationBlockedError("Migration comparison history is malformed.", { sourceId });
  }
  const runs = value.runs.map((run) => {
    if (!run || typeof run.runId !== "string" || run.runId.length === 0
      || !Number.isSafeInteger(run.detectedAt) || run.detectedAt < 0
      || !Number.isSafeInteger(run.persistedDifferenceCount)
      || run.persistedDifferenceCount < 0
      || run.persistedDifferenceCount > MIGRATION_COMPARISON_DETAIL_LIMIT) {
      throw new MigrationBlockedError("Migration comparison history contains an invalid run.", {
        sourceId,
      });
    }
    return run;
  });
  if (runs.length > MIGRATION_COMPARISON_RUN_LIMIT + 1) {
    throw new MigrationBlockedError("Migration comparison history exceeds its bounded run limit.", {
      sourceId,
    });
  }
  return { ...value, runs };
}

function boundedComparisonDetails(differences, runId, detectedAt) {
  const records = [];
  let persistedBytes = 0;
  for (const difference of differences) {
    if (records.length >= MIGRATION_COMPARISON_DETAIL_LIMIT) break;
    const payload = { ...difference, runId, detectedAt };
    const bytes = Buffer.byteLength(stableJson(payload), "utf8");
    if (bytes > MIGRATION_COMPARISON_DETAIL_BYTES - persistedBytes) continue;
    records.push(payload);
    persistedBytes += bytes;
  }
  return { records, persistedBytes };
}

async function persistComparisonRun(store, sourceId, summary, comparison) {
  const runId = randomUUID();
  const detectedAt = Date.now();
  const historyKey = migrationKeys.comparisonHistory(sourceId);
  const checkpointKey = migrationKeys.checkpoint(sourceId);
  // Warm transaction point reads for rocksdb-js, then re-read inside the
  // optimistic transaction so concurrent comparison runs cannot orphan each
  // other's records outside the bounded history.
  await store.get(historyKey);
  await store.get(checkpointKey);
  const details = boundedComparisonDetails(comparison.samples, runId, detectedAt);
  const run = {
    runId,
    detectedAt,
    persistedDifferenceCount: details.records.length,
  };
  await store.transaction(async (transaction) => {
    const previousHistory = comparisonHistory(sourceId, await transaction.get(historyKey));
    const checkpoint = await transaction.get(checkpointKey);
    const candidates = [...previousHistory.runs, run];
    const recentIds = new Set(candidates
      .slice(-MIGRATION_COMPARISON_RUN_LIMIT)
      .map((candidate) => candidate.runId));
    const pinnedRunId = checkpoint?.verification?.runId;
    const retained = candidates.filter((candidate) =>
      recentIds.has(candidate.runId) || candidate.runId === pinnedRunId);
    const retainedIds = new Set(retained.map((candidate) => candidate.runId));
    const evicted = candidates.filter((candidate) => !retainedIds.has(candidate.runId));
    for (let index = 0; index < details.records.length; index += 1) {
      await transaction.put(migrationKeys.comparison(sourceId, runId, index), {
        ...details.records[index],
      }, { kind: "migration-comparison" });
    }
    await transaction.put(migrationKeys.comparisonRun(sourceId, runId), {
      migrationFormatVersion: MIGRATION_FORMAT_VERSION,
      runId,
      detectedAt,
      summary,
      comparisonHash: comparison.comparisonHash,
      differenceCount: comparison.differenceCount,
      failureCount: comparison.failureCount,
      differenceCounts: comparison.differenceCounts,
      failureCounts: comparison.failureCounts,
      persistedDifferenceCount: details.records.length,
      persistedDifferenceBytes: details.persistedBytes,
      detailsTruncated: details.records.length < comparison.differenceCount,
    }, { kind: "migration-comparison-run" });
    await transaction.put(historyKey, {
      migrationComparisonHistoryFormatVersion: MIGRATION_COMPARISON_HISTORY_FORMAT_VERSION,
      sourceDatabaseId: sourceId,
      runs: retained,
      updatedAt: detectedAt,
    }, { kind: "migration-comparison-history" });
    for (const previous of evicted) {
      for (let index = 0; index < previous.persistedDifferenceCount; index += 1) {
        await transaction.remove(migrationKeys.comparison(sourceId, previous.runId, index));
      }
      await transaction.remove(migrationKeys.comparisonRun(sourceId, previous.runId));
    }
  });
  return {
    runId,
    detectedAt,
    comparisonHash: comparison.comparisonHash,
    differenceCount: comparison.differenceCount,
    failureCount: comparison.failureCount,
    persistedDifferenceCount: details.records.length,
    detailsTruncated: details.records.length < comparison.differenceCount,
  };
}

/** Persist sampled recall/search differences and surface non-allowlisted failures in status. */
export async function recordShadowDifferences(store, {
  sourceId,
  kind,
  differences,
  allowlist = [],
  now = Date.now(),
} = {}) {
  identifier(sourceId, "sourceId");
  identifier(kind, "comparison kind");
  if (!Array.isArray(differences)) throw new TypeError("differences must be an array.");
  const accumulator = new MigrationDifferenceAccumulator({ allowlist, now });
  for (const difference of differences) accumulator.push(difference);
  const comparison = accumulator.finish();
  const failures = comparison.failureCount;
  const currentStatus = await getMigrationStatus(store);
  const checkpoint = await store.get(migrationKeys.checkpoint(sourceId));
  if (!checkpoint) throw new MigrationBlockedError("No checkpoint exists for this comparison source.");
  const summary = {
    kind,
    status: failures === 0 ? "passed" : "failed",
    checked: comparison.differenceCount,
    failures,
  };
  const run = await persistComparisonRun(store, sourceId, summary, comparison);
  const status = statusFor(
    checkpoint,
    currentStatus.phase,
    Number(currentStatus.comparisonFailures ?? 0) + failures,
  );
  await persistState(store, checkpoint, status);
  return { ...summary, ...run };
}

/** Verify the complete canonical corpus; every working set and mismatch sample is bounded. */
async function verifyOfflineMigration(store, {
  sourcePath,
  sampleLimit,
  allowlist = [],
  artifactPath,
  now = Date.now(),
} = {}) {
  const currentStatus = await getMigrationStatus(store);
  if (currentStatus.phase === "rocksdb-authority") {
    throw new MigrationBlockedError(
      "The offline verification gate is sealed after the first RocksDB authority write.",
    );
  }
  const resolvedSourcePath = sourcePath ?? currentStatus.sourcePath;
  if (!resolvedSourcePath) throw new TypeError("Migration verification requires sourcePath.");
  if (sampleLimit !== undefined
    && (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 1_000_000)) {
    throw new RangeError("sampleLimit must be between 1 and 1000000.");
  }
  // The completed copy already binds the semantic corpus fingerprint. Open a
  // private read view without scanning every large source row a second time;
  // the exact live database/WAL/journal fingerprint below proves that corpus
  // is still the checkpointed one.
  const source = SqliteArchiveSource.open(resolvedSourcePath, { deferCorpusIdentity: true });
  try {
    const observedInfo = source.info();
    const checkpoint = await store.get(migrationKeys.checkpoint(observedInfo.databaseId));
    if (!checkpoint) throw new MigrationBlockedError("No checkpoint exists for this SQLite source.");
    if (checkpoint.completed !== true) {
      throw new MigrationBlockedError(
        "Offline verification cannot run until the SQLite copy is complete.",
      );
    }
    assertSameDatabase(checkpoint, observedInfo);
    if (stableJson(checkpoint.sourceFileFingerprint)
      !== stableJson(observedInfo.fileFingerprint)) {
      throw new MigrationSourceMismatchError("Migration source files changed after copy.", {
        expected: checkpoint.sourceFileFingerprint,
        actual: observedInfo.fileFingerprint,
      });
    }
    const info = Object.freeze({
      ...observedInfo,
      sourceFingerprint: checkpoint.sourceFingerprint,
      corpusFingerprint: checkpoint.sourceCorpusFingerprint,
    });
    const resolvedArtifact = artifactPath === undefined
      ? undefined
      : safeVerificationArtifactPath(store, info.path, artifactPath);

    const differences = new MigrationDifferenceAccumulator({ allowlist, now });
    let missingDocuments = 0;
    let cursor = 0;
    let checked = 0;
    let sampled = 0;
    const chunkCache = {};
    while (true) {
      const rows = source.readBatch(cursor, MIGRATION_VERIFICATION_PAGE_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.sourceOrderingKey;
        checked += 1;
        const expected = expectedMigratedRow(row, info, checkpoint);
        const storedSource = uncachedExactPayload(
          store,
          migrationKeys.source(info.databaseId, row.sourceOrderingKey),
        );
        const manifest = uncachedExactPayload(store, manifestKeys.document(row.id, 1));
        const options = { allowlist, now };
        if (storedSource === undefined || manifest === undefined) {
          missingDocuments += 1;
          pushedDifference(differences, "missing-canonical", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              sourceRecord: storedSource === undefined,
              canonicalDocument: manifest === undefined,
            },
            actual: null,
          }, options);
          continue;
        }

        if (stableJson(storedSource) !== stableJson(expected.sourceRecord)) {
          pushedDifference(differences, "source-record", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { hash: hash(stableJson(expected.sourceRecord)) },
            actual: { hash: hash(stableJson(storedSource)) },
          }, options);
        }
        if (storedSource.metadataJson !== row.metadataJson
          || stableJson(storedSource.metadataParse) !== stableJson(row.metadataParse)
          || stableJson(storedSource.provenance) !== stableJson(row.provenance)
          || storedSource.sourceRowId !== expected.sourceRecord.sourceRowId
          || storedSource.sourceKey !== expected.sourceRecord.sourceKey
          || storedSource.sourceKeyStatus !== expected.sourceRecord.sourceKeyStatus
          || stableJson(storedSource.sourceMessageKeys)
            !== stableJson(expected.sourceRecord.sourceMessageKeys)) {
          pushedDifference(differences, "provenance", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              metadataJsonHash: hash(row.metadataJson),
              provenanceHash: hash(stableJson(row.provenance)),
            },
            actual: {
              metadataJsonHash: hash(String(storedSource.metadataJson ?? "")),
              provenanceHash: hash(stableJson(storedSource.provenance ?? null)),
            },
          }, options);
        }

        let canonicalSource;
        try {
          canonicalSource = verifyCanonicalSource(store, manifest, chunkCache);
        } catch (error) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { readable: true },
            actual: { readable: false, error: serializedError(error) },
          }, options);
          continue;
        }
        if (expected.sourceRecord.textByteLength !== canonicalSource.byteLength
          || expected.sourceRecord.textHash !== canonicalSource.contentHash) {
          pushedDifference(differences, "text-bytes", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              byteLength: expected.sourceRecord.textByteLength,
              hash: expected.sourceRecord.textHash,
            },
            actual: {
              byteLength: canonicalSource.byteLength,
              hash: canonicalSource.contentHash,
            },
          }, options);
        }
        const expectedWithoutText = { ...expected.document };
        const actualWithoutText = canonicalStaticDocument(manifest);
        delete expectedWithoutText.text;
        if (stableJson(expectedWithoutText) !== stableJson(actualWithoutText)) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { hash: hash(stableJson(expectedWithoutText)) },
            actual: { hash: hash(stableJson(actualWithoutText)) },
          }, options);
        }
        if (manifest.retentionClass !== expected.retention.retentionClass
          || manifest.expiresAt !== expected.retention.expiresAt) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: {
              retentionClass: expected.retention.retentionClass,
              expiresAt: expected.retention.expiresAt ?? null,
            },
            actual: {
              retentionClass: manifest?.retentionClass ?? null,
              expiresAt: manifest?.expiresAt ?? null,
            },
          }, options);
        }
        if (expected.retention.expiresAt !== undefined) {
          const expiryKey = manifestKeys.expiry(
            expected.retention.expiresAt,
            expected.retention.retentionClass,
            row.id,
            1,
          );
          const expiry = uncachedExactPayload(store, expiryKey);
          const expectedExpiry = {
            documentId: row.id,
            documentVersion: 1,
            retentionClass: expected.retention.retentionClass,
            expiresAt: expected.retention.expiresAt,
          };
          if (stableJson(expiry) !== stableJson(expectedExpiry)) {
            pushedDifference(differences, "canonical-document", {
              documentId: row.id,
              sourceOrderingKey: row.sourceOrderingKey,
              expected: { expiryHash: hash(stableJson(expectedExpiry)) },
              actual: { expiryHash: expiry === undefined ? null : hash(stableJson(expiry)) },
            }, options);
          }
        }
        if (stableJson(manifest?.structuralMessages ?? [])
          !== stableJson(expected.structuralMessages)) {
          pushedDifference(differences, "canonical-document", {
            documentId: row.id,
            sourceOrderingKey: row.sourceOrderingKey,
            expected: { structuralMessagesHash: hash(stableJson(expected.structuralMessages)) },
            actual: { structuralMessagesHash: hash(stableJson(manifest?.structuralMessages ?? [])) },
          }, options);
        }

        if (sampleLimit === undefined || sampled < sampleLimit) {
          sampled += 1;
          const expectedHash = expectedRecallEvidenceHash(row);
          if (expectedHash !== canonicalSource.recallEvidenceHash) {
            pushedDifference(differences, "recall-evidence", {
              documentId: row.id,
              expected: { hash: expectedHash },
              actual: { hash: canonicalSource.recallEvidenceHash },
            }, options);
          }
        }
      }
    }

    for (const record of destinationSourceRecords(store, info.databaseId)) {
      const orderingKey = Number(record.key.at(-1));
      const expectedKey = Number.isSafeInteger(orderingKey) && orderingKey > 0
        ? migrationKeys.source(info.databaseId, orderingKey)
        : undefined;
      const keyIdentity = stableJson(record.key);
      const expectedKeyIdentity = expectedKey === undefined ? undefined : stableJson(expectedKey);
      const expectedDocumentId = expectedKey === undefined
        ? undefined
        : source.getDocumentIdByOrderingKey(orderingKey);
      if (expectedDocumentId === undefined
        || expectedDocumentId !== record.payload?.documentId
        || keyIdentity !== expectedKeyIdentity) {
        const extraId = record.payload?.documentId ?? `source-order:${String(orderingKey)}`;
        pushedDifference(differences, "extra-canonical", {
          documentId: extraId,
          sourceOrderingKey: Number.isSafeInteger(orderingKey) ? orderingKey : null,
          expected: null,
          actual: { sourceRecordHash: hash(stableJson(record.payload)) },
        }, { allowlist, now });
      }
    }

    for (const record of destinationCanonicalRecords(store)) {
      const documentId = record.key[1];
      const version = record.key[2];
      const expectedKey = typeof documentId === "string"
        ? manifestKeys.document(documentId, 1)
        : undefined;
      if (expectedKey !== undefined
        && stableJson(record.key) === stableJson(expectedKey)
        && source.hasDocumentId(documentId)) continue;
      const renderedDocumentId = String(documentId ?? "unknown-document");
      pushedDifference(differences, "extra-canonical", {
        documentId: renderedDocumentId,
        documentVersion: version,
        expected: null,
        actual: { canonicalManifestHash: hash(stableJson(record.payload)) },
      }, { allowlist, now });
    }

    // Do not certify a private snapshot after the live source advanced while
    // verification was reading it. A retry will compare the new coherent view.
    assertSnapshotStillCurrent(source, info);

    const comparison = differences.finish();
    const failureCount = (type) => comparison.failureCounts[type] ?? 0;
    const result = {
      status: comparison.failureCount === 0 ? "passed" : "failed",
      checked,
      missing: missingDocuments,
      extra: failureCount("extra-canonical"),
      provenanceDifferences: failureCount("provenance"),
      recallDifferences: failureCount("recall-evidence"),
      differences: comparison.differenceCount,
      failures: comparison.failureCount,
      differenceCounts: comparison.differenceCounts,
      failureCounts: comparison.failureCounts,
      comparisonHash: comparison.comparisonHash,
      sampledDifferences: comparison.sampledDifferenceCount,
      samplesTruncated: comparison.samplesTruncated,
    };
    const run = await persistComparisonRun(store, info.databaseId, result, comparison);
    const nextCheckpoint = {
      ...checkpoint,
      verification: {
        status: result.status,
        sourceFingerprint: info.sourceFingerprint,
        corpusFingerprint: info.corpusFingerprint,
        checked,
        failures: comparison.failureCount,
        comparisonHash: comparison.comparisonHash,
        runId: run.runId,
        verifiedAt: run.detectedAt,
      },
      updatedAt: Date.now(),
    };
    if (resolvedArtifact !== undefined) {
      writeVerificationArtifact(resolvedArtifact.target, `${JSON.stringify({
        migrationFormatVersion: MIGRATION_FORMAT_VERSION,
        source: sourceDescriptor(info),
        checkpoint: nextCheckpoint,
        verification: result,
        run,
        differences: comparison.samples,
      }, null, 2)}\n`);
      // Artifact publication is outside RocksDB. Recheck the live rollback
      // source after the filesystem write and before certifying offline-ready.
      assertSnapshotStillCurrent(source, info);
      result.artifactPath = resolvedArtifact.requested;
    }
    const status = statusFor(
      nextCheckpoint,
      comparison.failureCount === 0 ? "offline-ready" : "blocked",
      comparison.failureCount,
      { currentInfo: info },
    );
    await persistState(store, nextCheckpoint, status);
    return result;
  } finally {
    source.close();
  }
}

export async function verifyMigration(store, options = {}) {
  const run = () => verifyOfflineMigration(store, options);
  return typeof store.withExclusiveWrites === "function"
    ? store.withExclusiveWrites(run)
    : run();
}

export function listMigrationDifferences(store, { sourceId, runId, limit = 1_000 } = {}) {
  positiveInteger(limit, "difference limit");
  const prefix = runId === undefined
    ? [MIGRATION_KEYSPACE, "comparison", identifier(sourceId, "sourceId")]
    : [MIGRATION_KEYSPACE, "comparison", identifier(sourceId, "sourceId"), identifier(runId, "runId")];
  return store.scan(prefix, { limit }).map((record) => record.payload);
}
