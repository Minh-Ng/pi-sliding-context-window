import { manifestKeys } from "../manifests.js";
import { KEYSPACE } from "../keys.js";
import { beginExpiry } from "./expiry.js";
import {
  identifier,
  positiveInteger,
  timestamp,
} from "./shared.js";

/**
 * Tombstone one document version without requiring an expiry-queue hit.
 * Used by scoped archive redaction. Respects pins/leases unless
 * `ignoreProtection` is true (user-confirmed redact).
 */
export async function tombstoneDocument(store, {
  documentId,
  version,
  now = Date.now(),
  reason = "Explicit archive redaction.",
  ignoreProtection = false,
} = {}) {
  identifier(documentId, "documentId");
  positiveInteger(version, "version");
  timestamp(now, "now");
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("reason must be a non-empty string.");
  }
  const manifest = await store.get(manifestKeys.document(documentId, version));
  if (manifest === undefined) {
    const existing = await store.get([KEYSPACE.SUPERSESSION, documentId, version]);
    if (existing !== undefined) {
      return Object.freeze({ status: "already-tombstoned", tombstone: existing, manifest: undefined });
    }
    return Object.freeze({ status: "missing" });
  }
  const candidate = Object.freeze({
    record: undefined,
    documentId,
    version,
    retentionClass: typeof manifest.retentionClass === "string"
      ? manifest.retentionClass
      : "conversation-source",
    expiresAt: now,
    generation: 0,
    legacy: true,
  });
  return beginExpiry(store, candidate, now, {
    ignoreProtection: ignoreProtection === true,
    reason,
    forced: true,
  });
}
