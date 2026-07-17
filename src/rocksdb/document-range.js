import { TextDecoder } from "node:util";
import { contentHash } from "./chunks.js";
import { manifestKeys } from "./manifests.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function boundary(bytes, offset) {
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function referencesForRange(manifest, startByte, endByte) {
  return manifest.chunks.filter((reference) => startByte === endByte
    ? reference.startByte === startByte && reference.endByte === endByte
    : reference.startByte < endByte && reference.endByte > startByte);
}

async function physicalBytes(view, reference, cache) {
  if (!Number.isSafeInteger(reference.ordinal) || reference.ordinal < 0
    || !Number.isSafeInteger(reference.startByte) || reference.startByte < 0
    || !Number.isSafeInteger(reference.endByte) || reference.endByte < reference.startByte
    || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0
    || reference.byteLength !== reference.endByte - reference.startByte) {
    throw new Error("Canonical source chunk reference has inconsistent coordinates.");
  }
  let bytes = cache.get(reference.chunkId);
  if (bytes === undefined) {
    const chunk = await view.get(manifestKeys.chunk(reference.chunkId));
    if (!chunk || chunk.encoding !== "utf8" || typeof chunk.content !== "string") {
      throw new Error(`Canonical source chunk ${reference.chunkId} is missing or malformed.`);
    }
    bytes = Buffer.from(chunk.content, "utf8");
    const hash = contentHash(bytes);
    if (chunk.byteLength !== bytes.length
      || chunk.contentHash !== hash
      || reference.chunkId !== `sha256:${hash}`) {
      throw new Error(`Canonical source chunk ${reference.chunkId} failed integrity validation.`);
    }
    cache.set(reference.chunkId, bytes);
  }
  // A content-addressed physical value may occur more than once. Validate the
  // coordinates of every occurrence even when its bytes came from the cache.
  if (bytes.length !== reference.byteLength) {
    throw new Error(`Canonical source chunk ${reference.chunkId} failed integrity validation.`);
  }
  return bytes;
}

/**
 * Read only physical chunks intersecting one canonical UTF-8 byte range.
 * `adjustUtf8` moves caller-selected interior offsets inward to scalar
 * boundaries and returns the resulting exact coordinates.
 */
export async function readDocumentRange(
  view,
  manifest,
  startByte,
  endByte,
  { adjustUtf8 = false } = {},
) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("readDocumentRange requires a readable store view.");
  }
  nonNegativeInteger(startByte, "startByte");
  nonNegativeInteger(endByte, "endByte");
  if (!manifest || !Array.isArray(manifest.chunks)
    || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0) {
    throw new TypeError("readDocumentRange requires a canonical document manifest.");
  }
  if (endByte < startByte || endByte > manifest.byteLength) {
    throw new RangeError("Canonical source range is outside its document manifest.");
  }
  const references = referencesForRange(manifest, startByte, endByte);
  if (references.length === 0) {
    if (startByte === endByte) {
      return Object.freeze({
        startByte,
        endByte,
        text: "",
        chunks: Object.freeze([]),
      });
    }
    throw new Error("Canonical source range has no intersecting physical chunks.");
  }
  if (references[0].startByte > startByte || references.at(-1).endByte < endByte) {
    throw new Error("Canonical source range is not fully covered by physical chunks.");
  }

  const cache = new Map();
  const occurrenceBytes = [];
  const firstReferenceIndex = manifest.chunks.indexOf(references[0]);
  let expectedStart = references[0].startByte;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (reference.ordinal !== firstReferenceIndex + index) {
      throw new Error("Canonical source range has an inconsistent chunk ordinal.");
    }
    if (reference.startByte !== expectedStart) {
      throw new Error("Canonical source range has a chunk gap.");
    }
    const bytes = await physicalBytes(view, reference, cache);
    occurrenceBytes.push(bytes);
    expectedStart = reference.endByte;
  }
  const allBytes = Buffer.concat(occurrenceBytes);
  const baseByte = references[0].startByte;
  let localStart = startByte - baseByte;
  let localEnd = endByte - baseByte;
  if (adjustUtf8) {
    while (localStart < localEnd && !boundary(allBytes, localStart)) localStart += 1;
    while (localEnd > localStart && !boundary(allBytes, localEnd)) localEnd -= 1;
  } else if (!boundary(allBytes, localStart) || !boundary(allBytes, localEnd)) {
    throw new RangeError("Canonical source range splits a UTF-8 scalar.");
  }
  const resolvedStart = baseByte + localStart;
  const resolvedEnd = baseByte + localEnd;
  const selectedBytes = allBytes.subarray(localStart, localEnd);
  const text = UTF8_DECODER.decode(selectedBytes);
  const chunks = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const selectedStart = Math.max(resolvedStart, reference.startByte);
    const selectedEnd = Math.min(resolvedEnd, reference.endByte);
    if (selectedEnd < selectedStart
      || (selectedEnd === selectedStart && resolvedStart !== resolvedEnd)) continue;
    const bytes = occurrenceBytes[index];
    const localChunkStart = selectedStart - reference.startByte;
    const localChunkEnd = selectedEnd - reference.startByte;
    chunks.push(Object.freeze({
      chunkId: reference.chunkId,
      ordinal: reference.ordinal,
      startByte: selectedStart,
      endByte: selectedEnd,
      text: UTF8_DECODER.decode(bytes.subarray(localChunkStart, localChunkEnd)),
    }));
  }
  if (chunks.map(({ text: chunkText }) => chunkText).join("") !== text) {
    throw new Error("Canonical range chunks do not reproduce their selected source bytes.");
  }
  return Object.freeze({
    startByte: resolvedStart,
    endByte: resolvedEnd,
    text,
    chunks: Object.freeze(chunks),
  });
}
