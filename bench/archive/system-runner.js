import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEvaluationEnvironment } from "../../eval/retrieval/environment.js";
import { SCHEMA_FINGERPRINT, STORE_SCHEMA_VERSION } from "../../src/rocksdb/schema.js";
import { STORE_PROTOCOL_VERSION } from "../../src/store-contract.js";
import { StoreClient } from "../../src/store-client.js";
import {
  ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE,
  archiveSystemProbeCounts,
  archiveSystemProbeRssSchedule,
  createArchiveSystemProbeArtifact,
  validateArchiveSystemProbeArtifact,
} from "./system-artifact.js";
import {
  ARCHIVE_SYSTEM_OFFICIAL_SCALE,
  ARCHIVE_SYSTEM_PROJECT,
  ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
  ARCHIVE_SYSTEM_RECALL_NEIGHBORS,
  archiveSystemAdmission,
  archiveSystemDocumentAt,
  archiveSystemQueries,
  archiveSystemRecallExpectation,
  createArchiveSystemRecallProbe,
} from "./system-fixture.js";
import {
  ARCHIVE_SYSTEM_REPOSITORY_ROOT,
  archiveSystemDaemonRssBytes,
  killArchiveSystemDaemon,
  startArchiveSystemDaemon,
  stopArchiveSystemDaemon,
} from "./system-daemon.js";

const CLIENTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;
const DEVELOPMENT_IDLE_TIMEOUT_MS = 5 * 60_000;
const OFFICIAL_IDLE_TIMEOUT_MS = 30 * 60_000;
const BACKLOG_PAYLOAD_BYTES = 1_024 * 1_024;
const MAX_TRANSIENT_STORE_ATTEMPTS = 100;
let controlRequestSequence = 0;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function profileScale(profile, developmentScale) {
  if (profile === "official") {
    if (developmentScale !== undefined) {
      throw new TypeError("developmentScale must be omitted for the official profile");
    }
    return ARCHIVE_SYSTEM_OFFICIAL_SCALE;
  }
  if (profile !== "development") {
    throw new TypeError("profile must be official or development");
  }
  if (!Number.isSafeInteger(developmentScale) || developmentScale <= 0) {
    throw new TypeError("developmentScale must be an explicit positive integer");
  }
  if (developmentScale > ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE) {
    throw new TypeError(
      `developmentScale must not exceed ${ARCHIVE_SYSTEM_PROBE_MAX_DEVELOPMENT_SCALE}`,
    );
  }
  return developmentScale;
}

function createClient(socketPath, client) {
  return new StoreClient({
    socketPath,
    client,
    clientVersion: "archive-system-probe-v1",
    project: ARCHIVE_SYSTEM_PROJECT,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function transientStoreError(error) {
  return /\b(?:resource busy|no blocking io|busy|temporarily unavailable|try again)\b/iu
    .test(error instanceof Error ? error.message : String(error));
}

async function requestWithTransientRetry(client, operation, payload, requestId) {
  for (let attempt = 0; attempt < MAX_TRANSIENT_STORE_ATTEMPTS; attempt += 1) {
    try {
      return {
        result: await client.request(operation, payload, {
          retry: false,
          requestId: `${requestId}:attempt-${attempt}`,
        }),
        transientRetryCount: attempt,
      };
    } catch (error) {
      if (!transientStoreError(error)) {
        throw error;
      }
      if (attempt + 1 === MAX_TRANSIENT_STORE_ATTEMPTS) {
        throw new Error(
          `${operation} exhausted ${MAX_TRANSIENT_STORE_ATTEMPTS} transient store attempts: ${error.message}`,
          { cause: error },
        );
      }
      await delay(Math.min(50, (attempt + 1) * 5));
    }
  }
  throw new Error(`transient retry loop did not terminate for ${operation}`);
}

async function daemonStatus(client) {
  const { result: status } = await requestWithTransientRetry(
    client,
    "daemon.status",
    {},
    `archive-system-status-${controlRequestSequence += 1}`,
  );
  if (!status?.ready || !status.outbox || !Array.isArray(status.backgroundErrors)) {
    throw new Error("context-windowd returned an incomplete status response");
  }
  return status;
}

async function waitForIndexIdle(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() <= deadline) {
    latest = await daemonStatus(client);
    if (latest.outbox.depth === 0) return latest;
    await delay(25);
  }
  throw new Error(
    `index backlog did not drain within ${timeoutMs} ms (last depth ${latest?.outbox?.depth ?? "unknown"})`,
  );
}

function requireCleanBackground(status, phase) {
  if (status.backgroundErrors.length !== 0) {
    throw new Error(`${phase} recorded ${status.backgroundErrors.length} background error(s)`);
  }
  return status;
}

async function admitCorpus({ clients, scale }) {
  const { result: before } = await requestWithTransientRetry(
    clients[0],
    "store.count",
    { scope: "project" },
    `archive-system-count-before-${scale}`,
  );
  const countBefore = before.count;
  let putAcknowledgedCount = 0;
  let transientRetryCount = 0;
  let duplicateAcknowledgementCount = 0;
  // The corpus fingerprint commits to this logical order. Eight-client write
  // performance is measured separately by the comparison artifacts; this
  // system corpus is admitted serially so its outbox order is reproducible and
  // production transaction-busy responses cannot make setup nondeterministic.
  for (let index = 0; index < scale; index += 1) {
    const document = archiveSystemDocumentAt(index, scale);
    const admission = await requestWithTransientRetry(
      clients[0],
      "store.put",
      archiveSystemAdmission(document, `archive-system:corpus:${scale}:${index}`),
      `archive-system-corpus-${scale}-${index}`,
    );
    const { result } = admission;
    transientRetryCount += admission.transientRetryCount;
    if (result.status === "duplicate") duplicateAcknowledgementCount += 1;
    if (!new Set(["stored", "duplicate"]).has(result.status)
      || (result.status === "duplicate" && admission.transientRetryCount === 0)
      || result.documentId !== document.id) {
      throw new Error(`corpus admission did not store ${document.id}`);
    }
    putAcknowledgedCount += 1;
  }
  const idleTimeout = scale === ARCHIVE_SYSTEM_OFFICIAL_SCALE
    ? OFFICIAL_IDLE_TIMEOUT_MS
    : DEVELOPMENT_IDLE_TIMEOUT_MS;
  const indexed = requireCleanBackground(
    await waitForIndexIdle(clients[0], idleTimeout),
    "corpus indexing",
  );
  const { result: after } = await requestWithTransientRetry(
    clients[0],
    "store.count",
    { scope: "project" },
    `archive-system-count-after-${scale}`,
  );
  const countAfter = after.count;
  return {
    requestedCount: scale,
    putAcknowledgedCount,
    transientRetryCount,
    duplicateAcknowledgementCount,
    countBefore,
    countAfter,
    indexedStatus: {
      outboxDepth: indexed.outbox.depth,
      backgroundErrorCount: indexed.backgroundErrors.length,
    },
  };
}

function searchPayload(query, probeId) {
  return {
    query,
    relation: null,
    scope: "project",
    sessionId: probeId,
    sessionIds: [probeId],
    project: ARCHIVE_SYSTEM_PROJECT,
    limit: 1,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  };
}

function preflightPayload(query, probeId) {
  return {
    messageKey: `message:${probeId}`,
    message: query,
    scope: "project",
    sessionId: probeId,
    sessionIds: [probeId],
    project: ARCHIVE_SYSTEM_PROJECT,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
    epochId: `epoch:${probeId}`,
    epochBudgetTokens: 10_000,
  };
}

async function measurePreflight(client, scale, sampleCount) {
  const queries = archiveSystemQueries(scale);
  const samples = [];
  for (const route of ["exact", "bm25"]) {
    for (let index = 0; index < sampleCount; index += 1) {
      const probeId = `preflight:${route}:${index}`;
      const { result: diagnostic } = await requestWithTransientRetry(
        client,
        "store.search",
        searchPayload(queries[route], probeId),
        `archive-system-diagnostic-${probeId}`,
      );
      const first = diagnostic.results?.[0];
      if (!first) throw new Error(`${route} preflight diagnostic did not resolve a candidate`);
      const startedAt = performance.now();
      const { result: response } = await requestWithTransientRetry(
        client,
        "store.preflight",
        preflightPayload(queries[route], probeId),
        `archive-system-${probeId}`,
      );
      const durationMs = performance.now() - startedAt;
      samples.push({
        probeId,
        route,
        durationMs,
        searchMode: diagnostic.mode,
        matchType: first.matchType,
        searchStatus: diagnostic.status,
        preflightHintCount: response.hints.length,
        preflightReturned: typeof response.modelVisibleText === "string"
          && response.modelVisibleText.length > 0,
      });
    }
  }
  return { samples };
}

async function measureRecall(client, scale, sampleCount) {
  const query = archiveSystemQueries(scale).recall;
  const expectation = archiveSystemRecallExpectation(scale);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const probeId = `recall:${index}`;
    const { result: search } = await requestWithTransientRetry(
      client,
      "store.search",
      searchPayload(query, probeId),
      `archive-system-search-${probeId}`,
    );
    const candidate = search.results?.[0];
    if (search.status !== "resolved" || !candidate) {
      throw new Error(`recall probe ${probeId} did not resolve its exact locator`);
    }
    const startedAt = performance.now();
    const { result: response } = await requestWithTransientRetry(client, "store.recall", {
      locator: candidate.locator,
      neighbors: ARCHIVE_SYSTEM_RECALL_NEIGHBORS,
      maxTokens: ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
    }, `archive-system-${probeId}`);
    const durationMs = performance.now() - startedAt;
    if (response.status !== "resolved" || response.chunks.length === 0) {
      throw new Error(`recall probe ${probeId} returned ${response.status}`);
    }
    samples.push({
      probeId,
      durationMs,
      neighbors: ARCHIVE_SYSTEM_RECALL_NEIGHBORS,
      maxTokens: ARCHIVE_SYSTEM_RECALL_MAX_TOKENS,
      status: response.status,
      documentId: response.documentId,
      expectedDocumentId: expectation.documentId,
      startByte: response.chunks[0].startByte,
      endByte: response.chunks.at(-1).endByte,
      expectedStartByte: expectation.startByte,
      expectedEndByte: expectation.endByte,
      continuationCount: response.continuationLocators.length,
    });
  }
  return { samples };
}

async function measureRss(client, daemon, sampleCount, schedule) {
  requireCleanBackground(
    await waitForIndexIdle(client, DEVELOPMENT_IDLE_TIMEOUT_MS),
    "RSS idle precondition",
  );
  const idleStartedAt = performance.now();
  await delay(schedule.minimumIdleBeforeFirstSampleMs + 25);
  const idleBeforeFirstSampleMs = performance.now() - idleStartedAt;
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0) await delay(schedule.minimumSampleSpacingMs + 10);
    const status = await daemonStatus(client);
    samples.push({
      observedAtMs: performance.now(),
      rssBytes: await archiveSystemDaemonRssBytes(daemon.child.pid),
      outboxDepth: status.outbox.depth,
      backgroundErrorCount: status.backgroundErrors.length,
    });
  }
  return { queriesWarmed: true, idleBeforeFirstSampleMs, samples };
}

function backlogDocument(index, scale) {
  const base = createArchiveSystemRecallProbe(scale);
  const prefix = `BACKLOG_WRITE_${String(index).padStart(8, "0")} `;
  const text = prefix + base.text.slice(prefix.length);
  if (Buffer.byteLength(text, "utf8") !== BACKLOG_PAYLOAD_BYTES) {
    throw new Error("backlog probe document must remain exactly 1 MiB");
  }
  return Object.freeze({
    ...base,
    id: `archive-system-backlog-${String(index).padStart(4, "0")}`,
    sessionId: "archive-system-backlog",
    createdAt: 1_800_000_000_000 + index,
    text,
    payloadBytes: BACKLOG_PAYLOAD_BYTES,
    metadata: Object.freeze({ archiveSystemProbe: "indexing-backlog", ordinal: index }),
  });
}

async function measureBacklog(clients, scale, writeCount) {
  const initialStatus = requireCleanBackground(
    await waitForIndexIdle(clients[0], DEVELOPMENT_IDLE_TIMEOUT_MS),
    "backlog precondition",
  );
  const writes = [];
  for (let index = 0; index < writeCount; index += 1) {
    const document = backlogDocument(index, scale);
    const before = await daemonStatus(clients[1] ?? clients[0]);
    const admission = await requestWithTransientRetry(
      clients[0],
      "store.put",
      archiveSystemAdmission(document, `archive-system:backlog:${index}`),
      `archive-system-backlog-${index}`,
    );
    const status = await daemonStatus(clients[1] ?? clients[0]);
    writes.push({
      documentId: document.id,
      payloadBytes: document.payloadBytes,
      ackStatus: admission.result.status,
      transientRetryCount: admission.transientRetryCount,
      depthBeforeWrite: before.outbox.depth,
      depthAfterAck: status.outbox.depth,
    });
  }
  const finalStatus = requireCleanBackground(
    await waitForIndexIdle(clients[0], OFFICIAL_IDLE_TIMEOUT_MS),
    "backlog recovery",
  );
  return {
    initialDepth: initialStatus.outbox.depth,
    writes,
    finalDepth: finalStatus.outbox.depth,
    backgroundErrorCount: finalStatus.backgroundErrors.length,
  };
}

function crashDocument(index) {
  const id = `archive-system-crash-${String(index).padStart(3, "0")}`;
  const marker = `CRASH_RECOVERY_PROBE_${String(index).padStart(3, "0")}`;
  const base = createArchiveSystemRecallProbe(1);
  const prefix = `${marker} `;
  const text = prefix + base.text.slice(prefix.length);
  if (Buffer.byteLength(text, "utf8") !== BACKLOG_PAYLOAD_BYTES) {
    throw new Error("crash recovery probe document must be exactly 1 MiB");
  }
  return Object.freeze({
    id,
    sessionId: "archive-system-crash",
    project: ARCHIVE_SYSTEM_PROJECT,
    kind: "tool-result",
    createdAt: 1_900_000_000_000 + index,
    text,
    payloadBytes: BACKLOG_PAYLOAD_BYTES,
    profile: "tool-1mib",
    metadata: Object.freeze({
      archiveSystemProbe: "acknowledged-write-recovery",
      marker,
      ordinal: index,
    }),
  });
}

async function measureCrashRecovery({
  daemon,
  socketPath,
  storePath,
  trialCount,
  registerClient,
  replaceDaemon,
}) {
  const trials = [];
  let currentDaemon = daemon;
  for (let index = 0; index < trialCount; index += 1) {
    const document = crashDocument(index);
    const writer = registerClient(createClient(socketPath, `archive-system-crash-writer-${index}`));
    const admission = await requestWithTransientRetry(
      writer,
      "store.put",
      archiveSystemAdmission(document, `archive-system:crash:${index}`),
      `archive-system-crash-${index}`,
    );
    const acknowledgedStatus = await daemonStatus(writer);
    writer.close();
    const exit = await killArchiveSystemDaemon(currentDaemon);
    currentDaemon = await startArchiveSystemDaemon({ storePath, socketPath });
    replaceDaemon(currentDaemon);
    const reader = registerClient(createClient(socketPath, `archive-system-crash-reader-${index}`));
    const { result: recovered } = await requestWithTransientRetry(
      reader,
      "store.get",
      { documentId: document.id },
      `archive-system-crash-get-${index}`,
    );
    const recoveredStatus = requireCleanBackground(
      await waitForIndexIdle(reader, DEVELOPMENT_IDLE_TIMEOUT_MS),
      `crash recovery trial ${index}`,
    );
    const { result: search } = await requestWithTransientRetry(
      reader,
      "store.search",
      searchPayload(document.metadata.marker, `crash-recovery:${index}`),
      `archive-system-crash-search-${index}`,
    );
    const searchDocumentId = search.results?.[0]?.documentId ?? "missing";
    reader.close();
    trials.push({
      documentId: document.id,
      payloadBytes: document.payloadBytes,
      ackStatus: admission.result.status,
      transientRetryCount: admission.transientRetryCount,
      depthAfterAck: acknowledgedStatus.outbox.depth,
      killSignal: "SIGKILL",
      exitSignal: exit.signal ?? `code:${String(exit.code)}`,
      restartReady: currentDaemon.ready.status === "ready",
      recoveredStatus: recovered.status,
      recoveredDocumentId: recovered.document?.documentId ?? recovered.documentId ?? "missing",
      finalOutboxDepth: recoveredStatus.outbox.depth,
      backgroundErrorCount: recoveredStatus.backgroundErrors.length,
      searchStatus: search.status,
      searchDocumentId,
    });
  }
  return { daemon: currentDaemon, observations: { trials } };
}

function runIdentity(environment) {
  return JSON.stringify({
    node: environment.node,
    package: environment.package,
    dependencyLockSha256: environment.dependencyLockSha256,
    dependencies: environment.dependencies,
    git: environment.git,
  });
}

/**
 * Exercise the production daemon and RPC contracts at either the immutable
 * release scale or an explicitly non-release development scale.
 */
export async function runArchiveSystemProbe({
  profile,
  developmentScale,
  notes = [],
} = {}) {
  const scale = profileScale(profile, developmentScale);
  const counts = archiveSystemProbeCounts(profile);
  const environment = collectEvaluationEnvironment({ cwd: ARCHIVE_SYSTEM_REPOSITORY_ROOT });
  const root = mkdtempSync(join(tmpdir(), "context-window-archive-system-"));
  // Darwin's sockaddr_un limit is shorter than its normal per-user temp path.
  // Keep the database in the normal temp root, but give the production daemon
  // an independently owned, bounded socket path.
  const socketRoot = mkdtempSync("/tmp/cw-as-");
  const storePath = join(root, "archive.rocks");
  const socketPath = join(socketRoot, "d.sock");
  const clients = new Set();
  const registerClient = (client) => {
    clients.add(client);
    return client;
  };
  let daemon;
  try {
    daemon = await startArchiveSystemDaemon({ storePath, socketPath });
    const corpusClients = Array.from({ length: Math.min(CLIENTS, scale) }, (_, index) =>
      registerClient(createClient(socketPath, `archive-system-corpus-${index}`)));
    const corpus = await admitCorpus({ clients: corpusClients, scale });
    const preflight = await measurePreflight(
      corpusClients[0],
      scale,
      counts.preflightSamplesPerRoute,
    );
    const recall = await measureRecall(corpusClients[0], scale, counts.recallSamples);
    const rss = await measureRss(
      corpusClients[0],
      daemon,
      counts.rssSamples,
      archiveSystemProbeRssSchedule(profile),
    );
    const backlog = await measureBacklog(corpusClients, scale, counts.backlogWrites);
    for (const client of clients) client.close();
    clients.clear();
    const crash = await measureCrashRecovery({
      daemon,
      socketPath,
      storePath,
      trialCount: counts.crashTrials,
      registerClient,
      replaceDaemon(nextDaemon) { daemon = nextDaemon; },
    });
    daemon = crash.daemon;
    const endingEnvironment = collectEvaluationEnvironment({ cwd: ARCHIVE_SYSTEM_REPOSITORY_ROOT });
    if (runIdentity(endingEnvironment) !== runIdentity(environment)) {
      throw new Error("archive system probe repository or runtime identity changed during the run");
    }
    const artifact = createArchiveSystemProbeArtifact({
      profile,
      ...(profile === "development" ? { developmentScale: scale } : {}),
      environment,
      release: {
        storageSchemaVersion: STORE_SCHEMA_VERSION,
        storageSchemaFingerprint: SCHEMA_FINGERPRINT,
        protocolVersion: STORE_PROTOCOL_VERSION,
      },
      observations: {
        corpus,
        preflight,
        recall,
        rss,
        backlog,
        crashRecovery: crash.observations,
      },
      notes: [
        "Production context-windowd entrypoint and StoreClient RPC APIs were exercised.",
        ...notes,
      ],
    });
    return validateArchiveSystemProbeArtifact(artifact);
  } finally {
    for (const client of clients) client.close();
    if (daemon) await stopArchiveSystemDaemon(daemon).catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(socketRoot, { recursive: true, force: true });
  }
}
