import { createHash } from "node:crypto";
import { contentToText } from "./window.js";

// A replacement must retain its archive ID even when no head/tail preview fits.
export const MIN_TOOL_RESULT_ARCHIVE_REFERENCE_TOKENS = 32;

export function toolResultId(sessionId, message, text) {
  const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "");
  return `tool-${createHash("sha256").update(`${sessionId}\0${toolCallId}\0${text}`).digest("hex").slice(0, 16)}`;
}

export function toolArgumentId(sessionId, part, text) {
  const toolCallId = String(part?.id ?? part?.toolCallId ?? part?.tool_call_id ?? "");
  return `tool-arg-${createHash("sha256").update(`${sessionId}\0${toolCallId}\0${text}`).digest("hex").slice(0, 16)}`;
}

// Sum the tool-result characters that actually land in the active window
// (whole results plus the bounded previews of externalized ones). This is a
// pure function of the post-externalization active slice, so it reproduces
// deterministically on resume and resets to the retained slice on rotation.
export function measureToolResultTokens(messages) {
  let chars = 0;
  for (const message of messages) {
    if (message?.role === "toolResult" || message?.role === "tool") {
      chars += contentToText(message.content).length;
    }
  }
  return Math.ceil(chars / 4);
}

// Adaptive tool-result budget knobs, resolved against defaults so partial
// embedder configs (and older persisted configs) behave like the shipped
// policy. The floor never raises the base per-result gate.
export function resolveToolResultBudget(config, rotationTokens) {
  const configuredMax = Number(config.maxToolResultTokens);
  const maxToolResultTokens = Math.max(
    MIN_TOOL_RESULT_ARCHIVE_REFERENCE_TOKENS,
    Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 4_000,
  );
  const ratio = Number(config.toolResultBudgetRatio);
  const effectiveRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.3;
  const configuredFloor = Number(config.toolResultBudgetFloorTokens);
  const effectiveFloor = Math.max(
    MIN_TOOL_RESULT_ARCHIVE_REFERENCE_TOKENS,
    Number.isSafeInteger(configuredFloor) && configuredFloor > 0 ? configuredFloor : 1_000,
  );
  const target = Number.isFinite(rotationTokens) && rotationTokens > 0 ? rotationTokens : 1;
  return {
    maxToolResultTokens,
    budgetTokens: Math.max(1, Math.floor(target * effectiveRatio)),
    floorTokens: Math.min(maxToolResultTokens, effectiveFloor),
  };
}
