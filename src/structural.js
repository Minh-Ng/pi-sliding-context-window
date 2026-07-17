export const STRUCTURAL_RELATIONS = Object.freeze([
  "latest-question",
  "latest-request",
  "latest-correction",
  "latest-answer",
]);

const INTERROGATIVE_PREFIX = /^(?:who|what|when|where|why|how|which|whose|can|could|would|should|do|does|did|is|are|was|were|will|have|has)\b/i;
const REQUEST_PREFIX = /^(?:please\b|can you\b|could you\b|would you\b|will you\b|i (?:want|need) you to\b|go ahead\b|add\b|answer\b|check\b|continue\b|create\b|delete\b|explain\b|find\b|fix\b|give\b|implement\b|look\b|make\b|read\b|remove\b|run\b|show\b|start\b|stop\b|tell\b|update\b|use\b|write\b)/i;
const CORRECTION_CUE = /(?:^|\b)(?:actually|correction|i meant|rather than|the whole point|that(?:'s| is| was) not|not what i asked|you missed|we already)(?:\b|:)/i;

function normalizedText(value) {
  return String(value ?? "").trim();
}

export function structuralMessageScores({
  role,
  text,
  isTerminalAssistant = false,
  stopReason,
}) {
  const value = normalizedText(text);
  const scores = {
    question: 0,
    request: 0,
    correction: 0,
    answer: 0,
  };
  if (!value) return scores;

  if (role === "user") {
    scores.question = value.includes("?") ? 100 : INTERROGATIVE_PREFIX.test(value) ? 85 : 10;
    scores.request = REQUEST_PREFIX.test(value) ? 100 : 10;
    scores.correction = CORRECTION_CUE.test(value) ? 100 : 0;
  }
  if (role === "assistant" && stopReason !== "error") {
    scores.answer = isTerminalAssistant ? 100 : 75;
  }
  return scores;
}

export function relationScoreField(relation) {
  switch (relation) {
    case "latest-question": return "question_score";
    case "latest-request": return "request_score";
    case "latest-correction": return "correction_score";
    case "latest-answer": return "answer_score";
    default: return undefined;
  }
}
