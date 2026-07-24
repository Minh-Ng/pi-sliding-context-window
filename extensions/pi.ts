import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  Container,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";
import { loadConfig, saveGlobalConfig } from "../src/config.js";
import { readGrantedReadScope } from "../src/daemon/read-scope.js";
import { retentionPolicyFromDays } from "../src/daemon/retention-policy.js";
import {
  EpochWindowSession as StaticEpochWindowSession,
  ROTATION_STATE_ENTRY as STATIC_ROTATION_STATE_ENTRY,
} from "../src/session/epoch-window.js";
import type {
  EpochWindowSession as EpochWindowSessionType,
} from "../src/session/epoch-window.js";
import {
  formatArchiveStorage,
  formatAutomaticRetrievalDiagnostics,
  formatGatherResults,
  formatPromotePacket,
  formatRecalledDocument,
  formatRedactResult,
  formatSearchResults,
  formatStatusDetails,
  formatStatusLine,
  formatSupersedeResult,
  formatTraversalResults,
  formatWindowUsage,
} from "../src/presentation.js";
import { archiveDocumentProvenance } from "../src/identity/provenance.js";
import { canonicalProjectId, projectIdentityAlias } from "../src/identity/project-identity.js";
import { explicitRecallScope, RECALL_SCOPE_VALUES } from "../src/retrieval/recall-scope.js";
import { ancestorSessionIds, stableSessionId } from "../src/session/session-id.js";
import { STRUCTURAL_RELATIONS } from "../src/structural-annotations.js";
import { Type } from "typebox";

const CONTEXT_PREPARATION_FAILURE_NOTICE =
  "Context preparation failed. The turn was aborted before provider submission.";
const TURN_CAP_VALUES = Object.freeze([10, 20, 30, 40, 50, 75, 100]);
const CONTEXT_CAP_VALUES = Object.freeze([64_000, 96_000, 128_000, 160_000, 192_000, 256_000]);
const WINDOW_ARGUMENTS = Object.freeze([
  { value: "status", label: "status", description: "Show context-window status" },
  { value: "usage", label: "usage", description: "Show per-component context token breakdown" },
  { value: "settings", label: "settings", description: "Configure persistent turn and context caps" },
  { value: "rotate", label: "rotate", description: "Queue rotation before the next provider request" },
  { value: "search ", label: "search <query>", description: "Search archived evidence" },
  { value: "recall why", label: "recall why", description: "Explain the last automatic retrieval decision" },
  { value: "promote ", label: "promote <documentId>", description: "Show how to make an archived decision durable" },
  { value: "supersede ", label: "supersede <documentId> [note]", description: "Supersede an archived decision" },
  { value: "daemon status", label: "daemon status", description: "Inspect the shared archive daemon" },
  { value: "daemon restart --force", label: "daemon restart --force", description: "Drain and replace the shared daemon" },
  { value: "archive status", label: "archive status", description: "Show archive storage status" },
  { value: "archive prune", label: "archive prune", description: "Run logical retention" },
  { value: "archive reclaim", label: "archive reclaim", description: "Request physical compaction" },
  { value: "archive redact session", label: "archive redact session", description: "Prepare session redaction confirmation" },
  { value: "archive redact project", label: "archive redact project", description: "Prepare project redaction confirmation" },
]);
const WINDOW_COMMAND_USAGE = WINDOW_ARGUMENTS.map(({ label }) => label).join("|");

function windowArgumentCompletions(
  prefix: string,
  active?: EpochWindowSessionType,
): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = WINDOW_ARGUMENTS.map(({ value, label, description }) => ({
    value,
    label,
    description,
  }));
  if (active) {
    const sessionToken = String(active.sessionId).slice(-8);
    const projectToken = String(active.project).replace(/[/\\]+$/u, "").split(/[/\\]/u).pop()
      || String(active.project);
    items.push(
      {
        value: `archive redact session confirm ${sessionToken}`,
        label: `archive redact session confirm ${sessionToken}`,
        description: "Confirm redaction for this session",
      },
      {
        value: `archive redact project confirm ${projectToken}`,
        label: `archive redact project confirm ${projectToken}`,
        description: "Confirm redaction for this project",
      },
    );
  }
  const filtered = items.filter(({ value }) => value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

function formatTokenCap(tokens: number) {
  return tokens % 1_000 === 0 ? `${tokens / 1_000}k` : String(tokens);
}

function formatDaemonLifecycle(status: any) {
  if (!status) return "The shared daemon is unavailable for this archive backend.";
  const runtime = status.runtimeMatches === false
    ? `${status.runtimeVersion} (loaded client expects ${status.expectedRuntimeVersion})`
    : status.runtimeVersion;
  const idle = status.idleShutdownAt === undefined
    ? "not scheduled while clients or work remain"
    : new Date(status.idleShutdownAt).toISOString();
  return [
    `context-windowd pid ${status.processId}`,
    `runtime: ${runtime}`,
    `clients: ${status.clientConnections ?? "unknown"}; active requests: ${status.activeRequests ?? "unknown"}`,
    `idle shutdown: ${idle}`,
  ].join("\n");
}

/** Documented daemon default for CONTEXT_WINDOW_CRITICAL_FREE_BYTES. */
export const DISK_PRESSURE_EMERGENCY_FLOOR_BYTES = 2 * 1024 ** 3;
/** Warn early, before admissions start failing. */
export const DISK_PRESSURE_WARN_BYTES = 2 * DISK_PRESSURE_EMERGENCY_FLOOR_BYTES;
export const DISK_PRESSURE_CHECK_INTERVAL_MS = 5 * 60_000;

export interface DiskPressure {
  severity: "emergency" | "approaching";
  message: string;
}

/**
 * Interpret archive storage stats for host disk pressure. Emergency mode is
 * authoritative (the daemon is already rejecting admissions with DISK_LOW,
 * so rotated turns are silently not archived); the free-space check warns
 * before that point using the documented default floor.
 */
export function evaluateDiskPressure(stats: any): DiskPressure | undefined {
  if (!stats || typeof stats !== "object") return undefined;
  if (stats.emergencyMode === true || stats.filesystem?.emergencyMode === true) {
    return {
      severity: "emergency",
      message: "Archive emergency mode: new archival admissions are rejected (DISK_LOW), so rotated turns are NOT being archived. Free disk space, then run /window archive reclaim.",
    };
  }
  const freeBytes = stats.filesystem?.freeBytes;
  if (Number.isSafeInteger(freeBytes) && freeBytes < DISK_PRESSURE_WARN_BYTES) {
    const free = (freeBytes / 1024 ** 3).toFixed(1);
    return {
      severity: "approaching",
      message: `Archive host has ${free} GiB free, approaching the 2 GiB emergency floor where archival admissions stop. Free disk space or run /window archive reclaim.`,
    };
  }
  return undefined;
}

export interface DiskPressureUi {
  notify: (message: string, level: "warning" | "info" | "error") => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/**
 * Throttled, notify-once disk-pressure monitor. Kept independent of the
 * extension closure so the notification and remediation flow is unit-testable.
 */
export function createDiskPressureMonitor(hooks: {
  archiveStats: () => any;
  reclaim?: () => any;
  formatStorage?: (stats: any) => string;
  now?: () => number;
  checkIntervalMs?: number;
}) {
  const now = hooks.now ?? Date.now;
  const interval = hooks.checkIntervalMs ?? DISK_PRESSURE_CHECK_INTERVAL_MS;
  let notified = false;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  return {
    reset() {
      notified = false;
      lastCheckedAt = Number.NEGATIVE_INFINITY;
    },
    async check(ui: DiskPressureUi): Promise<DiskPressure | undefined> {
      if (notified) return undefined;
      const at = now();
      if (at - lastCheckedAt < interval) return undefined;
      lastCheckedAt = at;
      let stats;
      try {
        stats = hooks.archiveStats();
      } catch {
        return undefined; // status is presentation-only; never disrupt the turn
      }
      const pressure = evaluateDiskPressure(stats);
      if (!pressure) return undefined;
      notified = true;
      ui.notify(pressure.message, "warning");
      if (ui.confirm && hooks.reclaim) {
        try {
          const run = await ui.confirm(
            "Archive disk pressure",
            pressure.severity === "emergency"
              ? "The archive daemon is rejecting new admissions. Run physical reclamation now (equivalent to /window archive reclaim)?"
              : "Free space is low for the archive host. Run physical reclamation now (equivalent to /window archive reclaim)?",
          );
          if (run) {
            const result = hooks.reclaim();
            if (!result) {
              ui.notify("Archive reclamation is unavailable for this backend.", "warning");
            } else {
              const level = result.status === "error" ? "error" : result.status === "busy" ? "warning" : "info";
              const suffix = hooks.formatStorage && result.after ? `\n${hooks.formatStorage(result.after)}` : "";
              ui.notify(`${result.status}${suffix}`, level);
            }
          }
        } catch {
          // Dialog-incapable mode; the warning notification already fired.
        }
      }
      return pressure;
    },
  };
}

function parseTokenCap(value: string) {
  if (value === "adaptive") return undefined;
  const match = /^(?<amount>\d+)(?<suffix>k)?$/u.exec(value);
  if (!match?.groups?.amount) return undefined;
  const amount = Number(match.groups.amount);
  const tokens = match.groups.suffix ? amount * 1_000 : amount;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function turnCapOptions(current: number, minimum: number) {
  return [...new Set([...TURN_CAP_VALUES, current, minimum].filter((value) => value >= minimum))]
    .sort((left, right) => left - right)
    .map(String);
}

function contextCapValue(config: Record<string, any>) {
  return config.rotationTokensExplicit === false
    ? "adaptive"
    : formatTokenCap(Number(config.rotationTokens));
}

function contextCapOptions(config: Record<string, any>) {
  const configured = contextCapValue(config);
  const fixed = [...new Set([
    ...CONTEXT_CAP_VALUES.map(formatTokenCap),
    ...(configured === "adaptive" ? [] : [configured]),
  ])].sort((left, right) => Number(parseTokenCap(left)) - Number(parseTokenCap(right)));
  return ["adaptive", ...fixed];
}

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

type ContextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

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

async function loadFreshEpochWindow(): Promise<typeof import("../src/session/epoch-window.js")> {
  const epochWindowUrl = new URL("../src/session/epoch-window.js", import.meta.url);
  epochWindowUrl.searchParams.set("pi-reload", `${Date.now()}-${Math.random()}`);
  return await import(epochWindowUrl.href) as typeof import("../src/session/epoch-window.js");
}

function startupContextMessages(sessionManager: ExtensionContext["sessionManager"]): any[] {
  const entries = typeof sessionManager.buildContextEntries === "function"
    ? sessionManager.buildContextEntries()
    : sessionManager.getBranch();
  return entries.flatMap((entry: any) => sessionEntryToContextMessages(entry));
}

function archiveCompletedSession(
  active: EpochWindowSessionType | undefined,
  sessionManager: ExtensionContext["sessionManager"],
) {
  const archiveCompletedTurns = (active as any)?.archiveCompletedTurns;
  if (typeof archiveCompletedTurns !== "function") return;
  archiveCompletedTurns.call(active, startupContextMessages(sessionManager));
}

/**
 * Build the Pi adapter with replaceable configuration and archive providers.
 * The default export below is the normal packaged extension.
 */
export function createContextEpochWindow({
  configLoader = loadConfig,
  configSaver = saveGlobalConfig,
  archiveFactory,
  epochWindowLoader,
}: {
  configLoader?: typeof loadConfig;
  configSaver?: typeof saveGlobalConfig | null;
  archiveFactory?: (path: string, options?: any) => any;
  epochWindowLoader?: () => Promise<typeof import("../src/session/epoch-window.js")>;
} = {}) {
  const persistConfig = typeof configSaver === "function" ? configSaver : saveGlobalConfig;
  return async function contextEpochWindow(pi: ExtensionAPI) {
    // The packaged default supplies a cache-busted epoch loader because Jiti
    // can retain native ESM dependencies across `/reload`. Injected/test
    // adapters use the stable constructor unless they request another loader.
    const epochWindowModule: typeof import("../src/session/epoch-window.js") = epochWindowLoader
      ? await epochWindowLoader()
      : {
          EpochWindowSession: StaticEpochWindowSession,
          ROTATION_STATE_ENTRY: STATIC_ROTATION_STATE_ENTRY,
        } as typeof import("../src/session/epoch-window.js");
    const { EpochWindowSession, ROTATION_STATE_ENTRY } = epochWindowModule;
    const routingUrl = new URL("../src/evidence-routing.js", import.meta.url);
    routingUrl.searchParams.set("pi-reload", `${Date.now()}-${Math.random()}`);
    const {
      ARCHIVE_GATHER_TURN_GUIDANCE,
      EVIDENCE_ROUTING_GUIDELINES,
      GATHER_TOOL_DESCRIPTION,
      RECALL_TOOL_DESCRIPTION,
      SEARCH_EFFORT_DESCRIPTION,
      SEARCH_SCOPE_DESCRIPTION,
      SEARCH_TOOL_DESCRIPTION,
      SUPERSEDE_TOOL_DESCRIPTION,
      TRAVERSE_TOOL_DESCRIPTION,
      archiveGatherSuggested,
    } = await import(routingUrl.href);
    let SQLiteArchive: any;
    let RocksArchive: any;
    let claimSqliteAuthority: any;
    if (!archiveFactory) {
      [
        { Archive: SQLiteArchive },
        { DaemonArchive: RocksArchive },
        { claimSqliteBackendAuthority: claimSqliteAuthority },
      ] = await Promise.all([
        import("../src/archive/archive.js"),
        import("../src/archive/daemon-archive.js"),
        import("../src/archive/backend-authority.js"),
      ]);
    }
    let session: EpochWindowSessionType | undefined;
    let recallHandles = new Map<string, string>();
    let recallHandleTargets = new Map<string, string>();
    let recallHandleByTarget = new Map<string, string>();
    let recallHandleByDocumentId = new Map<string, string>();
    let nextRecallHandle = 1;
    let pendingTraversal: {
      nextId: string;
      direction: "before" | "after";
      visibleIds: Set<string>;
    } | undefined;
    let protectionRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let startupState: "not-started" | "starting" | "ready" | "failed" | "stopped" = "not-started";

    function emitTiming(details: Record<string, unknown>) {
      try { pi.events?.emit?.("context-window:timing", details); } catch { /* diagnostics only */ }
    }

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

    const diskPressureMonitor = createDiskPressureMonitor({
      archiveStats: () => session?.archiveStats(),
      reclaim: () => session?.reclaimArchive(),
      formatStorage: formatArchiveStorage,
    });

    function maybeWarnDiskPressure(ctx: ExtensionContext) {
      if (!ctx?.hasUI || !session || startupState !== "ready") return;
      void diskPressureMonitor.check({
        notify: (message, level) => {
          try { ctx.ui.notify(message, level); } catch { /* presentation-only */ }
        },
        confirm: (title, message) => ctx.ui.confirm(title, message),
      });
    }

    function exposeRecallHandles(results: any[]) {
      return results.map((result) => {
        const target = typeof result.documentId === "string"
          ? `${result.project ?? ""}\0${result.sessionId ?? ""}\0${result.documentId}\0${result.version ?? 1}`
          : String(result.id);
        let handle = recallHandleByTarget.get(target);
        if (handle === undefined) {
          handle = `r${nextRecallHandle}`;
          nextRecallHandle += 1;
          recallHandleByTarget.set(target, handle);
          recallHandleTargets.set(handle, target);
        }
        // Refresh the internal signed locator when repeated searches return a
        // newer lease for the same exact document version. The model keeps one
        // stable short handle instead of seeing duplicate opaque identities.
        recallHandles.set(handle, result.id);
        if (typeof result.documentId === "string") {
          recallHandleByDocumentId.set(result.documentId, handle);
        }
        while (recallHandles.size > 1_000) {
          const oldest = recallHandles.keys().next().value;
          if (oldest === undefined) break;
          recallHandles.delete(oldest);
          const oldestTarget = recallHandleTargets.get(oldest);
          recallHandleTargets.delete(oldest);
          if (oldestTarget !== undefined) recallHandleByTarget.delete(oldestTarget);
          for (const [documentId, candidate] of recallHandleByDocumentId) {
            if (candidate === oldest) recallHandleByDocumentId.delete(documentId);
          }
        }
        return { ...result, id: handle };
      });
    }

    function resolveRecallHandle(id: string) {
      const handle = recallHandleByDocumentId.get(id);
      return recallHandles.get(handle ?? id) ?? id;
    }

    function exposeGatherHandles(gather: any) {
      return {
        ...gather,
        evidence: gather.evidence.map((item: any) => {
          const [exposed] = exposeRecallHandles([{
            id: item.id ?? item.locator,
            documentId: item.document?.documentId,
            version: item.document?.version,
            sessionId: item.document?.sessionId,
            project: item.document?.project,
            kind: item.document?.kind,
          }]);
          return {
            ...item,
            id: exposed.id,
            locator: exposed.id,
            document: {
              ...item.document,
              recallId: exposed.id,
              locator: exposed.id,
            },
          };
        }),
      };
    }

    function pendingTraversalResult(): ContextToolResult {
      if (!pendingTraversal) throw new Error("No chronological traversal is pending.");
      const instruction = `Chronological traversal is unresolved. Call context_window_traverse with id=${JSON.stringify(pendingTraversal.nextId)} and direction=${JSON.stringify(pendingTraversal.direction)}, or recall one of the visible traversal ids.`;
      return {
        content: [{ type: "text" as const, text: instruction }],
        details: {
          blocked: true,
          continuationId: pendingTraversal.nextId,
          direction: pendingTraversal.direction,
        },
      };
    }

    function failClosedContext(ctx: ExtensionContext) {
      try { ctx.abort(); } catch { /* abort is best-effort after preparation failure */ }
      try { ctx.ui.notify(CONTEXT_PREPARATION_FAILURE_NOTICE, "error"); } catch {}
      try { updateStatus(ctx); } catch {}
      return { messages: [] };
    }

    async function openSettings(ctx: ExtensionContext) {
      const active = requireSession();
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify("/window settings requires TUI mode.", "error");
        return;
      }
      // The granted read ceiling is displayed from the user-global settings
      // file only — the same file the daemon reads — never from merged
      // project-local configuration, so the panel always shows the honored
      // value and cannot be widened by repository content.
      let readScopeValue = await readGrantedReadScope();
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const status = active.status();
        const minimumTurns = Number(active.config.retainTurns) + 1;
        const items: SettingItem[] = [
          {
            id: "turn-cap",
            label: "Turn cap",
            currentValue: String(status.rotationTurns),
            values: turnCapOptions(status.rotationTurns, minimumTurns),
            description: `Rotate at this many user interaction groups. Must exceed retained turns (${active.config.retainTurns}).`,
          },
          {
            id: "context-cap",
            label: "Context cap",
            currentValue: contextCapValue(active.config),
            values: contextCapOptions(active.config),
            description: `Rotate at this estimated message-token cap. Adaptive uses ${Math.round(active.config.rotationContextRatio * 100)}% of the selected model's input budget after Pi's compaction reserve; current effective cap is ${formatTokenCap(status.rotationTokens)}.`,
          },
          {
            id: "recall-scope",
            label: "Recall scope",
            currentValue: active.config.recallScope ?? "auto",
            values: [...RECALL_SCOPE_VALUES],
            description: "Default archive boundary. auto keeps ordinary recall session-local and follows project-scoped continuity markers; explicit tool scope still overrides.",
          },
          {
            id: "read-scope",
            label: "Read scope ceiling",
            currentValue: readScopeValue,
            values: ["project", "all"],
            description: "Granted ceiling for archive search scope=all. project keeps every connection inside its own project; all lets scope=all read every project on this machine. Saved to user-global settings only; applies to new daemon connections.",
          },
        ];
        let settingsList: SettingsList;
        settingsList = new SettingsList(
          items,
          items.length + 2,
          getSettingsListTheme(),
          (id, newValue) => {
            if (id === "recall-scope") {
              const previous = active.config.recallScope ?? "auto";
              if (!RECALL_SCOPE_VALUES.includes(newValue)) {
                settingsList.updateValue(id, previous);
                ctx.ui.notify("Recall scope must be auto, session, project, or all.", "error");
                return;
              }
              try {
                // Auto is the product default, so avoid pinning a redundant key.
                persistConfig({ recallScope: newValue === "auto" ? undefined : newValue });
                const refreshed = configLoader({
                  cwd: ctx.cwd,
                  projectTrusted: ctx.isProjectTrusted?.() === true,
                });
                active.updateWindowPolicy(refreshed, ctx.model);
                settingsList.updateValue(id, active.config.recallScope ?? "auto");
                ctx.ui.notify(
                  `Context window recall scope: ${active.config.recallScope ?? "auto"} · saved globally · survives reload`,
                  "info",
                );
              } catch (error) {
                settingsList.updateValue(id, previous);
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              }
              return;
            }
            if (id === "read-scope") {
              const previous = readScopeValue;
              if (newValue !== "project" && newValue !== "all") {
                settingsList.updateValue(id, previous);
                ctx.ui.notify("Read scope ceiling must be project or all.", "error");
                return;
              }
              try {
                // "project" is the implicit default: persisting it removes the
                // key instead of pinning a redundant grant.
                persistConfig({ maxReadScope: newValue === "all" ? "all" : undefined });
                readScopeValue = newValue;
                settingsList.updateValue(id, newValue);
                ctx.ui.notify(
                  `Context window read scope ceiling: ${newValue} · saved globally · applies to new daemon connections`,
                  "info",
                );
              } catch (error) {
                settingsList.updateValue(id, previous);
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              }
              return;
            }
            const previousValue = id === "turn-cap"
              ? String(active.status().rotationTurns)
              : contextCapValue(active.config);
            let updates: Record<string, number | undefined>;
            if (id === "turn-cap") {
              const turns = Number(newValue);
              if (!Number.isSafeInteger(turns) || turns < minimumTurns) {
                settingsList.updateValue(id, previousValue);
                ctx.ui.notify(`Turn cap must be an integer of at least ${minimumTurns}.`, "error");
                return;
              }
              updates = { rotationTurns: turns };
            } else {
              const tokens = parseTokenCap(newValue);
              if (newValue !== "adaptive" && tokens === undefined) {
                settingsList.updateValue(id, previousValue);
                ctx.ui.notify("Context cap must be adaptive or a positive token count.", "error");
                return;
              }
              updates = { rotationTokens: tokens };
            }
            try {
              persistConfig(updates);
              const refreshed = configLoader({
                cwd: ctx.cwd,
                projectTrusted: ctx.isProjectTrusted?.() === true,
              });
              active.updateWindowPolicy(refreshed, ctx.model);
              const effective = active.status();
              const effectiveValue = id === "turn-cap"
                ? String(effective.rotationTurns)
                : contextCapValue(active.config);
              settingsList.updateValue(id, effectiveValue);
              updateStatus(ctx);
              ctx.ui.notify(
                `Context window ${id}: ${effectiveValue} · effective ${effective.rotationTurns} turns / ${formatTokenCap(effective.rotationTokens)} tokens · saved globally`,
                "info",
              );
            } catch (error) {
              settingsList.updateValue(id, previousValue);
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
          },
          () => done(undefined),
        );
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
        container.addChild(new (class {
          render() {
            return [
              theme.fg("accent", theme.bold("Context Window Settings")),
              theme.fg("dim", "Global caps · persistent · project/environment overrides still win"),
              "",
            ];
          }
          invalidate() {}
        })());
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    }

    pi.on("session_start", (event, ctx) => {
      const startupStartedAt = performance.now();
      let archiveSetupMs = 0;
      let warmupMs = 0;
      let warmupMessageCount = 0;
      let warmupArtifactCount = 0;
      let warmupAvailable = true;
      const previousSession = session;
      session = undefined;
      recallHandles = new Map();
      recallHandleTargets = new Map();
      recallHandleByTarget = new Map();
      recallHandleByDocumentId = new Map();
      nextRecallHandle = 1;
      pendingTraversal = undefined;
      startupState = "starting";
      try {
        stopProtectionRefresh();
      } catch (error) {
        startupState = "failed";
        try { previousSession?.close(); } catch { /* preserve the timer cleanup failure */ }
        throw error;
      }
      let archive: any;
      let nextSession: EpochWindowSessionType | undefined;
      try {
        const config = configLoader({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted?.() === true });
        // Canonicalize project identity so one repository opened through a
        // symlink or alternate path spelling maps to a single archive namespace.
        // The literal spelling rides along as a read-only alias so archives
        // written under the pre-canonical key stay reachable.
        const project = canonicalProjectId(ctx.cwd);
        const projectAlias = projectIdentityAlias(ctx.cwd);
        const aliasProjects = projectAlias === undefined ? [] : [projectAlias];
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
                    project,
                  });
                }
                return new SQLiteArchive(config.dbPath, { retention });
              })()
            : new RocksArchive({
                storePath: config.rocksdbPath,
                socketPath: (config as any).socketPath,
                project,
                aliasProjects,
                recallMaxTokens: Math.max(39, config.searchResultTokens * 2),
                retentionPolicy: retentionPolicyFromDays(config),
                migrationSourcePath: config.dbPath,
                semantic: {
                  enabled: (config as any).semanticRetrieval,
                  model: (config as any).semanticModel,
                  revision: (config as any).semanticModelRevision,
                  cachePath: (config as any).semanticModelCachePath,
                  indexPath: (config as any).semanticIndexPath,
                  candidates: (config as any).semanticCandidates,
                  dimensions: (config as any).semanticModelDimensions,
                  pooling: (config as any).semanticModelPooling,
                },
                // Cross-encoder rerank for explicit search/gather only
                // (deferred task #2); never consulted by automatic preflight.
                reranker: {
                  enabled: (config as any).rerankerEnabled,
                  model: (config as any).rerankerModel,
                  revision: (config as any).rerankerModelRevision,
                  cachePath: (config as any).rerankerModelCachePath,
                  candidateWindow: (config as any).rerankerCandidates,
                },
              });
        const createdSession = new EpochWindowSession({
          archive,
          config,
          sessionId: stableSessionId(ctx.sessionManager, project),
          initialSessionIds,
          project,
          model: ctx.model,
          onRotation: (state) => pi.appendEntry(ROTATION_STATE_ENTRY, state),
        });
        nextSession = createdSession;
        const branch = ctx.sessionManager.getBranch();
        createdSession.restore(branch);
        archiveSetupMs = performance.now() - startupStartedAt;

        const warmupMessages = startupContextMessages(ctx.sessionManager);
        warmupMessageCount = warmupMessages.length;
        const warmupStartedAt = performance.now();
        if (warmupMessages.length > 0) {
          const warmToolArtifacts = (createdSession as any).warmToolArtifacts;
          if (typeof warmToolArtifacts === "function") {
            const warmup = warmToolArtifacts.call(createdSession, warmupMessages);
            warmupArtifactCount = warmup.artifactCount;
          } else {
            // A stale dependency generation must not make `/reload` fail. The
            // cache-busted import above should prevent this, but skipping the
            // optional warmup remains safe if a host loader violates URL identity.
            warmupAvailable = false;
          }
        }
        warmupMs = performance.now() - warmupStartedAt;
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
      diskPressureMonitor.reset();
      emitTiming({
        phase: "startup",
        reason: event.reason,
        archiveSetupMs,
        warmupMs,
        warmupMessageCount,
        warmupArtifactCount,
        warmupAvailable,
        totalMs: performance.now() - startupStartedAt,
      });
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
      const contextStartedAt = performance.now();
      try {
        messages = session.process(event.messages, ctx.model);
      } catch (error) {
        // Keep provider submission fail-closed while exposing bounded internal
        // diagnostics to embedders and evaluation harnesses via Pi's event bus.
        try {
          pi.events.emit("context-window:failure", {
            phase: "context",
            message: error instanceof Error ? error.message : String(error),
          });
        } catch { /* diagnostics must never weaken fail-closed behavior */ }
        return failClosedContext(ctx);
      }
      emitTiming({
        phase: "context",
        elapsedMs: performance.now() - contextStartedAt,
        messageCount: event.messages.length,
      });
      // Status is presentation-only. Once the provider copy is safely bounded,
      // a UI failure must not make Pi discard it and restore the raw input.
      try { updateStatus(ctx); } catch {}
      return { messages };
    });

    pi.on("before_agent_start", (event) => {
      const activeTools = event.systemPromptOptions.selectedTools ?? [];
      if (!activeTools.includes("context_window_gather")
        || !archiveGatherSuggested(event.prompt)
        || event.systemPrompt.includes(ARCHIVE_GATHER_TURN_GUIDANCE)) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Historical context gathering for this turn\n\n${ARCHIVE_GATHER_TURN_GUIDANCE}`,
      };
    });

    // The provider-context event may run without an active TUI context. Refresh
    // after each complete run so the footer reflects the latest measurement.
    pi.on("agent_settled", (_event, ctx) => {
      archiveCompletedSession(session, ctx.sessionManager);
      session?.refreshArchiveProtection();
      updateStatus(ctx);
      maybeWarnDiskPressure(ctx);
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

    pi.on("session_before_compact", (event) => {
      try {
        if (!session || !isCompactionEvent(event)) return { cancel: true };

        // Aggregate provider usage cannot safely apportion tokenizer error
        // between a removed prefix and retained suffix. Once Pi reaches its
        // exact reserve-aware threshold, archive-first custom compaction remains
        // authoritative rather than canceling on an estimated rotation.
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
      recallHandles.clear();
      recallHandleTargets.clear();
      recallHandleByTarget.clear();
      recallHandleByDocumentId.clear();
      pendingTraversal = undefined;
      try {
        archiveCompletedSession(closingSession, ctx.sessionManager);
      } catch (error) {
        cleanupFailure ??= { error };
      }
      try { closingSession?.close(); } catch (error) { cleanupFailure ??= { error }; }
      if (cleanupFailure) throw cleanupFailure.error;
    });

    pi.registerTool({
      name: "context_window_gather",
      label: "context_window_gather",
      description: GATHER_TOOL_DESCRIPTION,
      promptGuidelines: [...EVIDENCE_ROUTING_GUIDELINES],
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Historical question with its entity, workflow anchor, and temporal qualifiers preserved" }),
        intent: Type.Optional(Type.Union([
          Type.Literal("auto"),
          Type.Literal("state"),
          Type.Literal("workflow"),
        ], { default: "auto" })),
        expansionTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 16,
          description: "Likely synonyms or domain terms for hybrid broadening",
        })),
        workingSet: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 16,
          description: "Files/symbols/identifiers you are currently acting on, for a ranking boost only",
        })),
        scope: Type.Optional(Type.Union([
          Type.Literal("auto"),
          Type.Literal("session"),
          Type.Literal("project"),
          Type.Literal("all"),
        ], { default: "auto", description: SEARCH_SCOPE_DESCRIPTION })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        searchEffort: Type.Optional(Type.Union([
          Type.Literal("normal"),
          Type.Literal("wide"),
        ], { default: "normal", description: SEARCH_EFFORT_DESCRIPTION })),
      }, { additionalProperties: false }),
      async execute(_id, params): Promise<ContextToolResult> {
        const active = requireSession();
        if (pendingTraversal) return pendingTraversalResult();
        const totalBudget = active.config.searchResultTokens * 4;
        const gather = exposeGatherHandles(active.gatherDetailed(params.query.trim(), {
          intent: params.intent ?? "auto",
          scope: explicitRecallScope({
            configuredScope: active.config.recallScope,
            requestedScope: params.scope,
            automaticRetrieval: active.automaticRetrievalDiagnostics(),
          }),
          limit: params.limit ?? active.config.searchResults,
          expansionTerms: params.expansionTerms,
          workingSet: params.workingSet,
          searchEffort: params.searchEffort,
          maxEvidence: 12,
          maxTokens: Math.max(39, totalBudget - 640),
        }));
        return {
          content: [{ type: "text", text: formatGatherResults(gather, totalBudget, params.query) }],
          details: {
            ids: gather.evidence.map((item: any) => item.id),
            count: gather.evidence.length,
            status: gather.status,
            mode: gather.mode,
            intent: gather.intent,
            anchorCount: gather.anchorCount,
            candidateCount: gather.candidateCount,
            truncated: gather.truncated,
            hasMore: gather.hasMore,
          },
        };
      },
    });

    pi.registerTool({
      name: "context_window_search",
      label: "context_window_search",
      description: SEARCH_TOOL_DESCRIPTION,
      promptGuidelines: [...EVIDENCE_ROUTING_GUIDELINES],
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Specific terms, file names, errors, or decisions to find" })),
        expansionTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 16,
          description: "Likely synonyms or domain terms for lexical expansion; keep query as the original request",
        })),
        workingSet: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 16,
          description: "Files/symbols/identifiers you are currently acting on, for a ranking boost only",
        })),
        relation: Type.Optional(Type.Union(
          STRUCTURAL_RELATIONS.map((relation) => Type.Literal(relation)),
          { description: "Structural archived-message relation for anchorless references" },
        )),
        scope: Type.Optional(Type.Union([
          Type.Literal("auto"),
          Type.Literal("session"),
          Type.Literal("project"),
          Type.Literal("all"),
        ], {
          default: "auto",
          description: SEARCH_SCOPE_DESCRIPTION,
        })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        searchEffort: Type.Optional(Type.Union([
          Type.Literal("normal"),
          Type.Literal("wide"),
        ], { default: "normal", description: SEARCH_EFFORT_DESCRIPTION })),
      }, { additionalProperties: false }),
      async execute(_id, params): Promise<ContextToolResult> {
        const active = requireSession();
        if (pendingTraversal) return pendingTraversalResult();
        const query = params.query?.trim() ?? "";
        if (!query && !params.relation) {
          throw new Error("context_window_search requires query or relation.");
        }
        const search = active.searchDetailed(query, {
          relation: params.relation,
          scope: explicitRecallScope({
            configuredScope: active.config.recallScope,
            requestedScope: params.scope,
            automaticRetrieval: active.automaticRetrievalDiagnostics(),
          }),
          limit: params.limit ?? active.config.searchResults,
          expansionTerms: params.expansionTerms,
          workingSet: params.workingSet,
          searchEffort: params.searchEffort,
          // Hand render-time excerpt widening the same budget this call
          // already commits to below via formatSearchResults; its own cap
          // still bounds the total.
          hintBudgetTokens: active.config.searchResultTokens,
        });
        const results = exposeRecallHandles(search.results);
        return {
          content: [{
            type: "text",
            text: formatSearchResults(results, active.config.searchResultTokens, { ...search, query }),
          }],
          details: {
            ids: results.map((result: { id: string }) => result.id),
            count: results.length,
            mode: search.mode,
            status: search.status,
            relation: search.relation,
            candidates: search.candidates,
          },
        };
      },
    });

    pi.registerTool({
      name: "context_window_traverse",
      label: "context_window_traverse",
      description: TRAVERSE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        id: Type.String({ description: "Short anchor id from search or a prior traversal page" }),
        direction: Type.Union([Type.Literal("before"), Type.Literal("after")]),
        scope: Type.Optional(Type.Union([
          Type.Literal("auto"),
          Type.Literal("session"),
          Type.Literal("project"),
          Type.Literal("all"),
        ], { default: "auto", description: SEARCH_SCOPE_DESCRIPTION })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params): Promise<ContextToolResult> {
        const active = requireSession();
        if (pendingTraversal
          && (params.id !== pendingTraversal.nextId || params.direction !== pendingTraversal.direction)) {
          return pendingTraversalResult();
        }
        pendingTraversal = undefined;
        const traversal = active.traverseDetailed(resolveRecallHandle(params.id), {
          direction: params.direction,
          scope: explicitRecallScope({
            configuredScope: active.config.recallScope,
            requestedScope: params.scope,
            automaticRetrieval: active.automaticRetrievalDiagnostics(),
          }),
          // A fixed bounded page prevents the model from accidentally choosing
          // a page too short to satisfy unknown-distance temporal relations.
          limit: 128,
        });
        const results = exposeRecallHandles(traversal.results);
        const text = formatTraversalResults(results, active.config.searchResultTokens * 2, traversal);
        const continuation = /continue with context_window_traverse using id="(?<id>[^"]+)" and direction="(?<direction>before|after)"/u.exec(text);
        if (continuation?.groups?.id && continuation.groups.direction) {
          pendingTraversal = {
            nextId: continuation.groups.id,
            direction: continuation.groups.direction as "before" | "after",
            visibleIds: new Set(
              [...text.matchAll(/"id":"(?<id>[^"]+)"/gu)]
                .map((match) => match.groups?.id)
                .filter((id): id is string => id !== undefined),
            ),
          };
        }
        return {
          content: [{ type: "text", text }],
          details: {
            ids: results.map((result: { id: string }) => result.id),
            count: results.length,
            status: traversal.status,
            direction: traversal.direction,
            scanned: traversal.scanned,
            truncated: traversal.truncated,
            hasMore: Boolean(pendingTraversal),
            continuationId: pendingTraversal?.nextId ?? null,
          },
        };
      },
    });

    pi.registerTool({
      name: "context_recall",
      label: "context_recall",
      description: RECALL_TOOL_DESCRIPTION,
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      async execute(_toolCallId, params): Promise<ContextToolResult> {
        const active = requireSession();
        if (pendingTraversal && !pendingTraversal.visibleIds.has(params.id)) {
          return pendingTraversalResult();
        }
        if (pendingTraversal?.visibleIds.has(params.id)) pendingTraversal = undefined;
        const document = active.recall(resolveRecallHandle(params.id));
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

    pi.registerTool({
      name: "context_window_archive",
      label: "context_window_archive",
      description: "Store text outside the active model context so it can later be found with BM25 search. Pass subjectKey for a durable fact or decision so one live document per subject stays retrievable; on a correction, pass supersedes to retire the prior live document for that same subjectKey in the same write.",
      promptGuidelines: [...EVIDENCE_ROUTING_GUIDELINES],
      parameters: Type.Object({
        text: Type.String({ minLength: 1, description: "Text to archive" }),
        kind: Type.Optional(Type.String({ minLength: 1, default: "manual" })),
        metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
        subjectKey: Type.Optional(Type.String({ minLength: 1, description: "Stable subject id for a durable fact or decision" })),
        supersedes: Type.Optional(Type.Object({
          documentId: Type.String({ minLength: 1 }),
          version: Type.Integer({ minimum: 1 }),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const active = requireSession();
        const id = active.archiveManual({
          text: params.text,
          kind: params.kind ?? "manual",
          metadata: params.metadata ?? {},
          subjectKey: params.subjectKey,
          supersedes: params.supersedes,
        });
        return {
          content: [{ type: "text", text: id ? `Archived as ${id}.` : "Nothing to archive." }],
          details: { id: id ?? null },
        };
      },
    });

    pi.registerTool({
      name: "context_window_supersede",
      label: "context_window_supersede",
      description: SUPERSEDE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        documentId: Type.String({ description: "Archived document id to supersede" }),
        version: Type.Optional(Type.Integer({ minimum: 1 })),
        note: Type.Optional(Type.String({ description: "Replacement decision text" })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const active = requireSession();
        const result = active.supersedeArchive({
          documentId: params.documentId,
          version: params.version,
          note: params.note,
        });
        return {
          content: [{ type: "text", text: formatSupersedeResult(result) }],
          details: result,
        };
      },
    });

    pi.registerCommand("window", {
      description: `Context epoch controls: /window [${WINDOW_COMMAND_USAGE}]`,
      getArgumentCompletions: (prefix) => windowArgumentCompletions(prefix, session),
      handler: async (args, ctx) => {
        const active = requireSession();
        updateStatus(ctx);
        const input = args.trim();
        if (input === "settings") {
          await openSettings(ctx);
          return;
        }
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
        if (input === "recall why") {
          ctx.ui.notify(formatAutomaticRetrievalDiagnostics(
            active.automaticRetrievalDiagnostics(),
          ), "info");
          return;
        }
        if (input.startsWith("promote ")) {
          const id = input.slice("promote ".length).trim();
          if (!id) {
            ctx.ui.notify("Usage: /window promote <documentId|locator>", "warning");
            return;
          }
          try {
            ctx.ui.notify(
              formatPromotePacket(active.promoteArchive(id), active.config.searchResultTokens * 2),
              "info",
            );
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (input.startsWith("supersede ")) {
          const rest = input.slice("supersede ".length).trim();
          const match = /^(?<id>\S+)(?:\s+(?<note>[\s\S]+))?$/u.exec(rest);
          const documentId = match?.groups?.id;
          if (!documentId) {
            ctx.ui.notify("Usage: /window supersede <documentId> [replacement note]", "warning");
            return;
          }
          try {
            const result = active.supersedeArchive({
              documentId,
              note: match?.groups?.note?.trim(),
            });
            ctx.ui.notify(formatSupersedeResult(result), "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (input === "daemon status") {
          ctx.ui.notify(formatDaemonLifecycle(active.daemonStatus()), "info");
          return;
        }
        if (input === "daemon restart") {
          ctx.ui.notify(
            "A shared-daemon restart interrupts every connected Pi tab. Confirm with: /window daemon restart --force",
            "warning",
          );
          return;
        }
        if (input === "daemon restart --force") {
          try {
            const result = active.restartDaemon({ reason: "operator forced restart from /window" });
            if (!result) {
              ctx.ui.notify("Shared-daemon restart is unavailable for this archive backend.", "warning");
              return;
            }
            ctx.ui.notify(
              `Restarted context-windowd ${result.previousProcessId} -> ${result.processId}`
                + ` (${result.graceful && !result.forced ? "graceful" : "SIGTERM fallback"}).`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
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
        if (input.startsWith("archive redact ")) {
          const rest = input.slice("archive redact ".length).trim();
          const sessionMatch = /^session(?:\s+confirm\s+(?<confirm>\S+))?$/u.exec(rest);
          const projectMatch = /^project(?:\s+confirm\s+(?<confirm>\S+))?$/u.exec(rest);
          if (sessionMatch && !sessionMatch.groups?.confirm) {
            const suffix = String(active.sessionId).slice(-8);
            ctx.ui.notify(
              `Confirm session redact with: /window archive redact session confirm ${suffix}`,
              "warning",
            );
            return;
          }
          if (projectMatch && !projectMatch.groups?.confirm) {
            const base = String(active.project).replace(/[/\\]+$/u, "").split(/[/\\]/u).pop()
              || active.project;
            ctx.ui.notify(
              `Confirm project redact with: /window archive redact project confirm ${base}`,
              "warning",
            );
            return;
          }
          try {
            if (sessionMatch?.groups?.confirm) {
              const result = active.redactArchive({
                scope: "session",
                sessionId: active.sessionId,
                confirm: sessionMatch.groups.confirm,
              });
              ctx.ui.notify(formatRedactResult(result), "info");
              return;
            }
            if (projectMatch?.groups?.confirm) {
              const result = active.redactArchive({
                scope: "project",
                confirm: projectMatch.groups.confirm,
              });
              ctx.ui.notify(formatRedactResult(result), "info");
              return;
            }
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          ctx.ui.notify(
            "Usage: /window archive redact session|project confirm <token>",
            "warning",
          );
          return;
        }
        if (input === "usage") {
          let contextUsage;
          try {
            contextUsage = ctx.getContextUsage?.();
          } catch { /* provider usage is presentation-only; never block the command */ }
          ctx.ui.notify(
            formatWindowUsage(active.status({ includeArchiveCount: false }), active.activeMessages, { contextUsage }),
            "info",
          );
          return;
        }
        ctx.ui.notify(formatStatusDetails(active.status()), "info");
      },
    });
  };
}

export default createContextEpochWindow({ epochWindowLoader: loadFreshEpochWindow });
