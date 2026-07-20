import assert from "node:assert/strict";
import test from "node:test";
import {
  getAnswerCheckPrompt,
  parseJudgeLabel,
} from "../eval/agent-memory/score-longmemeval.js";

test("LongMemEval judge prompt preserves the official knowledge-update rule", () => {
  const prompt = getAnswerCheckPrompt(
    "knowledge-update",
    "Where is it now?",
    "In the closet",
    "It was in the garage, but is now in the closet.",
  );
  assert.match(prompt, /previous information along with an updated answer/);
  assert.match(prompt, /Question: Where is it now\?/);
  assert.match(prompt, /Correct Answer: In the closet/);
  assert.match(prompt, /Model Response: It was in the garage, but is now in the closet\./);
  assert.match(prompt, /Answer yes or no only\.$/);
});

test("LongMemEval abstention prompt uses explanation rather than answer wording", () => {
  const prompt = getAnswerCheckPrompt(
    "single-session-user",
    "What is the missing value?",
    "No history gives this value.",
    "I do not have enough information.",
    { abstention: true },
  );
  assert.match(prompt, /unanswerable question/);
  assert.match(prompt, /Explanation: No history gives this value\./);
  assert.doesNotMatch(prompt, /Correct Answer:/);
});

test("LongMemEval judge label matches the official yes-substring rule", () => {
  assert.equal(parseJudgeLabel("yes"), true);
  assert.equal(parseJudgeLabel("YES."), true);
  assert.equal(parseJudgeLabel("no"), false);
});

test("LongMemEval judge rejects unknown question types", () => {
  assert.throws(
    () => getAnswerCheckPrompt("unknown", "q", "a", "r"),
    /Unsupported LongMemEval question type/,
  );
});
