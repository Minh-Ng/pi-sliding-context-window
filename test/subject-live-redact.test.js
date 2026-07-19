import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBm25IndexHandler } from "../src/rocksdb/index/bm25.js";
import { createExactIndexHandler } from "../src/rocksdb/index/exact.js";
import { createStructuralIndexHandler } from "../src/rocksdb/index/structural.js";
import { IndexWorker } from "../src/rocksdb/indexer.js";
import {
  admitDocument,
  resolveLiveSubject,
} from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { tombstoneDocument } from "../src/rocksdb/retention.js";
import { searchArchive } from "../src/retrieval/search.js";

function temporaryStorePath(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `context-window-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "archive.rocks");
}

async function fixture(t, name) {
  const store = await RocksStore.open(temporaryStorePath(t, name));
  t.after(() => store.close());
  const worker = new IndexWorker(store, {
    workerId: `test-${name}`,
    handlers: [
      createExactIndexHandler(),
      createBm25IndexHandler(),
      createStructuralIndexHandler(),
    ],
  });
  return {
    store,
    worker,
    async admit(id, text, overrides = {}) {
      await admitDocument(store, {
        idempotencyKey: `admit:${id}:${overrides.version ?? 1}`,
        document: {
          documentId: id,
          version: overrides.version ?? 1,
          sourceKey: `user:${id}`,
          sessionId: overrides.sessionId ?? "session-a",
          project: overrides.project ?? "/workspace/demo",
          kind: overrides.kind ?? "decision-candidate",
          createdAt: overrides.createdAt ?? 100,
          text,
          metadata: { turnId: `turn-${id}` },
          sourceMessageKeys: [`user:${id}`],
          ...(overrides.subjectKey === undefined ? {} : { subjectKey: overrides.subjectKey }),
          ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
        },
        retentionClass: "derived-evidence",
      });
    },
  };
}

test("subject-live tracks and requires supersedes for a new holder", async (t) => {
  const { store, admit } = await fixture(t, "subject-live");
  const subjectKey = "decision:job_queue";
  await admit("decision-old", "We'll use Redis for job_queue.", {
    createdAt: 100,
    subjectKey,
  });
  const live = await resolveLiveSubject(store, {
    project: "/workspace/demo",
    subjectKey,
  });
  assert.deepEqual(live, {
    documentId: "decision-old",
    version: 1,
    kind: "decision-candidate",
    subjectKey,
    project: "/workspace/demo",
  });

  await assert.rejects(
    () => admit("decision-conflict", "We'll use Postgres for job_queue.", {
      createdAt: 200,
      subjectKey,
    }),
    /admit with supersedes targeting that live subject/u,
  );

  await admit("decision-new", "We'll use Postgres for job_queue.", {
    createdAt: 200,
    subjectKey,
    supersedes: { documentId: "decision-old", version: 1 },
  });
  const next = await resolveLiveSubject(store, {
    project: "/workspace/demo",
    subjectKey,
  });
  assert.equal(next.documentId, "decision-new");
});

test("tombstone clears subject-live and hides the document from search", async (t) => {
  const { store, worker, admit } = await fixture(t, "redact-subject");
  const subjectKey = "decision:REAP_DRAIN";
  await admit("to-redact", "We'll keep REAP_DRAIN enabled.", {
    createdAt: 100,
    subjectKey,
    kind: "turn",
  });
  await worker.drain();
  const before = await searchArchive(store, {
    query: "REAP_DRAIN",
    relation: null,
    scope: "project",
    project: "/workspace/demo",
    limit: 5,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 0,
  });
  assert.equal(before.results.some(({ documentId }) => documentId === "to-redact"), true);

  const tombstoned = await tombstoneDocument(store, {
    documentId: "to-redact",
    version: 1,
    now: 1_000,
    ignoreProtection: true,
  });
  assert.equal(tombstoned.status, "tombstoned");
  assert.equal(
    await resolveLiveSubject(store, { project: "/workspace/demo", subjectKey }),
    undefined,
  );
});
