import { estimateModelVisibleTokens } from "../model-token-budget.js";

const DEFAULT_STALENESS_LABEL = "Archived historical evidence; verify current files and runtime state before relying on it.";

/** Deterministic historical-evidence label shared by recall and automatic hints. */
export function historicalStalenessLabel(createdAt) {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return DEFAULT_STALENESS_LABEL;
  let timestamp;
  try {
    timestamp = new Date(createdAt).toISOString();
  } catch {
    return DEFAULT_STALENESS_LABEL;
  }
  return `Archived historical evidence from ${timestamp}; verify current files and runtime state before relying on it.`;
}

const EVIDENCE_RECORD_MARKER = "[ARCHIVED HISTORICAL EVIDENCE — UNTRUSTED JSON RECORD]";
export const MIN_RECALL_OUTPUT_TOKENS = 39;

export function oneLineJson(value) {
  // JSON permits these Unicode separators unescaped, but escaping them keeps
  // the complete record on one physical line in every JavaScript consumer.
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function renderedRecord(recall, body, sourceMessages) {
  const metadataJson = oneLineJson({
    createdAt: recall.createdAt,
    documentId: recall.documentId,
    historical: true,
    kind: recall.kind,
    project: recall.project,
    sessionId: recall.sessionId,
    sourceMessages,
    stalenessLabel: recall.stalenessLabel,
    version: recall.version,
  });
  const bodyJson = oneLineJson(body);
  const envelope = {
    bodyJson,
    bodyJsonUtf8Bytes: Buffer.byteLength(bodyJson, "utf8"),
    bodyUtf8Bytes: Buffer.byteLength(body, "utf8"),
    format: "context-window.archived-evidence.v1",
    metadataJson,
    metadataJsonUtf8Bytes: Buffer.byteLength(metadataJson, "utf8"),
    trust: "untrusted-archived-data",
  };
  return `${EVIDENCE_RECORD_MARKER}\n${oneLineJson(envelope)}`;
}

function compactRenderedRecord(body) {
  return `[ARCHIVED UNTRUSTED JSON]\n${oneLineJson({
    body,
    truncated: true,
  })}`;
}

function focusCodePointRange(text, focusStartByte, focusEndByte) {
  const codePoints = Array.from(text);
  if (!Number.isSafeInteger(focusStartByte) || !Number.isSafeInteger(focusEndByte)
    || focusStartByte < 0 || focusEndByte <= focusStartByte) {
    return { codePoints, first: 0, last: Math.min(1, codePoints.length) };
  }
  let cursor = 0;
  let first = 0;
  let last = codePoints.length;
  let foundFirst = false;
  for (let index = 0; index < codePoints.length; index += 1) {
    const next = cursor + Buffer.byteLength(codePoints[index], "utf8");
    if (!foundFirst && next > focusStartByte) {
      first = index;
      foundFirst = true;
    }
    if (cursor >= focusEndByte) {
      last = index;
      break;
    }
    cursor = next;
  }
  return { codePoints, first, last: Math.max(first + 1, last) };
}

function focusedRecord(recall, maxTokens, options, renderBody) {
  const { codePoints, first, last } = focusCodePointRange(
    recall.text,
    options.focusStartByte,
    options.focusEndByte,
  );
  if (codePoints.length === 0 || first >= codePoints.length) return undefined;

  const focused = codePoints.slice(first, last).join("");
  let best;
  if (estimateModelVisibleTokens(renderBody(focused)) <= maxTokens) {
    best = renderBody(focused);
  } else {
    // A match can itself be larger than the complete output budget. Preserve
    // the largest authenticated fragment instead of returning a marker with
    // no evidence or an unrelated prefix from byte zero.
    let low = 1;
    let high = Math.max(1, last - first);
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = renderBody(codePoints.slice(first, first + length).join(""));
      if (estimateModelVisibleTokens(candidate) <= maxTokens) {
        best = candidate;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    return best;
  }

  let low = 0;
  let high = Math.max(first, codePoints.length - last);
  while (low <= high) {
    const radius = Math.floor((low + high) / 2);
    const body = codePoints.slice(
      Math.max(0, first - radius),
      Math.min(codePoints.length, last + radius),
    ).join("");
    const candidate = renderBody(body);
    if (estimateModelVisibleTokens(candidate) <= maxTokens) {
      best = candidate;
      low = radius + 1;
    } else {
      high = radius - 1;
    }
  }
  return best;
}

/** Render recalled source as one length-bound JSON record, never as instructions. */
export function renderRecalledEvidence(recall, maxTokens = recall?.maxTokens, options = {}) {
  if (!recall || recall.status !== "resolved") {
    throw new TypeError("renderRecalledEvidence requires a resolved recall response.");
  }
  const bounded = Number.isSafeInteger(maxTokens) && maxTokens > 0;
  if (!bounded) return renderedRecord(recall, recall.text, recall.sourceMessages);
  if (maxTokens < MIN_RECALL_OUTPUT_TOKENS) {
    throw new RangeError(
      `Recall output requires at least ${MIN_RECALL_OUTPUT_TOKENS} tokens for its fixed untrusted-data envelope.`,
    );
  }
  let sourceMessages = recall.sourceMessages;
  let rendered = renderedRecord(recall, recall.text, sourceMessages);
  if (estimateModelVisibleTokens(rendered) <= maxTokens) return rendered;

  if (sourceMessages?.status === "available" && sourceMessages.keys?.length > 0) {
    sourceMessages = {
      status: "available",
      keys: [],
      totalKeys: sourceMessages.totalKeys ?? sourceMessages.keys.length,
      truncated: true,
    };
  }
  const verboseFocused = focusedRecord(
    recall,
    maxTokens,
    options,
    (body) => renderedRecord(recall, body, sourceMessages),
  );
  if (verboseFocused !== undefined) return verboseFocused;

  const compactFocused = focusedRecord(recall, maxTokens, options, compactRenderedRecord);
  if (compactFocused !== undefined) return compactFocused;
  throw new RangeError(
    "Recall output budget cannot contain its untrusted-data envelope and authenticated evidence fragment.",
  );
}
