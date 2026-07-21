import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import {
  isArchiveEchoDocument,
  isArchiveEchoToolName,
} from "../src/rocksdb/index/echo.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument, manifestKeys } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { searchArchive } from "../src/retrieval/search.js";

const PROJECT = "/workspace/archive-echo";

function admission(id, { kind = "turn", text, toolName, createdAt = Date.now() } = {}) {
  const sourceKey = kind === "turn" ? `user:${id}` : `toolResult:${id}`;
  return {
    idempotencyKey: `echo:${id}`,
    document: {
      documentId: id,
      version: 1,
      sourceKey,
      sessionId: "session-echo",
      project: PROJECT,
      kind,
      createdAt,
      text,
      metadata: kind === "turn"
        ? { turnId: `turn-${id}` }
        : { toolCallId: `call-${id}`, toolName },
      sourceMessageKeys: [sourceKey],
    },
    ...(kind === "turn"
      ? {
        structuralMessages: [{
          messageKey: sourceKey,
          messageIndex: 0,
          role: "user",
          createdAt,
          text,
          questionScore: 50,
          requestScore: 50,
          correctionScore: 0,
          answerScore: 0,
        }],
      }
      : {}),
    retentionClass: kind === "turn" ? "conversation-source" : "ephemeral-payload",
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-echo-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const worker = new IndexWorker(store, {
    workerId: "echo-worker",
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  return { store, worker };
}

test("archive tool names are recognized as echo, including namespaced spellings", () => {
  assert.equal(isArchiveEchoToolName("context_window_search"), true);
  assert.equal(isArchiveEchoToolName("context_window_gather"), true);
  assert.equal(isArchiveEchoToolName("context_window_traverse"), true);
  assert.equal(isArchiveEchoToolName("context_recall"), true);
  assert.equal(isArchiveEchoToolName("mcp__context-window__context_window_search"), true);
  assert.equal(isArchiveEchoToolName("Context_Window_Search"), true);
  assert.equal(isArchiveEchoToolName("bash"), false);
  assert.equal(isArchiveEchoToolName("web_search"), false);
  // A name merely containing an echo tool name is not echo.
  assert.equal(isArchiveEchoToolName("context_window_search_helper"), false);
  assert.equal(isArchiveEchoToolName(undefined), false);

  assert.equal(isArchiveEchoDocument({
    kind: "tool-result",
    metadata: { toolName: "context_window_search" },
  }), true);
  assert.equal(isArchiveEchoDocument({
    kind: "turn",
    metadata: { toolName: "context_window_search" },
  }), false);
  assert.equal(isArchiveEchoDocument({
    kind: "tool-result",
    metadata: { toolName: "bash" },
  }), false);
});

test("search echo stays recallable but never outranks or even joins retrieval results", async (t) => {
  const { store, worker } = await fixture(t);
  const now = Date.now();

  // The answer-bearing source document mentions the rare token once.
  await admitDocument(store, admission("source-1", {
    kind: "turn",
    text: "The benchmark comparison table lists ECHOPROBEMARK as one candidate benchmark.",
    createdAt: now - 60_000,
  }));
  // A search echo repeats the same token many times: under term-frequency
  // ranking it would dominate the source document if it were indexed.
  await admitDocument(store, admission("echo-1", {
    kind: "tool-result",
    toolName: "context_window_search",
    text: Array.from({ length: 20 }, (_, index) => (
      `{"rank":${index + 1},"snippet":"… ECHOPROBEMARK appears in ECHOPROBEMARK results …"}`
    )).join("\n"),
    createdAt: now - 30_000,
  }));
  // A non-archive tool result with its own token stays indexed (control).
  await admitDocument(store, admission("control-1", {
    kind: "tool-result",
    toolName: "bash",
    text: "build log line: CONTROLPROBEMARK emitted by the compiler",
    createdAt: now - 45_000,
  }));
  await worker.drain({ limit: 1_000, maxDurationMs: 30_000, throwOnError: true });

  const echoQuery = await searchArchive(store, {
    query: "ECHOPROBEMARK",
    relation: null,
    scope: "project",
    sessionIds: [],
    project: PROJECT,
    limit: 5,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  });
  assert.equal(echoQuery.status, "resolved");
  assert.ok(echoQuery.results.length >= 1);
  assert.equal(echoQuery.results[0].documentId, "source-1");
  assert.equal(
    echoQuery.results.some((result) => result.documentId === "echo-1"),
    false,
    "an archive-search echo must not appear in retrieval results",
  );

  const controlQuery = await searchArchive(store, {
    query: "CONTROLPROBEMARK",
    relation: null,
    scope: "project",
    sessionIds: [],
    project: PROJECT,
    limit: 5,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  });
  assert.equal(
    controlQuery.results.some((result) => result.documentId === "control-1"),
    true,
    "ordinary tool results must remain retrievable",
  );

  // The echo document itself stays archived and recallable by exact identity.
  const manifest = await store.get(manifestKeys.document("echo-1", 1));
  assert.equal(manifest?.documentId, "echo-1");
  assert.match(manifest.metadata.toolName, /context_window_search/);
});
