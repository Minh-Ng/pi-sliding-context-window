/**
 * The object()/field validation machinery that executes the schema
 * descriptors in store-contract-schema.js, plus the operation-level asserters
 * that dispatch and result paths call before trusting a payload.
 */
import { ContractError } from "./store-contract-errors.js";
import {
  MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES,
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_JSON_VALUE_DEPTH,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_VISIBLE_SOURCE_KEY_BYTES,
  STORE_OPERATION_CONTRACTS,
  STORE_SCHEMA_METADATA_SCHEMA,
  STORE_SCHEMA_VERSION,
  LOCATOR_PAYLOAD_SCHEMA,
  activeHintMessageKeys,
  visibleSourceKeys,
} from "./store-contract-schema.js";

function fail(code, path, message) {
  throw new ContractError(code, path, message);
}

function isJsonValue(value) {
  const active = new Set();
  const pending = [{ value, depth: 0, exit: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.exit) {
      active.delete(current.value);
      continue;
    }
    const candidate = current.value;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (!candidate || typeof candidate !== "object" || current.depth >= MAX_JSON_VALUE_DEPTH
      || active.has(candidate)) return false;
    if (!Array.isArray(candidate)) {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    active.add(candidate);
    pending.push({ value: candidate, depth: current.depth, exit: true });
    const entries = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({ value: entries[index], depth: current.depth + 1, exit: false });
    }
  }
  return true;
}

function validate(schema, value, path, code) {
  if (schema.anyOf) {
    const failures = [];
    for (const candidate of schema.anyOf) {
      try {
        validate(candidate, value, path, code);
        return;
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        failures.push(error.message);
      }
    }
    fail(code, path, `does not match any allowed shape (${failures.join("; ")})`);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    fail(code, path, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail(code, path, `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (schema.type === "json") {
    if (!isJsonValue(value)) fail(code, path, "must be an acyclic JSON value");
    return;
  }
  if (schema.type === "null") {
    if (value !== null) fail(code, path, "must be null");
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") fail(code, path, "must be a string");
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(code, path, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(code, path, `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) {
      fail(code, path, `must match ${schema.pattern}`);
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(code, path, "must be a boolean");
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const valid = typeof value === "number"
      && Number.isFinite(value)
      && (schema.type !== "integer" || Number.isSafeInteger(value));
    if (!valid) fail(code, path, `must be a finite ${schema.type}`);
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(code, path, `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(code, path, `must be at most ${schema.maximum}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail(code, path, "must be an array");
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(code, path, `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(code, path, `must contain at most ${schema.maxItems} items`);
    }
    value.forEach((entry, index) => validate(schema.items, entry, `${path}[${index}]`, code));
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(code, path, "must be an object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(code, path, "must be a plain object");
    }
    const properties = schema.properties ?? {};
    const unknown = Object.keys(value)
      .filter((key) => !Object.hasOwn(properties, key))
      .sort();
    if (unknown.length > 0 && schema.additionalProperties === false) {
      fail(code, `${path}.${unknown[0]}`, "is not an allowed field");
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(code, `${path}.${key}`, "is required");
    }
    for (const [key, nested] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(nested, value[key], `${path}.${key}`, code);
    }
    if (schema.additionalProperties && schema.additionalProperties !== false) {
      for (const key of unknown) validate(schema.additionalProperties, value[key], `${path}.${key}`, code);
    }
    return;
  }
  if (!schema.anyOf && !Object.hasOwn(schema, "const") && !schema.enum) {
    throw new Error(`Unsupported contract schema at ${path}`);
  }
}

/** Validate a value against an exported schema and return the same value. */
export function assertContract(schema, value, {
  path = "$",
  code = "INVALID_REQUEST",
} = {}) {
  validate(schema, value, path, code);
  return value;
}

/** Bound live-context exclusions before any retrieval path materializes a Set. */
export function assertVisibleSourceKeys(value, {
  path = "$.excludeVisibleSourceKeys",
  code = "INVALID_REQUEST",
} = {}) {
  validate(visibleSourceKeys, value, path, code);
  let bytes = 0;
  for (const key of value) {
    bytes += Buffer.byteLength(key, "utf8");
    if (bytes > MAX_VISIBLE_SOURCE_KEY_BYTES) {
      fail(code, path, `must contain at most ${MAX_VISIBLE_SOURCE_KEY_BYTES} UTF-8 bytes`);
    }
  }
  return value;
}

/** Bound active hint accounting before preflight materializes message-key state. */
export function assertActiveHintMessageKeys(value, {
  path = "$.activeMessageKeys",
  code = "INVALID_REQUEST",
} = {}) {
  validate(activeHintMessageKeys, value, path, code);
  let bytes = 0;
  for (const key of value) {
    bytes += Buffer.byteLength(key, "utf8");
    if (bytes > MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES) {
      fail(code, path, `must contain at most ${MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES} UTF-8 bytes`);
    }
  }
  return value;
}

// Count the caller-supplied JSON footprint without serializing the complete
// value into a second large string. Escaping can make the wire representation
// larger, so this deliberately bounds the raw UTF-8 input retained by
// canonical records rather than claiming to measure protocol-frame bytes.
function jsonInputBytes(value) {
  let bytes = 0;
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null) {
      bytes += 4;
    } else if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8") + 2;
    } else if (typeof current === "boolean") {
      bytes += current ? 4 : 5;
    } else if (typeof current === "number") {
      bytes += Buffer.byteLength(String(current), "utf8");
    } else if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1);
      for (const entry of current) pending.push(entry);
    } else {
      const entries = Object.entries(current);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, entry] of entries) {
        bytes += Buffer.byteLength(key, "utf8") + 3;
        pending.push(entry);
      }
    }
    if (bytes > MAX_DOCUMENT_METADATA_BYTES) return bytes;
  }
  return bytes;
}

/** Validate an operation payload before dispatch. */
export function assertStoreRequest(operation, payload) {
  const contract = STORE_OPERATION_CONTRACTS[operation];
  if (!contract) fail("UNKNOWN_OPERATION", "$.operation", `unknown operation ${JSON.stringify(operation)}`);
  const validated = assertContract(contract.request, payload, {
    path: "$.payload",
    code: "INVALID_REQUEST",
  });
  if (operation === "store.put") {
    const documentTextBytes = Buffer.byteLength(payload.document.text, "utf8");
    if (documentTextBytes > MAX_DOCUMENT_TEXT_BYTES) {
      fail(
        "INVALID_REQUEST",
        "$.payload.document.text",
        `must contain at most ${MAX_DOCUMENT_TEXT_BYTES} UTF-8 bytes; split larger sources across documents`,
      );
    }
    const metadataBytes = jsonInputBytes(payload.document.metadata);
    if (metadataBytes > MAX_DOCUMENT_METADATA_BYTES) {
      fail(
        "INVALID_REQUEST",
        "$.payload.document.metadata",
        `must contain at most ${MAX_DOCUMENT_METADATA_BYTES} UTF-8 bytes; store larger payloads in document text`,
      );
    }
    let sourceMessageKeyBytes = 0;
    for (const sourceMessageKey of payload.document.sourceMessageKeys ?? []) {
      sourceMessageKeyBytes += Buffer.byteLength(sourceMessageKey, "utf8");
      if (sourceMessageKeyBytes > MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT) {
        fail(
          "INVALID_REQUEST",
          "$.payload.document.sourceMessageKeys",
          `must contain at most ${MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT} UTF-8 bytes`,
        );
      }
    }
  }
  if (operation === "store.put" && Array.isArray(payload.structuralMessages)) {
    let structuralBytes = 0;
    let structuralKeyBytes = 0;
    for (const message of payload.structuralMessages) {
      structuralKeyBytes += Buffer.byteLength(message.messageKey, "utf8");
      if (structuralKeyBytes > MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT) {
        fail(
          "INVALID_REQUEST",
          "$.payload.structuralMessages",
          `message keys must contain at most ${MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT} UTF-8 bytes`,
        );
      }
      structuralBytes += Buffer.byteLength(message.text, "utf8");
      if (structuralBytes > MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT) {
        fail(
          "INVALID_REQUEST",
          "$.payload.structuralMessages",
          `must contain at most ${MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT} UTF-8 bytes of text`,
        );
      }
    }
  }
  if (operation === "store.search" || operation === "store.gather" || operation === "store.preflight") {
    assertVisibleSourceKeys(payload.excludeVisibleSourceKeys, {
      path: "$.payload.excludeVisibleSourceKeys",
    });
  }
  if (operation === "store.preflight" && payload.activeMessageKeys !== undefined) {
    assertActiveHintMessageKeys(payload.activeMessageKeys, {
      path: "$.payload.activeMessageKeys",
    });
  }
  return validated;
}

/** Validate an operation result before it enters a success response. */
export function assertStoreResult(operation, result) {
  const contract = STORE_OPERATION_CONTRACTS[operation];
  if (!contract) fail("UNKNOWN_OPERATION", "$.operation", `unknown operation ${JSON.stringify(operation)}`);
  return assertContract(contract.result, result, { path: "$.result", code: "INVALID_RESPONSE" });
}

/** Validate on-disk compatibility before a backend opens the store for writes. */
export function assertStoreSchemaMetadata(metadataValue) {
  for (const field of ["schemaVersion", "minimumReadableVersion", "minimumWritableVersion"]) {
    if (metadataValue && typeof metadataValue === "object"
      && Object.hasOwn(metadataValue, field)
      && metadataValue[field] !== STORE_SCHEMA_VERSION) {
      fail(
        "UNSUPPORTED_SCHEMA_VERSION",
        `$.schema.${field}`,
        `schema version ${JSON.stringify(metadataValue[field])} is incompatible; expected ${STORE_SCHEMA_VERSION}`,
      );
    }
  }
  return assertContract(STORE_SCHEMA_METADATA_SCHEMA, metadataValue, {
    path: "$.schema",
    code: "INVALID_REQUEST",
  });
}

/** Validate the signed/MAC-protected locator payload before encoding or after decoding. */
export function assertLocatorPayload(payload) {
  assertContract(LOCATOR_PAYLOAD_SCHEMA, payload, { path: "$.locator", code: "LOCATOR_INVALID" });
  if (payload.matchRange.endByte < payload.matchRange.startByte) {
    fail("LOCATOR_INVALID", "$.locator.matchRange.endByte", "must not precede startByte");
  }
  if (payload.expiresAt < payload.issuedAt) {
    fail("LOCATOR_INVALID", "$.locator.expiresAt", "must not precede issuedAt");
  }
  return payload;
}
