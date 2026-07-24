import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePostingLocator,
  encodePostingLocator,
  isPostingLocator,
  POSTING_LOCATOR_KIND,
} from "../src/rocksdb/index/posting-locator.js";

test("posting locators round-trip canonical keys in compact bytes", () => {
  const targets = [Buffer.from("canonical-one"), Buffer.from("canonical-two")];
  const encoded = encodePostingLocator(POSTING_LOCATOR_KIND.EXACT_FOLDED, targets);
  assert.equal(isPostingLocator(encoded), true);
  assert.ok(encoded.length < JSON.stringify({
    targets: targets.map((target) => target.toString("base64url")),
  }).length);
  const decoded = decodePostingLocator(encoded, POSTING_LOCATOR_KIND.EXACT_FOLDED);
  assert.deepEqual(decoded.targets, targets);
});

test("posting locators reject corruption and a mismatched index kind", () => {
  const encoded = encodePostingLocator(
    POSTING_LOCATOR_KIND.BM25_SESSION,
    [Buffer.from("canonical")],
  );
  assert.throws(
    () => decodePostingLocator(encoded, POSTING_LOCATOR_KIND.EXACT_FOLDED),
    /kind does not match/u,
  );
  assert.throws(
    () => decodePostingLocator(encoded.subarray(0, -1)),
    /target length|truncated/u,
  );
});
