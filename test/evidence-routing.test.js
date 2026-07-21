import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  ARCHIVED_EVIDENCE_LABEL,
  ARCHIVE_GATHER_TURN_GUIDANCE,
  ARCHIVE_STATE_RECONCILIATION_HINT,
  EVIDENCE_ROUTES,
  EVIDENCE_ROUTING_GUIDELINES,
  EVIDENCE_ROUTING_POLICY,
  GATHER_TOOL_DESCRIPTION,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SUPERSEDE_TOOL_DESCRIPTION,
  archiveGatherSuggested,
  archiveStateReconciliationSuggested,
} from "../src/evidence-routing.js";
import {
  EFFECTIVE_PRODUCTION_GUIDANCE,
  EFFECTIVE_PRODUCTION_GUIDANCE_HASH,
  EFFECTIVE_PRODUCTION_GUIDANCE_VERSION,
  EVIDENCE_ROUTING_HELD_OUT_SUITE,
  EVIDENCE_ROUTING_REFERENCE_SUITE,
  canonicalEffectiveProductionGuidance,
  EVIDENCE_ROUTING_REGRESSION_SUITE,
  HELD_OUT_EVALUATION_INSTRUCTIONS,
  REFERENCE_EVALUATION_INSTRUCTIONS,
  EVIDENCE_ROUTING_SUITES,
  EVIDENCE_ROUTING_JARGON_SUITE,
  EVIDENCE_ROUTING_JARGON_PAIRS,
  EVIDENCE_ROUTING_INTERNALIZED_SUITE,
  JARGON_EVALUATION_INSTRUCTIONS,
  INTERNALIZED_EVALUATION_INSTRUCTIONS,
  assessArchiveOnlyTerminology,
  createEvidenceRoutingEvalRecord,
  scoreArchiveRequiredRouting,
  scoreJargonMarkerPairs,
  evidenceRoutingModelInputs,
  hashEffectiveProductionGuidance,
  reconstructEvidenceRoutingRawResponse,
  renderEvidenceRoutingEvaluationPrompt,
  scoreEvidenceRouting,
  validateEvidenceRoutingArtifact,
  validateEvidenceRoutingEvalRecord,
} from "../eval/evidence-routing/evidence-routing-eval.js";

const ROUTES = Object.values(EVIDENCE_ROUTES);
const SUITES = Object.entries(EVIDENCE_ROUTING_SUITES);

function assertNonLeakingOrder(name, suite) {
  const labels = suite.map(({ expectedRoute }) => expectedRoute);

  for (let index = 1; index < labels.length; index += 1) {
    assert.notEqual(labels[index], labels[index - 1], `${name} has a route run at ${index}`);
  }

  for (let period = 1; period <= Math.floor(labels.length / 2); period += 1) {
    const repeats = labels.every((label, index) => index < period || label === labels[index - period]);
    assert.equal(repeats, false, `${name} labels repeat with period ${period}`);
  }
}

function assertAnnotatedBalancedSuite(name, suite) {
  assert.equal(Object.isFrozen(suite), true);
  assert.equal(suite.length, 20);
  const counts = Object.fromEntries(ROUTES.map((route) => [route, 0]));

  for (const fixture of suite) {
    assert.equal(Object.isFrozen(fixture), true);
    assert.match(fixture.id, new RegExp(`^${name}-\\d{3}$`));
    for (const route of ROUTES) {
      assert.equal(fixture.id.includes(route), false, `id reveals route ${route}: ${fixture.id}`);
    }
    assert.ok(ROUTES.includes(fixture.expectedRoute), `unknown route: ${fixture.expectedRoute}`);
    assert.ok(fixture.prompt.length >= 20, `underspecified prompt: ${fixture.id}`);
    assert.ok(fixture.annotation.length >= 40, `underspecified annotation: ${fixture.id}`);
    counts[fixture.expectedRoute] += 1;
  }

  assert.deepEqual(counts, { archive: 5, live: 5, both: 5, neither: 5 });
  assertNonLeakingOrder(name, suite);
}

test("routing policy defines archive, live, both, and neither semantics", () => {
  assert.deepEqual(ROUTES, ["archive", "live", "both", "neither"]);
  assert.deepEqual(Object.keys(EVIDENCE_ROUTING_POLICY), ROUTES);
  assert.match(EVIDENCE_ROUTING_POLICY.archive, /prior intent.*rationale.*exact wording.*decisions.*rejected approaches.*continuity.*scope disputes/);
  assert.match(EVIDENCE_ROUTING_POLICY.live, /current files.*runtime behavior.*configuration.*test results.*task status/);
  assert.match(EVIDENCE_ROUTING_POLICY.live, /old discussion.*inviting history lookup.*exclusively current mutable state/);
  assert.match(EVIDENCE_ROUTING_POLICY.both, /archived intent first.*live state second.*reconcile conflicts/);
  assert.match(EVIDENCE_ROUTING_POLICY.both, /authoritative for mutable current state/);
  assert.match(EVIDENCE_ROUTING_POLICY.neither, /Avoid speculative broad archive searches/);
  assert.match(SEARCH_TOOL_DESCRIPTION, /continuity marker confirms only.*exact anchor copied from the current user message/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /search the marker's exact anchor before using it/i);
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /marker itself as a recovered fact, decision, definition, or current-state claim/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /archive candidate.*plain language.*archived discussion or a live source/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /project-specific term.*not defined in visible context.*about to search.*live source.*also run context_window_search.*exact term/i.test(guideline)));
  assert.match(SEARCH_TOOL_DESCRIPTION, /project-specific term.*not defined in visible context.*search the archive for that exact term.*origin as ambiguous/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /latest\/current state.*rolling time window.*change over time/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /preserve temporal qualifiers.*inspect every returned candidate.*do not default to rank 1/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /newest relevant candidate.*snippet is truncated or omits the requested value.*older explicit value/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /event dates or old→new values.*preserve uncertainty/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /materially disagree.*top result is only an assistant assertion.*never accept rank 1/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /own visible answer.*claims, not source evidence.*explicit user decisions/i);
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /materially disagree.*assistant assertion.*never accept rank 1/i.test(guideline)));
  assert.match(SEARCH_TOOL_DESCRIPTION, /acting on specific files, symbols, or identifiers.*workingSet.*never overrides a clearly stronger match/i);
  assert.match(GATHER_TOOL_DESCRIPTION, /acting on specific files, symbols, or identifiers.*workingSet.*without overriding a clearly stronger match/i);
  assert.match(SEARCH_TOOL_DESCRIPTION, /searchEffort=wide only after a normal search missed or when uncertainty is genuinely high.*costs latency and tokens/i);
  assert.match(GATHER_TOOL_DESCRIPTION, /searchEffort=wide only after a normal gather missed or when uncertainty is genuinely high.*costs latency and tokens/i);
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /Source timestamps order messages, not necessarily events/i.test(guideline)));
  // Fact-shaped archiving: settled facts get a stable subjectKey at write time,
  // superseded on correction so one live document per subject stays retrievable.
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /durable project fact or decision is settled.*stable subjectKey.*one live document per subject/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /on a later correction.*supersede or re-archive with supersedes targeting the live document/i.test(guideline)));
  // Third destination: cross-project user facts go to host memory, not the
  // project-partitioned archive and not the repository.
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /user-scoped fact that holds across projects.*host's own memory mechanism.*not this project-partitioned archive and not the repository/i.test(guideline)));
  // Risk-weighted retrieval: before an irreversible action, the bar for
  // consulting archived evidence drops to one targeted, precisely-keyed
  // search rather than the default speculative-search avoidance.
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /destructive or hard-to-reverse action.*subjectKey or exact anchors.*empty result clears the action.*match must be reconciled before proceeding/i.test(guideline)));
  assert.match(SUPERSEDE_TOOL_DESCRIPTION, /hard to reverse.*search for the subject's prior decisions or constraints first/i);
  // Negative-evidence archiving: a meaningful, acted-on absence finding
  // ("checked X, found nothing") is worth archiving under a stable
  // absence:<subject> key so the next session doesn't repeat the check or
  // assume presence; a routine empty grep is not archived.
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /meaningful check for a subject comes up empty.*absence is acted on.*absence:<subject>.*what was checked, how, and when/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /context_window_supersede.*subject is later found to exist.*absence stops being treated as current/i.test(guideline)));
  // Artifact versioning (ultracode task #38): successive versions of one
  // working artifact share a stable subjectKey and supersede one another,
  // and context_recall reports the resulting chain position.
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /successive versions of one working artifact.*stable subjectKey.*supersede the prior version/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /kind manual for an artifact that must outlive normal retention/i.test(guideline)));
  assert.ok(EVIDENCE_ROUTING_GUIDELINES.some((guideline) => /context_recall on any version in that chain reports its position \(version k of n\) and its immediate predecessor\/successor/i.test(guideline)));

  assert.deepEqual(EFFECTIVE_PRODUCTION_GUIDANCE, {
    searchToolDescription: SEARCH_TOOL_DESCRIPTION,
    recallToolDescription: RECALL_TOOL_DESCRIPTION,
    evidenceRoutingGuidelines: EVIDENCE_ROUTING_GUIDELINES,
    archivedEvidenceLabel: ARCHIVED_EVIDENCE_LABEL,
  });
  const digest = createHash("sha256").update(JSON.stringify(EFFECTIVE_PRODUCTION_GUIDANCE)).digest("hex");
  assert.equal(EFFECTIVE_PRODUCTION_GUIDANCE_HASH, `sha256:${digest}`);
  // The searchEffort=wide guidance line added to SEARCH_TOOL_DESCRIPTION and
  // GATHER_TOOL_DESCRIPTION invalidates the prior fingerprint, so the version
  // identifier must be bumped past it.
  // The gather-before-irreversible-action rule appended to
  // EVIDENCE_ROUTING_GUIDELINES again changes the model-visible guidance
  // text, so the fingerprint version bumped past "13" to "14". The
  // negative-evidence archiving rule (confirmed-absence findings) appended
  // above bumps it again to "15". The artifact-versioning rule (successive
  // versions of one working artifact under a stable subjectKey; ultracode
  // task #38) bumps it again to "16". Conflict-aware recall guidance bumps
  // it to "17". Any held-out/reference eval artifact captured against an
  // older version (see the persisted-artifact test below, still pinned at
  // "4") already fails validateEvidenceRoutingEvalRecord's version check by
  // design — once guidance moves, its recorded routing accuracy is
  // regression-only evidence for that snapshot, not a live held-out
  // measurement.
  assert.equal(EFFECTIVE_PRODUCTION_GUIDANCE_VERSION, "17");
});

test("archive-state reconciliation intent covers broad time-sensitive language without treating every historical question as an update", () => {
  for (const query of [
    "How many are there now?",
    "What is the latest recorded preference?",
    "Did the ratio switch to more or less water?",
    "What changed after the migration?",
    "How many films were watched in the last 3 months?",
    "Is that setting still enabled?",
  ]) {
    assert.equal(archiveStateReconciliationSuggested(query), true, query);
  }
  for (const query of [
    "What was the count on May 20?",
    "Why did we choose RocksDB earlier?",
    "Quote the original deployment decision.",
    "",
  ]) {
    assert.equal(archiveStateReconciliationSuggested(query), false, query);
  }
  assert.match(ARCHIVE_STATE_RECONCILIATION_HINT, /one match may be stale or partial/i);
  assert.match(ARCHIVE_STATE_RECONCILIATION_HINT, /inspect every returned snippet.*do not default to rank 1/i);
  assert.match(ARCHIVE_STATE_RECONCILIATION_HINT, /sourceTimestamp orders source messages, not events/i);
  assert.match(ARCHIVE_STATE_RECONCILIATION_HINT, /does not replace live inspection/i);
});

test("bounded gather intent recognizes generic state and workflow requests without release-specific tuning", () => {
  for (const query of [
    "What is the latest recorded value now?",
    "Use the same procedure as we did before.",
    "Repeat the previous workflow for this package.",
    "How did we handle this migration last time?",
  ]) {
    assert.equal(archiveGatherSuggested(query), true, query);
  }
  for (const query of [
    "Quote the sentence containing CACHE_KEY.",
    "Inspect the current repository status.",
    "Explain Merkle trees.",
    "",
  ]) {
    assert.equal(archiveGatherSuggested(query), false, query);
  }
  assert.match(GATHER_TOOL_DESCRIPTION, /bounded packet of exact archived evidence/i);
  assert.match(GATHER_TOOL_DESCRIPTION, /surrounding turns/i);
  assert.match(ARCHIVE_GATHER_TURN_GUIDANCE, /Prefer context_window_gather/i);
  for (const text of [GATHER_TOOL_DESCRIPTION, ARCHIVE_GATHER_TURN_GUIDANCE]) {
    assert.doesNotMatch(text, /benchmark|expected answer|fixture id|held-out case/iu);
  }
});

test("regression and held-out suites are balanced, annotated, and non-cyclic", () => {
  assertAnnotatedBalancedSuite("regression", EVIDENCE_ROUTING_REGRESSION_SUITE);
  assertAnnotatedBalancedSuite("heldout", EVIDENCE_ROUTING_HELD_OUT_SUITE);
  assertAnnotatedBalancedSuite("reference", EVIDENCE_ROUTING_REFERENCE_SUITE);
});

test("jargon suite isolates continuity-marker presence within exact prompt pairs", () => {
  const suite = EVIDENCE_ROUTING_JARGON_SUITE;
  assert.equal(Object.isFrozen(suite), true);
  assert.equal(suite.length, 20);
  const markerVisible = /^\[continuity marker:/i;
  const counts = Object.fromEntries(ROUTES.map((route) => [route, 0]));

  for (const fixture of suite) {
    assert.equal(Object.isFrozen(fixture), true);
    assert.match(fixture.id, /^jargon-\d{3}$/);
    for (const route of ROUTES) {
      assert.equal(fixture.id.includes(route), false, `id reveals route ${route}: ${fixture.id}`);
    }
    assert.ok(ROUTES.includes(fixture.expectedRoute), `unknown route: ${fixture.expectedRoute}`);
    assert.ok(fixture.prompt.length >= 20, `underspecified prompt: ${fixture.id}`);
    assert.ok(fixture.annotation.length >= 40, `underspecified annotation: ${fixture.id}`);
    assert.equal(fixture.prompt.includes("\n"), false, `multi-line prompt: ${fixture.id}`);
    counts[fixture.expectedRoute] += 1;
  }
  assert.deepEqual(counts, { archive: 5, live: 4, both: 5, neither: 6 });
  assertNonLeakingOrder("jargon", suite);

  const byId = new Map(suite.map((fixture, index) => [fixture.id, { fixture, index }]));
  const paired = new Set();
  let changedRoutes = 0;
  for (const pair of EVIDENCE_ROUTING_JARGON_PAIRS) {
    assert.equal(Object.isFrozen(pair), true);
    const without = byId.get(pair.withoutMarkerId);
    const withMarker = byId.get(pair.withMarkerId);
    assert.ok(without && withMarker, `pair references unknown case: ${pair.pairId}`);
    for (const id of [pair.withoutMarkerId, pair.withMarkerId]) {
      assert.equal(paired.has(id), false, `case in multiple pairs: ${id}`);
      paired.add(id);
    }
    // The complete user text is fixed; only the marker bytes vary.
    assert.ok(without.fixture.prompt.includes(pair.term), `term missing in ${pair.withoutMarkerId}`);
    assert.ok(withMarker.fixture.prompt.includes(pair.term), `term missing in ${pair.withMarkerId}`);
    assert.doesNotMatch(without.fixture.prompt, markerVisible, `baseline variant mentions marker: ${pair.withoutMarkerId}`);
    assert.match(withMarker.fixture.prompt, markerVisible, `marker variant lacks marker: ${pair.withMarkerId}`);
    assert.equal(withMarker.fixture.prompt, `${pair.markerText}${without.fixture.prompt}`);
    assert.match(pair.markerText, new RegExp(pair.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.equal(pair.markerText.includes(pair.archiveOnlyTerm), false, `marker leaks ${pair.archiveOnlyTerm}`);
    assert.equal(without.fixture.prompt.includes(pair.archiveOnlyTerm), false, `user text leaks ${pair.archiveOnlyTerm}`);
    if (without.fixture.expectedRoute !== withMarker.fixture.expectedRoute) {
      changedRoutes += 1;
      assert.equal(without.fixture.expectedRoute, EVIDENCE_ROUTES.BOTH);
      assert.equal(withMarker.fixture.expectedRoute, EVIDENCE_ROUTES.ARCHIVE);
    }
    // Pair members are separated so adjacency cannot cue the comparison.
    assert.ok(Math.abs(without.index - withMarker.index) > 1, `adjacent pair members: ${pair.pairId}`);
  }
  assert.equal(paired.size, 20, "every case must belong to exactly one pair");
  assert.equal(changedRoutes, 3, "three implicit-continuity pairs must require exact-anchor history only when marked");
});

test("archive-only terminology passes only when omitted or defined with provenance", () => {
  for (const { archiveOnlyTerm } of EVIDENCE_ROUTING_JARGON_PAIRS) {
    assert.deepEqual(assessArchiveOnlyTerminology("Use only terminology from the user.", [archiveOnlyTerm]), {
      pass: true,
      mentionedTerms: [],
      violations: [],
    });

    for (const responseText of [
      `Use ${archiveOnlyTerm} before flushing.`,
      `${archiveOnlyTerm} means the relevant archived mechanism.`,
      `The archived discussion mentions ${archiveOnlyTerm}.`,
    ]) {
      const result = assessArchiveOnlyTerminology(responseText, [archiveOnlyTerm]);
      assert.equal(result.pass, false, responseText);
      assert.deepEqual(result.mentionedTerms, [archiveOnlyTerm]);
      assert.deepEqual(result.violations, [{
        term: archiveOnlyTerm,
        reason: "archive-only-term-requires-inline-definition-and-provenance",
      }]);
    }

    const introduced = assessArchiveOnlyTerminology(
      `In the archived discussion, ${archiveOnlyTerm} means the relevant archived mechanism.`,
      [archiveOnlyTerm],
    );
    assert.equal(introduced.pass, true);
    assert.deepEqual(introduced.mentionedTerms, [archiveOnlyTerm]);
    assert.deepEqual(introduced.violations, []);
    assert.equal(Object.isFrozen(introduced), true);
  }

  assert.throws(() => assessArchiveOnlyTerminology(null, ["term"]), /responseText/);
  assert.throws(() => assessArchiveOnlyTerminology("response", [""]), /archiveOnlyTerms/);
});

test("internalized suite is policy-free with trap-focused composition", () => {
  const suite = EVIDENCE_ROUTING_INTERNALIZED_SUITE;
  assert.equal(Object.isFrozen(suite), true);
  assert.equal(suite.length, 20);
  const counts = Object.fromEntries(ROUTES.map((route) => [route, 0]));
  for (const fixture of suite) {
    assert.equal(Object.isFrozen(fixture), true);
    assert.match(fixture.id, /^internalized-\d{3}$/);
    for (const route of ROUTES) {
      assert.equal(fixture.id.includes(route), false, `id reveals route ${route}: ${fixture.id}`);
    }
    assert.ok(ROUTES.includes(fixture.expectedRoute), `unknown route: ${fixture.expectedRoute}`);
    assert.ok(fixture.prompt.length >= 20, `underspecified prompt: ${fixture.id}`);
    assert.ok(fixture.annotation.length >= 40, `underspecified annotation: ${fixture.id}`);
    assert.equal(fixture.prompt.includes("\n"), false, `multi-line prompt: ${fixture.id}`);
  }
  for (const fixture of suite) counts[fixture.expectedRoute] += 1;
  assert.deepEqual(counts, { archive: 6, live: 6, both: 4, neither: 4 });
  assertNonLeakingOrder("internalized", suite);

  // The whole point of this suite: instructions must not state the policy.
  assert.equal(INTERNALIZED_EVALUATION_INSTRUCTIONS.includes("Policy:"), false);
  for (const phrase of ["resolves its origin", "historical framing", "mutable", "probe both"]) {
    assert.equal(
      INTERNALIZED_EVALUATION_INSTRUCTIONS.toLowerCase().includes(phrase.toLowerCase()),
      false,
      `instructions leak policy phrase: ${phrase}`,
    );
  }
});

test("suite ids and prompts are unique within and across suites", () => {
  const ids = new Set();
  const prompts = new Set();
  for (const [, suite] of SUITES) {
    for (const fixture of suite) {
      assert.equal(ids.has(fixture.id), false, `duplicate id: ${fixture.id}`);
      assert.equal(prompts.has(fixture.prompt), false, `duplicate prompt: ${fixture.id}`);
      ids.add(fixture.id);
      prompts.add(fixture.prompt);
    }
  }
  const totalCases = SUITES.reduce((sum, [, suite]) => sum + suite.length, 0);
  assert.equal(ids.size, totalCases);
  assert.equal(prompts.size, totalCases);
});

test("annotations state the evidence needed without entering model inputs", () => {
  // Marker pairs have their own composition; the three original suites keep
  // the 4-way balance.
  const expectedBothCounts = { regression: 5, heldout: 5, reference: 5, jargon: 5, internalized: 4 };
  for (const [name, suite] of SUITES) {
    const mixed = suite.filter(({ expectedRoute }) => expectedRoute === EVIDENCE_ROUTES.BOTH);
    assert.equal(mixed.length, expectedBothCounts[name], `unexpected both count in ${name}`);
    for (const fixture of mixed) {
      assert.match(fixture.annotation, /Recover|historical|archive evidence/);
      assert.match(fixture.annotation, /inspect|current|live deployment|benchmark/);
    }

    const modelInputs = evidenceRoutingModelInputs(name);
    assert.equal(Object.isFrozen(modelInputs), true);
    assert.deepEqual(
      modelInputs,
      suite.map(({ id, prompt }) => ({ id, prompt })),
    );
    for (const input of modelInputs) {
      assert.deepEqual(Object.keys(input), ["id", "prompt"]);
      assert.equal(Object.isFrozen(input), true);
    }
  }
  assert.throws(() => evidenceRoutingModelInputs("unknown"), /unknown evidence-routing suite/);
});

function recordArguments(overrides = {}) {
  const orderedModelInputs = evidenceRoutingModelInputs("heldout");
  const parsedOrderedLabels = EVIDENCE_ROUTING_HELD_OUT_SUITE.map(({ expectedRoute }) => expectedRoute);
  return {
    timestamp: "2026-07-12T10:30:00.000Z",
    modelIdentifier: "provider/model-version",
    suite: "heldout",
    exposure: "untouched",
    evaluationInstructions: HELD_OUT_EVALUATION_INSTRUCTIONS,
    orderedModelInputs,
    renderedPrompt: renderEvidenceRoutingEvaluationPrompt(orderedModelInputs),
    rawResponseText: reconstructEvidenceRoutingRawResponse(orderedModelInputs, parsedOrderedLabels),
    rawResponseProvenance: "reconstructed-from-ordered-lines",
    parsedOrderedLabels,
    harnessIdentifier: "test-harness",
    harnessRevision: "revision-1",
    harnessSettings: { thinking: "high", retries: 0 },
    ...overrides,
  };
}

test("eval records require explicit exposure and preserve complete provenance", () => {
  const record = createEvidenceRoutingEvalRecord(recordArguments());
  assert.equal(record.exposure, "untouched");
  assert.equal(record.evaluationInstructions, HELD_OUT_EVALUATION_INSTRUCTIONS);
  assert.deepEqual(record.orderedModelInputs, evidenceRoutingModelInputs("heldout"));
  assert.equal(record.renderedPrompt, renderEvidenceRoutingEvaluationPrompt(record.orderedModelInputs));
  assert.match(record.renderedPromptHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.parsedOrderedLabels.length, 20);
  assert.equal(record.score.accuracy, 1);
  assert.equal(Object.isFrozen(record.harness.settings), true);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(validateEvidenceRoutingEvalRecord(record), true);

  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ exposure: undefined })), /exposure/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ exposure: "unknown" })), /exposure/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ timestamp: "not-a-date" })), /timestamp/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ modelIdentifier: "" })), /modelIdentifier/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ evaluationInstructions: "Rewritten instructions." })), /retained.*tool call/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ orderedModelInputs: [] })), /orderedModelInputs/);
  assert.throws(() => createEvidenceRoutingEvalRecord(recordArguments({ parsedOrderedLabels: [undefined] })), /strings or null/);
});

test("reference suite renders and scores through the generalized eval pipeline", () => {
  const orderedModelInputs = evidenceRoutingModelInputs("reference");
  assert.equal(orderedModelInputs.length, 20);
  const parsedOrderedLabels = EVIDENCE_ROUTING_REFERENCE_SUITE.map(({ expectedRoute }) => expectedRoute);
  const renderedPrompt = renderEvidenceRoutingEvaluationPrompt(orderedModelInputs, {
    instructions: REFERENCE_EVALUATION_INSTRUCTIONS,
    idPrefix: "reference-",
  });
  const lines = renderedPrompt.split("\n");
  assert.equal(lines.length, 22);
  assert.equal(lines[0], REFERENCE_EVALUATION_INSTRUCTIONS.split("\n")[0]);
  for (let index = 0; index < orderedModelInputs.length; index += 1) {
    const displayId = String(index + 1).padStart(3, "0");
    assert.equal(lines[index + 2], `${displayId} ${orderedModelInputs[index].prompt}`);
    assert.equal(lines[index + 2].includes(orderedModelInputs[index].id), false);
  }
  const record = createEvidenceRoutingEvalRecord({
    timestamp: "2026-07-13T00:00:00.000Z",
    modelIdentifier: "provider/model-version",
    suite: "reference",
    exposure: "untouched",
    evaluationInstructions: REFERENCE_EVALUATION_INSTRUCTIONS,
    orderedModelInputs,
    renderedPrompt,
    rawResponseText: reconstructEvidenceRoutingRawResponse(orderedModelInputs, parsedOrderedLabels),
    rawResponseProvenance: "reconstructed-from-ordered-lines",
    parsedOrderedLabels,
    harnessIdentifier: "test-harness",
    harnessRevision: "revision-1",
    harnessSettings: { thinking: "high", retries: 0 },
  });
  assert.equal(record.suite, "reference");
  assert.equal(record.score.accuracy, 1);
  assert.equal(record.score.falseArchiveSearches, 0);
  assert.equal(validateEvidenceRoutingEvalRecord(record), true);
});

test("jargon suite renders and embeds split scores through the eval pipeline", () => {
  const orderedModelInputs = evidenceRoutingModelInputs("jargon");
  const parsedOrderedLabels = EVIDENCE_ROUTING_JARGON_SUITE.map(({ expectedRoute }) => expectedRoute);
  const renderedPrompt = renderEvidenceRoutingEvaluationPrompt(orderedModelInputs, {
    instructions: JARGON_EVALUATION_INSTRUCTIONS,
    idPrefix: "jargon-",
  });
  const record = createEvidenceRoutingEvalRecord({
    timestamp: "2026-07-13T00:00:00.000Z",
    modelIdentifier: "provider/model-version",
    suite: "jargon",
    exposure: "regression",
    evaluationInstructions: JARGON_EVALUATION_INSTRUCTIONS,
    orderedModelInputs,
    renderedPrompt,
    rawResponseText: reconstructEvidenceRoutingRawResponse(orderedModelInputs, parsedOrderedLabels),
    rawResponseProvenance: "reconstructed-from-ordered-lines",
    parsedOrderedLabels,
    harnessIdentifier: "test-harness",
    harnessRevision: "revision-1",
    harnessSettings: { thinking: "high", retries: 0 },
  });
  assert.equal(record.score.accuracy, 1);
  assert.deepEqual(record.archiveRoutingScore, {
    archiveRequiredTotal: 10,
    archiveRequiredRouted: 10,
    archiveSearchRecall: 1,
    archiveSearchesTotal: 10,
    archiveSearchesMaterial: 10,
    archiveSearchPrecision: 1,
  });
  assert.equal(record.markerPairScore.bothCorrect, 10);
  assert.equal(record.markerPairScore.bothWrong, 0);
  assert.equal(validateEvidenceRoutingEvalRecord(record), true);

  // Old suites must not grow split-score fields: persisted artifacts
  // reproduce byte-exactly through JSON comparison.
  const heldoutRecord = createEvidenceRoutingEvalRecord(recordArguments());
  assert.equal("archiveRoutingScore" in heldoutRecord, false);
  assert.equal("markerPairScore" in heldoutRecord, false);

  // The internalized suite embeds the split score but has no marker pairs.
  const internalizedInputs = evidenceRoutingModelInputs("internalized");
  const internalizedLabels = EVIDENCE_ROUTING_INTERNALIZED_SUITE.map(({ expectedRoute }) => expectedRoute);
  const internalizedRecord = createEvidenceRoutingEvalRecord({
    timestamp: "2026-07-13T00:00:00.000Z",
    modelIdentifier: "provider/model-version",
    suite: "internalized",
    exposure: "untouched",
    evaluationInstructions: INTERNALIZED_EVALUATION_INSTRUCTIONS,
    orderedModelInputs: internalizedInputs,
    renderedPrompt: renderEvidenceRoutingEvaluationPrompt(internalizedInputs, {
      instructions: INTERNALIZED_EVALUATION_INSTRUCTIONS,
      idPrefix: "internalized-",
    }),
    rawResponseText: reconstructEvidenceRoutingRawResponse(internalizedInputs, internalizedLabels),
    rawResponseProvenance: "reconstructed-from-ordered-lines",
    parsedOrderedLabels: internalizedLabels,
    harnessIdentifier: "test-harness",
    harnessRevision: "revision-1",
    harnessSettings: { thinking: "high", retries: 0 },
  });
  assert.equal(internalizedRecord.score.accuracy, 1);
  assert.deepEqual(internalizedRecord.archiveRoutingScore, {
    archiveRequiredTotal: 10,
    archiveRequiredRouted: 10,
    archiveSearchRecall: 1,
    archiveSearchesTotal: 10,
    archiveSearchesMaterial: 10,
    archiveSearchPrecision: 1,
  });
  assert.equal("markerPairScore" in internalizedRecord, false);
  assert.equal(validateEvidenceRoutingEvalRecord(internalizedRecord), true);
});

test("archive-required split scoring reports recall and precision separately", () => {
  const labels = ["archive", "both", "live", "neither", "both"];
  // Model: misses one archive-required case (index 1 -> live), makes one
  // spurious search (index 2 -> archive), answers the rest correctly.
  const results = ["archive", "live", "archive", "neither", "both"];
  const score = scoreArchiveRequiredRouting(labels, results);
  assert.deepEqual(score, {
    archiveRequiredTotal: 3,
    archiveRequiredRouted: 2,
    archiveSearchRecall: 2 / 3,
    archiveSearchesTotal: 3,
    archiveSearchesMaterial: 2,
    archiveSearchPrecision: 2 / 3,
  });
  assert.equal("accuracy" in score, false, "split score must not offer an aggregate");
  assert.throws(() => scoreArchiveRequiredRouting(["unknown"], []), /invalid expected route label/);

  const perfect = EVIDENCE_ROUTING_JARGON_SUITE.map(({ expectedRoute }) => expectedRoute);
  const flippedIndex = EVIDENCE_ROUTING_JARGON_SUITE.findIndex(
    ({ id }) => id === EVIDENCE_ROUTING_JARGON_PAIRS[0].withoutMarkerId,
  );
  const flipped = [...perfect];
  flipped[flippedIndex] = "live";
  const pairScore = scoreJargonMarkerPairs(flipped);
  assert.equal(pairScore.bothCorrect, 9);
  assert.equal(pairScore.markerVariantOnlyCorrect, 1);
  assert.equal(pairScore.baselineVariantOnlyCorrect, 0);
  assert.equal(pairScore.bothWrong, 0);
  assert.equal(pairScore.pairs[0].withoutMarkerCorrect, false);
  assert.equal(pairScore.pairs[0].withMarkerCorrect, true);
});

test("exact held-out prompt rendering preserves instructions, presentation ids, and case order", () => {
  const inputs = evidenceRoutingModelInputs("heldout");
  const rendered = renderEvidenceRoutingEvaluationPrompt(inputs);
  const lines = rendered.split("\n");

  assert.equal(lines[0], HELD_OUT_EVALUATION_INSTRUCTIONS.split("\n")[0]);
  assert.equal(lines[1], HELD_OUT_EVALUATION_INSTRUCTIONS.split("\n")[1]);
  assert.match(lines[1], /historical framing alone does not make archive material for an exclusively current question/);
  assert.equal(lines.length, 22);
  for (let index = 0; index < inputs.length; index += 1) {
    const displayId = String(index + 1).padStart(3, "0");
    assert.equal(lines[index + 2], `${displayId} ${inputs[index].prompt}`);
    assert.equal(rendered.split(`${displayId} ${inputs[index].prompt}`).length - 1, 1);
    assert.equal(lines[index + 2].includes(inputs[index].id), false);
  }
});

test("persisted held-out artifact validates all provenance and deterministic scores", async () => {
  const artifact = JSON.parse(await readFile(
    new URL("../eval/evidence-routing/heldout-2026-07-12.json", import.meta.url),
    "utf8",
  ));

  assert.equal(artifact.records.length, 2);
  assert.match(artifact.provenance.evaluationPrompt, /exact.*retained tool call/i);
  assert.match(artifact.provenance.presentationIds, /heldout-NNN.*NNN/);
  assert.match(artifact.provenance.rawResponses, /response bytes.*not captured.*reconstructed/i);
  assert.equal(validateEvidenceRoutingArtifact(artifact), true);
  const historicalGuidanceHash = hashEffectiveProductionGuidance(
    artifact.effectiveProductionGuidance,
  );
  assert.equal(artifact.effectiveProductionGuidanceVersion, "4");
  assert.notEqual(historicalGuidanceHash, EFFECTIVE_PRODUCTION_GUIDANCE_HASH);
  const expectedExposureBySuite = { heldout: "regression", reference: "untouched" };
  const seenSuites = new Set();
  for (const record of artifact.records) {
    assert.ok(record.suite in expectedExposureBySuite, `unexpected suite: ${record.suite}`);
    seenSuites.add(record.suite);
    assert.equal(record.exposure, expectedExposureBySuite[record.suite]);
    assert.equal(record.effectiveProductionGuidanceVersion, "4");
    assert.equal(record.effectiveProductionGuidanceHash, historicalGuidanceHash);
    assert.throws(() => validateEvidenceRoutingEvalRecord(record), /guidance version mismatch/);
    const spec = record.suite === "heldout"
      ? { instructions: HELD_OUT_EVALUATION_INSTRUCTIONS, idPrefix: "heldout-" }
      : { instructions: REFERENCE_EVALUATION_INSTRUCTIONS, idPrefix: "reference-" };
    assert.deepEqual(record.orderedModelInputs, evidenceRoutingModelInputs(record.suite));
    assert.equal(record.evaluationInstructions, spec.instructions);
    assert.equal(record.renderedPrompt, renderEvidenceRoutingEvaluationPrompt(record.orderedModelInputs, spec));
    assert.equal(record.parsedOrderedLabels.length, 20);
    assert.equal(
      record.rawResponseText,
      reconstructEvidenceRoutingRawResponse(record.orderedModelInputs, record.parsedOrderedLabels),
    );
  }
  assert.deepEqual([...seenSuites].sort(), ["heldout", "reference"]);
});

test("persisted eval artifacts use generic synthetic identifiers", async () => {
  const artifactNames = [
    "heldout-2026-07-12.json",
    "internalized-2026-07-12.json",
    "jargon-2026-07-12.json",
  ];
  const forbiddenSpecificAnchors = /(?:\/Users\/[^/"\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|github\.com|resolveContextLimits|hardLimitContextRatio|retainTurns|fix\/rehydrate-tasks-on-reload)/iu;

  for (const name of artifactNames) {
    const artifact = JSON.parse(await readFile(
      new URL(`../eval/evidence-routing/${name}`, import.meta.url),
      "utf8",
    ));
    assert.doesNotMatch(JSON.stringify(artifact), forbiddenSpecificAnchors, name);
  }
});

test("artifact validation detects any model-visible production guidance change", () => {
  const record = createEvidenceRoutingEvalRecord(recordArguments());
  for (const field of ["searchToolDescription", "recallToolDescription", "evidenceRoutingGuidelines", "archivedEvidenceLabel"]) {
    const changed = structuredClone(EFFECTIVE_PRODUCTION_GUIDANCE);
    if (Array.isArray(changed[field])) changed[field][0] += " changed";
    else changed[field] += " changed";
    assert.notEqual(hashEffectiveProductionGuidance(changed), EFFECTIVE_PRODUCTION_GUIDANCE_HASH);
    assert.throws(
      () => validateEvidenceRoutingEvalRecord(record, { effectiveProductionGuidance: changed }),
      /guidance hash mismatch/,
    );
  }
});

test("policy-only values do not affect the canonical production guidance hash", () => {
  const withUnusedPolicy = {
    ...EFFECTIVE_PRODUCTION_GUIDANCE,
    evidenceRoutingPolicy: { ...EVIDENCE_ROUTING_POLICY, archive: "unused changed value" },
  };
  assert.deepEqual(canonicalEffectiveProductionGuidance(withUnusedPolicy), EFFECTIVE_PRODUCTION_GUIDANCE);
  assert.equal(hashEffectiveProductionGuidance(withUnusedPolicy), EFFECTIVE_PRODUCTION_GUIDANCE_HASH);
});

test("validation rejects changed prompts, labels, reconstruction, and scores", () => {
  const record = createEvidenceRoutingEvalRecord(recordArguments());
  const tamperedPrompt = `${record.renderedPrompt} tampered`;
  const tamperedPromptHash = `sha256:${createHash("sha256").update(tamperedPrompt).digest("hex")}`;
  const mutations = [
    { ...record, evaluationInstructions: "Altered but otherwise valid instruction text." },
    { ...record, orderedModelInputs: [...record.orderedModelInputs].reverse() },
    { ...record, renderedPrompt: tamperedPrompt },
    { ...record, renderedPrompt: tamperedPrompt, renderedPromptHash: tamperedPromptHash },
    { ...record, parsedOrderedLabels: ["live", ...record.parsedOrderedLabels.slice(1)] },
    { ...record, rawResponseText: `${record.rawResponseText}\n` },
    { ...record, score: { ...record.score, correct: 0 } },
  ];
  for (const changed of mutations) assert.throws(() => validateEvidenceRoutingEvalRecord(changed));
});

test("scoreEvidenceRouting returns exact deterministic metrics", () => {
  const labels = ["archive", "live", "both", "neither", "live", "neither"];
  const results = ["archive", "archive", "both", "live", "both", "neither"];

  assert.deepEqual(scoreEvidenceRouting(labels, results), {
    total: 6,
    correct: 3,
    incorrect: 3,
    accuracy: 0.5,
    missing: 0,
    invalid: 0,
    extra: 0,
    falseArchiveSearches: 2,
  });
});

test("scoreEvidenceRouting accounts for invalid, missing, and extra labels", () => {
  assert.deepEqual(
    scoreEvidenceRouting(
      ["archive", "live", "both", "neither"],
      ["ARCHIVE", undefined, null, "neither", "not-a-route"],
    ),
    {
      total: 4,
      correct: 1,
      incorrect: 3,
      accuracy: 0.25,
      missing: 2,
      invalid: 1,
      extra: 1,
      falseArchiveSearches: 0,
    },
  );

  assert.throws(() => scoreEvidenceRouting(["unknown"], []), /invalid expected route label/);
  assert.throws(() => scoreEvidenceRouting({}, []), /must be arrays/);
});
