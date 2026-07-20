**Purpose**

This directory is the semantic contract and verification guide for the single-owner RocksDB service and automatic, cache-safe retrieval hints. A guide describes intended or supported behavior only where the matching implementation and verifier exist; release evidence remains separate.

**Required reading**

Every implementation agent reads this file plus the guide named by its task. Agents changing a contract read all guides that define that contract.

| Guide | Governs |
|---|---|
| [architecture.md](./architecture.md) | Process topology, canonical records, key layout, and invariants |
| [retrieval.md](./retrieval.md) | Search, locators, recall, automatic hints, and cache behavior |
| [retention.md](./retention.md) | Expiry, pins, tombstones, compaction, and disk pressure |
| [migration-operations.md](./migration-operations.md) | SQLite migration, daemon recovery, rollout, rollback, and observability |
| [evaluation.md](./evaluation.md) | Correctness, retrieval-quality, performance, and release gates |
| [release-evidence.md](./release-evidence.md) | Clean-revision evidence capture, validation, and final decision |
| [tasks.md](./tasks.md) | Dependency graph, agent ownership, deliverables, and task verifiers |

**Frozen decisions**

- Use `@harperfast/rocksdb-js` with Node 22.19–22.x or Node 24 and newer; Node 23 is outside the supported engine range.
- A local Node daemon is the sole RocksDB owner; adapters are clients.
- Canonical source messages and chunks are immutable.
- Search finds bounded candidates; recall materializes exact source regions.
- Run cheap retrieval for every new user message, reveal candidates selectively, and never auto-recall full documents.
- Persist every revealed hint byte-for-byte so provider prefixes remain append-only within an epoch.
- Replace routine byte-watermark pruning with evidence-class and age policies.
- Keep a disk-low emergency mode; RocksDB compaction is not logical retention.
- Keep existing SQLite archives authoritative until explicit offline copy and verification pass. Preserve the source after cutover; rollback is supported only before the first RocksDB-only write.
- Do not claim online dual writes, production shadow reads, or post-authority rollback in the first cutover.
- Keep vectors and model-generated summaries out of the automatic retrieval/preflight path in the first production cutover; explicit `context_window_search` and `context_window_gather` separately ship a default-on, opt-out local vector embedding fallback (no generated summaries), documented in [retrieval.md](./retrieval.md).

**Swarm rules**

- One task owns a production file at a time. Follow the ownership paths in `tasks.md`.
- Do not change a semantic contract silently. Update its guide in the same change and call out downstream tasks.
- Tests use temporary stores and sockets. Never point tests or migrations at the user's archive.
- A task is incomplete until its verifier passes and its completion evidence is recorded in the change description.
- Agents may implement compatible internal details, but may not relax invariants or release gates without explicit approval.
- Commit generated fixtures only when their generator, inputs, and validation command are also committed.

**Definition of complete**

The project is complete only when fresh installations and explicitly migrated archives use the RocksDB daemon, the offline migration and pre-authority rollback rehearsal pass, automatic hints are cache-stable and budgeted, retention reclaims tombstoned data, and every applicable gate in `evaluation.md` passes.
