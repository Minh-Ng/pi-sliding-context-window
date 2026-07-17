import { performance } from "node:perf_hooks";
import { hashJson } from "./schema.js";
import { validateEvaluationEnvironment } from "./environment.js";

export const PERFORMANCE_CORPUS_SCALES = Object.freeze([10_000, 100_000, 1_000_000]);
export const PERFORMANCE_CORPUS_SEED = 0x6d2b79f5;

export const PERFORMANCE_CORPUS_PLAN = Object.freeze({
  schemaVersion: 1,
  seed: PERFORMANCE_CORPUS_SEED,
  scales: PERFORMANCE_CORPUS_SCALES,
  distribution: Object.freeze({
    shortConversation: "all records except scheduled tool results",
    toolResult10KiB: "every 1000th logical window",
    toolResult1MiB: "every 10000th logical window",
    repeatedIdentifiers: "deterministically selected from 32 identifiers",
    commonTerms: "present in every logical window",
    coldBuckets: "16 deterministic historical time buckets",
  }),
});

export const PERFORMANCE_CORPUS_PLAN_FINGERPRINT = "sha256:d608f8b215df3a718cef22b3df24781362ec088964351ed34956a580215533c6";

export function assertFrozenPerformanceCorpusPlan() {
  const actual = hashJson(PERFORMANCE_CORPUS_PLAN);
  if (actual !== PERFORMANCE_CORPUS_PLAN_FINGERPRINT) {
    throw new Error(
      `Frozen performance corpus plan fingerprint mismatch: expected ${PERFORMANCE_CORPUS_PLAN_FINGERPRINT}, got ${actual}`,
    );
  }
  return PERFORMANCE_CORPUS_PLAN;
}

assertFrozenPerformanceCorpusPlan();

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function paddedText(prefix, targetBytes) {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  if (prefixBytes >= targetBytes) return prefix;
  return `${prefix}${"x".repeat(targetBytes - prefixBytes)}`;
}

export function* generatePerformanceDocuments({ count, seed = PERFORMANCE_CORPUS_SEED } = {}) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new TypeError("count must be a positive integer");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative integer");
  const random = mulberry32(seed);
  for (let index = 0; index < count; index += 1) {
    const ordinal = index + 1;
    const repeatedIdentifier = `REPEAT_KEY_${String(Math.floor(random() * 32)).padStart(2, "0")}`;
    const bucket = index % 16;
    const base = `logical window ${ordinal} common archive history ${repeatedIdentifier} bucket-${bucket}`;
    const isOneMiB = ordinal % 10_000 === 0;
    const isTenKiB = !isOneMiB && ordinal % 1_000 === 0;
    const kind = isOneMiB || isTenKiB ? "tool-result" : "turn";
    const targetBytes = isOneMiB ? 1024 * 1024 : isTenKiB ? 10 * 1024 : undefined;
    const text = targetBytes
      ? paddedText(`${base} diagnostic payload tail-marker-${ordinal} `, targetBytes)
      : `${base} user request and assistant response about deterministic retrieval.`;
    yield Object.freeze({
      id: `perf-${String(ordinal).padStart(7, "0")}`,
      sessionId: `perf-session-${index % 8}`,
      project: "/fixture/performance",
      kind,
      createdAt: 1_700_000_000_000 - ((15 - bucket) * 86_400_000) + index,
      text,
      metadata: Object.freeze({ bucket, repeatedIdentifier, ordinal }),
    });
  }
}

export function percentile(samples, percentileValue) {
  if (!Array.isArray(samples) || samples.length === 0) throw new TypeError("samples must be a non-empty array");
  if (!samples.every((sample) => Number.isFinite(sample) && sample >= 0)) {
    throw new TypeError("samples must contain only non-negative finite numbers");
  }
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new TypeError("percentile must be from 0 through 1");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(
    ordered.length - 1,
    Math.ceil(percentileValue * ordered.length) - 1,
  ));
  return ordered[index];
}

function summarizeMilliseconds(milliseconds) {
  const totalMilliseconds = milliseconds.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    min: Math.min(...milliseconds),
    mean: totalMilliseconds / milliseconds.length,
    p50: percentile(milliseconds, 0.5),
    p95: percentile(milliseconds, 0.95),
    p99: percentile(milliseconds, 0.99),
    max: Math.max(...milliseconds),
  });
}

export async function measureOperation(operation, { samples = 100, warmup = 10 } = {}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (!Number.isSafeInteger(samples) || samples <= 0) throw new TypeError("samples must be a positive integer");
  if (!Number.isSafeInteger(warmup) || warmup < 0) throw new TypeError("warmup must be a non-negative integer");
  for (let index = 0; index < warmup; index += 1) await operation(index, true);
  const milliseconds = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation(index, false);
    milliseconds.push(performance.now() - startedAt);
  }
  return Object.freeze({
    sampleCount: milliseconds.length,
    warmupCount: warmup,
    milliseconds,
    summary: summarizeMilliseconds(milliseconds),
  });
}

function validateScenario(name, scenario) {
  if (!Number.isSafeInteger(scenario?.sampleCount) || scenario.sampleCount <= 0) {
    throw new TypeError(`scenario ${name} must contain a positive sampleCount`);
  }
  if (!Number.isSafeInteger(scenario.warmupCount) || scenario.warmupCount < 0) {
    throw new TypeError(`scenario ${name} must contain a non-negative warmupCount`);
  }
  if (!Array.isArray(scenario.milliseconds) || scenario.milliseconds.length !== scenario.sampleCount) {
    throw new TypeError(`scenario ${name} milliseconds must match sampleCount`);
  }
  const recomputed = summarizeMilliseconds(scenario.milliseconds);
  if (JSON.stringify(recomputed) !== JSON.stringify(scenario.summary)) {
    throw new Error(`scenario ${name} summary does not match its raw samples`);
  }
}

export function createPerformanceArtifact({ environment, backend, scale, scenarios, notes = [] }) {
  validateEvaluationEnvironment(environment);
  if (!PERFORMANCE_CORPUS_SCALES.includes(scale)) {
    throw new TypeError(`scale must be one of ${PERFORMANCE_CORPUS_SCALES.join(", ")}`);
  }
  if (!backend || typeof backend.id !== "string" || typeof backend.version !== "string") {
    throw new TypeError("backend must contain string id and version fields");
  }
  if (!scenarios || typeof scenarios !== "object" || Array.isArray(scenarios)) {
    throw new TypeError("scenarios must be an object");
  }
  for (const [name, scenario] of Object.entries(scenarios)) validateScenario(name, scenario);
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    throw new TypeError("notes must be an array of strings");
  }
  const artifact = {
    kind: "retrieval-performance",
    schemaVersion: 1,
    generatedAt: environment.capturedAt,
    corpus: {
      scale,
      planFingerprint: PERFORMANCE_CORPUS_PLAN_FINGERPRINT,
    },
    environment,
    backend,
    scenarios,
    notes,
  };
  return Object.freeze({ ...artifact, artifactHash: hashJson(artifact) });
}

export function validatePerformanceArtifact(artifact) {
  if (!artifact || artifact.kind !== "retrieval-performance" || artifact.schemaVersion !== 1) {
    throw new TypeError("artifact must be a retrieval-performance v1 artifact");
  }
  validateEvaluationEnvironment(artifact.environment);
  if (artifact.corpus?.planFingerprint !== PERFORMANCE_CORPUS_PLAN_FINGERPRINT) {
    throw new Error("performance corpus plan fingerprint is stale");
  }
  const rebuilt = createPerformanceArtifact({
    environment: artifact.environment,
    backend: artifact.backend,
    scale: artifact.corpus.scale,
    scenarios: artifact.scenarios,
    notes: artifact.notes,
  });
  if (artifact.artifactHash !== rebuilt.artifactHash) {
    throw new Error("performance artifact hash does not match its canonical content");
  }
  return artifact;
}
