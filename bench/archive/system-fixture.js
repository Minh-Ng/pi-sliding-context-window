import { createHash } from "node:crypto";
import {
  createChunkReferences,
  splitPhysicalChunks,
} from "../../src/rocksdb/chunks.js";
import {
  createSearchWindows,
  windowForByteRange,
} from "../../src/rocksdb/windows.js";
import {
  ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
  ARCHIVE_BENCHMARK_SEED,
  benchmarkDocumentAt,
} from "./fixture.js";

export const ARCHIVE_SYSTEM_PROJECT = "/fixture/archive-benchmark";
export const ARCHIVE_SYSTEM_OFFICIAL_SCALE = 1_000_000;
export const ARCHIVE_SYSTEM_RECALL_MARKER = "SYSTEM_RECALL_PROBE_001";
export const ARCHIVE_SYSTEM_RECALL_MAX_TOKENS = 4_096;
export const ARCHIVE_SYSTEM_RECALL_NEIGHBORS = 1;

const RECALL_PROBE_BYTES = 1_024 * 1_024;
const RECALL_FILLER = "alpha beta gamma delta ";
// Each outer token exceeds the BM25 tokenizer's 128-code-point term limit and
// is therefore ignored. This keeps the 1 MiB recall probe under the bounded
// per-document analysis budget while retaining a realistic large payload.
const RECALL_OUTER_FILLER = `${"payloadsegment".repeat(16)} `;
const RECALL_CONTROL_HALF = RECALL_FILLER.repeat(750);
const RECALL_PROBE_CONTENT_SHA256 =
  "sha256:56103b3acd1e3a68331964e0838f981ee6111ba1e5f0b7ddd9714c52f163450f";

export const ARCHIVE_SYSTEM_RECALL_PROBE_DESCRIPTOR = Object.freeze({
  schemaVersion: 1,
  selection: "replace the final logical window",
  profile: "tool-1mib",
  byteLength: RECALL_PROBE_BYTES,
  marker: ARCHIVE_SYSTEM_RECALL_MARKER,
  generator: "long-token outer filler with 3000 short tokens on each side of one centered marker",
  contentSha256: RECALL_PROBE_CONTENT_SHA256,
});

const corpusFingerprintCache = new Map();

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function asciiFill(bytes, offset = 0, filler = RECALL_OUTER_FILLER) {
  const repeated = filler.repeat(Math.ceil((bytes + offset) / filler.length) + 1);
  return repeated.slice(offset, offset + bytes);
}

/**
 * The last logical window is a deterministic 1 MiB tool result with an exact
 * anchor in an interior logical search window. Its short lexical tokens keep
 * the requested three-window neighborhood inside the production byte budget.
 */
export function createArchiveSystemRecallProbe(scale) {
  positiveInteger(scale, "scale");
  const base = benchmarkDocumentAt(scale - 1, {
    count: scale,
    seed: ARCHIVE_BENCHMARK_SEED,
    officialScale: scale === ARCHIVE_SYSTEM_OFFICIAL_SCALE,
    profile: "tool-1mib",
  });
  const controlled = `${RECALL_CONTROL_HALF} ${ARCHIVE_SYSTEM_RECALL_MARKER} ${RECALL_CONTROL_HALF}`;
  const controlledBytes = Buffer.byteLength(controlled, "utf8");
  const prefixBytes = Math.floor((RECALL_PROBE_BYTES - controlledBytes) / 2);
  const prefix = asciiFill(prefixBytes);
  const suffixBytes = RECALL_PROBE_BYTES - prefixBytes - controlledBytes;
  const text = `${prefix}${controlled}${asciiFill(
    suffixBytes,
    prefixBytes % RECALL_OUTER_FILLER.length,
  )}`;
  if (Buffer.byteLength(text, "utf8") !== RECALL_PROBE_BYTES) {
    throw new Error("archive system recall probe must be exactly 1 MiB");
  }
  const contentSha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  if (contentSha256 !== RECALL_PROBE_CONTENT_SHA256) {
    throw new Error("archive system recall probe content fingerprint is stale");
  }
  return Object.freeze({
    ...base,
    text,
    payloadBytes: RECALL_PROBE_BYTES,
    kind: "tool-result",
    profile: "tool-1mib",
    metadata: Object.freeze({
      ...base.metadata,
      archiveSystemProbe: "three-window-recall",
    }),
  });
}

function systemProfileAt(index, scale) {
  const ordinal = index + 1;
  if (index === scale - 1) return "tool-1mib";
  if (scale === ARCHIVE_SYSTEM_OFFICIAL_SCALE) {
    if (ordinal % 10_000 === 0) return "tool-1mib";
    if (ordinal % 1_000 === 0) return "tool-10kib";
    return "short";
  }
  if (scale >= 3 && ordinal === scale - 1) return "tool-10kib";
  return "short";
}

/**
 * Bind the base frozen corpus plan, every ordered logical identity/profile,
 * and the complete content identity of the one system-specific override.
 */
export function archiveSystemCorpusFingerprint(scale) {
  positiveInteger(scale, "scale");
  const cached = corpusFingerprintCache.get(scale);
  if (cached) return cached;
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    schemaVersion: 1,
    basePlanFingerprint: ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
    seed: ARCHIVE_BENCHMARK_SEED,
    scale,
    vectorsEnabled: false,
    override: ARCHIVE_SYSTEM_RECALL_PROBE_DESCRIPTOR,
  }));
  hash.update("\n");
  for (let index = 0; index < scale; index += 1) {
    const ordinal = index + 1;
    const profile = systemProfileAt(index, scale);
    const bucket = index % 16;
    const repeatedIdentifier = (ordinal * 17 + ARCHIVE_BENCHMARK_SEED) % 32;
    const kind = profile === "short" ? "turn" : "tool-result";
    const createdAt = 1_700_000_000_000 - ((15 - bucket) * 86_400_000) + index;
    hash.update([
      ordinal,
      `bench-${String(ordinal).padStart(7, "0")}`,
      `bench-session-${index % 8}`,
      ARCHIVE_SYSTEM_PROJECT,
      kind,
      profile,
      createdAt,
      bucket,
      repeatedIdentifier,
      index === scale - 1 ? RECALL_PROBE_CONTENT_SHA256 : ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
    ].join("\0"));
    hash.update("\n");
  }
  const fingerprint = `sha256:${hash.digest("hex")}`;
  corpusFingerprintCache.set(scale, fingerprint);
  return fingerprint;
}

export function archiveSystemDocumentAt(index, scale) {
  positiveInteger(scale, "scale");
  if (!Number.isSafeInteger(index) || index < 0 || index >= scale) {
    throw new RangeError("index must identify an archive system document");
  }
  if (index === scale - 1) return createArchiveSystemRecallProbe(scale);
  return benchmarkDocumentAt(index, {
    count: scale,
    seed: ARCHIVE_BENCHMARK_SEED,
    officialScale: scale === ARCHIVE_SYSTEM_OFFICIAL_SCALE,
  });
}

export function archiveSystemAdmission(document, idempotencyKey) {
  const sourceKey = `benchmark:${document.id}`;
  return Object.freeze({
    idempotencyKey,
    document: Object.freeze({
      documentId: document.id,
      version: 1,
      sourceKey,
      sessionId: document.sessionId,
      project: document.project,
      kind: document.kind,
      createdAt: document.createdAt,
      text: document.text,
      metadata: structuredClone(document.metadata),
      sourceMessageKeys: Object.freeze([sourceKey]),
      sourceKeyStatus: "preserved",
    }),
    structuralMessages: Object.freeze([]),
    retentionClass: document.kind === "tool-result"
      ? "ephemeral-payload"
      : "conversation-source",
  });
}

export function archiveSystemQueries(scale) {
  positiveInteger(scale, "scale");
  return Object.freeze({
    exact: ARCHIVE_SYSTEM_RECALL_MARKER,
    bm25: "Earlier alpha beta gamma delta",
    recall: ARCHIVE_SYSTEM_RECALL_MARKER,
  });
}

/** Recompute the expected interior three-window recall byte range. */
export function archiveSystemRecallExpectation(scale) {
  const document = createArchiveSystemRecallProbe(scale);
  const markerStartByte = Buffer.byteLength(
    document.text.slice(0, document.text.indexOf(ARCHIVE_SYSTEM_RECALL_MARKER)),
    "utf8",
  );
  const markerEndByte = markerStartByte + Buffer.byteLength(ARCHIVE_SYSTEM_RECALL_MARKER, "utf8");
  const chunks = createChunkReferences(splitPhysicalChunks(document.text));
  const windows = createSearchWindows({
    text: document.text,
    documentId: document.id,
    documentVersion: 1,
    chunks,
  });
  const target = windowForByteRange(windows, markerStartByte, markerEndByte);
  const first = windows[target.ordinal - ARCHIVE_SYSTEM_RECALL_NEIGHBORS];
  const last = windows[target.ordinal + ARCHIVE_SYSTEM_RECALL_NEIGHBORS];
  if (!first || !last) throw new Error("archive system recall marker is not in an interior window");
  return Object.freeze({
    documentId: document.id,
    targetWindowOrdinal: target.ordinal,
    firstWindowOrdinal: first.ordinal,
    lastWindowOrdinal: last.ordinal,
    startByte: first.startByte,
    endByte: last.endByte,
    markerStartByte,
    markerEndByte,
  });
}
