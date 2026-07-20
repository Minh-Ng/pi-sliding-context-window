import { RETENTION_CLASSES } from "../../store/store-contract.js";
import { KEYSPACE } from "../keys.js";

export const RETENTION_FORMAT_VERSION = 1;
export const DEFAULT_ACCESS_BUCKET_MS = 60 * 60 * 1_000;
export const DEFAULT_RETENTION_WORK_LIMIT = 256;
export const DEFAULT_TOMBSTONE_AUDIT_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_SCAN_LIMIT = 100_000;
export const SECONDARY_PROTECTION_SCAN_PAGE = 10_000;
const ROOT = Object.freeze([KEYSPACE.META, "retention"]);

export function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

export function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer timestamp.`);
  }
  return value;
}

export function requireStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.getRecord !== "function"
    || typeof store.scan !== "function" || typeof store.iterate !== "function"
    || typeof store.transaction !== "function") {
    throw new TypeError("Retention requires a writable RocksStore-compatible store.");
  }
  return store;
}

export function documentVersion(documentId, version) {
  return {
    documentId: identifier(documentId, "documentId"),
    version: positiveInteger(version, "version"),
  };
}

export const retentionKeys = Object.freeze({
  pin(pinId) {
    return [...ROOT, "pin", identifier(pinId, "pinId")];
  },
  pinPrefix() {
    return [...ROOT, "pin"];
  },
  pinDocument(documentId, version, pinId) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "pin-document", target.documentId, target.version, identifier(pinId, "pinId")];
  },
  pinDocumentPrefix(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "pin-document", target.documentId, target.version];
  },
  protection(ownerId) {
    return [...ROOT, "protection", identifier(ownerId, "ownerId")];
  },
  protectionExpiry(expiresAt, ownerId) {
    return [
      ...ROOT,
      "protection-expiry",
      timestamp(expiresAt, "expiresAt"),
      identifier(ownerId, "ownerId"),
    ];
  },
  protectionExpiryPrefix() {
    return [...ROOT, "protection-expiry"];
  },
  protectionDocument(documentId, version, ownerId) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "protection-document", target.documentId, target.version, identifier(ownerId, "ownerId")];
  },
  protectionDocumentPrefix(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "protection-document", target.documentId, target.version];
  },
  protectionSession(sessionId, ownerId, project) {
    return project === undefined
      ? [...ROOT, "protection-session", identifier(sessionId, "sessionId"), identifier(ownerId, "ownerId")]
      : [
          ...ROOT,
          "protection-session-project",
          identifier(project, "project"),
          identifier(sessionId, "sessionId"),
          identifier(ownerId, "ownerId"),
        ];
  },
  protectionSessionPrefix(sessionId, project) {
    return project === undefined
      ? [...ROOT, "protection-session", identifier(sessionId, "sessionId")]
      : [
          ...ROOT,
          "protection-session-project",
          identifier(project, "project"),
          identifier(sessionId, "sessionId"),
        ];
  },
  expiryCurrent(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "expiry-current", target.documentId, target.version];
  },
  expiry(expiresAt, retentionClass, documentId, version, generation) {
    const target = documentVersion(documentId, version);
    if (!RETENTION_CLASSES.includes(retentionClass)) throw new TypeError("retentionClass is invalid.");
    return [
      KEYSPACE.EXPIRY,
      Math.floor(timestamp(expiresAt, "expiresAt") / 3_600_000),
      retentionClass,
      expiresAt,
      target.documentId,
      target.version,
      positiveInteger(generation, "generation"),
    ];
  },
  cleanup(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "cleanup", target.documentId, target.version];
  },
  cleanupManifest(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "cleanup-manifest", target.documentId, target.version];
  },
  auditExpiry(expiresAt, documentId, version) {
    const target = documentVersion(documentId, version);
    return [
      ...ROOT,
      "audit-expiry",
      timestamp(expiresAt, "expiresAt"),
      target.documentId,
      target.version,
    ];
  },
  auditExpiryPrefix() {
    return [...ROOT, "audit-expiry"];
  },
  scanCursor(project = "*", retentionClass = "*") {
    return [
      ...ROOT,
      "scan-cursor",
      identifier(project, "project cursor"),
      identifier(retentionClass, "retention class cursor"),
    ];
  },
  access(documentId, version, bucket) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "access", target.documentId, target.version, timestamp(bucket, "bucket")];
  },
  accessPrefix(documentId, version) {
    const target = documentVersion(documentId, version);
    return [...ROOT, "access", target.documentId, target.version];
  },
  emergency() {
    return [...ROOT, "emergency"];
  },
});
