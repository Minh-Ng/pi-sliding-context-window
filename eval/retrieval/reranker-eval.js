import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBm25IndexHandler, searchBm25 } from "../../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../../src/rocksdb/index/structural.js";
import { createImportanceIndexHandler } from "../../src/rocksdb/index/importance.js";
import { IndexWorker } from "../../src/rocksdb/indexer.js";
import { admitDocument } from "../../src/rocksdb/manifests.js";
import { RocksStore } from "../../src/rocksdb/store.js";
import { searchArchive } from "../../src/retrieval/search.js";
import { RERANKER_CORPUS, rerankerCorpusFingerprint, rerankerDocumentText } from "./reranker-corpus.js";
import { collectEvaluationEnvironment } from "./environment.js";
import { percentile } from "./performance.js";

const RERANKER_EVAL_SCHEMA_VERSION = 1;

// Decision rule for the deferred cross-encoder task (#2), applied mechanically
// from the measured numbers. BUILD when the rerank improves MRR by at least
// this relative fraction OR Recall@3 by at least this absolute margin, AND the
// p50 rerank latency for a full candidate window stays within the budget.
export const RERANKER_DECISION_RULE = Object.freeze({
  minRelativeMrrGain: 0.10,
  minAbsoluteRecallAt3Gain: 0.05,
  maxP50LatencyMs: 1_500,
  candidateWindow: 40,
});

// Stated in the artifact and the summary so the number is never read as a
// live-traffic estimate: this suite measures reranker capability on
// constructed hard cases, not how often real sessions land on them.
export const RERANKER_MEASUREMENT_CAVEAT =
  "This measures reranker capability on constructed hard cases (target in BM25 top-50 but out of the fused top-3). "
  + "How often real sessions actually hit such cases is a separate question answered by the live relevance-feedback log, not by this suite.";

function round(value, places = 6) {
  return Number(Number(value).toFixed(places));
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function utf8ScalarTokens(text) {
  const tokens = [];
  let startByte = 0;
  for (const value of text) {
    const endByte = startByte + Buffer.byteLength(value, "utf8");
    tokens.push(Object.freeze({ value, startByte, endByte }));
    startByte = endByte;
  }
  return Object.freeze(tokens);
}

function admissionRequest(document) {
  const messageKeys = document.metadata?.sourceMessageKeys ?? [`eval:${document.id}`];
  return {
    idempotencyKey: `reranker:${RERANKER_CORPUS.corpusId}:${document.id}:1`,
    document: {
      documentId: document.id,
      version: 1,
      sourceKey: messageKeys[0],
      sourceMessageKeys: messageKeys,
      sessionId: document.sessionId,
      project: document.project,
      kind: document.kind,
      createdAt: document.createdAt,
      text: document.text,
      metadata: structuredClone(document.metadata),
    },
    structuralMessages: [],
    retentionClass: "conversation-source",
  };
}

function admissionOptions() {
  return {
    chunking: {
      maxChunkBytes: RERANKER_CORPUS.chunking.targetBytes,
      minLineSplitBytes: 0,
    },
    windows: {
      windowTokens: RERANKER_CORPUS.chunking.targetBytes,
      overlapTokens: RERANKER_CORPUS.chunking.overlapBytes,
      tokenize: utf8ScalarTokens,
    },
  };
}

async function drainUntilIdle(worker) {
  for (;;) {
    const result = await worker.drain({ limit: 4_096, maxDurationMs: 60_000, throwOnError: true });
    if (result.terminal === "idle") return;
    if (result.terminal !== "limit") throw new Error(`reranker index drain stopped at ${result.terminal}.`);
  }
}

/**
 * Open a temporary RocksDB archive, admit the rank-sensitive corpus, and expose
 * exactly the two search surfaces the eval compares against: the full
 * production fused ranking (exact tier + RRF + recency decay + importance
 * prior, matching the daemon's explicit store.search options) and the raw BM25
 * ranking used to prove each target is inside the lexical top-50.
 */
export async function prepareRerankerStore(corpus = RERANKER_CORPUS) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-reranker-eval-"));
  let store;
  let worker;
  try {
    store = await RocksStore.open(join(directory, "archive.rocks"));
    worker = new IndexWorker(store, {
      workerId: `reranker-eval:${process.pid}`,
      maxDrainMs: 60_000,
      handlers: [
        createExactIndexHandler(),
        createBm25IndexHandler(),
        createStructuralIndexHandler(),
        createImportanceIndexHandler(),
      ],
    });
    const options = admissionOptions();
    for (const document of corpus.documents) {
      await admitDocument(store, admissionRequest(document), options);
    }
    await drainUntilIdle(worker);
  } catch (error) {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    // Full fused baseline: the exact option set the daemon's explicit search
    // path passes (src/daemon/operations.js), minus the optional semantic
    // fallback the spec's baseline definition excludes.
    async fusedSearch(query, { limit, now = corpus.now } = {}) {
      const response = await searchArchive(store, {
        query,
        relation: null,
        scope: "session",
        sessionId: corpus.session,
        sessionIds: [corpus.session],
        project: corpus.project,
        limit,
        excludeVisibleSourceKeys: [],
        hintBudgetTokens: 4_000,
      }, {
        allowExpansion: true,
        applyImportancePrior: true,
        recencyDecay: true,
        expandSnippetsToBudget: true,
        now,
        ownerId: `reranker-eval:fused:${query}`,
      });
      return response.results.map((result) => ({
        documentId: result.documentId,
        score: result.score,
        retrievalMode: result.retrievalMode,
        snippet: result.snippet,
      }));
    },
    async bm25Ranking(query, { limit } = {}) {
      const response = await searchBm25(store, {
        query,
        project: corpus.project,
        scope: "session",
        sessionIds: [corpus.session],
        excludeVisibleSourceKeys: [],
        limit,
      });
      return response.results.map((result) => result.documentId);
    },
    async close() {
      try {
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function rankOf(documentIds, targetId) {
  const index = documentIds.indexOf(targetId);
  return index < 0 ? 0 : index + 1;
}

/**
 * Measure each case's baseline position without any model: the fused ranking,
 * the target's fused rank, its BM25 rank, and whether it satisfies the
 * hard-case contract (inside BM25 top-50, outside fused top-3). Used both by
 * the full eval and by the test that guards fixture hardness.
 */
export async function collectRerankerBaseline(harness, corpus = RERANKER_CORPUS) {
  const observations = [];
  for (const evaluationCase of corpus.cases) {
    const fused = await harness.fusedSearch(evaluationCase.query, { limit: evaluationCase.fusedLimit });
    const bm25 = await harness.bm25Ranking(evaluationCase.query, { limit: evaluationCase.bm25Limit });
    const fusedDocumentIds = fused.map((result) => result.documentId);
    const bm25Rank = rankOf(bm25, evaluationCase.targetDocumentId);
    const baselineRank = rankOf(fusedDocumentIds, evaluationCase.targetDocumentId);
    observations.push(Object.freeze({
      id: evaluationCase.id,
      query: evaluationCase.query,
      targetDocumentId: evaluationCase.targetDocumentId,
      rerankWindow: evaluationCase.rerankWindow,
      fused,
      fusedDocumentIds,
      bm25Rank,
      baselineRank,
      inBm25Top50: bm25Rank >= 1 && bm25Rank <= evaluationCase.bm25Limit,
      inFusedTop3: baselineRank >= 1 && baselineRank <= 3,
      inRerankWindow: baselineRank >= 1 && baselineRank <= evaluationCase.rerankWindow,
      hardCase: bm25Rank >= 1 && bm25Rank <= evaluationCase.bm25Limit
        && !(baselineRank >= 1 && baselineRank <= 3),
    }));
  }
  return observations;
}

function reciprocalRank(rank) {
  return rank > 0 ? 1 / rank : 0;
}

/**
 * Rerank each case's fused candidate window (top-40) with the injected
 * cross-encoder scorer, scoring full canonical candidate text so the
 * measurement is independent of snippet-budget tuning. Returns per-case ranks
 * before and after reranking.
 */
export async function rerankBaseline(baseline, reranker, documentText = rerankerDocumentText()) {
  const cases = [];
  for (const observation of baseline) {
    const window = observation.fusedDocumentIds.slice(0, observation.rerankWindow);
    const passages = window.map((documentId) => documentText.get(documentId) ?? "");
    const scores = window.length > 0 ? await reranker.score(observation.query, passages) : [];
    const reranked = window
      .map((documentId, index) => ({ documentId, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId));
    const rerankedDocumentIds = reranked.map((entry) => entry.documentId);
    const rerankRank = rankOf(rerankedDocumentIds, observation.targetDocumentId);
    cases.push(Object.freeze({
      id: observation.id,
      targetDocumentId: observation.targetDocumentId,
      bm25Rank: observation.bm25Rank,
      baselineRank: observation.baselineRank,
      rerankRank,
      windowSize: window.length,
      baselineRecalledAt3: observation.baselineRank >= 1 && observation.baselineRank <= 3,
      rerankRecalledAt3: rerankRank >= 1 && rerankRank <= 3,
      baselineReciprocalRank: round(reciprocalRank(observation.baselineRank)),
      rerankReciprocalRank: round(reciprocalRank(rerankRank)),
      rerankedDocumentIds,
    }));
  }
  return cases;
}

export function scoreReranker(rerankedCases) {
  const baselineRecallAt3 = round(mean(rerankedCases.map(({ baselineRecalledAt3 }) => Number(baselineRecalledAt3))));
  const rerankRecallAt3 = round(mean(rerankedCases.map(({ rerankRecalledAt3 }) => Number(rerankRecalledAt3))));
  const baselineMrr = round(mean(rerankedCases.map(({ baselineReciprocalRank }) => baselineReciprocalRank)));
  const rerankMrr = round(mean(rerankedCases.map(({ rerankReciprocalRank }) => rerankReciprocalRank)));
  return Object.freeze({
    caseCount: rerankedCases.length,
    baseline: Object.freeze({ recallAt3: baselineRecallAt3, meanReciprocalRank: baselineMrr }),
    rerank: Object.freeze({ recallAt3: rerankRecallAt3, meanReciprocalRank: rerankMrr }),
    delta: Object.freeze({
      recallAt3Absolute: round(rerankRecallAt3 - baselineRecallAt3),
      meanReciprocalRankAbsolute: round(rerankMrr - baselineMrr),
      // Relative MRR gain is undefined when the baseline MRR is 0; report
      // Infinity so the decision rule still fires the "any positive lift beats
      // a zero baseline" branch rather than dividing by zero.
      meanReciprocalRankRelative: baselineMrr > 0
        ? round((rerankMrr - baselineMrr) / baselineMrr)
        : (rerankMrr > 0 ? Number.POSITIVE_INFINITY : 0),
    }),
  });
}

/**
 * Apply the frozen decision rule mechanically to the measured metrics and
 * latency. Returns the verdict plus the individual criteria so the artifact
 * shows exactly why it landed on BUILD or PARK.
 */
export function decideReranker(metrics, latency, rule = RERANKER_DECISION_RULE) {
  const relativeMrrGain = metrics.delta.meanReciprocalRankRelative;
  const absoluteRecallGain = metrics.delta.recallAt3Absolute;
  const mrrCriterionMet = relativeMrrGain >= rule.minRelativeMrrGain;
  const recallCriterionMet = absoluteRecallGain >= rule.minAbsoluteRecallAt3Gain;
  const qualityCriterionMet = mrrCriterionMet || recallCriterionMet;
  const latencyCriterionMet = Number.isFinite(latency.p50Ms) && latency.p50Ms <= rule.maxP50LatencyMs;
  const verdict = qualityCriterionMet && latencyCriterionMet ? "build" : "park";
  return Object.freeze({
    verdict,
    rule,
    criteria: Object.freeze({
      relativeMrrGain: relativeMrrGain === Number.POSITIVE_INFINITY ? "infinite" : round(relativeMrrGain),
      relativeMrrGainMet: mrrCriterionMet,
      absoluteRecallAt3Gain: absoluteRecallGain,
      absoluteRecallAt3GainMet: recallCriterionMet,
      qualityCriterionMet,
      p50LatencyMs: latency.p50Ms,
      latencyCriterionMet,
    }),
    rationale: verdict === "build"
      ? "Rerank cleared the quality bar (MRR or Recall@3) and the p50 latency budget on this machine."
      : latencyCriterionMet
        ? "Rerank did not clear the quality bar (neither the relative MRR nor the absolute Recall@3 threshold)."
        : "Rerank p50 latency exceeded the budget for a full candidate window on this machine.",
  });
}

// Pad each case's candidate window to exactly `candidateWindow` passages (using
// the rest of the corpus as filler) so the latency figure reflects a full
// reranker window regardless of how many candidates a given query fused.
function latencyBatch(observation, documentText, candidateWindow) {
  const passages = observation.fusedDocumentIds
    .slice(0, candidateWindow)
    .map((documentId) => documentText.get(documentId) ?? "");
  if (passages.length >= candidateWindow) return passages.slice(0, candidateWindow);
  const filler = [...documentText.values()].filter((text) => !passages.includes(text));
  let index = 0;
  while (passages.length < candidateWindow && index < filler.length) {
    passages.push(filler[index]);
    index += 1;
  }
  return passages;
}

async function measureRerankLatency(baseline, reranker, documentText, { samples, warmup, candidateWindow }) {
  const perQuery = [];
  const allSamples = [];
  for (const observation of baseline) {
    const passages = latencyBatch(observation, documentText, candidateWindow);
    for (let index = 0; index < warmup; index += 1) await reranker.score(observation.query, passages);
    const durations = [];
    for (let index = 0; index < samples; index += 1) {
      const startedAt = performance.now();
      await reranker.score(observation.query, passages);
      const elapsed = performance.now() - startedAt;
      durations.push(elapsed);
      allSamples.push(elapsed);
    }
    perQuery.push(Object.freeze({
      id: observation.id,
      candidateCount: passages.length,
      p50Ms: round(percentile(durations, 0.5), 3),
      p95Ms: round(percentile(durations, 0.95), 3),
    }));
  }
  return Object.freeze({
    candidateWindow,
    sampleCount: allSamples.length,
    samplesPerQuery: samples,
    warmupPerQuery: warmup,
    p50Ms: round(percentile(allSamples, 0.5), 3),
    p95Ms: round(percentile(allSamples, 0.95), 3),
    perQuery: Object.freeze(perQuery),
  });
}

/**
 * Full offline reranker evaluation: prepare the corpus, measure the fused
 * baseline, verify each case's hardness empirically, rerank with the injected
 * cross-encoder, score Recall@3 / MRR, measure per-query rerank latency, and
 * apply the decision rule. The reranker is injected so the test suite can drive
 * this deterministically without a model download.
 */
export async function runRerankerEvaluation({
  reranker,
  corpus = RERANKER_CORPUS,
  samples = 20,
  warmup = 3,
  environment,
} = {}) {
  if (!reranker || typeof reranker.score !== "function") {
    throw new TypeError("runRerankerEvaluation requires a reranker with a score(query, passages) method");
  }
  const documentText = rerankerDocumentText();
  const harness = await prepareRerankerStore(corpus);
  let baseline;
  let rerankedCases;
  let latency;
  try {
    baseline = await collectRerankerBaseline(harness, corpus);
    rerankedCases = await rerankBaseline(baseline, reranker, documentText);
    latency = await measureRerankLatency(baseline, reranker, documentText, {
      samples,
      warmup,
      candidateWindow: RERANKER_DECISION_RULE.candidateWindow,
    });
  } finally {
    await harness.close();
  }
  const metrics = scoreReranker(rerankedCases);
  const decision = decideReranker(metrics, latency);
  const hardCaseCount = baseline.filter(({ hardCase }) => hardCase).length;
  return Object.freeze({
    kind: "reranker-rank-sensitive-eval",
    schemaVersion: RERANKER_EVAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    corpus: Object.freeze({
      id: corpus.corpusId,
      fingerprint: rerankerCorpusFingerprint(),
      documentCount: corpus.documents.length,
      caseCount: corpus.cases.length,
      now: corpus.now,
    }),
    reranker: reranker.metadata ?? Object.freeze({ id: "injected", revision: "n/a" }),
    environment: environment ?? collectEvaluationEnvironment(),
    hardCase: Object.freeze({
      count: hardCaseCount,
      total: baseline.length,
      allSatisfied: hardCaseCount === baseline.length,
      contract: "target is inside the BM25 top-50 and outside the fused top-3 at baseline",
    }),
    baselineObservations: Object.freeze(baseline.map((observation) => Object.freeze({
      id: observation.id,
      targetDocumentId: observation.targetDocumentId,
      bm25Rank: observation.bm25Rank,
      baselineFusedRank: observation.baselineRank,
      inBm25Top50: observation.inBm25Top50,
      inFusedTop3: observation.inFusedTop3,
      inRerankWindow: observation.inRerankWindow,
      hardCase: observation.hardCase,
    }))),
    cases: Object.freeze(rerankedCases),
    metrics,
    latency,
    decision,
    caveat: RERANKER_MEASUREMENT_CAVEAT,
  });
}
