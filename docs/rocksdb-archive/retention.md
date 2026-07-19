**Principle**

RocksDB background compaction optimizes and reclaims physical storage. Application retention decides which logical evidence is no longer live. Unique append-only values remain live until the application expires or supersedes them.

**Retention classes**

| Class | Examples | Intended policy |
|---|---|---|
| Ephemeral payload | Large raw tool output and redundant previews | Shortest age window |
| Conversation source | User and assistant messages, turn manifests | Longer age window |
| Derived evidence | Exact terms, structural scores, verbatim decision excerpts | Rebuildable; follows source or explicit promotion |
| Durable evidence | Manual archives, explicit pins | No automatic expiry while pinned. Product longevity for decisions is promotion into the repository (AGENTS.md / ADR / config), not pin UI. |
| Active evidence | Current epoch, current TOC targets, active retrieval leases | Temporarily protected |

Durations remain configuration, not schema. Production storage defaults are 14 days for ephemeral payloads, 90 days for conversation sources, and 30 days for source-linked derived evidence. Manual archives use durable evidence and do not expire automatically. A zero-day class override disables automatic expiry. Active leases and pins remain protections, not alternate copies of evidence.

Automatic prompt insertion has a separate, shorter eligibility horizon: 7 days for ephemeral tool payloads, 30 days for conversation sources, and 30 days for derived evidence. Manual and durable archives are never automatic candidates. Evidence can therefore remain available to explicit project/session search after it becomes too old for unsolicited insertion. Source creation time, not last access, determines this eligibility; every revealed historical excerpt includes its source date.

**Expiry index**

Every expirable document version writes an ordered entry:

```text
expiry/<time-bucket>/<retention-class>/<document>/<version>
```

The expiry worker scans only due prefixes. Before deletion it verifies that the entry still names the current expiry generation, the document is not pinned, and no active retrieval lease protects that version. Explicitly renewing expiry writes a new generation; stale expiry entries become harmless. Ordinary search, recall, and coarse access records do not extend the retention deadline.

**Deletion lifecycle**

1. Append a semantic tombstone or supersession record.
2. Exclude the version from normal search immediately.
3. Delete canonical references and derived posting ranges in bounded batches.
4. Retain enough metadata to return an accurate expired or superseded recall status.
5. Let RocksDB background compaction reclaim tombstones and obsolete values.
6. Flush large deletion waves so RocksDB's background workers can reclaim obsolete values; reserve full manual compaction for an explicit operator request.

The JavaScript binding documents background compaction threads and manual range compaction, but not native TTL compaction filters. The first implementation therefore makes expiry decisions in the daemon and uses ordinary deletes.

**Maintenance loop**

The daemon runs one non-overlapping maintenance loop. Each default one-minute tick cleans at most 1,000 expired protections, 1,000 retrieval leases, and a shared total of 1,000 abandoned hints plus expired source-exposure records, then runs at most four 256-document retention waves. Cursor state lets later ticks continue without one unbounded transaction. The timer is unreferenced and shutdown clears it and waits for an active tick.

Logical retention waves are blocked while an offline migration is copying, awaiting verification, blocked, or verified but still rollback-eligible. Verification holds the exclusive logical-write boundary. A retention wave holds one shared boundary from its migration/authority check through the full deletion wave, preventing a queued migration transition from splitting that decision from its deletes. Index publication and physical compaction remain independent.

Completed deletion work accumulates until either 10,000 keys have been deleted or RocksDB reports at least 256 MiB of reclaimable SST data. The daemon then flushes pending writes and reports that background compaction was scheduled. A flush is not treated as completed reclamation: the deletion trigger remains armed and later maintenance ticks retry until RocksDB properties show that SST or pending-compaction bytes were reclaimed. The daemon does not synchronously compact the whole database from the maintenance loop because that operation has unbounded I/O and temporary-space cost. An explicit operator compaction remains available. These thresholds are host-wide daemon options and can be overridden with the documented environment variables or matching command-line flags.

**Pins and leases**

- A durable pin protects an explicitly selected document until removed.
- An active-context lease protects current session and TOC evidence.
- A retrieval lease protects the exact versions returned by search for a short period.
- Client heartbeats renew active-context leases.
- Expired client leases recover automatically after crashes.
- Closing one client never releases protection owned by another client.

One active-context request may protect at most 1,000 exact document versions. The daemon authorizes the complete set from compact document-history ledgers, checks key existence without decoding canonical payloads, and publishes the owner record plus every reverse reference in one transaction. Any missing, foreign-project, expired, superseded, or concurrently retired target rejects the entire request as unauthorized; document conflict guards prevent retirement from crossing the preflight-to-commit boundary. Full multi-MiB manifests are never retained as the protection working set. Retention checks popular document and session reverse-reference prefixes through uncached streaming pages, returning on the first live owner and retaining only one iterator record even when every reference is stale.

Access tracking is coarse. At most one access record per document per configured time bucket should be written; recall must not create a hot counter update on every read.

**Bucket deletion**

Keys put the time bucket before retention class so chronological due scans can stop at the first future bucket, while each `<time-bucket>/<retention-class>` subrange remains homogeneous. Mixed-retention values do not share a class subrange. Pinned values are promoted or referenced from the durable class before their old bucket expires.

**Disk-low emergency mode**

Routine retention does not target an exact archive byte size. The daemon still monitors filesystem free space and RocksDB live/SST estimates.

When free space crosses a configured critical threshold, the daemon:

1. Runs all already-due expiry work immediately.
2. Shortens only unprotected future raw tool-result payloads; source turns, durable evidence, active evidence, pins, protections, and retrieval leases remain intact.
3. Flushes completed deletion waves and leaves physical reclamation to RocksDB's background compaction workers.
4. Rejects an individual archival write that would threaten host stability.
5. Reports a durable, user-visible degraded status.

The default critical threshold is 2 GiB with a 64 MiB admission reserve. Every archival admission checks current filesystem free space; a write is rejected with a typed, retryable `DISK_LOW` error when accepting it would consume the reserve. Retention, recall, search, pins, and lease renewal remain available in emergency mode. A threshold of zero disables this guard and clears a previously persisted emergency flag during daemon startup.

Emergency behavior never deletes durable pins, active evidence, or the newest source turn per session without an explicit destructive policy.

The public `force` option only requests an immediate cleanup pass. It does not
authorize lifetime shortening; that authority exists only inside the daemon's
disk-pressure maintenance path.

**Semantic compaction**

Physical compaction must not be confused with summarization. The first compact evidence layer is deterministic: terms, positions, structural scores, source-linked verbatim excerpts, and manifests. Model-generated summaries are deferred because they can lose or invent evidence.

**Required evidence**

- Expired versions disappear from search before physical compaction.
- A locator for an expired version returns `expired`, not a newer version.
- Pins and leases survive concurrent cleanup attempts.
- Restart resumes interrupted expiry idempotently.
- After a controlled deletion-and-compaction benchmark, physical bytes materially decrease and no live key is lost.

These behaviors are exercised by `test/rocksdb-retention.test.js`, `test/daemon-maintenance.test.js`, and the retention component consumed by the archive performance aggregate. Configuration/default separation is enforced by `test/config.test.js`; automatic age eligibility is enforced by `test/retrieval-hints.test.js`.
