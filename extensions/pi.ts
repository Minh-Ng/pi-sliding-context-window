import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import {
  EVIDENCE_ROUTING_GUIDELINES,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../src/evidence-routing.js";
import { EpochWindowSession, ROTATION_STATE_ENTRY } from "../src/epoch-window.js";
import {
  formatRecalledDocument,
  formatSearchResults,
  formatStatusDetails,
  formatStatusLine,
} from "../src/presentation.js";
import { archiveDocumentProvenance } from "../src/provenance.js";
import { ancestorSessionIds, stableSessionId } from "../src/session-id.js";
import { Type } from "typebox";

/**
 * Build the Pi adapter with replaceable configuration and archive providers.
 * The default export below is the normal packaged extension.
 */
export function createContextEpochWindow({
  configLoader = loadConfig,
  archiveFactory,
}: {
  configLoader?: typeof loadConfig;
  archiveFactory?: (path: string) => any;
} = {}) {
  return async function contextEpochWindow(pi: ExtensionAPI) {
    let createArchive = archiveFactory;
    if (!createArchive) {
      const { Archive } = await import("../src/archive.js");
      createArchive = (path: string) => new Archive(path);
    }
    let session: EpochWindowSession | undefined;

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

    pi.on("session_start", (event, ctx) => {
      session?.close();
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
      session = new EpochWindowSession({
        archive: createArchive(config.dbPath),
        config,
        sessionId: stableSessionId(ctx.sessionManager, ctx.cwd),
        initialSessionIds,
        project: ctx.cwd,
        model: ctx.model,
        onRotation: (state) => pi.appendEntry(ROTATION_STATE_ENTRY, state),
      });
      session.restore(ctx.sessionManager.getBranch());
      updateStatus(ctx);
    });

    pi.on("context", (event, ctx) => {
      if (!session) return;
      const messages = session.process(event.messages, ctx.model);
      updateStatus(ctx);
      return { messages };
    });

    // The provider-context event may run without an active TUI context. Refresh
    // after each complete run so the footer reflects the latest measurement.
    pi.on("agent_settled", (_event, ctx) => updateStatus(ctx));

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
      // Pi's measurement includes the system prompt, tool schemas, provider
      // framing, and any content our chars/4 estimate cannot see. Prefer the
      // larger provider-aware signal so an optimistic epoch estimate can never
      // suppress the compaction needed to avoid a real context overflow.
      const contextUsage = ctx.getContextUsage?.();
      const observedTokens = [event.preparation.tokensBefore, contextUsage?.tokens]
        .filter((tokens): tokens is number => typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0)
        .reduce((maximum, tokens) => Math.max(maximum, Number(tokens)), Number.NEGATIVE_INFINITY);
      if (session?.shouldCancelCompaction(event.reason, observedTokens)) return { cancel: true };
    });

    // Native compaction replaces Pi's provider path with a summary and kept
    // suffix. Persist a post-compaction reset so reload cannot resurrect an old
    // epoch boundary or TOC from custom entries earlier in the branch.
    pi.on("session_compact", (_event, ctx) => {
      if (!session) return;
      pi.appendEntry(ROTATION_STATE_ENTRY, session.resetAfterCompaction());
      updateStatus(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus("context-window", undefined);
      session?.close();
      session = undefined;
    });

    pi.registerTool({
      name: "context_window_search",
      label: "context_window_search",
      description: SEARCH_TOOL_DESCRIPTION,
      promptGuidelines: [...EVIDENCE_ROUTING_GUIDELINES],
      parameters: Type.Object({
        query: Type.String({ description: "Specific terms, file names, errors, or decisions to find" }),
        scope: Type.Optional(Type.Union([
          Type.Literal("session"),
          Type.Literal("project"),
          Type.Literal("all"),
        ], { default: "session" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        const active = requireSession();
        const results = active.search(params.query, {
          scope: params.scope ?? "session",
          limit: params.limit ?? active.config.searchResults,
        });
        return {
          content: [{ type: "text", text: formatSearchResults(results, active.config.searchResultTokens) }],
          details: { ids: results.map((result: { id: string }) => result.id), count: results.length },
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
      description: "Context epoch status and controls: /window [status|rotate|search <query>]",
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
        ctx.ui.notify(formatStatusDetails(active.status()), "info");
      },
    });
  };
}

export default createContextEpochWindow();
