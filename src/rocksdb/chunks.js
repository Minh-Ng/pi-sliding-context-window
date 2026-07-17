import { createHash } from "node:crypto";

export const CHUNK_FORMAT_VERSION = 1;
export const DEFAULT_CHUNKING_OPTIONS = Object.freeze({
  maxChunkBytes: 64 * 1024,
  minLineSplitBytes: 16 * 1024,
});
// Documents are unbounded, but one physical value must remain a bounded read
// unit. Indexing and recall can then page arbitrarily large sources without a
// single RocksDB value forcing the whole document into the JavaScript heap.
export const MAX_PHYSICAL_CHUNK_BYTES = 1 * 1024 * 1024;

export class ChunkIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChunkIntegrityError";
    this.code = "ERR_ROCKSDB_CHUNK_INTEGRITY";
    this.details = details;
  }
}

function requireWellFormedText(value, label = "text") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) {
    throw new TypeError(`${label} must not contain unpaired UTF-16 surrogates.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/** Normalize physical chunk parameters without retaining caller-owned state. */
export function normalizeChunkingOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Chunking options must be an object.");
  }
  const maxChunkBytes = positiveInteger(
    options.maxChunkBytes ?? DEFAULT_CHUNKING_OPTIONS.maxChunkBytes,
    "maxChunkBytes",
  );
  // Four bytes are needed to guarantee that any one valid UTF-8 scalar fits.
  if (maxChunkBytes < 4) throw new RangeError("maxChunkBytes must be at least 4.");
  if (maxChunkBytes > MAX_PHYSICAL_CHUNK_BYTES) {
    throw new RangeError(`maxChunkBytes must not exceed ${MAX_PHYSICAL_CHUNK_BYTES}.`);
  }
  const minLineSplitBytes = options.minLineSplitBytes
    ?? Math.min(DEFAULT_CHUNKING_OPTIONS.minLineSplitBytes, maxChunkBytes);
  if (!Number.isSafeInteger(minLineSplitBytes)
    || minLineSplitBytes < 0
    || minLineSplitBytes > maxChunkBytes) {
    throw new RangeError("minLineSplitBytes must be between 0 and maxChunkBytes.");
  }
  return Object.freeze({ maxChunkBytes, minLineSplitBytes });
}

/** Return the lowercase SHA-256 digest for exactly the supplied bytes. */
export function contentHash(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("Content hashing requires a string, Buffer, or Uint8Array.");
  }
  const bytes = typeof value === "string"
    ? Buffer.from(requireWellFormedText(value), "utf8")
    : Buffer.from(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkIdForHash(hash) {
  return `sha256:${hash}`;
}

function utf8BoundaryAtOrBefore(bytes, candidate, floor) {
  let boundary = candidate;
  while (boundary > floor && boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) {
    boundary -= 1;
  }
  return boundary;
}

function preferredEnd(bytes, start, options) {
  if (start + options.maxChunkBytes >= bytes.length) return bytes.length;
  const hardEnd = utf8BoundaryAtOrBefore(bytes, start + options.maxChunkBytes, start);
  if (hardEnd <= start) {
    throw new ChunkIntegrityError("Unable to find a UTF-8 boundary within the configured chunk size.", {
      startByte: start,
      maxChunkBytes: options.maxChunkBytes,
    });
  }
  const minimumEnd = start + options.minLineSplitBytes;
  const newline = bytes.lastIndexOf(0x0a, hardEnd - 1);
  if (newline >= minimumEnd && newline + 1 > start) return newline + 1;
  return hardEnd;
}

function physicalPayload(occurrence) {
  return Object.freeze({
    chunkFormatVersion: CHUNK_FORMAT_VERSION,
    chunkId: occurrence.chunkId,
    contentHash: occurrence.contentHash,
    encoding: "utf8",
    byteLength: occurrence.byteLength,
    content: occurrence.content,
  });
}

/**
 * Split a document into non-overlapping UTF-8-safe physical occurrences.
 *
 * `chunkId` is a pure content address. Repeated occurrences therefore retain
 * distinct coordinates while sharing one physical payload in RocksDB.
 */
export function splitPhysicalChunks(text, options = {}) {
  const source = requireWellFormedText(text);
  const normalized = normalizeChunkingOptions(options);
  const bytes = Buffer.from(source, "utf8");
  const chunks = [];
  const contentByChunkId = new Map();
  let startByte = 0;
  let ordinal = 0;

  // An empty source still has a canonical physical value and a manifest
  // occurrence, which keeps reconstruction and direct-document recall simple.
  do {
    const endByte = bytes.length === 0 ? 0 : preferredEnd(bytes, startByte, normalized);
    const contentBytes = bytes.subarray(startByte, endByte);
    const hash = contentHash(contentBytes);
    const chunkId = chunkIdForHash(hash);
    let content = contentByChunkId.get(chunkId);
    if (content === undefined) {
      content = contentBytes.toString("utf8");
      contentByChunkId.set(chunkId, content);
    }
    chunks.push(Object.freeze({
      chunkFormatVersion: CHUNK_FORMAT_VERSION,
      chunkId,
      contentHash: hash,
      ordinal,
      startByte,
      endByte,
      byteLength: contentBytes.length,
      encoding: "utf8",
      content,
    }));
    ordinal += 1;
    startByte = endByte;
  } while (startByte < bytes.length);

  assertChunkLayout(chunks, bytes.length);
  return Object.freeze(chunks);
}

/** Return one immutable physical payload per content hash, preserving first appearance order. */
export function uniquePhysicalChunks(chunks) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks must be an array.");
  const seen = new Map();
  for (const occurrence of chunks) {
    assertChunkOccurrence(occurrence);
    const existing = seen.get(occurrence.chunkId);
    const payload = physicalPayload(occurrence);
    if (existing) {
      if (existing.contentHash !== payload.contentHash || existing.content !== payload.content) {
        throw new ChunkIntegrityError(`Content address ${occurrence.chunkId} resolves to different bytes.`);
      }
      continue;
    }
    seen.set(occurrence.chunkId, payload);
  }
  return Object.freeze([...seen.values()]);
}

/** Strip payload bytes from physical occurrences for canonical manifests. */
export function createChunkReferences(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError("chunks must contain at least one physical occurrence.");
  }
  const references = chunks.map((occurrence) => {
    assertChunkOccurrence(occurrence);
    return Object.freeze({
      chunkId: occurrence.chunkId,
      ordinal: occurrence.ordinal,
      startByte: occurrence.startByte,
      endByte: occurrence.endByte,
      byteLength: occurrence.byteLength,
    });
  });
  assertChunkLayout(references, references.at(-1).endByte);
  return Object.freeze(references);
}

function assertChunkOccurrence(chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    throw new ChunkIntegrityError("A physical chunk occurrence must be an object.");
  }
  if (typeof chunk.chunkId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(chunk.chunkId)) {
    throw new ChunkIntegrityError("A physical chunk occurrence has an invalid chunkId.");
  }
  for (const field of ["ordinal", "startByte", "endByte", "byteLength"]) {
    if (!Number.isSafeInteger(chunk[field]) || chunk[field] < 0) {
      throw new ChunkIntegrityError(`A physical chunk occurrence has an invalid ${field}.`);
    }
  }
  if (chunk.endByte < chunk.startByte || chunk.byteLength !== chunk.endByte - chunk.startByte) {
    throw new ChunkIntegrityError("A physical chunk occurrence has inconsistent byte coordinates.");
  }
}

/** Verify that occurrences form one exact, ordered, non-overlapping byte range. */
export function assertChunkLayout(chunks, expectedByteLength) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new ChunkIntegrityError("A chunk layout must contain at least one occurrence.");
  }
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
    throw new TypeError("expectedByteLength must be a non-negative safe integer.");
  }
  let cursor = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    assertChunkOccurrence(chunk);
    if (chunk.ordinal !== index) {
      throw new ChunkIntegrityError(`Chunk ordinal ${chunk.ordinal} does not match position ${index}.`);
    }
    if (chunk.startByte !== cursor) {
      throw new ChunkIntegrityError(`Chunk ${index} begins at ${chunk.startByte}; expected ${cursor}.`);
    }
    cursor = chunk.endByte;
  }
  if (cursor !== expectedByteLength) {
    throw new ChunkIntegrityError(`Chunk layout ends at ${cursor}; expected ${expectedByteLength}.`);
  }
  if (expectedByteLength === 0 && chunks.length !== 1) {
    throw new ChunkIntegrityError("An empty source must have exactly one empty chunk occurrence.");
  }
  return true;
}

/** Reconstruct and verify bytes from ordered occurrences that include payload content. */
export function reconstructPhysicalChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError("chunks must contain at least one occurrence.");
  }
  assertChunkLayout(chunks, chunks.at(-1).endByte);
  const buffers = chunks.map((chunk) => {
    if (chunk.encoding !== "utf8" || typeof chunk.content !== "string") {
      throw new ChunkIntegrityError(`Chunk ${chunk.ordinal} does not contain UTF-8 text.`);
    }
    requireWellFormedText(chunk.content, `chunks[${chunk.ordinal}].content`);
    const bytes = Buffer.from(chunk.content, "utf8");
    if (bytes.length !== chunk.byteLength) {
      throw new ChunkIntegrityError(`Chunk ${chunk.ordinal} content length does not match its coordinates.`);
    }
    const hash = contentHash(bytes);
    if (chunk.contentHash !== undefined && chunk.contentHash !== hash) {
      throw new ChunkIntegrityError(`Chunk ${chunk.ordinal} content hash does not match its bytes.`);
    }
    if (chunk.chunkId !== chunkIdForHash(hash)) {
      throw new ChunkIntegrityError(`Chunk ${chunk.ordinal} content address does not match its bytes.`);
    }
    return bytes;
  });
  return Buffer.concat(buffers).toString("utf8");
}
