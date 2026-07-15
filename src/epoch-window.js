import { createHash } from "node:crypto";
import {
  buildTocMarkerText,
  estimateTokens,
  extractDecisionCandidates,
  extractSalientTerms,
  externalizeLargeToolResults,
  groupCompleteTurns,
  messageKey,
  planEpochRotation,
  removeEmptyAssistantErrors,
  resolveContextLimits,
  serializeMessages,
  sliceFromBoundary,
  TOC_TOKEN_BUDGET,
  turnTopic,
} from "./window.js";

// Bounds persisted rotation-state growth; the marker text is separately
// bounded by the token budget in buildTocMarkerText.
export const TOC_MAX_ENTRIES = 64;

export const ROTATION_STATE_ENTRY = "context-epoch-window:rotation";

function toolResultId(sessionId, message, text) {
  const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
  return `tool-${createHash("sha256").update(`${sessionId}\0${toolCallId}\0${text}`).digest("hex").slice(0, 16)}`;
}

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
    this.rotations = 0;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.toc = [];
    this.contextLimits = resolveContextLimits(config, model);
  }

  restore(entries) {
    this.boundaryKey = undefined;
    this.rotations = 0;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.toc = [];
    // Search lineage is authoritative only when supplied from verified session headers.
    this.sessionIds = new Set([this.sessionId, ...this.initialSessionIds]);
    if (!Array.isArray(entries)) return;
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
          .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
          .map((entry) => ({
            id: entry.id,
            topic: typeof entry.topic === "string" ? entry.topic : "",
            terms: Array.isArray(entry.terms)
              ? entry.terms.filter((term) => typeof term === "string")
              : [],
          }))
          .slice(-TOC_MAX_ENTRIES);
      }
    }
  }

  process(messages, model) {
    this.contextLimits = resolveContextLimits(this.config, model);
    const contextMessages = removeEmptyAssistantErrors(messages);
    let sliced = sliceFromBoundary(contextMessages, this.boundaryKey);
    if (!sliced.found) {
      this.boundaryKey = undefined;
      sliced = { messages: contextMessages, found: true, start: 0 };
    }

    let active = sliced.messages;
    if (active.length === 0) {
      this.clearMeasurement();
      return active;
    }

    active = externalizeLargeToolResults(active, {
      maxTokens: this.config.maxToolResultTokens,
      store: (message, text) => this.storeToolResult(message, text),
    }).messages;

    // The marker occupies real window space, so it counts toward rotation
    // pressure; it is synthetic, so it never counts as a user turn.
    let marker = this.tocMarkerMessage();
    this.activeTokens = estimateTokens(marker ? [marker, ...active] : active);
    this.activeTurns = this.countUserTurns(active);
    if (this.activeTokens === 0 && this.activeTurns === 0) {
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
      this.archiveTurns(sliced.messages.slice(0, plan.start));
      this.boundaryKey = messageKey(sliced.messages[plan.start]);
      this.rotations += 1;
      this.lastRotationReason = plan.trigger;
      this.lastRotationMode = plan.mode;
      this.effectiveRetainTurns = plan.retainedTurns;
      this.compactionFallbackReason = undefined;
      this.onRotation(this.rotationState());
      active = active.slice(plan.start);
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

    this.activeTurns = this.countUserTurns(active);
    return marker ? [marker, ...active] : active;
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

  requestRotation() {
    this.forceRotation = true;
  }

  resetAfterCompaction() {
    this.boundaryKey = undefined;
    this.forceRotation = false;
    this.lastRotationReason = undefined;
    this.lastRotationMode = undefined;
    this.effectiveRetainTurns = undefined;
    this.compactionFallbackReason = undefined;
    this.toc = [];
    this.clearMeasurement();
    return this.rotationState();
  }

  clearMeasurement() {
    this.activeTokens = undefined;
    this.activeTurns = undefined;
  }

  shouldCancelCompaction(reason, observedContextTokens) {
    const observed = Number(observedContextTokens);
    return this.config.preventAutoCompaction
      && reason === "threshold"
      && this.activeTokens != null
      && this.activeTokens < this.contextLimits.hardLimitTokens
      && this.compactionFallbackReason == null
      // The character estimate excludes the system prompt, tool schemas, and
      // provider framing. Never suppress Pi's threshold compaction unless its
      // provider-aware pre-compaction measurement is also safely below the
      // hard limit. An absent measurement is unsafe, not permission to cancel.
      && Number.isFinite(observed)
      && observed >= 0
      && observed < this.contextLimits.hardLimitTokens;
  }

  search(query, options = {}) {
    return this.archive.search(query, {
      sessionId: this.sessionId,
      sessionIds: [...this.sessionIds],
      project: this.project,
      scope: options.scope ?? "session",
      limit: options.limit ?? this.config.searchResults,
    });
  }

  recall(id) {
    return this.archive.get(id);
  }

  status({ includeArchiveCount = true } = {}) {
    return {
      activeTokens: this.activeTokens,
      activeTurns: this.activeTurns,
      rotationTokens: this.contextLimits.rotationTokens,
      rotationTurns: this.contextLimits.rotationTurns,
      modelPattern: this.contextLimits.modelPattern,
      retainTurns: this.config.retainTurns,
      rotations: this.rotations,
      rotationPending: this.forceRotation,
      lastRotationReason: this.lastRotationReason,
      lastRotationMode: this.lastRotationMode,
      effectiveRetainTurns: this.effectiveRetainTurns,
      compactionFallbackReason: this.compactionFallbackReason,
      archivedDocuments: includeArchiveCount
        ? this.archive.count({
            sessionId: this.sessionId,
            sessionIds: [...this.sessionIds],
            project: this.project,
            scope: "session",
          })
        : undefined,
      dbPath: this.config.dbPath,
    };
  }

  close() {
    this.archive.close();
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
      toc: this.toc.map((entry) => ({ ...entry, terms: [...entry.terms] })),
      archivedAt: Date.now(),
    };
  }

  storeToolResult(message, text) {
    const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
    const id = toolResultId(this.sessionId, message, text);
    this.archive.put({
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
    });
    return id;
  }

  archiveTurns(messages) {
    for (const turn of groupCompleteTurns(messages)) {
      const text = serializeMessages(turn.messages);
      if (!text.trim()) continue;
      const sourceMessageKeys = turn.messages.map((message) => messageKey(message));
      const first = turn.messages[0];
      const id = this.archive.put({
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
      });
      if (id) {
        this.toc.push({
          id,
          topic: turnTopic(turn.messages),
          terms: extractSalientTerms(text),
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
          });
        }
      }
    }
    if (this.toc.length > TOC_MAX_ENTRIES) {
      this.toc = this.toc.slice(-TOC_MAX_ENTRIES);
    }
  }

  countUserTurns(messages) {
    return groupCompleteTurns(messages).filter((turn) => turn.hasUser).length;
  }
}
