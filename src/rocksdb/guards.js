import { KEYSPACE } from "./keys.js";

const ROOT = Object.freeze([KEYSPACE.META, "conflict-guard"]);

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

export const guardKeys = Object.freeze({
  document(documentId, version) {
    return [...ROOT, "document", identifier(documentId, "documentId"), positiveInteger(version, "version")];
  },
  session(sessionId) {
    return [...ROOT, "session", identifier(sessionId, "sessionId")];
  },
  chunk(chunkId) {
    return [...ROOT, "chunk", identifier(chunkId, "chunkId")];
  },
  sourceMessage(project, sessionId, sourceKey) {
    return [
      ...ROOT,
      "source-message",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(sourceKey, "sourceKey"),
    ];
  },
  auxiliaryManifest(kind, manifestId, version) {
    if (kind !== "turn" && kind !== "tool-result") {
      throw new TypeError("kind must be turn or tool-result.");
    }
    return [
      ...ROOT,
      "auxiliary-manifest",
      kind,
      identifier(manifestId, "manifestId"),
      positiveInteger(version, "version"),
    ];
  },
});

/** Warm a point key before entering the native optimistic transaction. */
export async function warmGuard(store, key) {
  if (!store || typeof store.get !== "function") throw new TypeError("warmGuard requires a readable store.");
  await store.get(key);
}

/** Write a shared revision so concurrent safety decisions conflict and retry. */
export async function bumpGuard(view, key) {
  if (!view || typeof view.get !== "function" || typeof view.put !== "function") {
    throw new TypeError("bumpGuard requires a writable transaction view.");
  }
  const current = await view.get(key);
  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new RangeError("Conflict guard revision overflowed.");
  await view.put(key, { revision }, { kind: "conflict-guard" });
  return revision;
}
