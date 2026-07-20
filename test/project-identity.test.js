import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalProjectId, projectIdentityAlias } from "../src/identity/project-identity.js";

const roots = [];

function makeRoot() {
  // realpath the base so assertions compare against the platform's canonical
  // spelling (e.g. macOS /var -> /private/var) rather than the tmp alias.
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "project-identity-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("symlink and real spelling resolve to one identity", () => {
  const root = makeRoot();
  const repo = mkdtempSync(join(root, "repo-"));
  const link = join(root, "repo-symlink");
  symlinkSync(repo, link, "dir");

  const viaReal = canonicalProjectId(repo);
  const viaLink = canonicalProjectId(link);
  assert.equal(viaLink, viaReal, "symlinked and direct spellings must share one identity");
  assert.equal(viaReal, realpathSync.native(repo));
});

test("distinct real directories never collapse", () => {
  const root = makeRoot();
  const a = mkdtempSync(join(root, "a-"));
  const b = mkdtempSync(join(root, "b-"));
  assert.notEqual(canonicalProjectId(a), canonicalProjectId(b));
});

test("realpath failure falls back to the literal path (fail-closed)", () => {
  const missing = join(makeRoot(), "does-not-exist-", String(Date.now()));
  assert.equal(canonicalProjectId(missing), missing);
});

test("a non-absolute or empty input is returned unchanged", () => {
  assert.equal(canonicalProjectId("project-label"), "project-label");
  assert.equal(canonicalProjectId(""), "");
});

test("projectIdentityAlias yields the literal only when it differs", () => {
  const root = makeRoot();
  const repo = mkdtempSync(join(root, "repo-"));
  const link = join(root, "repo-symlink");
  symlinkSync(repo, link, "dir");

  assert.equal(projectIdentityAlias(link), link, "a symlinked spelling needs a read alias");
  assert.equal(
    projectIdentityAlias(canonicalProjectId(repo)),
    undefined,
    "an already-canonical project contributes no alias",
  );
});

test("a trailing-slash spelling is canonicalized and aliased", () => {
  const root = makeRoot();
  const repo = mkdtempSync(join(root, "repo-"));
  const trailing = `${repo}/`;
  assert.equal(canonicalProjectId(trailing), realpathSync.native(repo));
  assert.equal(projectIdentityAlias(trailing), trailing);
});
