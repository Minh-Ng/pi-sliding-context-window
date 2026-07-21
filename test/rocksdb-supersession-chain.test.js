import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KEYSPACE } from "../src/rocksdb/keys.js";
import {
  admitDocument,
  manifestKeys,
  MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH,
} from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { supersessionChainView } from "../src/rocksdb/supersession-chain.js";

const PROJECT = "/workspace/supersession-chain";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

function request(id, text, overrides = {}) {
  const version = overrides.version ?? 1;
  const sourceKey = overrides.sourceKey ?? `user:${id}:${version}`;
  return {
    idempotencyKey: overrides.idempotencyKey ?? `chain:${id}:${version}`,
    document: {
      documentId: id,
      version,
      sourceKey,
      sessionId: overrides.sessionId ?? "session-main",
      project: overrides.project ?? PROJECT,
      kind: overrides.kind ?? "manual",
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
  return store;
}

async function manifestFor(store, documentId, version = 1) {
  const manifest = await store.get(manifestKeys.document(documentId, version));
  assert.ok(manifest, `manifest for ${documentId}@${version} must exist`);
  return manifest;
}

test("supersessionChainView returns undefined for a document that neither supersedes nor is superseded", async (t) => {
  const store = await fixture(t, "standalone");
  await admit(store, "standalone-note", "Nothing else references this.", { createdAt: 100 });

  const manifest = await manifestFor(store, "standalone-note");
  const chain = await store.snapshot((view) => supersessionChainView(view, manifest));

  assert.equal(chain, undefined);
});

test("supersessionChainView reports position k of n and immediate predecessor/successor across an explicit chain", async (t) => {
  const store = await fixture(t, "artifact-chain");
  const subjectKey = "artifact:deploy-plan";
  await admit(store, "plan-v1", "Draft deploy plan.", { createdAt: 100, subjectKey });
  await admit(store, "plan-v2", "Revised deploy plan.", {
    createdAt: 200,
    subjectKey,
    supersedes: { documentId: "plan-v1", version: 1 },
  });
  await admit(store, "plan-v3", "Final deploy plan.", {
    createdAt: 300,
    subjectKey,
    supersedes: { documentId: "plan-v2", version: 1 },
  });

  const manifestV1 = await manifestFor(store, "plan-v1");
  const v1 = await store.snapshot((view) => supersessionChainView(view, manifestV1));
  assert.deepEqual(v1, {
    position: 1,
    totalVersions: 3,
    successor: { documentId: "plan-v2", version: 1, createdAt: 200 },
  });

  const manifestV2 = await manifestFor(store, "plan-v2");
  const v2 = await store.snapshot((view) => supersessionChainView(view, manifestV2));
  assert.deepEqual(v2, {
    position: 2,
    totalVersions: 3,
    predecessor: { documentId: "plan-v1", version: 1, createdAt: 100 },
    successor: { documentId: "plan-v3", version: 1, createdAt: 300 },
  });

  const manifestV3 = await manifestFor(store, "plan-v3");
  const v3 = await store.snapshot((view) => supersessionChainView(view, manifestV3));
  assert.deepEqual(v3, {
    position: 3,
    totalVersions: 3,
    predecessor: { documentId: "plan-v2", version: 1, createdAt: 200 },
  });
});

test("supersessionChainView never follows an automatic same-document version bump as a chain hop", async (t) => {
  const store = await fixture(t, "automatic-version");
  await admit(store, "note", "First cut.", { createdAt: 100 });
  await admit(store, "note", "Second cut.", { createdAt: 200, version: 2 });

  const v1 = await manifestFor(store, "note", 1);
  const chain = await store.snapshot((view) => supersessionChainView(view, v1));

  assert.equal(chain, undefined, "an automatic version bump is a distinct mechanism from an explicit subjectKey chain");
});

test("supersessionChainView bounds a corrupted cycle instead of looping unboundedly", async (t) => {
  const store = await fixture(t, "cycle-guard");
  const subjectKey = "artifact:cycle";
  await admit(store, "cyc-a", "A.", { createdAt: 100, subjectKey });
  await admit(store, "cyc-b", "B.", {
    createdAt: 200,
    subjectKey,
    supersedes: { documentId: "cyc-a", version: 1 },
  });

  // admitDocument's own write-time validation rejects a cycle before commit;
  // simulate corrupted on-disk state that bypassed it by hand-writing a
  // backward pointer from cyc-a to cyc-b, closing a 2-node cycle
  // (cyc-b -> cyc-a -> cyc-b -> ...) that a real chain can never contain.
  const corruptedA = await manifestFor(store, "cyc-a");
  await store.put(manifestKeys.document("cyc-a", 1), {
    ...corruptedA,
    supersedes: { documentId: "cyc-b", version: 1 },
  });

  const cycB = await manifestFor(store, "cyc-b");
  const chain = await store.snapshot((view) => supersessionChainView(view, cycB));

  // The visited-set guard stops the backward walk the moment it would
  // revisit cyc-b's own identity, one hop after the corrupted pointer --
  // never an unbounded or MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH-length walk.
  assert.deepEqual(chain, {
    position: 2,
    totalVersions: 2,
    predecessor: { documentId: "cyc-a", version: 1, createdAt: 100 },
  });
});

test("MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH is the same bound the write-time cycle check enforces", () => {
  assert.equal(MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH, 4_096);
  assert.ok(Number.isSafeInteger(MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH) && MAX_EXPLICIT_SUPERSESSION_CHAIN_DEPTH > 0);
});

test("supersessionChainView requires a store or snapshot view and a manifest identity", async (t) => {
  const store = await fixture(t, "validation");
  await assert.rejects(
    () => store.snapshot((view) => supersessionChainView(view, { documentId: "x" })),
    TypeError,
  );
  await assert.rejects(
    () => supersessionChainView(undefined, { documentId: "x", version: 1, project: PROJECT }),
    TypeError,
  );
});

// Sanity: the KEYSPACE.SUPERSESSION marker this module reads is the same one
// admitDocument writes, so a schema drift in either place fails loudly here
// rather than silently returning undefined chains everywhere.
test("supersessionChainView reads the same SUPERSESSION keyspace admitDocument writes", async (t) => {
  const store = await fixture(t, "keyspace-identity");
  const subjectKey = "artifact:keyspace-check";
  await admit(store, "ks-a", "A.", { createdAt: 100, subjectKey });
  await admit(store, "ks-b", "B.", {
    createdAt: 200,
    subjectKey,
    supersedes: { documentId: "ks-a", version: 1 },
  });
  const marker = await store.get([KEYSPACE.SUPERSESSION, "ks-a", 1]);
  assert.equal(marker.status, "superseded");
  assert.equal(marker.supersessionType, "explicit");

  const manifestA = await manifestFor(store, "ks-a");
  const chain = await store.snapshot((view) => supersessionChainView(view, manifestA));
  assert.equal(chain.successor.documentId, "ks-b");
});
