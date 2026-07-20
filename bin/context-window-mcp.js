#!/usr/bin/env node
import { Archive } from "../src/archive/archive.js";
import { claimSqliteBackendAuthority } from "../src/archive/backend-authority.js";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { loadConfig } from "../src/config.js";
import { retentionPolicyFromDays } from "../src/daemon/retention-policy.js";
import { LineFramer } from "../src/daemon/framing.js";
import { canonicalProjectId, projectIdentityAlias } from "../src/identity/project-identity.js";
import {
  GATHER_TOOL_DESCRIPTION,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_SCOPE_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SUPERSEDE_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import {
  formatArchiveStorage,
  formatGatherResults,
  formatPromotePacket,
  formatRecalledDocument,
  formatRedactResult,
  formatSearchResults,
  formatSupersedeResult,
} from "../src/presentation.js";
import { STRUCTURAL_RELATIONS } from "../src/structural-annotations.js";
import {
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_STORE_IDENTIFIER_LENGTH,
} from "../src/store/store-contract.js";

// Canonicalize so a repository reached through a symlink or alternate spelling
// shares one archive namespace. The literal spelling is carried as a read-only
// alias so archives written under the pre-canonical key stay reachable. An
// explicit CONTEXT_WINDOW_PROJECT override is left uncanonicalized: it is how an
// operator names the mutation-authoritative project (e.g. to reach a
// pre-canonical spelling for supersede/redact/pin), and canonicalizing it would
// both strand legacy-keyed records as read-only forever and silently rewrite an
// opaque project label into an absolute realpath whenever it happens to match a
// directory relative to the current cwd.
const explicitProject = process.env.CONTEXT_WINDOW_PROJECT;
const project = explicitProject ?? canonicalProjectId(process.cwd());
const projectAlias = explicitProject === undefined ? projectIdentityAlias(process.cwd()) : undefined;
const aliasProjects = projectAlias === undefined ? [] : [projectAlias];
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
    aliasProjects,
    recallMaxTokens: Math.max(39, config.searchResultTokens * 2),
    retentionPolicy: retentionPolicyFromDays(config),
    migrationSourcePath: config.dbPath,
    semantic: {
      enabled: config.semanticRetrieval,
      model: config.semanticModel,
      revision: config.semanticModelRevision,
      cachePath: config.semanticModelCachePath,
      indexPath: config.semanticIndexPath,
      candidates: config.semanticCandidates,
      // Undefined unless explicitly overridden: the spawned daemon derives
      // dimensions/pooling from `model` via the catalog (model-catalog.js).
      dimensions: config.semanticModelDimensions,
      pooling: config.semanticModelPooling,
    },
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
    name: "context_window_gather",
    description: GATHER_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 65_536 },
        intent: { type: "string", enum: ["auto", "state", "workflow"], default: "auto" },
        expansionTerms: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
          maxItems: 16,
        },
        scope: {
          type: "string",
          enum: ["session", "project", "all"],
          default: "project",
          description: SEARCH_SCOPE_DESCRIPTION,
        },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "context_window_search",
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 65_536 },
        expansionTerms: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
          maxItems: 16,
        },
        relation: { type: "string", enum: [...STRUCTURAL_RELATIONS] },
        scope: {
          type: "string",
          enum: ["session", "project", "all"],
          default: "project",
          description: SEARCH_SCOPE_DESCRIPTION,
        },
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
    description: "Store text outside the active model context so it can later be found with BM25 search. Pass subjectKey for a durable fact or decision so one live document per subject stays retrievable; on a correction, pass supersedes to retire the prior live document for that same subjectKey in the same write.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: MAX_DOCUMENT_TEXT_BYTES },
        kind: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH, default: "manual" },
        metadata: { type: "object" },
        subjectKey: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
        supersedes: {
          type: "object",
          properties: {
            documentId: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
            version: { type: "integer", minimum: 1 },
          },
          required: ["documentId", "version"],
          additionalProperties: false,
        },
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
  {
    name: "context_window_supersede",
    description: SUPERSEDE_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
        version: { type: "integer", minimum: 1 },
        note: { type: "string", maxLength: 4_096 },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "context_window_promote",
    description: "Recall an archived document and return a concrete promote-to-codebase draft (AGENTS.md/CLAUDE.md diff hunk or ADR file body) with provenance and a suggested target path. Does not pin or edit the repo.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "context_window_redact",
    description: "Tombstone archived documents for the current session or project after an explicit confirm token.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["session", "project"] },
        confirm: { type: "string", minLength: 1, maxLength: MAX_STORE_IDENTIFIER_LENGTH },
      },
      required: ["scope", "confirm"],
      additionalProperties: false,
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function callTool(name, args = {}) {
  switch (name) {
    case "context_window_gather": {
      const query = String(args.query ?? "").trim();
      if (!query) return textResult("context_window_gather requires query.", true);
      const totalBudget = config.searchResultTokens * 4;
      const gather = archive.gatherDetailed(query, {
        intent: args.intent ?? "auto",
        sessionId,
        project,
        scope: args.scope ?? "project",
        limit: args.limit ?? config.searchResults,
        expansionTerms: args.expansionTerms,
        maxEvidence: 12,
        maxTokens: Math.max(39, totalBudget - 640),
      });
      return textResult(formatGatherResults(gather, totalBudget), gather.status === "not-found");
    }
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
        expansionTerms: args.expansionTerms,
        // The render step below already commits to config.searchResultTokens
        // as the total output budget; hand that same headroom to render-time
        // excerpt widening instead of leaving it unused behind a small fixed
        // snippet size. formatSearchResults' own cap still bounds the total.
        hintBudgetTokens: config.searchResultTokens,
      });
      return textResult(formatSearchResults(search.results, config.searchResultTokens, {
        ...search,
        query: typeof args.query === "string" ? args.query : "",
      }));
    }
    case "context_recall": {
      const document = archive.get(String(args.id ?? ""));
      return textResult(
        formatRecalledDocument(document, config.searchResultTokens * 2, args.id),
        !document,
      );
    }
    case "context_window_archive": {
      if ((args.subjectKey !== undefined || args.supersedes !== undefined)
        && typeof archive.resolveSubject !== "function") {
        return textResult("subjectKey and supersedes require the RocksDB archive backend.", true);
      }
      const id = archive.put({
        sessionId,
        project,
        kind: String(args.kind ?? "manual"),
        text: String(args.text ?? ""),
        metadata: args.metadata ?? {},
        ...(args.subjectKey === undefined ? {} : { subjectKey: String(args.subjectKey) }),
        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
      });
      return id ? textResult(`Archived as ${id}.`) : textResult("Nothing to archive.", true);
    }
    case "context_window_status":
      return textResult([
        `Archive: ${config.archiveBackend === "rocksdb" ? config.rocksdbPath : config.dbPath}`,
        `Project documents: ${archive.count({ project, scope: "project" })}`,
        formatArchiveStorage(archive.stats()),
      ].join("\n"));
    case "context_window_supersede": {
      if (typeof archive.supersede !== "function") {
        return textResult("Archive supersession is unavailable for this backend.", true);
      }
      const result = archive.supersede({
        documentId: String(args.documentId ?? ""),
        version: args.version,
        sessionId,
        note: args.note,
      });
      return textResult(formatSupersedeResult(result));
    }
    case "context_window_promote": {
      const document = archive.get(String(args.id ?? ""));
      if (!document) return textResult("No archived document found to promote.", true);
      return textResult(formatPromotePacket({
        documentId: document.documentId ?? document.id ?? args.id,
        kind: document.kind,
        createdAt: document.createdAt,
        // recalledText carries the raw decision text; text may be a rendered,
        // JSON-framed evidence envelope on backends with a model-visible trust
        // boundary (see recalledDocument in src/archive/daemon-archive.js).
        text: document.recalledText ?? document.text,
        subjectKey: document.subjectKey,
        sessionId: document.sessionId,
      }, config.searchResultTokens * 2));
    }
    case "context_window_redact": {
      if (typeof archive.redact !== "function") {
        return textResult("Archive redaction is unavailable for this backend.", true);
      }
      const result = archive.redact({
        scope: String(args.scope ?? ""),
        sessionId,
        confirm: String(args.confirm ?? ""),
      });
      return textResult(formatRedactResult(result));
    }
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
