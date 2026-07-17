const DEFAULT_STATUS_RECORD_LIMIT = 10_000;
const DEFAULT_STATUS_STORED_BYTE_LIMIT = 8 * 1_024 * 1_024;

function positiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function statusRecordStoredBytes(record) {
  const valueBytes = record?.storedValueBytes;
  const keyBytes = record?.keyBytes?.byteLength;
  if (!Number.isSafeInteger(valueBytes) || valueBytes < 0
    || !Number.isSafeInteger(keyBytes) || keyBytes < 0) {
    throw new TypeError("A status scan record must expose its stored key and value byte lengths.");
  }
  return valueBytes + keyBytes;
}

/**
 * Visit a prefix one decoded record at a time under both count and stored-byte
 * limits. The byte limit bounds retained decoded payloads; a single valid
 * record may cross it, but a second record is never fetched afterward.
 */
export async function scanStatusPrefix(store, prefix, visit, options = {}) {
  if (!store || typeof store.iterate !== "function") {
    throw new TypeError("scanStatusPrefix requires a RocksStore-compatible store.");
  }
  if (typeof visit !== "function") throw new TypeError("scanStatusPrefix requires a visitor.");
  const recordLimit = positiveLimit(
    options.recordLimit ?? DEFAULT_STATUS_RECORD_LIMIT,
    "recordLimit",
  );
  const storedByteLimit = positiveLimit(
    options.storedByteLimit ?? DEFAULT_STATUS_STORED_BYTE_LIMIT,
    "storedByteLimit",
  );
  let scanned = 0;
  let storedBytes = 0;
  let byteLimitReached = false;
  for (const record of store.iterate(prefix, { limit: recordLimit, fillCache: false })) {
    const recordBytes = statusRecordStoredBytes(record);
    const additionalBytes = await visit(record);
    if (additionalBytes !== undefined
      && (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0)) {
      throw new TypeError("A status scan visitor byte charge must be a non-negative safe integer.");
    }
    scanned += 1;
    storedBytes += recordBytes + (additionalBytes ?? 0);
    if (storedBytes >= storedByteLimit) {
      byteLimitReached = true;
      break;
    }
  }
  return Object.freeze({
    scanned,
    storedBytes,
    // Reaching the native record limit is conservative: determining whether
    // one more record exists would itself decode an unbudgeted value.
    truncated: byteLimitReached || scanned === recordLimit,
  });
}

export const STATUS_SCAN_LIMITS = Object.freeze({
  records: DEFAULT_STATUS_RECORD_LIMIT,
  storedBytes: DEFAULT_STATUS_STORED_BYTE_LIMIT,
});
