import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  assertContract,
  LOCATOR_PAYLOAD_SCHEMA,
} from "../store-contract.js";
import { KEYSPACE } from "../rocksdb/keys.js";
import { stableJson } from "../rocksdb/schema.js";

export const LOCATOR_FORMAT_VERSION = 1;
export const LOCATOR_PREFIX = `cw${LOCATOR_FORMAT_VERSION}`;
export const LOCATOR_SECRET_BYTES = 32;

const LOCATOR_SECRET_KEY = Object.freeze([
  KEYSPACE.META,
  "retrieval-locator-secret",
  LOCATOR_FORMAT_VERSION,
]);

export class LocatorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LocatorError";
    this.code = "ERR_RETRIEVAL_LOCATOR_INVALID";
    this.details = details;
  }
}

function requireStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.transaction !== "function") {
    throw new TypeError("Locator key management requires a writable RocksStore-compatible store.");
  }
  return store;
}

function secretBytes(secret) {
  let bytes;
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else if (typeof secret === "string" && secret.length > 0) {
    if (!/^[A-Za-z0-9_-]+$/u.test(secret)) {
      throw new TypeError("Locator secrets must be base64url strings or byte arrays.");
    }
    try {
      bytes = Buffer.from(secret, "base64url");
    } catch {
      throw new TypeError("Locator secrets must be base64url strings or byte arrays.");
    }
    if (bytes.toString("base64url") !== secret) {
      throw new TypeError("Locator secrets must use canonical base64url encoding.");
    }
  } else {
    throw new TypeError("Locator secrets must be base64url strings or byte arrays.");
  }
  if (bytes.length < LOCATOR_SECRET_BYTES) {
    throw new RangeError(`Locator secrets must contain at least ${LOCATOR_SECRET_BYTES} bytes.`);
  }
  return bytes;
}

function persistedSecretRecord(bytes, createdAt) {
  return Object.freeze({
    locatorSecretVersion: LOCATOR_FORMAT_VERSION,
    algorithm: "hmac-sha256",
    secret: bytes.toString("base64url"),
    createdAt,
  });
}

function decodePersistedSecret(record) {
  if (!record || record.locatorSecretVersion !== LOCATOR_FORMAT_VERSION
    || record.algorithm !== "hmac-sha256" || typeof record.secret !== "string") {
    throw new LocatorError("The persisted locator signing key is malformed.");
  }
  return secretBytes(record.secret);
}

/** Load the daemon-owned signing key, creating it atomically on first use. */
export async function getOrCreateLocatorSecret(store, options = {}) {
  requireStore(store);
  const supplied = options.secret === undefined ? undefined : secretBytes(options.secret);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now must be a non-negative safe integer timestamp.");
  }
  return store.transaction(async (transaction) => {
    const existing = await transaction.get(LOCATOR_SECRET_KEY);
    if (existing !== undefined) {
      const persisted = decodePersistedSecret(existing);
      if (supplied !== undefined
        && (persisted.length !== supplied.length || !timingSafeEqual(persisted, supplied))) {
        throw new LocatorError("The supplied locator key does not match the persisted daemon key.");
      }
      return persisted;
    }
    const generated = supplied ?? randomBytes(LOCATOR_SECRET_BYTES);
    await transaction.putImmutable(
      LOCATOR_SECRET_KEY,
      persistedSecretRecord(generated, now),
      { kind: "retrieval-locator-secret" },
    );
    return generated;
  });
}

function validateClaims(payload) {
  try {
    assertContract(LOCATOR_PAYLOAD_SCHEMA, payload, {
      path: "locator",
      code: "LOCATOR_INVALID",
    });
  } catch (error) {
    throw new LocatorError("The locator claims are malformed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (payload.matchRange.endByte < payload.matchRange.startByte) {
    throw new LocatorError("The locator match range is reversed.");
  }
  if (payload.expiresAt <= payload.issuedAt) {
    throw new LocatorError("The locator expiry must follow its issue time.");
  }
  return payload;
}

function mac(secret, prefix, encodedPayload) {
  return createHmac("sha256", secret)
    .update(prefix, "ascii")
    .update(".", "ascii")
    .update(encodedPayload, "ascii")
    .digest();
}

/** Serialize and authenticate locator claims. */
export function signLocator(payload, secret) {
  const claims = validateClaims(payload);
  const key = secretBytes(secret);
  const encodedPayload = Buffer.from(stableJson(claims), "utf8").toString("base64url");
  const signature = mac(key, LOCATOR_PREFIX, encodedPayload).toString("base64url");
  return `${LOCATOR_PREFIX}.${encodedPayload}.${signature}`;
}

function decodeJsonPayload(encodedPayload) {
  if (!/^[A-Za-z0-9_-]+$/u.test(encodedPayload)) {
    throw new LocatorError("The locator payload is not base64url data.");
  }
  let bytes;
  try {
    bytes = Buffer.from(encodedPayload, "base64url");
  } catch {
    throw new LocatorError("The locator payload is not base64url data.");
  }
  if (bytes.toString("base64url") !== encodedPayload) {
    throw new LocatorError("The locator payload is not canonical base64url data.");
  }
  if (bytes.length === 0 || bytes.length > 64 * 1024) {
    throw new LocatorError("The locator payload has an invalid length.");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LocatorError("The locator payload is not valid JSON.");
  }
}

/** Authenticate and decode one opaque locator without applying authorization. */
export function verifyLocator(locator, secret) {
  if (typeof locator !== "string" || locator.length === 0 || locator.length > 128 * 1024) {
    throw new LocatorError("The locator must be a bounded non-empty string.");
  }
  const parts = locator.split(".");
  if (parts.length !== 3 || parts[0] !== LOCATOR_PREFIX
    || parts[1].length === 0 || parts[2].length === 0) {
    throw new LocatorError("The locator format or version is unsupported.");
  }
  const expected = mac(secretBytes(secret), parts[0], parts[1]);
  let supplied;
  if (!/^[A-Za-z0-9_-]+$/u.test(parts[2])) {
    throw new LocatorError("The locator signature is not base64url data.");
  }
  try {
    supplied = Buffer.from(parts[2], "base64url");
  } catch {
    throw new LocatorError("The locator signature is not base64url data.");
  }
  if (supplied.toString("base64url") !== parts[2]) {
    throw new LocatorError("The locator signature is not canonical base64url data.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LocatorError("The locator signature is invalid.");
  }
  return Object.freeze(validateClaims(decodeJsonPayload(parts[1])));
}

/** Authenticate a locator and enforce caller project/session authorization. */
export function authorizeLocator(locator, secret, {
  project,
  sessionIds,
} = {}) {
  const claims = verifyLocator(locator, secret);
  if (typeof project !== "string" || project.length === 0 || claims.project !== project) {
    throw new LocatorError("The locator is outside the authorized project boundary.");
  }
  const lineage = sessionIds === undefined ? [] : [...new Set(sessionIds)];
  if (claims.scope === "session" && !lineage.includes(claims.sessionId)) {
    throw new LocatorError("The locator is outside the authorized session lineage.");
  }
  return claims;
}

export const locatorKeys = Object.freeze({
  secret() {
    return [...LOCATOR_SECRET_KEY];
  },
});
