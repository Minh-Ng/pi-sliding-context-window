#!/usr/bin/env node
import { Archive } from "../src/archive.js";
import { claimSqliteBackendAuthority } from "../src/backend-authority.js";
import { DaemonArchive } from "../src/daemon-archive.js";
import { loadConfig } from "../src/config.js";
import { retentionPolicyFromDays } from "../src/daemon/retention-policy.js";
import { LineFramer } from "../src/daemon/framing.js";
import {
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { formatArchiveStorage, formatRecalledDocument, formatSearchResults } from "../src/presentation.js";
import { STRUCTURAL_RELATIONS } from "../src/structural.js";
import {
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_STORE_IDENTIFIER_LENGTH,
} from "../src/store-contract.js";

const project = process.env.CONTEXT_WINDOW_PROJECT ?? process.cwd();
const sessionId = process.env.CONTEXT_WINDOW_SESSION ?? `mcp-${process.pid}`;
const config = loadConfig({ cwd: project, projectTrusted: false });
let archive;
if (config.archiveBackend === "sqlite") {
  claimSqliteBackendAuthority({
    storePath: config.rocksdbPath,
    socketPath: config.socketPath,
    sourcePath: config.dbPath,
    project,
  });
  archive = new Archive(config.dbPath, {
    retention: {
      maxBytes: config.maxArchiveBytes,
      targetBytes: config.targetArchiveBytes,
      recentProtectionMs: config.recentDocumentProtectionDays * 24 * 60 * 60 * 1_000,
      minimumTurnsPerSession: config.minimumTurnsPerSession,
    },
  });
} else {
  archive = new DaemonArchive({
    storePath: config.rocksdbPath,
    socketPath: config.socketPath,
    project,
    recallMaxTokens: Math.max(39, config.searchResultTokens * 2),
    retentionPolicy: retentionPolicyFromDays(config),
    migrationSourcePath: config.dbPath,
  });
}
const MCP_PROTOCOL_VERSION = "2025-06-18";
const POLICY_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
// Bound the encoded MCP transport independently from logical field limits.
// Ordinary maximum archive content fits with envelope headroom; JSON whose
// escape expansion would require unsafe transient parser copies is rejected.
const MCP_DEFAULT_MAX_INPUT_FRAME_BYTES = 16 * 1_024 * 1_024;
const configuredInputFrameBytes = Number(process.env.CONTEXT_WINDOW_MCP_TEST_MAX_FRAME_BYTES);
const MCP_MAX_INPUT_FRAME_BYTES = Number.isSafeInteger(configuredInputFrameBytes)
  && configuredInputFrameBytes > 0
  ? Math.min(configuredInputFrameBytes, MCP_DEFAULT_MAX_INPUT_FRAME_BYTES)
  : MCP_DEFAULT_MAX_INPUT_FRAME_BYTES;
let archiveClosed = false;
const policyRefreshTimer = setInterval(() => {
  try { archive.refreshPolicyLease(); } catch { /* the next tool call or heartbeat retries */ }
}, POLICY_REFRESH_INTERVAL_MS);
policyRefreshTimer.unref();

function closeArchive() {
  if (archiveClosed) return;
  archiveClosed = true;
  clearInterval(policyRefreshTimer);
  archive.close();
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const tools = [
  {
    name: "context_window_search",
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 65_536 },
        relation: { type: "string", enum: [...STRUCTURAL_RELATIONS] },
        scope: { type: "string", enum: ["session", "project", "all"], default: "project" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      anyOf: [{ required: ["query"] }, { required: ["relation"] }],
      additionalProperties: false,
    },
  },
  {
    name: "context_recall",
    description: RECALL_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "context_window_archive",
    description: "Store text outside the active model context so it can later be found with BM25 search.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: MAX_DOCUMENT_TEXT_BYTES },
        kind: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH, default: "manual" },
        metadata: { type: "object" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "context_window_status",
    description: "Show local context archive status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function callTool(name, args = {}) {
  switch (name) {
    case "context_window_search": {
      const query = String(args.query ?? "").trim();
      if (!query && !args.relation) {
        return textResult("context_window_search requires query or relation.", true);
      }
      const search = archive.searchDetailed(query, {
        relation: args.relation,
        sessionId,
        project,
        scope: args.scope ?? "project",
        limit: args.limit ?? config.searchResults,
      });
      return textResult(formatSearchResults(search.results, config.searchResultTokens, search));
    }
    case "context_recall": {
      const document = archive.get(String(args.id ?? ""));
      return textResult(
        formatRecalledDocument(document, config.searchResultTokens * 2, args.id),
        !document,
      );
    }
    case "context_window_archive": {
      const id = archive.put({
        sessionId,
        project,
        kind: String(args.kind ?? "manual"),
        text: String(args.text ?? ""),
        metadata: args.metadata ?? {},
      });
      return id ? textResult(`Archived as ${id}.`) : textResult("Nothing to archive.", true);
    }
    case "context_window_status":
      return textResult([
        `Archive: ${config.archiveBackend === "rocksdb" ? config.rocksdbPath : config.dbPath}`,
        `Project documents: ${archive.count({ project, scope: "project" })}`,
        formatArchiveStorage(archive.stats()),
      ].join("\n"));
    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

function respond(message) {
  if (message.id === undefined) return;
  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "context-epoch-window", version: "0.1.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        result = callTool(message.params?.name, message.params?.arguments);
        break;
      default:
        writeMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
        return;
    }
    writeMessage({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

const input = new LineFramer({ maxFrameBytes: MCP_MAX_INPUT_FRAME_BYTES });
let inputFailed = false;

function rejectInput(message = "Parse error") {
  if (inputFailed) return;
  inputFailed = true;
  input.discard();
  writeMessage({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message },
  });
  process.exitCode = 1;
  closeArchive();
  process.stdin.destroy();
}

function acceptInputLine(line) {
  if (line.length === 0) return;
  const text = line.toString("utf8");
  if (text.trim().length === 0) return;
  try {
    respond(JSON.parse(text));
  } catch {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
}

process.stdin.on("data", (chunk) => {
  if (inputFailed) return;
  try {
    for (const line of input.push(chunk)) acceptInputLine(line);
  } catch {
    rejectInput(`Input frame exceeds ${MCP_MAX_INPUT_FRAME_BYTES} bytes.`);
  }
});
process.stdin.on("end", () => {
  if (inputFailed) return;
  try {
    input.finish();
    closeArchive();
  } catch {
    rejectInput("Incomplete input frame.");
  }
});
process.stdin.on("close", closeArchive);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    closeArchive();
    process.exit(0);
  });
}
