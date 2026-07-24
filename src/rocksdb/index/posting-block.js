import { deserialize, serialize } from "node:v8";

const MAGIC = Buffer.from("CWPBLK01", "ascii");
const FORMAT_VERSION = 1;
const TYPE_BM25 = 1;
const TYPE_EXACT = 2;
const HEADER_BYTES = MAGIC.length + 2;
const MAX_COLLECTION_ITEMS = 100_000;
const MAX_STRING_BYTES = 16 * 1_024 * 1_024;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw new TypeError(`${label} is too large.`);
  }
  return value;
}

function nullableString(value, label) {
  return value === null || value === undefined ? null : string(value, label);
}

function strings(values, label) {
  if (!Array.isArray(values) || values.length > MAX_COLLECTION_ITEMS) {
    throw new TypeError(`${label} must be a bounded array.`);
  }
  return values.map((value, index) => string(value, `${label}[${index}]`));
}

function encodeBlock(type, fields) {
  return Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION, type]),
    serialize(fields),
  ]);
}

function decodeBlock(value, expectedType, expectedFields) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("Posting block must be bytes.");
  }
  const bytes = Buffer.from(value);
  if (bytes.length <= HEADER_BYTES
    || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TypeError("Posting block has an unknown format.");
  }
  if (bytes[MAGIC.length] !== FORMAT_VERSION) {
    throw new TypeError(`Posting block version ${bytes[MAGIC.length]} is unsupported.`);
  }
  if (bytes[MAGIC.length + 1] !== expectedType) {
    throw new TypeError("Posting block type does not match its index.");
  }
  let fields;
  try {
    fields = deserialize(bytes.subarray(HEADER_BYTES));
  } catch {
    throw new TypeError("Posting block payload is malformed.");
  }
  if (!Array.isArray(fields) || fields.length !== expectedFields) {
    throw new TypeError("Posting block field layout is malformed.");
  }
  return fields;
}

export function isPostingBlock(value) {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array)
    && value.length >= MAGIC.length
    && Buffer.from(value).subarray(0, MAGIC.length).equals(MAGIC);
}

export function encodeBm25PostingBlock(value) {
  const posting = requireObject(value, "BM25 posting");
  const window = requireObject(posting.window, "BM25 posting window");
  if (window.positionsEncoding !== "delta-v1"
    || !Array.isArray(window.positionDeltas)
    || window.positionDeltas.length > MAX_COLLECTION_ITEMS * 3) {
    throw new TypeError("BM25 posting positions must use bounded delta-v1 values.");
  }
  return encodeBlock(TYPE_BM25, [
    nonNegativeInteger(posting.bm25PostingVersion, "bm25PostingVersion"),
    nonNegativeInteger(posting.tokenizerVersion, "tokenizerVersion"),
    nonNegativeInteger(posting.generation, "generation"),
    nonNegativeInteger(posting.documentVersion, "documentVersion"),
    nonNegativeInteger(posting.createdAt, "createdAt"),
    nonNegativeInteger(posting.bucket, "bucket"),
    string(posting.project, "project"),
    string(posting.term, "term"),
    string(posting.documentId, "documentId"),
    string(posting.kind, "kind"),
    string(posting.sessionId, "sessionId"),
    strings(posting.sourceMessageKeys, "sourceMessageKeys"),
    nullableString(posting.turnId, "turnId"),
    nonNegativeInteger(window.ordinal, "window.ordinal"),
    nonNegativeInteger(window.startByte, "window.startByte"),
    nonNegativeInteger(window.endByte, "window.endByte"),
    nonNegativeInteger(window.length, "window.length"),
    finite(window.weightedLength, "window.weightedLength"),
    nonNegativeInteger(window.termFrequency, "window.termFrequency"),
    finite(window.weightedTermFrequency, "window.weightedTermFrequency"),
    window.positionDeltas.map((delta, index) =>
      nonNegativeInteger(delta, `window.positionDeltas[${index}]`)),
  ]);
}

export function decodeBm25PostingBlock(value) {
  const fields = decodeBlock(value, TYPE_BM25, 21);
  const [
    rawPostingVersion,
    rawTokenizerVersion,
    rawGeneration,
    rawDocumentVersion,
    rawCreatedAt,
    rawBucket,
    rawProject,
    rawTerm,
    rawDocumentId,
    rawKind,
    rawSessionId,
    rawSourceMessageKeys,
    rawTurnId,
    rawOrdinal,
    rawStartByte,
    rawEndByte,
    rawLength,
    rawWeightedLength,
    rawTermFrequency,
    rawWeightedTermFrequency,
    rawPositionDeltas,
  ] = fields;
  if (!Array.isArray(rawPositionDeltas)
    || rawPositionDeltas.length > MAX_COLLECTION_ITEMS * 3) {
    throw new TypeError("BM25 posting deltas are too large.");
  }
  return Object.freeze({
    bm25PostingVersion: nonNegativeInteger(rawPostingVersion, "bm25PostingVersion"),
    tokenizerVersion: nonNegativeInteger(rawTokenizerVersion, "tokenizerVersion"),
    generation: nonNegativeInteger(rawGeneration, "generation"),
    project: string(rawProject, "project"),
    term: string(rawTerm, "term"),
    documentId: string(rawDocumentId, "documentId"),
    documentVersion: nonNegativeInteger(rawDocumentVersion, "documentVersion"),
    kind: string(rawKind, "kind"),
    createdAt: nonNegativeInteger(rawCreatedAt, "createdAt"),
    bucket: nonNegativeInteger(rawBucket, "bucket"),
    sessionId: string(rawSessionId, "sessionId"),
    sourceMessageKeys: Object.freeze(strings(rawSourceMessageKeys, "sourceMessageKeys")),
    turnId: nullableString(rawTurnId, "turnId"),
    window: Object.freeze({
      ordinal: nonNegativeInteger(rawOrdinal, "window.ordinal"),
      startByte: nonNegativeInteger(rawStartByte, "window.startByte"),
      endByte: nonNegativeInteger(rawEndByte, "window.endByte"),
      length: nonNegativeInteger(rawLength, "window.length"),
      weightedLength: finite(rawWeightedLength, "window.weightedLength"),
      termFrequency: nonNegativeInteger(rawTermFrequency, "window.termFrequency"),
      weightedTermFrequency: finite(
        rawWeightedTermFrequency,
        "window.weightedTermFrequency",
      ),
      positionsEncoding: "delta-v1",
      positionDeltas: Object.freeze(rawPositionDeltas.map((delta, index) =>
        nonNegativeInteger(delta, `window.positionDeltas[${index}]`))),
    }),
  });
}

export function encodeExactPostingBlock(value) {
  const posting = requireObject(value, "exact posting");
  if (!Array.isArray(posting.matches) || posting.matches.length > MAX_COLLECTION_ITEMS) {
    throw new TypeError("Exact posting matches must be a bounded array.");
  }
  return encodeBlock(TYPE_EXACT, [
    nonNegativeInteger(posting.postingVersion, "postingVersion"),
    nonNegativeInteger(posting.generation, "generation"),
    nonNegativeInteger(posting.sourceVersion, "sourceVersion"),
    nonNegativeInteger(posting.bucket, "bucket"),
    nonNegativeInteger(posting.createdAt, "createdAt"),
    nonNegativeInteger(posting.documentVersion, "documentVersion"),
    nonNegativeInteger(posting.windowOrdinal, "windowOrdinal"),
    nonNegativeInteger(posting.windowStartByte, "windowStartByte"),
    nonNegativeInteger(posting.windowEndByte, "windowEndByte"),
    string(posting.project, "project"),
    string(posting.sessionId, "sessionId"),
    string(posting.documentId, "documentId"),
    string(posting.documentKind, "documentKind"),
    string(posting.sourceKey, "sourceKey"),
    nullableString(posting.sourceKeyStatus, "sourceKeyStatus"),
    strings(posting.sourceMessageKeys, "sourceMessageKeys"),
    nullableString(posting.turnId, "turnId"),
    string(posting.caseMode, "caseMode"),
    string(posting.normalizedTerm, "normalizedTerm"),
    posting.matches.map((candidate, index) => {
      const match = requireObject(candidate, `matches[${index}]`);
      return [
        string(match.type, `matches[${index}].type`),
        string(match.value, `matches[${index}].value`),
        nonNegativeInteger(match.startByte, `matches[${index}].startByte`),
        nonNegativeInteger(match.endByte, `matches[${index}].endByte`),
        finite(match.specificity, `matches[${index}].specificity`),
      ];
    }),
  ]);
}

export function decodeExactPostingBlock(value) {
  const fields = decodeBlock(value, TYPE_EXACT, 20);
  const [
    rawPostingVersion,
    rawGeneration,
    rawSourceVersion,
    rawBucket,
    rawCreatedAt,
    rawDocumentVersion,
    rawWindowOrdinal,
    rawWindowStartByte,
    rawWindowEndByte,
    rawProject,
    rawSessionId,
    rawDocumentId,
    rawDocumentKind,
    rawSourceKey,
    rawSourceKeyStatus,
    rawSourceMessageKeys,
    rawTurnId,
    rawCaseMode,
    rawNormalizedTerm,
    rawMatches,
  ] = fields;
  if (!Array.isArray(rawMatches) || rawMatches.length > MAX_COLLECTION_ITEMS) {
    throw new TypeError("Exact posting matches must be a bounded array.");
  }
  const matches = rawMatches.map((candidate, index) => {
    if (!Array.isArray(candidate) || candidate.length !== 5) {
      throw new TypeError(`matches[${index}] has a malformed field layout.`);
    }
    return Object.freeze({
      type: string(candidate[0], `matches[${index}].type`),
      value: string(candidate[1], `matches[${index}].value`),
      startByte: nonNegativeInteger(candidate[2], `matches[${index}].startByte`),
      endByte: nonNegativeInteger(candidate[3], `matches[${index}].endByte`),
      specificity: finite(candidate[4], `matches[${index}].specificity`),
    });
  });
  return Object.freeze({
    postingVersion: nonNegativeInteger(rawPostingVersion, "postingVersion"),
    generation: nonNegativeInteger(rawGeneration, "generation"),
    sourceVersion: nonNegativeInteger(rawSourceVersion, "sourceVersion"),
    project: string(rawProject, "project"),
    sessionId: string(rawSessionId, "sessionId"),
    bucket: nonNegativeInteger(rawBucket, "bucket"),
    createdAt: nonNegativeInteger(rawCreatedAt, "createdAt"),
    documentId: string(rawDocumentId, "documentId"),
    documentVersion: nonNegativeInteger(rawDocumentVersion, "documentVersion"),
    documentKind: string(rawDocumentKind, "documentKind"),
    sourceKey: string(rawSourceKey, "sourceKey"),
    sourceKeyStatus: nullableString(rawSourceKeyStatus, "sourceKeyStatus"),
    sourceMessageKeys: Object.freeze(strings(rawSourceMessageKeys, "sourceMessageKeys")),
    turnId: nullableString(rawTurnId, "turnId"),
    windowOrdinal: nonNegativeInteger(rawWindowOrdinal, "windowOrdinal"),
    windowStartByte: nonNegativeInteger(rawWindowStartByte, "windowStartByte"),
    windowEndByte: nonNegativeInteger(rawWindowEndByte, "windowEndByte"),
    caseMode: string(rawCaseMode, "caseMode"),
    normalizedTerm: string(rawNormalizedTerm, "normalizedTerm"),
    matches: Object.freeze(matches),
  });
}
