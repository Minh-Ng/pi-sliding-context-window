import { RocksStore } from "../src/rocksdb/store.js";
import {
  createDocumentManifest,
  manifestKeys,
} from "../src/rocksdb/manifests.js";
import {
  createChunkReferences,
  splitPhysicalChunks,
} from "../src/rocksdb/chunks.js";
import { DaemonOperations } from "../src/daemon/operations.js";
import { auxiliaryOwnershipIndexKeys } from "../src/rocksdb/auxiliary-ownership.js";

const [mode, storePath, requestedCount] = process.argv.slice(2);
const documentCount = Number(requestedCount);
const project = "/workspace/status-memory";

if (!storePath || !Number.isSafeInteger(documentCount) || documentCount <= 0) {
  throw new TypeError("usage: status-memory-child MODE STORE_PATH DOCUMENT_COUNT");
}

function largeManifest(index) {
  const documentId = `status-memory-${String(index).padStart(4, "0")}`;
  const text = `document ${index}`;
  const chunks = createChunkReferences(splitPhysicalChunks(text));
  return createDocumentManifest({
    documentId,
    version: 1,
    sourceKey: `source-${index}`,
    sourceKeyStatus: "preserved",
    sessionId: "status-memory-session",
    project,
    kind: "turn",
    createdAt: index + 1,
    text,
    metadata: { padding: "m".repeat((1 * 1_024 * 1_024) - 1_024) },
    sourceMessageKeys: Array.from(
      { length: 256 },
      (_, keyIndex) => `source-${index}-${keyIndex}-${"s".repeat(960)}`,
    ),
  }, {
    chunks,
    retentionClass: "conversation-source",
    structuralMessages: [{
      messageKey: `message-${index}`,
      messageIndex: 0,
      role: "user",
      createdAt: index + 1,
      text: "t".repeat((1 * 1_024 * 1_024) - 1_024),
      questionScore: 100,
      requestScore: 0,
      correctionScore: 0,
      answerScore: 0,
    }],
  });
}

if (mode === "setup" || mode === "setup-ownership") {
  const store = await RocksStore.open(storePath);
  try {
    for (let index = 0; index < documentCount; index += 1) {
      const documentId = `status-memory-${String(index).padStart(4, "0")}`;
      await store.put(
        manifestKeys.document(documentId, 1),
        largeManifest(index),
        { kind: "document-manifest" },
      );
      await store.put(
        manifestKeys.sessionDocumentReference(project, "status-memory-session", documentId, 1),
        {
          project,
          sessionId: "status-memory-session",
          documentId,
          documentVersion: 1,
        },
        { kind: "session-document-reference" },
      );
    }
    if (mode === "setup-ownership") {
      await store.remove(auxiliaryOwnershipIndexKeys.state());
    }
    await store.flush();
  } finally {
    store.close();
  }
} else if (mode === "measure") {
  const store = await RocksStore.open(storePath);
  const runtime = new DaemonOperations(store, {
    maintenance: { intervalMs: 60 * 60 * 1_000 },
  });
  try {
    globalThis.gc?.();
    const baselineRss = process.memoryUsage.rss();
    const status = await runtime.status(project);
    const counted = await runtime.count({ scope: "project" }, { project });
    globalThis.gc?.();
    const finalRss = process.memoryUsage.rss();
    const peakRss = process.resourceUsage().maxRSS * 1_024;
    process.stdout.write(`${JSON.stringify({
      baselineRss,
      finalRss,
      peakRss,
      statusDocuments: status.counts.documents,
      statusApproximate: status.counts.approximate,
      exactCount: counted.count,
    })}\n`);
  } finally {
    await runtime.close();
    store.close();
  }
} else if (mode === "measure-ownership") {
  globalThis.gc?.();
  const baselineRss = process.memoryUsage.rss();
  const store = await RocksStore.open(storePath);
  try {
    const state = await store.get(auxiliaryOwnershipIndexKeys.state());
    globalThis.gc?.();
    process.stdout.write(`${JSON.stringify({
      baselineRss,
      finalRss: process.memoryUsage.rss(),
      peakRss: process.resourceUsage().maxRSS * 1_024,
      state,
    })}\n`);
  } finally {
    store.close();
  }
} else {
  throw new TypeError(`unknown mode ${JSON.stringify(mode)}`);
}
