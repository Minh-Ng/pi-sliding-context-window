import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import {
  findDependentDocuments,
  MAX_DEPENDENT_CANDIDATES,
  MAX_DEPENDENT_DOCUMENT_IDS,
} from "../src/rocksdb/dependents.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import { admitDocument, manifestKeys } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

const PROJECT = "/workspace/dependents";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(id, text, overrides = {}) {
  const version = overrides.version ?? 1;
  const sourceKey = overrides.sourceKey ?? `user:${id}:${version}`;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `dependents:${id}:${version}`,
    document: {
      documentId: id,
      version,
      sourceKey,
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? PROJECT,
      kind: overrides.kind ?? "turn",
      createdAt: overrides.createdAt ?? version * 100,
      text,
      metadata: overrides.metadata ?? {},
      sourceMessageKeys: overrides.sourceMessageKeys ?? [sourceKey],
      ...(overrides.subjectKey === undefined ? {} : { subjectKey: overrides.subjectKey }),
      ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
    },
    structuralMessages: [],
    retentionClass: "conversation-source",
  };
}

async function admit(store, id, text, overrides = {}) {
  return admitDocument(store, request(id, text, overrides), {
    chunking: { maxChunkBytes: 256, minLineSplitBytes: 0 },
    windows: { windowTokens: 32, overlapTokens: 4 },
  });
}

async function fixture(t, name) {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `dependents-worker:${name}`,
    maxDrainMs: 30_000,
    handlers: [createExactIndexHandler(), createBm25IndexHandler()],
  });
  return { store, worker };
}

async function targetFor(store, documentId, version = 1) {
  const manifest = await store.get(manifestKeys.document(documentId, version));
  assert.ok(manifest, `manifest for ${documentId}@${version} must exist`);
  return {
    documentId: manifest.documentId,
    version: manifest.version,
    project: manifest.project,
    sessionId: manifest.sessionId,
    createdAt: manifest.createdAt,
    subjectKey: manifest.subjectKey,
    sourceMessageKeys: manifest.sourceMessageKeys,
  };
}

test("findDependentDocuments surfaces a later document that cites the target's documentId, not an unrelated one", async (t) => {
  const { store, worker } = await fixture(t, "citation");
  await admit(store, "decision-alpha", "Use the new deploy pipeline.", { createdAt: 100 });
  await admit(store, "note-citing-alpha", "Per decision-alpha, the rollout starts Monday.", { createdAt: 200 });
  await admit(store, "note-unrelated", "The weather was fine and nothing else happened.", { createdAt: 300 });
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const target = await targetFor(store, "decision-alpha");
  const dependents = await store.snapshot((view) => findDependentDocuments(view, target));

  assert.equal(dependents.count, 1);
  assert.deepEqual(dependents.documentIds, ["note-citing-alpha"]);
});

test("findDependentDocuments surfaces a later document sharing the target's own source message", async (t) => {
  const { store } = await fixture(t, "source-overlap");
  await admit(store, "turn-source", "Original conversational turn.", {
    createdAt: 100,
    sourceMessageKeys: ["user:shared:1"],
    sourceKey: "user:shared:1",
  });
  await admit(store, "derived-decision", "A decision extracted from the same turn.", {
    createdAt: 200,
    sourceMessageKeys: ["user:shared:1"],
  });
  await admit(store, "different-turn", "A completely different exchange.", {
    createdAt: 300,
    sourceMessageKeys: ["user:other:1"],
    sourceKey: "user:other:1",
  });

  const target = await targetFor(store, "turn-source");
  const dependents = await store.snapshot((view) => findDependentDocuments(view, target));

  assert.equal(dependents.count, 1);
  assert.deepEqual(dependents.documentIds, ["derived-decision"]);
});

test("findDependentDocuments walks subjectKey lineage past the direct successor, but never reports the direct successor itself", async (t) => {
  const { store } = await fixture(t, "lineage");
  await admit(store, "root-decision", "Ship the printer driver as-is.", {
    createdAt: 100,
    subjectKey: "decision:printer-driver",
  });
  await admit(store, "root-decision-v2", "Ship the patched printer driver instead.", {
    createdAt: 200,
    subjectKey: "decision:printer-driver",
    supersedes: { documentId: "root-decision", version: 1 },
  });
  await admit(store, "root-decision-v3", "Ship the rewritten printer driver.", {
    createdAt: 300,
    subjectKey: "decision:printer-driver",
    supersedes: { documentId: "root-decision-v2", version: 1 },
  });

  const target = await targetFor(store, "root-decision");
  const dependents = await store.snapshot((view) => findDependentDocuments(view, target));

  assert.equal(dependents.count, 1, "the direct successor is the deliberate replacement, not a discovered dependent");
  assert.deepEqual(dependents.documentIds, ["root-decision-v3"]);
});

test("findDependentDocuments never surfaces documents admitted before the target, even if they cite it", async (t) => {
  const { store, worker } = await fixture(t, "before");
  await admit(store, "earlier-note", "Per decision-beta, we already agreed.", { createdAt: 50 });
  await admit(store, "decision-beta", "Use the new deploy pipeline.", { createdAt: 100 });
  await worker.drain({ limit: 10, maxDurationMs: 30_000, throwOnError: true });

  const target = await targetFor(store, "decision-beta");
  const dependents = await store.snapshot((view) => findDependentDocuments(view, target));

  assert.equal(dependents.count, 0);
  assert.deepEqual(dependents.documentIds, []);
});

test("findDependentDocuments caps the recallable document ID list independently of the total found", async (t) => {
  const { store, worker } = await fixture(t, "cap");
  await admit(store, "decision-gamma", "Use the new deploy pipeline.", { createdAt: 100 });
  for (let index = 0; index < MAX_DEPENDENT_DOCUMENT_IDS + 5; index += 1) {
    await admit(store, `citing-${index}`, `Per decision-gamma, item ${index} follows.`, {
      createdAt: 200 + index,
    });
  }
  await worker.drain({ limit: 64, maxDurationMs: 30_000, throwOnError: true });

  const target = await targetFor(store, "decision-gamma");
  const dependents = await store.snapshot((view) => findDependentDocuments(view, target));

  assert.ok(dependents.documentIds.length <= MAX_DEPENDENT_DOCUMENT_IDS);
  assert.equal(dependents.documentIds.length, MAX_DEPENDENT_DOCUMENT_IDS);
  assert.ok(dependents.count >= dependents.documentIds.length);
  assert.ok(dependents.count <= MAX_DEPENDENT_CANDIDATES);
});

test("findDependentDocuments requires a well-formed target identity", async (t) => {
  const { store } = await fixture(t, "validation");
  await assert.rejects(
    () => store.snapshot((view) => findDependentDocuments(view, { documentId: "x" })),
    TypeError,
  );
});
