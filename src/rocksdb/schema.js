import { createHash, timingSafeEqual } from "node:crypto";

export const STORE_SCHEMA_NAME = "context-window-rocksdb";
export const STORE_SCHEMA_VERSION = 1;
export const RECORD_FORMAT_VERSION = 1;

const VALUE_MAGIC = Buffer.from("CWR1", "ascii");
const FIXED_HEADER_BYTES = VALUE_MAGIC.length + 2 + 2 + 2 + 1 + 4;
const CHECKSUM_BYTES = 32;
const ENCODING_JSON = 1;
const ENCODING_BYTES = 2;

export class SchemaCompatibilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SchemaCompatibilityError";
    this.code = "ERR_ROCKSDB_SCHEMA_INCOMPATIBLE";
    this.details = details;
  }
}

function canonicalize(value, seen, arrayElement = false) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Record payload numbers must be finite.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) return arrayElement ? null : undefined;
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported record payload type: ${typeof value}.`);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new TypeError("Nested binary values are unsupported; store a Buffer as the complete payload.");
  }
  if (seen.has(value)) throw new TypeError("Record payloads must not contain cycles.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, seen, true));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Record payload objects must be plain objects.");
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = canonicalize(value[key], seen);
      if (entry !== undefined) result[key] = entry;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function stableJson(value) {
  const canonical = canonicalize(value, new Set());
  if (canonical === undefined) throw new TypeError("A record payload cannot be undefined.");
  return JSON.stringify(canonical);
}

function uint16(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new TypeError(`${label} must be an unsigned 16-bit integer.`);
  }
  return value;
}

/** Encode a checksummed, self-describing value envelope. */
export function encodeRecord({ kind, payload, recordVersion = 1, schemaVersion = STORE_SCHEMA_VERSION }) {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError("Record kind must be a non-empty string.");
  }
  const kindBytes = Buffer.from(kind, "utf8");
  uint16(kindBytes.length, "Record kind byte length");
  uint16(recordVersion, "Record version");
  uint16(schemaVersion, "Schema version");

  const binary = Buffer.isBuffer(payload) || payload instanceof Uint8Array;
  const serialized = binary ? undefined : stableJson(payload);
  const sourceBytes = binary
    ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    : undefined;
  const payloadLength = binary
    ? sourceBytes.length
    : Buffer.byteLength(serialized, "utf8");
  if (payloadLength > 0xffff_ffff) throw new TypeError("Record payload exceeds 4 GiB.");

  const contentLength = FIXED_HEADER_BYTES + kindBytes.length + payloadLength;
  const output = Buffer.allocUnsafe(contentLength + CHECKSUM_BYTES);
  VALUE_MAGIC.copy(output, 0);
  let offset = VALUE_MAGIC.length;
  output.writeUInt16BE(schemaVersion, offset);
  offset += 2;
  output.writeUInt16BE(recordVersion, offset);
  offset += 2;
  output.writeUInt16BE(kindBytes.length, offset);
  offset += 2;
  output[offset] = binary ? ENCODING_BYTES : ENCODING_JSON;
  offset += 1;
  output.writeUInt32BE(payloadLength, offset);
  offset += 4;
  kindBytes.copy(output, offset);
  offset += kindBytes.length;
  if (binary) sourceBytes.copy(output, offset);
  else output.write(serialized, offset, payloadLength, "utf8");

  const checksum = createHash("sha256")
    .update(output.subarray(0, contentLength))
    .digest();
  checksum.copy(output, contentLength);
  return output;
}

function corrupt(message) {
  const error = new Error(message);
  error.name = "CorruptRecordError";
  error.code = "ERR_ROCKSDB_CORRUPT_RECORD";
  return error;
}

/** Decode and verify a value produced by {@link encodeRecord}. */
export function decodeRecord(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw corrupt("Stored record is not binary data.");
  }
  const bytes = Buffer.from(value);
  if (bytes.length < FIXED_HEADER_BYTES + CHECKSUM_BYTES) throw corrupt("Stored record is truncated.");
  if (!bytes.subarray(0, VALUE_MAGIC.length).equals(VALUE_MAGIC)) {
    throw corrupt("Stored record has an unknown value format.");
  }

  let offset = VALUE_MAGIC.length;
  const schemaVersion = bytes.readUInt16BE(offset);
  offset += 2;
  const recordVersion = bytes.readUInt16BE(offset);
  offset += 2;
  const kindLength = bytes.readUInt16BE(offset);
  offset += 2;
  const encodingTag = bytes[offset];
  offset += 1;
  const payloadLength = bytes.readUInt32BE(offset);
  offset += 4;
  const contentLength = FIXED_HEADER_BYTES + kindLength + payloadLength;
  if (bytes.length !== contentLength + CHECKSUM_BYTES) throw corrupt("Stored record length does not match its header.");

  const expected = createHash("sha256").update(bytes.subarray(0, contentLength)).digest();
  const actual = bytes.subarray(contentLength);
  if (!timingSafeEqual(actual, expected)) throw corrupt("Stored record checksum does not match its contents.");

  const kind = bytes.subarray(offset, offset + kindLength).toString("utf8");
  offset += kindLength;
  const payloadBytes = bytes.subarray(offset, offset + payloadLength);
  let payload;
  let encoding;
  if (encodingTag === ENCODING_BYTES) {
    encoding = "bytes";
    payload = Buffer.from(payloadBytes);
  } else if (encodingTag === ENCODING_JSON) {
    encoding = "json";
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
    } catch (error) {
      throw corrupt(`Stored JSON record cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw corrupt(`Stored record uses unknown payload encoding ${encodingTag}.`);
  }

  return {
    schemaVersion,
    recordVersion,
    kind,
    encoding,
    payload,
    checksum: actual.toString("hex"),
  };
}

export const CURRENT_SCHEMA = Object.freeze({
  name: STORE_SCHEMA_NAME,
  schemaVersion: STORE_SCHEMA_VERSION,
  minimumReaderVersion: STORE_SCHEMA_VERSION,
  keyFormatVersion: 1,
  recordFormatVersion: RECORD_FORMAT_VERSION,
});

export const SCHEMA_FINGERPRINT = createHash("sha256")
  .update(stableJson(CURRENT_SCHEMA))
  .digest("hex");

export function schemaMetadata(createdAt = Date.now()) {
  return {
    ...CURRENT_SCHEMA,
    fingerprint: SCHEMA_FINGERPRINT,
    createdAt,
  };
}

export function assertSchemaCompatible(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new SchemaCompatibilityError("RocksDB schema metadata is missing or malformed.");
  }
  if (metadata.name !== STORE_SCHEMA_NAME) {
    throw new SchemaCompatibilityError(`RocksDB schema name ${String(metadata.name)} is not supported.`, {
      expected: STORE_SCHEMA_NAME,
      actual: metadata.name,
    });
  }
  if (metadata.schemaVersion !== STORE_SCHEMA_VERSION
    || metadata.minimumReaderVersion > STORE_SCHEMA_VERSION
    || metadata.keyFormatVersion !== CURRENT_SCHEMA.keyFormatVersion
    || metadata.recordFormatVersion !== CURRENT_SCHEMA.recordFormatVersion
    || metadata.fingerprint !== SCHEMA_FINGERPRINT) {
    throw new SchemaCompatibilityError(
      `RocksDB schema version ${String(metadata.schemaVersion)} is incompatible with reader ${STORE_SCHEMA_VERSION}.`,
      { expected: CURRENT_SCHEMA, actual: metadata },
    );
  }
  return metadata;
}
