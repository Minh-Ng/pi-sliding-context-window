import { createHash } from "node:crypto";
import { resolveModelConfig } from "../config.js";
import { extractExactAnchors } from "../rocksdb/index/exact.js";

// Matches Pi's provider-neutral image proxy. Actual image tokenization varies
// by provider and dimensions; provider-reported usage remains authoritative.
export const ESTIMATED_IMAGE_CHARS = 4_800;

function shortDigest(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function base64ByteLength(data) {
  const value = String(data ?? "").replace(/\s/g, "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function nonTextContentMarker(part) {
  if (part?.type === "image") {
    const data = String(part.data ?? "");
    const mimeType = String(part.mimeType ?? "application/octet-stream");
    return `[image mimeType=${JSON.stringify(mimeType)} bytes=${base64ByteLength(data)} sha256=${shortDigest(data)}]`;
  }
  let serialized;
  try {
    serialized = JSON.stringify(part) ?? String(part);
  } catch {
    serialized = String(part);
  }
  return `[content type=${JSON.stringify(String(part?.type ?? "unknown"))} chars=${serialized.length} sha256=${shortDigest(serialized)}]`;
}

function contentPartToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (part.type === "toolCall" || part.type === "tool_call") {
    return `[tool ${part.name ?? "unknown"} ${JSON.stringify(part.arguments ?? part.input ?? {})}]`;
  }
  if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
  return nonTextContentMarker(part);
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map(contentPartToText).filter(Boolean).join("\n");
}

function estimatedContentCharacters(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let characters = 0;
  let renderedParts = 0;
  for (const part of content) {
    let partCharacters = 0;
    if (part && typeof part === "object" && part.type === "image") {
      partCharacters = ESTIMATED_IMAGE_CHARS;
    } else {
      partCharacters = contentPartToText(part).length;
    }
    if (partCharacters === 0) continue;
    characters += partCharacters;
    renderedParts += 1;
  }
  return characters + Math.max(0, renderedParts - 1);
}

function estimatedMessageCharacters(message) {
  const role = String(message?.role ?? "unknown");
  const synthetic = syntheticMessageSerialization(message, role);
  if (synthetic !== undefined) return synthetic.length;
  const label = role === "toolResult" || role === "tool"
    ? `${role}:${message?.toolName ?? message?.name ?? "unknown"}`
    : role;
  return label.length + 3 + estimatedContentCharacters(message?.content);
}

/**
 * Per-message token estimate using the identical character accounting
 * estimateTokens sums over an array. A component breakdown built from this
 * shares its arithmetic with the aggregate footer number; only the inter-
 * message join separator (len - 1 characters, folded into estimateTokens'
 * array path) and independent per-group rounding are not reflected here, so
 * a breakdown's total may differ from the aggregate by a few tokens.
 */
export function estimateMessageTokens(message) {
  return Math.ceil(estimatedMessageCharacters(message) / 4);
}

export function estimateTokens(value) {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    const characters = value.reduce((sum, message) => sum + estimatedMessageCharacters(message), 0)
      + Math.max(0, value.length - 1);
    return Math.ceil(characters / 4);
  }
  return Math.ceil(JSON.stringify(value).length / 4);
}

function messageKeyWithSerialization(message, serialized) {
  const role = String(message?.role ?? "unknown");
  const timestamp = String(message?.timestamp ?? "");
  const toolCallId = String(message?.toolCallId ?? message?.tool_call_id ?? "");
  const digest = createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 12);
  return `${role}:${timestamp}:${toolCallId}:${digest}`;
}

export function messageKey(message) {
  return messageKeyWithSerialization(message, serializeMessage(message));
}

// Used only to match rotation state persisted before message keys hashed the
// complete serialization. New state and provenance must always use messageKey.
function legacyBoundaryMessageKey(message) {
  return messageKeyWithSerialization(message, serializeMessage(message).slice(0, 8_000));
}

function legacyTextOnlyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "toolCall" || part.type === "tool_call") {
      return `[tool ${part.name ?? "unknown"} ${JSON.stringify(part.arguments ?? part.input ?? {})}]`;
    }
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
    return "";
  }).filter(Boolean).join("\n");
}

function preMultimodalSerialization(message) {
  const role = String(message?.role ?? "unknown");
  const synthetic = syntheticMessageSerialization(message, role);
  if (synthetic !== undefined) return synthetic;
  const label = role === "toolResult" || role === "tool"
    ? `${role}:${message?.toolName ?? message?.name ?? "unknown"}`
    : role;
  return `[${label}] ${legacyTextOnlyContent(message?.content)}`;
}

function preMultimodalMessageKey(message, truncate = false) {
  const serialized = preMultimodalSerialization(message);
  return messageKeyWithSerialization(message, truncate ? serialized.slice(0, 8_000) : serialized);
}

function syntheticMessageSerialization(message, role) {
  if (role === "bashExecution") {
    const state = {
      exitCode: message?.exitCode ?? null,
      cancelled: message?.cancelled === true,
      truncated: message?.truncated === true,
      fullOutputPath: message?.fullOutputPath ?? null,
      excludeFromContext: message?.excludeFromContext === true,
    };
    return `[bashExecution ${JSON.stringify(state)}]\n[command] ${String(message?.command ?? "")}\n[output] ${String(message?.output ?? "")}`;
  }
  if (role === "compactionSummary") {
    return `[compactionSummary tokensBefore=${Number(message?.tokensBefore) || 0}] ${String(message?.summary ?? "")}`;
  }
  if (role === "branchSummary") {
    return `[branchSummary fromId=${JSON.stringify(String(message?.fromId ?? ""))}] ${String(message?.summary ?? "")}`;
  }
  return undefined;
}

export function serializeMessage(message) {
  const role = String(message?.role ?? "unknown");
  const synthetic = syntheticMessageSerialization(message, role);
  if (synthetic !== undefined) return synthetic;
  const label = role === "toolResult" || role === "tool"
    ? `${role}:${message?.toolName ?? message?.name ?? "unknown"}`
    : role;
  return `[${label}] ${contentToText(message?.content)}`;
}

export function serializeMessages(messages) {
  return messages.map(serializeMessage).join("\n\n");
}

export function removeEmptyAssistantErrors(messages) {
  let changed = false;
  const filtered = messages.filter((message) => {
    const shouldRemove = message?.role === "assistant"
      && message?.stopReason === "error"
      && contentToText(message.content).trim() === "";
    changed ||= shouldRemove;
    return !shouldRemove;
  });
  return changed ? filtered : messages;
}

export function groupCompleteTurns(messages) {
  const starts = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === "user") starts.push(index);
  }
  if (starts.length === 0) {
    return messages.length ? [{ start: 0, end: messages.length, messages: [...messages], hasUser: false }] : [];
  }

  const turns = [];
  if (starts[0] > 0) {
    turns.push({ start: 0, end: starts[0], messages: messages.slice(0, starts[0]), hasUser: false });
  }
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = starts[index + 1] ?? messages.length;
    turns.push({ start, end, messages: messages.slice(start, end), hasUser: true });
  }
  return turns;
}

export function findRetainedStart(messages, retainTurns) {
  const userTurns = groupCompleteTurns(messages).filter((turn) => turn.hasUser);
  if (userTurns.length <= retainTurns) return 0;
  return userTurns[userTurns.length - retainTurns].start;
}

function rotationTrigger({ force, tokens, turns, rotationTokens, rotationTurns }) {
  if (force) return "forced";
  if (tokens >= rotationTokens) return "tokens";
  if (turns >= rotationTurns) return "turns";
  return undefined;
}

/**
 * Plan a complete-turn epoch rotation without mutating source messages.
 * Mid-turn cuts are intentionally not represented: when no complete user-turn
 * suffix fits, Pi native compaction is the only safe fallback.
 */
export function planEpochRotation(messages, {
  force = false,
  tokens = estimateTokens(messages),
  turns = groupCompleteTurns(messages).filter((turn) => turn.hasUser).length,
  rotationTokens,
  rotationTurns,
  retainTurns,
  markerTokenReserve = TOC_TOKEN_BUDGET,
  observedContextTokens,
  hardLimitTokens,
} = {}) {
  const trigger = rotationTrigger({ force, tokens, turns, rotationTokens, rotationTurns });
  if (!trigger) return { action: "none", reason: "below-threshold" };

  const observed = Number(observedContextTokens);
  const hardLimit = Number(hardLimitTokens);
  if (Number.isFinite(observed) && Number.isFinite(hardLimit) && observed >= hardLimit) {
    return {
      action: "native-compaction",
      trigger,
      reason: "provider-hard-limit",
      observedContextTokens: observed,
    };
  }

  const userTurns = groupCompleteTurns(messages).filter((turn) => turn.hasUser);
  if (userTurns.length < 2) {
    return { action: "native-compaction", trigger, reason: "no-user-boundary" };
  }

  const configuredRetainTurns = Math.max(1, Number.isSafeInteger(retainTurns) ? retainTurns : 1);
  const reserve = Math.max(0, Number.isFinite(markerTokenReserve) ? markerTokenReserve : TOC_TOKEN_BUDGET);
  const target = Math.max(1, Number.isFinite(rotationTokens) ? rotationTokens : 1);
  let newestCandidate;

  // Oldest to newest chooses the largest recent suffix that satisfies both the
  // configured retention ceiling and token target.
  for (let index = 1; index < userTurns.length; index++) {
    const candidate = userTurns[index];
    const retainedTurns = userTurns.length - index;
    if (retainedTurns > configuredRetainTurns) continue;
    const estimatedTokens = estimateTokens(messages.slice(candidate.start)) + reserve;
    newestCandidate = { start: candidate.start, retainedTurns, estimatedTokens };
    if (estimatedTokens > target) continue;
    return {
      action: "rotate",
      trigger,
      mode: retainedTurns === configuredRetainTurns ? "normal" : "emergency-retention",
      start: candidate.start,
      retainedTurns,
      configuredRetainTurns,
      estimatedTokens,
      markerTokenReserve: reserve,
    };
  }

  return {
    action: "native-compaction",
    trigger,
    reason: "oversized-latest-turn",
    newestCandidate,
  };
}

export function resolveContextLimits(config, model) {
  const modelConfig = resolveModelConfig(config, model);
  const contextWindow = Number(model?.contextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return {
      rotationTokens: config.rotationTokens,
      hardLimitTokens: config.hardLimitTokens,
      rotationTurns: modelConfig.rotationTurns,
      modelPattern: modelConfig.pattern,
    };
  }

  // Adaptive ratios apply to the host's usable input budget, not the model's
  // combined input+output context window. Prefer Pi's configured compaction
  // reserve; model.maxTokens is a conservative fallback when host settings are
  // unavailable. Legacy absolute settings remain optional caps.
  const configuredReserve = Number(config.piCompactionReserveTokens);
  const modelOutputLimit = Number(model?.maxTokens);
  const hasConfiguredReserve = Number.isSafeInteger(configuredReserve) && configuredReserve >= 0;
  const hasModelOutputLimit = Number.isSafeInteger(modelOutputLimit) && modelOutputLimit > 0;
  const reserveTokens = hasConfiguredReserve
    ? configuredReserve
    : hasModelOutputLimit
      ? modelOutputLimit
      : 0;
  const reserveKnown = hasConfiguredReserve || hasModelOutputLimit;
  const inputWindow = Math.max(0, contextWindow - reserveTokens);
  const ratioRotationLimit = Math.max(1, Math.floor(inputWindow * modelConfig.rotationContextRatio));
  const ratioHardLimit = Math.max(1, Math.floor(inputWindow * modelConfig.hardLimitContextRatio));
  const hardLimitTokens = config.hardLimitTokensExplicit === false
    ? ratioHardLimit
    : Math.min(config.hardLimitTokens, ratioHardLimit);
  const configuredRotationLimit = config.rotationTokensExplicit === false
    ? ratioRotationLimit
    : Math.min(config.rotationTokens, ratioRotationLimit);
  return {
    rotationTokens: Math.min(configuredRotationLimit, hardLimitTokens),
    hardLimitTokens,
    ...(reserveKnown ? {
      inputWindowTokens: inputWindow,
      piCompactionReserveTokens: reserveTokens,
    } : {}),
    rotationTurns: modelConfig.rotationTurns,
    modelPattern: modelConfig.pattern,
  };
}

export function shouldRotateWindow({ force = false, tokens, turns, rotationTokens, rotationTurns }) {
  return force || tokens >= rotationTokens || turns >= rotationTurns;
}

function replaceTextContent(content, replacement) {
  if (typeof content === "string") return replacement;
  if (!Array.isArray(content)) return replacement;
  const nonText = content.filter((part) => !(part && typeof part === "object" && part.type === "text"));
  return [{ type: "text", text: replacement }, ...nonText];
}

/**
 * Externalize tool results that exceed the per-result token gate, with an
 * optional cumulative epoch budget layered on top.
 *
 * The per-result gate (`maxTokens`) alone lets a long run of individually
 * moderate results (1-3K each) dominate the window in aggregate. When
 * `budgetTokens` and `floorTokens` are supplied, this walks results in order
 * and tracks the tool-result characters admitted so far (both whole results
 * kept inline and the bounded previews of externalized ones — every character
 * that lands in the window counts). Once that running total reaches the budget,
 * NEW results are gated at the lower `floorTokens` threshold instead of
 * `maxTokens`. `floorThroughIndex` applies that lower gate to a retained
 * rotation prefix; rotation has already broken the provider prompt prefix, so
 * this can rebalance carry-over results without rewriting an active epoch.
 * `protectedMessageIndexes` preserves deduplication markers that already point
 * at an exact archived result instead of nesting one archive reference in another.
 *
 * Forward-only by construction: each result's decision depends only on the
 * characters admitted by results BEFORE it — a strictly append-only prefix
 * within an epoch — so an already-exposed result is never re-externalized on a
 * later pass, preserving the provider prompt cache. The running total is not
 * persisted: it is recomputed from the same filtered prefix on every pass.
 * Rotation persists only the carry-over cutoff, allowing resume to reproduce
 * the rebalanced prefix while later results keep normal forward-only gating.
 */
export function externalizeLargeToolResults(messages, {
  maxTokens,
  store,
  previewTokens = Math.min(800, Math.floor(maxTokens / 2)),
  budgetTokens,
  floorTokens,
  floorThroughIndex = -1,
  protectedMessageIndexes = new Set(),
} = {}) {
  const maxChars = Math.max(1, maxTokens) * 4;
  const previewChars = Math.max(1, previewTokens) * 4;
  const hasBudget = Number.isFinite(budgetTokens) && budgetTokens > 0
    && Number.isFinite(floorTokens) && floorTokens > 0;
  const budgetChars = hasBudget ? Math.max(1, Math.floor(budgetTokens)) * 4 : Infinity;
  // The floor only ever lowers the gate; a misconfigured floor above the base
  // threshold is clamped so the adaptive path can never admit more than the
  // static per-result gate would.
  const floorChars = hasBudget ? Math.min(maxChars, Math.max(1, Math.floor(floorTokens)) * 4) : maxChars;
  let admittedChars = 0;
  let changed = false;
  const archiveIds = [];
  const output = messages.map((message, messageIndex) => {
    const isToolResult = message?.role === "toolResult" || message?.role === "tool";
    if (!isToolResult) return message;
    const text = contentToText(message.content);
    if (protectedMessageIndexes.has(messageIndex)) {
      admittedChars += text.length;
      return message;
    }
    const shouldUseFloor = messageIndex <= floorThroughIndex || admittedChars >= budgetChars;
    const effectiveMaxChars = shouldUseFloor ? floorChars : maxChars;
    if (text.length <= effectiveMaxChars) {
      admittedChars += text.length;
      return message;
    }

    const id = store(message, text);
    if (!id) {
      // Archival failed, so the whole result stays inline and still consumes
      // window space; count it so the budget reflects real admitted tokens.
      admittedChars += text.length;
      return message;
    }
    archiveIds.push(id);
    // Account for the archive marker itself so the complete replacement, not
    // only its head/tail payload, stays within the gate that admitted it.
    const markerFor = (omittedChars) =>
      `\n\n[… ${omittedChars} characters archived as ${id}; use context_recall …]\n\n`;
    let retainedPreviewChars = Math.min(previewChars, effectiveMaxChars);
    let replacement;
    while (true) {
      const headChars = Math.floor(retainedPreviewChars * 0.7);
      const tailChars = Math.floor(retainedPreviewChars * 0.3);
      const head = text.slice(0, headChars);
      const tail = tailChars > 0 ? text.slice(-tailChars) : "";
      const marker = markerFor(text.length - head.length - tail.length);
      replacement = `${head}${marker}${tail}`;
      if (replacement.length <= effectiveMaxChars || retainedPreviewChars === 0) break;
      retainedPreviewChars = Math.max(
        0,
        retainedPreviewChars - Math.max(1, replacement.length - effectiveMaxChars),
      );
    }
    admittedChars += replacement.length;
    changed = true;
    return { ...message, content: replaceTextContent(message.content, replacement) };
  });
  return {
    messages: changed ? output : messages,
    changed,
    archiveIds,
    admittedTokens: Math.ceil(admittedChars / 4),
    ...(hasBudget ? { overBudget: admittedChars >= budgetChars, budgetTokens: Math.floor(budgetTokens) } : {}),
  };
}

function toolCallArgumentField(part) {
  return part?.arguments !== undefined ? "arguments" : "input";
}

export function stringifyToolCallArguments(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Externalize oversized tool-call arguments symmetrically with
 * externalizeLargeToolResults: the assistant's toolCall part's
 * arguments/input field is replaced with an object carrying the archive id
 * and a bounded head/tail preview (`{ archivedAs, preview }`), and the
 * archived text is handed to `store` exactly as issued. Unlike tool results,
 * whose content is text, tool_use/toolCall input must remain a JSON object
 * for every provider (Anthropic tool_use.input, Bedrock Converse
 * toolUse.input, Gemini functionCall.args), so the replacement stays
 * object-shaped rather than becoming a bare string. This only rewrites the
 * provider-facing transcript already produced after the tool executed; the
 * historical call itself (and any live dispatch, which reads from the host's
 * own message state, not this filtered copy) is never mutated.
 */
export function externalizeLargeToolArguments(messages, {
  maxTokens,
  store,
  previewTokens = Math.min(800, Math.floor(maxTokens / 2)),
} = {}) {
  const maxChars = Math.max(1, maxTokens) * 4;
  const previewChars = Math.max(1, previewTokens) * 4;
  let changed = false;
  const archiveIds = [];
  const output = messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const nextContent = message.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type !== "toolCall" && part.type !== "tool_call") return part;
      const field = toolCallArgumentField(part);
      const value = part[field];
      if (value === undefined) return part;
      const text = stringifyToolCallArguments(value);
      if (text.length <= maxChars) return part;

      const id = store(message, part, text);
      if (!id) return part;
      archiveIds.push(id);
      const head = text.slice(0, Math.floor(previewChars * 0.7));
      const tail = text.slice(-Math.floor(previewChars * 0.3));
      const preview = `${head}\n\n[… ${text.length - head.length - tail.length} characters archived as ${id}; use context_recall …]\n\n${tail}`;
      messageChanged = true;
      // Providers require tool_use/toolCall input to be a JSON object
      // (Anthropic tool_use.input, Bedrock Converse toolUse.input, Gemini
      // functionCall.args), so the externalized field must stay object-shaped
      // rather than becoming a bare preview string.
      return { ...part, [field]: { archivedAs: id, preview } };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content: nextContent };
  });
  return { messages: changed ? output : messages, changed, archiveIds };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Key ordering must never change the dedup decision, so arguments are
// serialized with sorted object keys rather than reusing the issued-order
// stringification used for the externalized-argument preview.
function normalizedToolArguments(value) {
  if (value === undefined) return "";
  try {
    return canonicalJsonValue(value);
  } catch {
    return stringifyToolCallArguments(value);
  }
}

function toolCallArgumentsIndex(messages) {
  const byCallId = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type !== "toolCall" && part.type !== "tool_call") continue;
      const id = String(part.id ?? part.toolCallId ?? part.tool_call_id ?? "");
      if (!id) continue;
      byCallId.set(id, normalizedToolArguments(part[toolCallArgumentField(part)]));
    }
  }
  return byCallId;
}

/**
 * Suppress duplicate tool results within the active epoch: forward-only,
 * comparing (tool name + normalized call arguments + exact content hash)
 * against results already admitted earlier in this same pass. On an exact
 * match, the NEW occurrence is externalized regardless of size — its raw
 * text is archived via `store` exactly as issued, and a short marker
 * ("identical to earlier result <ref>, archived as <id>") replaces it. A
 * near-match (any single byte different) is never touched.
 *
 * The earlier occurrence is never rewritten — only later duplicates are
 * ever replaced — so this stays append-only and preserves the provider
 * prompt cache exactly like externalizeLargeToolResults.
 *
 * The comparison map is local to this call and derived only from the
 * `messages` passed in; it is not persisted. That makes it reconstruct
 * deterministically on resume (recomputed from the same boundary-filtered
 * active slice every pass) and reset naturally at rotation (the active
 * slice starts over from the new, shorter boundary).
 */
export function deduplicateToolResults(messages, { store } = {}) {
  const callArguments = toolCallArgumentsIndex(messages);
  const seen = new Map();
  let changed = false;
  const archiveIds = [];
  const externalizedMessageIndexes = [];
  const output = messages.map((message, messageIndex) => {
    const isToolResult = message?.role === "toolResult" || message?.role === "tool";
    if (!isToolResult) return message;
    const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
    const toolName = String(message.toolName ?? message.name ?? "");
    const normalizedArguments = callArguments.get(toolCallId) ?? "";
    const text = contentToText(message.content);
    const digest = createHash("sha256").update(text).digest("hex");
    const key = `${toolName}\0${normalizedArguments}\0${digest}`;
    const earlier = seen.get(key);
    if (earlier === undefined) {
      seen.set(key, { ref: toolCallId || messageKey(message) });
      return message;
    }

    const id = store(message, text);
    if (!id) {
      // Archival failed; leave the duplicate inline rather than lose content.
      return message;
    }
    archiveIds.push(id);
    externalizedMessageIndexes.push(messageIndex);
    changed = true;
    const marker = `[Identical to earlier result ${earlier.ref} in this conversation, archived as ${id}; use context_recall on ${id} if needed.]`;
    return { ...message, content: replaceTextContent(message.content, marker) };
  });
  return {
    messages: changed ? output : messages,
    changed,
    archiveIds,
    externalizedMessageIndexes,
  };
}

export const TOC_TERMS_PER_ENTRY = 8;
export const TOC_TOPIC_CHARS = 80;
export const TOC_TOKEN_BUDGET = 1_000;

export const TOC_MARKER_HEADER =
  "[Context index — older turns were rotated out of the window. Each line is an archive id, the turn topic, and named referents from that turn. If a term below matches something you need, run context_window_search on it or context_recall on the id.]";

// Ordered by precision: explicit quoting first, then structured identifiers.
const SALIENT_TERM_PATTERNS = [
  /`([^`\n]{2,60})`/g, // backtick-quoted spans
  /(?<![\w./-])[\w.-]+\/[\w./-]+(?![\w./-])/g, // path-like tokens
  /\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b/g, // dotted identifiers
  /\b[a-z][a-z0-9]*(?:[A-Z]\w*)+\b/g, // camelCase
  /\b[a-zA-Z]\w*_\w+\b/g, // snake_case
];

export function extractSalientTerms(text, limit = TOC_TERMS_PER_ENTRY) {
  const source = String(text ?? "");
  const terms = [];
  const seen = new Set();
  for (const pattern of SALIENT_TERM_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const term = (match[1] ?? match[0]).trim();
      if (term.length < 3 || term.length > 60) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      // Patterns run precision-first, so a later, looser match that is a
      // fragment of an existing term ("config.js" inside "src/config.js")
      // adds noise without adding a new referent.
      if (terms.some((existing) => existing.toLowerCase().includes(key))) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length >= limit) return terms;
    }
  }
  return terms;
}

export function turnTopic(messages, maxChars = TOC_TOPIC_CHARS) {
  const firstUser = messages.find((message) => message?.role === "user");
  const text = contentToText(firstUser?.content ?? "").trim();
  const line = (text.split("\n", 1)[0] ?? "").trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

export function buildTocMarkerText(entries, tokenBudget = TOC_TOKEN_BUDGET) {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const render = (kept) => [TOC_MARKER_HEADER, ...kept.map((entry) => {
    const topic = entry.topic ? ` "${entry.topic}"` : "";
    const terms = entry.terms?.length ? ` — ${entry.terms.join(", ")}` : "";
    return `- ${entry.id}${topic}${terms}`;
  })].join("\n");
  // Drop oldest entries first: recent referents are the likeliest recall targets.
  let kept = entries;
  let text = render(kept);
  while (kept.length > 1 && estimateTokens(text) > tokenBudget) {
    kept = kept.slice(1);
    text = render(kept);
  }
  return text;
}

export const DECISION_CANDIDATE_MAX_PER_TURN = 5;
export const DECISION_CANDIDATE_MAX_CHARS = 300;

// Lexical cues for decision-shaped sentences. Matching is deliberately
// verbatim-quoting: a heuristic cannot hallucinate a decision that was never
// made, only quote a sentence that looks like one. Recall is allowed to be
// moderate because raw turns remain archived and searchable regardless.
// Exported so other deterministic evidence machinery (e.g. gather.js's
// possibly-conflicting-evidence flagging, ultracode task #37) can reuse this
// exact lexicon instead of re-deriving its own.
export const DECISION_CUE_PATTERN = new RegExp(
  "\\b(?:"
  + [
    "decided?", "agreed?", "settl(?:ed?|ing) on", "let'?s go with",
    "we(?:'ll| will) (?:use|go with|keep|skip)", "going with", "opt(?:ed)? for",
    "chose", "chosen", "instead of", "rather than", "reject(?:ed|ing)?",
    "rul(?:ed?|ing) out", "won'?t (?:use|do|support|need)", "will not",
    "out of scope", "deferr?(?:ed|ing)?",
  ].join("|")
  + ")\\b",
  "i",
);

/**
 * Extract verbatim decision-shaped sentences from serialized turn text.
 * Returns exact spans (trimmed only), never paraphrases.
 */
export function extractDecisionCandidates(text, {
  maxCandidates = DECISION_CANDIDATE_MAX_PER_TURN,
  maxChars = DECISION_CANDIDATE_MAX_CHARS,
} = {}) {
  const source = String(text ?? "");
  const candidates = [];
  const seen = new Set();
  for (const raw of source.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < 15 || sentence.length > maxChars) continue;
    // A question can mention a past choice without asserting what was chosen.
    // Keep it in the raw archived turn, but do not grant it decision-specific
    // indexing or ranking weight.
    if (sentence.endsWith("?")) continue;
    if (!DECISION_CUE_PATTERN.test(sentence)) continue;
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    candidates.push(sentence);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

// Lexical cues for a fact-shaped sentence: an explicit binding between a
// stated value and its meaning ("retention is 90 days", "the socket lives
// in /tmp/app.sock", "use node v20.11.0"). "is" and "uses" alone are far too
// common to gate extraction by themselves, so this cue set is only ever
// tested together with the typed-anchor requirement in
// extractFactCandidates below -- a common word plus an untyped span of text
// is not enough on its own.
export const FACT_CUE_PATTERN = new RegExp(
  "\\b(?:"
  + [
    "is", "uses?", "set to", "defaults? to", "lives? in", "named",
  ].join("|")
  + ")\\b",
  "i",
);

// Anchor types from exact.js's classifier (classifyExactValue/
// extractExactAnchors) that name a fact-shaped value rather than a code
// referent. "value" covers dotted versions and k=v pairs (its
// VERSION_OR_VALUE branch) as well as hyphenated tokens; "path" and "url"
// cover the location-shaped values the task also calls out (a config file,
// a socket, an endpoint). Identifier-shaped anchors that exact.js also
// types -- symbol, dotted-name, commit, error, quoted-value -- are
// deliberately excluded: they tend to name code referents already covered
// by decision-candidate extraction's cue set or by ordinary lexical search,
// not a stated configuration fact.
export const FACT_ANCHOR_TYPES = new Set(["value", "path", "url"]);

// Independent of DECISION_CANDIDATE_MAX_PER_TURN, not a shared budget.
// Decisions and facts are mined by disjoint cue sets over the same turn
// text; sharing one counter would let a decision-heavy turn crowd out fact
// extraction (or vice versa) even though each extractor's own regex/anchor
// scan is already separately bounded and cheap. Two independent per-turn
// ceilings of 5 keep the combined worst case at 10 archive.put calls per
// rotated turn -- still bounded, additive work.
export const FACT_CANDIDATE_MAX_PER_TURN = 5;
export const FACT_CANDIDATE_MAX_CHARS = DECISION_CANDIDATE_MAX_CHARS;

/**
 * Extract verbatim fact-shaped sentences from serialized turn text. A
 * sentence qualifies only when it contains BOTH a typed exact anchor
 * (FACT_ANCHOR_TYPES, via the same extractExactAnchors classifier exact.js's
 * index/search path uses) AND a binding cue (FACT_CUE_PATTERN) -- an anchor
 * with no binding cue, or a cue with no typed anchor, is not extracted (see
 * the negative-case test). Returns exact spans (trimmed only) paired with
 * the qualifying anchor exactly as the classifier reported it -- never
 * re-trimmed or otherwise touched -- so the metadata anchor always matches
 * byte-for-byte what the archived document's own exact-index posting will
 * contain (path/url anchors sitting at a sentence's end can include that
 * sentence's own terminal "."/"!"/"?", the same way they would for any other
 * archived document ending in one; that is exact.js's existing, shared
 * classification behavior, not something specific to fact candidates). Like
 * extractDecisionCandidates, this is additive: the raw turn stays archived
 * regardless, so a missed extraction only degrades to the status quo. No
 * subjectKey is assigned here -- these are candidates for the agent to
 * promote, not an automatically deduplicated record.
 */
export function extractFactCandidates(text, {
  maxCandidates = FACT_CANDIDATE_MAX_PER_TURN,
  maxChars = FACT_CANDIDATE_MAX_CHARS,
} = {}) {
  const source = String(text ?? "");
  const candidates = [];
  const seen = new Set();
  for (const raw of source.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < 15 || sentence.length > maxChars) continue;
    if (seen.has(sentence)) continue;
    // A question can't itself assert a bound fact, but "is" (a deliberately
    // included cue) also opens an interrogative ("Is the checkpoint
    // restart-safe?"); observed as a false positive against the eval
    // fixtures (ultracode task #39 notes), so interrogatives are excluded
    // outright rather than trying to enumerate every cue that can start one.
    if (sentence.endsWith("?")) continue;
    if (!FACT_CUE_PATTERN.test(sentence)) continue;
    let anchors;
    try {
      anchors = extractExactAnchors(sentence, { maxAnchors: 8 });
    } catch {
      // Malformed input (e.g. an unpaired surrogate from naive slicing) is
      // conservatively skipped rather than failing the whole rotation.
      continue;
    }
    const anchor = anchors.find((candidate) => FACT_ANCHOR_TYPES.has(candidate.type));
    if (!anchor) continue;
    seen.add(sentence);
    candidates.push({
      text: sentence,
      anchor: { type: anchor.type, value: anchor.value },
    });
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

export function sliceFromBoundary(messages, boundaryKey) {
  if (!boundaryKey) return { messages, found: true, start: 0 };
  const start = messages.findIndex((message) => messageKey(message) === boundaryKey
    || legacyBoundaryMessageKey(message) === boundaryKey
    || preMultimodalMessageKey(message) === boundaryKey
    || preMultimodalMessageKey(message, true) === boundaryKey);
  if (start < 0) return { messages, found: false, start: 0 };
  return { messages: messages.slice(start), found: true, start };
}
