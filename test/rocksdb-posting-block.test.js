import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBm25PostingBlock,
  decodeExactPostingBlock,
  encodeBm25PostingBlock,
  encodeExactPostingBlock,
  isPostingBlock,
} from "../src/rocksdb/index/posting-block.js";

test("BM25 canonical posting blocks round-trip and beat JSON bytes", () => {
  const posting = {
    bm25PostingVersion: 3,
    tokenizerVersion: 2,
    generation: 10,
    project: "/workspace/project",
    term: "posting",
    documentId: "document",
    documentVersion: 1,
    kind: "turn",
    createdAt: 100,
    bucket: 0,
    sessionId: "session",
    sourceMessageKeys: ["user:document"],
    turnId: "turn",
    window: {
      ordinal: 0,
      startByte: 0,
      endByte: 100,
      length: 20,
      weightedLength: 21.25,
      termFrequency: 2,
      weightedTermFrequency: 4.5,
      positionsEncoding: "delta-v1",
      positionDeltas: [1, 4, 7, 2, 10, 7],
    },
  };
  const encoded = encodeBm25PostingBlock(posting);
  assert.equal(isPostingBlock(encoded), true);
  assert.equal(encoded.equals(encodeBm25PostingBlock(posting)), true);
  assert.ok(encoded.length < Buffer.byteLength(JSON.stringify(posting)));
  assert.deepEqual(decodeBm25PostingBlock(encoded), posting);
  assert.throws(
    () => decodeBm25PostingBlock(encoded.subarray(0, encoded.length - 1)),
    /malformed/u,
  );
});

test("exact canonical posting blocks round-trip and beat JSON bytes", () => {
  const posting = {
    postingVersion: 1,
    generation: 10,
    sourceVersion: 1,
    project: "/workspace/project",
    sessionId: "session",
    bucket: 0,
    createdAt: 100,
    documentId: "document",
    documentVersion: 1,
    documentKind: "turn",
    sourceKey: "user:document",
    sourceKeyStatus: "active",
    sourceMessageKeys: ["user:document"],
    turnId: null,
    windowOrdinal: 0,
    windowStartByte: 0,
    windowEndByte: 100,
    caseMode: "exact",
    normalizedTerm: "PostingTarget",
    matches: [{
      type: "symbol",
      value: "PostingTarget",
      startByte: 4,
      endByte: 17,
      specificity: 0.94,
    }],
  };
  const encoded = encodeExactPostingBlock(posting);
  assert.equal(isPostingBlock(encoded), true);
  assert.equal(encoded.equals(encodeExactPostingBlock(posting)), true);
  assert.ok(encoded.length < Buffer.byteLength(JSON.stringify(posting)));
  assert.deepEqual(decodeExactPostingBlock(encoded), posting);
  assert.throws(() => decodeBm25PostingBlock(encoded), /type does not match/u);
});
