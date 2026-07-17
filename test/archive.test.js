import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("repeated legacy document writes remain idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-repeated-put-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    const document = {
      id: "repeated-tool-result",
      sessionId: "s1",
      project: "/project/a",
      kind: "tool-result",
      text: "first result",
      createdAt: 1,
    };
    archive.put(document);
    archive.put({ ...document, text: "updated result", createdAt: 2 });

    assert.equal(archive.get(document.id).text, "updated result");
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM legacy_documents WHERE document_id = ?",
    ).get(document.id).n, 1);
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

test("structural search resolves the latest indexed question deterministically", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    for (const [id, createdAt, question] of [
      ["older-turn", 1, "Why was the worker restarted?"],
      ["newer-turn", 2, "Were liveserving workloads scaled up?"],
    ]) {
      archive.put({
        id,
        sessionId: "s1",
        project: "/project/a",
        kind: "turn",
        text: `[user] ${question}\n\n[assistant] Answer`,
        createdAt,
      }, {
        structuralMessages: [
          {
            messageIndex: 0,
            messageKey: `user:${createdAt}`,
            role: "user",
            createdAt,
            text: question,
            questionScore: 100,
            requestScore: 10,
          },
          {
            messageIndex: 1,
            messageKey: `assistant:${createdAt}`,
            role: "assistant",
            createdAt,
            text: "Answer",
            answerScore: 100,
          },
        ],
      });
    }

    const result = archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "s1",
      sessionIds: ["s1"],
      project: "/project/a",
      scope: "session",
      limit: 3,
    });
    assert.equal(result.status, "resolved");
    assert.equal(result.results[0].id, "newer-turn");
    assert.equal(result.results[0].snippet, "Were liveserving workloads scaled up?");
    assert.equal(result.results[0].structural.relationConfidence, 100);
    assert.equal(result.results[0].structural.granularity, "message");
    assert.equal(archive.get("newer-turn").kind, "turn");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural candidate limiting cannot hide a current-session match behind ancestors", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-lineage-rank-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    archive.put({
      id: "current-question",
      sessionId: "child",
      project: "/project/a",
      kind: "turn",
      text: "[user] Current session question?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "current-user",
        role: "user",
        createdAt: 1,
        text: "Current session question?",
        questionScore: 100,
      }],
    });
    for (let index = 0; index < 120; index += 1) {
      archive.put({
        id: `parent-${index}`,
        sessionId: "parent",
        project: "/project/a",
        kind: "turn",
        text: `[user] Parent question ${index}?`,
        createdAt: index + 2,
      }, {
        structuralMessages: [{
          messageIndex: 0,
          messageKey: `parent-user-${index}`,
          role: "user",
          createdAt: index + 2,
          text: `Parent question ${index}?`,
          questionScore: 100,
        }],
      });
    }

    const result = archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "child",
      sessionIds: ["child", "parent"],
      project: "/project/a",
      scope: "session",
      limit: 1,
    });
    assert.equal(result.results[0].id, "current-question");
    assert.equal(result.status, "resolved");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural BM25 filters individual messages rather than sibling turn text", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-fts-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    archive.put({
      id: "turn-1",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] What happened?\n\n[assistant] The zircon-token appeared here.",
      createdAt: 1,
    }, {
      structuralMessages: [
        {
          messageIndex: 0,
          messageKey: "user:1",
          role: "user",
          createdAt: 1,
          text: "What happened?",
          questionScore: 100,
        },
        {
          messageIndex: 1,
          messageKey: "assistant:1",
          role: "assistant",
          createdAt: 2,
          text: "The zircon-token appeared here.",
          answerScore: 100,
        },
      ],
    });

    assert.equal(archive.searchDetailed("zircon-token", {
      relation: "latest-question",
      sessionId: "s1",
      project: "/project/a",
    }).status, "not-found");
    assert.equal(archive.searchDetailed("zircon-token", {
      relation: "latest-answer",
      sessionId: "s1",
      project: "/project/a",
    }).results[0].structural.role, "assistant");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural search marks ancestor and newer legacy candidates as ambiguous", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-legacy-"));
  const archive = new Archive(join(directory, "archive.db"));
  try {
    archive.put({
      id: "parent-question",
      sessionId: "parent",
      project: "/project/a",
      kind: "turn",
      text: "[user] Why parent?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "parent-user",
        role: "user",
        createdAt: 1,
        text: "Why parent?",
        questionScore: 100,
      }],
    });
    archive.put({
      id: "newer-legacy",
      sessionId: "child",
      project: "/project/a",
      kind: "turn",
      text: "[user] Legacy boundaries are unavailable",
      createdAt: 2,
    });
    archive.put({
      id: "cross-project",
      sessionId: "child",
      project: "/project/b",
      kind: "turn",
      text: "[user] Cross project?",
      createdAt: 3,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "cross-user",
        role: "user",
        createdAt: 3,
        text: "Cross project?",
        questionScore: 100,
      }],
    });

    const result = archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "child",
      sessionIds: ["child", "parent"],
      project: "/project/a",
      scope: "session",
      limit: 3,
    });
    assert.equal(result.status, "ambiguous");
    assert.deepEqual(result.results.map(({ id }) => id), ["parent-question", "newer-legacy"]);
    assert.equal(result.results[1].structural.granularity, "document");
    assert.equal(result.results.some(({ id }) => id === "cross-project"), false);

    const anchored = archive.searchDetailed("parent", {
      relation: "latest-question",
      sessionId: "child",
      sessionIds: ["child", "parent"],
      project: "/project/a",
      scope: "session",
      limit: 3,
    });
    assert.equal(anchored.status, "ambiguous");
    assert.equal(anchored.results[0].id, "parent-question");
    assert.equal(anchored.results[0].structural.lineageDepth, 1);

    const broad = archive.searchDetailed("", {
      relation: "latest-question",
      project: "/project/b",
      scope: "project",
      limit: 3,
    });
    assert.equal(broad.status, "ambiguous");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural index replacement preserves document order and pruning removes child rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-lifecycle-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: { maxBytes: 100_000, targetBytes: 500, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  try {
    archive.put({
      id: "replace-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] Old question?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "old-key",
        role: "user",
        createdAt: 1,
        text: "Old question?",
        questionScore: 100,
      }],
    });
    const sequence = archive.db.prepare(
      "SELECT sequence FROM document_order WHERE document_id = 'replace-turn'",
    ).get().sequence;
    const accountedBefore = archive.db.prepare(
      "SELECT accounted_bytes FROM document_retention WHERE document_id = 'replace-turn'",
    ).get().accounted_bytes;

    archive.put({
      id: "replace-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] New question?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "new-key",
        role: "user",
        createdAt: 1,
        text: "New question?",
        questionScore: 100,
      }],
    });
    assert.equal(archive.db.prepare(
      "SELECT sequence FROM document_order WHERE document_id = 'replace-turn'",
    ).get().sequence, sequence);
    assert.equal(archive.searchDetailed("old", {
      relation: "latest-question",
      sessionId: "s1",
      project: "/project/a",
    }).status, "not-found");
    assert.equal(archive.searchDetailed("new", {
      relation: "latest-question",
      sessionId: "s1",
      project: "/project/a",
    }).results[0].structural.messageKey, "new-key");
    assert.ok(accountedBefore > 0);

    archive.put({
      id: "newest-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] Newest question?",
      createdAt: 2,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "newest-key",
        role: "user",
        createdAt: 2,
        text: "Newest question?",
        questionScore: 100,
      }],
    });
    archive.prune({ force: true, now: 10_000 });
    assert.equal(archive.get("replace-turn"), undefined);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM archive_messages WHERE document_id = 'replace-turn'",
    ).get().n, 0);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM archive_messages_fts WHERE document_id = 'replace-turn'",
    ).get().n, 0);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM document_order WHERE document_id = 'replace-turn'",
    ).get().n, 0);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup repair removes structural FTS rows orphaned with their parent document", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-structural-orphan-"));
  const databasePath = join(directory, "archive.db");
  let archive = new Archive(databasePath);
  try {
    archive.put({
      id: "orphan-parent",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] Orphan question?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "orphan-key",
        role: "user",
        text: "Orphan question?",
        questionScore: 100,
      }],
    });
    archive.db.prepare("DELETE FROM documents WHERE id = 'orphan-parent'").run();
    archive.close();

    archive = new Archive(databasePath);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM archive_messages WHERE document_id = 'orphan-parent'",
    ).get().n, 0);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM archive_messages_fts WHERE document_id = 'orphan-parent'",
    ).get().n, 0);
  } finally {
    try { archive.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database triggers account and classify writes from an already-running legacy process", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mixed-version-"));
  const databasePath = join(directory, "archive.db");
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      id UNINDEXED, session_id UNINDEXED, project UNINDEXED, text,
      tokenize = 'porter unicode61'
    );
  `);
  const legacyInsert = legacyDb.prepare(`
    INSERT INTO documents(id, session_id, project, kind, created_at, text, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const legacyUpdate = legacyDb.prepare(
    "UPDATE documents SET text = ?, created_at = ? WHERE id = ?",
  );
  let archive;
  try {
    archive = new Archive(databasePath, {
      retention: { maxBytes: 5_000, targetBytes: 4_000, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
    });
    archive.put({
      id: "indexed-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "[user] Indexed question?",
      createdAt: 1,
    }, {
      structuralMessages: [{
        messageIndex: 0,
        messageKey: "indexed-key",
        role: "user",
        text: "Indexed question?",
        questionScore: 100,
      }],
    });
    const before = archive.logicalBytes();

    legacyInsert.run(
      "legacy-late",
      "s1",
      "/project/a",
      "turn",
      2,
      "[user] A newer legacy question?",
      "{}",
    );
    assert.ok(archive.logicalBytes() > before);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM legacy_documents WHERE document_id = 'legacy-late'",
    ).get().n, 1);
    assert.equal(archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "s1",
      project: "/project/a",
    }).status, "ambiguous");

    legacyUpdate.run("[user] Updated by legacy writer", 3, "indexed-turn");
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM archive_messages WHERE document_id = 'indexed-turn'",
    ).get().n, 0);
    assert.equal(archive.db.prepare(
      "SELECT count(*) AS n FROM legacy_documents WHERE document_id = 'indexed-turn'",
    ).get().n, 1);
    assert.equal(archive.searchDetailed("", {
      relation: "latest-question",
      sessionId: "s1",
      project: "/project/a",
    }).status, "legacy-fallback");

    assert.throws(() => legacyInsert.run(
      "legacy-oversized",
      "s1",
      "/project/a",
      "turn",
      4,
      "x".repeat(5_000),
      "{}",
    ), /hard limit exceeded/);
    assert.equal(archive.get("legacy-oversized"), undefined);
  } finally {
    archive?.close();
    legacyDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active archive instances enforce the smallest configured cap without constructor-order races", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-policy-coordination-"));
  const databasePath = join(directory, "archive.db");
  let larger;
  let smaller;
  try {
    larger = new Archive(databasePath, {
      retention: { maxBytes: 10_000, targetBytes: 8_000 },
    });
    smaller = new Archive(databasePath, {
      retention: { maxBytes: 2_000, targetBytes: 1_500 },
    });
    assert.equal(larger.stats().maxBytes, 2_000);
    assert.equal(larger.stats().targetBytes, 1_500);
    smaller.close();
    smaller = undefined;
    assert.equal(larger.stats().maxBytes, 10_000);
    assert.equal(larger.stats().targetBytes, 8_000);
    larger.close();
    larger = undefined;

    smaller = new Archive(databasePath, {
      retention: { maxBytes: 2_000, targetBytes: 1_500 },
    });
    larger = new Archive(databasePath, {
      retention: { maxBytes: 10_000, targetBytes: 8_000 },
    });
    assert.equal(larger.stats().maxBytes, 2_000);
    smaller.close();
    smaller = undefined;
    assert.equal(larger.stats().maxBytes, 10_000);
  } finally {
    try { smaller?.close(); } catch {}
    try { larger?.close(); } catch {}
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

test("retention prunes derived and tool documents before turns and removes FTS rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 2_000,
      targetBytes: 1_000,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  try {
    archive.put({
      id: "decision-1",
      sessionId: "s1",
      project: "/project/a",
      kind: "decision-candidate",
      text: `decision-search-token ${"x".repeat(280)}`,
      createdAt: 1,
    });
    archive.put({
      id: "decision-2",
      sessionId: "s1",
      project: "/project/a",
      kind: "decision-candidate",
      text: `decision-search-token ${"x".repeat(280)}`,
      createdAt: 2,
    });
    archive.put({
      id: "tool-1",
      sessionId: "s1",
      project: "/project/a",
      kind: "tool-result",
      text: `tool-search-token ${"x".repeat(280)}`,
      createdAt: 3,
    });

    assert.equal(archive.get("decision-1"), undefined);
    assert.equal(archive.get("decision-2"), undefined);
    assert.equal(archive.get("tool-1").kind, "tool-result");
    assert.equal(archive.search("decision-search-token", { scope: "all" }).length, 0);
    assert.equal(archive.count({ scope: "all" }), 1);
    assert.equal(archive.stats().lastPrune.status, "pruned");
    assert.deepEqual(archive.stats().lastPrune.byKind, { "decision-candidate": 2 });
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retention prefers never-recalled documents within the same class", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-access-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 10_000,
      targetBytes: 400,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  try {
    archive.put({
      id: "recalled-old",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "old recalled turn",
      createdAt: 1,
    });
    archive.put({
      id: "unrecalled-new",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "new unrecalled turn",
      createdAt: 2,
    });
    archive.get("recalled-old");

    const result = archive.prune({ force: true, now: 10_000 });

    assert.equal(result.status, "pruned");
    assert.equal(archive.get("unrecalled-new"), undefined);
    assert.equal(archive.get("recalled-old").text, "old recalled turn");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retention preserves explicitly protected TOC documents", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-protected-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 2_000,
      targetBytes: 700,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  try {
    archive.put({
      id: "toc-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: `protected toc turn ${"x".repeat(280)}`,
      createdAt: 1,
    });
    archive.setProtectedContext({ sessionIds: ["s1"], documentIds: ["toc-turn"] });
    archive.put({
      id: "old-tool",
      sessionId: "s1",
      project: "/project/a",
      kind: "tool-result",
      text: `disposable tool result ${"x".repeat(280)}`,
      createdAt: 2,
    });
    archive.put({
      id: "trigger-tool",
      sessionId: "s1",
      project: "/project/a",
      kind: "tool-result",
      text: `new tool result ${"x".repeat(280)}`,
      createdAt: 3,
    });

    assert.equal(archive.get("toc-turn").kind, "turn");
    assert.equal(archive.get("old-tool"), undefined);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retention honors another archive instance's active protection lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-lease-"));
  const databasePath = join(directory, "archive.db");
  const owner = new Archive(databasePath, {
    retention: { maxBytes: 10_000, targetBytes: 7_500, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  const cleaner = new Archive(databasePath, {
    retention: { maxBytes: 2_000, targetBytes: 700, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  try {
    owner.put({
      id: "leased-tool",
      sessionId: "active-session",
      project: "/project/a",
      kind: "tool-result",
      text: `leased tool ${"x".repeat(280)}`,
      createdAt: 1,
    }, { deferPrune: true, protect: true });
    cleaner.put({
      id: "disposable-tool",
      sessionId: "inactive-session",
      project: "/project/a",
      kind: "tool-result",
      text: `disposable tool ${"x".repeat(280)}`,
      createdAt: 2,
    });
    cleaner.put({
      id: "trigger-tool",
      sessionId: "inactive-session",
      project: "/project/a",
      kind: "tool-result",
      text: `trigger tool ${"x".repeat(280)}`,
      createdAt: 3,
    });

    assert.equal(cleaner.get("leased-tool").kind, "tool-result");
    assert.equal(cleaner.get("disposable-tool"), undefined);
  } finally {
    owner.close();
    cleaner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session handoff can close its connection without releasing protection leases", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-handoff-"));
  const databasePath = join(directory, "archive.db");
  const owner = new Archive(databasePath, {
    retention: { maxBytes: 10_000, targetBytes: 7_500, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  let cleaner;
  try {
    owner.put({
      id: "handoff-turn",
      sessionId: "old-session",
      project: "/project/a",
      kind: "turn",
      text: `handoff turn ${"x".repeat(280)}`,
      createdAt: 1,
    }, { deferPrune: true, protect: true });
    const previousOwner = owner.close({ releaseProtection: false });
    cleaner = new Archive(databasePath, {
      retention: { maxBytes: 2_000, targetBytes: 100, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
    });

    const protectedBeforeHandoff = cleaner.prune({ force: true, now: Date.now() });
    assert.equal(protectedBeforeHandoff.status, "protected-over-limit");
    cleaner.setProtectedContext({ documentIds: ["handoff-turn"] });
    cleaner.releaseProtectionOwner(previousOwner);
    assert.equal(cleaner.db.prepare(
      "SELECT count(*) AS n FROM archive_protection WHERE owner_id = ?",
    ).get(previousOwner).n, 0);
    const protectedAfterHandoff = cleaner.prune({ force: true, now: Date.now() });
    assert.equal(protectedAfterHandoff.status, "protected-over-limit");
    assert.equal(cleaner.get("handoff-turn").kind, "turn");
  } finally {
    try { owner.close(); } catch {}
    cleaner?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized documents are rejected without leaving recall or FTS entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-oversized-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: { maxBytes: 1_000, targetBytes: 750, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  try {
    const id = archive.put({
      id: "oversized",
      sessionId: "s1",
      project: "/project/a",
      kind: "tool-result",
      text: "oversized-token ".repeat(100),
      createdAt: 1,
    });
    assert.equal(id, undefined);
    assert.equal(archive.get("oversized"), undefined);
    assert.equal(archive.search("oversized-token", { scope: "all" }).length, 0);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aggregate deferred admissions cannot exceed the hard logical watermark", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-batch-cap-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: { maxBytes: 3_000, targetBytes: 2_000, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  try {
    const first = archive.put({
      id: "batch-1",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "a".repeat(500),
      createdAt: 1,
    }, { deferPrune: true, protect: true });
    const second = archive.put({
      id: "batch-2",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "b".repeat(500),
      createdAt: 2,
    }, { deferPrune: true, protect: true });
    const third = archive.put({
      id: "batch-3",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "c".repeat(500),
      createdAt: 3,
    }, { deferPrune: true, protect: true });

    assert.ok(first);
    assert.ok(second);
    assert.equal(third, undefined);
    assert.ok(archive.logicalBytes() <= 3_000);
    assert.equal(archive.get("batch-3"), undefined);
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed legacy decision metadata cannot block pruning a parent turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retention-malformed-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: { maxBytes: 10_000, targetBytes: 400, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
  });
  try {
    archive.put({
      id: "old-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "old parent turn",
      createdAt: 1,
    });
    archive.put({
      id: "malformed-decision",
      sessionId: "s1",
      project: "/project/a",
      kind: "decision-candidate",
      text: "malformed decision",
      createdAt: 2,
    });
    archive.put({
      id: "newest-turn",
      sessionId: "s1",
      project: "/project/a",
      kind: "turn",
      text: "newest retained turn",
      createdAt: 3,
    });
    archive.db.prepare("UPDATE documents SET metadata_json = '{broken' WHERE id = 'malformed-decision'").run();
    archive.setProtectedContext({ documentIds: ["malformed-decision"] });

    assert.doesNotThrow(() => archive.prune({ force: true, now: 10_000 }));
    assert.equal(archive.get("malformed-decision").metadataParse.status, "malformed-json");
  } finally {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new archives expose incremental reclamation while legacy archives require offline upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-reclaim-"));
  const newPath = join(directory, "new.db");
  const legacyPath = join(directory, "legacy.db");
  let legacy = new Archive(legacyPath);
  let legacyArchive;
  let freshArchive;
  try {
    // Recreate this fixture as a legacy auto_vacuum=NONE database.
    legacy.close();
    legacy = undefined;
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(legacyPath)});
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=NONE; VACUUM;");
      db.close();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script]);
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);

    legacyArchive = new Archive(legacyPath);
    freshArchive = new Archive(newPath, {
      retention: { maxBytes: 100_000_000, targetBytes: 100_000, recentProtectionMs: 0, minimumTurnsPerSession: 0 },
    });
    assert.equal(legacyArchive.stats().autoVacuum, "none");
    assert.equal(legacyArchive.reclaim().status, "offline-upgrade-required");
    assert.equal(freshArchive.stats().autoVacuum, "incremental");

    for (let index = 0; index < 20; index += 1) {
      freshArchive.put({
        id: `reclaim-${index}`,
        sessionId: `session-${index}`,
        project: "/project/a",
        kind: "tool-result",
        text: "x".repeat(20_000),
        createdAt: index + 1,
      });
    }
    freshArchive.prune({ force: true, now: 1_000_000 });
    const before = freshArchive.stats();
    const reclaimed = freshArchive.reclaim({ pages: 10_000 });
    assert.equal(reclaimed.status, "reclaimed");
    assert.ok(reclaimed.after.allocatedBytes < before.allocatedBytes);
    assert.equal(reclaimed.after.reclaimableBytes, 0);
    assert.equal(reclaimed.after.walBytes, 0);
  } finally {
    legacy?.close();
    legacyArchive?.close();
    freshArchive?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds a safe FTS expression", () => {
  assert.equal(matchExpression('token " OR * refresh'), '"token" OR "or" OR "refresh"');
  assert.equal(matchExpression("?"), "");
});
