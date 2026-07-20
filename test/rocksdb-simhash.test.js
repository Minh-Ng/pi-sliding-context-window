import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SIMHASH_TOKENS_PER_DOCUMENT } from "../src/rocksdb/index-preparation.js";
import {
  computeSimHash,
  createNearDuplicateIndexHandler,
  DEFAULT_NEAR_DUPLICATE_HAMMING,
  hammingDistance,
  readNearDuplicateSignature,
  selectNearDuplicateRepresentatives,
  simhashKeys,
} from "../src/rocksdb/index/simhash.js";
import { tokenizeBm25 } from "../src/rocksdb/index/tokenizer.js";

function signatureOfText(text) {
  const frequencies = new Map();
  for (const token of tokenizeBm25(text)) {
    frequencies.set(token.term, (frequencies.get(token.term) ?? 0) + 1);
  }
  return computeSimHash(frequencies);
}

function fullWindow(text) {
  return { ordinal: 0, startByte: 0, endByte: Buffer.byteLength(text, "utf8") };
}

// A minimal stand-in for the IndexWorker's bounded reader: ASCII-only test
// fixtures never need UTF-8 boundary adjustment, so a plain byte slice is a
// faithful fake of the production readSourceRange contract.
function fakeReadSourceRange(buffer) {
  return async (startByte, endByte) => ({
    startByte,
    endByte,
    text: buffer.subarray(startByte, endByte).toString("utf8"),
  });
}

function handlerContext({
  text = "",
  windows,
  operation = "index",
  get = async () => undefined,
  sourceSegmentBytes = 4_096,
}) {
  return {
    view: { get, scan: () => [] },
    generation: 1,
    operation,
    manifest: {
      project: "/workspace/dedup",
      documentId: "doc-under-test",
      version: 1,
      contentHash: "sha256:test",
    },
    windows,
    sourceSegmentBytes,
    readSourceRange: fakeReadSourceRange(Buffer.from(text, "utf8")),
    yieldControl: async () => {},
  };
}

test("SimHash is a deterministic, order-independent fingerprint of the term multiset", () => {
  const first = computeSimHash(new Map([["alpha", 3], ["beta", 2], ["gamma", 1]]));
  const reordered = computeSimHash(new Map([["gamma", 1], ["alpha", 3], ["beta", 2]]));
  assert.equal(first, reordered);
  assert.match(first, /^[0-9a-f]{16}$/u);
  assert.equal(hammingDistance(first, reordered), 0);
});

test("near-identical long output collapses to a small Hamming distance while unrelated text does not", () => {
  const body = Array.from({ length: 40 }, (_, index) => (
    `PASS src/module${index}/handler.spec.ts checkout billing integration assertion verified deterministic`
  )).join("\n");
  const runA = `${body}\nTest Suites: 40 passed, 40 total. Tests: 312 passed. Time: 8.21 s.`;
  const runB = `${body}\nTest Suites: 40 passed, 40 total. Tests: 312 passed. Time: 9.07 s.`;
  const unrelated = "The database migration renames the ledger column and backfills historical invoice rows.";
  assert.ok(hammingDistance(signatureOfText(runA), signatureOfText(runB)) <= DEFAULT_NEAR_DUPLICATE_HAMMING);
  assert.ok(hammingDistance(signatureOfText(runA), signatureOfText(unrelated)) > DEFAULT_NEAR_DUPLICATE_HAMMING);
});

test("representative selection keeps the first cluster member and counts the suppressed rest", () => {
  const shared = "aaaaaaaaaaaaaaaa";
  const items = [
    { id: "best", simhash: shared },
    { id: "dup-1", simhash: shared },
    { id: "dup-2", simhash: shared },
    { id: "distinct", simhash: "ffffffffffffffff" },
    { id: "no-signature" },
  ];
  const representatives = selectNearDuplicateRepresentatives(items, { maxHammingDistance: 0 });
  assert.deepEqual(
    representatives.map(({ item, nearDuplicates }) => [item.id, nearDuplicates]),
    [["best", 2], ["distinct", 0], ["no-signature", 0]],
  );
});

test("candidates without a signature are never clustered together", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const representatives = selectNearDuplicateRepresentatives(items, { maxHammingDistance: 64 });
  assert.equal(representatives.length, 3);
  assert.ok(representatives.every(({ nearDuplicates }) => nearDuplicates === 0));
});

test("an absorbed item's own already-suppressed duplicates carry into the absorbing representative", () => {
  const shared = "aaaaaaaaaaaaaaaa";
  // "already-deduped" simulates an upstream pass (search.js) whose own
  // representative already absorbed 2 near-dups before this second pass runs.
  const items = [
    { id: "already-deduped", simhash: shared, priorSuppressed: 2 },
    { id: "new-neighbor", simhash: shared, priorSuppressed: 0 },
  ];
  const representatives = selectNearDuplicateRepresentatives(items, {
    maxHammingDistance: 0,
    priorCount: (item) => item.priorSuppressed,
  });
  assert.deepEqual(
    representatives.map(({ item, nearDuplicates }) => [item.id, nearDuplicates]),
    [["already-deduped", 3]],
  );
});

test("readNearDuplicateSignature only trusts a complete signature, never a partial or empty one", async () => {
  // A "partial" signature covers just a bounded prefix (the document exceeded
  // MAX_SIMHASH_TOKENS_PER_DOCUMENT). Two unrelated documents that happen to
  // be identical for that prefix and diverge afterward would otherwise land
  // at Hamming distance 0 and wrongly cluster, suppressing the diverging one.
  const records = new Map([
    ["doc-partial-a", { status: "partial", simhash: "aaaaaaaaaaaaaaaa" }],
    ["doc-partial-b", { status: "partial", simhash: "aaaaaaaaaaaaaaaa" }],
    ["doc-empty", { status: "empty" }],
    ["doc-complete", { status: "complete", simhash: "bbbbbbbbbbbbbbbb" }],
  ]);
  const view = { get: async (key) => records.get(key.at(-2)) };
  assert.equal(await readNearDuplicateSignature(view, "/workspace/dedup", "doc-partial-a", 1), undefined);
  assert.equal(await readNearDuplicateSignature(view, "/workspace/dedup", "doc-partial-b", 1), undefined);
  assert.equal(await readNearDuplicateSignature(view, "/workspace/dedup", "doc-empty", 1), undefined);
  assert.equal(
    await readNearDuplicateSignature(view, "/workspace/dedup", "doc-complete", 1),
    "bbbbbbbbbbbbbbbb",
  );

  // Consequently, two partial signatures at Hamming distance 0 still never
  // cluster: selectNearDuplicateRepresentatives never even sees a signature
  // for either, because the retrieval-side lookup excluded both.
  const items = ["doc-partial-a", "doc-partial-b"];
  const signatures = new Map();
  for (const documentId of items) {
    const simhash = await readNearDuplicateSignature(view, "/workspace/dedup", documentId, 1);
    if (simhash !== undefined) signatures.set(documentId, simhash);
  }
  const representatives = selectNearDuplicateRepresentatives(items, {
    signatureOf: (documentId) => signatures.get(documentId),
  });
  assert.equal(representatives.length, 2);
  assert.ok(representatives.every(({ nearDuplicates }) => nearDuplicates === 0));
});

test("the index handler stores one versioned signature record per document", async () => {
  const handler = createNearDuplicateIndexHandler();
  const text = "checkout billing integration verified deterministic assertion suite";
  const result = await handler.prepare(handlerContext({ text, windows: [fullWindow(text)] }));
  assert.equal(result.mutations.length, 1);
  const [mutation] = result.mutations;
  assert.equal(mutation.type, "put");
  assert.equal(mutation.kind, "near-duplicate-signature");
  assert.deepEqual(mutation.key, simhashKeys.signature("/workspace/dedup", "doc-under-test", 1));
  assert.equal(mutation.payload.status, "complete");
  assert.equal(mutation.payload.documentId, "doc-under-test");
  assert.equal(mutation.payload.documentVersion, 1);
  assert.equal(mutation.payload.simhash, signatureOfText(text));
});

test("chunked bounded reads produce the same signature as a single read, regardless of segment size", async () => {
  const handler = createNearDuplicateIndexHandler();
  const text = Array.from({ length: 200 }, (_, index) => `token${index} checkout billing`).join(" ");
  const wide = await handler.prepare(handlerContext({
    text,
    windows: [fullWindow(text)],
    sourceSegmentBytes: 4_096,
  }));
  const narrow = await handler.prepare(handlerContext({
    text,
    windows: [fullWindow(text)],
    // Forces many bounded reads per window, mirroring a large document read
    // through indexer.js's small default source-segment size.
    sourceSegmentBytes: 17,
  }));
  assert.equal(wide.mutations[0].payload.simhash, narrow.mutations[0].payload.simhash);
  assert.equal(wide.mutations[0].payload.tokenCount, narrow.mutations[0].payload.tokenCount);
});

test("an empty document yields an empty status with no signature", async () => {
  const handler = createNearDuplicateIndexHandler();
  const result = await handler.prepare(handlerContext({ text: "", windows: [fullWindow("")] }));
  assert.equal(result.mutations[0].payload.status, "empty");
  assert.equal(result.mutations[0].payload.tokenCount, 0);
  assert.equal(Object.hasOwn(result.mutations[0].payload, "simhash"), false);
});

test("a document above the token budget yields a durable partial signature over its prefix", async () => {
  const handler = createNearDuplicateIndexHandler();
  const words = Array.from({ length: MAX_SIMHASH_TOKENS_PER_DOCUMENT + 50 }, (_, index) => `term${index}`);
  const text = words.join(" ");
  const result = await handler.prepare(handlerContext({ text, windows: [fullWindow(text)] }));
  assert.equal(result.mutations[0].payload.status, "partial");
  assert.equal(result.mutations[0].payload.tokenCount, MAX_SIMHASH_TOKENS_PER_DOCUMENT);
  assert.match(result.mutations[0].payload.simhash, /^[0-9a-f]{16}$/u);
});

test("the delete operation removes an existing signature and is a no-op otherwise", async () => {
  const handler = createNearDuplicateIndexHandler();
  const present = await handler.prepare(handlerContext({
    operation: "delete",
    windows: [],
    get: async () => ({ simhash: "aaaaaaaaaaaaaaaa", status: "complete" }),
  }));
  assert.equal(present.mutations.length, 1);
  assert.equal(present.mutations[0].type, "remove");
  assert.deepEqual(present.mutations[0].key, simhashKeys.signature("/workspace/dedup", "doc-under-test", 1));

  const absent = await handler.prepare(handlerContext({ operation: "delete", windows: [] }));
  assert.deepEqual(absent.mutations, []);
  assert.equal(absent.metadata.deleted, false);
});
