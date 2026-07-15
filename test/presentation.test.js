import assert from "node:assert/strict";
import test from "node:test";
import { ARCHIVED_EVIDENCE_LABEL } from "../src/evidence-routing.js";
import {
  capText,
  formatRecalledDocument,
  formatSearchResults,
  formatStatusLine,
  statusUrgency,
} from "../src/presentation.js";

function status(overrides = {}) {
  return {
    activeTokens: 40_000,
    activeTurns: 8,
    rotationTokens: 96_000,
    rotationTurns: 20,
    rotationPending: false,
    ...overrides,
  };
}

test("archive search and recall outputs carry a concise staleness label", () => {
  const result = { id: "doc-1", kind: "turn", snippet: "Earlier decision" };
  const search = formatSearchResults([result], 100);
  const emptySearch = formatSearchResults([], 100);
  const recall = formatRecalledDocument({ ...result, text: "Exact earlier wording" }, 100);
  const missingRecall = formatRecalledDocument(undefined, 100, "missing-id");

  for (const output of [search, emptySearch, recall, missingRecall]) {
    assert.equal(output.startsWith(`[${ARCHIVED_EVIDENCE_LABEL}]\n\n`), true);
    assert.equal(output.match(/Archived historical evidence/g)?.length, 1);
  }
  assert.match(search, /Earlier decision/);
  assert.match(recall, /Exact earlier wording/);
  assert.match(recall, /legacy-unavailable/);
  assert.match(missingRecall, /No archived document with id missing-id\./);
});

test("capText includes its marker within a strict normalized character budget", () => {
  for (const tokens of [-10, 0, 1, 3]) {
    const output = capText("abcdefghijklmnopqrstuvwxyz", tokens);
    assert.ok(output.length <= Math.max(1, tokens) * 4);
  }
  assert.equal(capText("abcdefgh", 1, "a marker far longer than the cap").length, 4);
  assert.match(capText("abcdefghijklmnopqrstuvwxyz".repeat(3), 10), /retrieval truncated/);
});

test("recall renders structured provenance inside the output cap", () => {
  const keys = Array.from({ length: 20 }, (_, index) => `message-${index}-${"k".repeat(20)}`);
  const document = {
    id: "doc-provenance",
    kind: "turn",
    sessionId: "session-child",
    project: "/project",
    createdAt: 1_700_000_000_000,
    text: `deterministic source-derived serialization ${"x".repeat(1_000)}`,
    metadata: {
      sourceMessageKeys: keys,
      sourceFirstKey: keys[0],
      sourceLastKey: keys.at(-1),
      sourceMessageCount: keys.length,
    },
  };

  const full = formatRecalledDocument(document, 1_000);
  assert.match(full, /Archive: doc-provenance \(turn\)/);
  assert.match(full, /Session: session-child/);
  assert.match(full, /Project: \/project/);
  assert.match(full, /Created: 2023-11-14T22:13:20\.000Z/);
  assert.match(full, /Ordered source message keys: message-0/);
  assert.ok(full.includes(`Ordered source message keys: ${keys.join(", ")}`));
  assert.ok(full.indexOf("Deterministic archived serialization") < full.indexOf("Provenance summary"));
  assert.match(full, /Deterministic archived serialization/);

  const capped = formatRecalledDocument(document, 80);
  assert.match(capped, /retrieval truncated/);
  assert.ok(capped.length <= 80 * 4);
  assert.equal(capped.includes(keys[10]), false);
  assert.match(capped, /deterministic source-derived/);
});

test("recall prioritizes evidence over hundreds of verbose ordered keys", () => {
  const keys = Array.from({ length: 400 }, (_, index) =>
    `message-${String(index).padStart(3, "0")}-${"long-key".repeat(20)}`,
  );
  const evidence = "MEANINGFUL RECALL EVIDENCE: use the deterministic archived decision.";
  const output = formatRecalledDocument({
    id: "adversarial-provenance",
    kind: "turn",
    text: evidence,
    metadata: {
      sourceMessageKeys: keys,
      sourceFirstKey: keys[0],
      sourceLastKey: keys.at(-1),
      sourceMessageCount: keys.length,
    },
  }, 1_500);

  assert.ok(output.length <= 1_500 * 4);
  assert.match(output, new RegExp(evidence));
  assert.match(output, /Source messages: 400 ordered key/);
  assert.match(output, /First source key:/);
  assert.equal(output.includes(keys[100]), false);
  assert.match(output, /retrieval truncated/);
});

test("tiny recall and missing-document limits cap the entire model-visible output", () => {
  const tiny = formatRecalledDocument({
    id: "tiny",
    kind: "turn",
    text: "EVIDENCE-SURVIVES",
    metadata: {
      sourceMessageKeys: ["first-long-source-key", "last-long-source-key"],
      sourceFirstKey: "first-long-source-key",
      sourceLastKey: "last-long-source-key",
      sourceMessageCount: 2,
    },
  }, 70);
  const missing = formatRecalledDocument(undefined, 4, "missing-" + "x".repeat(200));

  assert.ok(tiny.length <= 70 * 4);
  assert.match(tiny, /EVIDENCE/);
  assert.equal(tiny.includes("First source key"), false);
  assert.ok(missing.length <= 4 * 4);
});

test("recall cap boundaries preserve an ordinary document's evidence before provenance", () => {
  const document = {
    id: "ordinary",
    kind: "turn",
    text: `¤ordinary archived document text ${"evidence ".repeat(80)}`,
    metadata: {
      sourceMessageKeys: ["source-first", "source-last"],
      sourceFirstKey: "source-first",
      sourceLastKey: "source-last",
      sourceMessageCount: 2,
    },
  };
  const evidencePrefix = `[${ARCHIVED_EVIDENCE_LABEL}]\n\n# ordinary (turn)\n\n## Deterministic archived serialization\n`;

  for (let tokens = 40; tokens <= 100; tokens += 1) {
    const first = formatRecalledDocument(document, tokens);
    const second = formatRecalledDocument(document, tokens);
    const evidenceCanFit = tokens * 4 > evidencePrefix.length;

    assert.equal(first, second, `non-deterministic output at ${tokens} tokens`);
    assert.ok(first.length <= tokens * 4, `cap exceeded at ${tokens} tokens`);
    assert.equal(
      first.includes(`## Deterministic archived serialization\n${document.text[0]}`),
      evidenceCanFit,
      `evidence presence at ${tokens} tokens`,
    );
    assert.equal(first.includes("Provenance summary"), false, `provenance displaced evidence at ${tokens} tokens`);
    assert.equal(first.includes("source-first"), false, `provenance key leaked at ${tokens} tokens`);
  }

  const repro = formatRecalledDocument(document, 46);
  assert.ok(repro.length <= 184);
  assert.match(repro, /Deterministic archived serialization\n¤/);
  assert.equal(repro.includes("Provenance summary"), false);
});

test("recall truncates optional provenance only after complete evidence", () => {
  const document = {
    id: "p",
    kind: "turn",
    sessionId: "session",
    project: "/project",
    text: "¤",
    metadata: {
      sourceMessageKeys: ["first", "last"],
      sourceFirstKey: "first",
      sourceLastKey: "last",
      sourceMessageCount: 2,
    },
  };
  const capped = formatRecalledDocument(document, 46);

  assert.equal(capped, formatRecalledDocument(document, 46));
  assert.ok(capped.length <= 184);
  assert.match(capped, /Deterministic archived serialization\n¤\n\n## Provenance/);
  assert.match(capped, /…$/);
  assert.equal(capped.includes("Additional provenance"), false);

  const full = formatRecalledDocument(document, 100);
  assert.ok(full.indexOf("¤") < full.indexOf("Provenance summary"));
  assert.ok(full.indexOf("Provenance summary") < full.indexOf("Additional provenance"));
  assert.match(full, /Ordered source message keys: first, last/);
});

test("search output is strictly capped and keeps a deterministic follow-up id", () => {
  const results = [
    { id: "follow-up-id", kind: "turn", snippet: "s".repeat(1_000) },
    { id: "second-id", kind: "turn", snippet: "other" },
  ];
  const first = formatSearchResults(results, 50);
  const second = formatSearchResults(results, 50);

  assert.equal(first, second);
  assert.ok(first.length <= 50 * 4);
  assert.match(first, /follow-up-id/);
  assert.match(first, /retrieval truncated/);
  assert.ok(formatSearchResults([], 1).length <= 4);
});

test("recall labels mixed cross-kind provenance as incomplete", () => {
  const output = formatRecalledDocument({
    id: "mixed-tool",
    kind: "tool-result",
    text: "mixed provenance evidence",
    metadata: {
      sourceMessageKey: "toolResult:2:call-1:abcdef123456",
      sourceMessageKeys: ["user:1::aaa"],
      sourceFirstKey: "user:1::aaa",
      sourceLastKey: "user:1::aaa",
      sourceMessageCount: 1,
    },
  }, 200);

  assert.match(output, /Source messages: incomplete/);
  assert.equal(output.includes("Ordered source message keys"), false);
  assert.equal(output.includes("one original message"), false);
  assert.match(output, /mixed provenance evidence/);
});

test("recall identifies a tool-result archive's one source message without calling it a turn", () => {
  const key = "toolResult:2:call-1:abcdef123456";
  const output = formatRecalledDocument({
    id: "tool-doc",
    kind: "tool-result",
    text: "tool output",
    metadata: {
      toolCallId: "call-1",
      toolName: "bash",
      sourceMessageKey: key,
    },
  }, 200);

  assert.match(output, new RegExp(`Source message: ${key}`));
  assert.match(output, /one original message; this tool-result document is not an archived turn/);
});

test("footer maps current epoch values directly to their limits", () => {
  assert.equal(
    formatStatusLine(status()),
    "Epoch · 8/20 turns · ~40K/96K tokens",
  );
});

test("footer explains unknown, near-limit, and queued states", () => {
  assert.equal(
    formatStatusLine(status({ activeTokens: undefined, activeTurns: undefined })),
    "Epoch · waiting to measure · limits 20 turns / 96K tokens",
  );
  assert.equal(
    formatStatusLine(status({ activeTokens: 80_000 })),
    "Epoch · 8/20 turns · ~80K/96K tokens · near limit",
  );
  assert.equal(
    formatStatusLine(status({ rotationPending: true })),
    "Epoch · 8/20 turns · ~40K/96K tokens · rotation queued",
  );
  assert.equal(
    formatStatusLine(status({ activeTokens: undefined, activeTurns: undefined, rotationPending: true })),
    "Epoch · waiting to measure · limits 20 turns / 96K tokens · rotation queued",
  );
});

test("footer surfaces emergency retention and native fallback", () => {
  assert.equal(
    formatStatusLine(status({
      retainTurns: 10,
      lastRotationMode: "emergency-retention",
      effectiveRetainTurns: 2,
    })),
    "Epoch · 8/20 turns · ~40K/96K tokens · emergency retention 2/10",
  );
  assert.equal(
    formatStatusLine(status({ compactionFallbackReason: "oversized-latest-turn" })),
    "Epoch · 8/20 turns · ~40K/96K tokens · native compaction needed",
  );
});

test("footer label accent is optional", () => {
  const accented = formatStatusLine(status(), {
    accent: (text) => `<accent>${text}</accent>`,
  });
  assert.match(accented, /^<accent>Epoch<\/accent>/);
  assert.match(formatStatusLine(status()), /^Epoch/);
});

test("footer urgency uses the nearest configured limit", () => {
  assert.equal(statusUrgency(status({ activeTurns: 16 })), "near");
  assert.equal(statusUrgency(status({ activeTokens: 96_000 })), "limit");
  assert.equal(statusUrgency(status({ rotationPending: true })), "queued");
});
