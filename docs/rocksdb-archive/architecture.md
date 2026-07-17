**Objective**

Store append-heavy conversation evidence as immutable records, index it asynchronously, retrieve exact bounded regions, and let RocksDB perform physical background compaction.

**System boundary**

```text
Pi extension ─┐
MCP clients ──┼── local RPC ── context-windowd (Node)
Other hosts ──┘                      │
                                    ├── RocksDB owner
                                    ├── indexing worker
                                    ├── expiry worker
                                    └── compaction monitor
```

RocksDB allows one process to open a database. The daemon owns the lock and every adapter communicates through a versioned local protocol. Client shutdown must not close the shared store.

The local transport admits at most 16 active connections. Its default Unix socket lives in a current-user-owned `0700` directory, and both client and daemon reject unsafe or symlinked socket parents before connecting or opening storage. A client must complete the versioned handshake within five seconds or the daemon closes the socket and releases the slot. Encoded frames are limited to 16 MiB; logical field limits do not guarantee admission when JSON escaping expands the wire representation. Retained partial, queued, and active input is limited to 32 MiB per connection and 32 MiB across the daemon before parsing. Output reserves a full frame before handler dispatch, retains that reservation through handler completion even after peer close, and allows at most 16 MiB plus the delimiter per connection and two full-frame reservations (32 MiB plus two delimiters) daemon-wide across result materialization and socket buffering. Recall is limited to 100,000 tokens so valid responses remain below the encoded-frame cap. Request concurrency, replay results, and shutdown drain time are independently bounded; socket backpressure pauses dispatch rather than accumulating responses.

**Non-negotiable invariants**

- A committed source message never changes in place.
- A source key identifies one deterministic serialization.
- A turn is an ordered manifest of source-message references.
- Large tool payloads are stored once and referenced from turns and tool-result manifests.
- Physical chunks are non-overlapping and content-addressed.
- Logical search windows may overlap without duplicating physical payload bytes.
- Every derived record identifies its source version.
- Superseded evidence remains auditable until retention expires it, but normal search excludes it immediately.
- The daemon acknowledges a write only after the canonical source and durable indexing outbox entry commit atomically.
- Indexes may lag canonical writes; canonical writes may never lag indexes.
- A generation labeled complete contains every configured handler result. Bounded-work truncation or omission is durably labeled partial or skipped.
- Search and recall operate against a consistent document version.

**Canonical records**

| Record | Meaning | Mutability |
|---|---|---|
| Event | Original user, assistant, tool-call, tool-result, or synthetic host event | Immutable |
| Turn manifest | Ordered event references and source provenance | New version only |
| Tool-result manifest | Ordered physical chunks and parent turn references | New version only |
| Physical chunk | Non-overlapping payload addressed by content hash | Immutable |
| Search window | Token range mapped to one or more physical chunks | Immutable per index generation |
| Derived evidence | Exact terms, structural scores, or verbatim decision excerpts | Rebuildable |
| Supersession record | Old version to replacement or deletion reason | Append-only |
| Lease or pin | Temporary or durable protection from expiry | Renewable metadata |

**Keyspace design**

Use column families where the binding supports them cleanly; otherwise use the same prefixes in one ordered keyspace.

```text
event/<project>/<session>/<sequence>
document/<document>/<version>
chunk/<retention-class>/<project>/<session>/<bucket>/<document>/<ordinal>
window/<document>/<version>/<ordinal>
exact/<project>/<normalized-term>/<bucket>/<document>/<window>
posting/<project>/<term>/<bucket>/<document>/<window>
relation/<session>/<relation>/<reverse-sequence>/<message>
expiry/<time-bucket>/<retention-class>/<document>/<version>
supersession/<document>/<version>
lease/<expires-at>/<document>/<version>/<owner>
outbox/<sequence>
meta/<name>
```

Keys use an explicit binary encoding with versioned field boundaries. The Node binding has one fixed 4 KiB native key buffer, shared by both iterator bounds. Point reads validate the full 4,096-byte limit; new persisted keys are limited to 2,047 encoded bytes so later prefix scans and pagination remain valid. Canonical admission rejects an unsafe tuple before writing any record. Tests cover NUL, slash, Unicode, exact-key limits, combined iterator bounds, restart, and retention.

**Buckets and chunks**

Use project and session as the chat-like locality boundary, then use a fixed time or epoch bucket. Discord documents this channel-plus-time-bucket pattern for message storage: <https://discord.com/blog/how-discord-stores-trillions-of-messages>.

Physical chunks should align to source record or line boundaries. The initial logical search-window hypothesis is approximately 900 tokens with 15 percent overlap, inspired by QMD, but `evaluation.md` decides the production value: <https://tobi-qmd-3.mintlify.app/architecture/overview>.

Database growth has no configured byte cap. One canonical admission is bounded to 8 MiB of UTF-8 source text, 1 MiB of metadata, 256 source-message references totaling at most 1 MiB of identifiers, and 4,096 structural annotations totaling at most 1 MiB each of identifiers and message text. Metadata JSON is also depth-bounded. Callers split larger payloads into multiple canonical documents.

Index preparation reads source in fixed 256 KiB segments and never requests more than 512 KiB at once. It accepts at most 4,096 stored windows, 4,500 staged mutations, and 8 MiB of staged mutation data per document. BM25 analyzes at most 16,000 token occurrences, 256 unique terms, and 1,024 term-window pairs. Exact indexing ranks at most 8,000 extracted anchors and publishes at most 1,000 posting records, marking the handler partial when lower-ranked matches are omitted. Structural indexing locates ordered annotations in one source pass, never publishes a coordinate-free posting, and skips the handler if an annotation cannot be resolved. These limits constrain temporary memory, not total archive size. Recall addresses its authenticated target window directly and fetches at most 32 neighbors.

**Write lifecycle**

1. Assign a monotonic session sequence and deterministic source key.
2. Split large payloads into immutable physical chunks.
3. Commit events, manifests, chunk references, and an outbox entry in one transaction.
4. Return success to the client.
5. Let the background indexer page canonical windows and prepare each handler under explicit source, token, posting, mutation, and byte limits.
6. Apply tablets in transactions capped by mutation count and encoded bytes. Generation-addressed postings keep the last published generation readable while a future generation is incomplete.
7. Atomically publish only after every tablet has a durable applied marker. Publish handler completeness as `complete`, `partial`, or `skipped`; replay replaces pre-header orphan tablets and resumes completed tablets.
8. Remove superseded derived values and tablet metadata after publication. RocksDB reclaims their physical bytes through normal LSM compaction.

The canonical WAL commit is always the acknowledgement boundary. The daemon gives documents up to 64 KiB a bounded best-effort foreground publication opportunity for immediate search consistency; a publication fault is recorded without converting the committed admission into an error. Larger documents skip synchronous startup/put indexing and remain at the ordered outbox head for background publication. Explicitly retryable background failures use exponential backoff from 50 milliseconds to 5 seconds, new activity may accelerate the retry, and shutdown cancels the timer. Internal faults remain recorded without a hot retry loop, while restart recovery can replay every pending entry.

Stores created before per-document turn/tool ownership references are upgraded once at writable open. The upgrade processes one document manifest per transaction, atomically writes deterministic owner references with a durable cursor, and resumes after interruption before the daemon becomes ready. The one-manifest transaction boundary keeps memory bounded for maximum-size manifests. Fresh stores record the owner index as complete in O(1). Retention can then delete shared metadata only after its final current or backfilled owner reference is removed.

**Read lifecycle**

1. Search a stable index generation and return versioned locators.
2. Create short retrieval leases for returned document versions.
3. Recall through a snapshot using the locator, manifest, and chunk references.
4. Render exact source text, bounded neighboring context, and provenance.

**Failure model**

- A crash before canonical commit produces no visible document.
- A crash after canonical commit leaves an outbox entry that restart replays.
- Duplicate client requests are idempotent by source key or request ID.
- Corrupt derived indexes are rebuildable from canonical records.
- Corrupt canonical records are fatal and must never be repaired from summaries or derived indexes.
- A client losing its socket does not affect committed work or other clients.

**Explicit non-goals for the first cutover**

- Distributed RocksDB ownership or remote multi-host service.
- Vector embeddings, query-expansion models, or model-based reranking.
- LLM-generated memory summaries.
- Repository indexing; live repository state remains the host's `rg`, SCIP, ctags, or IDE responsibility.
- Online SQLite/RocksDB dual writes or rollback after the first acknowledged RocksDB authority write.
- Automatically deleting the SQLite migration source.
