import assert from "node:assert/strict";
import test from "node:test";
import {
  relationScoreField,
  structuralMessageScores,
} from "../src/structural-annotations.js";

test("scores explicit questions, requests, corrections, and answers deterministically", () => {
  assert.deepEqual(structuralMessageScores({ role: "user", text: "Were liveserving workloads scaled up?" }), {
    question: 100,
    request: 10,
    correction: 0,
    answer: 0,
  });
  assert.deepEqual(structuralMessageScores({ role: "user", text: "Can you check Datadog?" }), {
    question: 100,
    request: 100,
    correction: 0,
    answer: 0,
  });
  assert.deepEqual(structuralMessageScores({ role: "user", text: "The whole point is that we have no compaction." }), {
    question: 10,
    request: 10,
    correction: 100,
    answer: 0,
  });
  assert.deepEqual(structuralMessageScores({
    role: "assistant",
    text: "The deployment completed.",
    isTerminalAssistant: true,
  }), {
    question: 0,
    request: 0,
    correction: 0,
    answer: 100,
  });
});

test("uses low-confidence role fallback without inventing corrections", () => {
  assert.deepEqual(structuralMessageScores({ role: "user", text: "Storage policy" }), {
    question: 10,
    request: 10,
    correction: 0,
    answer: 0,
  });
  assert.equal(structuralMessageScores({
    role: "assistant",
    text: "failed",
    isTerminalAssistant: true,
    stopReason: "error",
  }).answer, 0);
  assert.deepEqual(structuralMessageScores({ role: "toolResult", text: "large output" }), {
    question: 0,
    request: 0,
    correction: 0,
    answer: 0,
  });
});

test("maps only supported structural relations to safe SQL columns", () => {
  assert.equal(relationScoreField("latest-question"), "question_score");
  assert.equal(relationScoreField("latest-answer"), "answer_score");
  assert.equal(relationScoreField("unknown"), undefined);
});
