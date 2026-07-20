import assert from "node:assert/strict";
import test from "node:test";
import {
  RERANKER_CORPUS,
  rerankerCorpusFingerprint,
  rerankerDocumentText,
} from "../eval/retrieval/reranker-corpus.js";
import {
  RERANKER_DECISION_RULE,
  collectRerankerBaseline,
  decideReranker,
  prepareRerankerStore,
  rerankBaseline,
  runRerankerEvaluation,
  scoreReranker,
} from "../eval/retrieval/reranker-eval.js";

// Deterministic stand-ins for the cross-encoder so the harness, hard-case
// contract, scoring, and decision rule are all tested without a model
// download. The real model is exercised only through reranker-cli.js.

// Perfect reranker: scores the case's true target highest. Keyed on query so it
// works purely from the (query, passages) signature the harness passes.
function oracleReranker(corpus = RERANKER_CORPUS) {
  const targetTextByQuery = new Map();
  const documentText = rerankerDocumentText();
  for (const evaluationCase of corpus.cases) {
    targetTextByQuery.set(evaluationCase.query, documentText.get(evaluationCase.targetDocumentId));
  }
  return {
    metadata: { id: "oracle-stub", revision: "test" },
    async score(query, passages) {
      const targetText = targetTextByQuery.get(query);
      return passages.map((passage, index) => (passage === targetText ? 1_000 : -index));
    },
    async close() {},
  };
}

// Order-preserving reranker: returns strictly decreasing scores in input order,
// so the reranked order equals the fused baseline order (no lift).
function identityReranker() {
  return {
    metadata: { id: "identity-stub", revision: "test" },
    async score(query, passages) {
      return passages.map((_passage, index) => -index);
    },
    async close() {},
  };
}

test("rank-sensitive corpus is internally consistent and stably fingerprinted", () => {
  const ids = RERANKER_CORPUS.documents.map((document) => document.id);
  assert.equal(new Set(ids).size, ids.length, "document ids must be unique");
  const documentText = rerankerDocumentText();
  for (const evaluationCase of RERANKER_CORPUS.cases) {
    assert.ok(documentText.has(evaluationCase.targetDocumentId), `target text present for ${evaluationCase.id}`);
    assert.ok(ids.includes(evaluationCase.targetDocumentId), `target document present for ${evaluationCase.id}`);
  }
  assert.match(rerankerCorpusFingerprint(), /^sha256:[a-f0-9]{64}$/);
  assert.equal(rerankerCorpusFingerprint(), rerankerCorpusFingerprint());
});

test("every case is empirically hard: target in BM25 top-50 but out of the fused top-3", async () => {
  const harness = await prepareRerankerStore();
  try {
    const baseline = await collectRerankerBaseline(harness);
    assert.equal(baseline.length, RERANKER_CORPUS.cases.length);
    for (const observation of baseline) {
      assert.ok(observation.inBm25Top50, `${observation.id}: target must be in BM25 top-50 (rank ${observation.bm25Rank})`);
      assert.ok(!observation.inFusedTop3, `${observation.id}: target must be out of fused top-3 (rank ${observation.baselineRank})`);
      assert.ok(observation.inRerankWindow, `${observation.id}: target must be inside the rerank window (rank ${observation.baselineRank})`);
      assert.ok(observation.hardCase, `${observation.id}: must satisfy the hard-case contract`);
    }
  } finally {
    await harness.close();
  }
});

test("scoring credits an oracle rerank and reports zero lift for an order-preserving rerank", async () => {
  const harness = await prepareRerankerStore();
  let baseline;
  try {
    baseline = await collectRerankerBaseline(harness);
  } finally {
    await harness.close();
  }

  const oracleCases = await rerankBaseline(baseline, oracleReranker());
  const oracleMetrics = scoreReranker(oracleCases);
  assert.equal(oracleMetrics.baseline.recallAt3, 0, "hard-case baseline recall is zero");
  assert.equal(oracleMetrics.rerank.recallAt3, 1, "oracle recovers every target into the top-3");
  assert.ok(oracleMetrics.rerank.meanReciprocalRank > oracleMetrics.baseline.meanReciprocalRank);
  assert.ok(oracleCases.every((scored) => scored.rerankRank === 1), "oracle ranks every target first");

  const identityCases = await rerankBaseline(baseline, identityReranker());
  const identityMetrics = scoreReranker(identityCases);
  assert.equal(identityMetrics.delta.recallAt3Absolute, 0, "order-preserving rerank changes nothing");
  assert.equal(identityMetrics.delta.meanReciprocalRankAbsolute, 0);
  for (const scored of identityCases) {
    assert.equal(scored.rerankRank, scored.baselineRank, `${scored.id}: identity rerank preserves rank`);
  }
});

test("decision rule applies BUILD/PARK mechanically, including the zero-baseline MRR branch", () => {
  const fastLatency = { p50Ms: 200, p95Ms: 400 };
  const slowLatency = { p50Ms: 2_000, p95Ms: 3_000 };

  // Zero baseline MRR with positive rerank MRR => infinite relative gain => BUILD.
  const recovered = scoreReranker([
    { baselineRecalledAt3: false, rerankRecalledAt3: true, baselineReciprocalRank: 0, rerankReciprocalRank: 1 },
    { baselineRecalledAt3: false, rerankRecalledAt3: true, baselineReciprocalRank: 0, rerankReciprocalRank: 0.5 },
  ]);
  assert.equal(recovered.delta.meanReciprocalRankRelative, Number.POSITIVE_INFINITY);
  assert.equal(decideReranker(recovered, fastLatency).verdict, "build");
  // Same quality, but latency over budget => PARK.
  assert.equal(decideReranker(recovered, slowLatency).verdict, "park");

  // Small absolute Recall@3 lift below both thresholds => PARK.
  const marginal = scoreReranker([
    { baselineRecalledAt3: false, rerankRecalledAt3: false, baselineReciprocalRank: 0.2, rerankReciprocalRank: 0.205 },
  ]);
  assert.ok(marginal.delta.recallAt3Absolute < RERANKER_DECISION_RULE.minAbsoluteRecallAt3Gain);
  assert.ok(marginal.delta.meanReciprocalRankRelative < RERANKER_DECISION_RULE.minRelativeMrrGain);
  assert.equal(decideReranker(marginal, fastLatency).verdict, "park");

  // Recall@3 lift clears the absolute bar even though relative MRR is small => BUILD.
  const recallDriven = scoreReranker([
    { baselineRecalledAt3: false, rerankRecalledAt3: true, baselineReciprocalRank: 0.25, rerankReciprocalRank: 0.26 },
    { baselineRecalledAt3: false, rerankRecalledAt3: false, baselineReciprocalRank: 0.25, rerankReciprocalRank: 0.25 },
  ]);
  const recallDecision = decideReranker(recallDriven, fastLatency);
  assert.ok(recallDecision.criteria.absoluteRecallAt3GainMet);
  assert.equal(recallDecision.verdict, "build");
});

test("end-to-end eval with an oracle stub yields a well-formed BUILD artifact", async () => {
  const artifact = await runRerankerEvaluation({
    reranker: oracleReranker(),
    samples: 2,
    warmup: 1,
    environment: { note: "test" },
  });
  assert.equal(artifact.kind, "reranker-rank-sensitive-eval");
  assert.equal(artifact.hardCase.allSatisfied, true);
  assert.equal(artifact.hardCase.count, RERANKER_CORPUS.cases.length);
  assert.equal(artifact.metrics.rerank.recallAt3, 1);
  assert.equal(artifact.decision.verdict, "build");
  assert.ok(Number.isFinite(artifact.latency.p50Ms) && artifact.latency.p50Ms >= 0);
  assert.equal(artifact.latency.candidateWindow, RERANKER_DECISION_RULE.candidateWindow);
  for (const perQuery of artifact.latency.perQuery) {
    assert.equal(perQuery.candidateCount, RERANKER_DECISION_RULE.candidateWindow);
  }
  assert.equal(artifact.corpus.fingerprint, rerankerCorpusFingerprint());
});
