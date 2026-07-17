import { guardKeys, bumpGuard, warmGuard } from "./guards.js";
import { KEYSPACE } from "./keys.js";
import {
  AUXILIARY_MANIFEST_REFERENCE_VERSION,
  auxiliaryManifestIdentityForDocument,
  manifestKeys,
} from "./manifests.js";
import { SchemaCompatibilityError } from "./schema.js";

export const AUXILIARY_OWNERSHIP_INDEX_FORMAT_VERSION = 1;
// A document manifest can contain several MiB of bounded metadata and source
// provenance. Upgrade one record at a time so daemon startup never retains a
// count-sized page of full manifests.
const BACKFILL_PAGE_SIZE = 1;

export const auxiliaryOwnershipIndexKeys = Object.freeze({
  state() {
    return [KEYSPACE.META, "auxiliary-ownership-index"];
  },
});

function referencePayload(identity, manifest) {
  return Object.freeze({
    referenceVersion: AUXILIARY_MANIFEST_REFERENCE_VERSION,
    kind: identity.kind,
    manifestId: identity.manifestId,
    manifestVersion: identity.version,
    documentId: manifest.documentId,
    documentVersion: manifest.version,
  });
}

function initialState() {
  return Object.freeze({
    formatVersion: AUXILIARY_OWNERSHIP_INDEX_FORMAT_VERSION,
    status: "indexing",
    after: null,
    indexedOwners: 0,
  });
}

function completeState(indexedOwners) {
  return Object.freeze({
    formatVersion: AUXILIARY_OWNERSHIP_INDEX_FORMAT_VERSION,
    status: "complete",
    after: null,
    indexedOwners,
  });
}

function assertState(value) {
  if (!value || value.formatVersion !== AUXILIARY_OWNERSHIP_INDEX_FORMAT_VERSION
    || !["indexing", "complete"].includes(value.status)
    || (value.after !== null && typeof value.after !== "string")
    || !Number.isSafeInteger(value.indexedOwners) || value.indexedOwners < 0) {
    throw new SchemaCompatibilityError("Auxiliary ownership index state is missing or malformed.");
  }
  return value;
}

function sameState(left, right) {
  return left?.formatVersion === right.formatVersion
    && left?.status === right.status
    && left?.after === right.after
    && left?.indexedOwners === right.indexedOwners;
}

/**
 * Upgrade pre-owner-index stores before serving reads or retention. The scan is
 * paged and crash-resumable, and runs only once for an existing store. A fresh
 * store starts complete because every admission writes its owner reference in
 * the canonical transaction.
 */
export async function ensureAuxiliaryOwnershipIndex(store, { fresh = false } = {}) {
  const stateKey = auxiliaryOwnershipIndexKeys.state();
  let state = await store.get(stateKey);
  if (state === undefined && fresh) {
    if (store.readOnly) {
      throw new SchemaCompatibilityError("Cannot initialize auxiliary ownership in read-only mode.");
    }
    state = completeState(0);
    await store.put(stateKey, state, { kind: "auxiliary-ownership-index-state" });
    return state;
  }
  if (state === undefined) {
    if (store.readOnly) {
      throw new SchemaCompatibilityError(
        "This RocksDB store requires a writable auxiliary ownership upgrade before read-only use.",
      );
    }
    state = initialState();
    await store.put(stateKey, state, { kind: "auxiliary-ownership-index-state" });
  } else {
    state = assertState(state);
  }
  if (state.status === "complete") return state;
  if (store.readOnly) {
    throw new SchemaCompatibilityError(
      "This RocksDB store has an incomplete auxiliary ownership upgrade.",
    );
  }

  while (state.status === "indexing") {
    const page = store.scan([KEYSPACE.DOCUMENT], {
      limit: BACKFILL_PAGE_SIZE,
      ...(state.after === null ? {} : { after: Buffer.from(state.after, "base64url") }),
    });
    if (page.length === 0) {
      const next = completeState(state.indexedOwners);
      await store.get(stateKey);
      await store.transaction(async (transaction) => {
        const current = await transaction.get(stateKey);
        if (!sameState(current, state)) {
          throw new SchemaCompatibilityError("Auxiliary ownership upgrade state changed unexpectedly.");
        }
        await transaction.put(stateKey, next, { kind: "auxiliary-ownership-index-state" });
      });
      state = next;
      break;
    }

    const owners = page.flatMap(({ payload: manifest }) => {
      const identity = auxiliaryManifestIdentityForDocument(manifest);
      if (identity === undefined || identity.managed) return [];
      return [{
        identity,
        guard: guardKeys.auxiliaryManifest(identity.kind, identity.manifestId, identity.version),
        referenceKey: manifestKeys.auxiliaryManifestReference(
          identity.kind,
          identity.manifestId,
          identity.version,
          manifest.documentId,
          manifest.version,
        ),
        payload: referencePayload(identity, manifest),
      }];
    });
    for (const owner of owners) {
      await warmGuard(store, owner.guard);
      await store.get(owner.referenceKey);
    }
    await store.get(stateKey);
    const next = Object.freeze({
      formatVersion: AUXILIARY_OWNERSHIP_INDEX_FORMAT_VERSION,
      status: "indexing",
      after: page.at(-1).keyBytes.toString("base64url"),
      indexedOwners: state.indexedOwners + owners.length,
    });
    await store.transaction(async (transaction) => {
      const current = await transaction.get(stateKey);
      if (!sameState(current, state)) {
        throw new SchemaCompatibilityError("Auxiliary ownership upgrade state changed unexpectedly.");
      }
      for (const owner of owners) {
        await bumpGuard(transaction, owner.guard);
        await transaction.putImmutable(
          owner.referenceKey,
          owner.payload,
          { kind: "auxiliary-manifest-reference" },
        );
      }
      await transaction.put(stateKey, next, { kind: "auxiliary-ownership-index-state" });
    });
    state = next;
  }
  return state;
}
