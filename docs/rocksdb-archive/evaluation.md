**Purpose**

Tests prove local correctness. Evaluation proves that retrieval quality, automatic hint routing, cache behavior, migration safety, and performance meet the product goal.

**Frozen suites**

| Suite | Contents | Primary metric |
|---|---|---|
| Exact anchors | Paths, symbols, errors, commits, quoted values, case variants | Recall at 3 |
| Lexical history | Historical questions with annotated source windows | Recall at 3 and reciprocal rank |
| Structural history | Latest question, request, correction, answer, decision | Resolution accuracy |
| Mixed evidence | Historical intent plus current-state requirement | Stale-answer and routing rate |
| Negative routing | Current-only, already-visible, and irrelevant messages | Automatic hint false-positive rate |
| Chunk targeting | Large tool outputs with evidence near boundaries and tails | Correct-window rate and returned tokens |
| Migration corpus | Legacy, malformed metadata, forks, multimodal markers, large tools | Byte and provenance parity |

Held-out cases remain untouched until a release candidate is frozen. After inspection or tuning, they become regression cases and a new held-out set is required.

**Correctness gates**

- Every acknowledged canonical write survives daemon restart.
- Idempotent retries create one canonical record.
- Oversized source, metadata, provenance, structural, nested-JSON, or lifecycle-unsafe key inputs fail with a typed error before any canonical write.
- A bounded-work index outcome is durably labeled partial or skipped, advances the ordered outbox, and leaves the canonical document directly recallable.
- Exact-anchor Recall@3 is 100 percent on the frozen suite.
- Structural resolution accuracy is 100 percent on deterministic supported relations.
- Lexical Recall@3 and reciprocal rank are no worse than the SQLite baseline.
- Correct logical window is returned for at least 95 percent of chunk-targeting cases.
- Resolved recall reproduces canonical source bytes and ordered source provenance.
- Superseded or expired evidence is never returned as current live evidence.
- A locator never resolves to a different document version.
- Offline migration has zero missing or extra canonical documents and zero unexplained provenance differences; complete counts and the full comparison hash are computed through bounded pages even when detail samples truncate.
- Migration start rejects requests without the explicit offline assertion and rejects a pre-populated RocksDB destination.
- Daemon canonical admissions are blocked during `offline-copy`, `offline-verification`, and `blocked`.
- `offline-ready` requires a passing verification against the still-current SQLite source fingerprint.
- The untouched SQLite archive is demonstrated as readable rollback state before the first RocksDB-only write.
- The first post-verification RocksDB canonical write atomically seals authority and makes rollback ineligible across restart and duplicate retry.

**Automatic-hint gates**

- At least 90 percent of annotated out-of-window historical needs surface the expected useful disclosure.
- At least 90 percent of annotated implicit recurring concepts surface a continuity marker made only from exact current-message phrases.
- At most 5 percent of current-only, already-visible, or irrelevant messages receive a model-visible hint.
- At most one automatic candidate is revealed per user message.
- Every revealed hint stays within its per-message and active-context token budgets.
- Reconstructing an unchanged branch produces byte-identical historical hints.
- Adding new archive data never changes a previously frozen hint.
- Archived tool text is visibly delimited as data and cannot alter retrieval instructions.
- Stale or recently surfaced sources are not revealed automatically.
- A continuity marker contains no candidate-only term, archived excerpt, or cold archived jargon.

The retrieval artifact exposes these as `historicalNeedRecall`, `continuityMarkerRecall`, `negativeFalsePositiveRate`, `maxOneViolationCount`, `budgetViolationCount`, `activeBudgetViolationCount`, `frozenByteMismatchCount`, `candidateOnlyTermLeakageCount`, `staleRevealCount`, `repeatedSourceRevealCount`, and `unsafeArchivedToolHintCount`. Release and local evidence recompute every metric from case-level records rather than trusting backend outcome flags.

**Performance corpus**

Generate deterministic stores at 10 thousand, 100 thousand, and 1 million logical windows. Include short conversation messages, 10 KiB tool results, 1 MiB tool results, repeated identifiers, common terms, and cold historical buckets. Record CPU, memory, filesystem, Node, package, and RocksDB versions with every result.

**Performance gates**

- Canonical append p95 is no slower than SQLite at one client and eight concurrent clients.
- Large-tool ingest throughput is at least 1.5 times the SQLite baseline for 1 MiB payloads, and no
  worse than 0.8 times for 10 KiB payloads. A 1 MiB admission amortizes the fixed cost of a canonical
  commit over enough bytes for the throughput advantage to show; at 10 KiB that fixed cost is most of
  the work and the two backends land level, so parity there is the expectation rather than a
  regression, and the floor exists to catch RocksDB becoming materially slower.
- Warm exact and BM25 preflight p95 is at most 50 ms at one million windows with vectors disabled.
- Three-window recall p95 is at most 25 ms on the benchmark host.
- Daemon steady-state RSS is at most 256 MiB with vector models disabled.
- Maximum successful and typed-partial built-in index plans remain below the 256 MiB RSS gate, including high-cardinality identifiers, thousand-window documents, missing structural annotations, and restart replay.
- Indexing backlog returns to zero after a burst without blocking canonical writes.
- Killing the daemon during ingestion and restarting loses zero acknowledged writes.
- After deleting 50 percent of byte-weighted test data and compacting affected ranges, physical bytes decrease materially and every retained key remains readable.

Absolute latency gates are interpreted only on the recorded benchmark host. Relative SQLite comparisons remain required on every supported host.

**Component commands**

```text
npm run test:rocksdb
npm run test:daemon
npm run test:migration
npm run eval:retrieval
npm run eval:hints
npm run bench:archive -- --allow-partial
npm run check
```

These commands are local development checks; `npm run bench:archive` defaults to a quick comparison and is not a release decision. The exact release-grade multi-artifact command sequence and external evidence-directory requirement are defined in [release-evidence.md](./release-evidence.md). That sequence ends with:

```text
node eval/release/cli.js --evidence-dir "$release_evidence_dir" --output "$release_evidence_dir/release-report.json"
```

The strict performance aggregate and final report are the release-completeness checks: they exit nonzero when any required gate fails or remains unmeasured. Quick comparison, baseline, retention-only, and artifact-inspection runs are development evidence; pass `--allow-partial` explicitly when their expected partial result should exit zero. Partial component artifacts cannot attest a release by themselves.

Each evaluation command emits a JSON artifact plus a concise human summary. Validators reject missing environment metadata, changed fixture order, stale schema fingerprints, malformed results, fixture-mismatched retention counts or bytes, and score recomputation mismatches. Relative SQLite comparisons exercise RocksDB's production canonical document-admission path rather than a raw key/value write. Migration uses the executable `context-window-migrate start --offline`, `verify`, and `status` commands documented in `migration-operations.md`.

**Local evidence privacy**

Local-only verification retains aggregate results in `evaluation-results.md`; it does not retain generated JSON. Raw evaluation, benchmark, system, migration, and package captures may contain absolute paths, machine metadata, content-shaped fixture fields, identifiers, locators, revisions, or hashes. Write them only to a private disposable directory, never mix them with user archives, and delete them after validation. Do not commit or share them as local-plugin evidence.

**Release evidence**

A release candidate includes the exact git revision, dependency lockfile hash, schema version, protocol version, suite fingerprints, exposure classification, raw evaluation artifacts, benchmark artifacts, the offline migration/rollback rehearsal artifact, and the final gate report. Passing unit tests without these artifacts is insufficient for cutover. Online dual writes, production shadow reads, and rollback after `rocksdb-authority` are outside this release and must not be inferred from static migration verification.

`evaluation-results.md` records only schema-validated aggregate local gate outcomes, counts, durations, byte totals, exit statuses, and approved version or hash fields. It intentionally omits generated retrieval records and content-bearing artifact hashes. Optional release-candidate evidence remains separate in a private external directory and is not required for this local plugin.
