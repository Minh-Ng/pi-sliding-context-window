import assert from "node:assert/strict";
import test from "node:test";
import {
  EpochWindowSession,
  ROTATION_STATE_ENTRY,
} from "../src/session/epoch-window.js";
import { archiveDocumentProvenance } from "../src/identity/provenance.js";
import { estimateTokens, messageKey } from "../src/session/window.js";
import {
  config,
  user,
  assistant,
  memoryArchive,
} from "./epoch-window-helpers.js";

test("rotation indexes deterministic structural scores for original messages", () => {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  const indexed = [];
  archive.put = (document, options) => {
    if (document.kind === "turn") indexed.push(options.structuralMessages);
    return put(document);
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "structural-session",
    project: "/project",
  });
  session.process([
    user("Can you check Datadog?", 1),
    assistant("Yes.", 2),
    { ...assistant("A later failed retry.", 2.5), stopReason: "error" },
    user("The whole point is no compaction.", 3), assistant("Understood.", 4),
    user("current", 5), assistant("current answer", 6),
  ], { contextWindow: 200_000 });

  assert.equal(indexed.length, 2);
  assert.equal(indexed[0][0].questionScore, 100);
  assert.equal(indexed[0][0].requestScore, 100);
  assert.equal(indexed[0][1].answerScore, 100);
  assert.equal(indexed[0][2].answerScore, 0);
  assert.equal(indexed[1][0].correctionScore, 100);
  assert.match(indexed[0][0].messageKey, /^user:1::/);
});

test("rotation archives verbatim decision candidates with turn provenance", () => {
  const archive = memoryArchive();
  archive.resolveSubject = () => {
    throw new Error("rotation must not infer supersession from an exact anchor");
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: () => {},
  });
  const decisionText = "We agreed to keep src/config.js for queue settings rather than callbacks.";
  const messages = [
    user("queue or callbacks?", 1), assistant(decisionText, 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages, { contextWindow: 200_000 });

  const documents = [...archive.documents.values()];
  const candidates = documents.filter((document) => document.kind === "decision-candidate");
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  // Verbatim: the archived sentence is an exact span of the serialized turn.
  assert.equal(candidate.text, `[assistant] ${decisionText}`);
  assert.equal(candidate.subjectKey, undefined);
  const turnDocument = documents.find((document) => document.kind === "turn"
    && document.metadata.sourceMessageKeys[0] === messageKey(messages[0]));
  assert.equal(candidate.metadata.sourceTurnId, turnDocument.id);
  assert.deepEqual(candidate.metadata.sourceMessageKeys, messages.slice(0, 2).map(messageKey));

  const provenance = archiveDocumentProvenance(candidate);
  assert.equal(provenance.sourceMessages.status, "available");
  assert.deepEqual(provenance.decisionCandidate, {
    verbatim: true,
    sourceTurnId: turnDocument.id,
  });
});

test("rotation archives verbatim fact candidates with anchor metadata and turn provenance", () => {
  const archive = memoryArchive();
  archive.resolveSubject = () => {
    throw new Error("rotation must not infer supersession from an exact anchor");
  };
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-1",
    project: "/project",
    onRotation: () => {},
  });
  const factText = "The build uses node v20.11.0 for this project.";
  const messages = [
    user("What node version do we use?", 1), assistant(factText, 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages, { contextWindow: 200_000 });

  const documents = [...archive.documents.values()];
  const candidates = documents.filter((document) => document.kind === "fact-candidate");
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  // Verbatim: the archived sentence is an exact span of the serialized turn.
  assert.equal(candidate.text, `[assistant] ${factText}`);
  assert.equal(candidate.subjectKey, undefined, "no automatic subjectKey is assigned");
  const turnDocument = documents.find((document) => document.kind === "turn"
    && document.metadata.sourceMessageKeys[0] === messageKey(messages[0]));
  assert.equal(candidate.metadata.sourceTurnId, turnDocument.id);
  assert.deepEqual(candidate.metadata.sourceMessageKeys, messages.slice(0, 2).map(messageKey));
  assert.deepEqual(candidate.metadata.factAnchor, { type: "value", value: "v20.11.0" });

  const provenance = archiveDocumentProvenance(candidate);
  assert.equal(provenance.sourceMessages.status, "available");
  assert.deepEqual(provenance.factCandidate, {
    verbatim: true,
    sourceTurnId: turnDocument.id,
    anchor: { type: "value", value: "v20.11.0" },
  });
});

test("rotation caps fact candidates per turn independently of decision candidates", () => {
  const archive = memoryArchive();
  const session = new EpochWindowSession({
    archive,
    config,
    sessionId: "session-cap",
    project: "/project",
    onRotation: () => {},
  });
  const manyFacts = Array.from({ length: 9 }, (_, i) =>
    `The port for service-${i} is set to service-${i}-8080.`).join(" ");
  const manyDecisions = Array.from({ length: 9 }, (_, i) => `We decided option ${i} works.`).join(" ");
  const messages = [
    user("summarize", 1), assistant(`${manyFacts} ${manyDecisions}`, 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages, { contextWindow: 200_000 });

  const documents = [...archive.documents.values()];
  assert.equal(documents.filter((document) => document.kind === "fact-candidate").length, 5);
  assert.equal(documents.filter((document) => document.kind === "decision-candidate").length, 5);
});

test("automatic preflight caches every frozen decision and survives later retrieval failure", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return {
      modelVisibleText: `\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA]\nArchived excerpt as JSON data: ${JSON.stringify(request.messageKey)}`,
      hints: [],
    };
  };
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      hintBudgetTokens: 80,
      epochHintBudgetTokens: 320,
      rotationTurns: 20,
    },
    sessionId: "hint-session",
    initialSessionIds: ["parent-session"],
    project: "/project",
  });
  const first = user("What did we decide earlier?", 1);
  const firstVisible = session.process([first]);

  assert.equal(firstVisible.length, 1);
  assert.equal(firstVisible[0].role, "user");
  assert.equal(firstVisible[0].content[0].text, first.content[0].text);
  assert.match(firstVisible[0].content.at(-1).text, /ARCHIVED HISTORICAL EVIDENCE/u);
  assert.deepEqual(requests[0], {
    messageKey: messageKey(first),
    message: "What did we decide earlier?",
    scope: "session",
    sessionId: "hint-session",
    sessionIds: ["hint-session", "parent-session"],
    project: "/project",
    excludeVisibleSourceKeys: [messageKey(first)],
    hintBudgetTokens: 80,
    activeHintBudgetTokens: 320,
    activeMessageKeys: [messageKey(first)],
    hintSourceCooldownMs: 86_400_000,
    ephemeralAutoRetrievalDays: 7,
    conversationAutoRetrievalDays: 30,
    derivedAutoRetrievalDays: 30,
    includeDiagnostics: true,
    epochId: "hint-session:0",
    epochBudgetTokens: 320,
  });
  assert.equal(session.activeTokens, estimateTokens(firstVisible));

  const answer = assistant("We chose the indexed archive.", 2);
  const second = user("Why did we choose it?", 3);
  const secondVisible = session.process([first, answer, second]);
  assert.deepEqual(secondVisible[0], firstVisible[0]);
  assert.match(secondVisible[2].content.at(-1).text, /ARCHIVED HISTORICAL EVIDENCE/u);
  assert.deepEqual(requests.slice(1).map(({ messageKey: key }) => key), [
    messageKey(second),
  ]);
  assert.deepEqual(requests[1].excludeVisibleSourceKeys, [
    messageKey(first),
    messageKey(answer),
    messageKey(second),
  ]);
  assert.deepEqual(requests[1].activeMessageKeys, [
    messageKey(first),
    messageKey(second),
  ]);

  session.resetAfterCompaction();
  const afterCompactionReset = session.process([first, answer, second]);
  assert.deepEqual(afterCompactionReset, secondVisible);
  assert.equal(requests.length, 2);

  archive.preflight = () => { throw new Error("daemon unavailable"); };
  const secondAnswer = assistant("Because it preserves exact evidence.", 4);
  const third = user("What is the live status?", 5);
  const reconstructed = session.process([first, answer, second, secondAnswer, third]);
  assert.deepEqual(reconstructed.slice(0, 3), secondVisible);
  assert.deepEqual(reconstructed.slice(3), [secondAnswer, third]);
  assert.equal(requests.length, 2);
  assert.equal(session.status().preflightError, "daemon unavailable");
});

test("automatic retrieval diagnostics preserve the last sanitized preflight decision", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({
    modelVisibleText: "",
    hints: [],
    diagnostics: {
      outcome: "suppress",
      reason: "weak-evidence",
      indexGeneration: 7,
      searchMode: "lexical",
      searchStatus: "resolved",
      candidate: {
        documentId: "decision-7",
        kind: "decision-candidate",
        retrievalMode: "lexical",
        matchedTerms: ["canari", "deploi"],
        termCoverage: 0.4,
        maxNormalizedIdf: 1,
        margin: 0.5,
      },
    },
  });
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "diagnostic-session",
    project: "/project",
  });
  const prompt = user("What color is used for canary deploys?", 1);
  session.process([prompt]);

  assert.deepEqual(session.automaticRetrievalDiagnostics(), {
    outcome: "suppress",
    reason: "weak-evidence",
    indexGeneration: 7,
    searchMode: "lexical",
    searchStatus: "resolved",
    candidate: {
      documentId: "decision-7",
      kind: "decision-candidate",
      retrievalMode: "lexical",
      matchedTerms: ["canari", "deploi"],
      termCoverage: 0.4,
      maxNormalizedIdf: 1,
      margin: 0.5,
    },
    messageKey: messageKey(prompt),
  });
});

test("rotation sends retained user keys under one unchanged active hint budget", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return { modelVisibleText: "", hints: [] };
  };
  archive.removeHints = () => ({ removed: 1, notFound: 0 });
  const session = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      rotationTurns: 3,
      retainTurns: 2,
      activeHintBudgetTokens: 222,
      hintSourceCooldownHours: 12,
      ephemeralAutoRetrievalDays: 4,
      conversationAutoRetrievalDays: 18,
      derivedAutoRetrievalDays: 9,
    },
    sessionId: "hint-rotation-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];
  session.process(messages.slice(0, 2));
  session.process(messages.slice(0, 4));
  session.process(messages);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].activeMessageKeys, [
    messageKey(messages[2]),
    messageKey(messages[4]),
  ]);
  assert.equal(requests[2].activeHintBudgetTokens, 222);
  assert.equal(requests[2].epochBudgetTokens, 222);
  assert.equal(requests[2].epochId, "hint-rotation-session:1");
  assert.equal(requests[2].hintSourceCooldownMs, 12 * 60 * 60 * 1_000);
  assert.equal(requests[2].ephemeralAutoRetrievalDays, 4);
  assert.equal(requests[2].conversationAutoRetrievalDays, 18);
  assert.equal(requests[2].derivedAutoRetrievalDays, 9);
  assert.ok(requests[2].excludeVisibleSourceKeys.includes(messageKey(messages[3])));
});

test("automatic preflight excludes original source keys after provider-only externalization", () => {
  const archive = memoryArchive();
  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    return { modelVisibleText: "", hints: [] };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true, maxToolResultTokens: 10 },
    sessionId: "hint-visible-source-session",
    project: "/project",
  });
  const prompt = user("inspect the tool result", 1);
  const tool = {
    role: "toolResult",
    content: [{ type: "text", text: "x".repeat(10_000) }],
    timestamp: 2,
    toolCallId: "visible-tool",
    toolName: "read",
  };
  const processed = session.process([prompt, tool]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(prompt)));
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(tool)));
  assert.notEqual(messageKey(processed[1]), messageKey(tool));
  assert.ok(requests[0].excludeVisibleSourceKeys.includes(messageKey(processed[1])));
});

test("frozen hint records retire only after post-compaction context reconciliation", () => {
  const archive = memoryArchive();
  const preflighted = [];
  const removals = [];
  archive.preflight = (request) => {
    preflighted.push(request.messageKey);
    return { modelVisibleText: "", hints: [] };
  };
  archive.removeHints = (messageKeys, options) => {
    removals.push({ messageKeys: [...messageKeys], options });
    return { removed: messageKeys.length, notFound: 0 };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "hint-lifecycle-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];

  session.process(messages.slice(0, 2), { contextWindow: 200_000 });
  session.process(messages.slice(0, 4), { contextWindow: 200_000 });
  session.process(messages, { contextWindow: 200_000 });

  assert.deepEqual(preflighted, [
    messageKey(messages[0]),
    messageKey(messages[2]),
    messageKey(messages[4]),
  ]);
  assert.deepEqual(removals, [{
    messageKeys: [messageKey(messages[0]), messageKey(messages[2])],
    options: { sessionId: "hint-lifecycle-session" },
  }]);

  session.process(messages, { contextWindow: 200_000 });
  assert.equal(removals.length, 1);
  session.resetAfterCompaction();
  assert.equal(removals.length, 1);
  session.process([]);
  assert.deepEqual(removals[1], {
    messageKeys: [messageKey(messages[4])],
    options: { sessionId: "hint-lifecycle-session" },
  });
});

test("failed frozen hint retirement is retried without failing the live prompt", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({ modelVisibleText: "", hints: [] });
  let attempts = 0;
  archive.removeHints = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary cleanup failure");
    return { removed: 2, notFound: 0 };
  };
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "hint-cleanup-retry-session",
    project: "/project",
  });
  const messages = [
    user("one", 1), assistant("answer one", 2),
    user("two", 3), assistant("answer two", 4),
    user("three", 5), assistant("answer three", 6),
  ];
  session.process(messages.slice(0, 2), { contextWindow: 200_000 });
  session.process(messages.slice(0, 4), { contextWindow: 200_000 });

  const visible = session.process(messages, { contextWindow: 200_000 });
  assert.ok(visible.some((message) => message.role === "user"
    && message.content[0].text === "three"));
  assert.equal(session.status().hintCleanupError, "temporary cleanup failure");

  session.process(messages, { contextWindow: 200_000 });
  assert.equal(attempts, 2);
  assert.equal(Object.hasOwn(session.status(), "hintCleanupError"), false);
});

test("suppressed or failed automatic retrieval adds zero model-visible content", () => {
  const message = user("current status", 1);
  for (let behavior of [
    () => ({ modelVisibleText: "", hints: [] }),
    () => { throw new Error("daemon unavailable"); },
  ]) {
    const archive = memoryArchive();
    let calls = 0;
    archive.preflight = (...args) => {
      calls += 1;
      return behavior(...args);
    };
    const session = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: "no-hint-session",
      project: "/project",
    });
    const visible = session.process([message]);
    assert.deepEqual(visible, [message]);
    assert.equal(session.activeTokens, estimateTokens([message]));

    behavior = () => ({
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    });
    assert.deepEqual(session.process([message]), visible);
    assert.equal(calls, 1);
  }
});

test("failed preflight stays reconstruct-only across rotation, reload, fork, and compaction reset", () => {
  const archive = memoryArchive();
  const requests = [];
  let recovered = false;
  archive.preflight = (request) => {
    requests.push(request);
    if (!recovered) throw new Error("daemon unavailable");
    if (request.reconstruct) throw new Error("no frozen decision");
    return {
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    };
  };
  archive.removeHints = () => ({ removed: 1, notFound: 0 });
  const persisted = [];
  const parent = new EpochWindowSession({
    archive,
    config: {
      ...config,
      automaticRetrieval: true,
      rotationTurns: 2,
      retainTurns: 1,
    },
    sessionId: "failed-parent-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });
  const first = user("What did we decide about archive compaction?", 1);
  const firstAnswer = assistant("I will check.", 2);
  const second = user("How does that decision apply here?", 3);

  assert.deepEqual(parent.process([first]), [first]);
  assert.deepEqual(persisted.at(-1).hintState, {
    version: 1,
    reconstructOnlyMessageKeys: [messageKey(first)],
  });

  const source = [first, firstAnswer, second];
  const rotated = parent.process(source, { contextWindow: 200_000 });
  const durableState = persisted.at(-1);
  assert.equal(durableState.boundaryKey, messageKey(second));
  assert.deepEqual(durableState.hintState.reconstructOnlyMessageKeys, [messageKey(second)]);
  assert.deepEqual(rotated.slice(1), [second]);

  recovered = true;
  const restoreAndProcess = (sessionId, initialSessionIds, state, messages) => {
    const restored = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId,
      initialSessionIds,
      project: "/project",
    });
    restored.restore([{ type: "custom", customType: ROTATION_STATE_ENTRY, data: state }]);
    return restored.process(messages, { contextWindow: 200_000 });
  };

  assert.deepEqual(
    restoreAndProcess("failed-parent-session", [], durableState, source),
    rotated,
  );
  assert.deepEqual(
    restoreAndProcess("failed-child-session", ["failed-parent-session"], durableState, source),
    rotated,
  );

  const compactedState = parent.resetAfterCompaction();
  assert.deepEqual(
    restoreAndProcess("failed-parent-session", [], compactedState, [second]),
    [second],
  );
  assert.ok(requests.slice(-3).every((request) => request.reconstruct === true));
});

test("successful empty-context hint cleanup durably retires reconstruct-only keys", () => {
  for (const hasRemoveHints of [true, false]) {
    const archive = memoryArchive();
    const requests = [];
    archive.preflight = (request) => {
      requests.push(request);
      return { modelVisibleText: "", hints: [] };
    };
    if (hasRemoveHints) {
      archive.removeHints = () => ({ removed: 1, notFound: 0 });
    }
    const persisted = [];
    const message = user(`retire ${hasRemoveHints ? "daemon" : "local"} hint`, 1);
    const session = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: `cleanup-${hasRemoveHints ? "daemon" : "local"}-session`,
      project: "/project",
      onRotation: (state) => persisted.push(structuredClone(state)),
    });

    session.process([message]);
    session.process([]);
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);
    assert.deepEqual(persisted[1].hintState.reconstructOnlyMessageKeys, []);

    const restored = new EpochWindowSession({
      archive,
      config: { ...config, automaticRetrieval: true },
      sessionId: `cleanup-${hasRemoveHints ? "daemon" : "local"}-session`,
      project: "/project",
    });
    restored.restore(persisted.map((data) => ({
      type: "custom",
      customType: ROTATION_STATE_ENTRY,
      data,
    })));
    restored.process([message]);
    assert.equal(requests.at(-1).reconstruct, undefined);
  }
});

test("failed hint cleanup does not persist a removal", () => {
  const archive = memoryArchive();
  archive.preflight = () => ({ modelVisibleText: "", hints: [] });
  let cleanupAttempts = 0;
  archive.removeHints = () => {
    cleanupAttempts += 1;
    throw new Error("cleanup unavailable");
  };
  const persisted = [];
  const message = user("retain failed cleanup state", 1);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "failed-cleanup-state-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });

  session.process([message]);
  session.process([]);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);

  const retryPersisted = [];
  const restored = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "failed-cleanup-state-session",
    project: "/project",
    onRotation: (state) => retryPersisted.push(structuredClone(state)),
  });
  restored.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  restored.process([]);
  assert.equal(cleanupAttempts, 2);
  assert.equal(retryPersisted.length, 0);
  assert.deepEqual(
    restored.rotationState().hintState.reconstructOnlyMessageKeys,
    [messageKey(message)],
  );

  archive.removeHints = () => {
    cleanupAttempts += 1;
    return { removed: 1, notFound: 0 };
  };
  restored.process([]);
  assert.equal(cleanupAttempts, 3);
  assert.equal(retryPersisted.length, 1);
  assert.deepEqual(retryPersisted[0].hintState.reconstructOnlyMessageKeys, []);
});

test("missing preflight capability freezes an empty decision before capability recovery", () => {
  const archive = memoryArchive();
  const persisted = [];
  const message = user("continue the archive design", 1);
  const session = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
    onRotation: (state) => persisted.push(structuredClone(state)),
  });

  assert.deepEqual(session.process([message]), [message]);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].hintState.reconstructOnlyMessageKeys, [messageKey(message)]);

  const removals = [];
  archive.removeHints = (messageKeys) => {
    removals.push([...messageKeys]);
    return { removed: 0, notFound: messageKeys.length };
  };
  const cleanupPersisted = [];
  const inactiveReload = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
    onRotation: (state) => cleanupPersisted.push(structuredClone(state)),
  });
  inactiveReload.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  inactiveReload.process([]);
  assert.deepEqual(removals, [[messageKey(message)]]);
  assert.equal(cleanupPersisted.length, 1);
  assert.deepEqual(cleanupPersisted[0].hintState.reconstructOnlyMessageKeys, []);

  const requests = [];
  archive.preflight = (request) => {
    requests.push(request);
    if (request.reconstruct) throw new Error("no frozen decision");
    return {
      modelVisibleText: "\n\n[ARCHIVED HISTORICAL EVIDENCE — QUOTED DATA] late result",
      hints: [],
    };
  };
  assert.deepEqual(session.process([message]), [message]);
  assert.equal(requests.length, 0);
  assert.equal(persisted.length, 1);

  const restored = new EpochWindowSession({
    archive,
    config: { ...config, automaticRetrieval: true },
    sessionId: "capability-recovery-session",
    project: "/project",
  });
  restored.restore([{
    type: "custom",
    customType: ROTATION_STATE_ENTRY,
    data: persisted[0],
  }]);
  assert.deepEqual(restored.process([message]), [message]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reconstruct, true);
});

