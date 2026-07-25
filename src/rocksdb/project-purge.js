import { decodeKey, KEYSPACE } from "./keys.js";

export const PROJECT_PURGE_PAGE_SIZE = 10_000;
const DELETE_BATCH = 256;

// Swept in a fixed order so a cursor can resume mid-purge across restarts.
const PURGE_KEYSPACES = Object.freeze(Object.values(KEYSPACE));

/**
 * Records whose key still names `project`, found by decoding each key rather
 * than by matching an allowlist of namespaces. Redaction retires documents one
 * at a time, so anything keyed by project rather than by document -- BM25
 * corpus and per-term document-frequency statistics, derived-view scope
 * membership, structural relation heads -- is unreachable from that cascade and
 * survives it. Deriving the match from the key itself means a namespace added
 * later is purged without anyone remembering to register it here.
 */
function keyNamesProject(keyBytes, project) {
  let fields;
  try {
    fields = decodeKey(keyBytes);
  } catch {
    return false;
  }
  for (const field of fields) {
    if (typeof field === "string" && field === project) return true;
  }
  return false;
}

/**
 * The first still-readable document version in `project`, or undefined when
 * every version has been retired.
 */
async function firstUnretiredDocument(store, project) {
  for (const record of store.iterate([KEYSPACE.DOCUMENT], {
    limit: 100_000,
    fillCache: false,
  })) {
    const manifest = record.payload;
    if (manifest?.project !== project) continue;
    const { documentId, version } = manifest;
    // Retirement writes a supersession record for the exact version; the
    // manifest itself lives on until the retention sweep collects it, so the
    // supersession record is what distinguishes retired from readable.
    const retired = await store.get([KEYSPACE.SUPERSESSION, documentId, version]);
    if (retired === undefined) return { documentId, version };
  }
  return undefined;
}

/**
 * Delete every record keyed to a project whose documents are all retired.
 *
 * Bounded and resumable: each call sweeps at most `limit` records and returns
 * the cursor to continue from. The caller repeats until `complete`.
 */
export async function purgeProjectRecords(store, {
  project,
  limit = PROJECT_PURGE_PAGE_SIZE,
  cursor,
  reportOnly = false,
  now = Date.now(),
} = {}) {
  if (typeof project !== "string" || project.length === 0) {
    throw new TypeError("Project purge requires a non-empty project.");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new RangeError("Project purge limit must be a positive safe integer no greater than 100000.");
  }

  // Refuse to purge while any document version in the project is still
  // readable, so a mis-targeted call cannot delete the index records backing
  // live content.
  const unretired = await firstUnretiredDocument(store, project);
  if (unretired !== undefined) {
    const error = new Error(
      `Project purge requires every document to be retired; ${project} still has `
        + `${unretired.documentId}@${unretired.version}.`,
    );
    error.code = "CONFLICT";
    throw error;
  }

  const startKeyspace = cursor?.keyspace;
  let after = cursor?.after === undefined ? undefined : Buffer.from(cursor.after, "base64url");
  let started = startKeyspace === undefined;
  let scannedKeys = 0;
  let deletedKeys = 0;
  let valueBytes = 0;

  for (const keyspace of PURGE_KEYSPACES) {
    if (!started) {
      if (keyspace !== startKeyspace) continue;
      started = true;
    }
    for (;;) {
      const remaining = limit - scannedKeys;
      if (remaining <= 0) {
        return Object.freeze({
          complete: false,
          scannedKeys,
          deletedKeys,
          valueBytes,
          cursor: Object.freeze({
            keyspace,
            ...(after === undefined ? {} : { after: after.toString("base64url") }),
          }),
        });
      }
      const page = store.scan([keyspace], {
        limit: Math.min(remaining, PROJECT_PURGE_PAGE_SIZE),
        fillCache: false,
        ...(after === undefined ? {} : { after }),
      });
      if (page.length === 0) break;
      scannedKeys += page.length;
      after = page.at(-1).keyBytes;
      const doomed = page.filter((record) => keyNamesProject(record.keyBytes, project));
      for (const record of doomed) valueBytes += record.storedValueBytes ?? 0;
      if (!reportOnly && doomed.length > 0) {
        for (let offset = 0; offset < doomed.length; offset += DELETE_BATCH) {
          const batch = doomed.slice(offset, offset + DELETE_BATCH);
          await store.transaction(async (transaction) => {
            for (const record of batch) await transaction.remove(record.keyBytes);
          });
        }
      }
      deletedKeys += reportOnly ? 0 : doomed.length;
    }
    after = undefined;
  }

  return Object.freeze({
    complete: true,
    scannedKeys,
    deletedKeys,
    valueBytes,
  });
}

/** Repeat {@link purgeProjectRecords} until the sweep reports completion. */
export async function purgeProjectRecordsUntilComplete(store, options = {}) {
  let cursor;
  let scannedKeys = 0;
  let deletedKeys = 0;
  let valueBytes = 0;
  for (let page = 0; page < 100_000; page += 1) {
    const result = await purgeProjectRecords(store, { ...options, cursor });
    scannedKeys += result.scannedKeys;
    deletedKeys += result.deletedKeys;
    valueBytes += result.valueBytes;
    if (result.complete) {
      return Object.freeze({ complete: true, scannedKeys, deletedKeys, valueBytes });
    }
    cursor = result.cursor;
  }
  throw new Error("Project purge did not converge.");
}
