**Execution model**

Tasks are sized for independent agents and arranged in waves. An agent owns only the listed production paths unless it coordinates a handoff. Tests may be added under matching unique filenames without taking ownership of unrelated tests.

**Dependency graph**

| Wave | Parallel tasks | Starts after |
|---|---|---|
| 0A | T01, T02 | Semantic guides accepted |
| 0B | T03 | T01 hands off `package.json` |
| 1 | T04, T05 | T01 and T02 |
| 2 | T06 | T05 |
| 3 | T07, T11 | T06 |
| 4 | T08, T09, T10 | T07 |
| 5 | T12 | T08 through T10 |
| 6 | T13, T14 | T12 |
| 7 | T15 | T13 and T03 |
| 8 | T16 | T04 and T12 through T15 |
| 9 | T17 | All implementation tasks |

T16 owns adapter integration and therefore runs after agents modifying retrieval and preflight core have handed off. T17 owns cutover and release evidence and runs last.

**T01 — RocksDB binding and baseline spike**

- Reads: `architecture.md`, `evaluation.md`.
- Owns: `bench/archive/**`, `test/rocksdb-binding.test.js`, dependency entries in `package.json` and `package-lock.json`.
- Produces: Node 22.19 binding smoke test, transactions, column-family behavior, concurrent threads, range iteration, manual compaction, property access, and SQLite baseline artifact.
- Verifier: `node --test test/rocksdb-binding.test.js && npm run bench:archive -- --baseline --allow-partial`.
- Done when: supported platforms load prebuilt bindings, no user archive is touched, and the baseline artifact satisfies `evaluation.md` metadata validation.

**T02 — Versioned storage and RPC contracts**

- Reads: all semantic guides.
- Owns: `src/store-contract.js`, `src/store-protocol.js`, `test/store-contract.test.js`.
- Produces: JSDoc or TypeScript-checkable request, response, error, locator, schema, and protocol definitions without a backend implementation.
- Verifier: `node --test test/store-contract.test.js && npm run check`.
- Done when: every current archive operation and planned daemon operation has a typed versioned contract, unknown fields, excessive admission size or nesting, unsafe error payloads, and incompatible versions fail deterministically, and downstream tasks import rather than duplicate definitions.

**T03 — Evaluation harness and frozen fixtures**

- Reads: `evaluation.md`, `retrieval.md`.
- Owns: `eval/retrieval/**`, `test/retrieval-eval.test.js`, evaluation script entries in `package.json`.
- Produces: fixture schema, deterministic generators, scoring, artifact validation, initial regression corpus, and held-out handling rules.
- Verifier: `node --test test/retrieval-eval.test.js && npm run eval:retrieval -- --validate-only`.
- Done when: fixture order, hashes, annotations, results, and exposure state are validated independently of any RocksDB implementation.

**T04 — Single-owner daemon and client transport**

- Depends: T02.
- Reads: `architecture.md`, `migration-operations.md`.
- Owns: `bin/context-windowd.js`, `src/daemon/**`, `src/store-client.js`, `test/daemon.test.js`.
- Produces: Unix-socket daemon, singleton ownership, protocol handshake, reconnecting client, clean shutdown, status endpoint, and temporary test launcher.
- Verifier: `node --test test/daemon.test.js`.
- Done when: eight child-process clients can concurrently use one daemon, a second daemon cannot open the same resolved path, a lost client does not stop the service, foreground index faults cannot turn committed admissions or restart recovery into availability failures, and explicitly retryable background faults re-arm without unrelated client activity.

**T05 — RocksDB schema and canonical transactions**

- Depends: T01, T02.
- Reads: `architecture.md`.
- Owns: `src/rocksdb/keys.js`, `src/rocksdb/schema.js`, `src/rocksdb/store.js`, `test/rocksdb-store.test.js`.
- Produces: versioned key encoding, schema metadata, canonical transactions, idempotency keys, snapshots, and canonical record reads.
- Verifier: `node --test test/rocksdb-store.test.js`.
- Done when: key round trips cover hostile Unicode and delimiters, native point and iterator limits fail before RocksDB access, every newly persisted key remains prefix-scan safe through restart and retention, acknowledged writes survive kill-and-restart fault injection, and duplicate requests do not duplicate canonical records.

**T06 — Canonical messages, manifests, and chunks**

- Depends: T05.
- Reads: `architecture.md`, `retrieval.md`.
- Owns: `src/rocksdb/chunks.js`, `src/rocksdb/manifests.js`, `src/rocksdb/windows.js`, `test/rocksdb-chunks.test.js`.
- Produces: source-message records, turn and tool manifests, content-addressed non-overlapping chunks, logical overlapping windows, and parent references.
- Verifier: `node --test test/rocksdb-chunks.test.js`.
- Done when: large tool content is stored once, every admitted source byte is reconstructable, per-document text, metadata, provenance, and annotation limits fail before canonical writes, boundary cases map to correct windows, and chunk/window parameters are configurable for evaluation.

**T07 — Durable outbox and background index worker**

- Depends: T05, T06.
- Reads: `architecture.md`, `migration-operations.md`.
- Owns: `src/rocksdb/outbox.js`, `src/rocksdb/indexer.js`, `test/rocksdb-indexer.test.js`.
- Produces: atomic outbox admission, idempotent worker, generation publication, backlog metrics, and restart replay.
- Verifier: `node --test test/rocksdb-indexer.test.js`.
- Done when: fault injection at each worker boundary yields an atomic complete, typed partial, or typed skipped generation; no torn handler output is published; limit failures advance the ordered cursor; and restart reproduces the same terminal outcome.

**T08 — Exact referent postings**

- Depends: T06, T07.
- Reads: `retrieval.md`.
- Owns: `src/rocksdb/index/exact.js`, `test/rocksdb-exact.test.js`.
- Produces: extraction and postings for quoted spans, paths, dotted names, camel case, snake case, commits, errors, and case-aware normalization.
- Verifier: `node --test test/rocksdb-exact.test.js && npm run eval:retrieval -- --suite exact`.
- Done when: the frozen exact suite has 100 percent Recall@3, exact paths or symbols are not broadened before lookup, bounded posting pressure retains higher-specificity anchors and is labeled partial, and snippet materialization reads no unrelated physical chunks.

**T09 — BM25 postings and segment statistics**

- Depends: T06, T07.
- Reads: `retrieval.md`, `evaluation.md`.
- Owns: `src/rocksdb/index/bm25.js`, `src/rocksdb/index/tokenizer.js`, `test/rocksdb-bm25.test.js`.
- Produces: deterministic tokenization, term positions, document lengths, segment frequencies, bounded posting merges, snippets, and score explanations.
- Verifier: `node --test test/rocksdb-bm25.test.js && npm run eval:retrieval -- --suite lexical`.
- Done when: scores reproduce from stored statistics, source analysis and successful mutation plans are bounded before publication, window metadata is sharded, thousand-window tail evidence remains searchable, snippets surround actual matches, and lexical quality is no worse than SQLite baseline.

**T10 — Structural and derived indexes**

- Depends: T06, T07.
- Reads: `retrieval.md` and current `src/structural.js` behavior.
- Owns: `src/rocksdb/index/structural.js`, `src/rocksdb/index/decisions.js`, `test/rocksdb-structural.test.js`.
- Produces: reverse chronological relation postings with canonical byte coordinates and source-linked verbatim decision excerpts with legacy ambiguity semantics.
- Verifier: `node --test test/rocksdb-structural.test.js && npm run eval:retrieval -- --suite structural`.
- Done when: supported relations resolve deterministically, relevant annotations are located in one bounded source pass, missing coordinates publish no relation rows and produce a durable skipped outcome, mutation fan-out fails before source reads, ancestor or legacy uncertainty remains labeled, and derived excerpts never invent text.

**T11 — Offline SQLite migration and static verification**

- Depends: T02, T05, T06.
- Reads: `migration-operations.md`, current `src/archive.js` and provenance tests.
- Owns: `src/migration/**`, `bin/context-window-migrate.js`, `test/migration.test.js`.
- Produces: read-only SQLite importer, explicit offline assertion, checkpoints, idempotent batches, source fingerprints, static recall parity, bounded structured verification differences, and document-owned provenance cleanup.
- Verifier: `node --test test/migration.test.js && npm run test:migration`.
- Done when: a fresh destination reaches `offline-ready` only after zero missing or extra canonical documents, source bytes and provenance agree, copy, restart, and paged verification retain no corpus-sized payload, identity, or difference collection, complete mismatch counts and hashes survive bounded sampling, restart resumes safely, artifact aliases cannot overwrite SQLite or RocksDB data, admissions remain blocked before verification, resolved failures are reclaimed, comparison history stays bounded, retired canonical documents do not retain SQLite provenance, and the SQLite fixture remains unchanged.

**T12 — Search orchestration, scoring, locators, and leases**

- Depends: T08, T09, T10.
- Reads: `retrieval.md`, `retention.md`.
- Owns: `src/retrieval/search.js`, `src/retrieval/locator.js`, `src/retrieval/leases.js`, `test/retrieval-search.test.js`.
- Produces: mode routing, candidate fusion, calibration boundary, visibility exclusions, deduplication, opaque versioned locators, and short result leases.
- Verifier: `node --test test/retrieval-search.test.js && npm run eval:retrieval`.
- Done when: search returns bounded distinct source locations, unauthorized or modified locators fail, and all retrieval correctness gates pass.

**T13 — Exact recall materializer**

- Depends: T06, T12.
- Reads: `retrieval.md`.
- Owns: `src/retrieval/recall.js`, `src/retrieval/render.js`, `test/retrieval-recall.test.js`.
- Produces: snapshot recall, range-only physical chunk reads, size-capped kind-specific expansion, bounded neighboring windows, continuation locators, provenance rendering, and typed failure statuses.
- Verifier: `node --test test/retrieval-recall.test.js && npm run eval:retrieval -- --suite chunks`.
- Done when: source bytes are exact, tail and boundary matches are recoverable, output caps include labels and provenance, unrelated chunks are not read, complete turns expand only below the documented byte cap, and old locators never resolve to new versions.

**T14 — Retention, tombstones, and compaction control**

- Depends: T05, T07, T12.
- Reads: `retention.md`.
- Owns: `src/rocksdb/retention.js`, `src/rocksdb/compaction.js`, `test/rocksdb-retention.test.js`.
- Produces: retention classes, expiry generations, pins, client heartbeats, semantic tombstones, batched deletes, background-compaction scheduling, explicit operator compaction, and disk-low state.
- Verifier: `node --test test/rocksdb-retention.test.js && npm run bench:archive -- --retention --allow-partial`.
- Done when: expiry is idempotent, pins and leases win races, max-count protection remains one atomic bounded-memory operation, search hides tombstones immediately, restart resumes cleanup, and physical reclamation evidence passes `evaluation.md`.

**T15 — Automatic retrieval preflight and frozen hints**

- Depends: T12, T13 and T03 calibration fixtures.
- Reads: `retrieval.md`, `evaluation.md`.
- Owns: `src/retrieval/preflight.js`, `src/retrieval/hints.js`, `test/retrieval-hints.test.js`.
- Produces: every-message cheap retrieval, reveal gate, per-message and epoch budgets, repeated-result suppression, frozen hint records, and deterministic rendering.
- Verifier: `node --test test/retrieval-hints.test.js && npm run eval:hints`.
- Done when: hint recall and false-positive gates pass, old hints remain byte-identical after index changes, and no-result turns add zero model-visible tokens.

**T16 — Adapter integration and compatibility cutover**

- Depends: T04, T12, T13, T14, T15.
- Reads: all semantic guides.
- Owns: `extensions/pi.ts`, `bin/context-window-mcp.js`, `src/epoch-window.js`, `src/config.js`, matching adapter/config tests, and user-facing README sections.
- Produces: daemon-backed archive/search/recall, stable hint insertion, status and control commands, protocol errors, explicit offline cutover configuration, and SQLite fallback routing before authority is sealed.
- Verifier: `npm run test:daemon && npm run check`.
- Done when: adapters no longer open RocksDB directly, reconstructed hints preserve prompt prefixes, existing public tools remain compatible or have documented migrations, and all  current regression tests pass.

**T17 — Offline release gate, rollback rehearsal, and authority seal**

- Depends: T01 through T16.
- Reads: `migration-operations.md`, `evaluation.md`.
- Owns: release scripts, daemon status presentation, operational documentation, and final cutover configuration. Coordinate any removal of obsolete SQLite retention code.
- Produces: complete evaluation artifacts, benchmark report, quiesced migration rehearsal, rollback-before-first-write rehearsal, executable daemon operations guide, atomic first-write authority-seal evidence, and final gate report.
- Verifier: execute the complete clean-revision sequence in `release-evidence.md`; `release-report.json` must validate against its source directory with `outcome: "passed"`. `--allow-partial` is allowed only on the documented comparison and retention component captures, never on the system probe, performance aggregate, or final report.
- Done when: every release gate passes, copy and verification block daemon admission, rollback through the verified canonical SQLite corpus is demonstrated before any RocksDB-only write, the first later RocksDB write closes rollback atomically, and unsupported online/post-authority rollback claims are absent.

**Agent handoff template**

```text
Task: TNN
Revision:
Owned files changed:
Contract changes:
Verifier commands:
Verifier results:
Artifacts:
Known limitations:
Downstream notes:
```
