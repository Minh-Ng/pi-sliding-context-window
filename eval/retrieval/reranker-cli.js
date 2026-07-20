#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectEvaluationEnvironment } from "./environment.js";
import { rerankerCorpusFingerprint, RERANKER_CORPUS } from "./reranker-corpus.js";
import {
  RERANKER_DECISION_RULE,
  RERANKER_MEASUREMENT_CAVEAT,
  runRerankerEvaluation,
} from "./reranker-eval.js";
import {
  createCrossEncoderReranker,
  defaultRerankerCacheDir,
  downloadRerankerModel,
  RERANKER_MODEL,
  rerankerDownloadCommand,
} from "./reranker-model.js";

function usage() {
  return [
    "Usage: node eval/retrieval/reranker-cli.js [options]",
    "  --download            Download the pinned cross-encoder into the local cache, then exit",
    "  --output PATH         Also write the eval artifact JSON to PATH",
    "  --cache-dir PATH      Model cache directory (default ~/.cache/context-window-reranker-eval)",
    "  --samples N           Latency samples per query (default 20)",
    "  --warmup N            Latency warmup passes per query (default 3)",
    "  --help                Show this help",
    "",
    `Model: ${RERANKER_MODEL.id} @ ${RERANKER_MODEL.revision} (dtype ${RERANKER_MODEL.dtype}, CPU)`,
  ].join("\n");
}

function parseArguments(argv) {
  const options = { samples: 20, warmup: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--download") options.download = true;
    else if (["--output", "--cache-dir", "--samples", "--warmup"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      index += 1;
      if (argument === "--output") options.output = value;
      else if (argument === "--cache-dir") options.cacheDir = value;
      else if (argument === "--samples") options.samples = Number(value);
      else options.warmup = Number(value);
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.samples) || options.samples <= 0) {
    throw new TypeError("--samples must be a positive integer");
  }
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0) {
    throw new TypeError("--warmup must be a non-negative integer");
  }
  return options;
}

// Emitted when the pinned weights are not cached locally: the harness is
// complete, but the one authorized download must be run to finish the
// measurement. Self-describing so a reviewer sees the contract without the run.
function blockedArtifact(cacheDir, reason) {
  return {
    kind: "reranker-rank-sensitive-eval",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpus: {
      id: RERANKER_CORPUS.corpusId,
      fingerprint: rerankerCorpusFingerprint(),
      documentCount: RERANKER_CORPUS.documents.length,
      caseCount: RERANKER_CORPUS.cases.length,
    },
    reranker: { id: RERANKER_MODEL.id, revision: RERANKER_MODEL.revision },
    decisionRule: RERANKER_DECISION_RULE,
    decision: { verdict: "blocked", reason },
    finishCommand: `${rerankerDownloadCommand()} --cache-dir ${cacheDir}`,
    caveat: RERANKER_MEASUREMENT_CAVEAT,
  };
}

function emit(artifact, output) {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) writeFileSync(resolve(output), json);
  process.stdout.write(json);
}

function summarize(artifact) {
  const { verdict } = artifact.decision;
  if (verdict === "blocked") {
    return `reranker eval BLOCKED: ${artifact.decision.reason}\nFinish with: ${artifact.finishCommand}`;
  }
  const { metrics, latency } = artifact;
  return [
    `reranker eval verdict: ${verdict.toUpperCase()}`,
    `  hard cases: ${artifact.hardCase.count}/${artifact.hardCase.total} (${artifact.hardCase.contract})`,
    `  Recall@3: ${metrics.baseline.recallAt3} -> ${metrics.rerank.recallAt3} (${metrics.delta.recallAt3Absolute >= 0 ? "+" : ""}${metrics.delta.recallAt3Absolute} abs)`,
    `  MRR: ${metrics.baseline.meanReciprocalRank} -> ${metrics.rerank.meanReciprocalRank} (${artifact.decision.criteria.relativeMrrGain} rel)`,
    `  rerank latency p50/p95: ${latency.p50Ms}ms / ${latency.p95Ms}ms for ${latency.candidateWindow} candidates`,
    `  rule: MRR>=${RERANKER_DECISION_RULE.minRelativeMrrGain} rel OR Recall@3>=${RERANKER_DECISION_RULE.minAbsoluteRecallAt3Gain} abs, AND p50<=${RERANKER_DECISION_RULE.maxP50LatencyMs}ms -> ${verdict.toUpperCase()}`,
    `  caveat: ${artifact.caveat}`,
  ].join("\n");
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const cacheDir = options.cacheDir ?? defaultRerankerCacheDir();
  if (options.download) {
    const result = await downloadRerankerModel({ cacheDir });
    process.stderr.write(`downloaded ${result.model} @ ${result.revision} to ${result.cacheDir} in ${Math.round(result.elapsedMs)}ms\n`);
    return 0;
  }
  let reranker;
  try {
    reranker = await createCrossEncoderReranker({ cacheDir, allowRemote: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const artifact = blockedArtifact(cacheDir, `pinned reranker weights are not cached locally: ${reason}`);
    emit(artifact, options.output);
    process.stderr.write(`${summarize(artifact)}\n`);
    return 2;
  }
  try {
    const artifact = await runRerankerEvaluation({
      reranker,
      environment: collectEvaluationEnvironment(),
      samples: options.samples,
      warmup: options.warmup,
    });
    emit(artifact, options.output);
    process.stderr.write(`${summarize(artifact)}\n`);
    return 0;
  } finally {
    await reranker.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
