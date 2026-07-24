**Decision**

Keep RocksDB's LSM as the archive substrate. Consolidate duplicated derived values into immutable canonical postings, compact locators, and additive correction overlays. Do not add a second B-tree.

**Cutover sequence**

1. Publish the exact versioned posting prefixes reachable by the running reader.
2. Delete only known BM25 or simhash namespaces excluded by that manifest.
3. Replace BM25 session copies with locators to canonical project postings.
4. Replace folded exact copies with locators to one or more case-preserving canonical postings.
5. Rewrite canonical BM25 and exact postings as schema-specific positional binary blocks.
6. Verify every canonical document, ordinal mapping, scope membership, and retirement overlay in resumable pages. Restart verification if the outbox changes between the first and final page.
7. Publish the query cutover and retain legacy reverse-cleanup references for 24 hours.
8. Remove only the cleanup-only reverse map; retain immutable derived targets.

Every phase is page-bounded, checkpointed, and readable in mixed legacy/compact form. A folded legacy posting with no surviving canonical partner is reported as unresolved and remains self-contained. It does not lose matches or block safe records from migrating.

The 24-hour interval is a query-cutover rollback grace: the current reader can continue using the retained cleanup map while the ordinal overlay is observed. It is not a promise that an older binary can read values already rewritten into compact blocks or locators.

**Operator workflow**

Report namespace ownership and logical bytes without opening the store for writes:

```bash
context-window-index-maintenance inventory --store /path/to/archive.rocks
context-window-index-maintenance gc --store /path/to/archive.rocks
```

Apply namespace GC only with the daemon stopped. The command requires an explicit offline assertion and revalidates the current reader manifest in every deletion transaction:

```bash
context-window-index-maintenance gc --store /path/to/archive.rocks --apply --offline
```

Add `--compact` to request a posting-keyspace compaction and report physical before/after bytes. Logical deletion and physical reclamation are separate measurements.

**Measured archive projection**

The July 23, 2026 read-only inventory of the local archive projected:

| Change | Logical bytes saved |
|---|---:|
| Obsolete versioned namespaces | 102,333,730 |
| BM25 session locators | 134,409,711 |
| BM25 canonical blocks | 57,685,350 |
| Exact folded locators | 172,683,569 |
| Exact canonical blocks | 67,260,132 |
| Reverse-cleanup map after grace | 506,776,524 |
| Total | 1,041,149,016 |

The exact migration resolved 181,333 folded records and retained 27 orphaned legacy records. Derived-view verification checked 2,621 documents with zero mismatches in 0.55 seconds.

`npm run bench:posting-storage` performs a paired format benchmark on one corpus. It expands the corpus to the legacy layout, stabilizes RocksDB, records size and exact-plus-BM25 latency, migrates the same keys, stabilizes RocksDB again, and verifies identical result identities. Two 128-document runs stored 43.97 percent of the legacy posting value bytes. Median latency ranged from 2.6 percent faster to 4.2 percent slower; p95 was 25.9 to 38.9 percent faster. The benchmark fails on a size regression, changed results, or a median/p95 regression above 10 percent.

**Measurement-gated designs**

- Roaring bitmaps: defer. Once project memberships are packed into per-run blocks, the measured 2,702 ordinals across five project sets need 2,705 bytes as delta-varints or 1,636 bytes as dense bitsets. Roaring could save only roughly one kilobyte before its headers and dependency cost. The 42,864 measured session-term sets have median cardinality 2, p95 17, and maximum 236, which favors small sorted arrays; postings still require term frequency, positions, and byte ranges.
- Vectorized execution: defer until posting decode or intersection appears in profiles. The paired benchmark passes without it, and RocksDB point/range access remains the dominant boundary.
- Content-defined chunking: defer. Canonical chunks are already content-addressed: 2,846 document references resolve to 1,591 unique chunk IDs, so 1,255 exact-content reuses are already captured. CDC would add boundary CPU and metadata to pursue only partial-substring duplication.
- Model-based merging: keep as an optional derived view. It can provide semantic compression, but inference cost, nondeterminism, information loss, and provenance requirements make it unsuitable as the canonical merge operator.
