import {
  ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
  ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
  createArchiveCheckpoint,
  createCompactionCatalog,
  reconstructCheckpointSource,
} from "../archive/archive-checkpoint.js";
import {
  buildTocMarkerText,
  deduplicateToolResults,
  estimateTokens,
  extractDecisionCandidates,
  extractSalientTerms,
  externalizeLargeToolArguments,
  externalizeLargeToolResults,
  groupCompleteTurns,
  messageKey,
  planEpochRotation,
  removeEmptyAssistantErrors,
  resolveContextLimits,
  serializeMessage,
  serializeMessages,
  sliceFromBoundary,
  TOC_TOKEN_BUDGET,
  turnTopic,
} from "./window.js";
import {
  measureToolResultTokens,
  resolveToolResultBudget,
  toolArgumentId,
  toolResultId,
} from "./epoch-budget.js";
import {
  appendArchivedHint,
  inlineUserTokens,
  OversizedInputArchiveError,
  replaceProviderText,
  structuralMessages,
  structuralText,
  userMessageKeys,
} from "./epoch-messages.js";
import {
  CHECKPOINT_ROOT_KIND,
  checkpointCreatedAt,
  checkpointIds,
  checkpointPlanningArchive,
  checkpointResultMatches,
  checkpointSourceChunks,
  checkpointSourceKey,
  CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
  latestTrustedArchiveEntries,
  MAX_TOC_CHECKPOINT_IDS_PER_ENTRY,
  normalizedArchiveEntries,
  normalizedMergedArchiveEntries,
  restoredTocEntry,
} from "./epoch-checkpoint.js";

// Re-export the split modules' public surface so importers of this module keep
// their existing entry point. CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION and
// OversizedInputArchiveError now live with the checkpoint and message helpers.
export { CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION, OversizedInputArchiveError };

// Bounds persisted rotation-state growth; the marker text is separately
// bounded by the token budget in buildTocMarkerText.
export const TOC_MAX_ENTRIES = 64;

const HINT_STATE_VERSION = 1;
const MAX_RECONSTRUCT_ONLY_HINT_KEYS = 1_000;

export const ROTATION_STATE_ENTRY = "context-epoch-window:rotation";

/**
 * Host-independent state machine for one active context-window session.
 *
 * The archive and rotation callback are injected so adapters can provide their
 * own persistence without changing epoch policy.
 */
export class EpochWindowSession {
  constructor({
    archive,
    config,
    sessionId,
    initialSessionIds = /** @type {string[]} */ ([]),
    project,
    model,
    onRotation = (_state) => {},
  }) {
    this.archive = archive;
    this.config = config;
    this.sessionId = sessionId;
    this.initialSessionIds = [...initialSessionIds].filter(Boolean).map(String);
    this.sessionIds = new Set([sessionId, ...this.initialSessionIds]);
    this.project = project;
    this.onRotation = onRotation;
    this.boundaryKey = undefined;
    this.activeTokens = undefined;
    this.activeTurns = undefined;
    this.activeMessages = undefined;
    this.toolResultBudget = undefined;
    this.rotations = 0;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.lastPreflightError = undefined;
    this.lastAutomaticRetrieval = undefined;
    this.lastHintCleanupError = undefined;
    this.toc = [];
    this.activeArchiveIds = new Set();
    this.compactionArchiveEntries = Object.freeze([]);
    this.compactionArchiveIds = new Set();
    this.activeHintMessageKeys = new Set();
    this.frozenHintTextByMessageKey = new Map();
    this.reconstructOnlyHintMessageKeys = new Set();
    this.observedActiveUserKeys = new Set();
    this.pendingHintRemovalKeys = new Set();
    this.hintReconciledBoundaryKey = undefined;
    this.contextLimits = resolveContextLimits(config, model);
    this.refreshArchiveProtection();
  }

  restore(entries) {
    this.boundaryKey = undefined;
    this.rotations = 0;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.lastPreflightError = undefined;
    this.lastAutomaticRetrieval = undefined;
    this.lastHintCleanupError = undefined;
    this.toc = [];
    this.activeArchiveIds = new Set();
    this.compactionArchiveEntries = Object.freeze([]);
    this.compactionArchiveIds = new Set();
    this.activeHintMessageKeys = new Set();
    this.frozenHintTextByMessageKey = new Map();
    this.reconstructOnlyHintMessageKeys = new Set();
    this.observedActiveUserKeys = new Set();
    this.pendingHintRemovalKeys = new Set();
    this.hintReconciledBoundaryKey = undefined;
    // Search lineage is authoritative only when supplied from verified session headers.
    this.sessionIds = new Set([this.sessionId, ...this.initialSessionIds]);
    if (!Array.isArray(entries)) {
      this.refreshArchiveProtection();
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object"
        || entry.type !== "custom" || entry.customType !== ROTATION_STATE_ENTRY) continue;
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      this.boundaryKey = typeof data.boundaryKey === "string" ? data.boundaryKey : undefined;
      if (Number.isSafeInteger(data.rotations) && data.rotations >= 0) {
        this.rotations = data.rotations;
      }
      this.lastRotationReason = ["forced", "tokens", "turns"].includes(data.reason)
        ? data.reason
        : undefined;
      this.lastRotationMode = ["normal", "emergency-retention"].includes(data.mode)
        ? data.mode
        : undefined;
      this.effectiveRetainTurns = Number.isSafeInteger(data.effectiveRetainTurns)
        && data.effectiveRetainTurns > 0
        ? data.effectiveRetainTurns
        : undefined;
      if (Array.isArray(data.toc)) {
        this.toc = data.toc
          .map((value) => restoredTocEntry(value, this.archive))
          .filter((entry) => entry !== undefined)
          .slice(-TOC_MAX_ENTRIES);
      }
      const hintState = data.hintState;
      this.reconstructOnlyHintMessageKeys = new Set(
        hintState && typeof hintState === "object" && !Array.isArray(hintState)
          && hintState.version === HINT_STATE_VERSION
          && Array.isArray(hintState.reconstructOnlyMessageKeys)
          ? hintState.reconstructOnlyMessageKeys
            .filter((key) => typeof key === "string"
              && key.startsWith("user:")
              && key.length <= 2_048)
            .slice(-MAX_RECONSTRUCT_ONLY_HINT_KEYS)
          : [],
      );
    }
    const trustedEntries = latestTrustedArchiveEntries(entries, undefined, this.archive);
    if (trustedEntries !== undefined) {
      this.compactionArchiveEntries = trustedEntries;
      this.compactionArchiveIds = checkpointIds(trustedEntries);
    }
    this.refreshArchiveProtection();
  }

  process(messages, model) {
    this.contextLimits = resolveContextLimits(this.config, model);
    if (this.contextLimits.inputWindowTokens === 0
      && this.contextLimits.piCompactionReserveTokens !== undefined) {
      throw new Error("Pi's compaction reserve leaves no usable model input budget.");
    }
    const contextMessages = removeEmptyAssistantErrors(messages);
    let sliced = sliceFromBoundary(contextMessages, this.boundaryKey);
    let boundaryPrefix = [];
    if (!sliced.found) {
      this.boundaryKey = undefined;
      sliced = { messages: contextMessages, found: true, start: 0 };
    } else if (this.boundaryKey !== undefined
      && this.hintReconciledBoundaryKey !== this.boundaryKey
      && sliced.start > 0) {
      boundaryPrefix = contextMessages.slice(0, sliced.start);
    }

    let active = sliced.messages;
    if (active.length === 0) {
      this.reconcileHintLifecycle([], boundaryPrefix);
      this.activeArchiveIds = new Set();
      this.refreshArchiveProtection();
      this.archive.prune?.();
      this.clearMeasurement();
      return active;
    }

    let visibleSourceKeys = active.map(messageKey);
    const oversized = this.externalizeOversizedUsers(active);
    active = oversized.messages;
    const suppressedHintMessageKeys = oversized.providerMessageKeys;
    this.activeArchiveIds = new Set(oversized.archiveIds);
    const dedupEnabled = this.config.dedupToolResults !== false;
    const deduplicated = dedupEnabled
      ? deduplicateToolResults(active, {
        store: (message, text) => this.storeToolResult(message, text),
      })
      : { messages: active, archiveIds: [] };
    active = deduplicated.messages;
    for (const id of deduplicated.archiveIds) this.activeArchiveIds.add(id);
    const budgetPolicy = resolveToolResultBudget(
      this.config,
      this.contextLimits.rotationTokens,
    );
    const externalized = externalizeLargeToolResults(active, {
      maxTokens: budgetPolicy.maxToolResultTokens,
      store: (message, text) => this.storeToolResult(message, text),
      budgetTokens: budgetPolicy.budgetTokens,
      floorTokens: budgetPolicy.floorTokens,
    });
    active = externalized.messages;
    for (const id of externalized.archiveIds) this.activeArchiveIds.add(id);
    const configuredArgumentLimit = Number(this.config.maxToolArgumentTokens);
    const maxToolArgumentTokens = Number.isSafeInteger(configuredArgumentLimit) && configuredArgumentLimit > 0
      ? configuredArgumentLimit
      : 4_000;
    const externalizedArguments = externalizeLargeToolArguments(active, {
      maxTokens: maxToolArgumentTokens,
      store: (message, part, text) => this.storeToolArgument(message, part, text),
    });
    active = externalizedArguments.messages;
    for (const id of externalizedArguments.archiveIds) this.activeArchiveIds.add(id);
    this.refreshArchiveProtection();
    this.archive.prune?.();

    // The marker occupies real window space, so it counts toward rotation
    // pressure; it is synthetic, so it never counts as a user turn.
    let marker = this.tocMarkerMessage();
    this.activeTokens = estimateTokens(marker ? [marker, ...active] : active);
    this.activeTurns = this.countUserTurns(active);
    if (this.activeTokens === 0 && this.activeTurns === 0) {
      this.reconcileHintLifecycle(active, boundaryPrefix);
      this.clearMeasurement();
      return active;
    }

    const plan = planEpochRotation(active, {
      force: this.forceRotation,
      tokens: this.activeTokens,
      turns: this.activeTurns,
      rotationTokens: this.contextLimits.rotationTokens,
      rotationTurns: this.contextLimits.rotationTurns,
      retainTurns: this.config.retainTurns,
      markerTokenReserve: TOC_TOKEN_BUDGET,
    });

    if (plan.action === "rotate") {
      // Indices are stable because externalization replaces messages in place.
      // Archive the exact source messages, not their provider-facing previews.
      const rotatedMessages = sliced.messages.slice(0, plan.start);
      this.archiveTurns(rotatedMessages);
      this.boundaryKey = messageKey(sliced.messages[plan.start]);
      this.rotations += 1;
      this.lastRotationReason = plan.trigger;
      this.lastRotationMode = plan.mode;
      this.effectiveRetainTurns = plan.retainedTurns;
      this.compactionFallbackReason = undefined;
      this.refreshArchiveProtection();
      this.onRotation(this.rotationState());
      active = active.slice(plan.start);
      visibleSourceKeys = visibleSourceKeys.slice(plan.start);
      boundaryPrefix = [...boundaryPrefix, ...rotatedMessages];
      marker = this.tocMarkerMessage();
      this.activeTokens = estimateTokens(marker ? [marker, ...active] : active);
    } else if (plan.action === "native-compaction") {
      // A forced rotation can be impossible simply because there is not yet a
      // second user boundary; that is not token pressure requiring compaction.
      this.compactionFallbackReason = plan.trigger === "forced" ? undefined : plan.reason;
    } else {
      this.compactionFallbackReason = undefined;
    }
    this.forceRotation = false;

    this.reconcileHintLifecycle(active, boundaryPrefix);
    active = this.withAutomaticArchiveHint(
      active,
      visibleSourceKeys,
      suppressedHintMessageKeys,
    );
    this.activeTurns = this.countUserTurns(active);
    this.activeMessages = marker ? [marker, ...active] : active;
    this.activeTokens = estimateTokens(this.activeMessages);
    // Measure over the final retained slice: this recomputes the same counter
    // deterministically on resume and resets to the retained epoch after a
    // rotation slices the active window.
    const toolResultTokens = measureToolResultTokens(active);
    this.toolResultBudget = Object.freeze({
      tokens: toolResultTokens,
      budgetTokens: budgetPolicy.budgetTokens,
      floorTokens: budgetPolicy.floorTokens,
      maxTokens: budgetPolicy.maxToolResultTokens,
      overBudget: toolResultTokens >= budgetPolicy.budgetTokens,
    });
    return this.activeMessages;
  }

  /**
   * Deterministic synthetic message indexing rotated-out turns. Built only
   * from persisted rotation state, so it is byte-stable across requests and
   * changes only at rotation — where the prefix already breaks.
   */
  tocMarkerMessage() {
    const text = buildTocMarkerText(this.toc);
    if (!text) return undefined;
    return { role: "user", content: [{ type: "text", text }] };
  }

  updateModel(model) {
    this.contextLimits = resolveContextLimits(this.config, model);
  }

  updateWindowPolicy(config, model) {
    for (const key of [
      "rotationContextRatio",
      "hardLimitContextRatio",
      "rotationTokens",
      "rotationTokensExplicit",
      "hardLimitTokens",
      "hardLimitTokensExplicit",
      "piCompactionReserveTokens",
      "rotationTurns",
      "retainTurns",
      "toolResultBudgetRatio",
      "toolResultBudgetFloorTokens",
      "models",
      "environmentOverrides",
    ]) {
      this.config[key] = config[key];
    }
    this.updateModel(model);
  }

  refreshArchiveProtection() {
    const documentIds = new Set([
      ...this.activeArchiveIds,
      ...this.compactionArchiveIds,
    ]);
    for (const entry of this.toc) {
      documentIds.add(entry.id);
      for (const id of entry.archiveIds ?? []) documentIds.add(id);
    }
    this.archive.setProtectedContext?.({
      sessionIds: [...this.sessionIds],
      documentIds: [...documentIds],
    });
  }

  archiveStats() {
    return this.archive.stats?.();
  }

  daemonStatus() {
    return this.archive.daemonStatus?.();
  }

  restartDaemon(options) {
    return this.archive.restartDaemon?.(options);
  }

  pruneArchive(options) {
    return this.archive.prune?.({ ...options, force: true });
  }

  reclaimArchive(options) {
    return this.archive.reclaim?.(options);
  }

  resolveSubject(subjectKey) {
    return this.archive.resolveSubject?.(subjectKey);
  }

  /**
   * @param {{text: string, kind?: string, metadata?: object, subjectKey?: string, supersedes?: {documentId: string, version: number}}} options
   */
  archiveManual({ text, kind = "manual", metadata = {}, subjectKey, supersedes } = {}) {
    if ((subjectKey !== undefined || supersedes !== undefined)
      && typeof this.archive.resolveSubject !== "function") {
      throw new Error("subjectKey and supersedes require the RocksDB archive backend.");
    }
    return this.archive.put({
      sessionId: this.sessionId,
      project: this.project,
      kind,
      text,
      metadata,
      ...(subjectKey === undefined ? {} : { subjectKey }),
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  }

  supersedeArchive(request) {
    if (typeof this.archive.supersede !== "function") {
      throw new Error("Archive supersession is unavailable for this backend.");
    }
    return this.archive.supersede({
      ...request,
      sessionId: request.sessionId ?? this.sessionId,
    });
  }

  redactArchive(request) {
    if (typeof this.archive.redact !== "function") {
      throw new Error("Archive redaction is unavailable for this backend.");
    }
    return this.archive.redact(request);
  }

  promoteArchive(id) {
    const document = this.recall(id);
    if (!document) return undefined;
    return {
      documentId: document.documentId ?? document.id ?? id,
      kind: document.kind,
      createdAt: document.createdAt,
      // recalledText carries the raw decision text; text may be a rendered,
      // JSON-framed evidence envelope on backends with a model-visible trust
      // boundary (see recalledDocument in src/daemon-archive.js).
      text: document.recalledText ?? document.text,
      subjectKey: document.subjectKey,
      sessionId: document.sessionId,
    };
  }

  checkpointCompaction(preparation, { branchEntries = [] } = {}) {
    try {
      if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)
        || typeof preparation.firstKeptEntryId !== "string"
        || preparation.firstKeptEntryId.length === 0
        || !Number.isSafeInteger(preparation.tokensBefore)
        || preparation.tokensBefore < 0
        || !Array.isArray(preparation.messagesToSummarize)
        || !Array.isArray(preparation.turnPrefixMessages)
        || typeof preparation.isSplitTurn !== "boolean"
        || (preparation.previousSummary !== undefined
          && typeof preparation.previousSummary !== "string")) {
        return undefined;
      }

      const sources = [];
      const appendSource = (messages, label, kind) => {
        const chunks = checkpointSourceChunks(messages);
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const chunkLabel = chunks.length === 1
            ? label
            : `${label}-${index + 1}-of-${chunks.length}`;
          const text = serializeMessages(chunk);
          sources.push({
            text,
            sourceKey: checkpointSourceKey(chunkLabel, chunk, text),
            sourceMessageKeys: chunk.map((message) => messageKey(message)),
            kind,
            createdAt: checkpointCreatedAt(chunk),
            topic: turnTopic(chunk),
            terms: extractSalientTerms(text),
          });
        }
      };
      appendSource(
        preparation.messagesToSummarize,
        "compaction-span",
        "compaction-span",
      );
      appendSource(
        preparation.turnPrefixMessages,
        "compaction-turn-prefix",
        "compaction-turn-prefix",
      );

      const previousSummary = typeof preparation.previousSummary === "string"
        ? preparation.previousSummary
        : undefined;
      const trustedPrevious = previousSummary === undefined
        ? undefined
        : latestTrustedArchiveEntries(
          branchEntries,
          previousSummary,
          this.archive,
          { requireExactSource: true },
        );
      const previousEntries = trustedPrevious ?? Object.freeze([]);
      const previousSummaryCoveredByTrustedCatalog = trustedPrevious !== undefined;
      if (sources.length === 0 && previousSummary === undefined) return undefined;

      const createdAt = checkpointCreatedAt([
        ...preparation.messagesToSummarize,
        ...preparation.turnPrefixMessages,
      ]);
      const request = {
        sessionId: this.sessionId,
        project: this.project,
        sources,
        ...(previousSummary === undefined ? {} : { previousSummary }),
        previousSummaryCoveredByTrustedCatalog,
        createdAt,
        previewSourceIndex: 0,
        previewTokens: ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
        catalogTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
      };
      const planned = createArchiveCheckpoint({
        archive: checkpointPlanningArchive(this.archive),
        ...request,
      });
      if (planned.status !== "stored") return undefined;
      const plannedEntries = normalizedArchiveEntries(planned.roots);
      if (plannedEntries === undefined) return undefined;
      const plannedCombined = normalizedMergedArchiveEntries(previousEntries, plannedEntries);
      if (plannedCombined === undefined) return undefined;

      // When an earlier extension catalog is carried forward, prove the final
      // bound before publishing any new part or root.
      const catalog = createCompactionCatalog(plannedCombined, {
        maxTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
      });

      const stored = createArchiveCheckpoint({ archive: this.archive, ...request });
      if (!checkpointResultMatches(planned, stored)) return undefined;
      const storedEntries = normalizedArchiveEntries(stored.roots);
      if (storedEntries === undefined) return undefined;
      const combined = normalizedMergedArchiveEntries(previousEntries, storedEntries);
      if (combined === undefined) return undefined;
      if (createCompactionCatalog(combined, {
        maxTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
      }) !== catalog) return undefined;

      const previousArchiveEntries = this.compactionArchiveEntries;
      const previousArchiveIds = this.compactionArchiveIds;
      this.compactionArchiveEntries = combined;
      this.compactionArchiveIds = checkpointIds(combined);
      try {
        this.refreshArchiveProtection();
        this.archive.prune?.();
      } catch {
        this.compactionArchiveEntries = previousArchiveEntries;
        this.compactionArchiveIds = previousArchiveIds;
        try { this.refreshArchiveProtection(); } catch {}
        return undefined;
      }

      return {
        summary: catalog,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: {
          contextWindowArchive: {
            version: CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION,
            entries: combined.map((entry) => ({
              ...entry,
              terms: [...entry.terms],
              partIds: [...entry.partIds],
            })),
          },
        },
      };
    } catch {
      return undefined;
    }
  }

  requestRotation() {
    this.forceRotation = true;
  }

  resetAfterCompaction() {
    // Pi decides which messages survive native compaction after this callback.
    // Preserve frozen decisions until the next concrete context arrives, then
    // reconcile against its actual user-message keys. Clearing here would let
    // the same live messages consume a fresh automatic-hint allowance.
    this.boundaryKey = undefined;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.toc = [];
    this.activeArchiveIds = new Set();
    this.hintReconciledBoundaryKey = undefined;
    this.refreshArchiveProtection();
    this.clearMeasurement();
    return this.rotationState();
  }

  clearMeasurement() {
    this.activeTokens = undefined;
    this.activeTurns = undefined;
    this.activeMessages = undefined;
    this.toolResultBudget = undefined;
  }

  search(query, options = {}) {
    return this.searchDetailed(query, options).results;
  }

  searchDetailed(query, options = {}) {
    const searchOptions = {
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      project: this.project,
      scope: options.scope ?? "session",
      limit: options.limit ?? this.config.searchResults,
      relation: options.relation,
      expansionTerms: options.expansionTerms,
      workingSet: options.workingSet,
      ...(Number.isSafeInteger(options.hintBudgetTokens) ? { hintBudgetTokens: options.hintBudgetTokens } : {}),
    };
    if (this.archive.searchDetailed) {
      return this.archive.searchDetailed(query, searchOptions);
    }
    const results = this.archive.search(query, searchOptions);
    return {
      mode: options.relation ? "structural" : "lexical",
      relation: options.relation,
      status: results.length > 0 ? "resolved" : "not-found",
      results,
      candidates: results.map(({ id }) => ({ id, granularity: "document" })),
    };
  }

  gatherDetailed(query, options = {}) {
    const gatherOptions = {
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      project: this.project,
      scope: options.scope ?? "session",
      intent: options.intent ?? "auto",
      limit: options.limit ?? this.config.searchResults,
      expansionTerms: options.expansionTerms,
      workingSet: options.workingSet,
      before: options.before,
      after: options.after,
      neighborhoodAnchors: options.neighborhoodAnchors,
      maxEvidence: options.maxEvidence,
      maxTokens: options.maxTokens ?? this.config.searchResultTokens * 4,
      excludeVisibleSourceKeys: options.excludeVisibleSourceKeys,
    };
    if (typeof this.archive.gatherDetailed === "function") {
      return this.archive.gatherDetailed(query, gatherOptions);
    }

    // Compatibility fallback for custom and legacy archive implementations.
    // It preserves the one-tool gather behavior, but only RocksDB can force the
    // hybrid semantic expansion and enforce the aggregate recall budget in the
    // store process.
    const search = this.searchDetailed(query, gatherOptions);
    const candidates = new Map();
    const add = (result, relation, anchorRank, distance) => {
      const key = result.documentId ?? result.id;
      const current = candidates.get(key);
      const priority = relation === "anchor" ? anchorRank : 100 + anchorRank * 20 + distance;
      if (!current || priority < current.priority) {
        candidates.set(key, { result, relation, anchorRank, distance, priority });
      }
    };
    search.results.forEach((result, index) => add(result, "anchor", index + 1, 0));
    const intent = gatherOptions.intent;
    const before = Number.isSafeInteger(gatherOptions.before)
      ? gatherOptions.before
      : intent === "state" ? 0 : 1;
    const after = Number.isSafeInteger(gatherOptions.after)
      ? gatherOptions.after
      : intent === "workflow" ? 8 : intent === "state" ? 0 : 3;
    const neighborhoodAnchors = search.results.slice(0, gatherOptions.neighborhoodAnchors ?? 2);
    let hasMore = false;
    neighborhoodAnchors.forEach((anchor, anchorIndex) => {
      for (const [direction, limit] of [["before", before], ["after", after]]) {
        if (limit === 0) continue;
        const traversal = this.traverseDetailed(anchor.id, { direction, scope: gatherOptions.scope, limit });
        hasMore ||= traversal.hasMore;
        traversal.results.forEach((result, index) => {
          add(result, direction, anchorIndex + 1, index + 1);
        });
      }
    });
    const selected = [...candidates.values()]
      .sort((left, right) => left.priority - right.priority)
      .slice(0, gatherOptions.maxEvidence ?? 12)
      .map((item) => ({
        relation: item.relation,
        anchorRank: item.anchorRank,
        distance: item.distance,
        id: item.result.id,
        locator: item.result.id,
        document: this.recall(item.result.id),
      }))
      .filter((item) => item.document)
      .sort((left, right) => Number(left.document.createdAt) - Number(right.document.createdAt));
    const truncated = hasMore || candidates.size > selected.length || search.results.length === gatherOptions.limit;
    return {
      status: selected.length > 0 ? "resolved" : "not-found",
      mode: search.mode,
      intent,
      anchorCount: search.results.length,
      candidateCount: candidates.size,
      returnedTokens: 0,
      truncated,
      hasMore: truncated,
      evidence: selected,
    };
  }

  traverseDetailed(id, options = {}) {
    if (typeof this.archive.traverseDetailed !== "function") {
      return {
        mode: "chronological",
        status: "not-found",
        direction: options.direction ?? "before",
        scanned: 0,
        truncated: false,
        hasMore: false,
        results: [],
        candidates: [],
      };
    }
    return this.archive.traverseDetailed(id, {
      direction: options.direction ?? "before",
      scope: options.scope ?? "session",
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      project: this.project,
      limit: options.limit ?? 128,
      scanLimit: options.scanLimit ?? 2_048,
    });
  }

  recall(id) {
    const document = this.archive.get(id, {
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      scope: "session",
    });
    if (document?.kind !== CHECKPOINT_ROOT_KIND) return document;

    const rootId = document.documentId ?? document.id;
    if (typeof rootId !== "string" || rootId.length === 0) {
      throw new Error("Checkpoint recall did not resolve a root ID.");
    }
    const reconstructed = reconstructCheckpointSource(this.archive, rootId);
    const {
      modelVisibleFramed: _modelVisibleFramed,
      provenance: _provenance,
      recalledText: _recalledText,
      ...base
    } = document;
    const sourceMessageKeys = reconstructed.root.sourceMessageKeys
      ?? [reconstructed.root.sourceKey];
    return {
      ...base,
      id: rootId,
      documentId: rootId,
      recallId: id,
      kind: reconstructed.root.sourceKind,
      text: reconstructed.text,
      sourceKey: reconstructed.root.sourceKey,
      sourceKeyStatus: "preserved",
      sourceMessageKeys: [...sourceMessageKeys],
      metadata: {
        checkpointFormatVersion: reconstructed.root.checkpointFormatVersion,
        publicationId: reconstructed.root.publicationId,
        contentHash: reconstructed.root.hash,
        byteCount: reconstructed.root.byteCount,
        partCount: reconstructed.root.parts.length,
        sourceMessageKeys: [...sourceMessageKeys],
        sourceFirstKey: sourceMessageKeys[0],
        sourceLastKey: sourceMessageKeys.at(-1),
        sourceMessageCount: sourceMessageKeys.length,
      },
      metadataParse: { status: "valid" },
    };
  }

  withAutomaticArchiveHint(messages, originalSourceKeys = [], suppressedMessageKeys = new Set()) {
    if (this.config.automaticRetrieval === false
      && this.frozenHintTextByMessageKey.size === 0
      && this.reconstructOnlyHintMessageKeys.size === 0) {
      return messages;
    }
    let next;
    let lastError;
    let hintStateChanged = false;
    const visibleSourceKeys = [...new Set([
      ...originalSourceKeys,
      ...messages.map(messageKey),
    ])];
    const activeMessageKeys = [...userMessageKeys(messages)];
    const activeHintBudgetTokens = this.config.activeHintBudgetTokens
      ?? this.config.epochHintBudgetTokens
      ?? 640;
    const cooldownHours = this.config.hintSourceCooldownHours ?? 24;
    const hintSourceCooldownMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      cooldownHours * 60 * 60 * 1_000,
    );
    for (let index = 0; index < messages.length; index += 1) {
      const target = messages[index];
      const message = target?.role === "user" ? structuralText(target) : "";
      if (!message.trim()) continue;
      const targetKey = messageKey(target);
      if (suppressedMessageKeys.has(targetKey)) continue;
      const frozenHint = this.frozenHintTextByMessageKey.get(targetKey);
      if (frozenHint !== undefined || this.frozenHintTextByMessageKey.has(targetKey)) {
        this.activeHintMessageKeys.add(targetKey);
        if (frozenHint) {
          next ??= [...messages];
          next[index] = appendArchivedHint(target, frozenHint);
        }
        continue;
      }
      const reconstruct = this.reconstructOnlyHintMessageKeys.has(targetKey);
      if (!reconstruct && this.config.automaticRetrieval === false) continue;
      if (typeof this.archive.preflight !== "function") {
        // Fully resolved production config always carries a boolean. Preserve
        // compatibility for partial embedders that omit this setting.
        if (!reconstruct && this.config.automaticRetrieval !== true) continue;
        if (!reconstruct) {
          this.reconstructOnlyHintMessageKeys.add(targetKey);
          hintStateChanged = true;
        }
        // Capability absence is a failed attempt, not permission to search
        // later after this exact provider prefix has already been used.
        this.frozenHintTextByMessageKey.set(targetKey, "");
        this.activeHintMessageKeys.add(targetKey);
        this.lastAutomaticRetrieval = Object.freeze({
          messageKey: targetKey,
          outcome: "error",
          reason: "preflight-unavailable",
          candidate: null,
        });
        continue;
      }
      if (!reconstruct) {
        this.reconstructOnlyHintMessageKeys.add(targetKey);
        hintStateChanged = true;
      }
      try {
        const response = this.archive.preflight({
          messageKey: targetKey,
          message,
          scope: "session",
          sessionId: this.sessionId,
          sessionIds: [...this.sessionIds],
          project: this.project,
          excludeVisibleSourceKeys: visibleSourceKeys,
          hintBudgetTokens: this.config.hintBudgetTokens ?? 160,
          activeHintBudgetTokens,
          activeMessageKeys,
          hintSourceCooldownMs,
          ephemeralAutoRetrievalDays: this.config.ephemeralAutoRetrievalDays ?? 7,
          conversationAutoRetrievalDays: this.config.conversationAutoRetrievalDays ?? 30,
          derivedAutoRetrievalDays: this.config.derivedAutoRetrievalDays ?? 30,
          includeDiagnostics: true,
          epochId: `${this.sessionId}:${this.rotations}`,
          epochBudgetTokens: activeHintBudgetTokens,
          ...(reconstruct ? { reconstruct: true } : {}),
        });
        const modelVisibleText = typeof response?.modelVisibleText === "string"
          ? response.modelVisibleText
          : "";
        this.frozenHintTextByMessageKey.set(targetKey, modelVisibleText);
        this.activeHintMessageKeys.add(targetKey);
        if (response?.diagnostics && typeof response.diagnostics === "object") {
          this.lastAutomaticRetrieval = Object.freeze({
            ...structuredClone(response.diagnostics),
            messageKey: targetKey,
          });
        }
        if (modelVisibleText) {
          next ??= [...messages];
          next[index] = appendArchivedHint(target, modelVisibleText);
        }
      } catch (error) {
        // Retrieval augments the prompt; one failed reconstruction must never
        // suppress live messages, discard other frozen prefix bytes, or add a
        // newly recovered hint to this already-visible prefix on a later call.
        this.frozenHintTextByMessageKey.set(targetKey, "");
        this.activeHintMessageKeys.add(targetKey);
        lastError = error instanceof Error ? error.message : String(error);
        this.lastAutomaticRetrieval = Object.freeze({
          messageKey: targetKey,
          outcome: "error",
          reason: "preflight-error",
          candidate: null,
          error: lastError,
        });
      }
    }
    this.lastPreflightError = lastError;
    if (hintStateChanged) {
      // Persist only the fact that a decision was attempted. On reload, the
      // daemon may reconstruct an existing frozen response, but it may not run
      // a new search for an already-used provider prefix. This also makes a
      // failed attempt durably empty without storing model-visible bytes here.
      this.onRotation(this.rotationState());
    }
    return next ?? messages;
  }

  automaticRetrievalDiagnostics() {
    return this.lastAutomaticRetrieval === undefined
      ? undefined
      : structuredClone(this.lastAutomaticRetrieval);
  }

  reconcileHintLifecycle(activeMessages, retiredMessages = [], retiredKeys = new Set()) {
    const activeKeys = userMessageKeys(activeMessages);
    let hintStateChanged = false;
    for (const key of userMessageKeys(retiredMessages)) this.pendingHintRemovalKeys.add(key);
    for (const key of retiredKeys) this.pendingHintRemovalKeys.add(key);
    for (const key of this.observedActiveUserKeys) {
      if (!activeKeys.has(key)) this.pendingHintRemovalKeys.add(key);
    }
    for (const key of this.activeHintMessageKeys) {
      if (!activeKeys.has(key)) this.pendingHintRemovalKeys.add(key);
    }
    for (const key of this.reconstructOnlyHintMessageKeys) {
      if (!activeKeys.has(key)) this.pendingHintRemovalKeys.add(key);
    }
    for (const key of activeKeys) this.pendingHintRemovalKeys.delete(key);

    const removable = [...this.pendingHintRemovalKeys];
    if (removable.length > 0 && typeof this.archive.removeHints === "function") {
      try {
        this.archive.removeHints(removable, { sessionId: this.sessionId });
        for (const key of removable) {
          this.pendingHintRemovalKeys.delete(key);
          this.activeHintMessageKeys.delete(key);
          this.frozenHintTextByMessageKey.delete(key);
          hintStateChanged = this.reconstructOnlyHintMessageKeys.delete(key)
            || hintStateChanged;
        }
        this.lastHintCleanupError = undefined;
      } catch (error) {
        this.lastHintCleanupError = error instanceof Error ? error.message : String(error);
      }
    } else if (removable.length > 0) {
      // Backends without lifecycle deletion own no removable hint state through
      // this interface; do not retain an unbounded in-memory retry queue.
      this.pendingHintRemovalKeys.clear();
      for (const key of removable) {
        this.activeHintMessageKeys.delete(key);
        this.frozenHintTextByMessageKey.delete(key);
        hintStateChanged = this.reconstructOnlyHintMessageKeys.delete(key)
          || hintStateChanged;
      }
      this.lastHintCleanupError = undefined;
    }
    if (this.pendingHintRemovalKeys.size === 0) {
      this.hintReconciledBoundaryKey = this.boundaryKey;
    }
    this.observedActiveUserKeys = activeKeys;
    if (hintStateChanged) this.onRotation(this.rotationState());
  }

  status({ includeArchiveCount = true } = {}) {
    const archiveStorage = includeArchiveCount ? this.archiveStats() : undefined;
    return {
      activeTokens: this.activeTokens,
      activeTurns: this.activeTurns,
      ...(this.toolResultBudget === undefined ? {} : {
        toolResultTokens: this.toolResultBudget.tokens,
        toolResultBudgetTokens: this.toolResultBudget.budgetTokens,
        toolResultBudgetFloorTokens: this.toolResultBudget.floorTokens,
        toolResultMaxTokens: this.toolResultBudget.maxTokens,
        toolResultOverBudget: this.toolResultBudget.overBudget,
      }),
      rotationTokens: this.contextLimits.rotationTokens,
      rotationTurns: this.contextLimits.rotationTurns,
      ...(this.contextLimits.inputWindowTokens === undefined ? {} : {
        inputWindowTokens: this.contextLimits.inputWindowTokens,
        piCompactionReserveTokens: this.contextLimits.piCompactionReserveTokens,
      }),
      modelPattern: this.contextLimits.modelPattern,
      retainTurns: this.config.retainTurns,
      rotations: this.rotations,
      rotationPending: this.forceRotation,
      lastRotationReason: this.lastRotationReason,
      lastRotationMode: this.lastRotationMode,
      effectiveRetainTurns: this.effectiveRetainTurns,
      compactionFallbackReason: this.compactionFallbackReason,
      ...(this.lastPreflightError === undefined ? {} : { preflightError: this.lastPreflightError }),
      ...(this.lastHintCleanupError === undefined
        ? {}
        : { hintCleanupError: this.lastHintCleanupError }),
      archivedDocuments: includeArchiveCount
        ? this.archive.count({
            sessionId: this.sessionId,
            sessionIds: [...this.sessionIds],
            project: this.project,
            scope: "session",
          })
        : undefined,
      ...(archiveStorage ? { archiveStorage } : {}),
      dbPath: this.config.archiveBackend === "rocksdb"
        ? this.config.rocksdbPath
        : this.config.dbPath,
    };
  }

  releaseArchiveProtectionOwner(ownerId) {
    this.archive.releaseProtectionOwner?.(ownerId);
  }

  close(options) {
    return this.archive.close(options);
  }

  rotationState() {
    return {
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      boundaryKey: this.boundaryKey,
      rotations: this.rotations,
      reason: this.lastRotationReason,
      mode: this.lastRotationMode,
      configuredRetainTurns: this.config.retainTurns,
      effectiveRetainTurns: this.effectiveRetainTurns,
      toc: this.toc.map((entry) => ({
        ...entry,
        terms: [...entry.terms],
        ...(entry.archiveIds ? { archiveIds: [...entry.archiveIds] } : {}),
      })),
      hintState: {
        version: HINT_STATE_VERSION,
        reconstructOnlyMessageKeys: [...this.reconstructOnlyHintMessageKeys]
          .slice(-MAX_RECONSTRUCT_ONLY_HINT_KEYS),
      },
      archivedAt: Date.now(),
    };
  }

  storeToolResult(message, text) {
    const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
    const id = toolResultId(this.sessionId, message, text);
    const storedId = this.archive.put({
      id,
      sessionId: this.sessionId,
      project: this.project,
      kind: "tool-result",
      text,
      createdAt: Number(message.timestamp) || Date.now(),
      metadata: {
        toolCallId,
        toolName: message.toolName ?? message.name,
        sourceMessageKey: messageKey(message),
      },
    }, { deferPrune: true, protect: true });
    if (storedId) {
      this.activeArchiveIds.add(storedId);
      this.refreshArchiveProtection();
    }
    return storedId;
  }

  storeToolArgument(message, part, text) {
    const toolCallId = String(part.id ?? part.toolCallId ?? part.tool_call_id ?? "");
    const id = toolArgumentId(this.sessionId, part, text);
    const storedId = this.archive.put({
      id,
      sessionId: this.sessionId,
      project: this.project,
      kind: "tool-argument",
      text,
      createdAt: Number(message.timestamp) || Date.now(),
      metadata: {
        toolCallId,
        toolName: part.name ?? part.toolName,
        sourceMessageKey: messageKey(message),
      },
    }, { deferPrune: true, protect: true });
    if (storedId) {
      this.activeArchiveIds.add(storedId);
      this.refreshArchiveProtection();
    }
    return storedId;
  }

  externalizeOversizedUsers(messages) {
    const configuredLimit = Number(this.config.maxInlineUserTokens);
    const maxInlineTokens = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 16_000;
    let changed = false;
    const archiveIds = new Set();
    const providerMessageKeys = new Set();
    const output = [];

    for (const message of messages) {
      if (message?.role !== "user" || inlineUserTokens(message) <= maxInlineTokens) {
        output.push(message);
        continue;
      }

      try {
        const text = serializeMessage(message);
        const sourceKey = messageKey(message);
        const source = {
          text,
          sourceKey,
          sourceMessageKeys: [sourceKey],
          kind: "oversized-user",
          createdAt: checkpointCreatedAt([message]),
          topic: turnTopic([message]),
          terms: extractSalientTerms(text),
        };
        const baseProviderMessage = replaceProviderText(message, "");
        let previewTokens = Math.min(
          ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
          maxInlineTokens - inlineUserTokens(baseProviderMessage),
        );
        let planned;
        let providerMessage;

        while (previewTokens > 0) {
          const request = {
            sessionId: this.sessionId,
            project: this.project,
            sources: [source],
            createdAt: source.createdAt,
            previewSourceIndex: 0,
            previewTokens,
            catalogTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
          };
          const candidate = createArchiveCheckpoint({
            archive: checkpointPlanningArchive(this.archive),
            ...request,
          });
          if (candidate.status !== "stored"
            || normalizedArchiveEntries(candidate.roots) === undefined) break;
          const candidateMessage = replaceProviderText(message, candidate.preview);
          const overflow = inlineUserTokens(candidateMessage) - maxInlineTokens;
          if (overflow <= 0) {
            planned = candidate;
            providerMessage = candidateMessage;
            break;
          }
          previewTokens -= Math.max(1, overflow + 4);
        }

        if (!planned || !providerMessage) throw new OversizedInputArchiveError();
        const stored = createArchiveCheckpoint({
          archive: this.archive,
          sessionId: this.sessionId,
          project: this.project,
          sources: [source],
          createdAt: source.createdAt,
          previewSourceIndex: 0,
          previewTokens,
          catalogTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
        });
        if (!checkpointResultMatches(planned, stored)) {
          throw new OversizedInputArchiveError();
        }
        for (const id of checkpointIds(stored.roots)) archiveIds.add(id);
        providerMessageKeys.add(messageKey(providerMessage));
        output.push(providerMessage);
        changed = true;
      } catch {
        throw new OversizedInputArchiveError();
      }
    }

    return {
      messages: changed ? output : messages,
      archiveIds: [...archiveIds],
      providerMessageKeys,
    };
  }

  archiveTurns(messages) {
    const stagedToc = [];
    const previousActiveArchiveIds = new Set(this.activeArchiveIds);
    const configuredLimit = Number(this.config.maxInlineUserTokens);
    const maxInlineTokens = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 16_000;
    try {
      for (const turn of groupCompleteTurns(messages)) {
        // One tool-heavy user turn can contain more source messages than the
        // archive wire contract permits on a single document. Segment it by
        // the same exact-provenance bounds used for compaction checkpoints.
        for (const turnMessages of checkpointSourceChunks(turn.messages)) {
          const text = serializeMessages(turnMessages);
          if (!text.trim()) continue;
          const sourceMessageKeys = turnMessages.map((message) => messageKey(message));
          const first = turnMessages[0];
          const requiresCheckpoint = turnMessages.some((message) =>
            message?.role === "user" && inlineUserTokens(message) > maxInlineTokens);
          let id;
          let topic;
          let terms;
          let archiveIds;
          if (requiresCheckpoint) {
            const source = {
              text,
              sourceKey: sourceMessageKeys[0]
                ?? checkpointSourceKey("rotated-turn", turnMessages, text),
              sourceMessageKeys,
              kind: turn.hasUser ? "turn" : "preamble",
              createdAt: checkpointCreatedAt(turnMessages),
              topic: turnTopic(turn.messages),
              terms: extractSalientTerms(text),
            };
            const request = {
              sessionId: this.sessionId,
              project: this.project,
              sources: [source],
              createdAt: source.createdAt,
              previewSourceIndex: 0,
              previewTokens: ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
              catalogTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
            };
            const planned = createArchiveCheckpoint({
              archive: checkpointPlanningArchive(this.archive),
              ...request,
            });
            const plannedEntries = planned.status === "stored"
              ? normalizedArchiveEntries(planned.roots)
              : undefined;
            if (plannedEntries === undefined || plannedEntries.length !== 1
              || checkpointIds(plannedEntries).size > MAX_TOC_CHECKPOINT_IDS_PER_ENTRY) {
              throw new Error("Context archive capacity prevented storing a rotated turn.");
            }
            const stored = createArchiveCheckpoint({ archive: this.archive, ...request });
            if (!checkpointResultMatches(planned, stored)) {
              throw new Error("Context archive capacity prevented storing a rotated turn.");
            }
            const [root] = stored.roots;
            id = root.rootId;
            topic = root.topic;
            terms = [...root.terms];
            archiveIds = [...checkpointIds(stored.roots)];
            for (const checkpointId of archiveIds) this.activeArchiveIds.add(checkpointId);
            this.refreshArchiveProtection();
          } else {
            id = this.archive.put({
              sessionId: this.sessionId,
              project: this.project,
              kind: turn.hasUser ? "turn" : "preamble",
              text,
              createdAt: Number(first?.timestamp) || Date.now(),
              metadata: {
                // Keep the original fields for consumers that already read them.
                startKey: sourceMessageKeys[0],
                messageCount: sourceMessageKeys.length,
                sourceMessageKeys,
                sourceFirstKey: sourceMessageKeys[0],
                sourceLastKey: sourceMessageKeys.at(-1),
                sourceMessageCount: sourceMessageKeys.length,
              },
            }, {
              deferPrune: true,
              protect: true,
              structuralMessages: structuralMessages(turnMessages),
            });
            if (!id) {
              throw new Error("Context archive capacity prevented storing a rotated turn.");
            }
            topic = turnTopic(turn.messages);
            terms = extractSalientTerms(text);
          }
          stagedToc.push({
            id,
            topic,
            terms,
            ...(archiveIds ? { archiveIds } : {}),
          });
          // Verbatim decision-shaped sentences become separately searchable
          // records. Additive: the raw turn stays archived either way, so a
          // missed extraction degrades to the status quo.
          for (const sentence of extractDecisionCandidates(text)) {
            this.archive.put({
              sessionId: this.sessionId,
              project: this.project,
              kind: "decision-candidate",
              text: sentence,
              createdAt: Number(first?.timestamp) || Date.now(),
              metadata: {
                sourceTurnId: id,
                sourceMessageKeys,
                sourceFirstKey: sourceMessageKeys[0],
                sourceLastKey: sourceMessageKeys.at(-1),
                sourceMessageCount: sourceMessageKeys.length,
              },
            }, { deferPrune: true });
          }
        }
      }
    } catch (error) {
      this.activeArchiveIds = previousActiveArchiveIds;
      this.refreshArchiveProtection();
      this.archive.prune?.();
      throw error;
    }

    const previousToc = this.toc;
    this.toc = [...this.toc, ...stagedToc].slice(-TOC_MAX_ENTRIES);
    try {
      this.refreshArchiveProtection();
      this.archive.prune?.();
    } catch (error) {
      this.toc = previousToc;
      this.activeArchiveIds = previousActiveArchiveIds;
      try { this.refreshArchiveProtection(); } catch {}
      throw error;
    }
  }

  countUserTurns(messages) {
    return groupCompleteTurns(messages).filter((turn) => turn.hasUser).length;
  }
}
