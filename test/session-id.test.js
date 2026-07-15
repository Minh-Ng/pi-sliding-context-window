import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ancestorSessionIds } from "../src/session-id.js";

function header(path, value) {
  writeFileSync(path, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "fixture-session-id",
    timestamp: "2026-01-02T03:04:05.000Z",
    cwd: dirname(path),
    ...value,
  })}\n`);
}

test("derives multi-generation parent ids from JSONL session headers", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-session-lineage-"));
  try {
    const grandparent = join(root, "grandparent.jsonl");
    const parent = join(root, "parent.jsonl");
    const child = join(root, "child.jsonl");
    header(grandparent, { version: 1, id: "grandparent-id" });
    header(parent, { version: 3, id: "parent-id", parentSession: "grandparent.jsonl" });
    header(child, { id: "child-id", parentSession: parent });

    assert.deepEqual(ancestorSessionIds(child), ["parent-id", "grandparent-id"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage parsing rejects unverified parents and bounds valid chains", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-session-guards-"));
  try {
    const malformed = join(root, "malformed.jsonl");
    const child = join(root, "child.jsonl");
    writeFileSync(malformed, "not-json\n");
    header(child, { id: "child", parentSession: malformed });
    assert.deepEqual(ancestorSessionIds(child), []);

    const missing = join(root, "missing.jsonl");
    header(child, { id: "child", parentSession: missing });
    assert.deepEqual(ancestorSessionIds(child), []);

    const nonSession = join(root, "non-session.jsonl");
    writeFileSync(nonSession, `${JSON.stringify({ type: "message", version: 3, id: "forged" })}\n`);
    header(child, { id: "child", parentSession: nonSession });
    assert.deepEqual(ancestorSessionIds(child), []);

    const idLess = join(root, "id-less.jsonl");
    header(idLess, { id: "", parentSession: "deeper.jsonl" });
    header(child, { id: "child", parentSession: idLess });
    assert.deepEqual(ancestorSessionIds(child), []);

    const incomplete = join(root, "incomplete.jsonl");
    writeFileSync(incomplete, `${JSON.stringify({ type: "session", version: 3, id: "forged" })}\n`);
    header(child, { id: "child", parentSession: incomplete });
    assert.deepEqual(ancestorSessionIds(child), []);

    const invalidTimestamp = join(root, "invalid-timestamp.jsonl");
    header(invalidTimestamp, { id: "bad-time", timestamp: "not-a-timestamp" });
    header(child, { id: "child", parentSession: invalidTimestamp });
    assert.deepEqual(ancestorSessionIds(child), []);

    const otherProject = join(root, "other-project");
    const wrongCwd = join(root, "wrong-cwd.jsonl");
    header(wrongCwd, { id: "wrong-project", cwd: otherProject });
    header(child, { id: "child", parentSession: wrongCwd });
    assert.deepEqual(ancestorSessionIds(child), []);
    assert.deepEqual(ancestorSessionIds(child, { expectedCwd: root }), []);

    const relativeCwd = join(root, "relative-cwd.jsonl");
    header(relativeCwd, { id: "relative-project", cwd: "relative/project" });
    header(child, { id: "child", parentSession: relativeCwd });
    assert.deepEqual(ancestorSessionIds(child), []);

    const unsupported = join(root, "unsupported.jsonl");
    header(unsupported, { version: 99, id: "future-or-forged" });
    header(child, { id: "child", parentSession: unsupported });
    assert.deepEqual(ancestorSessionIds(child), []);

    const oversized = join(root, "oversized.jsonl");
    writeFileSync(oversized, `${" ".repeat(64 * 1024)}${JSON.stringify({
      type: "session",
      version: 3,
      id: "hidden",
      timestamp: "2026-01-02T03:04:05.000Z",
      cwd: root,
    })}\n`);
    header(child, { id: "child", parentSession: oversized });
    assert.deepEqual(ancestorSessionIds(child), []);

    const a = join(root, "a.jsonl");
    const b = join(root, "b.jsonl");
    header(a, { id: "a", parentSession: b });
    header(b, { id: "b", parentSession: a });
    assert.deepEqual(ancestorSessionIds(a), ["b"]);

    const paths = Array.from({ length: 5 }, (_, index) => join(root, `${index}.jsonl`));
    paths.forEach((path, index) => header(path, {
      id: `id-${index}`,
      ...(paths[index + 1] ? { parentSession: paths[index + 1] } : {}),
    }));
    assert.deepEqual(ancestorSessionIds(paths[0], { maxDepth: 2 }), ["id-1", "id-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts current v3 and legacy v1 session header version semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-session-versions-"));
  try {
    const v1 = join(root, "v1.jsonl");
    const implicitV1 = join(root, "implicit-v1.jsonl");
    const v3 = join(root, "v3.jsonl");
    header(v1, { version: 1, id: "v1-id" });
    header(implicitV1, { version: undefined, id: "implicit-v1-id", parentSession: v1 });
    header(v3, { version: 3, id: "v3-id", parentSession: implicitV1 });

    assert.deepEqual(ancestorSessionIds(v3, { expectedCwd: root }), ["implicit-v1-id", "v1-id"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork fallback uses the previous session only when supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-session-fallback-"));
  try {
    const parent = join(root, "parent.jsonl");
    const notYetWritten = join(root, "child.jsonl");
    header(parent, { id: "parent-id" });

    assert.deepEqual(ancestorSessionIds(notYetWritten), []);
    assert.deepEqual(ancestorSessionIds(notYetWritten, {
      fallbackParentFile: parent,
      expectedCwd: root,
    }), ["parent-id"]);
    assert.deepEqual(ancestorSessionIds(undefined, {
      fallbackParentFile: parent,
      expectedCwd: root,
    }), ["parent-id"]);

    const incomplete = join(root, "incomplete-parent.jsonl");
    writeFileSync(incomplete, `${JSON.stringify({ type: "session", id: "forged" })}\n`);
    assert.deepEqual(ancestorSessionIds(undefined, { fallbackParentFile: incomplete }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
