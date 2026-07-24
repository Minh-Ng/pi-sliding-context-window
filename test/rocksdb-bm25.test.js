import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_VISIBLE_SOURCE_KEYS } from "../src/store/store-contract.js";
import { RETRIEVAL_REGRESSION_FIXTURE } from "../eval/retrieval/fixtures.js";
import { scoreRetrievalSuite } from "../eval/retrieval/scoring.js";
import { createSqliteEvaluationBackend } from "../eval/retrieval/sqlite-backend.js";
import { structuralMessageScores } from "../src/structural-annotations.js";
import {
  bm25InverseDocumentFrequency,
  bm25Keys,
  createBm25IndexHandler,
  DEFAULT_BM25_SEARCH_LIMITS,
  readBm25Statistics,
  recomputeBm25Evidence,
  recomputeBm25Score,
  searchBm25,
} from "../src/rocksdb/index/bm25.js";
import {
  bm25Subterms,
  normalizeBm25Term,
  splitBm25Subtokens,
  tokenizeBm25,
  tokenizeBm25Query,
} from "../src/rocksdb/index/tokenizer.js";
import {
  decodeBm25PostingBlock,
  isPostingBlock,
} from "../src/rocksdb/index/posting-block.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { runRetention } from "../src/rocksdb/retention.js";
import { RocksStore } from "../src/rocksdb/store.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-bm25-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(documentId, text, overrides = {}) {
  const version = overrides.version ?? 1;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `bm25:${documentId}:${version}`,
    retentionClass: "conversation-source",
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    ...(overrides.structuralMessages === undefined ? {} : { structuralMessages: overrides.structuralMessages }),
    document: {
      documentId,
      version,
      sourceKey: overrides.sourceKey ?? `assistant:${documentId}`,
      sourceMessageKeys: overrides.sourceMessageKeys ?? [overrides.sourceKey ?? `assistant:${documentId}`],
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? "/fixture/project",
      kind: overrides.kind ?? "turn",
      createdAt: overrides.createdAt ?? 1_700_000_000_000,
      text,
      metadata: overrides.metadata ?? { turnId: `turn-${documentId}` },
    },
  };
}

async function admit(store, documentId, text, overrides) {
  return admitDocument(store, request(documentId, text, overrides), {
    windows: { windowTokens: 100, overlapTokens: 0 },
  });
}

test("tokenizer stems deterministic terms and retains original UTF-8 positions", () => {
  assert.equal(normalizeBm25Term("duplicated"), "duplic");
  assert.equal(normalizeBm25Term("duplicating"), "duplic");
  assert.equal(normalizeBm25Term("reconstruction"), "reconstruct");
  assert.equal(normalizeBm25Term("ＤＵＰＬＩＣＡＴＥＤ"), "duplic");
  assert.deepEqual(tokenizeBm25Query("Duplicated duplicating bytes"), ["duplic", "byte"]);
  assert.deepEqual(
    tokenizeBm25Query("What deployment color are used for canary deploys"),
    ["deploy", "color", "us", "canari", "deploi"],
  );

  const text = "Café 🪨 DUPLICATED/雪";
  const tokens = tokenizeBm25(text);
  assert.deepEqual(tokens.map(({ term, startByte, endByte }) => ({ term, startByte, endByte })), [
    { term: "café", startByte: 0, endByte: 5 },
    { term: "duplic", startByte: 11, endByte: 21 },
    { term: "雪", startByte: 22, endByte: 25 },
  ]);
  for (const token of tokens) {
    assert.equal(Buffer.from(text).subarray(token.startByte, token.endByte).toString(), token.surface);
  }
});

test("subtoken splitting isolates camelCase, PascalCase, acronym, and snake_case pieces", () => {
  assert.deepEqual(splitBm25Subtokens("handleRotationCheckpoint"), ["handle", "Rotation", "Checkpoint"]);
  assert.deepEqual(splitBm25Subtokens("foo_bar"), ["foo", "bar"]);
  assert.deepEqual(splitBm25Subtokens("HTTPServer"), ["HTTP", "Server"]);
  assert.deepEqual(splitBm25Subtokens("getHTTPResponse"), ["get", "HTTP", "Response"]);
  assert.deepEqual(splitBm25Subtokens("_foo"), ["foo"]);
  assert.deepEqual(splitBm25Subtokens("__init__"), ["init"]);
  assert.deepEqual(splitBm25Subtokens("fooBar123Baz"), ["foo", "Bar123", "Baz"]);
  // No internal boundary: a plain word or an acronym-only word does not split.
  assert.deepEqual(splitBm25Subtokens("Foo"), []);
  assert.deepEqual(splitBm25Subtokens("foo"), []);
  assert.deepEqual(splitBm25Subtokens("ID"), []);
  // Non-ASCII case never triggers a boundary itself, but an ASCII hump
  // elsewhere in the word still splits around the non-ASCII run.
  assert.deepEqual(splitBm25Subtokens("café"), []);
  assert.deepEqual(splitBm25Subtokens("naïveBuilder"), ["naïve", "Builder"]);
});

test("bm25Subterms normalizes subtokens and excludes duplicates of the compound term", () => {
  const compound = normalizeBm25Term("handleRotationCheckpoint");
  const subterms = bm25Subterms("handleRotationCheckpoint", compound);
  assert.deepEqual(subterms.map(({ term }) => term), ["handl", "rotat", "checkpoint"]);
  assert.deepEqual(subterms.map(({ surface }) => surface), ["handle", "Rotation", "Checkpoint"]);
  // A word that does not decompose contributes no subterms.
  assert.deepEqual(bm25Subterms("Foo", normalizeBm25Term("Foo")), []);
  // Repeated pieces within one word collapse to a single subterm.
  assert.deepEqual(bm25Subterms("FooFoo", normalizeBm25Term("FooFoo")).map(({ term }) => term), ["foo"]);
});

test("tokenizeBm25 indexes camelCase/snake_case compounds alongside their subtokens", () => {
  const text = "handleRotationCheckpoint foo_bar HTTPServer";
  const tokens = tokenizeBm25(text);
  assert.deepEqual(
    tokens.map(({ term, surface, startByte, endByte }) => ({ term, surface, startByte, endByte })),
    [
      { term: "handlerotationcheckpoint", surface: "handleRotationCheckpoint", startByte: 0, endByte: 24 },
      { term: "handl", surface: "handle", startByte: 0, endByte: 24 },
      { term: "rotat", surface: "Rotation", startByte: 0, endByte: 24 },
      { term: "checkpoint", surface: "Checkpoint", startByte: 0, endByte: 24 },
      { term: "foo_bar", surface: "foo_bar", startByte: 25, endByte: 32 },
      { term: "foo", surface: "foo", startByte: 25, endByte: 32 },
      { term: "bar", surface: "bar", startByte: 25, endByte: 32 },
      { term: "httpserver", surface: "HTTPServer", startByte: 33, endByte: 43 },
      { term: "http", surface: "HTTP", startByte: 33, endByte: 43 },
      { term: "server", surface: "Server", startByte: 33, endByte: 43 },
    ],
  );
  // Query tokenization applies the identical split, in first-occurrence order.
  assert.deepEqual(
    tokenizeBm25Query("handleRotationCheckpoint"),
    ["handlerotationcheckpoint", "handl", "rotat", "checkpoint"],
  );
});

test("BM25 search finds a compound identifier by a camelCase or snake_case subtoken", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "subtokens"));
  t.after(() => store.close());
  await admit(store, "doc-checkpoint", "The daemon calls handleRotationCheckpoint before archiving old_epoch_state.", {
    createdAt: 100,
  });
  await admit(store, "doc-unrelated", "Nothing here discusses rotation or archiving at all.", {
    createdAt: 200,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:subtokens",
    // The IndexWorker context always supplies readSourceRange, so this
    // exercises the production streaming tokenizer path, not tokenizeBm25
    // directly.
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 2);

  const bySubtoken = await searchBm25(store, {
    query: "checkpoint",
    project: "/fixture/project",
    scope: "project",
    limit: 3,
  });
  assert.equal(bySubtoken.results[0]?.documentId, "doc-checkpoint");
  assert.ok(bySubtoken.results[0].matchedTerms.includes("checkpoint"));

  const bySnakeSubtoken = await searchBm25(store, {
    query: "epoch",
    project: "/fixture/project",
    scope: "project",
    limit: 3,
  });
  assert.equal(bySnakeSubtoken.results[0]?.documentId, "doc-checkpoint");

  const byCompound = await searchBm25(store, {
    query: "handleRotationCheckpoint",
    project: "/fixture/project",
    scope: "project",
    limit: 3,
  });
  assert.equal(byCompound.results[0]?.documentId, "doc-checkpoint");
  assert.ok(byCompound.results[0].matchedTerms.includes("handlerotationcheckpoint"));
});

test("IndexWorker publishes complete BM25 generations with recomputable scores", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "generations"));
  t.after(() => store.close());
  await admit(store, "doc-cache", "Persisted historical hints preserve the provider cache prefix during reconstruction.", {
    createdAt: 100,
  });
  await admit(store, "doc-tools", "Immutable chunks prevent duplicated large tool result bytes.", {
    createdAt: 200,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:generations",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 2);

  const statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach", "duplic"],
  });
  assert.equal(statistics.generation, 2);
  assert.equal(statistics.corpus.documentCount, 2);
  assert.equal(statistics.terms.duplic.documentFrequency, 1);

  const response = await searchBm25(store, {
    query: "preserve reconstructed provider cache prefix",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 3,
  });
  assert.equal(response.results[0].documentId, "doc-cache");
  assert.match(response.results[0].snippet, /\[[^\]]+\]/u);
  assert.equal(response.results[0].matchType, "bm25");
  assert.equal(response.results[0].createdAt, 100);
  assert.equal(response.results[0].location.generation, 2);
  assert.equal(response.results[0].locator, null);
  assert.equal(response.results[0].score, recomputeBm25Score(response.results[0].explanation));
  assert.equal(response.results[0].rawScore, response.results[0].score);
  assert.deepEqual(response.results[0].matchedTerms, [
    "cach",
    "prefix",
    "preserv",
    "provid",
    "reconstruct",
  ]);
  assert.equal(response.results[0].termCoverage, 1);
  assert.equal(response.results[0].maxNormalizedIdf, 1);
  assert.ok(response.results[0].termIdf.every(({ normalizedIdf }) => normalizedIdf === 1));
  assert.deepEqual(
    {
      matchedTerms: response.results[0].matchedTerms,
      termCoverage: response.results[0].termCoverage,
      termIdf: response.results[0].termIdf,
      maxNormalizedIdf: response.results[0].maxNormalizedIdf,
    },
    recomputeBm25Evidence(response.results[0].explanation),
  );
  assert.equal(response.results[0].explanation.statisticsGeneration, 2);
  assert.ok(response.results[0].explanation.terms.every(({ positions }) => positions.length > 0));
  const boundedSnippet = await searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
  }, { maxSnippetCharacters: 16 });
  assert.ok(Array.from(boundedSnippet.results[0].snippet).length <= 16);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "session",
  }), /requires sessionId or sessionIds/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    excludeVisibleSourceKeys: "assistant:doc-cache",
  }), /excludeVisibleSourceKeys/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    excludeVisibleSourceKeys: Array.from(
      { length: MAX_VISIBLE_SOURCE_KEYS + 1 },
      (_, index) => `visible-${index}`,
    ),
  }), /at most 1000 items/u);
  await assert.rejects(searchBm25(store, {
    query: "provider cache",
    project: "/fixture/project",
    scope: "project",
    generation: 1,
  }), /current published generation/u);

  const missingPosting = store.scan(bm25Keys.postingPrefix("/fixture/project", "cach"), { limit: 1 })[0];
  await store.remove(missingPosting.key);
  await admit(store, "doc-cache", "Persisted historical hints preserve the provider cache prefix during reconstruction.", {
    createdAt: 100,
    idempotencyKey: "bm25:doc-cache:repair",
  });
  assert.equal((await worker.drain()).processed, 1);
  assert.equal(store.scan(bm25Keys.postingPrefix("/fixture/project", "cach")).length, 1);
  assert.equal((await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach"],
  })).corpus.documentCount, 2);

  await admit(store, "doc-cache", "The replacement discusses only unrelated current runtime state.", {
    version: 2,
    createdAt: 300,
  });
  assert.equal((await worker.drain()).processed, 1);
  const afterReplacement = await searchBm25(store, {
    query: "provider cache prefix",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
  });
  assert.equal(afterReplacement.results.some(({ documentId }) => documentId === "doc-cache"), false);
  assert.equal((await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["cach"],
  })).corpus.documentCount, 2);
  // Generation-addressed postings are immutable. The old posting survives
  // physically and is excluded by the current-version/tombstone overlays.
  assert.equal(store.scan(bm25Keys.postingPrefix("/fixture/project", "cach")).length, 1);

  await store.put([KEYSPACE.SUPERSESSION, "doc-tools", 1], { status: "superseded" });
  const superseded = await searchBm25(store, {
    query: "immutable chunks duplicated tool result",
    project: "/fixture/project",
    scope: "project",
  });
  assert.equal(superseded.results.some(({ documentId }) => documentId === "doc-tools"), false);
});

function windowPayload(store, project, documentId, version, term) {
  return store.scan(bm25Keys.postingPrefix(project, term))
    .map(({ payload }) => isPostingBlock(payload) ? decodeBm25PostingBlock(payload) : payload)
    .find((posting) => posting.documentId === documentId && posting.documentVersion === version)
    ?.window;
}

test("BM25F field weighting boosts user text and suppresses tool output relative to neutral", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "field-weighting"));
  t.after(() => store.close());
  const filler = "noise ".repeat(10);
  const userSentence = "Where is REAP_DRAIN handled?";
  const text = `[user] ${userSentence}\n[tool:bash] ${filler}`;
  await admit(store, "doc-weighted", text, {
    createdAt: 100,
    // No positive question/request/correction/answer score, so this stays on
    // the plain "user" tier rather than being promoted to "structural".
    structuralMessages: [{
      messageKey: "user:weighted",
      messageIndex: 0,
      role: "user",
      createdAt: 100,
      text: userSentence,
      questionScore: 0,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  // Identical bytes, but with no structuralMessages at all: every token must
  // fall back to neutral weight and reproduce the pre-field-weighting numbers.
  await admit(store, "doc-neutral", text, { createdAt: 100 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:field-weighting",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 2);

  const userTerm = "handl";
  const toolTerm = "nois";
  const weightedUserWindow = windowPayload(store, "/fixture/project", "doc-weighted", 1, userTerm);
  const weightedToolWindow = windowPayload(store, "/fixture/project", "doc-weighted", 1, toolTerm);
  const neutralUserWindow = windowPayload(store, "/fixture/project", "doc-neutral", 1, userTerm);
  const neutralToolWindow = windowPayload(store, "/fixture/project", "doc-neutral", 1, toolTerm);

  // A term inside the located user span is weighted up; a term in the
  // unlocated remainder (tool output and message-boundary labels) is
  // weighted down. Both postings see the same raw termFrequency either way.
  assert.equal(weightedUserWindow.termFrequency, neutralUserWindow.termFrequency);
  assert.ok(Math.abs(
    weightedUserWindow.weightedTermFrequency - (weightedUserWindow.termFrequency * 2.25),
  ) < 1e-9);
  assert.equal(weightedToolWindow.termFrequency, neutralToolWindow.termFrequency);
  assert.ok(Math.abs(
    weightedToolWindow.weightedTermFrequency - (weightedToolWindow.termFrequency * 0.4),
  ) < 1e-9);

  // Without any structuralMessages, weighting is a no-op: weighted values
  // equal the raw counts exactly, for both the boosted and the suppressed term.
  assert.equal(neutralUserWindow.weightedTermFrequency, neutralUserWindow.termFrequency);
  assert.equal(neutralToolWindow.weightedTermFrequency, neutralToolWindow.termFrequency);
  assert.equal(neutralUserWindow.weightedLength, neutralUserWindow.length);

  // The tool-heavy filler dominates raw length, so weighting it down pulls
  // the weighted window length below the raw token count.
  assert.ok(weightedUserWindow.weightedLength < weightedUserWindow.length);

  // The short user sentence, once boosted, outranks the byte-identical
  // neutral document for a query naming only its terms.
  const response = await searchBm25(store, {
    query: "REAP_DRAIN handled",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 2,
  });
  assert.equal(response.results[0].documentId, "doc-weighted");
  assert.ok(response.results[0].score > response.results[1].score);
  assert.equal(response.results[0].score, recomputeBm25Score(response.results[0].explanation));
});

test("BM25F treats a decision-candidate document as a uniformly boosted title field", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "decision-candidate-weighting"));
  t.after(() => store.close());
  await admit(store, "decision-a", "The team selected warm-harbor as the release label.", {
    kind: "decision-candidate",
    createdAt: 100,
  });
  await admit(store, "turn-a", "The team selected warm-harbor as the release label.", {
    kind: "turn",
    createdAt: 100,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:decision-weighting",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 2);

  const decisionWindow = windowPayload(store, "/fixture/project", "decision-a", 1, "harbor");
  const turnWindow = windowPayload(store, "/fixture/project", "turn-a", 1, "harbor");
  assert.equal(decisionWindow.weightedTermFrequency, decisionWindow.termFrequency * 2.5);
  assert.equal(decisionWindow.weightedLength, decisionWindow.length * 2.5);
  assert.equal(turnWindow.weightedTermFrequency, turnWindow.termFrequency);
});

test("BM25F promotes a question-scored user message to the structural tier instead of plain user weight", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "structural-promotion"));
  t.after(() => store.close());
  const questionText = "How will background compaction reclaim tombstoned keys?";
  const text = `[user] ${questionText}\n[assistant] It compacts affected ranges after leases expire.`;
  await admit(store, "doc-question", text, {
    createdAt: 100,
    structuralMessages: [{
      messageKey: "user:question",
      messageIndex: 0,
      role: "user",
      createdAt: 100,
      text: questionText,
      questionScore: 100,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:structural-promotion",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 1);

  const window = windowPayload(store, "/fixture/project", "doc-question", 1, "background");
  assert.equal(window.weightedTermFrequency, window.termFrequency * 2.5);
});

test("BM25F keeps write-path fallback scores on the plain role tier and only promotes decisive cues", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "write-path-tiers"));
  t.after(() => store.close());
  // structuralMessageScores is the same function epoch-window.js calls to
  // populate structuralMessages on the write path (not a fabricated
  // all-zero or all-100 fixture). Its fallback scores for ordinary
  // conversational text are never exactly 0 (question/request default to
  // 10, a non-error assistant reply defaults to 75), so this proves the
  // promotion threshold — not just a `> 0` check — is what keeps those
  // spans on the plain user/assistant tier instead of collapsing every
  // located span into the structural tier.
  const statement = "The daemon writes checkpoints under the archive directory.";
  const reply = "Understood, checkpoints land in the archive directory.";
  const statementScores = structuralMessageScores({ role: "user", text: statement });
  const replyScores = structuralMessageScores({
    role: "assistant",
    text: reply,
    isTerminalAssistant: false,
    stopReason: "stop",
  });
  assert.ok(statementScores.question > 0 && statementScores.question < 85);
  assert.ok(replyScores.answer > 0 && replyScores.answer < 85);
  await admit(store, "doc-fallback", `[user] ${statement}\n[assistant] ${reply}`, {
    createdAt: 100,
    structuralMessages: [
      {
        messageKey: "user:fallback",
        messageIndex: 0,
        role: "user",
        createdAt: 100,
        text: statement,
        questionScore: statementScores.question,
        requestScore: statementScores.request,
        correctionScore: statementScores.correction,
        answerScore: statementScores.answer,
      },
      {
        messageKey: "assistant:fallback",
        messageIndex: 1,
        role: "assistant",
        createdAt: 101,
        text: reply,
        questionScore: replyScores.question,
        requestScore: replyScores.request,
        correctionScore: replyScores.correction,
        answerScore: replyScores.answer,
      },
    ],
  });

  const question = "How does the daemon avoid losing writes on crash?";
  const answerScores = structuralMessageScores({
    role: "assistant",
    text: "It fsyncs the write-ahead log before acknowledging.",
    isTerminalAssistant: true,
    stopReason: "stop",
  });
  assert.equal(answerScores.answer, 100);
  await admit(store, "doc-decisive", `[user] ${question}\n[assistant] It fsyncs the write-ahead log before acknowledging.`, {
    createdAt: 100,
    structuralMessages: [
      {
        messageKey: "user:decisive",
        messageIndex: 0,
        role: "user",
        createdAt: 100,
        text: question,
        questionScore: structuralMessageScores({ role: "user", text: question }).question,
        requestScore: 0,
        correctionScore: 0,
        answerScore: 0,
      },
      {
        messageKey: "assistant:decisive",
        messageIndex: 1,
        role: "assistant",
        createdAt: 101,
        text: "It fsyncs the write-ahead log before acknowledging.",
        questionScore: 0,
        requestScore: 0,
        correctionScore: 0,
        answerScore: answerScores.answer,
      },
    ],
  });

  const worker = new IndexWorker(store, {
    workerId: "bm25:test:write-path-tiers",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 2);

  const userWindow = windowPayload(store, "/fixture/project", "doc-fallback", 1, "daemon");
  assert.equal(userWindow.weightedTermFrequency, userWindow.termFrequency * 2.25);
  const assistantWindow = windowPayload(store, "/fixture/project", "doc-fallback", 1, "understood");
  assert.equal(assistantWindow.weightedTermFrequency, assistantWindow.termFrequency * 1.25);

  const promotedUserWindow = windowPayload(store, "/fixture/project", "doc-decisive", 1, "avoid");
  assert.equal(promotedUserWindow.weightedTermFrequency, promotedUserWindow.termFrequency * 2.5);
  const promotedAssistantWindow = windowPayload(store, "/fixture/project", "doc-decisive", 1, "fsync");
  assert.equal(promotedAssistantWindow.weightedTermFrequency, promotedAssistantWindow.termFrequency * 2.5);
});

test("BM25F field weighting is a no-op when structural messages cannot be located", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "unresolved-field-weighting"));
  t.after(() => store.close());
  const text = "The team selected warm-harbor as the release label.";
  await admit(store, "doc-mismatch", text, {
    createdAt: 100,
    // This text never appears in the document, so location resolution fails
    // and must fall back to neutral weighting rather than failing indexing.
    structuralMessages: [{
      messageKey: "user:mismatch",
      messageIndex: 0,
      role: "user",
      createdAt: 100,
      text: "This sentence is not present in the document.",
      questionScore: 0,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:unresolved-field-weighting",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);

  const window = windowPayload(store, "/fixture/project", "doc-mismatch", 1, "harbor");
  assert.equal(window.weightedTermFrequency, window.termFrequency);
  assert.equal(window.weightedLength, window.length);
});

test("BM25 evidence identifies a single common query term without inflating its IDF", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "common-term-evidence"));
  t.after(() => store.close());
  await admit(store, "common-a", "shared alpha", { createdAt: 1 });
  await admit(store, "common-b", "shared beta", { createdAt: 2 });
  await admit(store, "common-c", "shared gamma", { createdAt: 3 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:common-term-evidence",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 3);

  const response = await searchBm25(store, {
    query: "shared",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
    limit: 1,
  });
  const result = response.results[0];
  const expectedIdf = bm25InverseDocumentFrequency(3, 3);
  const maximumIdf = bm25InverseDocumentFrequency(3, 1);
  assert.equal(result.documentId, "common-c");
  assert.equal(result.createdAt, 3);
  assert.equal(result.rawScore, recomputeBm25Score(result.explanation));
  assert.deepEqual(result.matchedTerms, ["share"]);
  assert.equal(result.termCoverage, 1);
  assert.deepEqual(result.termIdf, [{
    term: "share",
    idf: expectedIdf,
    normalizedIdf: expectedIdf / maximumIdf,
  }]);
  assert.equal(result.maxNormalizedIdf, expectedIdf / maximumIdf);
  assert.deepEqual(recomputeBm25Evidence(result.explanation), {
    matchedTerms: result.matchedTerms,
    termCoverage: result.termCoverage,
    termIdf: result.termIdf,
    maxNormalizedIdf: result.maxNormalizedIdf,
  });
});

test("BM25 evidence reports two distinctive terms and partial query coverage", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "distinctive-term-evidence"));
  t.after(() => store.close());
  await admit(store, "distinctive-target", "tablet compaction", { createdAt: 10 });
  await admit(store, "distinctive-other-a", "ordinary routing", { createdAt: 20 });
  await admit(store, "distinctive-other-b", "routine history", { createdAt: 30 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:distinctive-term-evidence",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain()).processed, 3);

  const response = await searchBm25(store, {
    query: "tablet compaction absent",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
    limit: 1,
  });
  const result = response.results[0];
  const distinctiveIdf = 0.9808292530117264;
  assert.equal(result.documentId, "distinctive-target");
  assert.equal(result.rawScore, recomputeBm25Score(result.explanation));
  assert.deepEqual(result.matchedTerms, ["compact", "tablet"]);
  assert.equal(result.termCoverage, 2 / 3);
  assert.deepEqual(result.termIdf, [
    { term: "compact", idf: distinctiveIdf, normalizedIdf: 1 },
    { term: "tablet", idf: distinctiveIdf, normalizedIdf: 1 },
  ]);
  assert.equal(result.maxNormalizedIdf, 1);
  assert.deepEqual(recomputeBm25Evidence(result.explanation), {
    matchedTerms: result.matchedTerms,
    termCoverage: 2 / 3,
    termIdf: result.termIdf,
    maxNormalizedIdf: 1,
  });
});

test("failed publication exposes neither postings nor partial generation statistics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "atomic-publication"));
  t.after(() => store.close());
  await admit(store, "doc-atomic", "Atomic generation statistics and postings publish together.");
  let injected = false;
  const failing = new IndexWorker(store, {
    workerId: "bm25:test:failing",
    handlers: [createBm25IndexHandler()],
    fault(boundary) {
      if (!injected && boundary === "before-publish") {
        injected = true;
        throw new Error("stop before BM25 publication");
      }
    },
  });
  await assert.rejects(failing.processNext(), /before BM25 publication/u);
  assert.equal(store.scan([KEYSPACE.POSTING, "bm25"]).length, 0);

  const restarted = new IndexWorker(store, {
    workerId: "bm25:test:restarted",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await restarted.drain()).processed, 1);
  assert.ok(store.scan([KEYSPACE.POSTING, "bm25"]).length > 0);
  const result = await searchBm25(store, {
    query: "atomic statistics postings",
    project: "/fixture/project",
    scope: "project",
  });
  assert.equal(result.results[0].documentId, "doc-atomic");
});

test("posting work is bounded and visible in search diagnostics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "bounded"));
  t.after(() => store.close());
  for (let index = 0; index < 4; index += 1) {
    await admit(store, `doc-${index}`, `shared term evidence number ${index}`, { createdAt: 100 + index });
  }
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:bounded",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  const response = await searchBm25(store, {
    query: "shared evidence",
    project: "/fixture/project",
    scope: "project",
    limit: 3,
  }, {
    maxPostingRecords: 1,
    maxWindowCandidates: 1,
  });
  assert.equal(response.work.postingRecordsRead, 1);
  assert.equal(response.work.windowCandidates, 1);
  assert.equal(response.work.truncated, true);
});

test("retired BM25 postings do not consume the live posting budget", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "retired-budget"));
  t.after(() => store.close());
  await admit(store, "live-old", "durable lexical budget evidence", { createdAt: 100 });
  await admit(store, "dead-middle", "durable lexical budget evidence", { createdAt: 200 });
  await admit(store, "dead-new", "durable lexical budget evidence", { createdAt: 300 });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:retired-budget",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  for (const documentId of ["dead-middle", "dead-new"]) {
    await store.put([KEYSPACE.SUPERSESSION, documentId, 1], {
      status: "expired",
      reason: "test",
      recordedAt: 400,
    });
  }

  const response = await searchBm25(store, {
    query: "durable lexical budget evidence",
    project: "/fixture/project",
    scope: "project",
  }, { maxPostingRecords: 1 });

  assert.deepEqual(response.results.map(({ documentId }) => documentId), ["live-old"]);
  assert.equal(response.work.postingRecordsRead, 1);
  assert.ok(response.work.postingRecordsScanned >= 3);
});

test("BM25 physical posting work is capped across query terms and locator reads", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "physical-query-budget"));
  t.after(() => store.close());
  for (const [documentId, text, createdAt] of [
    ["physical-alpha", "alpha", 100],
    ["physical-beta", "beta", 200],
    ["physical-gamma", "gamma", 300],
  ]) {
    await admit(store, documentId, text, { createdAt });
  }
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:physical-query-budget",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();

  const project = await searchBm25(store, {
    query: "alpha beta gamma",
    project: "/fixture/project",
    scope: "project",
  }, {
    maxPhysicalPostingRecords: 2,
  });
  assert.equal(project.work.postingRecordsScanned, 2);
  assert.equal(project.work.canonicalPostingsRead, 0);
  assert.equal(project.work.truncated, true);

  const session = await searchBm25(store, {
    query: "alpha beta gamma",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-main"],
  }, {
    maxPhysicalPostingRecords: 2,
  });
  assert.ok(
    session.work.postingRecordsScanned + session.work.canonicalPostingsRead <= 2,
  );
  assert.equal(session.work.truncated, true);
});

test("BM25 snippets never materialize an unbounded logical window", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "bounded-snippet-source"));
  t.after(() => store.close());
  const target = "SNIPPET_RANGE_TARGET";
  const text = `${target} ${"a".repeat(300_000)}`;
  await admitDocument(store, request("doc-bounded-snippet", text), {
    chunking: { maxChunkBytes: 4_096, minLineSplitBytes: 0 },
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:bounded-snippet-source",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  const manifest = await store.get([KEYSPACE.DOCUMENT, "doc-bounded-snippet", 1]);
  assert.equal(store.scan([KEYSPACE.WINDOW, "doc-bounded-snippet", 1], { limit: 10 }).length, 1);
  const contextBytes = DEFAULT_BM25_SEARCH_LIMITS.maxSnippetCharacters * 4;
  const allowedEnd = 2 * contextBytes;
  const allowed = new Set(manifest.chunks
    .filter((reference) => reference.startByte < allowedEnd && reference.endByte > 0)
    .map(({ chunkId }) => chunkId));
  const forbidden = new Set(manifest.chunks
    .map(({ chunkId }) => chunkId)
    .filter((chunkId) => !allowed.has(chunkId)));
  const chunkReads = new Set();
  assert.ok(forbidden.size > 0);
  const guarded = {
    snapshot(callback) {
      return store.snapshot((view) => callback({
        get(key, ...args) {
          if (key[0] === KEYSPACE.CHUNK) {
            chunkReads.add(key[1]);
            if (forbidden.has(key[1])) {
              throw new Error(`BM25 snippet read unrelated chunk ${key[1]}`);
            }
          }
          return view.get(key, ...args);
        },
        scan: view.scan.bind(view),
      }));
    },
  };
  const response = await searchBm25(guarded, {
    query: target,
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-main",
  });
  assert.equal(response.results[0].documentId, "doc-bounded-snippet");
  assert.match(response.results[0].snippet, /SNIPPET_RANGE_TARGET/u);
  assert.ok(chunkReads.size > 0);
  assert.ok([...chunkReads].every((chunkId) => allowed.has(chunkId)));
});

test("session-scoped caps cannot be consumed by newer unauthorized sessions", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "session-cap"));
  t.after(() => store.close());
  await admit(store, "eligible", "shared lexical evidence", {
    sessionId: "session-eligible",
    createdAt: 100,
  });
  await admit(store, "ineligible", "shared lexical evidence", {
    sessionId: "session-other",
    createdAt: 200,
  });
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:session-cap",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  const response = await searchBm25(store, {
    query: "shared lexical evidence",
    project: "/fixture/project",
    scope: "session",
    sessionId: "session-eligible",
  }, { maxPostingRecords: 1 });
  assert.equal(response.work.postingRecordsRead, 1);
  assert.equal(response.results[0].documentId, "eligible");

  await admit(store, "adoc-newest", "shared lexical evidence", {
    sessionId: "session-eligible",
    createdAt: 300,
  });
  await worker.drain();
  const newestAcrossLineage = await searchBm25(store, {
    query: "shared lexical evidence",
    project: "/fixture/project",
    scope: "session",
    sessionIds: ["session-eligible", "session-other"],
  }, { maxPostingRecords: 1 });
  assert.equal(newestAcrossLineage.results[0].documentId, "adoc-newest");
  assert.equal(newestAcrossLineage.work.postingRecordsRead, 1);
  assert.equal(newestAcrossLineage.work.postingRecordsScanned, 3);
});

test("frozen lexical quality is no worse than the SQLite FTS5 baseline", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "lexical-quality"));
  t.after(() => store.close());
  for (const document of RETRIEVAL_REGRESSION_FIXTURE.documents) {
    const admission = {
      idempotencyKey: `fixture:${document.id}`,
      retentionClass: "conversation-source",
      document: {
        documentId: document.id,
        version: 1,
        sourceKey: document.metadata.sourceMessageKeys[0],
        sourceMessageKeys: document.metadata.sourceMessageKeys,
        sessionId: document.sessionId,
        project: document.project,
        kind: document.kind,
        createdAt: document.createdAt,
        text: document.text,
        metadata: document.metadata,
      },
    };
    await admitDocument(store, admission);
  }
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:quality",
    handlers: [createBm25IndexHandler()],
  });
  assert.equal((await worker.drain({ limit: 64 })).processed, RETRIEVAL_REGRESSION_FIXTURE.documents.length);

  const sqlite = createSqliteEvaluationBackend();
  t.after(() => sqlite.close());
  await sqlite.prepare(RETRIEVAL_REGRESSION_FIXTURE);
  const baselineObservations = [];
  const rocksObservations = [];
  for (const evaluationCase of RETRIEVAL_REGRESSION_FIXTURE.suites.lexical) {
    const request = {
      query: evaluationCase.query,
      project: "/fixture/project",
      sessionId: "session-main",
      sessionIds: ["session-main"],
      scope: evaluationCase.scope,
      limit: evaluationCase.limit,
      mode: "lexical",
    };
    const baseline = await sqlite.search(request);
    const rocks = await searchBm25(store, request);
    baselineObservations.push({ id: evaluationCase.id, results: baseline.results });
    rocksObservations.push({ id: evaluationCase.id, results: rocks.results });
  }
  const baseline = scoreRetrievalSuite(
    "lexical",
    RETRIEVAL_REGRESSION_FIXTURE,
    baselineObservations,
  ).metrics;
  const rocks = scoreRetrievalSuite(
    "lexical",
    RETRIEVAL_REGRESSION_FIXTURE,
    rocksObservations,
    { baseline },
  );
  assert.ok(rocks.metrics.recallAt3 >= baseline.recallAt3);
  assert.ok(rocks.metrics.meanReciprocalRank >= baseline.meanReciprocalRank);
  assert.equal(rocks.gate.status, "passed");
});

test("current statistics resolve through O(1) pointers without history scans", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "statistics-pointers"));
  t.after(() => store.close());
  await admit(store, "doc-stats", "current statistics pointer evidence");
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:statistics-pointers",
    handlers: [createBm25IndexHandler()],
  });
  await worker.drain();
  let scans = 0;
  const observedView = {
    get: store.get.bind(store),
    scan(...arguments_) {
      scans += 1;
      return store.scan(...arguments_);
    },
  };
  const statistics = await readBm25Statistics(observedView, {
    project: "/fixture/project",
    terms: ["statist", "pointer"],
  });
  assert.equal(statistics.corpus.documentCount, 1);
  assert.equal(scans, 0);
});

test("a zero-frequency transition remains authoritative for historical generations", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "statistics-zero-history"));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:statistics-zero-history",
    handlers: [createBm25IndexHandler()],
  });
  await admit(store, "history", "historicalterm evidence", { version: 1 });
  await worker.drain({ throwOnError: true });
  await admit(store, "history", "replacement evidence", { version: 2 });
  await worker.drain({ throwOnError: true });
  await admit(store, "other", "historicalterm later evidence");
  await worker.drain({ throwOnError: true });

  const generationTwo = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["historicalterm"],
    generation: 2,
  });
  assert.equal(generationTwo.terms.historicalterm, undefined);
  assert.equal(
    (await store.get(bm25Keys.termStatistics(
      "/fixture/project",
      "historicalterm",
      2,
    ))).documentFrequency,
    0,
  );
});

test("expiring an old version preserves the newer BM25 pointer and final expiry clears statistics", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "versioned-retention"));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:versioned-retention",
    handlers: [createBm25IndexHandler()],
  });
  await admit(store, "versioned", "oldterm historical evidence", {
    version: 1,
    createdAt: 10,
    expiresAt: 100,
  });
  await worker.drain();
  await admit(store, "versioned", "newterm replacement evidence", {
    version: 2,
    createdAt: 20,
    expiresAt: 1_000,
  });
  await worker.drain();
  assert.equal(
    (await store.get(bm25Keys.corpusDelta("/fixture/project", 1))).documentCountDelta,
    1,
  );
  assert.equal(
    (await store.get(bm25Keys.corpusDelta("/fixture/project", 2))).documentCountDelta,
    0,
  );
  assert.equal(
    (await store.get(bm25Keys.termDelta("/fixture/project", "oldterm", 2)))
      .documentFrequencyDelta,
    -1,
  );
  assert.equal(
    (await store.get(bm25Keys.termDelta("/fixture/project", "newterm", 2)))
      .documentFrequencyDelta,
    1,
  );
  assert.ok(store.scan(bm25Keys.postingPrefix("/fixture/project", "oldterm")).length > 0);

  await runRetention(store, { now: 200, force: false, batchSize: 10 });
  const current = await store.get(bm25Keys.current("/fixture/project", "versioned"));
  assert.equal(current.documentVersion, 2);
  assert.equal((await searchBm25(store, {
    query: "newterm",
    project: "/fixture/project",
    scope: "project",
  })).results[0].version, 2);
  let statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["oldterm", "newterm"],
  });
  assert.equal(statistics.corpus.documentCount, 1);
  assert.equal(statistics.terms.oldterm, undefined);
  assert.equal(statistics.terms.newterm.documentFrequency, 1);
  assert.ok(store.scan(bm25Keys.postingPrefix("/fixture/project", "oldterm")).length > 0);

  await runRetention(store, { now: 2_000, force: false, batchSize: 10 });
  statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["newterm"],
  });
  assert.equal(statistics.corpus.documentCount, 0);
  assert.equal(statistics.terms.newterm, undefined);
  assert.equal(await store.get(bm25Keys.current("/fixture/project", "versioned")), undefined);

  await admit(store, "versioned", "rebornterm restored evidence", {
    version: 3,
    createdAt: 3_000,
    expiresAt: 10_000,
  });
  assert.equal((await worker.drain({ throwOnError: true })).processed, 1);
  statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["rebornterm"],
  });
  assert.equal(statistics.corpus.documentCount, 1);
  assert.equal(statistics.terms.rebornterm.documentFrequency, 1);
  assert.equal((await searchBm25(store, {
    query: "rebornterm",
    project: "/fixture/project",
    scope: "project",
  })).results[0].version, 3);
});

test("BM25F weighted corpus statistics survive many expiries in a different order than admission", async (t) => {
  const store = await RocksStore.open(temporaryStorePath(t, "weighted-expiry-order"));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: "bm25:test:weighted-expiry-order",
    handlers: [createBm25IndexHandler()],
  });
  // Fractional field weights (2.5/2.25/1.25/0.4) make each document's
  // weighted length a running float sum. Expiring documents in a different
  // order than they were admitted has previously driven the corpus running
  // total's floating-point residue negative even though the true value is
  // exactly zero once every document is gone.
  const fillerCounts = [7, 19, 3, 41, 11, 23];
  for (const [index, fillerCount] of fillerCounts.entries()) {
    const documentId = `weighted-${index}`;
    const userSentence = `Where does document ${index} keep its state?`;
    const filler = `chatter${index} `.repeat(fillerCount);
    await admit(store, documentId, `[user] ${userSentence}\n[tool:bash] ${filler}`, {
      createdAt: 10,
      // Reverse expiry order relative to admission order: the last document
      // admitted expires first.
      expiresAt: 100 + (fillerCounts.length - 1 - index),
      structuralMessages: [{
        messageKey: `user:${documentId}`,
        messageIndex: 0,
        role: "user",
        createdAt: 10,
        text: userSentence,
        questionScore: 0,
        requestScore: 0,
        correctionScore: 0,
        answerScore: 0,
      }],
    });
  }
  await worker.drain();

  for (let now = 100; now <= 105; now += 1) {
    await assert.doesNotReject(
      runRetention(store, { now, force: false, batchSize: 1 }),
      `retention at now=${now} must not throw on weighted corpus statistics`,
    );
  }
  const statistics = await readBm25Statistics(store, {
    project: "/fixture/project",
    terms: ["chatter0"],
  });
  assert.equal(statistics.corpus.documentCount, 0);
  assert.equal(statistics.corpus.totalWeightedDocumentLength, 0);
});
