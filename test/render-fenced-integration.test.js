import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RocksStore } from "../src/rocksdb/store.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { getOrCreateLocatorSecret, signLocator } from "../src/retrieval/locator.js";
import { createRetrievalLease } from "../src/retrieval/leases.js";
import { recallArchive } from "../src/retrieval/recall.js";
import { windowForByteRange } from "../src/rocksdb/windows.js";

/**
 * End-to-end format plumbing check: a real store, a real admitted document,
 * a real signed locator, and recallArchive with options.renderFormat — the
 * exact path DaemonOperations.recall() drives when
 * CONTEXT_WINDOW_RECALL_FORMAT=fenced-v2 is set on the daemon process.
 */

const BODY = 'Decision: keep RocksDB. if (x === "y") { return "z"; }\nNEEDLE_TOKEN present.';

function document() {
  return {
    documentId: "doc-fenced-e2e",
    version: 1,
    sourceKey: "user:doc-fenced-e2e:1",
    sessionId: "session-main",
    project: "/workspace/render-fenced-e2e",
    kind: "tool-result",
    createdAt: 1_700_000_000_000,
    text: BODY,
    metadata: { turnId: "turn-fenced" },
    sourceMessageKeys: ["user:doc-fenced-e2e:1"],
  };
}

test("recallArchive renders fenced-v2 when options.renderFormat is set", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-fenced-e2e-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => store.close());

  const doc = document();
  await admitDocument(store, {
    idempotencyKey: `recall:${doc.documentId}:${doc.version}`,
    document: doc,
    structuralMessages: [],
    retentionClass: "conversation-source",
  }, {
    chunking: { maxChunkBytes: 256, minLineSplitBytes: 0 },
    windows: { windowTokens: 64, overlapTokens: 4 },
  });

  const secret = await getOrCreateLocatorSecret(store, { now: 1_000 });
  const match = "NEEDLE_TOKEN";
  const startByte = Buffer.byteLength(BODY.slice(0, BODY.indexOf(match)), "utf8");
  const endByte = startByte + Buffer.byteLength(match, "utf8");
  const windows = store.scan(["window", doc.documentId, doc.version]).map(({ payload }) => payload);
  const window = windowForByteRange(windows, startByte, endByte);
  const lease = await createRetrievalLease(store, {
    leaseId: "lease:doc-fenced-e2e:1",
    ownerId: "render-fenced-e2e",
    documentId: doc.documentId,
    documentVersion: doc.version,
    now: 1_000,
    ttlMs: 60_000,
  });
  const locator = signLocator({
    locatorVersion: 1,
    documentId: doc.documentId,
    documentVersion: doc.version,
    windowOrdinal: window.ordinal,
    matchRange: { startByte, endByte },
    indexGeneration: 0,
    leaseId: lease.leaseId,
    project: doc.project,
    sessionId: doc.sessionId,
    scope: "session",
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
  }, secret);

  const baseOptions = {
    project: doc.project,
    scope: "session",
    sessionIds: ["session-current", doc.sessionId],
    now: 2_000,
    secret,
  };
  const request = { locator, neighbors: 1, maxTokens: 1_500 };

  // Default stays json-v1.
  const v1 = await recallArchive(store, request, baseOptions);
  assert.equal(v1.status, "resolved");
  assert.match(v1.renderedText, /UNTRUSTED JSON RECORD/u);

  // The daemon-operations option switches the packet to fenced-v2.
  const v2 = await recallArchive(store, request, { ...baseOptions, renderFormat: "fenced-v2" });
  assert.equal(v2.status, "resolved");
  const lines = v2.renderedText.split("\n");
  assert.match(lines[0], /^\[ARCHIVE:UNTRUSTED-DATA\]/u);
  const metadata = JSON.parse(lines[1]);
  assert.equal(metadata.doc, "doc-fenced-e2e@v1");
  assert.match(lines[2], /^~{5,}archived-evidence$/u);
  assert.equal(lines[lines.length - 1], lines[2].replace("archived-evidence", ""));
  const body = lines.slice(3, -1).join("\n");
  assert.match(body, /NEEDLE_TOKEN/u);
  assert.ok(BODY.includes(body), "body must be an exact canonical fragment");
  // The raw body is cheaper than double-encoded JSON of the same fragment.
  assert.ok(v2.returnedTokens <= v1.returnedTokens,
    `fenced (${v2.returnedTokens}) must not exceed json-v1 (${v1.returnedTokens})`);

  // Unknown format values degrade safely to json-v1.
  const unknown = await recallArchive(store, request, { ...baseOptions, renderFormat: "bogus" });
  assert.match(unknown.renderedText, /UNTRUSTED JSON RECORD/u);
});
