import assert from "node:assert/strict";
import test from "node:test";
import { encodeRecord } from "../src/rocksdb/schema.js";

test("record encoding remains byte-compatible after bounded-allocation encoding", () => {
  const json = encodeRecord({
    kind: "json",
    payload: { z: "héllo", a: [1, true, null, { x: "🙂" }] },
    recordVersion: 7,
    schemaVersion: 1,
  });
  assert.equal(
    json.toString("base64"),
    "Q1dSMQABAAcABAEAAAAtanNvbnsiYSI6WzEsdHJ1ZSxudWxsLHsieCI6IvCfmYIifV0sInoiOiJow6lsbG8ifUyZ5Y/OZvwgruROXIq37FOZjEQPZETHGXdiCgeQoeSR",
  );

  const binary = encodeRecord({
    kind: "bytes",
    payload: Uint8Array.from([0, 1, 2, 127, 128, 255]),
    recordVersion: 2,
    schemaVersion: 1,
  });
  assert.equal(
    binary.toString("base64"),
    "Q1dSMQABAAIABQIAAAAGYnl0ZXMAAQJ/gP8gCTwg5Rsunsydv2qqJgcqz9uilDKvTorJo3yC28rKmQ==",
  );
});
