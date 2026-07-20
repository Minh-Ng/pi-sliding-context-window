import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Archive } from "../src/archive/archive.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import {
  ARCHIVED_EVIDENCE_LABEL,
  GATHER_TOOL_DESCRIPTION,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_SCOPE_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { StoreClient } from "../src/store/store-client.js";
import {
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_STORE_IDENTIFIER_LENGTH,
} from "../src/store/store-contract.js";

function startServer(databasePath, extraEnvironment = {}) {
  const directory = dirname(databasePath);
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = directory;
  const child = spawn(process.execPath, ["bin/context-window-mcp.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOME: directory,
      CONTEXT_WINDOW_BACKEND: "sqlite",
      CONTEXT_WINDOW_DB: databasePath,
      CONTEXT_WINDOW_ROCKSDB: storePath,
      CONTEXT_WINDOW_SOCKET: socketPath,
      CONTEXT_WINDOW_PROJECT: project,
      ...extraEnvironment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.authority = { socketPath, project };
  return child;
}

function startRocksServer({ directory, storePath, socketPath, project }) {
  const env = {
    ...process.env,
    HOME: directory,
    CONTEXT_WINDOW_PROJECT: project,
    CONTEXT_WINDOW_SESSION: "mcp-rocks-session",
    CONTEXT_WINDOW_ROCKSDB: storePath,
    CONTEXT_WINDOW_SOCKET: socketPath,
  };
  // The absence of this switch is the behavior under test: RocksDB is the
  // default adapter, even when the invoking process happens to override it.
  delete env.CONTEXT_WINDOW_BACKEND;
  delete env.CONTEXT_WINDOW_DB;
  return spawn(process.execPath, ["bin/context-window-mcp.js"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function rpcClient(child) {
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let sequence = 0;
  input.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    waiter.resolve(response);
  });
  input.on("error", (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return {
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
    close() { input.close(); },
  };
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(processId) {
  if (!processId || !processExists(processId)) return;
  process.kill(processId, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(processId)) {
    process.kill(processId, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function daemonStatus(socketPath, project) {
  const client = new StoreClient({ socketPath, project, requestTimeoutMs: 5_000 });
  try {
    return await client.request("daemon.status", {});
  } finally {
    client.close();
  }
}

async function stopServerAuthority(child) {
  const authority = child.authority;
  if (!authority) return;
  let processId;
  try { processId = (await daemonStatus(authority.socketPath, authority.project)).processId; } catch {}
  await stopProcess(processId);
  rmSync(authority.socketPath, { force: true });
}

function collectLines(stream, count) {
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    const lines = [];
    input.on("line", (line) => {
      lines.push(JSON.parse(line));
      if (lines.length === count) {
        input.close();
        resolve(lines);
      }
    });
    input.on("error", reject);
  });
}

test("MCP exposes routing guidance and labels recall output as archived evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-routing-"));
  const child = startServer(join(directory, "archive.db"));
  const responses = collectLines(child.stdout, 6);

  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "context_recall", arguments: { id: "missing" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "context_window_status", arguments: {} },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "context_window_search", arguments: { relation: "latest-question" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "context_window_search", arguments: { query: "What is the current recorded count?" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "context_window_gather", arguments: { query: "Use the previous workflow", intent: "workflow" } },
    })}\n`);

    const [listed, recalled, status, structural, updateSearch, gathered] = await responses;
    const gather = listed.result.tools.find(({ name }) => name === "context_window_gather");
    const search = listed.result.tools.find(({ name }) => name === "context_window_search");
    const recall = listed.result.tools.find(({ name }) => name === "context_recall");
    const archiveTool = listed.result.tools.find(({ name }) => name === "context_window_archive");
    assert.equal(listed.result.tools.some(({ name }) => name === "context_window_recall"), false);
    assert.equal(gather.description, GATHER_TOOL_DESCRIPTION);
    assert.equal(gather.inputSchema.properties.scope.description, SEARCH_SCOPE_DESCRIPTION);
    assert.equal(search.description, SEARCH_TOOL_DESCRIPTION);
    assert.equal(search.inputSchema.properties.scope.description, SEARCH_SCOPE_DESCRIPTION);
    assert.match(search.inputSchema.properties.scope.description, /all.*does not bypass project authorization/i);
    assert.equal(recall.description, RECALL_TOOL_DESCRIPTION);
    assert.equal(search.inputSchema.properties.query.maxLength, 65_536);
    assert.equal(recall.inputSchema.properties.id.maxLength, MAX_STORE_IDENTIFIER_LENGTH);
    assert.equal(archiveTool.inputSchema.properties.text.maxLength, MAX_DOCUMENT_TEXT_BYTES);
    assert.match(search.description, /historical evidence candidates/);
    assert.match(search.description, /context_recall.*exact original wording or source evidence/);
    assert.match(search.description, /live tools—not the archive—for current mutable state/);
    assert.match(search.description, /mixed questions.*archived intent first.*inspect live state.*reconcile conflicts/);
    assert.match(search.description, /Historical framing.*invitation to search history.*exclusively current question/);
    assert.match(recall.description, /exact archived source document/);
    assert.match(recall.description, /exact original wording or source evidence/);
    assert.match(recall.description, /not as proof of current mutable state.*live tools/);
    assert.match(status.result.content[0].text, /Archive logical usage/);
    assert.match(status.result.content[0].text, /SQLite files/);
    assert.match(structural.result.content[0].text, /Structural retrieval: latest-question — not-found/);
    assert.match(updateSearch.result.content[0].text, /Time-sensitive archive query/);
    assert.match(updateSearch.result.content[0].text, /does not replace live inspection/);
    assert.match(gathered.result.content[0].text, /Bounded historical gather: workflow — not-found/u);
    assert.equal(gathered.result.isError, true);
    assert.equal(recalled.result.isError, true);
    assert.equal(
      recalled.result.content[0].text.startsWith(`[${ARCHIVED_EVIDENCE_LABEL}]\n\n`),
      true,
    );

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopServerAuthority(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP bounds oversized and unterminated stdin before JSON parsing", async () => {
  const cases = [
    {
      name: "oversized",
      bytes: Buffer.alloc(1_025, 0x20),
      expected: /exceeds 1024 bytes/u,
    },
    {
      name: "unterminated",
      bytes: Buffer.from('{"jsonrpc":"2.0"', "utf8"),
      expected: /Incomplete input frame/u,
    },
  ];
  for (const candidate of cases) {
    const directory = mkdtempSync(join(tmpdir(), `context-window-mcp-${candidate.name}-`));
    const child = startServer(join(directory, "archive.db"), {
      CONTEXT_WINDOW_MCP_TEST_MAX_FRAME_BYTES: "1024",
    });
    const responses = collectLines(child.stdout, 1);
    try {
      child.stdin.end(candidate.bytes);
      const [response] = await responses;
      assert.equal(response.id, null);
      assert.equal(response.error.code, -32700);
      assert.match(response.error.message, candidate.expected);
      const [exitCode] = await once(child, "exit");
      assert.equal(exitCode, 1);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await stopServerAuthority(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("MCP defaults to project-bound RocksDB search and locator recall", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-rocks-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = join(directory, "project");
  const child = startRocksServer({ directory, storePath, socketPath, project });
  const rpc = rpcClient(child);
  let daemonProcessId;

  try {
    const archived = await rpc.request("tools/call", {
      name: "context_window_archive",
      arguments: {
        kind: "manual",
        text: "MCP_ROCKS_LOCATOR_TOKEN exact archived version one",
      },
    });
    assert.equal(archived.error, undefined);
    assert.match(archived.result.content[0].text, /^Archived as /u);

    const searched = await rpc.request("tools/call", {
      name: "context_window_search",
      arguments: { query: "MCP_ROCKS_LOCATOR_TOKEN", scope: "project", limit: 3 },
    });
    assert.equal(searched.error, undefined);
    const locator = searched.result.content[0].text.match(
      /\b(cw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/u,
    )?.[1];
    assert.ok(locator, "search must expose an opaque exact-version locator");

    const recalled = await rpc.request("tools/call", {
      name: "context_recall",
      arguments: { id: locator },
    });
    assert.equal(recalled.error, undefined);
    assert.equal(recalled.result.isError, false);
    assert.match(recalled.result.content[0].text, /MCP_ROCKS_LOCATOR_TOKEN exact archived version one/u);
    assert.match(recalled.result.content[0].text, /ARCHIVED HISTORICAL EVIDENCE/u);
    const recallLines = recalled.result.content[0].text.split("\n");
    assert.equal(recallLines.length, 2);
    const recallEnvelope = JSON.parse(recallLines[1]);
    assert.equal(recallEnvelope.trust, "untrusted-archived-data");
    assert.match(JSON.parse(recallEnvelope.bodyJson), /MCP_ROCKS_LOCATOR_TOKEN/u);

    const status = await rpc.request("tools/call", {
      name: "context_window_status",
      arguments: {},
    });
    assert.equal(status.error, undefined);
    assert.match(status.result.content[0].text, /RocksDB archive: 1 document/u);
    assert.match(status.result.content[0].text, new RegExp(storePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.doesNotMatch(status.result.content[0].text, /SQLite files/u);

    const rightProject = new StoreClient({ socketPath, project, requestTimeoutMs: 5_000 });
    const wrongProject = new StoreClient({
      socketPath,
      project: join(directory, "other-project"),
      requestTimeoutMs: 5_000,
    });
    try {
      assert.equal((await rightProject.request("store.count", { scope: "project" })).count, 1);
      assert.equal((await wrongProject.request("store.count", { scope: "project" })).count, 0);
      daemonProcessId = (await rightProject.request("daemon.status", {})).processId;
    } finally {
      rightProject.close();
      wrongProject.close();
    }

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    rpc.close();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (!daemonProcessId) {
      try { daemonProcessId = (await daemonStatus(socketPath, project)).processId; } catch {}
    }
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP archive tool admits a subjectKey and requires supersedes to replace its live document", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-subject-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = join(directory, "project");
  const child = startRocksServer({ directory, storePath, socketPath, project });
  const rpc = rpcClient(child);
  let daemonProcessId;

  try {
    const first = await rpc.request("tools/call", {
      name: "context_window_archive",
      arguments: {
        kind: "decision",
        text: "The team settled on port 8443 for the admin console.",
        subjectKey: "decision:admin-console-port",
      },
    });
    assert.equal(first.error, undefined);
    assert.equal(first.result.isError, false);
    const firstId = first.result.content[0].text.match(/^Archived as (\S+)\.$/u)?.[1];
    assert.ok(firstId, "first archive call must report a document id");

    // Re-archiving the same live subjectKey without supersedes must fail closed.
    const conflicting = await rpc.request("tools/call", {
      name: "context_window_archive",
      arguments: {
        kind: "decision",
        text: "The team settled on port 9443 for the admin console.",
        subjectKey: "decision:admin-console-port",
      },
    });
    assert.equal(conflicting.result, undefined);
    assert.match(conflicting.error.message, /subjectKey.*is live at/u);

    const superseding = await rpc.request("tools/call", {
      name: "context_window_archive",
      arguments: {
        kind: "decision",
        text: "The team settled on port 9443 for the admin console.",
        subjectKey: "decision:admin-console-port",
        supersedes: { documentId: firstId, version: 1 },
      },
    });
    assert.equal(superseding.error, undefined);
    assert.equal(superseding.result.isError, false);

    const searched = await rpc.request("tools/call", {
      name: "context_window_search",
      arguments: { query: "admin console port", scope: "project", limit: 3 },
    });
    assert.equal(searched.error, undefined);
    assert.match(searched.result.content[0].text, /9443/u);
    assert.doesNotMatch(searched.result.content[0].text, /8443/u);

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    rpc.close();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (!daemonProcessId) {
      try { daemonProcessId = (await daemonStatus(socketPath, project)).processId; } catch {}
    }
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP recall renders archive, source-message, and tool-result provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-provenance-"));
  const databasePath = join(directory, "archive.db");
  const archive = new Archive(databasePath);
  const sourceKeys = Array.from({ length: 200 }, (_, index) =>
    `message-${index}-${"long-source-key".repeat(12)}`,
  );
  archive.put({
    id: "turn-with-source",
    sessionId: "fork-session",
    project: "/project",
    kind: "turn",
    text: "deterministic archived serialization that must remain visible",
    createdAt: 123,
    metadata: {
      sourceMessageKeys: sourceKeys,
      sourceFirstKey: sourceKeys[0],
      sourceLastKey: sourceKeys.at(-1),
      sourceMessageCount: sourceKeys.length,
    },
  });
  archive.put({
    id: "tool-source",
    sessionId: "fork-session",
    project: "/project",
    kind: "tool-result",
    text: "tool output",
    createdAt: 124,
    metadata: {
      toolCallId: "call-9",
      toolName: "read",
      sourceMessageKey: "toolResult:3:call-9:abcdef123456",
    },
  });
  archive.close();

  const child = startServer(databasePath);
  const responses = collectLines(child.stdout, 2);
  try {
    for (const [id, archiveId] of [[1, "turn-with-source"], [2, "tool-source"]]) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "context_recall", arguments: { id: archiveId } },
      })}\n`);
    }
    const [turn, tool] = await responses;
    assert.match(turn.result.content[0].text, /Archive: turn-with-source \(turn\)/);
    assert.match(turn.result.content[0].text, /Session: fork-session/);
    assert.ok(turn.result.content[0].text.length <= 1_500 * 2 * 4);
    assert.match(turn.result.content[0].text, /deterministic archived serialization that must remain visible/);
    assert.match(turn.result.content[0].text, /Ordered source message keys: message-0/);
    assert.equal(turn.result.content[0].text.includes(sourceKeys[100]), false);
    assert.match(tool.result.content[0].text, /Source message: toolResult:3:call-9:abcdef123456/);
    assert.match(tool.result.content[0].text, /one original message; this tool-result document is not an archived turn/);
    assert.match(tool.result.content[0].text, /Tool call ID: call-9/);
    assert.match(tool.result.content[0].text, /Tool name: read/);

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopServerAuthority(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP promote returns a landable draft, not a checklist, and never edits the repo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-promote-"));
  const databasePath = join(directory, "archive.db");
  const archive = new Archive(databasePath);
  archive.put({
    id: "short-decision",
    sessionId: "promote-session",
    project: "/project",
    kind: "turn",
    text: "Use RocksDB as the sole archive backend for context-window.",
    createdAt: Date.parse("2026-01-15T00:00:00Z"),
  });
  archive.put({
    id: "long-decision",
    sessionId: "promote-session",
    project: "/project",
    kind: "turn",
    text: "We evaluated three storage backends for the archive.\n\n"
      + "After benchmarking, RocksDB was selected because it supports the "
      + "single-owner daemon model without a network dependency, and because "
      + "its LSM compaction reclaims tombstoned records without a maintenance window.",
    createdAt: Date.parse("2026-01-16T00:00:00Z"),
  });
  archive.close();

  const child = startServer(databasePath);
  const responses = collectLines(child.stdout, 3);
  try {
    for (const [id, archiveId] of [[1, "short-decision"], [2, "long-decision"], [3, "missing-id"]]) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "context_window_promote", arguments: { id: archiveId } },
      })}\n`);
    }
    const [short, long, missing] = await responses;

    const shortText = short.result.content[0].text;
    assert.equal(short.result.isError, false);
    assert.match(shortText, /Document: short-decision \(turn\)/);
    assert.match(shortText, /Session: promote-session/);
    assert.match(shortText, /Date: 2026-01-15/);
    assert.match(shortText, /Draft \(AGENTS\.md \/ CLAUDE\.md diff hunk\) — target AGENTS\.md/);
    assert.match(shortText, /\+\+\+ b\/AGENTS\.md/);
    assert.match(shortText, /\+- Use RocksDB as the sole archive backend for context-window\./);
    assert.doesNotMatch(shortText, /Suggested landings:/);
    assert.doesNotMatch(shortText, /Next: edit the repo/);
    assert.match(shortText, /Do not pin the archive\./);

    const longText = long.result.content[0].text;
    assert.equal(long.result.isError, false);
    assert.match(longText, /Draft \(ADR file body\) — target docs\/adr\/2026-01-16-/);
    assert.match(longText, /## Decision/);
    assert.match(longText, /After benchmarking, RocksDB was selected/);
    assert.match(longText, /## Provenance/);
    assert.match(longText, /Archived document: long-decision \(turn\)/);
    assert.match(longText, /Session: promote-session/);

    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /No archived document found to promote\./);

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopServerAuthority(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP promote on the default RocksDB backend drafts the decision text, not the archived-evidence envelope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-promote-rocks-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  const project = join(directory, "project");
  const child = startRocksServer({ directory, storePath, socketPath, project });
  const rpc = rpcClient(child);
  let daemonProcessId;

  try {
    const archived = await rpc.request("tools/call", {
      name: "context_window_archive",
      arguments: {
        kind: "manual",
        text: "Use RocksDB as the sole archive backend for context-window.",
      },
    });
    assert.equal(archived.error, undefined);

    const searched = await rpc.request("tools/call", {
      name: "context_window_search",
      arguments: { query: "sole archive backend for context-window", scope: "project", limit: 3 },
    });
    assert.equal(searched.error, undefined);
    const locator = searched.result.content[0].text.match(
      /\b(cw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/u,
    )?.[1];
    assert.ok(locator, "search must expose an opaque exact-version locator");

    const promoted = await rpc.request("tools/call", {
      name: "context_window_promote",
      arguments: { id: locator },
    });
    assert.equal(promoted.error, undefined);
    assert.equal(promoted.result.isError, false);
    const promotedText = promoted.result.content[0].text;
    assert.match(promotedText, /Draft \(AGENTS\.md \/ CLAUDE\.md diff hunk\) — target AGENTS\.md/);
    assert.match(promotedText, /\+- Use RocksDB as the sole archive backend for context-window\./);
    assert.doesNotMatch(promotedText, /ARCHIVED HISTORICAL EVIDENCE/u);
    assert.doesNotMatch(promotedText, /untrusted-archived-data/u);

    const storeClient = new StoreClient({ socketPath, project, requestTimeoutMs: 5_000 });
    try {
      daemonProcessId = (await storeClient.request("daemon.status", {})).processId;
    } finally {
      storeClient.close();
    }

    child.stdin.end();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
  } finally {
    rpc.close();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (!daemonProcessId) {
      try { daemonProcessId = (await daemonStatus(socketPath, project)).processId; } catch {}
    }
    await stopProcess(daemonProcessId);
    rmSync(socketPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP negotiates its supported version and reports malformed JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-mcp-"));
  const child = startServer(join(directory, "archive.db"));
  const responses = collectLines(child.stdout, 2);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })}\n`);
    child.stdin.write("{not-json\n");

    const [initialize, parseError] = await responses;
    assert.equal(initialize.result.protocolVersion, "2025-06-18");
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    child.stdin.end();
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopServerAuthority(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
