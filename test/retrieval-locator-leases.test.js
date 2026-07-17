import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeLocator,
  getOrCreateLocatorSecret,
  LocatorError,
  signLocator,
  verifyLocator,
} from "../src/retrieval/locator.js";
import {
  cleanupExpiredLeases,
  createRetrievalLease,
  hasActiveDocumentLease,
  leaseKeys,
  readLease,
  releaseLease,
  validateRetrievalLease,
} from "../src/retrieval/leases.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function claims(overrides = {}) {
  return {
    locatorVersion: 1,
    documentId: "doc-雪",
    documentVersion: 2,
    windowOrdinal: 3,
    matchRange: { startByte: 12, endByte: 27 },
    indexGeneration: 9,
    leaseId: "lease-1",
    project: "/workspace/one",
    sessionId: "session-child",
    scope: "session",
    issuedAt: 1_000,
    expiresAt: 61_000,
    ...overrides,
  };
}

test("locator signing key is persisted atomically and survives reopen", async (t) => {
  const path = temporaryStore(t, "locator-secret");
  const store = await RocksStore.open(path);
  const [first, second] = await Promise.all([
    getOrCreateLocatorSecret(store, { now: 10 }),
    getOrCreateLocatorSecret(store, { now: 20 }),
  ]);
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  store.close();

  const reopened = await RocksStore.open(path);
  t.after(() => reopened.close());
  assert.deepEqual(await getOrCreateLocatorSecret(reopened), first);
  await assert.rejects(
    getOrCreateLocatorSecret(reopened, { secret: Buffer.alloc(32, 0x7f) }),
    LocatorError,
  );
});

test("opaque locators authenticate every claim and enforce authorization", () => {
  const secret = Buffer.alloc(32, 0x42);
  const locator = signLocator(claims(), secret);
  assert.match(locator, /^cw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.deepEqual(verifyLocator(locator, secret), claims());
  assert.deepEqual(authorizeLocator(locator, secret, {
    project: "/workspace/one",
    sessionIds: ["session-current", "session-child"],
  }), claims());

  const parts = locator.split(".");
  const tamperedPayload = `${parts[0]}.${parts[1].slice(0, -1)}A.${parts[2]}`;
  const tamperedMac = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => verifyLocator(tamperedPayload, secret), LocatorError);
  assert.throws(() => verifyLocator(tamperedMac, secret), LocatorError);
  assert.throws(() => verifyLocator(locator, Buffer.alloc(32, 0x43)), LocatorError);
  assert.throws(() => authorizeLocator(locator, secret, {
    project: "/workspace/two",
  }), /project boundary/u);
  assert.throws(() => authorizeLocator(locator, secret, {
    project: "/workspace/one",
    scope: "project",
    sessionIds: ["session-unrelated"],
  }), /session lineage/u);
  const projectLocator = signLocator(claims({ scope: "project" }), secret);
  assert.equal(authorizeLocator(projectLocator, secret, {
    project: "/workspace/one",
    sessionIds: ["session-unrelated"],
  }).scope, "project");
});

test("locator validation rejects reversed ranges, invalid expiry, and malformed encodings", () => {
  const secret = Buffer.alloc(32, 0x19);
  assert.throws(() => signLocator(claims({
    matchRange: { startByte: 30, endByte: 20 },
  }), secret), LocatorError);
  assert.throws(() => signLocator(claims({ expiresAt: 1_000 }), secret), LocatorError);
  for (const locator of ["", "cw2.e30.signature", "cw1.not+url.signature", "cw1.e30.not+url"] ) {
    assert.throws(() => verifyLocator(locator, secret), LocatorError);
  }
});

test("retrieval leases bind an immutable target and use strict expiry", async (t) => {
  const store = await RocksStore.open(temporaryStore(t, "retrieval-lease"));
  t.after(() => store.close());
  const lease = await createRetrievalLease(store, {
    leaseId: "lease-fixed",
    ownerId: "search:user-message-1",
    documentId: "doc-1",
    documentVersion: 4,
    now: 1_000,
    ttlMs: 5_000,
  });
  assert.equal(lease.expiresAt, 6_000);
  assert.equal(lease.duplicate, false);
  assert.equal((await readLease(store, lease.leaseId)).documentId, "doc-1");
  assert.equal((await validateRetrievalLease(store, {
    leaseId: lease.leaseId,
    documentId: "doc-1",
    documentVersion: 4,
    now: 5_999,
  })).status, "active");
  assert.equal((await validateRetrievalLease(store, {
    leaseId: lease.leaseId,
    documentId: "doc-1",
    documentVersion: 4,
    now: 6_000,
  })).status, "expired");
  assert.equal((await validateRetrievalLease(store, {
    leaseId: lease.leaseId,
    documentId: "doc-1",
    documentVersion: 5,
    now: 2_000,
  })).status, "mismatch");
  assert.equal(await hasActiveDocumentLease(store, "doc-1", 4, { now: 5_000 }), true);
  assert.equal(await hasActiveDocumentLease(store, "doc-1", 4, { now: 6_000 }), false);

  const duplicate = await createRetrievalLease(store, {
    leaseId: "lease-fixed",
    ownerId: "search:user-message-1",
    documentId: "doc-1",
    documentVersion: 4,
    now: 1_000,
    ttlMs: 5_000,
  });
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(createRetrievalLease(store, {
    leaseId: "lease-fixed",
    ownerId: "different-owner",
    documentId: "doc-1",
    documentVersion: 4,
    now: 1_000,
    ttlMs: 5_000,
  }), /different claims/u);
});

test("release and bounded expiry cleanup remove every lease index", async (t) => {
  const store = await RocksStore.open(temporaryStore(t, "lease-cleanup"));
  t.after(() => store.close());
  for (const [leaseId, ttlMs] of [["a", 1_000], ["b", 2_000], ["c", 10_000]]) {
    await createRetrievalLease(store, {
      leaseId,
      documentId: `doc-${leaseId}`,
      documentVersion: 1,
      now: 1_000,
      ttlMs,
    });
  }
  assert.deepEqual(await cleanupExpiredLeases(store, { now: 3_000, limit: 1 }), {
    scanned: 1,
    released: 1,
    more: true,
  });
  assert.equal(await readLease(store, "a"), undefined);
  assert.deepEqual(await cleanupExpiredLeases(store, { now: 3_000, limit: 10 }), {
    scanned: 1,
    released: 1,
    more: false,
  });
  assert.equal(await readLease(store, "b"), undefined);
  assert.ok(await readLease(store, "c"));

  assert.deepEqual(await releaseLease(store, "c"), { status: "released", leaseId: "c" });
  assert.deepEqual(await releaseLease(store, "c"), { status: "not-found", leaseId: "c" });
  assert.equal(store.scan(leaseKeys.byExpiryPrefix()).length, 0);
  assert.equal(store.scan(leaseKeys.byDocumentPrefix("doc-c", 1)).length, 0);
});
