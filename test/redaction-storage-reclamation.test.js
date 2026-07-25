import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { decodeKey, KEYSPACE } from "../src/rocksdb/keys.js";
import { admitDocument } from "../src/rocksdb/manifests.js";
import { RocksStore } from "../src/rocksdb/store.js";

const REDACTED_PROJECT = "/fixture/redaction/alpha";
const CONTROL_PROJECT = "/fixture/redaction/beta";
const DOCUMENTS_PER_PROJECT = 12;
const SCAN_LIMIT = 100_000;

// Deterministic prose with enough distinct terms that each document produces a
// realistic spread of index postings rather than a handful of shared ones.
const VOCABULARY = ("archive retention compaction manifest posting locator epoch daemon window session "
  + "document supersession migration outbox derived lease throughput latency recall gather traverse "
  + "preflight structural importance tokenizer statistics generation redaction reclamation")
  .split(" ");

function documentText(seed) {
  let state = seed * 2_654_435_761 % 2_147_483_647;
  const next = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_647) / 2_147_483_647;
  return Array.from({ length: 80 }, () => VOCABULARY[Math.floor(next() * VOCABULARY.length)]).join(" ");
}

function admissionRequest(project, tag, index) {
  return {
    idempotencyKey: `${tag}:${index}`,
    document: {
      documentId: `${tag}-${index}`,
      version: 1,
      sourceKey: `key:${tag}:${index}`,
      sourceMessageKeys: [`key:${tag}:${index}`],
      sessionId: `session-${tag}`,
      project,
      kind: "turn",
      createdAt: 1_700_000_000_000 + index * 1_000,
      text: documentText(index + 1),
      metadata: {},
    },
    retentionClass: "conversation-source",
  };
}

/**
 * Records whose key still names `project`, grouped by keyspace namespace.
 * Attribution is by decoded key field rather than by a namespace allowlist so
 * a newly added project-keyed namespace is caught without updating this test.
 */
function recordsNamingProject(store, project) {
  const namespaces = new Map();
  let records = 0;
  let valueBytes = 0;
  for (const keyspace of Object.values(KEYSPACE)) {
    for (const record of store.iterate([keyspace], { limit: SCAN_LIMIT, fillCache: false })) {
      let fields;
      try {
        fields = decodeKey(record.keyBytes).map(String);
      } catch {
        continue;
      }
      if (!fields.includes(project)) continue;
      const namespace = fields.slice(0, 2).join("/");
      const entry = namespaces.get(namespace) ?? { records: 0, valueBytes: 0 };
      entry.records += 1;
      entry.valueBytes += record.storedValueBytes ?? 0;
      namespaces.set(namespace, entry);
      records += 1;
      valueBytes += record.storedValueBytes ?? 0;
    }
  }
  return { records, valueBytes, namespaces };
}

function describeNamespaces(inventory) {
  return [...inventory.namespaces]
    .sort(([, left], [, right]) => right.records - left.records)
    .map(([namespace, { records, valueBytes }]) => `  ${namespace}: ${records} records, ${valueBytes} bytes`)
    .join("\n");
}

async function redactProject(handlers, project) {
  const context = { project, readProjects: [project], grantedReadScope: "project" };
  for (let page = 0; page < 1_000; page += 1) {
    const result = await handlers["store.redact"]({
      scope: "project",
      confirm: basename(project),
      batchSize: 1_000,
    }, context);
    if (result.status === "complete") return;
  }
  throw new Error("Project redaction did not converge.");
}

async function runRetentionToCompletion(handlers, project) {
  const context = { project, readProjects: [project], grantedReadScope: "project" };
  // Retention is expiry-driven; advance well past every tombstone grace so the
  // sweep has no remaining reason to defer deletion.
  const now = Date.now() + 365 * 24 * 60 * 60 * 1_000;
  for (let page = 0; page < 1_000; page += 1) {
    const result = await handlers["retention.run"]({
      now,
      force: true,
      batchSize: 10_000,
    }, context);
    if (result.status !== "more-work") return;
  }
  throw new Error("Retention did not converge.");
}

async function withArchive(run) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-redaction-reclamation-"));
  const store = await RocksStore.open(join(directory, "archive.rocks"));
  const indexPath = join(directory, "semantic-index");
  const runtime = await createDaemonOperations(store, {
    maintenance: {},
    semantic: { enabled: false, indexPath },
    reranker: { enabled: false },
  });
  try {
    for (const [project, tag] of [[REDACTED_PROJECT, "a"], [CONTROL_PROJECT, "b"]]) {
      for (let index = 0; index < DOCUMENTS_PER_PROJECT; index += 1) {
        await admitDocument(store, admissionRequest(project, tag, index), {});
      }
    }
    await runtime.drainIndexUntilIdle();
    await run({ store, runtime, handlers: runtime.handlers(), indexPath });
  } finally {
    await runtime.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Stand in for an embedded project by writing the on-disk index directory the
 * semantic layer would own. Building real vectors would require a model, and
 * what this test is about is whether the directory survives a purge.
 */
function seedSemanticIndex(runtime, indexPath, project) {
  const directory = runtime.semantic.projectDirectory(project);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.usearch"), Buffer.alloc(1024));
  writeFileSync(join(directory, "metadata.json"), JSON.stringify({ project }));
  assert.ok(existsSync(directory), "fixture must create the project index directory");
  assert.ok(directory.startsWith(indexPath), "project index must live under the configured index path");
  return directory;
}

test("project redaction reclaims every record keyed to the redacted project", async () => {
  await withArchive(async ({ store, runtime, handlers }) => {
    const before = recordsNamingProject(store, REDACTED_PROJECT);
    assert.ok(before.records > 0, "the fixture must produce project-keyed records to reclaim");

    await redactProject(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();
    await runRetentionToCompletion(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();

    const after = recordsNamingProject(store, REDACTED_PROJECT);
    assert.equal(
      after.records,
      0,
      `Redaction left ${after.records} records (${after.valueBytes} bytes) keyed to a project with no live `
        + `documents; ${before.records} existed before redaction. Surviving namespaces:\n`
        + `${describeNamespaces(after)}`,
    );
  });
});

test("project redaction reclaims the project's semantic index", async () => {
  await withArchive(async ({ runtime, handlers, indexPath }) => {
    const redacted = seedSemanticIndex(runtime, indexPath, REDACTED_PROJECT);
    const control = seedSemanticIndex(runtime, indexPath, CONTROL_PROJECT);

    await redactProject(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();
    await runRetentionToCompletion(handlers, REDACTED_PROJECT);

    assert.equal(
      existsSync(redacted),
      false,
      `Redaction left the project's vectors on disk at ${redacted}; the keyspace sweep does not `
        + "reach the semantic index, so they would survive indefinitely.",
    );
    assert.equal(
      existsSync(control),
      true,
      "Redacting one project must not delete another project's semantic index.",
    );
  });
});

test("project redaction does not reclaim an unrelated project", async () => {
  await withArchive(async ({ store, runtime, handlers }) => {
    const before = recordsNamingProject(store, CONTROL_PROJECT);

    await redactProject(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();
    await runRetentionToCompletion(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();

    const after = recordsNamingProject(store, CONTROL_PROJECT);
    assert.equal(
      after.records,
      before.records,
      "Redacting one project must not delete records belonging to another.",
    );
  });
});

test("redacting a project never grows its stored footprint", async () => {
  await withArchive(async ({ store, runtime, handlers }) => {
    const before = recordsNamingProject(store, REDACTED_PROJECT);

    await redactProject(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();
    await runRetentionToCompletion(handlers, REDACTED_PROJECT);
    await runtime.drainIndexUntilIdle();

    const after = recordsNamingProject(store, REDACTED_PROJECT);
    // Redaction adds tombstones, supersessions, and cleanup manifests. Those
    // additions must not outweigh what the sweep removes, or purging a project
    // costs more storage than keeping it.
    assert.ok(
      after.records <= before.records,
      `Redaction grew the redacted project's footprint from ${before.records} to ${after.records} records `
        + `(${before.valueBytes} to ${after.valueBytes} bytes). Surviving namespaces:\n`
        + `${describeNamespaces(after)}`,
    );
  });
});
