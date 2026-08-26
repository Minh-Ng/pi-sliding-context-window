import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

test("Transformers resolves a sharp version patched for GHSA-f88m-g3jw-g9cj", () => {
  const transformersEntry = require.resolve("@huggingface/transformers");
  const transformersRequire = createRequire(transformersEntry);
  const sharpEntry = transformersRequire.resolve("sharp");
  const sharpPackagePath = findPackageJSON("sharp", sharpEntry);
  assert.ok(sharpPackagePath, "sharp package metadata is unavailable");
  const sharpPackage = JSON.parse(readFileSync(sharpPackagePath, "utf8"));

  assert.equal(
    versionAtLeast(sharpPackage.version, "0.35.0"),
    true,
    `@huggingface/transformers resolved vulnerable sharp ${sharpPackage.version}`,
  );
});
