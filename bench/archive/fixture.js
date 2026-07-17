import { createHash } from "node:crypto";
import {
  PERFORMANCE_CORPUS_PLAN_FINGERPRINT,
  PERFORMANCE_CORPUS_SEED,
} from "../../eval/retrieval/performance.js";
import { hashJson } from "../../eval/retrieval/schema.js";

export const ARCHIVE_BENCHMARK_SEED = PERFORMANCE_CORPUS_SEED;
export const ARCHIVE_BENCHMARK_SCALES = Object.freeze([10_000, 100_000, 1_000_000]);
export const ARCHIVE_BENCHMARK_CLIENT_COUNTS = Object.freeze([1, 8]);
export const ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES = 128;
const PAYLOAD_PROFILES = new Set(["short", "tool-10kib", "tool-1mib"]);

export const ARCHIVE_BENCHMARK_PLAN = Object.freeze({
  schemaVersion: 1,
  seed: ARCHIVE_BENCHMARK_SEED,
  clientCounts: ARCHIVE_BENCHMARK_CLIENT_COUNTS,
  canonicalCorpus: Object.freeze({
    sourcePlanFingerprint: PERFORMANCE_CORPUS_PLAN_FINGERPRINT,
    shortConversation: "all logical windows except scheduled tool results",
    toolResult10KiB: "every 1000th logical window",
    toolResult1MiB: "every 10000th logical window, replacing the 10 KiB result",
    quickProfile: "one 10 KiB and one 1 MiB result when the corpus is large enough",
    repeatedIdentifiers: "32 values selected by ((ordinal * 17) + seed) modulo 32",
    coldBuckets: 16,
  }),
  focusedToolProbes: Object.freeze({
    samplesPerWorkload: ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES,
    toolResult10KiB: 10 * 1024,
    toolResult1MiB: 1024 * 1024,
  }),
  warmup: Object.freeze({
    canonical: "100 operations or 16 per client, whichever is larger",
    focusedTool: "16 operations or 2 per client, whichever is larger, using the measured payload profile",
    accounting: "excluded from measurements",
  }),
  retentionProbe: Object.freeze({
    selection: "even ordinals, exactly half of equal-sized payload bytes",
    content: "seeded deterministic binary payloads",
    materialDecreaseRatio: 0.2,
  }),
});

// Deliberately frozen rather than derived at validation time. A plan edit must
// update this value and therefore creates an explicit review point.
export const ARCHIVE_BENCHMARK_PLAN_FINGERPRINT =
  "sha256:5660093b5820d2d6aa406a84d7d1cc2ab6254f964b55e27576154107a8e4ef12";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

export function archiveWarmupOperationCount(workload, clients) {
  if (!new Set(["canonical", "tool-10kib", "tool-1mib"]).has(workload)) {
    throw new TypeError(`unsupported benchmark workload: ${String(workload)}`);
  }
  positiveInteger(clients, "clients");
  return workload === "canonical"
    ? Math.max(100, clients * 16)
    : Math.max(16, clients * 2);
}

export function assertFrozenArchiveBenchmarkPlan() {
  const actual = hashJson(ARCHIVE_BENCHMARK_PLAN);
  if (actual !== ARCHIVE_BENCHMARK_PLAN_FINGERPRINT) {
    throw new Error(
      `Frozen archive benchmark plan fingerprint mismatch: expected ${ARCHIVE_BENCHMARK_PLAN_FINGERPRINT}, got ${actual}`,
    );
  }
  return ARCHIVE_BENCHMARK_PLAN;
}

function xorshift32(seed) {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

function textAtBytes(prefix, targetBytes, seed) {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  if (prefixBytes >= targetBytes) return prefix.slice(0, targetBytes);
  const remaining = targetBytes - prefixBytes;
  const bytes = Buffer.allocUnsafe(remaining);
  const random = xorshift32(seed);
  const alphabet = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789 _-", "ascii");
  for (let index = 0; index < remaining; index += 1) {
    bytes[index] = alphabet[random() % alphabet.length];
  }
  return prefix + bytes.toString("ascii");
}

function payloadProfile(index, count, officialScale) {
  const ordinal = index + 1;
  if (officialScale) {
    if (ordinal % 10_000 === 0) return "tool-1mib";
    if (ordinal % 1_000 === 0) return "tool-10kib";
    return "short";
  }
  if (count >= 2 && ordinal === count) return "tool-1mib";
  if (count >= 3 && ordinal === count - 1) return "tool-10kib";
  return "short";
}

function targetBytes(profile) {
  if (profile === "tool-1mib") return 1024 * 1024;
  if (profile === "tool-10kib") return 10 * 1024;
  return 160;
}

export function benchmarkDocumentAt(index, {
  count,
  seed = ARCHIVE_BENCHMARK_SEED,
  officialScale = false,
  profile,
} = {}) {
  positiveInteger(count, "count");
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError("index must identify a document in the benchmark corpus");
  }
  const ordinal = index + 1;
  const selectedProfile = profile ?? payloadProfile(index, count, officialScale);
  if (!PAYLOAD_PROFILES.has(selectedProfile)) {
    throw new TypeError(`unsupported payload profile: ${String(selectedProfile)}`);
  }
  const repeatedIdentifier = `REPEAT_KEY_${String((ordinal * 17 + seed) % 32).padStart(2, "0")}`;
  const bucket = index % 16;
  const prefix = [
    `logical window ${ordinal}`,
    "common archive history",
    repeatedIdentifier,
    `bucket-${bucket}`,
    selectedProfile === "short" ? "user request and assistant response" : "diagnostic tool payload",
    `tail-marker-${ordinal}`,
    "",
  ].join(" ");
  const text = textAtBytes(prefix, targetBytes(selectedProfile), seed ^ ordinal ^ targetBytes(selectedProfile));
  return Object.freeze({
    id: `bench-${String(ordinal).padStart(7, "0")}`,
    sessionId: `bench-session-${index % 8}`,
    project: "/fixture/archive-benchmark",
    kind: selectedProfile === "short" ? "turn" : "tool-result",
    createdAt: 1_700_000_000_000 - ((15 - bucket) * 86_400_000) + index,
    text,
    payloadBytes: Buffer.byteLength(text, "utf8"),
    profile: selectedProfile,
    metadata: Object.freeze({ bucket, ordinal, repeatedIdentifier }),
  });
}

function corpusOrderFingerprint({ count, officialScale, seed }) {
  const hash = createHash("sha256");
  for (let index = 0; index < count; index += 1) {
    const profile = payloadProfile(index, count, officialScale);
    hash.update(`${index + 1}\0${profile}\0${(((index + 1) * 17) + seed) % 32}\0${index % 16}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function createArchiveBenchmarkFixture({
  count = 100,
  scale = "quick",
  seed = ARCHIVE_BENCHMARK_SEED,
  largeSamples,
  retentionRecords = 64,
  retentionRecordBytes = 64 * 1024,
} = {}) {
  assertFrozenArchiveBenchmarkPlan();
  positiveInteger(count, "count");
  if (count < Math.max(...ARCHIVE_BENCHMARK_CLIENT_COUNTS)) {
    throw new TypeError(`count must be at least ${Math.max(...ARCHIVE_BENCHMARK_CLIENT_COUNTS)} so every client receives a canonical write`);
  }
  const selectedLargeSamples = largeSamples ?? (scale === "quick"
    ? 8
    : ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES);
  positiveInteger(selectedLargeSamples, "largeSamples");
  positiveInteger(retentionRecords, "retentionRecords");
  positiveInteger(retentionRecordBytes, "retentionRecordBytes");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative integer");
  const officialScale = scale !== "quick";
  if (officialScale && (!ARCHIVE_BENCHMARK_SCALES.includes(scale) || count !== scale)) {
    throw new TypeError(`official scale must be one of ${ARCHIVE_BENCHMARK_SCALES.join(", ")} and match count`);
  }
  if (officialScale && selectedLargeSamples !== ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES) {
    throw new TypeError(
      `official scales require exactly ${ARCHIVE_BENCHMARK_FOCUSED_TOOL_SAMPLES} focused tool samples`,
    );
  }
  if (retentionRecords % 2 !== 0) throw new TypeError("retentionRecords must be even");
  return Object.freeze({
    fixtureId: `archive-benchmark-${scale}`,
    planFingerprint: ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
    sourceCorpusPlanFingerprint: PERFORMANCE_CORPUS_PLAN_FINGERPRINT,
    seed,
    scale,
    officialScale,
    logicalWindows: count,
    largeSamples: selectedLargeSamples,
    retentionRecords,
    retentionRecordBytes,
    orderFingerprint: corpusOrderFingerprint({ count, officialScale, seed }),
  });
}
