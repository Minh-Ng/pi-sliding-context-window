const MAGIC = Buffer.from("CWSEMETA", "ascii");
const FORMAT_VERSION = 1;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export const SEMANTIC_METADATA_FILENAME = "metadata.bin";
export const LEGACY_SEMANTIC_METADATA_FILENAME = "metadata.json";
export const SEMANTIC_METADATA_MAGIC = MAGIC.toString("ascii");
export const SEMANTIC_METADATA_FORMAT_VERSION = FORMAT_VERSION;

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function uint64(value, label) {
  let integer;
  try {
    integer = BigInt(value);
  } catch {
    throw new TypeError(`${label} must be an unsigned 64-bit integer.`);
  }
  if (integer <= 0n || integer > MAX_UINT64) {
    throw new TypeError(`${label} must be a positive unsigned 64-bit integer.`);
  }
  return integer;
}

function documentIdentity(documentId, version) {
  return `${documentId}\0${version}`;
}

function compactEntry(entry, label = "entry") {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const startByte = nonNegativeInteger(entry.startByte, `${label}.startByte`);
  const endByte = nonNegativeInteger(entry.endByte, `${label}.endByte`);
  if (endByte < startByte) throw new TypeError(`${label}.endByte must not precede startByte.`);
  return Object.freeze({
    label: uint64(entry.label, `${label}.label`).toString(),
    documentId: nonEmptyString(entry.documentId, `${label}.documentId`),
    version: positiveInteger(entry.version, `${label}.version`),
    windowOrdinal: nonNegativeInteger(entry.windowOrdinal, `${label}.windowOrdinal`),
    startByte,
    endByte,
  });
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Semantic metadata entries must be an array.");
  const labels = new Set();
  const normalized = entries.map((entry, index) => {
    const result = compactEntry(entry, `entries[${index}]`);
    if (labels.has(result.label)) throw new TypeError(`Duplicate semantic label ${result.label}.`);
    labels.add(result.label);
    return result;
  });
  normalized.sort((left, right) => {
    const leftLabel = BigInt(left.label);
    const rightLabel = BigInt(right.label);
    return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
  });
  return Object.freeze(normalized);
}

function expectedSnapshot(snapshot, expected) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Semantic metadata snapshot must be an object.");
  }
  const fingerprint = nonEmptyString(snapshot.fingerprint, "fingerprint");
  const project = nonEmptyString(snapshot.project, "project");
  const dimensions = positiveInteger(snapshot.dimensions, "dimensions");
  if (dimensions > MAX_UINT32) {
    throw new TypeError("dimensions must fit in an unsigned 32-bit integer.");
  }
  if (expected?.fingerprint !== undefined && fingerprint !== expected.fingerprint) {
    throw new TypeError("Semantic metadata fingerprint does not match the configured index.");
  }
  if (expected?.project !== undefined && project !== expected.project) {
    throw new TypeError("Semantic metadata project does not match the configured index.");
  }
  if (expected?.dimensions !== undefined && dimensions !== expected.dimensions) {
    throw new TypeError("Semantic metadata dimensions do not match the configured index.");
  }
  return { fingerprint, project, dimensions };
}

function snapshotResult(header, entries) {
  const documents = new Set(entries.map((entry) =>
    documentIdentity(entry.documentId, entry.version)));
  return Object.freeze({
    ...header,
    entries,
    documents: Object.freeze([...documents]),
  });
}

export function normalizeLegacySemanticMetadata(snapshot, expected = {}) {
  if (snapshot?.formatVersion !== 1) {
    throw new TypeError("Unsupported legacy semantic metadata format.");
  }
  const header = expectedSnapshot(snapshot, expected);
  return snapshotResult(header, normalizeEntries(snapshot.entries));
}

function varUintLength(value) {
  let integer = BigInt(nonNegativeInteger(value, "varuint"));
  let bytes = 1;
  while (integer >= 0x80n) {
    integer >>= 7n;
    bytes += 1;
  }
  return bytes;
}

function stringField(value, label) {
  const bytes = Buffer.from(nonEmptyString(value, label), "utf8");
  return Object.freeze({ bytes, byteLength: varUintLength(bytes.length) + bytes.length });
}

function prepareSnapshot(snapshot) {
  const header = expectedSnapshot(snapshot);
  const entries = normalizeEntries(snapshot.entries);
  const documentByIdentity = new Map();
  for (const entry of entries) {
    const identity = documentIdentity(entry.documentId, entry.version);
    if (!documentByIdentity.has(identity)) {
      documentByIdentity.set(identity, {
        documentId: entry.documentId,
        version: entry.version,
      });
    }
  }
  const documents = [...documentByIdentity.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.documentId, "utf8"), Buffer.from(right.documentId, "utf8"))
      || left.version - right.version);
  const documentIndexes = new Map(documents.map((document, index) => [
    documentIdentity(document.documentId, document.version),
    index,
  ]));
  const fingerprint = stringField(header.fingerprint, "fingerprint");
  const project = stringField(header.project, "project");
  const preparedDocuments = documents.map((document, index) => {
    const documentId = stringField(document.documentId, `documents[${index}].documentId`);
    return Object.freeze({
      ...document,
      documentIdBytes: documentId.bytes,
      byteLength: documentId.byteLength + varUintLength(document.version),
    });
  });
  const preparedEntries = entries.map((entry) => Object.freeze({
    ...entry,
    labelValue: BigInt(entry.label),
    documentIndex: documentIndexes.get(documentIdentity(entry.documentId, entry.version)),
  }));
  const byteLength = MAGIC.length
    + 4
    + 4
    + fingerprint.byteLength
    + project.byteLength
    + varUintLength(preparedDocuments.length)
    + preparedDocuments.reduce((total, document) => total + document.byteLength, 0)
    + varUintLength(preparedEntries.length)
    + preparedEntries.reduce((total, entry) =>
      total
      + 8
      + varUintLength(entry.documentIndex)
      + varUintLength(entry.windowOrdinal)
      + varUintLength(entry.startByte)
      + varUintLength(entry.endByte), 0);
  return {
    ...header,
    entries: preparedEntries,
    documents: preparedDocuments,
    fingerprintBytes: fingerprint.bytes,
    projectBytes: project.bytes,
    byteLength,
  };
}

class Writer {
  constructor(byteLength) {
    this.buffer = Buffer.allocUnsafe(byteLength);
    this.offset = 0;
  }

  bytes(value) {
    value.copy(this.buffer, this.offset);
    this.offset += value.length;
  }

  uint32(value) {
    this.buffer.writeUInt32BE(value, this.offset);
    this.offset += 4;
  }

  uint64(value) {
    this.buffer.writeBigUInt64BE(value, this.offset);
    this.offset += 8;
  }

  varUint(value) {
    let integer = BigInt(nonNegativeInteger(value, "varuint"));
    do {
      let byte = Number(integer & 0x7fn);
      integer >>= 7n;
      if (integer > 0n) byte |= 0x80;
      this.buffer[this.offset] = byte;
      this.offset += 1;
    } while (integer > 0n);
  }

  string(bytes) {
    this.varUint(bytes.length);
    this.bytes(bytes);
  }
}

export function encodeSemanticMetadata(snapshot) {
  const prepared = prepareSnapshot(snapshot);
  const writer = new Writer(prepared.byteLength);
  writer.bytes(MAGIC);
  writer.uint32(FORMAT_VERSION);
  writer.uint32(prepared.dimensions);
  writer.string(prepared.fingerprintBytes);
  writer.string(prepared.projectBytes);
  writer.varUint(prepared.documents.length);
  for (const document of prepared.documents) {
    writer.string(document.documentIdBytes);
    writer.varUint(document.version);
  }
  writer.varUint(prepared.entries.length);
  for (const entry of prepared.entries) {
    writer.uint64(entry.labelValue);
    writer.varUint(entry.documentIndex);
    writer.varUint(entry.windowOrdinal);
    writer.varUint(entry.startByte);
    writer.varUint(entry.endByte);
  }
  if (writer.offset !== prepared.byteLength) {
    throw new Error("Semantic metadata byte-length calculation is inconsistent.");
  }
  return writer.buffer;
}

class Reader {
  constructor(value) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError("Semantic metadata must be bytes.");
    }
    this.buffer = Buffer.from(value);
    this.offset = 0;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
      throw new TypeError("Semantic metadata is truncated.");
    }
    const result = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  uint32() {
    if (this.remaining() < 4) throw new TypeError("Semantic metadata is truncated.");
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  uint64() {
    if (this.remaining() < 8) throw new TypeError("Semantic metadata is truncated.");
    const value = this.buffer.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  varUint() {
    let value = 0n;
    let shift = 0n;
    for (let index = 0; index < 8; index += 1) {
      if (this.remaining() === 0) throw new TypeError("Semantic metadata varuint is truncated.");
      const byte = this.buffer[this.offset];
      this.offset += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (value > MAX_SAFE_BIGINT) {
          throw new TypeError("Semantic metadata varuint exceeds JavaScript's safe integer range.");
        }
        return Number(value);
      }
      shift += 7n;
    }
    throw new TypeError("Semantic metadata varuint is malformed.");
  }

  string(label) {
    const length = this.varUint();
    const value = this.bytes(length).toString("utf8");
    return nonEmptyString(value, label);
  }
}

export function decodeSemanticMetadata(value, expected = {}) {
  const reader = new Reader(value);
  if (!reader.bytes(MAGIC.length).equals(MAGIC)) {
    throw new TypeError("Semantic metadata magic is invalid.");
  }
  if (reader.uint32() !== FORMAT_VERSION) {
    throw new TypeError("Unsupported semantic metadata format.");
  }
  const dimensions = reader.uint32();
  const fingerprint = reader.string("fingerprint");
  const project = reader.string("project");
  const header = expectedSnapshot({ dimensions, fingerprint, project }, expected);
  const documentCount = reader.varUint();
  const documents = [];
  for (let index = 0; index < documentCount; index += 1) {
    documents.push(Object.freeze({
      documentId: reader.string(`documents[${index}].documentId`),
      version: positiveInteger(reader.varUint(), `documents[${index}].version`),
    }));
  }
  const entryCount = reader.varUint();
  const entries = [];
  const labels = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    const label = reader.uint64();
    if (label === 0n) throw new TypeError("Semantic metadata labels must be positive.");
    const documentIndex = reader.varUint();
    const document = documents[documentIndex];
    if (document === undefined) throw new TypeError("Semantic metadata document index is invalid.");
    const entry = compactEntry({
      label: label.toString(),
      documentId: document.documentId,
      version: document.version,
      windowOrdinal: reader.varUint(),
      startByte: reader.varUint(),
      endByte: reader.varUint(),
    }, `entries[${index}]`);
    if (labels.has(entry.label)) throw new TypeError(`Duplicate semantic label ${entry.label}.`);
    labels.add(entry.label);
    entries.push(entry);
  }
  if (reader.remaining() !== 0) throw new TypeError("Semantic metadata has trailing bytes.");
  return snapshotResult(header, Object.freeze(entries));
}
