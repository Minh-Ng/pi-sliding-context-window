import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTINUITY_REASON,
  CONTINUITY_THRESHOLDS,
  continuityAnchors,
  continuityIntent,
  decideContinuityDisclosure,
  renderContinuityMarker,
} from "../src/retrieval/continuity-policy.js";

function lexicalCandidate(overrides = {}) {
  return {
    documentId: "candidate-document-id",
    version: 1,
    kind: "turn",
    retrievalMode: "lexical",
    score: 0.62,
    rawScore: 1.63,
    calibratedScore: 0.62,
    margin: 0.20,
    matchedAnchors: [],
    matchedTerms: ["tablet", "compact"],
    termCoverage: 2 / 3,
    maxNormalizedIdf: 0.90,
    snippet: "tablet compact coldNeighborTerm /private/archive/path",
    locator: "candidate-only-locator",
    ...overrides,
  };
}

test("implicit recurring concepts return a marker made only from current-message anchors", () => {
  const message = "Could tablets help with compaction here?";
  const candidate = lexicalCandidate();
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.deepEqual(decision, {
    outcome: "continuity-marker",
    reason: CONTINUITY_REASON.IMPLICIT_CONTINUITY,
    anchors: ["tablets", "compaction"],
  });
  const marker = renderContinuityMarker(message, decision.anchors);
  assert.match(marker, /tablets/u);
  assert.match(marker, /compaction/u);
  assert.doesNotMatch(marker, /coldNeighborTerm/u);
  assert.doesNotMatch(marker, /candidate-document-id|candidate-only-locator|private\/archive/u);
  assert.ok(decision.anchors.every((anchor) => message.includes(anchor)));
});

test("a verbatim exact current-message anchor permits implicit conversation continuity", () => {
  const message = "Could REAP_DRAIN help here?";
  const candidate = lexicalCandidate({
    retrievalMode: "exact",
    matchType: "exact-symbol",
    matchedAnchors: ["REAP_DRAIN"],
    matchedTerms: [],
    termCoverage: 0,
    maxNormalizedIdf: 0,
  });
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.equal(decision.outcome, "continuity-marker");
  assert.deepEqual(decision.anchors, ["REAP_DRAIN"]);
});

test("explicit historical intent yields a snippet only for strong unambiguous evidence", () => {
  const message = "What did we decide before about tablets and compaction?";
  const strong = decideContinuityDisclosure({ message, candidate: lexicalCandidate() });
  assert.equal(strong.outcome, "historical-snippet");
  assert.equal(strong.reason, CONTINUITY_REASON.EXPLICIT_HISTORY);

  for (const margin of [0.01, 0.08]) {
    const ambiguous = decideContinuityDisclosure({
      message,
      candidate: lexicalCandidate({ margin }),
    });
    assert.equal(ambiguous.outcome, "continuity-marker");
    assert.equal(ambiguous.reason, CONTINUITY_REASON.AMBIGUOUS_HISTORY);
  }
});

test("explicit decision recall tolerates IDF diluted by its rotated source turn", () => {
  const message = "Remember discussed what color are canary deployments?";
  const decisionCandidate = lexicalCandidate({
    kind: "decision-candidate",
    matchedTerms: ["canari", "color", "deploy"],
    termCoverage: 0.60,
    maxNormalizedIdf: 0.58,
  });
  assert.equal(
    decideContinuityDisclosure({ message, candidate: decisionCandidate }).outcome,
    "historical-snippet",
  );
  assert.equal(
    decideContinuityDisclosure({ message, candidate: { ...decisionCandidate, kind: "turn" } }).reason,
    CONTINUITY_REASON.WEAK_EVIDENCE,
  );
  assert.equal(
    decideContinuityDisclosure({
      message: "What color are canary deployments?",
      candidate: decisionCandidate,
    }).reason,
    CONTINUITY_REASON.WEAK_EVIDENCE,
  );
});

test("lexical continuity requires two terms, coverage, and distinctive evidence", () => {
  const message = "Could tablets help with compaction here?";
  const cases = [
    lexicalCandidate({ matchedTerms: ["tablet"], termCoverage: 1, maxNormalizedIdf: 1 }),
    lexicalCandidate({ termCoverage: 0.59 }),
    lexicalCandidate({ maxNormalizedIdf: 0.59 }),
  ];
  for (const candidate of cases) {
    const decision = decideContinuityDisclosure({ message, candidate });
    assert.equal(decision.outcome, "suppress");
    assert.equal(decision.reason, CONTINUITY_REASON.WEAK_EVIDENCE);
  }
});

test("continuity thresholds include their exact boundary values", () => {
  assert.deepEqual(CONTINUITY_THRESHOLDS, {
    lexicalTerms: 2,
    termCoverage: 0.60,
    maxNormalizedIdf: 0.60,
    ambiguityMargin: 0.10,
  });
  const implicitMessage = "Could tablets help with compaction here?";
  const atLexicalBoundary = decideContinuityDisclosure({
    message: implicitMessage,
    candidate: lexicalCandidate({
      matchedTerms: ["tablet", "compact"],
      termCoverage: 0.60,
      maxNormalizedIdf: 0.60,
    }),
  });
  assert.equal(atLexicalBoundary.outcome, "continuity-marker");

  const historicalMessage = "What did we decide before about tablets and compaction?";
  assert.equal(decideContinuityDisclosure({
    message: historicalMessage,
    candidate: lexicalCandidate({ margin: 0.10 }),
  }).outcome, "continuity-marker");
  assert.equal(decideContinuityDisclosure({
    message: historicalMessage,
    candidate: lexicalCandidate({ margin: 0.100_001 }),
  }).outcome, "historical-snippet");
});

test("current-state-only and general-knowledge messages suppress automatic history", () => {
  const candidate = lexicalCandidate();
  for (const message of [
    "What is the current state of tablet compaction?",
    "Does the current repository implement tablet compaction?",
    "What is the current configuration for tablet compaction?",
    "Does the code on disk implement tablet compaction?",
    "Before changing anything, inspect the current files for tablet compaction.",
  ]) {
    const current = decideContinuityDisclosure({ message, candidate });
    assert.equal(current.outcome, "suppress");
    assert.equal(current.reason, CONTINUITY_REASON.CURRENT_STATE_REQUIRED);
  }

  for (const message of [
    "Define tablet compaction",
    "In general, what is tablet compaction?",
    "What is tablet compaction in general?",
    "Explain tablet compaction generally.",
  ]) {
    const general = decideContinuityDisclosure({ message, candidate });
    assert.equal(general.outcome, "suppress");
    assert.equal(general.reason, CONTINUITY_REASON.GENERAL_KNOWLEDGE);
  }
});

test("implicit continuity is limited to eligible conversation sources", () => {
  assert.equal(decideContinuityDisclosure({
    message: "What deployment color is used for canary deploys?",
    candidate: lexicalCandidate({
      kind: "decision-candidate",
      matchedTerms: ["color", "us", "canari"],
      termCoverage: 0.75,
    }),
  }).outcome, "continuity-marker");

  const decision = decideContinuityDisclosure({
    message: "Could tablets help with compaction here?",
    candidate: lexicalCandidate({ kind: "tool-result" }),
  });
  assert.equal(decision.outcome, "suppress");
  assert.equal(decision.reason, CONTINUITY_REASON.SOURCE_INELIGIBLE);

  const externallyIneligible = decideContinuityDisclosure({
    message: "What did we decide before about tablets and compaction?",
    candidate: lexicalCandidate(),
    sourceEligible: false,
  });
  assert.equal(externallyIneligible.outcome, "suppress");
  assert.equal(externallyIneligible.reason, CONTINUITY_REASON.SOURCE_INELIGIBLE);
});

test("marker rendering rejects archive-only or duplicate dynamic material", () => {
  const message = "Could tablets help with compaction here?";
  assert.throws(
    () => renderContinuityMarker(message, ["tablets", "coldNeighborTerm"]),
    /exact span/u,
  );
  assert.throws(
    () => renderContinuityMarker(message, ["tablets", "tablets"]),
    /unique exact span/u,
  );
});

test("one compound identifier's camelCase subtokens do not alone satisfy the two-term evidence bar", () => {
  const message = "why handleRotationCheckpoint?";
  const candidate = lexicalCandidate({
    matchedTerms: ["rotat", "checkpoint"],
    termCoverage: 1,
    maxNormalizedIdf: 1,
  });
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.equal(decision.outcome, "suppress");
  assert.equal(decision.reason, CONTINUITY_REASON.WEAK_EVIDENCE);
});

test("subterms from two distinct compound identifiers still satisfy the two-term evidence bar", () => {
  const message = "why handleRotationCheckpoint and validateSnapshotSync?";
  const candidate = lexicalCandidate({
    matchedTerms: ["rotat", "snapshot"],
    termCoverage: 1,
    maxNormalizedIdf: 1,
  });
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.equal(decision.outcome, "continuity-marker");
  assert.equal(decision.reason, CONTINUITY_REASON.IMPLICIT_CONTINUITY);
});

test("a literally repeated word with only one matched term does not satisfy the two-term evidence bar", () => {
  const message = "tablet tablet compaction issue";
  const candidate = lexicalCandidate({
    matchedTerms: ["tablet"],
    termCoverage: 1,
    maxNormalizedIdf: 1,
  });
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.equal(decision.outcome, "suppress");
  assert.equal(decision.reason, CONTINUITY_REASON.WEAK_EVIDENCE);
});

test("a subterm-only match anchors on the whole identifier the user typed, not a word fragment", () => {
  const message = "why handleRotationCheckpoint and validateSnapshotSync?";
  const candidate = lexicalCandidate({
    matchedTerms: ["rotat", "snapshot"],
    termCoverage: 1,
    maxNormalizedIdf: 1,
  });
  const decision = decideContinuityDisclosure({ message, candidate });
  assert.deepEqual(decision.anchors, ["handleRotationCheckpoint", "validateSnapshotSync"]);
});

test("routing intent recognizes explicit recall without broadening ordinary remember commands", () => {
  for (const message of [
    "Recall: What color are canary deploys?",
    "Can you remember what we chose for canary deploys?",
    "Remember when we chose the canary convention?",
    "Remember discussed what color are canary deployments?",
    "Do you remember our discussion about canary deployments?",
  ]) {
    assert.equal(continuityIntent(message).historical, true, message);
  }
  assert.equal(continuityIntent("Remember to run the tests.").historical, false);
});

test("routing intent remains narrow enough for implicit concepts", () => {
  assert.deepEqual(continuityIntent("Could tablets help here?"), {
    historical: false,
    currentOnly: false,
    generalKnowledge: false,
  });
  assert.deepEqual(
    continuityAnchors("Could tablets help with compaction?", lexicalCandidate()),
    ["tablets", "compaction"],
  );
  const missing = decideContinuityDisclosure({ message: "Could tablets help here?" });
  assert.equal(missing.reason, CONTINUITY_REASON.NO_CANDIDATE);
});
