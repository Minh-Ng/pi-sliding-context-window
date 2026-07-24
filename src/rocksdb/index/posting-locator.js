const MAGIC = Buffer.from("CWPOSTL1", "ascii");
const FORMAT_VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 1 + 4;
const MAX_TARGETS = 1_024;
const MAX_TARGET_KEY_BYTES = 1 * 1_024 * 1_024;

export const POSTING_LOCATOR_KIND = Object.freeze({
  BM25_SESSION: 1,
  EXACT_FOLDED: 2,
});

function locatorKind(value) {
  if (!Number.isSafeInteger(value) || !Object.values(POSTING_LOCATOR_KIND).includes(value)) {
    throw new TypeError("Posting locator kind is unsupported.");
  }
  return value;
}

function targetKey(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be bytes.`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > MAX_TARGET_KEY_BYTES) {
    throw new TypeError(`${label} must contain between 1 and ${MAX_TARGET_KEY_BYTES} bytes.`);
  }
  return bytes;
}

/** Encode one compact alias to canonical posting keys. */
export function encodePostingLocator(kind, targetKeys) {
  const normalizedKind = locatorKind(kind);
  if (!Array.isArray(targetKeys) || targetKeys.length === 0 || targetKeys.length > MAX_TARGETS) {
    throw new TypeError(`Posting locators require between 1 and ${MAX_TARGETS} target keys.`);
  }
  const targets = targetKeys.map((value, index) => targetKey(value, `targetKeys[${index}]`));
  const byteLength = HEADER_BYTES
    + targets.reduce((total, target) => total + 4 + target.length, 0);
  const result = Buffer.allocUnsafe(byteLength);
  MAGIC.copy(result, 0);
  let offset = MAGIC.length;
  result[offset] = FORMAT_VERSION;
  offset += 1;
  result[offset] = normalizedKind;
  offset += 1;
  result.writeUInt32BE(targets.length, offset);
  offset += 4;
  for (const target of targets) {
    result.writeUInt32BE(target.length, offset);
    offset += 4;
    target.copy(result, offset);
    offset += target.length;
  }
  return result;
}

/** Decode and validate a compact posting locator. */
export function decodePostingLocator(value, expectedKind) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("Posting locator payload must be bytes.");
  }
  const bytes = Buffer.from(value);
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TypeError("Posting locator has an unknown format.");
  }
  let offset = MAGIC.length;
  const version = bytes[offset];
  offset += 1;
  if (version !== FORMAT_VERSION) throw new TypeError(`Posting locator version ${version} is unsupported.`);
  const kind = locatorKind(bytes[offset]);
  offset += 1;
  if (expectedKind !== undefined && kind !== locatorKind(expectedKind)) {
    throw new TypeError("Posting locator kind does not match its index.");
  }
  const count = bytes.readUInt32BE(offset);
  offset += 4;
  if (count === 0 || count > MAX_TARGETS) throw new TypeError("Posting locator target count is invalid.");
  const targets = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > bytes.length) throw new TypeError("Posting locator is truncated.");
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    if (length === 0 || length > MAX_TARGET_KEY_BYTES || offset + length > bytes.length) {
      throw new TypeError("Posting locator target length is invalid.");
    }
    targets.push(Buffer.from(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset !== bytes.length) throw new TypeError("Posting locator has trailing bytes.");
  return Object.freeze({
    version,
    kind,
    targets: Object.freeze(targets),
  });
}

export function isPostingLocator(value) {
  return (Buffer.isBuffer(value) || value instanceof Uint8Array)
    && value.length >= MAGIC.length
    && Buffer.from(value).subarray(0, MAGIC.length).equals(MAGIC);
}
