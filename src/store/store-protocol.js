import {
  ContractError,
  boundedStoreErrorMessage,
  MAX_STORE_IDENTIFIER_LENGTH,
  STORE_ERROR_CODES,
  STORE_ERROR_SCHEMA,
  STORE_OPERATIONS,
  STORE_PROTOCOL_VERSION,
  STORE_SCHEMA_VERSION,
  assertContract,
  assertStoreRequest,
  assertStoreResult,
} from "./store-contract.js";

/**
 * @typedef {object} HandshakeRequest
 * @property {1} protocolVersion
 * @property {"handshake"} type
 * @property {string} client
 * @property {string} clientVersion
 * @property {string} project
 */

/**
 * @typedef {object} StoreRequestFrame
 * @property {1} protocolVersion
 * @property {"request"} type
 * @property {string} requestId
 * @property {string} operation
 * @property {import("./store-contract.js").JsonValue} payload
 */

/**
 * @typedef {object} StoreSuccessResponseFrame
 * @property {1} protocolVersion
 * @property {"response"} type
 * @property {string} requestId
 * @property {string} operation
 * @property {true} ok
 * @property {import("./store-contract.js").JsonValue} result
 */

/**
 * @typedef {object} StoreErrorResponseFrame
 * @property {1} protocolVersion
 * @property {"response"} type
 * @property {string} requestId
 * @property {string} operation
 * @property {false} ok
 * @property {import("./store-contract.js").StoreError} error
 */

export {
  STORE_ERROR_CODES,
  STORE_LOCATOR_VERSION,
  STORE_OPERATIONS,
  STORE_PROTOCOL_VERSION,
  STORE_SCHEMA_VERSION,
} from "./store-contract.js";

export const PROTOCOL_FRAME_TYPES = Object.freeze([
  "handshake",
  "handshake-ack",
  "request",
  "response",
]);

const identifier = { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH };
const protocolVersion = { const: STORE_PROTOCOL_VERSION };
const schemaVersion = { const: STORE_SCHEMA_VERSION };
const jsonValue = { type: "json" };

function object(properties, required = Object.keys(properties)) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function anyOf(...schemas) {
  return { anyOf: schemas };
}

// A handful is ample: a client contributes at most the single literal cwd
// spelling that differs from its canonical project identity.
export const MAX_PROJECT_ALIASES = 8;

export const HANDSHAKE_REQUEST_SCHEMA = Object.freeze(object({
  protocolVersion,
  type: { const: "handshake" },
  client: identifier,
  clientVersion: identifier,
  project: identifier,
  // Optional read-compatibility aliases for pre-canonical project spellings.
  // Never authoritative for writes; the daemon re-verifies each against the real
  // filesystem before honoring it, so an alias can only widen reads over another
  // spelling of the same directory.
  aliasProjects: { type: "array", items: identifier, maxItems: MAX_PROJECT_ALIASES },
}, ["protocolVersion", "type", "client", "clientVersion", "project"]));

const acceptedHandshake = object({
  protocolVersion,
  type: { const: "handshake-ack" },
  accepted: { const: true },
  serverVersion: identifier,
  schemaVersion,
  processId: { type: "integer", minimum: 1 },
  storePath: identifier,
  capabilities: { type: "array", items: identifier },
});

const rejectedHandshake = object({
  protocolVersion,
  type: { const: "handshake-ack" },
  accepted: { const: false },
  error: STORE_ERROR_SCHEMA,
});

export const HANDSHAKE_RESPONSE_SCHEMA = Object.freeze(anyOf(
  acceptedHandshake,
  rejectedHandshake,
));

export const REQUEST_FRAME_SCHEMA = Object.freeze(object({
  protocolVersion,
  type: { const: "request" },
  requestId: identifier,
  operation: identifier,
  payload: jsonValue,
}));

export const SUCCESS_RESPONSE_FRAME_SCHEMA = Object.freeze(object({
  protocolVersion,
  type: { const: "response" },
  requestId: identifier,
  operation: identifier,
  ok: { const: true },
  result: jsonValue,
}));

export const ERROR_RESPONSE_FRAME_SCHEMA = Object.freeze(object({
  protocolVersion,
  type: { const: "response" },
  requestId: identifier,
  operation: identifier,
  ok: { const: false },
  error: STORE_ERROR_SCHEMA,
}));

function assertSupportedVersion(frame, code) {
  if (frame && typeof frame === "object" && !Array.isArray(frame)
    && Object.hasOwn(frame, "protocolVersion")
    && frame.protocolVersion !== STORE_PROTOCOL_VERSION) {
    throw new ContractError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "$.protocolVersion",
      `protocol version ${JSON.stringify(frame.protocolVersion)} is incompatible; expected ${STORE_PROTOCOL_VERSION}`,
    );
  }
  return code;
}

export function assertHandshakeRequest(frame) {
  assertSupportedVersion(frame, "INVALID_REQUEST");
  return assertContract(HANDSHAKE_REQUEST_SCHEMA, frame, {
    path: "$",
    code: "INVALID_REQUEST",
  });
}

export function assertHandshakeResponse(frame) {
  assertSupportedVersion(frame, "INVALID_RESPONSE");
  return assertContract(HANDSHAKE_RESPONSE_SCHEMA, frame, {
    path: "$",
    code: "INVALID_RESPONSE",
  });
}

export function assertRequestFrame(frame) {
  assertSupportedVersion(frame, "INVALID_REQUEST");
  assertContract(REQUEST_FRAME_SCHEMA, frame, { path: "$", code: "INVALID_REQUEST" });
  assertStoreRequest(frame.operation, frame.payload);
  return frame;
}

export function assertResponseFrame(frame) {
  assertSupportedVersion(frame, "INVALID_RESPONSE");
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return assertContract(SUCCESS_RESPONSE_FRAME_SCHEMA, frame, {
      path: "$",
      code: "INVALID_RESPONSE",
    });
  }
  if (frame.ok === true) {
    assertContract(SUCCESS_RESPONSE_FRAME_SCHEMA, frame, {
      path: "$",
      code: "INVALID_RESPONSE",
    });
    assertStoreResult(frame.operation, frame.result);
    return frame;
  }
  assertContract(ERROR_RESPONSE_FRAME_SCHEMA, frame, {
    path: "$",
    code: "INVALID_RESPONSE",
  });
  return frame;
}

export function assertProtocolFrame(frame) {
  switch (frame?.type) {
    case "handshake": return assertHandshakeRequest(frame);
    case "handshake-ack": return assertHandshakeResponse(frame);
    case "request": return assertRequestFrame(frame);
    case "response": return assertResponseFrame(frame);
    default:
      throw new ContractError("INVALID_REQUEST", "$.type", "must identify a supported frame type");
  }
}

function wireError(code, message, retryable = false, details) {
  const error = { code, message, retryable };
  if (details !== undefined) {
    try {
      const serialized = JSON.stringify(details);
      if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= 8_192) {
        error.details = JSON.parse(serialized);
      } else if (serialized !== undefined) {
        error.details = { truncated: true };
      }
    } catch {
      // Error reporting must remain available even when diagnostic details are
      // cyclic, deeply nested, or otherwise not representable as JSON.
    }
  }
  try {
    assertContract(STORE_ERROR_SCHEMA, error, { path: "$.error", code: "INVALID_RESPONSE" });
  } catch (validationError) {
    if (error.details === undefined || !(validationError instanceof ContractError)) throw validationError;
    delete error.details;
    assertContract(STORE_ERROR_SCHEMA, error, { path: "$.error", code: "INVALID_RESPONSE" });
  }
  return error;
}

function errorDetails(error, explicitDetails) {
  if (explicitDetails !== undefined) return explicitDetails;
  if (error instanceof ContractError) return { path: error.path };
  return undefined;
}

function errorCode(error) {
  return STORE_ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL";
}

function errorMessage(error) {
  return boundedStoreErrorMessage(error);
}

function correlationIdentifier(value, fallback) {
  let identifierValue;
  try {
    identifierValue = String(value ?? fallback);
  } catch {
    identifierValue = fallback;
  }
  if (identifierValue.length === 0) identifierValue = fallback;
  return identifierValue.slice(0, MAX_STORE_IDENTIFIER_LENGTH);
}

function defaultRetryable(code) {
  return code === "STORE_BUSY" || code === "DISK_LOW" || code === "CONNECTION_CLOSED";
}

export function createHandshakeAccepted({
  serverVersion,
  processId = process.pid,
  storePath,
  capabilities = STORE_OPERATIONS,
}) {
  return assertHandshakeResponse({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "handshake-ack",
    accepted: true,
    serverVersion,
    schemaVersion: STORE_SCHEMA_VERSION,
    processId,
    storePath,
    capabilities: [...capabilities],
  });
}

export function createHandshakeRejected(error, { retryable, details } = {}) {
  const code = errorCode(error);
  return assertHandshakeResponse({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "handshake-ack",
    accepted: false,
    error: wireError(
      code,
      errorMessage(error),
      retryable ?? defaultRetryable(code),
      errorDetails(error, details),
    ),
  });
}

export function createSuccessResponse(request, result) {
  assertRequestFrame(request);
  assertStoreResult(request.operation, result);
  return assertResponseFrame({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "response",
    requestId: request.requestId,
    operation: request.operation,
    ok: true,
    result,
  });
}

/**
 * Build a correlated error response. Identification is intentionally accepted
 * without validating the original payload so malformed/unknown requests can
 * still receive a typed response.
 */
export function createErrorResponse(request, error, { retryable, details } = {}) {
  const requestId = correlationIdentifier(request?.requestId, "unknown-request");
  const operation = correlationIdentifier(request?.operation, "unknown-operation");
  const code = errorCode(error);
  return assertResponseFrame({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "response",
    requestId,
    operation,
    ok: false,
    error: wireError(
      code,
      errorMessage(error),
      retryable ?? defaultRetryable(code),
      errorDetails(error, details),
    ),
  });
}

export function encodeProtocolFrame(frame) {
  assertProtocolFrame(frame);
  return `${JSON.stringify(frame)}\n`;
}

export function decodeProtocolLine(input, { direction = "any" } = {}) {
  if (!new Set(["any", "request", "response"]).has(direction)) {
    throw new TypeError(`Unknown protocol direction ${JSON.stringify(direction)}.`);
  }
  const code = direction === "response" ? "INVALID_RESPONSE" : "INVALID_REQUEST";
  const source = Buffer.isBuffer(input) ? input.toString("utf8") : String(input ?? "");
  const line = source.endsWith("\n") ? source.slice(0, -1).replace(/\r$/u, "") : source;
  if (!line || /[\r\n]/u.test(line)) {
    throw new ContractError(code, "$", "must contain exactly one non-empty protocol line");
  }
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new ContractError(code, "$", "must contain valid JSON");
  }
  if (direction === "request") {
    if (frame?.type === "handshake") return assertHandshakeRequest(frame);
    return assertRequestFrame(frame);
  }
  if (direction === "response") {
    if (frame?.type === "handshake-ack") return assertHandshakeResponse(frame);
    return assertResponseFrame(frame);
  }
  return assertProtocolFrame(frame);
}
