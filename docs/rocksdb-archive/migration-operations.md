**Supported rollout**

SQLite-to-RocksDB migration is offline only. The operator must stop every Pi, MCP, or other process that can write the SQLite archive before starting. `--offline` is an explicit assertion of that condition; it is not a request for the tool to quiesce other processes.

The migration never modifies the SQLite source. Online dual writes, sampled shadow reads, and rollback after a RocksDB-only write are not implemented and must not be claimed as supported.

**Preconditions**

1. Stop every writer of the SQLite archive.
2. Keep the SQLite database and its WAL files in place.
3. Use a fresh RocksDB destination. A destination with an acknowledged canonical document is rejected.
4. Keep writers stopped through copy, verification, and the backend configuration change.

An existing SQLite file keeps the default backend on SQLite. RocksDB must be selected explicitly after verification with `archiveBackend: "rocksdb"` or `CONTEXT_WINDOW_BACKEND=rocksdb`. The packaged adapters bind that selection to the configured `dbPath`: while the source exists, startup rejects a destination in `not-started`, copy, verification, or blocked state, and rejects a destination migrated from another source. Selecting the backend cannot create an empty replacement archive or cross-wire histories.

Every packaged adapter establishes backend authority before its selected backend can acknowledge a new canonical write. SQLite startup contacts or starts the configured RocksDB daemon and records a source-bound `sqlite` claim before opening SQLite, even when the RocksDB directory did not previously exist. RocksDB startup records permanent `rocksdb` authority for a fresh destination, while a verified cutover waits to seal authority with its first post-verification canonical write. Concurrent fresh SQLite and RocksDB startups therefore serialize to one winner instead of opening divergent writable histories.

**Executable procedure**

Run these commands from the plugin checkout. The daemon stays in the foreground,
so keep it in terminal 1:

```bash
node ./bin/context-windowd.js \
  --store ~/.pi/context-window/archive.rocks \
  --socket ~/.cache/context-window/run/context-windowd-migration.sock
```

While terminal 1 remains running, use terminal 2:

```bash
node ./bin/context-window-migrate.js start \
  --socket ~/.cache/context-window/run/context-windowd-migration.sock \
  --source ~/.pi/context-window/archive.db \
  --offline

node ./bin/context-window-migrate.js verify \
  --socket ~/.cache/context-window/run/context-windowd-migration.sock \
  --source ~/.pi/context-window/archive.db \
  --artifact ./artifacts/migration-verification.json

node ./bin/context-window-migrate.js status \
  --socket ~/.cache/context-window/run/context-windowd-migration.sock
```

After status reports `offline-ready`, keep Pi and MCP writers stopped, terminate
the foreground daemon in terminal 1, select the RocksDB backend, and restart Pi.
Do not start a second daemon on another socket while the migration daemon still
owns the store.

The daemon creates the socket parent as a private `0700` directory and rejects an unsafe parent or ancestor chain, including non-sticky shared directories controlled by another user. Do not place the socket directly in shared `/tmp`.

`start` is checkpointed and idempotent. Rerun the same command after interruption. Do not select RocksDB until `verify` reports `passed`, status is `offline-ready`, and `rollbackEligible` is `true`.

Copy and resume fetch, prepare, and commit one SQLite row at a time. The configured batch size is the logical checkpoint interval: its ordered fingerprint is built incrementally, then the checkpoint advances only after every row in that interval is durable. Neither an initial copy nor a restart retains a batch of document payloads in memory.

Adapter startup is the final cutover guard. It permits a fresh installation only when no configured SQLite source exists, and permits an existing source only when the selected destination reports matching `offline-ready` verification or `rocksdb-authority`. A rejected data-path activation cannot admit a canonical write, although the daemon may initialize the destination and persist backend-control metadata. Restore `archiveBackend: "sqlite"` and complete or repair the offline migration. There is no configuration flag that silently abandons an existing history.

**State and admission gates**

| Phase | Meaning | RocksDB canonical admission |
|---|---|---|
| `not-started` | No SQLite migration is active; normal for a fresh installation | Allowed |
| `offline-copy` | A checkpointed copy is incomplete | Blocked |
| `offline-verification` | Copy completed and verification is required | Blocked |
| `blocked` | Copy, source-freshness, or verification gate failed | Blocked |
| `offline-ready` | The complete copy passed verification against the current SQLite fingerprint | First admission atomically seals authority |
| `rocksdb-authority` | At least one post-verification RocksDB write was acknowledged | Allowed; SQLite rollback is unavailable |

The first new canonical RocksDB write after verification stores both the source-bound authority seal and permanent global RocksDB authority in the same transaction as the acknowledged document. A direct first canonical write on a fresh destination likewise creates permanent global RocksDB authority atomically. A crash cannot commit the document while leaving SQLite selectable, and duplicate retries reproduce the same authority transition.

**Verification**

Verification scans the complete SQLite corpus and checks migrated canonical documents, source bytes, ordering, metadata parsing, source keys, provenance, and deterministic recall rendering. SQLite and RocksDB are read one record at a time because each admitted record can carry several MiB of source, metadata, and structural provenance; destination membership uses indexed SQLite point lookups instead of retaining a corpus-sized identity map. Missing, extra, or unexplained records produce `failed`, persist exact summary counts plus a bounded structured detail sample, and move the gate to `blocked`. A clean rerun moves it to `offline-ready`; verification never regresses `rocksdb-authority`.

The verification artifact is static offline parity evidence. It records complete per-type totals and an ordered SHA-256 hash over every evaluated difference, while retaining at most 256 structured samples and 1 MiB of sample bytes. Pass/fail is calculated from the complete counts, never from the sample. Repeating an unchanged comparison produces the same comparison hash. The artifact is not evidence of online dual writes or production shadow-read comparison.

Artifact publication resolves symlinks and existing parent aliases before writing. It rejects the SQLite database and sidecars, anything inside the RocksDB store, and hard links to either data set. A valid artifact is written through an exclusive temporary file and atomic rename; the source files are fingerprinted again after publication and before `offline-ready` is persisted.

**Cutover and rollback boundary**

After `offline-ready`, explicitly select RocksDB and restart the adapter. Before its first new canonical write, rollback is:

1. Stop RocksDB-backed clients.
2. Confirm `rollbackEligible: true`.
3. Remove the explicit RocksDB backend selection or set the backend to SQLite.
4. Restart the client against the untouched SQLite archive.

SQLite startup persists a source-bound rollback claim before opening the database. That claim is removed only by rerunning `context-window-migrate start --offline` for the same source under the daemon's exclusive migration boundary; the copy is revalidated and verification must pass again before RocksDB can be selected. Merely flipping the backend setting back to RocksDB is rejected.

Eligibility is recalculated from the verified SQLite source fingerprint. Replacing, deleting, or changing the source closes the rollback gate. The first post-verification RocksDB write also closes it permanently, and every later packaged SQLite startup is rejected before SQLite opens.

After status becomes `rocksdb-authority`, automated rollback is unsupported because SQLite does not contain RocksDB-only writes. Recovery then requires an operator-managed export/replay procedure that this release does not provide.

**Crash recovery**

- Kill-after-boundary tests cover canonical commits and migration checkpoints.
- Restart resumes without skipping or duplicating SQLite rows.
- Source drift prevents a stale checkpoint from becoming ready.
- Daemon canonical admissions remain blocked while copy or verification is incomplete.

**Metadata lifecycle**

Per-row SQLite provenance is document-owned derived data. It remains available for offline verification and recall while the canonical document is live, then the normal phased retention worker removes the provenance record and its reverse reference when that exact document version retires.

The initial checkpoint fixes one `retentionStartedAt` timestamp for the entire copy. Every retry reuses it: imported raw tool payloads enter the default 14-day expiry queue, conversation sources enter the 90-day queue, source-linked derived evidence enters the 30-day queue, and durable manual evidence remains unexpired. Logical retention waves are blocked for every checkpointed pre-authority phase, including `offline-ready` and `blocked`, so the verified corpus cannot drift before authority. Verification holds the exclusive logical-write boundary; each retention wave holds one shared boundary across its status check and complete deletion wave. Retention resumes after permanent RocksDB authority.

Only an unresolved copy failure is durable. A successful retry atomically decrements the unresolved failure count and removes the resolved failure row. RocksDB keeps the eight most recent comparison runs plus the verification run referenced by the migration checkpoint. Each run and an explicitly requested artifact store at most 256 structured difference samples and 1 MiB of sample bytes. Exact totals, per-type totals, and the full comparison hash still cover every evaluated difference, so large failed cutovers remain bounded without weakening the gate.

The current checkpoint, status, authority seal, and compact comparison-history record are constant-size control metadata and remain for the life of the RocksDB archive. The SQLite source is never modified or deleted automatically.
