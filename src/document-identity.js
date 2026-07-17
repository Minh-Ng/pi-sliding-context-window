import { createHash } from "node:crypto";
import { contentHash } from "./rocksdb/chunks.js";
import { stableJson } from "./rocksdb/schema.js";

function requiredContentHash(document) {
  if (typeof document?.text === "string") return contentHash(document.text);
  if (typeof document?.contentHash === "string" && /^[a-f0-9]{64}$/u.test(document.contentHash)) {
    return document.contentHash;
  }
  throw new TypeError("A canonical document identity requires text or a SHA-256 contentHash.");
}

/**
 * Hash the fields that define legacy put equality without copying source text
 * into an RPC response. A document and its immutable manifest produce the same
 * identity because source bytes are represented by their canonical SHA-256.
 */
export function canonicalDocumentIdentityHash(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("A canonical document identity requires a document object.");
  }
  const comparable = stableJson({
    documentId: document.documentId,
    version: document.version,
    sourceKey: document.sourceKey,
    sourceKeyStatus: document.sourceKeyStatus ?? "preserved",
    sourceMessageKeys: document.sourceMessageKeys ?? [],
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    contentHash: requiredContentHash(document),
    metadata: document.metadata,
  });
  return `sha256:${createHash("sha256").update(comparable).digest("hex")}`;
}
