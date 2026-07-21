import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSessionContextTerms,
  SESSION_CONTEXT_GROUP_WINDOW,
  SESSION_CONTEXT_TERM_LIMIT,
} from "../src/session/session-context.js";

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// One user turn plus its assistant reply, matching groupCompleteTurns'
// interaction-group boundary (a new group starts at each user message).
function group(userText, assistantText) {
  return [user(userText), assistant(assistantText)];
}

test("deriveSessionContextTerms is empty for no messages or an empty prefix", () => {
  assert.deepEqual(deriveSessionContextTerms([]), []);
  assert.deepEqual(deriveSessionContextTerms(undefined), []);
  assert.deepEqual(deriveSessionContextTerms(null), []);
});

test("deriveSessionContextTerms ranks a term concentrated in one recent group above one repeated in every group", () => {
  const messages = [
    ...group("Let's discuss the quarterly roadmap.", "Sure, happy to talk roadmap."),
    ...group("Back to the roadmap, what about staffing?", "Staffing for the roadmap is tentative."),
    ...group(
      "One more roadmap question, then let's dig into the WIDGET_CALIBRATION_ENGINE regression.",
      "The WIDGET_CALIBRATION_ENGINE regression looks like a calibration drift bug.",
    ),
  ];
  const terms = deriveSessionContextTerms(messages, { groupWindow: 3 });
  // "roadmap" recurs in every one of the 3 groups (local document frequency
  // 3/3) while "calibr"/"engin"/"regress" (from WIDGET_CALIBRATION_ENGINE and
  // "calibration"/"regression") are concentrated in the most recent group
  // only (document frequency 1/3) -- the local-IDF proxy this module
  // documents ranks the concentrated, topically distinctive terms above the
  // one that recurs everywhere.
  const roadmapRank = terms.indexOf("roadmap");
  const calibrationRank = terms.indexOf("calibr");
  assert.ok(calibrationRank >= 0, `expected "calibr" in ${JSON.stringify(terms)}`);
  assert.ok(roadmapRank === -1 || calibrationRank < roadmapRank);
});

test("deriveSessionContextTerms only considers the last N interaction groups", () => {
  const stale = group("Discuss STALE_ANCHOR_TOPIC at length in the first turn.", "Noted, STALE_ANCHOR_TOPIC.");
  const recentGroups = Array.from({ length: SESSION_CONTEXT_GROUP_WINDOW }, (_, index) => (
    group(`Recent turn ${index} about FRESH_ANCHOR_TOPIC.`, `Ack turn ${index}.`)
  )).flat();
  const terms = deriveSessionContextTerms([...stale, ...recentGroups]);
  assert.ok(!terms.some((term) => term.includes("stale")));
});

test("deriveSessionContextTerms caps at termLimit (default SESSION_CONTEXT_TERM_LIMIT)", () => {
  const distinctWords = Array.from({ length: 40 }, (_, index) => `distinctword${index}`);
  const messages = group(distinctWords.join(" "), "acknowledged");
  const terms = deriveSessionContextTerms(messages);
  assert.equal(terms.length, SESSION_CONTEXT_TERM_LIMIT);
  const limited = deriveSessionContextTerms(messages, { termLimit: 3 });
  assert.equal(limited.length, 3);
});

test("deriveSessionContextTerms is deterministic for a fixed prefix", () => {
  const messages = [
    ...group("Investigate the PAYMENT_RETRY_QUEUE backlog.", "Looking into PAYMENT_RETRY_QUEUE now."),
    ...group("Any update on the retry queue?", "Still draining the retry queue backlog."),
  ];
  const first = deriveSessionContextTerms(messages);
  const second = deriveSessionContextTerms(messages);
  assert.deepEqual(first, second);
});

test("deriveSessionContextTerms tokenizes with the existing BM25 tokenizer (camelCase/snake_case subterms included)", () => {
  const messages = group("We should refactor readDocumentTermVocabulary carefully.", "Agreed.");
  const terms = deriveSessionContextTerms(messages);
  assert.ok(terms.includes("document"));
  // The tokenizer's Porter stemmer normalizes "Vocabulary" to "vocabulari".
  assert.ok(terms.includes("vocabulari"));
});

test("deriveSessionContextTerms does not throw when active message text contains an unpaired UTF-16 surrogate", () => {
  // Mirrors a truncated tool-result preview mid-emoji/CJK (window.js
  // code-unit .slice()), which the BM25 tokenizer otherwise rejects.
  const lonelySurrogate = String.fromCharCode(0xd83d); // high surrogate with no low pair
  const messages = group(
    `Investigate the export preview cutoff ${lonelySurrogate} regression.`,
    "Looking into the export preview cutoff regression now.",
  );
  const terms = deriveSessionContextTerms(messages);
  assert.ok(terms.includes("export"));
  assert.ok(terms.includes("preview"));
});
