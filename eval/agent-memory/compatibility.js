import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { capText } from "../../src/presentation.js";

const DEFAULT_PROJECT = "/benchmark/context-window";
const DEFAULT_TOP_K = 5;
const DEFAULT_CONTEXT_TOKENS = 2_048;
const DEFAULT_IMAGE_CONTEXT_TOKENS = 256;
const DEFAULT_MAX_IMAGES_PER_RESULT = 2;

function requiredString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function xmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function messageText(message) {
  if (!message || typeof message !== "object") throw new Error("message must be an object");
  return `[${requiredString(message.role, "message.role")}] ${requiredString(message.content, "message.content")}`;
}

function longMemEvalDcg(gains) {
  return gains.reduce((sum, gain, index) => {
    if (index === 0) return sum + gain;
    return sum + gain / Math.log2(index + 1);
  }, 0);
}

function ndcgAt(rankedIds, relevantIds, k) {
  const relevant = new Set(relevantIds);
  const gains = rankedIds.slice(0, k).map((id) => relevant.has(id) ? 1 : 0);
  const idealCount = Math.min(k, relevant.size);
  const idealGains = Array.from({ length: idealCount }, () => 1);
  const ideal = longMemEvalDcg(idealGains);
  return ideal === 0 ? 0 : longMemEvalDcg(gains) / ideal;
}

export class ArchiveAgentMemoryAdapter {
  constructor(archive, {
    project = DEFAULT_PROJECT,
    sessionId,
    topK = DEFAULT_TOP_K,
    memoryContextMaxTokens = DEFAULT_CONTEXT_TOKENS,
    imageContextTokens = DEFAULT_IMAGE_CONTEXT_TOKENS,
    maxImagesPerResult = DEFAULT_MAX_IMAGES_PER_RESULT,
  } = {}) {
    if (!archive || typeof archive.put !== "function" || typeof archive.search !== "function") {
      throw new Error("archive must expose put() and search()");
    }
    this.archive = archive;
    this.project = requiredString(project, "project");
    this.sessionId = requiredString(sessionId, "sessionId");
    this.topK = positiveInteger(topK, DEFAULT_TOP_K);
    this.memoryContextMaxTokens = positiveInteger(memoryContextMaxTokens, DEFAULT_CONTEXT_TOKENS);
    this.imageContextTokens = positiveInteger(imageContextTokens, DEFAULT_IMAGE_CONTEXT_TOKENS);
    this.maxImagesPerResult = positiveInteger(maxImagesPerResult, DEFAULT_MAX_IMAGES_PER_RESULT);
    this.sequence = 0;
  }

  insertText({ id, text, kind = "turn", createdAt, metadata = {} }) {
    const documentId = requiredString(id ?? `${this.sessionId}:${this.sequence + 1}`, "id");
    const admitted = this.archive.put({
      id: documentId,
      sessionId: this.sessionId,
      project: this.project,
      kind,
      text: requiredString(text, "text"),
      createdAt: createdAt ?? this.sequence + 1,
      metadata,
    }, { deferPrune: true });
    if (!admitted) throw new Error(`archive rejected benchmark document ${documentId}`);
    this.sequence += 1;
    return admitted;
  }

  search(query, { limit = this.topK } = {}) {
    return this.archive.search(requiredString(query, "query"), {
      sessionId: this.sessionId,
      project: this.project,
      scope: "session",
      limit: positiveInteger(limit, this.topK),
    });
  }

  queryContext(query, { limit = this.topK, includeImages = true } = {}) {
    const results = this.search(query, { limit });
    if (results.length === 0) return [];
    const context = [];
    let remainingBudget = this.memoryContextMaxTokens;
    results.forEach((result, resultIndex) => {
      const resultsRemaining = results.length - resultIndex;
      const itemBudget = Math.max(1, Math.floor(remainingBudget / resultsRemaining));
      const hasTextEvidence = result.metadata?.hasTextEvidence !== false;
      const imagePaths = includeImages && Array.isArray(result.metadata?.imagePaths)
        ? result.metadata.imagePaths.slice(0, this.maxImagesPerResult)
        : [];
      const maximumImages = hasTextEvidence
        ? Math.max(0, Math.floor((itemBudget - 1) / this.imageContextTokens))
        : Math.floor(itemBudget / this.imageContextTokens);
      const selectedImages = imagePaths.slice(0, maximumImages);
      const imageBudget = selectedImages.length * this.imageContextTokens;
      if (hasTextEvidence) {
        context.push({
          type: "text",
          value: capText(
            [
              "[ARCHIVED HISTORICAL EVIDENCE]",
              `Source: ${result.id}`,
              `Matched excerpt: ${result.snippet}`,
              "Source text:",
              result.text,
            ].join("\n"),
            Math.max(1, itemBudget - imageBudget),
          ),
        });
      }
      for (const imagePath of selectedImages) {
        requireImageFile(imagePath, `archived image for ${result.id}`);
        context.push({ type: "image", value: imagePath });
      }
      remainingBudget -= imageBudget + (hasTextEvidence ? Math.max(1, itemBudget - imageBudget) : 0);
    });
    return context;
  }

  addChunk(chunk, { id, createdAt, metadata = {} } = {}) {
    return this.insertText({
      id: id ?? `${this.sessionId}:chunk:${this.sequence + 1}`,
      text: chunk,
      createdAt,
      metadata: { benchmark: "memoryarena", ...metadata },
    });
  }

  wrapUserPrompt(question) {
    const query = requiredString(question, "question");
    const context = this.queryContext(query);
    const memories = context.length === 0
      ? "None"
      : context.map(({ value }) => `<memory>${xmlText(value)}</memory>`).join("\n");
    return `<memory_context>\n${memories}\n</memory_context>\nUser: ${query}`;
  }
}

export function ingestLongMemEvalCase(adapter, entry) {
  const questionId = requiredString(entry?.question_id, "question_id");
  const sessionIds = entry?.haystack_session_ids;
  const sessions = entry?.haystack_sessions;
  const dates = entry?.haystack_dates;
  if (!Array.isArray(sessionIds) || !Array.isArray(sessions) || !Array.isArray(dates)) {
    throw new Error("LongMemEval case must contain haystack session ids, sessions, and dates");
  }
  if (sessionIds.length !== sessions.length || sessions.length !== dates.length) {
    throw new Error("LongMemEval haystack arrays must have equal lengths");
  }
  return sessions.map((messages, index) => {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error(`LongMemEval session ${sessionIds[index]} must contain messages`);
    }
    const corpusId = requiredString(sessionIds[index], `haystack_session_ids[${index}]`);
    return adapter.insertText({
      id: `${adapter.sessionId}:${corpusId}`,
      text: [`Date: ${dates[index]}`, ...messages.map(messageText)].join("\n"),
      createdAt: index + 1,
      metadata: {
        benchmark: "longmemeval-v1",
        questionId,
        corpusId,
        date: dates[index],
      },
    });
  });
}

export function runLongMemEvalRetrieval(adapter, entry, { limit = 10 } = {}) {
  const question = requiredString(entry?.question, "question");
  const answerSessionIds = Array.isArray(entry?.answer_session_ids)
    ? entry.answer_session_ids.map(String)
    : [];
  const results = adapter.search(question, { limit });
  const rankedItems = results.map((result) => ({
    corpus_id: result.metadata.corpusId,
    text: result.text,
    score: result.score,
  }));
  const rankedIds = rankedItems.map(({ corpus_id: corpusId }) => corpusId);
  const metrics = {};
  for (const k of [1, 3, 5, 10]) {
    const retrieved = new Set(rankedIds.slice(0, k));
    const hitCount = answerSessionIds.filter((id) => retrieved.has(id)).length;
    metrics[`recall_any@${k}`] = Number(hitCount > 0);
    metrics[`recall_all@${k}`] = Number(hitCount === answerSessionIds.length);
    metrics[`ndcg_any@${k}`] = ndcgAt(rankedIds, answerSessionIds, k);
  }
  return {
    question_id: entry.question_id,
    retrieval_results: {
      query: question,
      ranked_items: rankedItems,
      metrics: { session: metrics, turn: {} },
    },
  };
}

function optionalLine(label, value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? `${label}: ${text}` : undefined;
}

function requireImageFile(path, field) {
  const imagePath = requiredString(path, field);
  let stats;
  try {
    stats = statSync(imagePath);
  } catch {
    throw new Error(`${field} must reference an existing file: ${imagePath}`);
  }
  if (!stats.isFile()) throw new Error(`${field} must reference a file: ${imagePath}`);
  return imagePath;
}

function resolveTrajectoryScreenshot(value, { dataRoot, trajectoryId, stateIndex }) {
  if (value === undefined || value === null) return undefined;
  const screenshot = requiredString(value, `trajectory ${trajectoryId} state ${stateIndex} screenshot`);
  const imagePath = isAbsolute(screenshot) ? screenshot : resolve(dataRoot, screenshot);
  return requireImageFile(imagePath, `trajectory ${trajectoryId} state ${stateIndex} screenshot`);
}

export function ingestLongMemEvalV2Trajectory(adapter, trajectory, { dataRoot = "." } = {}) {
  const trajectoryId = requiredString(trajectory?.id, "trajectory.id");
  const states = trajectory?.states;
  if (!Array.isArray(states) || states.length === 0) {
    throw new Error(`trajectory ${trajectoryId} must contain states`);
  }
  const screenshotPaths = [];
  let textEvidenceCount = 0;
  const lines = [`Trajectory: ${trajectoryId}`];
  for (const line of [
    optionalLine("Goal", trajectory.goal),
    optionalLine("Start URL", trajectory.start_url),
  ]) {
    if (line) {
      lines.push(line);
      textEvidenceCount += 1;
    }
  }
  states.forEach((state, index) => {
    if (!state || typeof state !== "object") throw new Error(`trajectory ${trajectoryId} state ${index} must be an object`);
    lines.push(`State ${index}:`);
    for (const line of [
      optionalLine("URL", state.url),
      optionalLine("Thought", state.thought ?? state.thoughts),
      optionalLine("Action", state.action),
      optionalLine("Observation", state.accessibility_tree ?? state.text),
    ]) {
      if (line) {
        lines.push(line);
        textEvidenceCount += 1;
      }
    }
    const screenshotPath = resolveTrajectoryScreenshot(state.screenshot, {
      dataRoot,
      trajectoryId,
      stateIndex: index,
    });
    if (screenshotPath) screenshotPaths.push(screenshotPath);
  });
  const outcome = optionalLine("Outcome", trajectory.outcome);
  if (outcome) {
    lines.push(outcome);
    textEvidenceCount += 1;
  }
  const documentId = adapter.insertText({
    id: `${adapter.sessionId}:${trajectoryId}`,
    text: lines.join("\n"),
    metadata: {
      benchmark: "longmemeval-v2",
      trajectoryId,
      screenshotReferences: screenshotPaths.length,
      imagePaths: screenshotPaths,
      hasTextEvidence: textEvidenceCount > 0,
    },
  });
  const compatibility = screenshotPaths.length === 0
    ? "text-complete"
    : textEvidenceCount === 0
      ? "image-complete"
      : "multimodal-complete";
  return {
    documentId,
    trajectoryId,
    screenshotReferences: screenshotPaths.length,
    textEvidence: textEvidenceCount > 0,
    compatibility,
  };
}

export function queryLongMemEvalV2(adapter, query, options) {
  return adapter.queryContext(query, options);
}

export const BENCHMARK_COMPATIBILITY = Object.freeze({
  longMemEvalV1: Object.freeze({
    lifecycle: "ingest sessions -> direct query -> ranked corpus ids -> retrieval metrics",
    status: "storage-contract-only",
    limitation: "The direct probe bypasses agent-side query expansion, iterative search, recall, and traversal.",
  }),
  longMemEvalV2: Object.freeze({
    lifecycle: "insert trajectory -> query -> bounded ordered text/image context items",
    status: "compatible",
    limitation: "The adapter pre-budgets images with a configurable token estimate; the official reader processor remains the source of truth for exact multimodal token counts and final prefix truncation.",
  }),
  memoryArena: Object.freeze({
    lifecycle: "initialize scoped memory -> add chunk -> wrap user prompt",
    status: "compatible-via-http-wrapper",
  }),
});
