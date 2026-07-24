import { createHash } from "node:crypto";
import { BM25_INDEX_VERSION } from "./index/bm25-keys.js";
import { NEAR_DUPLICATE_INDEX_VERSION } from "./index/simhash.js";
import { BM25_TOKENIZER_VERSION } from "./index/tokenizer.js";
import { KEYSPACE } from "./keys.js";
import { stableJson } from "./schema.js";

export const INDEX_NAMESPACE_MANIFEST_VERSION = 1;
export const INDEX_NAMESPACE_GC_PAGE_SIZE = 10_000;

const MANIFEST_KEY = Object.freeze([KEYSPACE.META, "active-index-namespaces"]);
const VERSIONED_FAMILIES = new Set(["bm25", "simhash"]);

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function activeDefinitions() {
  return Object.freeze([
    Object.freeze({
      family: "bm25",
      version: BM25_INDEX_VERSION,
      tokenizerVersion: BM25_TOKENIZER_VERSION,
      prefix: Object.freeze([
        KEYSPACE.POSTING,
        "bm25",
        BM25_INDEX_VERSION,
        BM25_TOKENIZER_VERSION,
      ]),
    }),
    Object.freeze({
      family: "simhash",
      version: NEAR_DUPLICATE_INDEX_VERSION,
      tokenizerVersion: BM25_TOKENIZER_VERSION,
      prefix: Object.freeze([
        KEYSPACE.POSTING,
        "simhash",
        NEAR_DUPLICATE_INDEX_VERSION,
        BM25_TOKENIZER_VERSION,
      ]),
    }),
  ]);
}

function manifestIdentity(active) {
  return {
    manifestVersion: INDEX_NAMESPACE_MANIFEST_VERSION,
    active: active.map(({ family, version, tokenizerVersion, prefix }) => ({
      family,
      version,
      tokenizerVersion,
      prefix,
    })),
  };
}

/** Describe the only versioned posting roots reachable by this reader. */
export function activeIndexNamespaceManifest(updatedAt = Date.now()) {
  const active = activeDefinitions();
  const identity = manifestIdentity(active);
  return Object.freeze({
    ...identity,
    fingerprint: createHash("sha256").update(stableJson(identity)).digest("hex"),
    updatedAt: timestamp(updatedAt, "updatedAt"),
  });
}

export const indexNamespaceKeys = Object.freeze({
  manifest() {
    return [...MANIFEST_KEY];
  },
});

function assertManifest(value) {
  const expected = activeIndexNamespaceManifest(0);
  if (!value || value.manifestVersion !== expected.manifestVersion
    || value.fingerprint !== expected.fingerprint
    || stableJson(manifestIdentity(value.active ?? []))
      !== stableJson(manifestIdentity(expected.active))) {
    const error = new Error(
      "Index namespace GC refused to run because the active-reader manifest is missing or stale.",
    );
    error.code = "ERR_INDEX_NAMESPACE_MANIFEST";
    throw error;
  }
  return value;
}

/** Publish the exact versioned posting prefixes reachable by this build. */
export async function ensureIndexNamespaceManifest(store, { now = Date.now() } = {}) {
  const expected = activeIndexNamespaceManifest(now);
  const current = await store.get(MANIFEST_KEY);
  if (current?.fingerprint === expected.fingerprint) return current;
  if (store.readOnly) {
    const error = new Error("A writable open is required to publish the active index namespace manifest.");
    error.code = "ERR_INDEX_NAMESPACE_MANIFEST";
    throw error;
  }
  await store.put(MANIFEST_KEY, expected, { kind: "active-index-namespace-manifest" });
  return expected;
}

function namespaceForKey(key) {
  if (!Array.isArray(key) || key[0] !== KEYSPACE.POSTING
    || !VERSIONED_FAMILIES.has(key[1])
    || !Number.isSafeInteger(key[2]) || key[2] <= 0
    || !Number.isSafeInteger(key[3]) || key[3] <= 0) {
    return undefined;
  }
  return Object.freeze({
    family: key[1],
    version: key[2],
    tokenizerVersion: key[3],
  });
}

function namespaceIdentity(namespace) {
  return `${namespace.family}\0${namespace.version}\0${namespace.tokenizerVersion}`;
}

function activeIdentities(manifest) {
  return new Set(manifest.active.map(namespaceIdentity));
}

function inventoryRow(namespace, active) {
  return {
    ...namespace,
    active,
    keyCount: 0,
    keyBytes: 0,
    valueBytes: 0,
    totalBytes: 0,
  };
}

/** Measure every known versioned posting namespace without mutating the store. */
export function inventoryIndexNamespaces(store) {
  const manifest = activeIndexNamespaceManifest(0);
  const reachable = activeIdentities(manifest);
  const rows = new Map();
  let after;
  for (;;) {
    const page = store.scan([KEYSPACE.POSTING], {
      limit: INDEX_NAMESPACE_GC_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
      fillCache: false,
    });
    for (const record of page) {
      const namespace = namespaceForKey(record.key);
      if (namespace === undefined) continue;
      const identity = namespaceIdentity(namespace);
      let row = rows.get(identity);
      if (row === undefined) {
        row = inventoryRow(namespace, reachable.has(identity));
        rows.set(identity, row);
      }
      row.keyCount += 1;
      row.keyBytes += record.keyBytes.length;
      row.valueBytes += record.storedValueBytes;
      row.totalBytes += record.keyBytes.length + record.storedValueBytes;
    }
    if (page.length < INDEX_NAMESPACE_GC_PAGE_SIZE) break;
    after = page.at(-1).keyBytes;
  }
  return Object.freeze([...rows.values()]
    .sort((left, right) => left.family.localeCompare(right.family)
      || left.version - right.version
      || left.tokenizerVersion - right.tokenizerVersion)
    .map((row) => Object.freeze({ ...row })));
}

/**
 * Inspect or delete one bounded page of posting records unreachable from the
 * active-reader manifest. Unknown posting families are never considered.
 */
export async function garbageCollectObsoleteIndexNamespaces(store, {
  reportOnly = true,
  limit = INDEX_NAMESPACE_GC_PAGE_SIZE,
  after,
} = {}) {
  const boundedLimit = positiveInteger(limit, "limit", 100_000);
  const persistedManifest = await store.get(MANIFEST_KEY);
  const manifest = reportOnly && persistedManifest === undefined
    ? activeIndexNamespaceManifest(0)
    : assertManifest(persistedManifest);
  const reachable = activeIdentities(manifest);
  const page = store.scan([KEYSPACE.POSTING], {
    limit: boundedLimit,
    ...(after === undefined ? {} : { after }),
    fillCache: false,
  });
  const obsolete = page.filter((record) => {
    const namespace = namespaceForKey(record.key);
    return namespace !== undefined && !reachable.has(namespaceIdentity(namespace));
  });
  const measured = obsolete.reduce((summary, record) => ({
    keyCount: summary.keyCount + 1,
    keyBytes: summary.keyBytes + record.keyBytes.length,
    valueBytes: summary.valueBytes + record.storedValueBytes,
    totalBytes: summary.totalBytes + record.keyBytes.length + record.storedValueBytes,
  }), { keyCount: 0, keyBytes: 0, valueBytes: 0, totalBytes: 0 });
  if (!reportOnly && obsolete.length > 0) {
    for (let offset = 0; offset < obsolete.length; offset += 256) {
      const batch = obsolete.slice(offset, offset + 256);
      await store.transaction(async (transaction) => {
        const current = await transaction.get(MANIFEST_KEY);
        assertManifest(current);
        for (const record of batch) await transaction.remove(record.keyBytes);
      });
    }
  }
  return Object.freeze({
    reportOnly,
    scannedKeys: page.length,
    ...measured,
    deletedKeys: reportOnly ? 0 : measured.keyCount,
    complete: page.length < boundedLimit,
    ...(page.length === 0 ? {} : { nextAfter: page.at(-1).keyBytes }),
    manifestFingerprint: manifest.fingerprint,
  });
}
