import { hashJson } from "../../eval/retrieval/schema.js";
import {
  validateEvaluationEnvironment,
} from "../../eval/retrieval/environment.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store-contract.js";
import { summarizeLatency } from "./artifact.js";
import { ARCHIVE_BENCHMARK_PLAN_FINGERPRINT } from "./fixture.js";
import {
  ARCHIVE_SYSTEM_OFFICIAL_SCALE,
  ARCHIVE_SYSTEM_PROJECT,
  ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
  ARCHIVE_SYSTEM_RECALL_NEIGHBORS,
  ARCHIVE_SYSTEM_RECALL_PROBE_DESCRIPTOR,
  archiveSystemCorpusFingerprint,
  archiveSystemQueries,
  archiveSystemRecallExpectation,
} from "./system-fixture.js";

export const ARCHIVE_SYSTEM_PROBE_ARTIFACT_VERSION = 1;
export const ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE = ARCHIVE_SYSTEM_OFFICIAL_SCALE;
export const ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE = 10_000;
export const ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES = 1_024 * 1_024;
export const ARCHIVE_SYSTEM_PROBE_PROFILES = Object.freeze(["development", "official"]);
export const ARCHIVE_SYSTEM_PROBE_THRESHOLDS = Object.freeze({
  warmPreflightP95Milliseconds: 50,
  threeWindowRecallP95Milliseconds: 25,
  steadyStateRssBytes: 256 * 1_024 * 1_024,
});
export const ARCHIVE_SYSTEM_PROBE_RSS_SCHEDULES = Object.freeze({
  development: Object.freeze({
    minimumIdleBeforeFirstSampleMs: 100,
    minimumSampleSpacingMs: 100,
  }),
  official: Object.freeze({
    minimumIdleBeforeFirstSampleMs: 30_000,
    minimumSampleSpacingMs: 1_000,
  }),
});
export const ARCHIVE_SYSTEM_PROBE_SAMPLE_COUNTS = Object.freeze({
  development: Object.freeze({
    exactPreflight: 3,
    bm25Preflight: 3,
    threeWindowRecall: 3,
    steadyStateRss: 3,
    backlogWrites: 8,
    crashRecoveryTrials: 1,
  }),
  official: Object.freeze({
    exactPreflight: 100,
    bm25Preflight: 100,
    threeWindowRecall: 100,
    steadyStateRss: 10,
    backlogWrites: 32,
    crashRecoveryTrials: 10,
  }),
});

export function archiveSystemProbeCounts(profile) {
  if (!ARCHIVE_SYSTEM_PROBE_PROFILES.includes(profile)) {
    fail("profile", `must be one of ${ARCHIVE_SYSTEM_PROBE_PROFILES.join(", ")}`);
  }
  const counts = ARCHIVE_SYSTEM_PROBE_SAMPLE_COUNTS[profile];
  if (counts.exactPreflight !== counts.bm25Preflight) {
    throw new Error("archive system preflight route sample counts must match");
  }
  return Object.freeze({
    preflightSamplesPerRoute: counts.exactPreflight,
    recallSamples: counts.threeWindowRecall,
    rssSamples: counts.steadyStateRss,
    backlogWrites: counts.backlogWrites,
    crashTrials: counts.crashRecoveryTrials,
  });
}

export function archiveSystemProbeRssSchedule(profile) {
  if (!ARCHIVE_SYSTEM_PROBE_PROFILES.includes(profile)) {
    fail("profile", `must be one of ${ARCHIVE_SYSTEM_PROBE_PROFILES.join(", ")}`);
  }
  return ARCHIVE_SYSTEM_PROBE_RSS_SCHEDULES[profile];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const ARCHIVE_SYSTEM_PROBE_PLAN = deepFreeze({
  schemaVersion: 1,
  baseCorpusPlanFingerprint: ARCHIVE_BENCHMARK_PLAN_FINGERPRINT,
  project: ARCHIVE_SYSTEM_PROJECT,
  officialScale: ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  development: Object.freeze({
    maximumScale: ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE,
    explicitScaleRequired: true,
    releaseEligible: false,
  }),
  vectorsEnabled: false,
  corpusIdentity: "serial ordered deterministic base corpus with one frozen final-window override",
  transientStoreRetry: Object.freeze({
    maximumAttempts: 100,
    classification: "resource busy, no blocking io, temporarily unavailable, or try again",
    idempotency: "stable admission key with a fresh transport request ID",
    accounting: "raw retry and duplicate-acknowledgement counts",
  }),
  recallProbe: Object.freeze({
    ...ARCHIVE_SYSTEM_RECALL_PROBE_DESCRIPTOR,
    neighbors: ARCHIVE_SYSTEM_RECALL_NEIGHBORS,
    maxTokens: ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
    expectedContinuationCount: 2,
    expectedRange: "archiveSystemRecallExpectation(logicalWindows)",
  }),
  queries: archiveSystemQueries(ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE),
  sampleCounts: ARCHIVE_SYSTEM_PROBE_SAMPLE_COUNTS,
  rssSchedules: ARCHIVE_SYSTEM_PROBE_RSS_SCHEDULES,
  backlog: Object.freeze({
    payloadBytesPerWrite: ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES,
    admissionStatus: "stored",
    overlapProof: "a later write observes positive depth before and after its acknowledgement",
    completion: "initial and final depths are zero with no background errors",
  }),
  crashRecovery: Object.freeze({
    admissionStatus: "stored",
    payloadBytesPerTrial: ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES,
    requiredDepthAfterAcknowledgement: "positive",
    killSignal: "SIGKILL",
    exitSignal: "SIGKILL",
    restartReady: true,
    recoveredStatus: "resolved",
    finalOutboxDepth: 0,
    backgroundErrorCount: 0,
    indexedSearchStatus: "resolved with the acknowledged document ID",
    allowedLostAcknowledgedWrites: 0,
  }),
  thresholds: ARCHIVE_SYSTEM_PROBE_THRESHOLDS,
});

// Deliberately frozen rather than derived at validation time. Any suite-plan
// edit must update this explicit review point before new evidence is accepted.
export const ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT =
  "sha256:38d71eb9867f18e09bf70dc612052a680b162e58728b85b050c04118a4a6e41b";

export function assertFrozenArchiveSystemProbePlan() {
  const actual = hashJson(ARCHIVE_SYSTEM_PROBE_PLAN);
  if (actual !== ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT) {
    throw new Error(
      `Frozen archive system probe plan fingerprint mismatch: expected ${ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT}, got ${actual}`,
    );
  }
  return ARCHIVE_SYSTEM_PROBE_PLAN;
}

export const ARCHIVE_SYSTEM_PROBE_SCHEMA_DESCRIPTOR = deepFreeze({
  artifactVersion: ARCHIVE_SYSTEM_PROBE_ARTIFACT_VERSION,
  planFingerprint: ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT,
  profiles: ARCHIVE_SYSTEM_PROBE_PROFILES,
  officialScale: ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
  maximumDevelopmentScale: ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE,
  sampleCounts: ARCHIVE_SYSTEM_PROBE_SAMPLE_COUNTS,
  rssSchedules: ARCHIVE_SYSTEM_PROBE_RSS_SCHEDULES,
  thresholds: ARCHIVE_SYSTEM_PROBE_THRESHOLDS,
  vectorsEnabled: false,
  backlogPayloadBytes: ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES,
  scaleFields: ["profile", "logicalWindows", "releaseEligible", "vectorsEnabled"],
  observationSchema: Object.freeze({
    corpus: ["requestedCount", "putAcknowledgedCount", "transientRetryCount", "duplicateAcknowledgementCount", "countBefore", "countAfter", "indexedStatus"],
    preflightSample: ["probeId", "route", "durationMs", "searchMode", "matchType", "searchStatus", "preflightHintCount", "preflightReturned"],
    recallSample: ["probeId", "durationMs", "neighbors", "maxTokens", "status", "documentId", "expectedDocumentId", "startByte", "endByte", "expectedStartByte", "expectedEndByte", "continuationCount"],
    rss: ["queriesWarmed", "idleBeforeFirstSampleMs", "samples"],
    rssSample: ["observedAtMs", "rssBytes", "outboxDepth", "backgroundErrorCount"],
    backlog: ["initialDepth", "writes", "finalDepth", "backgroundErrorCount"],
    backlogWrite: ["documentId", "payloadBytes", "ackStatus", "transientRetryCount", "depthBeforeWrite", "depthAfterAck"],
    crashRecoveryTrial: ["documentId", "payloadBytes", "ackStatus", "transientRetryCount", "depthAfterAck", "killSignal", "exitSignal", "restartReady", "recoveredStatus", "recoveredDocumentId", "finalOutboxDepth", "backgroundErrorCount", "searchStatus", "searchDocumentId"],
  }),
  recomputation: [
    "latency summaries from raw samples",
    "counts and correctness from every raw observation",
    "RSS schedule from idle duration and monotonic sample times",
    "backlog peak and admission overlap from ordered write depths",
    "active backlog, canonical recovery, final index drain, indexed search, and lost acknowledged writes from every SIGKILL trial",
  ],
  gates: [
    "warmPreflightP95",
    "threeWindowRecallP95",
    "steadyStateRss",
    "indexingBacklogRecovery",
    "acknowledgedWriteRecovery",
  ],
});

export const ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT =
  hashJson(ARCHIVE_SYSTEM_PROBE_SCHEMA_DESCRIPTOR);

const TOP_LEVEL_KEYS = new Set([
  "kind",
  "schemaVersion",
  "schemaFingerprint",
  "planFingerprint",
  "corpusFingerprint",
  "generatedAt",
  "scale",
  "environment",
  "release",
  "observations",
  "results",
  "gates",
  "outcome",
  "notes",
  "artifactHash",
]);
const RELEASE_KEYS = new Set([
  "storageSchemaVersion",
  "storageSchemaFingerprint",
  "protocolVersion",
]);

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
}

function assertExactKeys(value, keys, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${path}.${key}`, "is not allowed");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function assertString(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, "must be a non-negative safe integer");
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(path, "must be a positive safe integer");
}

function assertFiniteNonNegative(value, path) {
  if (!Number.isFinite(value) || value < 0) fail(path, "must be a non-negative finite number");
}

function assertArray(value, path, expectedLength) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length !== expectedLength) {
    fail(path, `must contain exactly ${expectedLength} observations`);
  }
}

function assertUnique(value, seen, path) {
  if (seen.has(value)) fail(path, "must be unique");
  seen.add(value);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeScale(profile, developmentScale) {
  if (!ARCHIVE_SYSTEM_PROBE_PROFILES.includes(profile)) {
    fail("profile", `must be one of ${ARCHIVE_SYSTEM_PROBE_PROFILES.join(", ")}`);
  }
  if (profile === "official") {
    if (developmentScale !== undefined) {
      fail("developmentScale", "must be omitted for the official profile");
    }
    return Object.freeze({
      profile,
      logicalWindows: ARCHIVE_SYSTEM_PROBE_OFFICIAL_SCALE,
      releaseEligible: true,
      vectorsEnabled: false,
    });
  }
  assertPositiveInteger(developmentScale, "developmentScale");
  if (developmentScale > ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE) {
    fail(
      "developmentScale",
      `must not exceed ${ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE}`,
    );
  }
  return Object.freeze({
    profile,
    logicalWindows: developmentScale,
    releaseEligible: false,
    vectorsEnabled: false,
  });
}

function validateRelease(release) {
  assertExactKeys(release, RELEASE_KEYS, "release");
  assertPositiveInteger(release.storageSchemaVersion, "release.storageSchemaVersion");
  assertString(release.storageSchemaFingerprint, "release.storageSchemaFingerprint");
  assertPositiveInteger(release.protocolVersion, "release.protocolVersion");
  if (release.storageSchemaVersion !== STORE_SCHEMA_VERSION
    || release.storageSchemaFingerprint !== SCHEMA_FINGERPRINT
    || release.protocolVersion !== STORE_PROTOCOL_VERSION) {
    throw new Error("release metadata does not match the current storage schema and protocol");
  }
}

function evaluateCorpus(corpus, logicalWindows) {
  assertExactKeys(corpus, new Set([
    "requestedCount",
    "putAcknowledgedCount",
    "transientRetryCount",
    "duplicateAcknowledgementCount",
    "countBefore",
    "countAfter",
    "indexedStatus",
  ]), "observations.corpus");
  for (const field of ["requestedCount", "putAcknowledgedCount", "transientRetryCount", "duplicateAcknowledgementCount", "countBefore", "countAfter"]) {
    assertNonNegativeInteger(corpus[field], `observations.corpus.${field}`);
  }
  assertExactKeys(corpus.indexedStatus, new Set([
    "outboxDepth",
    "backgroundErrorCount",
  ]), "observations.corpus.indexedStatus");
  assertNonNegativeInteger(
    corpus.indexedStatus.outboxDepth,
    "observations.corpus.indexedStatus.outboxDepth",
  );
  assertNonNegativeInteger(
    corpus.indexedStatus.backgroundErrorCount,
    "observations.corpus.indexedStatus.backgroundErrorCount",
  );
  const admittedDelta = corpus.countAfter - corpus.countBefore;
  const fullyAdmitted = corpus.requestedCount === logicalWindows
    && corpus.putAcknowledgedCount === logicalWindows
    && corpus.countBefore === 0
    && admittedDelta === logicalWindows
    && corpus.duplicateAcknowledgementCount <= corpus.transientRetryCount;
  const fullyIndexed = corpus.indexedStatus.outboxDepth === 0
    && corpus.indexedStatus.backgroundErrorCount === 0;
  return {
    requestedCount: corpus.requestedCount,
    putAcknowledgedCount: corpus.putAcknowledgedCount,
    transientRetryCount: corpus.transientRetryCount,
    duplicateAcknowledgementCount: corpus.duplicateAcknowledgementCount,
    countBefore: corpus.countBefore,
    countAfter: corpus.countAfter,
    admittedDelta,
    outboxDepth: corpus.indexedStatus.outboxDepth,
    backgroundErrorCount: corpus.indexedStatus.backgroundErrorCount,
    fullyAdmitted,
    fullyIndexed,
    ready: fullyAdmitted && fullyIndexed,
  };
}

function correctPreflightSample(sample) {
  const expectedSearchMode = sample.route === "exact" ? "exact" : "lexical";
  const expectedMatch = sample.route === "exact"
    ? sample.matchType.startsWith("exact-")
    : sample.matchType === "bm25";
  return sample.searchMode === expectedSearchMode
    && expectedMatch
    && sample.searchStatus === "resolved"
    && sample.preflightHintCount === 1
    && sample.preflightReturned;
}

function evaluatePreflight(preflight, counts) {
  assertExactKeys(preflight, new Set(["samples"]), "observations.preflight");
  const expectedCount = counts.exactPreflight + counts.bm25Preflight;
  assertArray(preflight.samples, "observations.preflight.samples", expectedCount);
  const routeSamples = { exact: [], bm25: [] };
  const seen = new Set();
  let correctCount = 0;
  preflight.samples.forEach((sample, index) => {
    const path = `observations.preflight.samples[${index}]`;
    assertExactKeys(sample, new Set([
      "probeId",
      "route",
      "durationMs",
      "searchMode",
      "matchType",
      "searchStatus",
      "preflightHintCount",
      "preflightReturned",
    ]), path);
    assertString(sample.probeId, `${path}.probeId`);
    assertUnique(sample.probeId, seen, `${path}.probeId`);
    if (!Object.hasOwn(routeSamples, sample.route)) {
      fail(`${path}.route`, "must be exact or bm25");
    }
    assertFiniteNonNegative(sample.durationMs, `${path}.durationMs`);
    assertString(sample.searchMode, `${path}.searchMode`);
    assertString(sample.matchType, `${path}.matchType`);
    assertString(sample.searchStatus, `${path}.searchStatus`);
    assertNonNegativeInteger(sample.preflightHintCount, `${path}.preflightHintCount`);
    assertBoolean(sample.preflightReturned, `${path}.preflightReturned`);
    routeSamples[sample.route].push(sample);
    if (correctPreflightSample(sample)) correctCount += 1;
  });
  if (routeSamples.exact.length !== counts.exactPreflight) {
    fail("observations.preflight.samples", `must contain exactly ${counts.exactPreflight} exact probes`);
  }
  if (routeSamples.bm25.length !== counts.bm25Preflight) {
    fail("observations.preflight.samples", `must contain exactly ${counts.bm25Preflight} bm25 probes`);
  }
  const routeResult = (route) => {
    const samples = routeSamples[route];
    const routeCorrectCount = samples.filter(correctPreflightSample).length;
    return {
      sampleCount: samples.length,
      correctCount: routeCorrectCount,
      allCorrect: routeCorrectCount === samples.length,
      latencyMilliseconds: summarizeLatency(samples.map(({ durationMs }) => durationMs)),
    };
  };
  const routes = { exact: routeResult("exact"), bm25: routeResult("bm25") };
  return {
    sampleCount: expectedCount,
    correctCount,
    allCorrect: correctCount === expectedCount,
    routes,
    worstP95Milliseconds: Math.max(
      routes.exact.latencyMilliseconds.p95,
      routes.bm25.latencyMilliseconds.p95,
    ),
  };
}

function correctRecallSample(sample, expectation) {
  return sample.neighbors === ARCHIVE_SYSTEM_RECALL_NEIGHBORS
    && sample.maxTokens === ARCHIVE_SYSTEM_RECALL_MAX_TOKENS
    && sample.status === "resolved"
    && sample.expectedDocumentId === expectation.documentId
    && sample.expectedStartByte === expectation.startByte
    && sample.expectedEndByte === expectation.endByte
    && sample.documentId === expectation.documentId
    && sample.startByte === expectation.startByte
    && sample.endByte === expectation.endByte
    && sample.endByte > sample.startByte
    && sample.continuationCount === 2;
}

function evaluateRecall(recall, counts, logicalWindows) {
  assertExactKeys(recall, new Set(["samples"]), "observations.recall");
  assertArray(
    recall.samples,
    "observations.recall.samples",
    counts.threeWindowRecall,
  );
  const expectation = archiveSystemRecallExpectation(logicalWindows);
  const seen = new Set();
  let correctCount = 0;
  recall.samples.forEach((sample, index) => {
    const path = `observations.recall.samples[${index}]`;
    assertExactKeys(sample, new Set([
      "probeId",
      "durationMs",
      "neighbors",
      "maxTokens",
      "status",
      "documentId",
      "expectedDocumentId",
      "startByte",
      "endByte",
      "expectedStartByte",
      "expectedEndByte",
      "continuationCount",
    ]), path);
    assertString(sample.probeId, `${path}.probeId`);
    assertUnique(sample.probeId, seen, `${path}.probeId`);
    assertFiniteNonNegative(sample.durationMs, `${path}.durationMs`);
    assertNonNegativeInteger(sample.neighbors, `${path}.neighbors`);
    assertPositiveInteger(sample.maxTokens, `${path}.maxTokens`);
    assertString(sample.status, `${path}.status`);
    assertString(sample.documentId, `${path}.documentId`);
    assertString(sample.expectedDocumentId, `${path}.expectedDocumentId`);
    for (const field of [
      "startByte",
      "endByte",
      "expectedStartByte",
      "expectedEndByte",
      "continuationCount",
    ]) {
      assertNonNegativeInteger(sample[field], `${path}.${field}`);
    }
    if (correctRecallSample(sample, expectation)) correctCount += 1;
  });
  const latencyMilliseconds = summarizeLatency(
    recall.samples.map(({ durationMs }) => durationMs),
  );
  return {
    sampleCount: recall.samples.length,
    correctCount,
    allCorrect: correctCount === recall.samples.length,
    latencyMilliseconds,
  };
}

function evaluateRss(rss, counts, profile) {
  assertExactKeys(rss, new Set([
    "queriesWarmed",
    "idleBeforeFirstSampleMs",
    "samples",
  ]), "observations.rss");
  assertBoolean(rss.queriesWarmed, "observations.rss.queriesWarmed");
  assertFiniteNonNegative(
    rss.idleBeforeFirstSampleMs,
    "observations.rss.idleBeforeFirstSampleMs",
  );
  assertArray(rss.samples, "observations.rss.samples", counts.steadyStateRss);
  let quiescentSampleCount = 0;
  let backgroundErrorCount = 0;
  let minimumObservedSpacingMs = Number.POSITIVE_INFINITY;
  rss.samples.forEach((sample, index) => {
    const path = `observations.rss.samples[${index}]`;
    assertExactKeys(sample, new Set([
      "observedAtMs",
      "rssBytes",
      "outboxDepth",
      "backgroundErrorCount",
    ]), path);
    assertFiniteNonNegative(sample.observedAtMs, `${path}.observedAtMs`);
    assertPositiveInteger(sample.rssBytes, `${path}.rssBytes`);
    assertNonNegativeInteger(sample.outboxDepth, `${path}.outboxDepth`);
    assertNonNegativeInteger(sample.backgroundErrorCount, `${path}.backgroundErrorCount`);
    backgroundErrorCount += sample.backgroundErrorCount;
    if (sample.outboxDepth === 0 && sample.backgroundErrorCount === 0) {
      quiescentSampleCount += 1;
    }
    if (index > 0) {
      minimumObservedSpacingMs = Math.min(
        minimumObservedSpacingMs,
        sample.observedAtMs - rss.samples[index - 1].observedAtMs,
      );
    }
  });
  const schedule = archiveSystemProbeRssSchedule(profile);
  const scheduleValid = rss.queriesWarmed
    && rss.idleBeforeFirstSampleMs >= schedule.minimumIdleBeforeFirstSampleMs
    && minimumObservedSpacingMs >= schedule.minimumSampleSpacingMs;
  return {
    sampleCount: rss.samples.length,
    maxBytes: Math.max(...rss.samples.map(({ rssBytes }) => rssBytes)),
    quiescentSampleCount,
    backgroundErrorCount,
    allQuiescent: quiescentSampleCount === rss.samples.length,
    queriesWarmed: rss.queriesWarmed,
    idleBeforeFirstSampleMs: rss.idleBeforeFirstSampleMs,
    minimumObservedSpacingMs,
    requiredIdleBeforeFirstSampleMs: schedule.minimumIdleBeforeFirstSampleMs,
    requiredSampleSpacingMs: schedule.minimumSampleSpacingMs,
    scheduleValid,
  };
}

function acknowledgedStatus(status, transientRetryCount) {
  return status === "stored" || (status === "duplicate" && transientRetryCount > 0);
}

function evaluateBacklog(backlog, counts) {
  assertExactKeys(backlog, new Set([
    "initialDepth",
    "writes",
    "finalDepth",
    "backgroundErrorCount",
  ]), "observations.backlog");
  assertNonNegativeInteger(backlog.initialDepth, "observations.backlog.initialDepth");
  assertNonNegativeInteger(backlog.finalDepth, "observations.backlog.finalDepth");
  assertNonNegativeInteger(
    backlog.backgroundErrorCount,
    "observations.backlog.backgroundErrorCount",
  );
  assertArray(backlog.writes, "observations.backlog.writes", counts.backlogWrites);
  const seen = new Set();
  let acknowledgedCount = 0;
  let payloadBytes = 0;
  backlog.writes.forEach((write, index) => {
    const path = `observations.backlog.writes[${index}]`;
    assertExactKeys(write, new Set([
      "documentId",
      "payloadBytes",
      "ackStatus",
      "transientRetryCount",
      "depthBeforeWrite",
      "depthAfterAck",
    ]), path);
    assertString(write.documentId, `${path}.documentId`);
    assertUnique(write.documentId, seen, `${path}.documentId`);
    assertPositiveInteger(write.payloadBytes, `${path}.payloadBytes`);
    if (write.payloadBytes !== ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES) {
      fail(
        `${path}.payloadBytes`,
        `must equal ${ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES}`,
      );
    }
    assertString(write.ackStatus, `${path}.ackStatus`);
    assertNonNegativeInteger(write.transientRetryCount, `${path}.transientRetryCount`);
    assertNonNegativeInteger(write.depthBeforeWrite, `${path}.depthBeforeWrite`);
    assertNonNegativeInteger(write.depthAfterAck, `${path}.depthAfterAck`);
    payloadBytes += write.payloadBytes;
    if (acknowledgedStatus(write.ackStatus, write.transientRetryCount)) acknowledgedCount += 1;
  });
  const peakDepth = Math.max(
    backlog.initialDepth,
    backlog.finalDepth,
    ...backlog.writes.map(({ depthBeforeWrite }) => depthBeforeWrite),
    ...backlog.writes.map(({ depthAfterAck }) => depthAfterAck),
  );
  const allAcknowledged = acknowledgedCount === backlog.writes.length;
  const overlappingStoredWriteCount = backlog.writes.filter((write, index) =>
    index > 0
      && acknowledgedStatus(write.ackStatus, write.transientRetryCount)
      && write.depthBeforeWrite > 0
      && write.depthAfterAck > 0).length;
  const recovered = backlog.initialDepth === 0
    && peakDepth > 0
    && backlog.finalDepth === 0
    && backlog.backgroundErrorCount === 0;
  return {
    writeCount: backlog.writes.length,
    acknowledgedCount,
    payloadBytes,
    initialDepth: backlog.initialDepth,
    peakDepth,
    finalDepth: backlog.finalDepth,
    backgroundErrorCount: backlog.backgroundErrorCount,
    allAcknowledged,
    overlappingStoredWriteCount,
    canonicalWritesUnblocked: allAcknowledged && overlappingStoredWriteCount > 0,
    recovered,
  };
}

function evaluateCrashRecovery(crashRecovery, counts) {
  assertExactKeys(crashRecovery, new Set(["trials"]), "observations.crashRecovery");
  assertArray(
    crashRecovery.trials,
    "observations.crashRecovery.trials",
    counts.crashRecoveryTrials,
  );
  const seen = new Set();
  let acknowledgedCount = 0;
  let killedCount = 0;
  let restartReadyCount = 0;
  let recoveredCount = 0;
  let activeBacklogCount = 0;
  let indexedRecoveryCount = 0;
  let lostAcknowledgedWriteCount = 0;
  crashRecovery.trials.forEach((trial, index) => {
    const path = `observations.crashRecovery.trials[${index}]`;
    assertExactKeys(trial, new Set([
      "documentId",
      "payloadBytes",
      "ackStatus",
      "transientRetryCount",
      "depthAfterAck",
      "killSignal",
      "exitSignal",
      "restartReady",
      "recoveredStatus",
      "recoveredDocumentId",
      "finalOutboxDepth",
      "backgroundErrorCount",
      "searchStatus",
      "searchDocumentId",
    ]), path);
    assertString(trial.documentId, `${path}.documentId`);
    assertUnique(trial.documentId, seen, `${path}.documentId`);
    for (const field of ["ackStatus", "killSignal", "exitSignal", "recoveredStatus", "recoveredDocumentId", "searchStatus", "searchDocumentId"]) {
      assertString(trial[field], `${path}.${field}`);
    }
    for (const field of ["payloadBytes", "transientRetryCount", "depthAfterAck", "finalOutboxDepth", "backgroundErrorCount"]) {
      assertNonNegativeInteger(trial[field], `${path}.${field}`);
    }
    if (trial.payloadBytes !== ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES) {
      fail(
        `${path}.payloadBytes`,
        `must equal ${ARCHIVE_SYSTEM_PROBE_BACKLOG_PAYLOAD_BYTES}`,
      );
    }
    assertBoolean(trial.restartReady, `${path}.restartReady`);
    const acknowledged = acknowledgedStatus(trial.ackStatus, trial.transientRetryCount);
    const activeBacklog = trial.depthAfterAck > 0;
    const killed = trial.killSignal === "SIGKILL" && trial.exitSignal === "SIGKILL";
    const canonicalRecovered = trial.restartReady
      && trial.recoveredStatus === "resolved"
      && trial.recoveredDocumentId === trial.documentId;
    const indexRecovered = trial.finalOutboxDepth === 0
      && trial.backgroundErrorCount === 0
      && trial.searchStatus === "resolved"
      && trial.searchDocumentId === trial.documentId;
    const recovered = canonicalRecovered && indexRecovered;
    if (acknowledged) acknowledgedCount += 1;
    if (activeBacklog) activeBacklogCount += 1;
    if (killed) killedCount += 1;
    if (trial.restartReady) restartReadyCount += 1;
    if (recovered) recoveredCount += 1;
    if (indexRecovered) indexedRecoveryCount += 1;
    if (acknowledged && !recovered) lostAcknowledgedWriteCount += 1;
  });
  const trialCount = crashRecovery.trials.length;
  return {
    trialCount,
    acknowledgedCount,
    activeBacklogCount,
    killedCount,
    restartReadyCount,
    recoveredCount,
    indexedRecoveryCount,
    lostAcknowledgedWriteCount,
    allTrialsAcknowledged: acknowledgedCount === trialCount,
    allTrialsHadActiveBacklog: activeBacklogCount === trialCount,
    allTrialsKilled: killedCount === trialCount,
    allRestartsReady: restartReadyCount === trialCount,
    allIndexesRecovered: indexedRecoveryCount === trialCount,
    zeroLostAcknowledgedWrites: lostAcknowledgedWriteCount === 0,
  };
}

function evaluateObservations(observations, scale) {
  assertExactKeys(observations, new Set([
    "corpus",
    "preflight",
    "recall",
    "rss",
    "backlog",
    "crashRecovery",
  ]), "observations");
  const counts = ARCHIVE_SYSTEM_PROBE_SAMPLE_COUNTS[scale.profile];
  return {
    corpus: evaluateCorpus(observations.corpus, scale.logicalWindows),
    preflight: evaluatePreflight(observations.preflight, counts),
    recall: evaluateRecall(observations.recall, counts, scale.logicalWindows),
    rss: evaluateRss(observations.rss, counts, scale.profile),
    backlog: evaluateBacklog(observations.backlog, counts),
    crashRecovery: evaluateCrashRecovery(observations.crashRecovery, counts),
  };
}

function scoreSystemProbe(results) {
  const corpusReady = results.corpus.ready;
  const warmPreflightPassed = corpusReady
    && results.preflight.allCorrect
    && results.preflight.worstP95Milliseconds
      <= ARCHIVE_SYSTEM_PROBE_THRESHOLDS.warmPreflightP95Milliseconds;
  const recallPassed = corpusReady
    && results.recall.allCorrect
    && results.recall.latencyMilliseconds.p95
      <= ARCHIVE_SYSTEM_PROBE_THRESHOLDS.threeWindowRecallP95Milliseconds;
  const rssPassed = corpusReady
    && results.rss.allQuiescent
    && results.rss.scheduleValid
    && results.rss.maxBytes <= ARCHIVE_SYSTEM_PROBE_THRESHOLDS.steadyStateRssBytes;
  const backlogPassed = corpusReady
    && results.backlog.canonicalWritesUnblocked
    && results.backlog.recovered;
  const crashPassed = corpusReady
    && results.crashRecovery.allTrialsAcknowledged
    && results.crashRecovery.allTrialsHadActiveBacklog
    && results.crashRecovery.allTrialsKilled
    && results.crashRecovery.allRestartsReady
    && results.crashRecovery.allIndexesRecovered
    && results.crashRecovery.zeroLostAcknowledgedWrites;
  return {
    warmPreflightP95: {
      status: warmPreflightPassed ? "passed" : "failed",
      thresholdMilliseconds: ARCHIVE_SYSTEM_PROBE_THRESHOLDS.warmPreflightP95Milliseconds,
      exactP95Milliseconds: results.preflight.routes.exact.latencyMilliseconds.p95,
      bm25P95Milliseconds: results.preflight.routes.bm25.latencyMilliseconds.p95,
      allCorrect: results.preflight.allCorrect,
      corpusReady,
    },
    threeWindowRecallP95: {
      status: recallPassed ? "passed" : "failed",
      thresholdMilliseconds: ARCHIVE_SYSTEM_PROBE_THRESHOLDS.threeWindowRecallP95Milliseconds,
      p95Milliseconds: results.recall.latencyMilliseconds.p95,
      allCorrect: results.recall.allCorrect,
      corpusReady,
    },
    steadyStateRss: {
      status: rssPassed ? "passed" : "failed",
      thresholdBytes: ARCHIVE_SYSTEM_PROBE_THRESHOLDS.steadyStateRssBytes,
      maxBytes: results.rss.maxBytes,
      allQuiescent: results.rss.allQuiescent,
      scheduleValid: results.rss.scheduleValid,
      corpusReady,
    },
    indexingBacklogRecovery: {
      status: backlogPassed ? "passed" : "failed",
      initialDepth: results.backlog.initialDepth,
      peakDepth: results.backlog.peakDepth,
      finalDepth: results.backlog.finalDepth,
      canonicalWritesUnblocked: results.backlog.canonicalWritesUnblocked,
      backgroundErrorCount: results.backlog.backgroundErrorCount,
      corpusReady,
    },
    acknowledgedWriteRecovery: {
      status: crashPassed ? "passed" : "failed",
      trialCount: results.crashRecovery.trialCount,
      lostAcknowledgedWriteCount: results.crashRecovery.lostAcknowledgedWriteCount,
      allTrialsHadActiveBacklog: results.crashRecovery.allTrialsHadActiveBacklog,
      allTrialsKilled: results.crashRecovery.allTrialsKilled,
      allRestartsReady: results.crashRecovery.allRestartsReady,
      allIndexesRecovered: results.crashRecovery.allIndexesRecovered,
      corpusReady,
    },
  };
}

function unsignedArtifact({ scale, environment, release, observations, notes }) {
  assertFrozenArchiveSystemProbePlan();
  if (hashJson(archiveSystemQueries(scale.logicalWindows))
    !== hashJson(ARCHIVE_SYSTEM_PROBE_PLAN.queries)) {
    throw new Error("archive system probe queries do not match the frozen plan");
  }
  validateEvaluationEnvironment(environment);
  validateRelease(release);
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    fail("notes", "must be an array of strings");
  }
  const results = evaluateObservations(observations, scale);
  const gates = scoreSystemProbe(results);
  const outcome = Object.values(gates).every(({ status }) => status === "passed")
    ? "passed"
    : "failed";
  return {
    kind: "archive-system-probe",
    schemaVersion: ARCHIVE_SYSTEM_PROBE_ARTIFACT_VERSION,
    schemaFingerprint: ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT,
    planFingerprint: ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT,
    corpusFingerprint: archiveSystemCorpusFingerprint(scale.logicalWindows),
    generatedAt: environment.capturedAt,
    scale,
    environment,
    release,
    observations,
    results,
    gates,
    outcome,
    notes,
  };
}

export function createArchiveSystemProbeArtifact({
  profile,
  developmentScale,
  environment,
  release,
  observations,
  notes = [],
}) {
  const scale = normalizeScale(profile, developmentScale);
  const cloned = structuredClone({ environment, release, observations, notes });
  const artifact = unsignedArtifact({ scale, ...cloned });
  return deepFreeze({ ...artifact, artifactHash: hashJson(artifact) });
}

export function validateArchiveSystemProbeArtifact(artifact) {
  assertExactKeys(artifact, TOP_LEVEL_KEYS, "artifact");
  if (artifact.kind !== "archive-system-probe"
    || artifact.schemaVersion !== ARCHIVE_SYSTEM_PROBE_ARTIFACT_VERSION) {
    fail("artifact", "must be an archive-system-probe v1 artifact");
  }
  if (artifact.schemaFingerprint !== ARCHIVE_SYSTEM_PROBE_SCHEMA_FINGERPRINT) {
    throw new Error("archive system probe schema fingerprint is stale");
  }
  if (artifact.planFingerprint !== ARCHIVE_SYSTEM_PROBE_PLAN_FINGERPRINT) {
    throw new Error("archive system probe plan fingerprint is stale");
  }
  assertExactKeys(
    artifact.scale,
    new Set(["profile", "logicalWindows", "releaseEligible", "vectorsEnabled"]),
    "artifact.scale",
  );
  const expectedScale = normalizeScale(
    artifact.scale.profile,
    artifact.scale.profile === "development" ? artifact.scale.logicalWindows : undefined,
  );
  if (!same(artifact.scale, expectedScale)) {
    throw new Error("archive system probe scale metadata is inconsistent");
  }
  const expectedCorpusFingerprint = archiveSystemCorpusFingerprint(
    expectedScale.logicalWindows,
  );
  if (artifact.corpusFingerprint !== expectedCorpusFingerprint) {
    throw new Error("archive system probe corpus fingerprint is stale");
  }
  const rebuilt = unsignedArtifact({
    scale: expectedScale,
    environment: artifact.environment,
    release: artifact.release,
    observations: artifact.observations,
    notes: artifact.notes,
  });
  if (!same(artifact.results, rebuilt.results)) {
    throw new Error("archive system probe results do not match raw observations");
  }
  if (!same(artifact.gates, rebuilt.gates) || artifact.outcome !== rebuilt.outcome) {
    throw new Error("archive system probe gates do not match recomputed results");
  }
  if (artifact.generatedAt !== rebuilt.generatedAt) {
    throw new Error("archive system probe generatedAt does not match its environment");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(artifact.artifactHash)
    || artifact.artifactHash !== hashJson(rebuilt)) {
    throw new Error("archive system probe artifact hash does not match its canonical content");
  }
  return artifact;
}
