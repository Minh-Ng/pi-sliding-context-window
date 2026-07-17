import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBm25IndexHandler } from "../../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../../src/rocksdb/index/structural.js";
import { IndexWorker } from "../../src/rocksdb/indexer.js";
import { admitDocument } from "../../src/rocksdb/manifests.js";
import { RocksStore } from "../../src/rocksdb/store.js";
import { preflightArchive } from "../../src/retrieval/preflight.js";
import { recallArchive } from "../../src/retrieval/recall.js";
import { searchArchive } from "../../src/retrieval/search.js";
import { RETRIEVAL_BACKEND_API_VERSION } from "./schema.js";

const EVALUATION_PROJECT = "/fixture/project";
const EVALUATION_SESSION = "session-main";

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

function sourceKeys(document) {
  const configured = document.metadata?.sourceMessageKeys;
  if (Array.isArray(configured) && configured.length > 0) return [...configured];
  return [`eval:${document.id}`];
}

function structuralMessages(document) {
  return (document.structuralMessages ?? []).map((message, messageIndex) => ({
    ...message,
    messageIndex,
    createdAt: document.createdAt + messageIndex,
  }));
}

function admissionRequest(fixture, document) {
  const messageKeys = sourceKeys(document);
  return {
    idempotencyKey: `evaluation:${fixture.fixtureId}:${document.id}:1`,
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
    structuralMessages: structuralMessages(document),
    retentionClass: "conversation-source",
  };
}

function admissionOptions(fixture) {
  return {
    chunking: {
      maxChunkBytes: fixture.chunking.targetBytes,
      minLineSplitBytes: 0,
    },
    windows: {
      windowTokens: fixture.chunking.targetBytes,
      overlapTokens: fixture.chunking.overlapBytes,
      tokenize: utf8ScalarTokens,
    },
  };
}

async function drainUntilIdle(worker) {
  for (;;) {
    const result = await worker.drain({
      limit: 1_024,
      maxDurationMs: 30_000,
      throwOnError: true,
    });
    if (result.terminal === "idle") return;
    if (result.terminal !== "limit") {
      throw new Error(`RocksDB evaluation index drain stopped at ${result.terminal}.`);
    }
  }
}

function searchRequest(request) {
  return {
    query: request.query,
    relation: request.mode === "structural" ? request.relation : null,
    sessionId: request.sessionId,
    sessionIds: request.sessionIds,
    project: request.project,
    scope: request.scope,
    limit: request.limit,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  };
}

function recallCoordinates(response) {
  if (response.status !== "resolved" || !Array.isArray(response.chunks) || response.chunks.length === 0) {
    return { startByte: -1, endByte: -1 };
  }
  return {
    startByte: response.chunks[0].startByte,
    endByte: response.chunks.at(-1).endByte,
  };
}

export async function createRocksdbEvaluationBackend() {
  const directory = mkdtempSync(join(tmpdir(), "context-window-rocksdb-retrieval-eval-"));
  let store;
  let worker;
  try {
    store = await RocksStore.open(join(directory, "archive.rocks"));
    worker = new IndexWorker(store, {
      workerId: `retrieval-evaluation:${process.pid}`,
      maxDrainMs: 30_000,
      handlers: [
        createExactIndexHandler(),
        createBm25IndexHandler(),
        createStructuralIndexHandler(),
      ],
    });
  } catch (error) {
    try {
      store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
  let prepared = false;
  let closed = false;

  return {
    metadata: Object.freeze({
      id: "rocksdb-archive",
      version: "schema-v1",
      apiVersion: RETRIEVAL_BACKEND_API_VERSION,
      capabilities: Object.freeze(["exact", "lexical", "structural", "chunks", "hints"]),
    }),
    async prepare(fixture) {
      if (prepared) throw new Error("RocksDB evaluation backend may only be prepared once");
      const options = admissionOptions(fixture);
      for (const document of fixture.documents) {
        await admitDocument(store, admissionRequest(fixture, document), options);
      }
      await drainUntilIdle(worker);
      prepared = true;
    },
    async search(request) {
      if (!prepared) throw new Error("RocksDB evaluation backend has not been prepared");
      const response = await searchArchive(store, searchRequest(request), {
        ownerId: `evaluation:${request.mode}:${request.query}`,
      });
      return {
        ...response,
        results: response.results.map((result) => ({
          ...result,
          messageKey: result.source?.messageKey,
        })),
      };
    },
    async recall(request) {
      if (!prepared) throw new Error("RocksDB evaluation backend has not been prepared");
      const response = await recallArchive(store, request, {
        project: EVALUATION_PROJECT,
        scope: "session",
        sessionIds: [EVALUATION_SESSION],
      });
      return {
        ...response,
        ...recallCoordinates(response),
        canonicalText: response.text ?? "",
      };
    },
    async preflight(request) {
      if (!prepared) throw new Error("RocksDB evaluation backend has not been prepared");
      return preflightArchive(store, request, {
        epochId: request.epochId,
        now: request.now,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export const createEvaluationBackend = createRocksdbEvaluationBackend;
export default createRocksdbEvaluationBackend;
