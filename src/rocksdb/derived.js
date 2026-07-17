import { createHash } from "node:crypto";
import { encodeKey, KEYSPACE } from "./keys.js";

const ROOT = Object.freeze([KEYSPACE.DERIVED, "document"]);

function identifier(value, label) {
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

export const derivedKeys = Object.freeze({
  prefix(documentId, version) {
    return [
      ...ROOT,
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  reference(documentId, version, targetKey) {
    const encoded = Buffer.isBuffer(targetKey) ? targetKey : encodeKey(targetKey);
    const digest = createHash("sha256").update(encoded).digest("hex");
    return [...this.prefix(documentId, version), digest];
  },
});

/** Add a compact document-to-derived-key reverse reference for bounded cleanup. */
export function addDerivedReferences(mutations, documentId, version) {
  const references = [];
  for (const mutation of mutations) {
    if (mutation?.type !== "put" || !mutation.payload) continue;
    const payloadVersion = mutation.payload.documentVersion ?? mutation.payload.version;
    if (mutation.payload.documentId !== documentId || payloadVersion !== version) continue;
    const targetKey = encodeKey(mutation.key);
    references.push({
      type: "put",
      key: derivedKeys.reference(documentId, version, targetKey),
      kind: "derived-document-reference",
      immutable: false,
      payload: {
        documentId,
        documentVersion: version,
        targetKey: targetKey.toString("base64url"),
      },
    });
  }
  return [...mutations, ...references];
}
