import { RocksStore } from "../src/rocksdb/store.js";
import {
  admitDocument,
} from "../src/rocksdb/manifests.js";
import { retentionKeys } from "../src/rocksdb/retention.js";
import { MAX_PROTECTED_DOCUMENT_VERSIONS } from "../src/store-contract.js";
import { DaemonOperations } from "../src/daemon/operations.js";

const [mode, storePath] = process.argv.slice(2);
const project = "/workspace/protect-memory";
const metadataBytes = 160 * 1_024;

if (!storePath) throw new TypeError("usage: protect-memory-child MODE STORE_PATH");

function documentId(index) {
  return `protect-memory-${String(index).padStart(4, "0")}`;
}

function metadataHeavyDocument(index) {
  const id = documentId(index);
  return {
    documentId: id,
    version: 1,
    sourceKey: `source-${index}`,
    sourceKeyStatus: "preserved",
    sessionId: "protect-memory-session",
    project,
    kind: "turn",
    createdAt: index + 1,
    text: `protect ${index}`,
    metadata: { padding: `${index}:${"m".repeat(metadataBytes)}` },
    sourceMessageKeys: [`source-${index}`],
  };
}

if (mode === "setup") {
  const store = await RocksStore.open(storePath);
  try {
    for (let index = 0; index < MAX_PROTECTED_DOCUMENT_VERSIONS; index += 1) {
      await admitDocument(store, {
        idempotencyKey: `protect-memory-${index}`,
        document: metadataHeavyDocument(index),
        structuralMessages: [],
        retentionClass: "conversation-source",
      });
    }
    await store.flush();
  } finally {
    store.close();
  }
} else if (mode === "measure") {
  const store = await RocksStore.open(storePath);
  try {
    const documentVersions = Array.from(
      { length: MAX_PROTECTED_DOCUMENT_VERSIONS },
      (_, index) => ({ documentId: documentId(index), version: 1 }),
    );
    globalThis.gc?.();
    const baselineRss = process.memoryUsage.rss();
    const result = await DaemonOperations.prototype.protect.call({ store }, {
      ownerId: "protect-memory-owner",
      ttlMs: 60_000,
      sessionIds: [],
      documentVersions,
    }, { project });
    globalThis.gc?.();
    const finalRss = process.memoryUsage.rss();
    const peakRss = process.resourceUsage().maxRSS * 1_024;
    const protection = store.scan(retentionKeys.protection("probe").slice(0, -1), {
      limit: 1,
      fillCache: false,
    })[0]?.payload;
    process.stdout.write(`${JSON.stringify({
      baselineRss,
      finalRss,
      peakRss,
      protectedDocuments: result.protectedDocuments,
      persistedDocuments: protection.documentVersions.length,
    })}\n`);
  } finally {
    store.close();
  }
} else {
  throw new TypeError(`unknown mode ${JSON.stringify(mode)}`);
}
