const KEY_FORMAT_VERSION = 1;
const MAX_KEY_BYTES = 1024 * 1024;

const FIELD = Object.freeze({
  STRING: 0x10,
  BYTES: 0x11,
  UNSIGNED_INTEGER: 0x12,
  FALSE: 0x13,
  TRUE: 0x14,
  NULL: 0x15,
});

export const KEY_VERSION = KEY_FORMAT_VERSION;

export const KEYSPACE = Object.freeze({
  CHUNK: "chunk",
  CHUNK_REFERENCE: "chunk-reference",
  COUNTER: "counter",
  DERIVED: "derived",
  DOCUMENT: "document",
  EVENT: "event",
  EVENT_REFERENCE: "event-reference",
  EXACT: "exact",
  EXPIRY: "expiry",
  IDEMPOTENCY: "idempotency",
  LEASE: "lease",
  META: "meta",
  OUTBOX: "outbox",
  POSTING: "posting",
  RELATION: "relation",
  SUPERSESSION: "supersession",
  WINDOW: "window",
});

function invalidKey(message) {
  const error = new TypeError(message);
  error.code = "ERR_ROCKSDB_KEY";
  return error;
}

function lengthPrefix(length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw invalidKey(`Key field length ${length} is outside the uint32 range.`);
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

function integerBytes(value) {
  const integer = typeof value === "bigint" ? value : BigInt(value);
  if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn) {
    throw invalidKey("Integer key fields must fit in an unsigned 64-bit integer.");
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(integer);
  return buffer;
}

function encodeField(value) {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([FIELD.STRING]), lengthPrefix(bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([FIELD.BYTES]), lengthPrefix(bytes.length), bytes]);
  }
  if ((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "bigint") {
    return Buffer.concat([Buffer.from([FIELD.UNSIGNED_INTEGER]), integerBytes(value)]);
  }
  if (value === false) return Buffer.from([FIELD.FALSE]);
  if (value === true) return Buffer.from([FIELD.TRUE]);
  if (value === null) return Buffer.from([FIELD.NULL]);
  throw invalidKey(`Unsupported key field type: ${typeof value}.`);
}

function normalizeParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw invalidKey("A key must contain at least one field.");
  }
  return parts;
}

/**
 * Encode a key as a versioned binary tuple. Length-delimited fields make NUL,
 * slash, Unicode, and other delimiter-like bytes unambiguous.
 */
export function encodeKey(parts) {
  const fields = normalizeParts(parts).map(encodeField);
  const key = Buffer.concat([Buffer.from([KEY_FORMAT_VERSION]), ...fields]);
  if (key.length > MAX_KEY_BYTES) {
    throw invalidKey(`Encoded key is ${key.length} bytes; the maximum is ${MAX_KEY_BYTES}.`);
  }
  return key;
}

function requireBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw invalidKey("Encoded keys must be Buffers or Uint8Arrays.");
  }
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes[0] !== KEY_FORMAT_VERSION) {
    throw invalidKey(`Unsupported key format version ${bytes[0] ?? "empty"}.`);
  }
  return bytes;
}

function readLength(bytes, offset) {
  if (offset + 4 > bytes.length) throw invalidKey("Truncated key field length.");
  return bytes.readUInt32BE(offset);
}

/** Decode a key produced by {@link encodeKey}. */
export function decodeKey(value) {
  const bytes = requireBytes(value);
  const parts = [];
  let offset = 1;
  while (offset < bytes.length) {
    const type = bytes[offset];
    offset += 1;
    if (type === FIELD.STRING || type === FIELD.BYTES) {
      const length = readLength(bytes, offset);
      offset += 4;
      const end = offset + length;
      if (end > bytes.length) throw invalidKey("Truncated length-delimited key field.");
      const field = bytes.subarray(offset, end);
      parts.push(type === FIELD.STRING ? field.toString("utf8") : Buffer.from(field));
      offset = end;
      continue;
    }
    if (type === FIELD.UNSIGNED_INTEGER) {
      if (offset + 8 > bytes.length) throw invalidKey("Truncated integer key field.");
      const integer = bytes.readBigUInt64BE(offset);
      parts.push(integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer);
      offset += 8;
      continue;
    }
    if (type === FIELD.FALSE) {
      parts.push(false);
      continue;
    }
    if (type === FIELD.TRUE) {
      parts.push(true);
      continue;
    }
    if (type === FIELD.NULL) {
      parts.push(null);
      continue;
    }
    throw invalidKey(`Unknown key field tag 0x${type.toString(16)}.`);
  }
  return parts;
}

/**
 * Return the smallest byte string greater than every key beginning with the
 * supplied prefix. `undefined` is only possible for an all-0xff prefix.
 */
export function prefixSuccessor(value) {
  const bytes = Buffer.from(value);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] === 0xff) continue;
    const successor = Buffer.from(bytes.subarray(0, index + 1));
    successor[index] += 1;
    return successor;
  }
  return undefined;
}

/** Create RocksDB lower and exclusive upper bounds for a tuple prefix. */
export function prefixBounds(parts) {
  const start = encodeKey(parts);
  const end = prefixSuccessor(start);
  if (!end) throw invalidKey("Key prefix has no finite upper bound.");
  return { start, end };
}

/** Validate and copy a caller-supplied encoded key. */
export function encodedKey(value) {
  const bytes = requireBytes(value);
  decodeKey(bytes);
  return Buffer.from(bytes);
}

export const keyFor = Object.freeze({
  canonical(kind, ...identity) {
    if (typeof kind !== "string" || kind.length === 0) {
      throw invalidKey("Canonical record kind must be a non-empty string.");
    }
    return [kind, ...identity];
  },
  counter(name) {
    return [KEYSPACE.META, KEYSPACE.COUNTER, name];
  },
  idempotency(requestId) {
    return [KEYSPACE.META, KEYSPACE.IDEMPOTENCY, requestId];
  },
  schema() {
    return [KEYSPACE.META, "schema"];
  },
});
