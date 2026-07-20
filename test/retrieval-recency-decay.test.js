import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { normalizeModeScore, searchArchive } from "../src/retrieval/search.js";
import { preflightArchive } from "../src/retrieval/preflight.js";
import { gatherArchive } from "../src/retrieval/gather.js";

function callCountingSemantic() {
  return {
    calls: 0,
    async search() {
      this.calls += 1;
      return [];
    },
  };
}
import {
  DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS,
  normalizeRecencyHalfLifeMsByClass,
  recencyDecayMultiplier,
} from "../src/daemon/retention-policy.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

async function fixture(t, name) {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `recency-decay-worker:${name}`,
    maxDrainMs: 30_000,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
    ],
  });
  return { store, worker };
}

function document(id, text, { createdAt, retentionClass }) {
  return {
    idempotencyKey: `recency:${id}`,
    document: {
      documentId: id,
      version: 1,
      sourceKey: `assistant:${id}`,
      sessionId: "session-main",
      project: "/workspace/recency",
      kind: "decision-candidate",
      createdAt,
      text,
      metadata: { turnId: `turn-${id}` },
      sourceMessageKeys: [`assistant:${id}`],
    },
    retentionClass,
  };
}

async function admitTied(store, worker, retentionClassOld, retentionClassNew, now) {
  // Byte-identical text on both documents means BM25 (term frequency, document
  // length, and document frequency) scores the two candidates exactly equal;
  // any ranking difference below is attributable only to recency decay.
  const text = "the retained decision covers durable evidence rollout guardrails";
  await admitDocument(store, document("aaa-old", text, {
    createdAt: now - 60 * DAY_MS,
    retentionClass: retentionClassOld,
  }));
  await admitDocument(store, document("zzz-new", text, {
    createdAt: now - 2 * DAY_MS,
    retentionClass: retentionClassNew,
  }));
  await worker.drain();
}

function searchRequest(overrides = {}) {
  return {
    query: "retained decision durable evidence rollout guardrails",
    relation: null,
    scope: "project",
    sessionIds: [],
    project: "/workspace/recency",
    limit: 3,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 0,
    ...overrides,
  };
}

test("recencyDecayMultiplier: half-life boundary, clamping, and no-decay classes", () => {
  assert.equal(recencyDecayMultiplier({
    retentionClass: "derived-evidence",
    ageMs: DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS["derived-evidence"],
  }), 0.5);
  assert.equal(recencyDecayMultiplier({ retentionClass: "derived-evidence", ageMs: 0 }), 1);
  // A future-dated createdAt (clock skew) is clamped to zero age, not a boost.
  assert.equal(recencyDecayMultiplier({ retentionClass: "derived-evidence", ageMs: -1_000 }), 1);
  assert.equal(recencyDecayMultiplier({ retentionClass: "durable-evidence", ageMs: 365 * DAY_MS }), 1);
  assert.equal(recencyDecayMultiplier({ retentionClass: "active-evidence", ageMs: 365 * DAY_MS }), 1);
  assert.equal(recencyDecayMultiplier({ retentionClass: "unknown-class", ageMs: 365 * DAY_MS }), 1);
  assert.ok(
    recencyDecayMultiplier({ retentionClass: "ephemeral-payload", ageMs: 60 * DAY_MS })
      < recencyDecayMultiplier({ retentionClass: "conversation-source", ageMs: 60 * DAY_MS }),
    "the shorter ephemeral half-life must decay faster than the longer conversation half-life",
  );
});

test("normalizeRecencyHalfLifeMsByClass merges overrides and validates class names", () => {
  const merged = normalizeRecencyHalfLifeMsByClass({ "derived-evidence": 5 * DAY_MS });
  assert.equal(merged["derived-evidence"], 5 * DAY_MS);
  assert.equal(merged["ephemeral-payload"], DEFAULT_RECENCY_HALF_LIFE_MS_BY_CLASS["ephemeral-payload"]);
  assert.throws(() => normalizeRecencyHalfLifeMsByClass({ "not-a-class": DAY_MS }), TypeError);
  assert.throws(() => normalizeRecencyHalfLifeMsByClass({ "derived-evidence": 0 }), TypeError);
  assert.throws(() => normalizeRecencyHalfLifeMsByClass({ "derived-evidence": -1 }), TypeError);
});

test("explicit search leaves BM25 ranking undecayed by default at an equal raw score", async (t) => {
  const { store, worker } = await fixture(t, "search-baseline");
  const now = 100 * DAY_MS;
  await admitTied(store, worker, "derived-evidence", "derived-evidence", now);
  const response = await searchArchive(store, searchRequest(), { now });
  assert.equal(response.mode, "lexical");
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0].rawScore, response.results[1].rawScore);
  // Tied raw scores fall back to documentId order, not recency, confirming the
  // pre-existing gap this task closes: BM25 alone carries no time component.
  assert.equal(response.results[0].documentId, "aaa-old");
  assert.equal(response.results[0].score, normalizeModeScore("lexical", response.results[0].rawScore));
});

test("recencyDecay reranks a tied BM25 score toward the newer derived-evidence candidate", async (t) => {
  const { store, worker } = await fixture(t, "search-decay");
  const now = 100 * DAY_MS;
  await admitTied(store, worker, "derived-evidence", "derived-evidence", now);
  const response = await searchArchive(store, searchRequest(), { now, recencyDecay: true });
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0].documentId, "zzz-new", "the 2-day-old candidate must outrank the 60-day-old one");
  assert.ok(response.results[0].score > response.results[1].score);
  // Raw BM25 evidence stays visible for explainability regardless of the
  // decay-adjusted ranking score.
  assert.equal(response.results[0].rawScore, response.results[1].rawScore);
  assert.notEqual(
    response.results[0].score,
    normalizeModeScore("lexical", response.results[0].rawScore),
    "decay must move the ranking score away from its undecayed calibration",
  );
});

test("durable-evidence never decays even when recencyDecay is requested", async (t) => {
  const { store, worker } = await fixture(t, "search-durable");
  const now = 100 * DAY_MS;
  await admitTied(store, worker, "durable-evidence", "durable-evidence", now);
  const response = await searchArchive(store, searchRequest(), { now, recencyDecay: true });
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0].documentId, "aaa-old", "a null half-life class must keep the undecayed tie-break order");
  assert.equal(response.results[0].score, normalizeModeScore("lexical", response.results[0].rawScore));
  assert.equal(response.results[1].score, normalizeModeScore("lexical", response.results[1].rawScore));
});

test("automatic preflight never applies recency decay", async (t) => {
  const { store, worker } = await fixture(t, "search-preflight");
  const now = 100 * DAY_MS;
  await admitTied(store, worker, "derived-evidence", "derived-evidence", now);
  const decision = await preflightArchive(store, {
    messageKey: "message-1",
    message: "retained decision durable evidence rollout guardrails",
    scope: "project",
    sessionId: "session-main",
    sessionIds: ["session-main"],
    project: "/workspace/recency",
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
    activeHintBudgetTokens: 640,
    activeMessageKeys: ["message-1"],
    hintSourceCooldownMs: 0,
    ephemeralAutoRetrievalDays: 7,
    conversationAutoRetrievalDays: 30,
    derivedAutoRetrievalDays: 30,
    includeDiagnostics: true,
  }, { now });
  // If decay leaked into preflight, the 2-day-old candidate would dominate the
  // ambiguity/continuity decision instead of the alphabetical, undecayed tie.
  assert.equal(decision.diagnostics?.candidate?.documentId, "aaa-old");
});

// gatherArchive forwards its options object to searchArchive unmodified, so
// recencyDecay/now reach the anchor search exactly as they would on the
// explicit search path.
test("gather anchors rerank toward the newer tied candidate when recencyDecay is requested", async (t) => {
  const { store, worker } = await fixture(t, "gather-decay");
  const now = 100 * DAY_MS;
  await admitTied(store, worker, "derived-evidence", "derived-evidence", now);
  // A single-result search limit means only the top-ranked candidate becomes
  // an anchor, so which document survives into evidence depends entirely on
  // decay's rerank of the tied BM25 score, not on the final chronological sort.
  const gatherRequest = {
    query: "retained decision durable evidence rollout guardrails",
    intent: "state",
    scope: "session",
    sessionIds: ["session-main"],
    limit: 1,
    before: 0,
    after: 0,
    neighborhoodAnchors: 1,
    maxEvidence: 1,
    maxTokens: 2_000,
    excludeVisibleSourceKeys: [],
  };
  const undecayed = await gatherArchive(store, gatherRequest, { project: "/workspace/recency", now });
  assert.equal(undecayed.evidence[0]?.document?.documentId, "aaa-old");
  const decayed = await gatherArchive(store, gatherRequest, {
    project: "/workspace/recency",
    now,
    recencyDecay: true,
  });
  assert.equal(
    decayed.evidence[0]?.document?.documentId,
    "zzz-new",
    "the 2-day-old candidate must anchor gather's evidence packet once recencyDecay is requested",
  );
});

// The semantic-broadening cost/behavior gate (shouldTrySemantic) must key off
// the undecayed lexical score. Otherwise enabling recencyDecay on the daemon's
// explicit search path could newly trigger embedding-backed semantic search
// for a query whose raw lexical match was strong, purely because the matching
// evidence happened to be old.
test("recencyDecay does not change whether semantic broadening is triggered", async (t) => {
  const { store, worker } = await fixture(t, "search-decay-gate");
  const now = 100 * DAY_MS;
  // A single, distinctively-worded document with full query coverage and no
  // competing candidates drives the undecayed lexical score comfortably above
  // the default 0.55 semantic-broadening threshold. Its short ephemeral-payload
  // half-life and 30-day age then drive the *decayed* score far below it.
  const text = "quokka zephyrine glimmer paradigm wombat frostbite covenant";
  await admitDocument(store, document("probe-doc", text, {
    createdAt: now - 30 * DAY_MS,
    retentionClass: "ephemeral-payload",
  }));
  await worker.drain();
  const request = searchRequest({ query: text });

  const undecayedSemantic = callCountingSemantic();
  const undecayed = await searchArchive(store, request, { now, semantic: undecayedSemantic });
  assert.ok(
    undecayed.results[0].score >= 0.55,
    "the undecayed lexical score must clear the semantic-broadening threshold for this fixture",
  );
  assert.equal(undecayedSemantic.calls, 0, "a strong undecayed lexical match must not trigger semantic search");
  assert.equal(undecayed.mode, "lexical");

  const decayedSemantic = callCountingSemantic();
  const decayed = await searchArchive(store, request, { now, semantic: decayedSemantic, recencyDecay: true });
  assert.equal(
    decayedSemantic.calls,
    0,
    "recencyDecay must not retroactively trigger semantic search for a query the undecayed score already resolved",
  );
  assert.equal(decayed.mode, "lexical");
  // Decay still reranks the final score even though it left the gate alone.
  assert.ok(decayed.results[0].score < undecayed.results[0].score);
});
