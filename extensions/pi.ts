import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { retentionPolicyFromDays } from "../src/daemon/retention-policy.js";
import {
  EVIDENCE_ROUTING_GUIDELINES,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import {
  EpochWindowSession,
  ROTATION_STATE_ENTRY,
} from "../src/epoch-window.js";
import {
  formatArchiveStorage,
  formatRecalledDocument,
  formatSearchResults,
  formatStatusDetails,
  formatStatusLine,
} from "../src/presentation.js";
import { archiveDocumentProvenance } from "../src/provenance.js";
import { ancestorSessionIds, stableSessionId } from "../src/session-id.js";
import { STRUCTURAL_RELATIONS } from "../src/structural.js";
import { Type } from "typebox";

const CONTEXT_PREPARATION_FAILURE_NOTICE =
  "Context preparation failed. The turn was aborted before provider submission.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCompactionPreparation(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || typeof value.firstKeptEntryId !== "string"
    || value.firstKeptEntryId.length === 0
    || !Array.isArray(value.messagesToSummarize)
    || !Array.isArray(value.turnPrefixMessages)
    || typeof value.isSplitTurn !== "boolean"
    || !isNonNegativeSafeInteger(value.tokensBefore)
    || (value.previousSummary !== undefined && typeof value.previousSummary !== "string")
    || !isRecord(value.fileOps)
    || !(value.fileOps.read instanceof Set)
    || !(value.fileOps.written instanceof Set)
    || !(value.fileOps.edited instanceof Set)
    || !isRecord(value.settings)
    || typeof value.settings.enabled !== "boolean"
    || !isNonNegativeSafeInteger(value.settings.reserveTokens)
    || !isNonNegativeSafeInteger(value.settings.keepRecentTokens)) {
    return false;
  }
  return true;
}

function isCompactionEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.type === "session_before_compact"
    && (value.reason === "threshold" || value.reason === "overflow" || value.reason === "manual")
    && typeof value.willRetry === "boolean"
    && isRecord(value.signal)
    && typeof value.signal.aborted === "boolean"
    && Array.isArray(value.branchEntries)
    && (value.customInstructions === undefined || typeof value.customInstructions === "string")
    && isCompactionPreparation(value.preparation);
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

type ArchiveCompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: {
    contextWindowArchive: {
      version: 1;
      entries: unknown[];
    };
  };
};

function isArchiveCompactionResult(value: unknown): value is ArchiveCompactionResult {
  if (!isRecord(value)
    || !exactKeys(value, ["summary", "firstKeptEntryId", "tokensBefore", "details"])
    || typeof value.summary !== "string"
    || typeof value.firstKeptEntryId !== "string"
    || value.firstKeptEntryId.length === 0
    || !isNonNegativeSafeInteger(value.tokensBefore)
    || !isRecord(value.details)
    || !exactKeys(value.details, ["contextWindowArchive"])) {
    return false;
  }
  const namespace = value.details.contextWindowArchive;
  if (!isRecord(namespace)
    || !exactKeys(namespace, ["version", "entries"])
    || namespace.version !== 1
    || !Array.isArray(namespace.entries)
    || namespace.entries.length === 0) {
    return false;
  }
  return true;
}

/**
 * Build the Pi adapter with replaceable configuration and archive providers.
 * The default export below is the normal packaged extension.
 */
export function createContextEpochWindow({
  configLoader = loadConfig,
  archiveFactory,
}: {
  configLoader?: typeof loadConfig;
  archiveFactory?: (path: string, options?: any) => any;
} = {}) {
  return async function contextEpochWindow(pi: ExtensionAPI) {
    let SQLiteArchive: any;
    let RocksArchive: any;
    let claimSqliteAuthority: any;
    if (!archiveFactory) {
      [
        { Archive: SQLiteArchive },
        { DaemonArchive: RocksArchive },
        { claimSqliteBackendAuthority: claimSqliteAuthority },
      ] = await Promise.all([
        import("../src/archive.js"),
        import("../src/daemon-archive.js"),
        import("../src/backend-authority.js"),
      ]);
    }
    let session: EpochWindowSession | undefined;
    let protectionRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let startupState: "not-started" | "starting" | "ready" | "failed" | "stopped" = "not-started";

    function stopProtectionRefresh() {
      const timer = protectionRefreshTimer;
      if (timer) clearInterval(timer);
      if (protectionRefreshTimer === timer) protectionRefreshTimer = undefined;
    }

    function restartProtectionRefresh() {
      stopProtectionRefresh();
      protectionRefreshTimer = setInterval(() => {
        try { session?.refreshArchiveProtection(); } catch { /* the next lifecycle event retries */ }
      }, 60 * 60 * 1_000);
      protectionRefreshTimer.unref?.();
    }

    function updateStatus(ctx: ExtensionContext) {
      if (!ctx?.hasUI || !session) return;
      const theme = ctx.ui.theme;
      const paint = (color: "accent" | "dim" | "warning") =>
        (text: string) => theme?.fg?.(color, text) ?? text;
      ctx.ui.setStatus("context-window", formatStatusLine(
        session.status({ includeArchiveCount: false }),
        {
          accent: session.config.statusLabelAccent ? paint("accent") : undefined,
          muted: paint("dim"),
          warning: paint("warning"),
        },
      ));
    }

    function requireSession() {
      if (!session) throw new Error("Context window session has not started.");
      return session;
    }

    function failClosedContext(ctx: ExtensionContext) {
      try { ctx.abort(); } catch { /* abort is best-effort after preparation failure */ }
      try { ctx.ui.notify(CONTEXT_PREPARATION_FAILURE_NOTICE, "error"); } catch {}
      try { updateStatus(ctx); } catch {}
      return { messages: [] };
    }

    pi.on("session_start", (event, ctx) => {
      const previousSession = session;
      session = undefined;
      startupState = "starting";
      try {
        stopProtectionRefresh();
      } catch (error) {
        startupState = "failed";
        try { previousSession?.close(); } catch { /* preserve the timer cleanup failure */ }
        throw error;
      }
      let archive: any;
      let nextSession: EpochWindowSession | undefined;
      try {
        const config = configLoader({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted?.() === true });
        let sessionFile: string | undefined;
        try { sessionFile = ctx.sessionManager.getSessionFile?.(); } catch { /* lineage is best-effort */ }
        const forkParentFile = event.reason === "fork" ? event.previousSessionFile : undefined;
        const lineageFile = forkParentFile && sessionFile === forkParentFile ? undefined : sessionFile;
        const initialSessionIds = ancestorSessionIds(lineageFile, {
          // A fork event can arrive before its new JSONL header is readable, or
          // while the manager still reports the previously active file.
          fallbackParentFile: forkParentFile,
          expectedCwd: ctx.cwd,
        });
        const retention = {
          maxBytes: config.maxArchiveBytes,
          targetBytes: config.targetArchiveBytes,
          recentProtectionMs: config.recentDocumentProtectionDays * 24 * 60 * 60 * 1_000,
          minimumTurnsPerSession: config.minimumTurnsPerSession,
        };
        archive = archiveFactory
          // Preserve the custom factory contract exactly for embedders and tests.
          ? archiveFactory(config.dbPath, { retention })
          : config.archiveBackend === "sqlite"
            ? (() => {
                // A custom config loader may intentionally implement the legacy
                // SQLite-only contract and omit every RocksDB path.
                if ((config as any).rocksdbPath) {
                  claimSqliteAuthority({
                    storePath: (config as any).rocksdbPath,
                    socketPath: (config as any).socketPath,
                    sourcePath: config.dbPath,
                    project: ctx.cwd,
                  });
                }
                return new SQLiteArchive(config.dbPath, { retention });
              })()
            : new RocksArchive({
                storePath: config.rocksdbPath,
                socketPath: (config as any).socketPath,
                project: ctx.cwd,
                recallMaxTokens: Math.max(39, config.searchResultTokens * 2),
                retentionPolicy: retentionPolicyFromDays(config),
                migrationSourcePath: config.dbPath,
              });
        nextSession = new EpochWindowSession({
          archive,
          config,
          sessionId: stableSessionId(ctx.sessionManager, ctx.cwd),
          initialSessionIds,
          project: ctx.cwd,
          model: ctx.model,
          onRotation: (state) => pi.appendEntry(ROTATION_STATE_ENTRY, state),
        });
        nextSession.restore(ctx.sessionManager.getBranch());
      } catch (error) {
        startupState = "failed";
        try { (nextSession ?? archive)?.close?.(); } catch { /* preserve the startup failure */ }
        try { previousSession?.close(); } catch { /* preserve the startup failure */ }
        throw error;
      }
      try {
        previousSession?.close();
        restartProtectionRefresh();
      } catch (error) {
        startupState = "failed";
        stopProtectionRefresh();
        try { nextSession?.close(); } catch { /* preserve the transition failure */ }
        throw error;
      }
      session = nextSession;
      startupState = "ready";
      // Status is presentation-only. A healthy session must not be reported to
      // Pi as a failed startup merely because the UI cannot render its footer.
      try { updateStatus(ctx); } catch {}
    });

    pi.on("context", (event, ctx) => {
      if (!session || startupState !== "ready") {
        if (startupState === "not-started") return;
        return failClosedContext(ctx);
      }
      let messages;
      try {
        messages = session.process(event.messages, ctx.model);
      } catch {
        return failClosedContext(ctx);
      }
      // Status is presentation-only. Once the provider copy is safely bounded,
      // a UI failure must not make Pi discard it and restore the raw input.
      try { updateStatus(ctx); } catch {}
      return { messages };
    });

    // The provider-context event may run without an active TUI context. Refresh
    // after each complete run so the footer reflects the latest measurement.
    pi.on("agent_settled", (_event, ctx) => {
      session?.refreshArchiveProtection();
      updateStatus(ctx);
    });

    pi.on("model_select", (event, ctx) => {
      session?.updateModel(event.model);
      updateStatus(ctx);
    });

    // A tree navigation changes the provider path. Discard the measurement from
    // the abandoned branch until the next context event measures the new one.
    pi.on("session_tree", (_event, ctx) => {
      session?.restore(ctx.sessionManager.getBranch());
      session?.clearMeasurement();
      updateStatus(ctx);
    });

    pi.on("session_before_compact", (event, ctx) => {
      try {
        if (!session || !isCompactionEvent(event)) return { cancel: true };

        // Pi's measurement includes the system prompt, tool schemas, provider
        // framing, and any content our chars/4 estimate cannot see. Prefer the
        // larger provider-aware signal so an optimistic epoch estimate can never
        // suppress the compaction needed to avoid a real context overflow.
        let contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
        try { contextUsage = ctx.getContextUsage?.(); } catch { contextUsage = undefined; }
        const preparationTokens = event.preparation.tokensBefore;
        const providerTokens = contextUsage?.tokens;
        const hasPreparationMeasurement = typeof preparationTokens === "number"
          && Number.isFinite(preparationTokens)
          && preparationTokens >= 0;
        const hasProviderMeasurement = typeof providerTokens === "number"
          && Number.isFinite(providerTokens)
          && providerTokens >= 0;
        const observedTokens = [event.preparation.tokensBefore, contextUsage?.tokens]
          .filter((tokens): tokens is number => typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0)
          .reduce((maximum, tokens) => Math.max(maximum, Number(tokens)), Number.NEGATIVE_INFINITY);

        // A proven-safe threshold is the only path that may skip checkpointing.
        if (hasPreparationMeasurement
          && hasProviderMeasurement
          && session.shouldCancelCompaction(event.reason, observedTokens)) {
          return { cancel: true };
        }

        const result = session.checkpointCompaction(event.preparation, {
          // The checked-JS declaration infers the default `[]` as `never[]`,
          // while Pi correctly supplies SessionEntry[].
          branchEntries: event.branchEntries as any,
        });
        if (!isArchiveCompactionResult(result)) return { cancel: true };
        return { compaction: result };
      } catch {
        // Never fall through to Pi's native summarizer with uncheckpointed raw
        // context, including when a custom archive implementation throws.
        return { cancel: true };
      }
    });

    // Successful compaction replaces Pi's provider path with a summary and kept
    // suffix. Persist a post-compaction reset so reload cannot resurrect an old
    // epoch boundary or TOC from custom entries earlier in the branch.
    pi.on("session_compact", (_event, ctx) => {
      if (!session) return;
      pi.appendEntry(ROTATION_STATE_ENTRY, session.resetAfterCompaction());
      updateStatus(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      startupState = "stopped";
      let cleanupFailure: { error: unknown } | undefined;
      try {
        if (ctx.hasUI) ctx.ui.setStatus("context-window", undefined);
      } catch (error) {
        cleanupFailure = { error };
      }
      try {
        stopProtectionRefresh();
      } catch (error) {
        cleanupFailure ??= { error };
      }
      const closingSession = session;
      session = undefined;
      try { closingSession?.close(); } catch (error) { cleanupFailure ??= { error }; }
      if (cleanupFailure) throw cleanupFailure.error;
    });

    pi.registerTool({
      name: "context_window_search",
      label: "context_window_search",
      description: SEARCH_TOOL_DESCRIPTION,
      promptGuidelines: [...EVIDENCE_ROUTING_GUIDELINES],
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Specific terms, file names, errors, or decisions to find" })),
        relation: Type.Optional(Type.Union(
          STRUCTURAL_RELATIONS.map((relation) => Type.Literal(relation)),
          { description: "Structural archived-message relation for anchorless references" },
        )),
        scope: Type.Optional(Type.Union([
          Type.Literal("session"),
          Type.Literal("project"),
          Type.Literal("all"),
        ], { default: "session" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        const active = requireSession();
        const query = params.query?.trim() ?? "";
        if (!query && !params.relation) {
          throw new Error("context_window_search requires query or relation.");
        }
        const search = active.searchDetailed(query, {
          relation: params.relation,
          scope: params.scope ?? "session",
          limit: params.limit ?? active.config.searchResults,
        });
        return {
          content: [{
            type: "text",
            text: formatSearchResults(search.results, active.config.searchResultTokens, search),
          }],
          details: {
            ids: search.results.map((result: { id: string }) => result.id),
            count: search.results.length,
            mode: search.mode,
            status: search.status,
            relation: search.relation,
            candidates: search.candidates,
          },
        };
      },
    });

    pi.registerTool({
      name: "context_recall",
      label: "context_recall",
      description: RECALL_TOOL_DESCRIPTION,
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const active = requireSession();
        const document = active.recall(params.id);
        const text = formatRecalledDocument(
          document,
          active.config.searchResultTokens * 2,
          params.id,
        );
        return {
          content: [{ type: "text", text }],
          details: {
            found: Boolean(document),
            provenance: document ? (document.provenance ?? archiveDocumentProvenance(document)) : null,
          },
        };
      },
    });

    pi.registerCommand("window", {
      description: "Context epoch controls: /window [status|rotate|search <query>|archive status|archive prune|archive reclaim]",
      handler: async (args, ctx) => {
        const active = requireSession();
        updateStatus(ctx);
        const input = args.trim();
        if (input === "rotate") {
          active.requestRotation();
          updateStatus(ctx);
          ctx.ui.notify("Context window will rotate before the next provider request.", "info");
          return;
        }
        if (input.startsWith("search ")) {
          const results = active.search(input.slice(7));
          ctx.ui.notify(formatSearchResults(results, active.config.searchResultTokens), "info");
          return;
        }
        if (input === "archive status") {
          ctx.ui.notify(formatArchiveStorage(active.archiveStats()), "info");
          return;
        }
        if (input === "archive prune") {
          const result = active.pruneArchive();
          if (!result) {
            ctx.ui.notify("Archive cleanup is unavailable for this backend.", "warning");
            return;
          }
          const level = result.status === "protected-over-limit" ? "warning" : "info";
          ctx.ui.notify(`${result.status}\n${formatArchiveStorage(active.archiveStats())}`, level);
          return;
        }
        if (input === "archive reclaim") {
          const result = active.reclaimArchive();
          if (!result) {
            ctx.ui.notify("Archive reclamation is unavailable for this backend.", "warning");
            return;
          }
          const level = result.status === "error" ? "error" : result.status === "busy" ? "warning" : "info";
          ctx.ui.notify(`${result.status}\n${formatArchiveStorage(result.after)}`, level);
          return;
        }
        ctx.ui.notify(formatStatusDetails(active.status()), "info");
      },
    });
  };
}

export default createContextEpochWindow();
