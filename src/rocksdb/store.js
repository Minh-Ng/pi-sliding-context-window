import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { RocksDatabase, versions as bindingVersions } from "@harperfast/rocksdb-js";
import { ensureSecureStoreDirectory } from "../daemon/paths.js";
import {
  decodeKey,
  encodeKey,
  encodedKey,
  KEYSPACE,
  keyFor,
  prefixBounds,
  prefixSuccessor,
} from "./keys.js";
import { ensureAuxiliaryOwnershipIndex } from "./auxiliary-ownership.js";
import {
  assertSchemaCompatible,
  CURRENT_SCHEMA,
  decodeRecord,
  encodeRecord,
  schemaMetadata,
  SchemaCompatibilityError,
  STORE_SCHEMA_VERSION,
} from "./schema.js";

const DEFAULT_SCAN_LIMIT = 1_000;
const MAX_SCAN_LIMIT = 100_000;

// rocksdb-js 2.4.0 encodes binary keys into one fixed 4 KiB shared buffer.
// Exact operations use the whole buffer; iterators place both range bounds in
// that same buffer. Keep these checks at our native adapter boundary even
// though the portable tuple encoding supports larger keys.
export const MAX_ROCKSDB_KEY_BYTES = 4_096;
export const MAX_ROCKSDB_SCAN_BOUND_BYTES = 4_096;
// A persisted key can later become both a scan prefix and a pagination cursor.
// Two 2,047-byte bounds plus scan.after's trailing exclusive byte still fit
// in the binding's shared 4 KiB iterator buffer.
export const MAX_ROCKSDB_PERSISTED_KEY_BYTES = 2_047;

function activeSharedWriteLease(value) {
  return value?.kind === "shared-write-lease" && value.active === true;
}

function activeExclusiveWriteLease(value) {
  return value?.kind === "exclusive-write-lease" && value.active === true;
}

function registerWriteDescendant(lease, callback) {
  let operation;
  try {
    operation = Promise.resolve(callback());
  } catch (error) {
    operation = Promise.reject(error);
  }
  lease.pending.add(operation);
  operation.then(
    () => lease.pending.delete(operation),
    () => lease.pending.delete(operation),
  );
  return operation;
}

async function settleWriteDescendants(lease) {
  while (lease.pending.size > 0) {
    await Promise.allSettled([...lease.pending]);
  }
}

class WriteBarrier {
  constructor() {
    this.shared = 0;
    this.exclusive = undefined;
    this.waiters = [];
  }

  acquireShared() {
    return new Promise((resolve) => {
      this.waiters.push({ kind: "shared", resolve });
      this.drain();
    });
  }

  tryAcquireShared() {
    if (this.exclusive !== undefined || this.waiters.length > 0) return undefined;
    this.shared += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.shared -= 1;
      this.drain();
    };
  }

  acquireExclusive() {
    return new Promise((resolve) => {
      this.waiters.push({ kind: "exclusive", resolve });
      this.drain();
    });
  }

  owns(token) {
    return token !== undefined && token === this.exclusive;
  }

  drain() {
    if (this.exclusive !== undefined || this.waiters.length === 0) return;
    const first = this.waiters[0];
    if (first.kind === "exclusive") {
      if (this.shared !== 0) return;
      this.waiters.shift();
      const token = Symbol("rocksdb-exclusive-write-barrier");
      this.exclusive = token;
      let released = false;
      first.resolve({
        token,
        release: () => {
          if (released) return;
          released = true;
          this.exclusive = undefined;
          this.drain();
        },
      });
      return;
    }
    while (this.waiters[0]?.kind === "shared" && this.exclusive === undefined) {
      const waiter = this.waiters.shift();
      this.shared += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.shared -= 1;
        this.drain();
      });
    }
  }
}

export class StoreClosedError extends Error {
  constructor() {
    super("The RocksDB store is closed.");
    this.name = "StoreClosedError";
    this.code = "ERR_ROCKSDB_STORE_CLOSED";
  }
}

export class ImmutableRecordConflictError extends Error {
  constructor(key) {
    super(`Immutable record ${key.toString("base64url")} already exists with different bytes.`);
    this.name = "ImmutableRecordConflictError";
    this.code = "ERR_ROCKSDB_IMMUTABLE_CONFLICT";
    this.key = Buffer.from(key);
  }
}

export class IdempotencyConflictError extends Error {
  constructor(requestId) {
    super(`Idempotency key ${requestId} was already committed with a different request.`);
    this.name = "IdempotencyConflictError";
    this.code = "ERR_ROCKSDB_IDEMPOTENCY_CONFLICT";
    this.requestId = requestId;
  }
}

export class CanonicalTransitionConflictError extends Error {
  constructor(key) {
    super(`Canonical transition ${key.toString("base64url")} no longer has its expected previous value.`);
    this.name = "CanonicalTransitionConflictError";
    this.code = "CONFLICT";
    this.key = Buffer.from(key);
  }
}

export class StoreKeySizeError extends RangeError {
  constructor(actualBytes, maxBytes, boundary = "key") {
    super(`Encoded RocksDB ${boundary} is ${actualBytes} bytes; the maximum is ${maxBytes}.`);
    this.name = "StoreKeySizeError";
    this.code = "INVALID_REQUEST";
    this.details = Object.freeze({ actualBytes, boundary, maxBytes });
  }
}

function assertNativeKeySize(bytes, boundary = "key") {
  if (bytes.length > MAX_ROCKSDB_KEY_BYTES) {
    throw new StoreKeySizeError(bytes.length, MAX_ROCKSDB_KEY_BYTES, boundary);
  }
  return bytes;
}

function keyBytes(key, boundary = "key") {
  const bytes = Array.isArray(key) ? encodeKey(key) : encodedKey(key);
  return assertNativeKeySize(bytes, boundary);
}

export function assertPersistableKey(key, boundary = "persisted key") {
  const bytes = Array.isArray(key) ? encodeKey(key) : encodedKey(key);
  if (bytes.length > MAX_ROCKSDB_PERSISTED_KEY_BYTES) {
    throw new StoreKeySizeError(bytes.length, MAX_ROCKSDB_PERSISTED_KEY_BYTES, boundary);
  }
  return bytes;
}

function nativePrefixBounds(prefix, boundary = "key prefix") {
  const bounds = prefixBounds(prefix);
  assertNativeKeySize(bounds.start, `${boundary} start`);
  assertNativeKeySize(bounds.end, `${boundary} end`);
  return bounds;
}

function assertNativeScanBounds(start, end) {
  const actualBytes = start.length + end.length;
  if (actualBytes > MAX_ROCKSDB_SCAN_BOUND_BYTES) {
    throw new StoreKeySizeError(
      actualBytes,
      MAX_ROCKSDB_SCAN_BOUND_BYTES,
      "scan bounds",
    );
  }
}

function scanLimit(value) {
  if (value === undefined) return DEFAULT_SCAN_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SCAN_LIMIT) {
    throw new RangeError(`Scan limit must be between 0 and ${MAX_SCAN_LIMIT}.`);
  }
  return value;
}

function kindForKey(key) {
  const [kind] = decodeKey(key);
  return typeof kind === "string" && kind.length > 0 ? kind : "record";
}

function writeBytes(key, payload, options = {}) {
  return encodeRecord({
    kind: options.kind ?? kindForKey(key),
    payload,
    recordVersion: options.recordVersion ?? 1,
    schemaVersion: options.schemaVersion ?? STORE_SCHEMA_VERSION,
  });
}

async function rawGet(dbi, key) {
  const value = await dbi.get(key);
  return value === undefined ? undefined : Buffer.from(value);
}

function rawGetSync(dbi, key) {
  const value = dbi.getSync(key);
  return value === undefined ? undefined : Buffer.from(value);
}

function rawHasKey(dbi, key) {
  const end = prefixSuccessor(key);
  if (end === undefined) return false;
  assertNativeScanBounds(key, end);
  for (const { key: candidate } of dbi.getRange({
    start: key,
    end,
    limit: 1,
    values: false,
    fillCache: false,
  })) {
    return Buffer.from(candidate).equals(key);
  }
  return false;
}

async function immutablePut(dbi, key, value) {
  const existing = await rawGet(dbi, key);
  if (existing === undefined) {
    await dbi.put(key, value);
    return "inserted";
  }
  if (!existing.equals(value)) throw new ImmutableRecordConflictError(key);
  return "unchanged";
}

function immutablePutSync(dbi, key, value) {
  const existing = rawGetSync(dbi, key);
  if (existing === undefined) {
    dbi.putSync(key, value);
    return "inserted";
  }
  if (!existing.equals(value)) throw new ImmutableRecordConflictError(key);
  return "unchanged";
}

function payloadFromBytes(value) {
  return value === undefined ? undefined : decodeRecord(value).payload;
}

function bumpGuardSync(dbi, key) {
  const current = payloadFromBytes(rawGetSync(dbi, key));
  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new RangeError("Conflict guard revision overflowed.");
  }
  dbi.putSync(key, writeBytes(key, { revision }, { kind: "conflict-guard" }));
  return revision;
}

function recordResult(key, value) {
  const record = decodeRecord(value);
  const result = {
    key: decodeKey(key),
    keyBytes: Buffer.from(key),
    ...record,
  };
  // Status and maintenance scans need to bound work by the bytes RocksDB
  // actually returned without serializing an already-decoded payload again.
  // Keep this transport detail out of the public/enumerable record shape.
  Object.defineProperty(result, "storedValueBytes", {
    configurable: false,
    enumerable: false,
    value: value.byteLength,
    writable: false,
  });
  return result;
}

class StoreView {
  constructor(owner, dbi, { readOnly = false, syncReads = false } = {}) {
    this.owner = owner;
    this.dbi = dbi;
    this.readOnly = readOnly;
    this.syncReads = syncReads;
  }

  async getRecord(key) {
    this.owner.assertOpen();
    const encoded = keyBytes(key);
    // rocksdb-js transactions reject a cold blob-file read through their
    // asynchronous get path ("no disk I/O allowed"). The synchronous native
    // path performs that I/O while retaining optimistic conflict tracking.
    const value = this.syncReads
      ? rawGetSync(this.dbi, encoded)
      : await rawGet(this.dbi, encoded);
    return value === undefined ? undefined : recordResult(encoded, value);
  }

  async get(key) {
    return (await this.getRecord(key))?.payload;
  }

  async has(key) {
    return (await this.getRecord(key)) !== undefined;
  }

  async hasKey(key) {
    this.owner.assertOpen();
    return rawHasKey(this.dbi, keyBytes(key));
  }

  async put(key, payload, options = {}) {
    this.owner.assertOpen();
    if (this.readOnly) throw new TypeError("Snapshot views are read-only.");
    const encoded = assertPersistableKey(key);
    await this.dbi.put(encoded, writeBytes(encoded, payload, options));
  }

  async putImmutable(key, payload, options = {}) {
    this.owner.assertOpen();
    if (this.readOnly) throw new TypeError("Snapshot views are read-only.");
    const encoded = assertPersistableKey(key);
    const value = writeBytes(encoded, payload, options);
    // Optimistic transactions cannot perform a cold asynchronous read. Match
    // getRecord's transaction-safe path when checking immutable key identity,
    // including after an ungraceful restart has emptied the block cache.
    return this.syncReads
      ? immutablePutSync(this.dbi, encoded, value)
      : immutablePut(this.dbi, encoded, value);
  }

  async remove(key) {
    this.owner.assertOpen();
    if (this.readOnly) throw new TypeError("Snapshot views are read-only.");
    await this.dbi.remove(keyBytes(key));
  }

  *iterate(prefix, options = {}) {
    this.owner.assertOpen();
    const limit = scanLimit(options.limit);
    if (limit === 0) return;
    const bounds = nativePrefixBounds(prefix, "scan prefix");
    let { start, end } = bounds;
    if (options.after !== undefined) {
      if (options.reverse === true) throw new TypeError("scan.after is only supported for forward scans.");
      const after = keyBytes(options.after);
      if (Buffer.compare(after, bounds.start) < 0 || Buffer.compare(after, bounds.end) >= 0) {
        throw new RangeError("scan.after must identify a key inside the requested prefix.");
      }
      // Encoded tuple keys may themselves prefix a longer tuple. Advancing to
      // prefixSuccessor(after) would skip every child of such a key. Field
      // tags are non-zero, so appending NUL is a strict lower bound that keeps
      // all valid child tuples in the next page while excluding `after`.
      const exclusiveStart = Buffer.concat([after, Buffer.from([0])]);
      if (Buffer.compare(exclusiveStart, end) >= 0) return;
      start = exclusiveStart;
    }
    assertNativeScanBounds(start, end);
    // rocksdb-js expresses reverse ranges from the upper bound down to the
    // lower bound, unlike its forward lower-to-upper convention.
    const rangeStart = options.reverse === true ? end : start;
    const rangeEnd = options.reverse === true ? start : end;
    for (const { key, value } of this.dbi.getRange({
      start: rangeStart,
      end: rangeEnd,
      reverse: options.reverse === true,
      limit,
      fillCache: options.fillCache === true,
    })) {
      yield recordResult(Buffer.from(key), Buffer.from(value));
    }
  }

  scan(prefix, options = {}) {
    return [...this.iterate(prefix, options)];
  }

  async increment(name) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("Counter name must be a non-empty string.");
    }
    const key = keyFor.counter(name);
    const current = await this.get(key);
    const value = current === undefined ? 1 : current + 1;
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Counter ${name} overflowed.`);
    await this.put(key, value, { kind: "counter" });
    return value;
  }
}

function normalizeCanonicalRecord(candidate, label) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (!("payload" in candidate) && !("value" in candidate)) {
    throw new TypeError(`${label} must contain payload.`);
  }
  const key = assertPersistableKey(candidate.key ?? candidate.keyParts, "canonical key");
  const payload = "payload" in candidate ? candidate.payload : candidate.value;
  const value = writeBytes(key, payload, {
    kind: candidate.kind,
    recordVersion: candidate.recordVersion,
  });
  return { key, value };
}

function normalizeCanonicalTransition(candidate, label) {
  if (!candidate || !Object.hasOwn(candidate, "previous")) {
    throw new TypeError(`${label} must contain its expected previous payload.`);
  }
  const next = normalizeCanonicalRecord(candidate, label);
  const previous = candidate.previous === undefined
    ? undefined
    : normalizeCanonicalRecord({
        key: candidate.key ?? candidate.keyParts,
        kind: candidate.kind,
        payload: candidate.previous,
        recordVersion: candidate.recordVersion,
      }, `${label}.previous`);
  return { ...next, previous: previous?.value };
}

function normalizeOutboxPayload(candidate, requestId, recordKeys) {
  if (candidate === undefined) return { requestId, recordKeys };
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("outbox must be an object.");
  }
  if (candidate.key !== undefined || candidate.keyParts !== undefined) {
    throw new TypeError("outbox keys are allocated atomically by RocksStore.");
  }
  const payload = "payload" in candidate ? candidate.payload : candidate.value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    throw new TypeError("outbox payload must be a plain JSON object.");
  }
  if (Object.hasOwn(payload, "sequence")) {
    throw new TypeError("outbox.sequence is allocated atomically by RocksStore.");
  }
  return payload;
}

function hashLength(hash, length) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(length);
  hash.update(bytes);
}

function requestFingerprint(entries) {
  const hash = createHash("sha256");
  for (const { key, value } of entries) {
    hashLength(hash, key.length);
    hash.update(key);
    hashLength(hash, value.length);
    hash.update(value);
  }
  return hash.digest("hex");
}

function comparePrepared(left, right) {
  return Buffer.compare(left.key, right.key);
}

export class RocksStore {
  static async open(path, options = {}) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("RocksDB path must be a non-empty string.");
    const absolutePath = ensureSecureStoreDirectory(path);
    const database = RocksDatabase.open(absolutePath, {
      encoding: "binary",
      keyEncoding: "binary",
      disableWAL: false,
      enableStats: options.enableStats === true,
      parallelismThreads: options.parallelismThreads,
      readOnly: options.readOnly === true,
      noBlockCache: options.noBlockCache,
      dbWriteBufferSize: options.dbWriteBufferSize,
      writeBufferSize: options.writeBufferSize,
      maxWriteBufferNumber: options.maxWriteBufferNumber,
    });
    const store = new RocksStore(absolutePath, database, options);
    try {
      const fresh = await store.initializeSchema();
      await ensureAuxiliaryOwnershipIndex(store, { fresh });
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  constructor(path, database, options = {}) {
    this.path = path;
    this.database = database;
    this.readOnly = options.readOnly === true;
    this.schema = undefined;
    this.view = new StoreView(this, database);
    this.writeBarrier = new WriteBarrier();
    this.writeBarrierContext = new AsyncLocalStorage();
  }

  assertOpen() {
    if (!this.database?.isOpen()) throw new StoreClosedError();
  }

  async initializeSchema() {
    this.assertOpen();
    const schemaKey = keyBytes(keyFor.schema(), "schema key");
    let stored = await rawGet(this.database, schemaKey);
    const fresh = stored === undefined;
    if (stored === undefined) {
      if (this.readOnly) {
        throw new SchemaCompatibilityError("Cannot initialize an empty RocksDB store in read-only mode.");
      }
      const initial = encodeRecord({ kind: "schema", payload: schemaMetadata() });
      await this.database.transaction(async (transaction) => {
        await immutablePut(transaction, schemaKey, initial);
      }, { retryOnBusy: true, maxRetries: 5 });
      stored = await rawGet(this.database, schemaKey);
    }
    const record = decodeRecord(stored);
    if (record.kind !== "schema") {
      throw new SchemaCompatibilityError(`Schema metadata has unexpected record kind ${record.kind}.`);
    }
    this.schema = assertSchemaCompatible(record.payload);
    return fresh;
  }

  isOpen() {
    return this.database?.isOpen() === true;
  }

  close() {
    if (this.database?.isOpen()) this.database.close();
  }

  get(key) {
    return this.view.get(key);
  }

  getRecord(key) {
    return this.view.getRecord(key);
  }

  getCanonical(key) {
    return this.getRecord(key);
  }

  has(key) {
    return this.view.has(key);
  }

  hasKey(key) {
    return this.view.hasKey(key);
  }

  async put(key, payload, options = {}) {
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    return this.withSharedWrite(() => this.view.put(key, payload, options));
  }

  async putImmutable(key, payload, options = {}) {
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    const encoded = assertPersistableKey(key);
    return this.transaction((transaction) => transaction.putImmutable(encoded, payload, options));
  }

  async remove(key) {
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    return this.withSharedWrite(() => this.view.remove(key));
  }

  scan(prefix, options = {}) {
    return this.view.scan(prefix, options);
  }

  iterate(prefix, options = {}) {
    return this.view.iterate(prefix, options);
  }

  async transaction(callback, options = {}) {
    this.assertOpen();
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    if (typeof callback !== "function") throw new TypeError("Transaction callback must be a function.");
    return this.withSharedWrite(() => this.database.transaction(
      (transaction, attempt) => callback(new StoreView(this, transaction, { syncReads: true }), attempt),
      {
        retryOnBusy: options.retryOnBusy ?? true,
        maxRetries: options.maxRetries ?? 5,
      },
    ));
  }

  async withSharedWrite(callback) {
    const activeContext = this.writeBarrierContext.getStore();
    if (activeSharedWriteLease(activeContext)) {
      return registerWriteDescendant(activeContext, callback);
    }
    if (activeExclusiveWriteLease(activeContext)
      && this.writeBarrier.owns(activeContext.token)) {
      return registerWriteDescendant(activeContext, callback);
    }
    const release = this.writeBarrier.tryAcquireShared()
      ?? await this.writeBarrier.acquireShared();
    const lease = { kind: "shared-write-lease", active: true, pending: new Set() };
    let result;
    let failure;
    try {
      try {
        result = await this.writeBarrierContext.run(lease, callback);
      } catch (error) {
        failure = error;
      }
      try {
        await settleWriteDescendants(lease);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
      return result;
    } finally {
      lease.active = false;
      release();
    }
  }

  /**
   * Exclude logical writes while maintenance takes a stable scan-and-rewrite
   * view. Reads remain available and writes resume in FIFO order afterward.
   */
  async withExclusiveWrites(callback) {
    if (typeof callback !== "function") throw new TypeError("Exclusive write maintenance requires a callback.");
    const activeContext = this.writeBarrierContext.getStore();
    if (activeExclusiveWriteLease(activeContext)
      && this.writeBarrier.owns(activeContext.token)) {
      return registerWriteDescendant(activeContext, callback);
    }
    if (activeSharedWriteLease(activeContext)) {
      throw new TypeError("A shared write lease cannot be upgraded to an exclusive write lease.");
    }
    const { token, release } = await this.writeBarrier.acquireExclusive();
    const lease = {
      kind: "exclusive-write-lease",
      active: true,
      pending: new Set(),
      token,
    };
    let result;
    let failure;
    try {
      try {
        result = await this.writeBarrierContext.run(lease, callback);
      } catch (error) {
        failure = error;
      }
      await settleWriteDescendants(lease);
      if (failure !== undefined) throw failure;
      return result;
    } finally {
      lease.active = false;
      release();
    }
  }

  /** Run a consistent, read-only callback against a RocksDB transaction snapshot. */
  async snapshot(callback) {
    this.assertOpen();
    if (typeof callback !== "function") throw new TypeError("Snapshot callback must be a function.");
    return this.database.transaction(
      (transaction) => callback(new StoreView(this, transaction, {
        readOnly: true,
        syncReads: true,
      })),
      { disableSnapshot: false, retryOnBusy: true, maxRetries: 5 },
    );
  }

  async increment(name) {
    return this.transaction((transaction) => transaction.increment(name));
  }

  /**
   * Atomically commit immutable canonical records, a durable outbox entry, and
   * an idempotency marker. Resolution is the write acknowledgement boundary;
   * the native binding's WAL is always enabled.
   */
  async commitCanonical({
    requestId,
    records,
    outbox,
    guards = [],
    mustBeAbsent = [],
    mustMatch = [],
    transitions = [],
  } = {}) {
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new TypeError("Canonical commits require a non-empty requestId.");
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new TypeError("Canonical commits require at least one record.");
    }

    const preparedRecords = records
      .map((record, index) => normalizeCanonicalRecord(record, `records[${index}]`))
      .sort(comparePrepared);
    if (!Array.isArray(transitions)) throw new TypeError("Canonical commit transitions must be an array.");
    const preparedTransitions = transitions
      .map((transition, index) => normalizeCanonicalTransition(transition, `transitions[${index}]`))
      .sort(comparePrepared);
    if (!Array.isArray(guards)) throw new TypeError("Canonical commit guards must be an array.");
    const preparedGuards = [...new Map(guards.map((guard, index) => {
      const key = assertPersistableKey(guard, "canonical guard key");
      return [key.toString("base64url"), key];
    })).values()].sort(Buffer.compare);
    if (!Array.isArray(mustBeAbsent)) {
      throw new TypeError("Canonical commit mustBeAbsent preconditions must be an array.");
    }
    const absentKeys = [...new Map(mustBeAbsent.map((candidate) => {
      const key = assertPersistableKey(candidate, "canonical precondition key");
      return [key.toString("base64url"), key];
    })).values()].sort(Buffer.compare);
    if (!Array.isArray(mustMatch)) {
      throw new TypeError("Canonical commit mustMatch preconditions must be an array.");
    }
    const matchingRecords = mustMatch
      .map((candidate, index) => normalizeCanonicalRecord(candidate, `mustMatch[${index}]`))
      .sort(comparePrepared);
    const recordKeys = preparedRecords.map(({ key }) => key.toString("base64url"));
    const outboxPayload = normalizeOutboxPayload(outbox, requestId, recordKeys);
    const fingerprintOutbox = normalizeCanonicalRecord({
      key: [KEYSPACE.OUTBOX, 0],
      kind: "outbox",
      payload: outboxPayload,
    }, "outbox");
    const fingerprintGuards = preparedGuards.map((key) => ({ key, value: Buffer.from("conflict-guard", "ascii") }));
    const fingerprintEntries = [
      ...preparedRecords,
      ...preparedTransitions,
      fingerprintOutbox,
      ...fingerprintGuards,
    ].sort(comparePrepared);
    for (let index = 1; index < fingerprintEntries.length; index += 1) {
      if (fingerprintEntries[index - 1].key.equals(fingerprintEntries[index].key)
        && !fingerprintEntries[index - 1].value.equals(fingerprintEntries[index].value)) {
        throw new ImmutableRecordConflictError(fingerprintEntries[index].key);
      }
    }
    const fingerprint = requestFingerprint(fingerprintEntries);
    const markerKey = keyFor.idempotency(requestId);
    const committedAt = Date.now();

    const encodedMarkerKey = assertPersistableKey(markerKey, "canonical idempotency key");
    const encodedCounterKey = keyBytes(keyFor.counter("outbox"));
    return this.transaction((transaction) => {
      const marker = payloadFromBytes(rawGetSync(transaction.dbi, encodedMarkerKey));
      if (marker !== undefined) {
        if (marker.fingerprint !== fingerprint) throw new IdempotencyConflictError(requestId);
        return {
          requestId,
          duplicate: true,
          fingerprint,
          recordKeys: marker.recordKeys,
          outboxKey: marker.outboxKey,
          outboxSequence: marker.outboxSequence,
        };
      }
      for (const key of absentKeys) {
        if (rawGetSync(transaction.dbi, key) !== undefined) {
          const error = new Error(
            `Canonical admission precondition failed because ${key.toString("base64url")} already exists.`,
          );
          error.code = "SUPERSEDED";
          throw error;
        }
      }
      for (const record of matchingRecords) {
        const current = rawGetSync(transaction.dbi, record.key);
        if (current === undefined || !current.equals(record.value)) {
          throw new CanonicalTransitionConflictError(record.key);
        }
      }
      for (const transition of preparedTransitions) {
        const current = rawGetSync(transaction.dbi, transition.key);
        if ((current === undefined) !== (transition.previous === undefined)
          || (current !== undefined && !current.equals(transition.previous))) {
          throw new CanonicalTransitionConflictError(transition.key);
        }
      }
      const recordsToInsert = [];
      for (const entry of preparedRecords) {
        const current = rawGetSync(transaction.dbi, entry.key);
        if (current === undefined) recordsToInsert.push(entry);
        else if (!current.equals(entry.value)) throw new ImmutableRecordConflictError(entry.key);
      }
      for (const guard of preparedGuards) bumpGuardSync(transaction.dbi, guard);
      // Synchronous native reads can load blob-backed values while preserving
      // transaction conflict tracking. The callback is replay-safe and avoids
      // one promise/microtask per canonical key on the hot admission path.
      for (const entry of recordsToInsert) transaction.dbi.putSync(entry.key, entry.value);
      for (const transition of preparedTransitions) {
        transaction.dbi.putSync(transition.key, transition.value);
      }
      const currentCounter = payloadFromBytes(rawGetSync(transaction.dbi, encodedCounterKey));
      const outboxSequence = (currentCounter ?? 0) + 1;
      if (!Number.isSafeInteger(outboxSequence) || outboxSequence <= 0) {
        throw new RangeError("Counter outbox overflowed.");
      }
      transaction.dbi.putSync(
        encodedCounterKey,
        writeBytes(encodedCounterKey, outboxSequence, { kind: "counter" }),
      );
      const preparedOutbox = normalizeCanonicalRecord({
        key: [KEYSPACE.OUTBOX, outboxSequence],
        kind: "outbox",
        payload: { ...outboxPayload, sequence: outboxSequence },
      }, "outbox");
      immutablePutSync(transaction.dbi, preparedOutbox.key, preparedOutbox.value);
      const outboxKey = preparedOutbox.key.toString("base64url");
      immutablePutSync(transaction.dbi, encodedMarkerKey, writeBytes(encodedMarkerKey, {
        requestId,
        fingerprint,
        recordKeys,
        outboxKey,
        outboxSequence,
        committedAt,
      }, { kind: "idempotency" }));
      return {
        requestId,
        duplicate: false,
        fingerprint,
        recordKeys,
        outboxKey,
        outboxSequence,
      };
    });
  }

  async flush() {
    this.assertOpen();
    if (this.readOnly) return;
    await this.database.flush();
  }

  async compact(options = {}) {
    this.assertOpen();
    if (this.readOnly) throw new TypeError("The RocksDB store is read-only.");
    if (options.prefix !== undefined) {
      await this.database.compact(nativePrefixBounds(options.prefix, "compaction prefix"));
      return;
    }
    const range = {};
    if (options.start !== undefined) range.start = keyBytes(options.start);
    if (options.end !== undefined) range.end = keyBytes(options.end);
    await this.database.compact(range);
  }

  async createCheckpoint(path) {
    this.assertOpen();
    await this.database.createCheckpoint(resolve(path));
  }

  properties() {
    this.assertOpen();
    const integer = (name) => this.database.getDBIntProperty(name) ?? 0;
    return {
      estimatedKeys: this.database.getEstimatedKeyCount(),
      liveDataBytes: integer("rocksdb.estimate-live-data-size"),
      totalSstBytes: integer("rocksdb.total-sst-files-size"),
      pendingCompactionBytes: integer("rocksdb.estimate-pending-compaction-bytes"),
      liveSnapshots: integer("rocksdb.num-snapshots"),
      levelStats: this.database.getDBProperty("rocksdb.levelstats") ?? "",
    };
  }

  status() {
    this.assertOpen();
    return {
      path: this.path,
      open: true,
      readOnly: this.readOnly,
      schema: this.schema,
      currentSchema: CURRENT_SCHEMA,
      bindingVersions: { ...bindingVersions },
      properties: this.properties(),
    };
  }
}
