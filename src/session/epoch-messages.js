import { estimateModelVisibleTokens } from "./model-token-budget.js";
import {
  estimateTokens,
  messageKey,
  serializeMessage,
} from "./window.js";
import { structuralMessageScores } from "../structural-annotations.js";

export function structuralText(message) {
  const role = String(message?.role ?? "unknown");
  if (role !== "user" && role !== "assistant") return "";
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => {
    if (typeof part === "string") return part;
    return part?.type === "text" && typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

export function structuralMessages(messages) {
  let terminalAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant"
      && messages[index]?.stopReason !== "error"
      && structuralText(messages[index]).trim()) {
      terminalAssistantIndex = index;
      break;
    }
  }
  return messages.map((message, messageIndex) => {
    const role = String(message?.role ?? "unknown");
    const text = structuralText(message);
    const scores = structuralMessageScores({
      role,
      text,
      isTerminalAssistant: messageIndex === terminalAssistantIndex,
      stopReason: message?.stopReason,
    });
    return {
      messageIndex,
      messageKey: messageKey(message),
      role,
      createdAt: Number(message?.timestamp) || 0,
      text,
      questionScore: scores.question,
      requestScore: scores.request,
      correctionScore: scores.correction,
      answerScore: scores.answer,
    };
  });
}

export function appendArchivedHint(message, hint) {
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}${hint}` };
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: "text", text: hint }],
    };
  }
  return { ...message, content: [{ type: "text", text: hint }] };
}

export function userMessageKeys(messages) {
  return new Set(messages
    .filter((message) => message?.role === "user" && structuralText(message).trim())
    .map((message) => messageKey(message)));
}

export class OversizedInputArchiveError extends Error {
  constructor() {
    super("Oversized user input could not be archived safely.");
    this.name = "OversizedInputArchiveError";
    this.code = "OVERSIZED_INPUT_ARCHIVE_FAILED";
  }
}

function textContentPart(part) {
  return typeof part === "string"
    || (part && typeof part === "object" && part.type === "text"
      && typeof part.text === "string");
}

export function replaceProviderText(message, replacement) {
  if (typeof message?.content === "string") return { ...message, content: replacement };
  if (!Array.isArray(message?.content)) {
    return { ...message, content: [{ type: "text", text: replacement }] };
  }
  let inserted = false;
  const content = [];
  for (const part of message.content) {
    if (!textContentPart(part)) {
      content.push(part);
      continue;
    }
    if (inserted) continue;
    content.push(typeof part === "string" ? replacement : { ...part, text: replacement });
    inserted = true;
  }
  if (!inserted) content.unshift({ type: "text", text: replacement });
  return { ...message, content };
}

export function inlineUserTokens(message) {
  return Math.max(
    estimateTokens([message]),
    estimateModelVisibleTokens(serializeMessage(message)),
  );
}
