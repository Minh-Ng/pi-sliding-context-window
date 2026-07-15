#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Archive } from "../src/archive.js";
import { loadConfig } from "../src/config.js";
import {
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { formatRecalledDocument, formatSearchResults } from "../src/presentation.js";

const project = process.env.CONTEXT_WINDOW_PROJECT ?? process.cwd();
const sessionId = process.env.CONTEXT_WINDOW_SESSION ?? `mcp-${process.pid}`;
const config = loadConfig({ cwd: project, projectTrusted: false });
const archive = new Archive(config.dbPath);
const MCP_PROTOCOL_VERSION = "2025-06-18";
let archiveClosed = false;

function closeArchive() {
  if (archiveClosed) return;
  archiveClosed = true;
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
        query: { type: "string" },
        scope: { type: "string", enum: ["session", "project", "all"], default: "project" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "context_recall",
    description: RECALL_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
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
        text: { type: "string" },
        kind: { type: "string", default: "manual" },
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
      const results = archive.search(String(args.query ?? ""), {
        sessionId,
        project,
        scope: args.scope ?? "project",
        limit: args.limit ?? config.searchResults,
      });
      return textResult(formatSearchResults(results, config.searchResultTokens));
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
      return textResult(`Archive: ${config.dbPath}\nProject documents: ${archive.count({ project, scope: "project" })}`);
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

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    respond(JSON.parse(line));
  } catch {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
});
input.on("close", closeArchive);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    closeArchive();
    process.exit(0);
  });
}
