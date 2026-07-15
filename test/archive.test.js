import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Archive, matchExpression } from "../src/archive.js";

test("archives and BM25-searches documents by scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    const first = archive.put({
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "Authentication failed because the refresh token expired in session.ts",
      createdAt: 1,
    });
    archive.put({
      sessionId: "s2",
      project: "/project/b",
      kind: "turn",
      text: "Completely unrelated CSS layout discussion",
      createdAt: 2,
    });

    const results = archive.search("refresh token session", { sessionId: "s1", project: "/project/a" });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, first);
    assert.match(results[0].snippet, /refresh/i);
    assert.equal(archive.get(first).kind, "turn");
    assert.equal(archive.count({ sessionId: "s1" }), 1);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Archive.get exposes new, legacy, and tool-result provenance without a migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-provenance-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    const sourced = archive.put({
      id: "sourced",
      sessionId: "child-session",
      project: "/project/a",
      kind: "turn",
      text: "[user] deterministic serialization",
      createdAt: 123,
      metadata: {
        sourceMessageKeys: ["user:1::aaa", "assistant:2::bbb"],
        sourceFirstKey: "user:1::aaa",
        sourceLastKey: "assistant:2::bbb",
        sourceMessageCount: 2,
      },
    });
    const legacy = archive.put({
      id: "legacy",
      sessionId: "old-session",
      project: "/project/a",
      kind: "turn",
      text: "legacy text",
      metadata: { startKey: "user:1::old", messageCount: 1 },
    });
    const tool = archive.put({
      id: "tool",
      sessionId: "child-session",
      project: "/project/a",
      kind: "tool-result",
      text: "tool output",
      metadata: { toolCallId: "call-7", toolName: "bash" },
    });
    const partial = archive.put({
      id: "partial",
      sessionId: "child-session",
      project: "/project/a",
      kind: "turn",
      text: "partial modern provenance",
      metadata: { sourceMessageKeys: ["user:1::aaa"], sourceMessageCount: 1 },
    });
    const mixedTool = archive.put({
      id: "mixed-tool",
      sessionId: "child-session",
      project: "/project/a",
      kind: "tool-result",
      text: "mixed tool provenance",
      metadata: {
        sourceMessageKey: "toolResult:1:call-1:aaa",
        sourceMessageKeys: ["user:1::aaa"],
        sourceFirstKey: "user:1::aaa",
        sourceLastKey: "user:1::aaa",
        sourceMessageCount: 1,
      },
    });
    const stringCount = archive.put({
      id: "string-count",
      sessionId: "child-session",
      project: "/project/a",
      kind: "turn",
      text: "string count provenance",
      metadata: {
        sourceMessageKeys: ["user:1::aaa"],
        sourceFirstKey: "user:1::aaa",
        sourceLastKey: "user:1::aaa",
        sourceMessageCount: "1",
      },
    });

    assert.deepEqual(archive.get(sourced).provenance.sourceMessages, {
      status: "available",
      keys: ["user:1::aaa", "assistant:2::bbb"],
      firstKey: "user:1::aaa",
      lastKey: "assistant:2::bbb",
      count: 2,
    });
    assert.deepEqual(archive.get(sourced).provenance.archive, {
      id: "sourced",
      kind: "turn",
      sessionId: "child-session",
      project: "/project/a",
      createdAt: 123,
    });
    assert.equal(archive.get(legacy).provenance.sourceMessages.status, "legacy-unavailable");
    assert.deepEqual(archive.get(tool).provenance.toolResult, {
      toolCallId: "call-7",
      toolName: "bash",
    });
    assert.equal(archive.get(tool).provenance.sourceMessages.status, "legacy-unavailable");
    for (const id of [partial, mixedTool, stringCount]) {
      assert.deepEqual(archive.get(id).provenance.sourceMessages, {
        status: "incomplete",
        reason: "Source-message provenance fields are partial or inconsistent.",
      });
    }
    assert.equal(archive.get(mixedTool).provenance.toolResult.sourceMessageKey, undefined);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed and non-object legacy metadata do not block get or search", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-invalid-metadata-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    const insertDocument = archive.db.prepare(`
      INSERT INTO documents(id, session_id, project, kind, created_at, text, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = archive.db.prepare(
      "INSERT INTO documents_fts(id, session_id, project, text) VALUES (?, ?, ?, ?)",
    );
    for (const [id, text, metadataJson] of [
      ["malformed", "searchable malformed archive text", "{broken"],
      ["non-object", "searchable nonobject archive text", "[]"],
    ]) {
      insertDocument.run(id, "legacy-session", "/project/a", "turn", 1, text, metadataJson);
      insertFts.run(id, "legacy-session", "/project/a", text);
    }

    const malformed = archive.get("malformed");
    assert.equal(malformed.text, "searchable malformed archive text");
    assert.deepEqual(malformed.metadata, {});
    assert.equal(malformed.metadataParse.status, "malformed-json");
    assert.equal(malformed.provenance.sourceMessages.status, "metadata-invalid");
    assert.equal(malformed.provenance.metadata.status, "malformed-json");
    assert.match(malformed.provenance.metadata.error, /JSON|property name/i);

    const nonObject = archive.get("non-object");
    assert.equal(nonObject.text, "searchable nonobject archive text");
    assert.deepEqual(nonObject.metadataParse, {
      status: "invalid-shape",
      error: "metadata_json must contain a JSON object.",
    });
    assert.equal(nonObject.provenance.sourceMessages.status, "metadata-invalid");

    const results = archive.search("searchable archive", {
      sessionId: "legacy-session",
      project: "/project/a",
    });
    assert.equal(results.length, 2);
    assert.deepEqual(new Set(results.map((result) => result.id)), new Set(["malformed", "non-object"]));
    assert.ok(results.every((result) => result.text.includes("searchable")));
    assert.ok(results.every((result) => result.provenance.sourceMessages.status === "metadata-invalid"));
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session scope can include inherited fork lineage", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-lineage-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    for (const [sessionId, createdAt] of [["parent", 1], ["child", 2], ["sibling", 3]]) {
      archive.put({
        sessionId,
        project: "/project/a",
        text: `shared lineage evidence from ${sessionId}`,
        createdAt,
      });
    }
    archive.put({
      sessionId: "parent",
      project: "/project/b",
      text: "shared lineage evidence from cross-project injected parent",
      createdAt: 4,
    });

    const results = archive.search("lineage evidence", {
      sessionId: "child",
      sessionIds: ["parent", "child"],
      project: "/project/a",
      scope: "session",
    });

    assert.deepEqual(new Set(results.map((result) => result.sessionId)), new Set(["parent", "child"]));
    assert.ok(results.every((result) => result.project === "/project/a"));
    assert.ok(results.some((result) => result.sessionId === "parent"));
    assert.equal(archive.count({
      sessionIds: ["parent", "child"],
      project: "/project/a",
      scope: "session",
    }), 2);
    assert.equal(archive.count({ sessionIds: ["parent", "child"], scope: "session" }), 3);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for a concurrent archive writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-"));
  const databasePath = join(directory, "archive.db");
  const archive = new Archive(databasePath);
  const locker = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 150);
    `,
    databasePath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const exit = once(locker, "exit");

  try {
    await once(locker.stdout, "data");
    const id = archive.put({
      sessionId: "s1",
      project: "/project/a",
      text: "A write that waits for another Pi session",
    });
    assert.equal(archive.get(id).text, "A write that waits for another Pi session");
    const [exitCode] = await exit;
    assert.equal(exitCode, 0);
  } finally {
    if (locker.exitCode === null) locker.kill();
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds a safe FTS expression", () => {
  assert.equal(matchExpression('token " OR * refresh'), '"token" OR "or" OR "refresh"');
  assert.equal(matchExpression("?"), "");
});
