import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Archive } from "../src/archive.js";
import {
  ARCHIVED_EVIDENCE_LABEL,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";

function startServer(databasePath) {
  return spawn(process.execPath, ["bin/context-window-mcp.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CONTEXT_WINDOW_DB: databasePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  const responses = collectLines(child.stdout, 2);

  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "context_recall", arguments: { id: "missing" } },
    })}\n`);

    const [listed, recalled] = await responses;
    const search = listed.result.tools.find(({ name }) => name === "context_window_search");
    const recall = listed.result.tools.find(({ name }) => name === "context_recall");
    assert.equal(listed.result.tools.some(({ name }) => name === "context_window_recall"), false);
    assert.equal(search.description, SEARCH_TOOL_DESCRIPTION);
    assert.equal(recall.description, RECALL_TOOL_DESCRIPTION);
    assert.match(search.description, /historical evidence candidates/);
    assert.match(search.description, /context_recall.*exact original wording or source evidence/);
    assert.match(search.description, /live tools—not the archive—for current mutable state/);
    assert.match(search.description, /mixed questions.*archived intent first.*inspect live state.*reconcile conflicts/);
    assert.match(search.description, /Historical framing.*invitation to search history.*exclusively current question/);
    assert.match(recall.description, /exact archived source document/);
    assert.match(recall.description, /exact original wording or source evidence/);
    assert.match(recall.description, /not as proof of current mutable state.*live tools/);
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
    rmSync(directory, { recursive: true, force: true });
  }
});
