**Deployment and default policy**

Pi may load the extension directly from a checkout; no package publication is required. After code changes, `/reload` loads the new extension. The client compares its production-code fingerprint and required capabilities with the daemon generation that owns the configured store; a stale daemon is gracefully replaced and clients reconnect through the normal store-lock arbitration. Do not manually search for or broadly kill daemon PIDs during routine updates. Fresh installations default to RocksDB, while an existing SQLite archive remains authoritative until the documented offline migration succeeds. Runtime authority, archive contents, and local overrides are machine state and are intentionally not recorded here; inspect them with `/window` and `/window archive status`.

The shipped defaults are:

| Control | Default value |
|---|---:|
| Rotate active context | 65% of the model window or 20 user messages |
| Normally retain after rotation | 5 complete interaction groups |
| Externalize one large tool result | Above 4,000 estimated tokens |
| Tighten the tool-result gate | After admitted tool results reach 30% of the rotation target, new results externalize above 1,000 tokens |
| Suppress duplicate tool results | Enabled (`dedupToolResults`) |
| Manual search results | 3 |
| Automatic recall | Enabled |
| Automatic hint budget | 160 tokens per message; 640 across the active context |

**Mental model**

Pi's native session transcript and the context-window archive are separate state. The transcript supports Pi resume and branch navigation. Canonical archived documents are added after an epoch rotation, large-tool externalization, explicit archive write, oversized-user admission, or Pi compaction checkpoint. RocksDB is not a second copy of every live message. Automatic retrieval may separately persist one bounded marker or excerpt in a hint record.

The model normally sees the active epoch. Archived history stays outside the prompt until retrieval selects bounded material. Ordinary recent turns that have neither rotated nor been checkpointed are not yet searchable in RocksDB; an oversized user source or a span covered by Pi compaction is already archived even if no epoch boundary moved. Deleting Pi session files would not clear RocksDB memory, and clearing RocksDB would not delete Pi's native transcript.

The per-result externalization gate has a cumulative companion. Dozens of individually moderate tool results (1-3K tokens each) can pass the per-result gate yet dominate the epoch in aggregate. The session tracks the tool-result tokens admitted into the active epoch — whole results kept inline plus the bounded previews of externalized ones — and once that total reaches `toolResultBudgetRatio` (default 0.3) of the rotation target, new tool results are externalized above the lower `toolResultBudgetFloorTokens` (default 1,000) instead of `maxToolResultTokens`. The gate is forward-only: each result's decision depends only on the tokens admitted by results before it, so an already-exposed result is never rewritten and the provider prompt cache survives. The counter is not persisted separately; it is recomputed deterministically from the same boundary-filtered active slice on every pass — including after session resume — and resets when rotation advances the boundary to a new, shorter epoch. Oversized tool-call *arguments* are governed by their own independent `maxToolArgumentTokens` gate and are deliberately excluded from this tool-result budget: the budget targets the tool-result output that dominates real epochs, and keeping the two accounts separate avoids one symmetric feature perturbing the other's threshold.

Sessions often re-run the same read or command and get back the identical result. `dedupToolResults` (default on) catches this ahead of the size gates: a new tool result whose tool name, normalized call arguments, and content hash exactly match a result already admitted earlier this epoch is externalized regardless of size and replaced with a short marker naming the earlier result and the new archive id, instead of the full body. A near-match — same tool and arguments but different output — is left alone. The earlier occurrence is never rewritten, matching the append-only, forward-only shape of the tool-result budget above; because the duplicate is reduced to its marker before the size-based gates run, a suppressed duplicate never inflates the cumulative tool-result budget. The per-epoch comparison map is not persisted — it is rebuilt from the same boundary-filtered active slice on every pass, so it reconstructs deterministically on resume and starts empty again after rotation.

RocksDB is one local physical store with four logical layers:

1. Canonical archived documents are immutable source records.
2. Exact, BM25 lexical, and structural indexes locate candidates without loading the archive into the prompt. Automatic preflight uses neither embeddings, model-based reranking, nor generated memory summaries. Explicit `context_window_search` and `context_window_gather` may additionally fall back to a local, non-LLM semantic embedding index; it is on by default and is disabled at the configuration/environment level with `semanticRetrieval: false` (the internal `store.search` wire API also accepts a per-call `semanticPolicy: "never"` override, not exposed as a tool parameter). The same two tools can reorder that fused lexical/semantic tier with a local cross-encoder reranker, disabled by default and enabled explicitly with `rerankerEnabled: true` after installation (`context-window-semantic install-reranker`).
3. Retrieval hints cache bounded decisions for stable user-message keys. Explicit historical intent can cache one quoted excerpt; an implicit recurring concept can cache only a marker made from exact phrases the user just wrote. Normal context reconciliation after rotation or compaction removes hints whose user message left the active path. Hints unique to an abandoned branch may remain until the default 30-day inactivity cleanup. Separate source-exposure records preserve the default 24-hour repeat-suppression window, after which bounded maintenance tombstones them.
4. RocksDB compaction reclaims obsolete physical records; it does not decide which evidence is semantically live.

**Recall on each message**

Automatic preflight runs for each eligible current user message once per stable project, session, and message key. A user message already externalized through oversized admission is skipped because its archived source is still visible in the provider context. Preflight searches only the current session and verified fork ancestry and excludes other source messages already visible in the active context. Explicit historical intent can reveal one strong, unambiguous, source-dated JSON excerpt. An implicit recurring concept can reveal only a search marker whose variable text is copied exactly from the current message; archive-only names and jargon stay out of the prompt. Current-only, general, weak, stale, repeated, suppressed, and failed decisions contribute zero prompt bytes.

Reveals and suppressions are persisted so later reindexing cannot change an already-used prompt prefix. A failed attempt is durably marked as attempted; restart may reconstruct an existing frozen daemon record but may not run a new search for that same used prefix. The 160-token per-message limit and 640-token active-context limit include headers and separators.

Manual `context_window_search` is broader when requested:

| Scope | Reach |
|---|---|
| `session` | Current session plus verified parent-session lineage, within the current project |
| `project` | All archived sessions whose project identity matches the current working directory |
| `all` | Up to the operator-granted read ceiling: collapses to project scope by default; reads every project in the store when user-global settings grant `maxReadScope: "all"` |

`context_recall` then resolves the authenticated result locator to an exact, budgeted source excerpt. Locator recall preserves the original search scope. Direct document-ID compatibility is broader within the same project, so treat document IDs as project-local capabilities. Archived evidence is useful for prior intent and decisions; current files and runtime state still require live inspection.

**Projects and sessions**

All projects share the default RocksDB files, but records are logically partitioned by project identity: the canonical real path of Pi's current working directory, with symlinks and alternate spellings resolved so one repository opened through different paths maps to a single namespace. A project-scoped search can bridge unrelated sessions in that same directory. It cannot cross into another project, and two genuinely different directories never collapse.

Read scope is one lattice (`session` ⊂ `project` ⊂ `all`) with two roles: the per-request `scope` is chosen by the model and is untrusted; the granted ceiling is operator configuration. The effective scope of any request is min(requested, granted). The ceiling (`context-window.maxReadScope`, default `project`) is honored only from the user-global `~/.pi/agent/settings.json` — configurable from the `/window settings` panel — and is read by the daemon itself at each handshake, never from the client handshake and never from project-local `.pi/settings.json`, so repository content cannot widen its own authorization. Under a global grant, `scope=all` search/gather read every project namespace and recall honors signed locators from any of them; project- and session-scoped requests never widen, and writes always target the authenticated project alone. Archives written under a pre-canonical spelling stay reachable through a read-only path alias; new writes always use the canonical identity. When the real path cannot be resolved, partitioning falls back to the exact directory string.

Resuming a Pi session preserves its session identity. A fork gets a new identity but session-scoped recall includes structurally verified ancestors. A new unrelated session starts with no session-lineage memory; use a project-scoped search when prior work from another session is relevant. Work that never rotated, externalized, checkpointed, or entered an explicit archive write remains only in the earlier Pi transcript.

Trusted projects may override policy in `.pi/settings.json`. Global policy belongs in the `context-window` namespace of the shared Pi settings. A separate `rocksdbPath` is available for physical project isolation, but logical project partitioning is sufficient for normal use.

**Routine controls**

| Command | Purpose |
|---|---|
| `/window` | Show active epoch, limits, rotations, database, and storage totals |
| `/window rotate` | Queue an epoch rotation before the next provider request |
| `/window search <terms>` | Search the current session and verified ancestry |
| `/window archive status` | Show logical records, physical storage, and retention status |
| `/window archive prune` | Process due semantic retention for the current project while honoring protections, pins, and leases |
| `/window archive reclaim` | Request physical RocksDB reclamation after logical deletion across the shared store |

Normal operation has no archive byte cap. Raw tool payloads expire after 14 days, archived conversation sources after 90 days, and source-linked derived evidence after 30 days; manual archives are durable. Automatic insertion stops sooner for tool payloads after 7 days and for conversation/derived evidence after 30 days. Older retained evidence remains available to explicit search. Active-context protection, pins, and retrieval leases take precedence over deletion. Background maintenance and LSM compaction run without placing raw storage logs in model context. A separate low-disk admission guard can stop new writes before the host becomes unsafe.

Scoped redaction is available as `/window archive redact session confirm <token>` and `/window archive redact project confirm <token>` (and the matching daemon `store.redact` operation). Redaction tombstones archive documents in that scope immediately for search and preflight; it does not delete Pi's on-disk session transcript. Durable longevity for decisions belongs in the repository: use `/window promote <id>` for a concrete draft (an AGENTS.md/CLAUDE.md diff hunk or ADR file body, with provenance and a suggested target path), then apply it into `AGENTS.md`, an ADR, or config. Do not treat archive pins as the product longevity path. When a prior decision is reversed, use `/window supersede <id>` or `context_window_supersede` so the old version leaves search. A complete archive reset still affects every project using that physical store and remains an offline administrative operation: stop Pi and MCP clients, explicitly terminate the detached `context-windowd` process, verify that no daemon owner or database handle remains, preserve or remove the RocksDB directory as intended, then start Pi to create fresh authority. Stopping clients alone does not stop the daemon. Do not delete individual RocksDB files or edit records while the daemon is running.
