import { createHash } from "node:crypto";
import { resolveModelConfig } from "./config.js";

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

  // Message estimation excludes the system prompt, tool schemas, provider framing,
  // and future output. Ratios reserve explicit headroom, while legacy absolute
  // settings remain optional caps when users have configured them.
  const ratioRotationLimit = Math.max(1, Math.floor(contextWindow * modelConfig.rotationContextRatio));
  const ratioHardLimit = Math.max(1, Math.floor(contextWindow * modelConfig.hardLimitContextRatio));
  const hardLimitTokens = config.hardLimitTokensExplicit === false
    ? ratioHardLimit
    : Math.min(config.hardLimitTokens, ratioHardLimit);
  const configuredRotationLimit = config.rotationTokensExplicit === false
    ? ratioRotationLimit
    : Math.min(config.rotationTokens, ratioRotationLimit);
  return {
    rotationTokens: Math.min(configuredRotationLimit, hardLimitTokens),
    hardLimitTokens,
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

export function externalizeLargeToolResults(messages, {
  maxTokens,
  store,
  previewTokens = Math.min(800, Math.floor(maxTokens / 2)),
} = {}) {
  const maxChars = Math.max(1, maxTokens) * 4;
  const previewChars = Math.max(1, previewTokens) * 4;
  let changed = false;
  const output = messages.map((message) => {
    const isToolResult = message?.role === "toolResult" || message?.role === "tool";
    if (!isToolResult) return message;
    const text = contentToText(message.content);
    if (text.length <= maxChars) return message;

    const id = store(message, text);
    const head = text.slice(0, Math.floor(previewChars * 0.7));
    const tail = text.slice(-Math.floor(previewChars * 0.3));
    const replacement = `${head}\n\n[… ${text.length - head.length - tail.length} characters archived as ${id}; use context_recall …]\n\n${tail}`;
    changed = true;
    return { ...message, content: replaceTextContent(message.content, replacement) };
  });
  return { messages: changed ? output : messages, changed };
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
const DECISION_CUE_PATTERN = new RegExp(
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
    if (!DECISION_CUE_PATTERN.test(sentence)) continue;
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    candidates.push(sentence);
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
