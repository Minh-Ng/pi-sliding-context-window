# Context Epoch Window

A cache-aware context window for coding agents. It keeps conversation history append-only during a large **epoch**, rotates only at a token threshold, archives removed turns through a single-owner local RocksDB daemon, and exposes exact, BM25, optional local semantic, structural, and bounded recall tools.

The Pi adapter provides the complete implementation because Pi exposes a pre-request `context` hook. The included MCP server makes the archive portable to Claude Code, Codex, OpenCode, and other MCP clients, but those clients cannot transparently remove old transcript messages unless their plugin API exposes a message-transform hook.

## Architecture

The implementation separates portable policy from host wiring:

- `src/session/epoch-window.js` — the host-independent session state machine. Storage and rotation persistence are injected through `archive` and `onRotation`.
- `src/session/window.js` — pure message grouping, filtering, token estimation, and epoch-boundary functions.
- `src/daemon/**`, `src/rocksdb/**`, and `src/retrieval/**` — the single-owner RocksDB service, immutable canonical records, indexes, locators, leases, recall, retention, and automatic hint preflight.
- `src/archive/archive.js` — the SQLite compatibility backend and pre-authority rollback source; custom adapters can still provide the small archive interface.
- `src/presentation.js` — shared output truncation and status/search formatting.
- `src/evidence-routing.js` — production archive-vs-live policy, tool descriptions, agent guidelines, and stale-evidence label. Benchmark fixtures and helpers are isolated under `eval/evidence-routing/` and are not imported by production modules.
- `src/session/session-id.js` — stable session identity and bounded, failure-tolerant Pi session-header lineage discovery.
- `extensions/pi.ts` — a thin Pi lifecycle, tool, command, and UI adapter. `createContextEpochWindow()` accepts custom `configLoader` and `archiveFactory` dependencies.
- `bin/context-windowd.js` — the sole RocksDB owner and versioned local RPC endpoint.
- `bin/context-window-mcp.js` — the portable MCP adapter over the same daemon-backed archive and presentation modules.

This keeps provider policy testable without Pi and gives alternate hosts or storage backends explicit extension points.

## Storage and Node requirement

The packaged Pi extension and MCP server use `@harperfast/rocksdb-js` through `context-windowd`. Adapters never open RocksDB directly. The first client starts the daemon on demand; later clients using the same resolved store share its Unix socket. Closing one client does not close the store while others remain. After the final client and request are gone, a five-minute reconnect grace expires before the daemon closes RocksDB and exits. Context Window currently supports macOS and Linux; Windows is unsupported because this release does not implement a named-pipe transport.

The package requires Node **22.19–22.x or 24+** and is tested on Node 24. Node 23 is not supported. Fresh installations default to RocksDB. If an existing SQLite archive is detected and no backend was explicitly configured, SQLite remains authoritative until the offline migration procedure completes.

Programmatic Pi integrations can replace storage by calling `createContextEpochWindow({ archiveFactory })`. The factory must provide `put`, `search`, `get`, `count`, and `close`; automatic preflight is enabled when it also provides `preflight`.

## Pi compatibility

No local or unreleased Pi patch is required. The adapter uses documented public extension APIs only: the `context`, `session_start`, `session_tree`, `session_before_compact`, `session_compact`, `agent_settled`, `model_select`, and `session_shutdown` events; `appendEntry`; `registerTool`; `registerCommand`; and `ctx.ui.setStatus`.

The package declares `@earendil-works/pi-coding-agent >=0.80.6` as its compatibility floor. The integration is tested against Pi 0.82.0. Transparent rotation specifically requires the host's pre-provider `context` message-transform hook, and threshold-compaction suppression requires cancellable `session_before_compact`; hosts without equivalents can use the MCP archive but not the full window policy.

## Behavior

Default policy:

- Keep appending until the active epoch reaches approximately **65% of the selected model's context window or 20 user-role messages**.
- Rotate once at a user-message boundary, normally retaining the configured number of latest interaction groups (each user-role message plus its following assistant/tool traffic). If that suffix does not fit the rotation target, retain progressively fewer complete groups, down to one. The footer reports `emergency retention N/M` when this safety policy goes below the configured target; the notice clears after four new user-role messages while the underlying rotation history remains persisted.
- Archive removed interaction groups in `~/.pi/context-window/archive.rocks` through the shared daemon.
- Checkpoint every completed interaction group after the agent settles, with shutdown as an idempotent fallback. Short sessions therefore become project history even when they never reach an epoch rotation; interrupted user/tool tails are not archived as completed turns.
- Record each archived turn/preamble's ordered stable source message keys, explicit first/last keys, source count, session, project, archive kind, and creation time. Keys hash the complete deterministic message serialization. Exact recall shows this provenance in Pi and MCP; Pi also returns it as structured tool-result details for host/UI consumers.
- Externalize individual tool results above **4K estimated tokens before the provider sees them**, recording the one original source message key while keeping the resulting document distinct from an archived turn. A cumulative companion guards against aggregate creep: once tool results admitted into the active epoch reach **30% of the rotation target** (`toolResultBudgetRatio`), new tool results externalize above the lower **1K-token floor** (`toolResultBudgetFloorTokens`) instead of the 4K gate. The tightening is forward-only within an epoch — each result's decision depends only on results before it, so the exposed prefix and its provider prompt cache are never rewritten. At rotation, where the prompt prefix already changes, retained tool results above the lower gate are rebalanced into archived previews; the carry-over cutoff is persisted so resume reproduces the same provider-facing suffix. The running counter is recomputed deterministically from that filtered suffix on every pass. Oversized tool-call arguments keep their own separate `maxToolArgumentTokens` gate and do not count toward this budget.
- Suppress exact-duplicate tool results within the active epoch (`dedupToolResults`, default on): when a new tool result's tool name, normalized call arguments, and content hash exactly match a result already admitted this epoch, the new occurrence is externalized regardless of size and replaced with a short marker naming the earlier result and the new archive id. The earlier occurrence is never rewritten, and a near-match (any changed byte) is left in place untouched. The comparison map is recomputed from the boundary-filtered active slice on every pass, so it rebuilds deterministically on resume and resets when rotation starts a new epoch; a suppressed duplicate does not count toward the cumulative tool-result budget above.
- Session-scoped search in a fork includes that session's verified parent archive lineage immediately, even if no ancestor has rotated. Ancestor identities come only from structurally valid Pi JSONL session headers; persisted rotation entries retain lineage only as informational state and cannot grant search access. Stable path identity is reserved for the current session when Pi does not provide its ID.
- Keep exact source session entries unchanged. Archived text is deterministic source-derived message serialization, not stored raw message objects. Pi's `bashExecution`, `compactionSummary`, and `branchSummary` roles are serialized from their native payload fields so token estimates, stable keys, and archived preambles include their actual command/output or summary text.
- Before accounting or provider dispatch, archive user input above the default 16K-token inline limit exactly. Only the provider-facing text receives a bounded head/tail preview; non-text blocks remain present, automatic retrieval skips that still-visible source, and the Pi transcript stays unchanged. Admission failure aborts the turn without exposing the raw oversized text.
- Run a cheap exact-first retrieval preflight for each current user message. Explicit historical intent may reveal one strong, unambiguous, date-labeled JSON excerpt. An implicit recurring concept can reveal only a continuity marker made from exact phrases in the current message; archived candidate wording and cold jargon do not enter that marker. Weak, stale, repeated, current-only, general-knowledge, and failed preflights add zero prompt bytes. Selected bytes are frozen by user-message key so an unchanged active prefix never changes after reindexing.
- Apply semantic expiry by evidence class and age. There is no routine maximum archive size. Pins, active-context protections, and retrieval leases win deletion races; disk-low emergency mode remains a separate host-safety mechanism.
- Let RocksDB compact obsolete LSM records in the background. Large deletion waves trigger a flush and continue through RocksDB's background workers; an explicit operator may request a full manual compaction. Compaction never decides which logical evidence is live.
- Apply adaptive epoch ratios to Pi's usable input budget (`model contextWindow - compaction reserveTokens`), rotating well before the host's exact threshold rather than treating combined input+output capacity as history space. Pi's configured reserve is authoritative; `model.maxTokens` is the fallback when that setting is unavailable. If provider usage still reaches Pi's threshold, the extension never cancels based on aggregate token estimation: it archives the exact compaction inputs and returns the bounded custom result. Large compaction spans split deterministically across bounded checkpoint roots while preserving every original message key in order. If checkpoint publication cannot be confirmed, the adapter cancels compaction rather than pass raw source to a summarizer.

Epoch sizing uses `characters / 4` within the reserve-adjusted input budget and excludes fixed request overhead such as the system prompt, tool schemas, and provider framing. Model-visible hints and recall use the stricter deterministic estimator described below. Provider usage and Pi's archive-first compaction threshold remain authoritative for safety; aggregate usage is never used to certify a retained suffix.

## Install in Pi

From this repository:

```bash
pi install /path/to/context-window
```

Restart Pi, then configure or inspect it:

```text
/window
/window settings
/window search refresh token
/window recall why
/window promote <documentId>
/window supersede <documentId> [note]
/window rotate
/window daemon status
/window daemon restart --force
/window archive status
/window archive prune
/window archive reclaim
/window archive redact session confirm <token>
/window archive redact project confirm <token>
```

`/window settings` opens a TUI settings panel for the global turn cap and optional absolute context-token cap. Changes persist under the `context-window` namespace in `~/.pi/agent/settings.json` and apply to the active session immediately when no higher-precedence project or environment override wins. Choose `adaptive` for the context cap to use the configured model-relative rotation ratio instead of an absolute token ceiling.

`/window recall why` explains the last automatic retrieval decision, including its suppression reason and sanitized match metrics. It never prints archived source text. `/window promote` recalls an archived decision and prints a concrete draft — an AGENTS.md/CLAUDE.md diff hunk or ADR file body, with provenance and a suggested target path — for landing a durable decision in the repo in one step (not an archive pin). `/window supersede` marks a prior archived decision as no longer live for search. `/window daemon status` reports the shared process, runtime generation, client count, active requests, and idle-shutdown state. `/window daemon restart --force` deliberately drains and replaces that process after warning that every Pi tab sharing the store will reconnect. Scoped redaction tombstones archive documents for one session or project after an explicit confirm token.

Agent tools:

- `context_window_gather` — retrieve a bounded, chronologically ordered packet of exact evidence for historical state or a multi-turn workflow
- `context_window_search` — exact/BM25 search with optional local semantic fallback, or structural lookup of the latest archived question, request, correction, or answer
- `context_recall` — recover an archived document by ID
- `context_window_traverse` — inspect bounded chronology before or after an authenticated anchor
- `context_window_supersede` — admit a correction that supersedes a prior archived document

Gather is the default for ordinary questions that require synthesis across dated records or surrounding workflow turns. It performs hybrid candidate retrieval, expands only the verified session lineage, resolves exact source, and returns explicit truncation metadata. Low-level search, recall, and traversal remain available for precise investigations and continuation.

`context_recall` keeps direct document-ID compatibility. Search internally returns authenticated, version-bound locators and exact recall uses them without substituting newer versions.

Use archive tools for prior intent, rationale, exact wording, decisions, rejected approaches, continuity, and scope disputes. Use live inspection for current files, runtime, configuration, tests, and task status. Mentioning old discussion or inviting history lookup does not make archive evidence material when the answer is exclusively current mutable state. For mixed questions, recover archived intent first, inspect live state second, and reconcile conflicts; archived evidence is never proof of current mutable state. Avoid speculative broad archive searches.

For a conceptually phrased historical question without an exact identifier, the agent preserves the original question for semantic matching and supplies 3–8 concise likely synonyms or domain terms separately for BM25 expansion. Exact file names, symbols, errors, commits, PRs, and specific values are searched verbatim and are never broadened. A missed conceptual archive search permits at most one reformulation; a missed well-anchored search routes the agent to live or external evidence instead.

Local semantic fallback is enabled by default and applies only to explicit search after exact lookup misses and BM25 evidence is weak. It does not change automatic prompt insertion. Install the configured model once:

```bash
context-window-semantic install
# From a source checkout where the package bin is not on PATH:
node ./bin/context-window-semantic.js install
```

The installer is the only path that permits a model download. Restart the shared daemon after installation. Runtime inference uses the library-managed cache with remote model access disabled; embeddings and per-project ANN indexes remain on the local machine. If the model or native index is unavailable, search falls back to exact/BM25 without failing the request.

The shipped default is `Xenova/all-MiniLM-L6-v2` (384-dim, ~90MB quantized). `src/semantic/model-catalog.js` also carries two unshipped candidate tiers for a manual upgrade — a small tier (`embeddinggemma-300m`, 768-dim, ~300MB quantized) and a quality tier (`Qwen3-Embedding-0.6B`, 1024-dim, ~600MB quantized; Jina v5 text-small is a same-size alternative with a non-commercial license). Install a candidate by tier alias or full model id, and pass a revision to pin something other than the catalog's `main`:

```bash
context-window-semantic install small
context-window-semantic install quality
context-window-semantic install jinaai/jina-embeddings-v5-text-small
```

Installing only warms the cache; it does not switch the daemon to the new model. Set `semanticModel` (and `semanticModelRevision`, if pinning) in config to that model id — or to the same tier alias (`small`/`quality`/`default`) you installed, which config resolves to the catalog's model id and pinned revision the same way the installer does — and restart the shared daemon. The per-project ANN index is keyed by a fingerprint of model, revision, embedding dimensions, and pooling strategy, so switching models rebuilds it automatically from canonical records in the background rather than mixing incompatible vectors; existing indexes for the previous model stay on disk until manually removed. Embedding dimensions and pooling (mean vs. last-token) come from the catalog entry for the configured model, not a fixed literal — set `semanticModelDimensions`/`semanticModelPooling` only to override a custom or self-hosted model the catalog does not recognize.

The small `embeddinggemma-300m` tier was subsequently installed and compared with the default in local retrieval evaluations. It showed no meaningful retrieval improvement, while its published quantized footprint is approximately 300MB versus 90MB for MiniLM (about 210MB more) and switching tiers requires a full background re-embed. No retained artifact makes that local comparison an independent benchmark claim; it is the empirical cost/benefit reason MiniLM remains the default. The catalog's EmbeddingGemma dimensions and pooling still come from its published model card, so confirm the installer's reported `dimensions` before relying on a new revision.

The quality-tier Qwen3 and Jina candidates remain unvalidated in this environment: their dimensions and pooling are sourced from their published cards, not measured locally. Expect their retrieval quality to fall short of published benchmarks until per-model instruction/query prompting (recommended by both model cards, not implemented here) is added. All non-default tiers remain manual experiments rather than pending default changes; semantic gates are calibrated against MiniLM's score distribution, so validate a candidate on your own archive (`eval:retrieval` and relevance-feedback statistics) before adopting it.

Semantic retrieval is opt-out. On a machine where its additional memory, CPU, or disk use is undesirable, disable it explicitly:

```json
{
  "context-window": {
    "semanticRetrieval": false
  }
}
```

A local cross-encoder reranker additionally reorders explicit search/gather's fused lexical/semantic results by (query, candidate) relevance — the same eval-validated configuration recorded in `eval/retrieval/reranker-verdict.json` (`Xenova/ms-marco-MiniLM-L-6-v2`, pinned revision, `q8`/CPU). It never touches automatic prompt insertion, never crosses the exact/structural priority tier, and degrades silently to the pre-rerank fused order whenever the pinned model is not installed. Install it once:

```bash
context-window-semantic install-reranker
# From a source checkout where the package bin is not on PATH:
node ./bin/context-window-semantic.js install-reranker
```

The installer is the only path that permits a model download; restart the shared daemon after installation. Only one reranker model is currently supported, so `install-reranker` takes no arguments. It is opt-out like semantic retrieval:

```json
{
  "context-window": {
    "rerankerEnabled": false
  }
}
```

`rerankerModel`/`rerankerModelRevision` override the pinned model (for a self-hosted mirror); `rerankerModelCachePath` overrides its local cache directory; `rerankerCandidates` overrides how many fused candidates are reranked per query (default 40, matching the eval's own candidate window).

When an existing context-recovery trigger has no lexical anchor, `context_window_search` accepts a structural `relation` instead of a query:

```json
{"relation":"latest-question","scope":"session"}
{"relation":"latest-request","query":"LiveServing","scope":"session"}
```

Supported relations are `latest-question`, `latest-request`, `latest-correction`, and `latest-answer`. The archive scores original user and assistant messages with deterministic cues at rotation time; no model or embedding call is involved. A relation result keeps the containing turn's archive ID, so `context_recall` continues to recover the exact full turn. Results explicitly report `resolved`, `ambiguous`, `not-found`, or `legacy-fallback`. Ancestor-only, low-confidence, cross-session, and newer unindexed legacy evidence is not silently presented as a certain resolution.

Query-only calls retain the existing document-level BM25 behavior and ordering. A relation plus query applies BM25 to individual user or assistant messages, preventing unrelated sibling tool or assistant text from satisfying the anchor.

### Routing benchmark and model evals

`eval/evidence-routing/evidence-routing-eval.js` exports two annotated, balanced suites in deterministic interleaved order:

- `EVIDENCE_ROUTING_REGRESSION_SUITE` contains the original 20 cases used while tuning the anti-framing guidance. Results on these cases are **regression checks**, not independent evidence.
- `EVIDENCE_ROUTING_HELD_OUT_SUITE` contains 20 new cases with route-neutral IDs. Only an untouched held-out suite—one not inspected for errors or used to change the policy before evaluation—can support independent evidence. After its cases or results inform tuning, report later runs as regression checks.

Before a run, select the suite and explicitly classify its prior exposure as `untouched` or `regression`; this is never inferred from the suite name. Send only the frozen, ordered `{ id, prompt }` values returned by `evidenceRoutingModelInputs(suite)` to the model; never expose `expectedRoute` or `annotation`. Preserve the exact evaluation instructions, full rendered prompt, model-safe inputs, raw response text, and parsed labels. Require one lowercase route label per input before tool use, and do not reorder, normalize, retry, or discard responses. Represent a missing parsed response as `null`. Use annotations only after outputs have been recorded and scored.

Score parsed ordered labels with `scoreEvidenceRouting(expectedLabels, parsedOrderedLabels)`. The pure helper reports correct, incorrect, missing, invalid, and extra outputs, accuracy, and false archive searches (an `archive` or `both` result for a `live` or `neither` case). `invalid` counts non-route values in expected positions; `extra` counts outputs beyond the expected case count. Incorrect and accuracy always use that expected count as their denominator.

For reproducibility, `createEvidenceRoutingEvalRecord(...)` requires the timestamp, provider/model identifier, suite, explicit exposure, exact evaluation instructions, ordered inputs, exact rendered prompt, raw response and its capture provenance, parsed labels, and harness identifier/revision/settings. The deterministic renderer keeps conceptual and response IDs as `heldout-NNN` but presents case-line IDs as `NNN`, matching the retained tool call. Each record hashes the full rendered prompt and also pins a versioned SHA-256 fingerprint of the complete model-visible production routing guidance: both tool descriptions, `EVIDENCE_ROUTING_GUIDELINES`, and `ARCHIVED_EVIDENCE_LABEL`. Policy-only constants such as `EVIDENCE_ROUTING_POLICY` are excluded because neither adapter exposes them to models. `validateEvidenceRoutingArtifact()` rejects stale guidance, altered input order or prompts, rendered-prompt tampering, inconsistent raw-response reconstruction, changed labels or scores, and incomplete provenance.

The initial run is preserved at `eval/evidence-routing/heldout-2026-07-12.json`. Those cases were untouched at run time; all future reruns must choose exposure explicitly. Its full prompt text is exact from the retained tool call and stored in each record. Exact response bytes were not retained, so each `rawResponseText` is reconstructed from the retained 20 ordered `<id>: <route>` lines and labeled as reconstructed; parsed labels and scores are unchanged.

Eval fixtures, artifacts, and tests are repository-only development material and are intentionally excluded from the npm package.

The footer maps each current value directly to its limit: `Epoch · 15/20 turns · ~92K/96K tokens`. Before the first provider request it says `waiting to measure`; at 80% it adds `near limit`; at or above a limit it adds `at limit`; and `/window rotate` immediately shows `rotation queued`. Semantic states use the active Pi theme rather than hard-coded colors. `Epoch` uses the theme accent by default; set `statusLabelAccent` to `false` for normal footer text.

`retainTurns` is the normal retention target rather than an unconditional safety floor. Under token pressure, the extension chooses the largest complete-turn suffix that fits the rotation target and may retain fewer groups. If even the newest complete turn cannot fit, the footer reports `history checkpoint needed`; the adapter archives the exact compaction inputs before returning a bounded custom result. Pi's percentage/window footer remains authoritative for provider context usage.

The concise operator model for prompt use, automatic recall, project/session boundaries, retention, and reset procedures is documented in [state-operations.md](./docs/state-operations.md).
The behavior-to-verifier map for retrieval and retention is maintained in [retrieval.md](./docs/rocksdb-archive/retrieval.md), [retention.md](./docs/rocksdb-archive/retention.md), and [evaluation.md](./docs/rocksdb-archive/evaluation.md).
Oversized admission, fail-closed Pi handling, and real RocksDB restart reconstruction are verified by `test/epoch-window.test.js`, `test/extension.test.js`, and `test/oversized-compaction.test.js`.

## Configuration

Use the `context-window` namespace in Pi's shared settings files:

- Global: `~/.pi/agent/settings.json`
- Project-local: `.pi/settings.json` (loaded only for trusted projects)

`maxReadScope` is the operator-granted read ceiling for the search/gather `scope` lattice (`session` ⊂ `project` ⊂ `all`); the effective scope of a request is min(requested, granted). It is honored only from the user-global settings file and is read by the daemon itself at each handshake — never from the client handshake and never from project-local settings — so repository content cannot widen its own authorization. With the default `"project"`, `scope=all` collapses to project scope; with `"all"`, `scope=all` reads every project namespace in the shared store while project- and session-scoped requests stay unchanged and writes remain bound to the authenticated project. It is also editable from the `/window settings` panel and applies to new daemon connections.

```json
{
  "context-window": {
    "rotationContextRatio": 0.65,
    "hardLimitContextRatio": 0.8,
    "rotationTurns": 20,
    "models": {
      "anthropic/claude-*": {
        "rotationContextRatio": 0.7,
        "rotationTurns": 24
      },
      "openai/gpt-*": {
        "rotationContextRatio": 0.55,
        "rotationTurns": 16
      }
    },
    "retainTurns": 5,
    "maxToolResultTokens": 4000,
    "toolResultBudgetRatio": 0.3,
    "toolResultBudgetFloorTokens": 1000,
    "dedupToolResults": true,
    "maxInlineUserTokens": 16000,
    "searchResults": 3,
    "searchResultTokens": 1500,
    "automaticRetrieval": true,
    "hintBudgetTokens": 160,
    "activeHintBudgetTokens": 640,
    "epochHintBudgetTokens": 640,
    "hintSourceCooldownHours": 24,
    "ephemeralAutoRetrievalDays": 7,
    "conversationAutoRetrievalDays": 30,
    "derivedAutoRetrievalDays": 30,
    "ephemeralRetentionDays": 14,
    "conversationRetentionDays": 90,
    "derivedRetentionDays": 30,
    "maxReadScope": "project",
    "archiveBackend": "rocksdb",
    "rocksdbPath": "~/.pi/context-window/archive.rocks",
    "semanticRetrieval": true,
    "semanticModel": "Xenova/all-MiniLM-L6-v2",
    "semanticModelRevision": "751bff37182d3f1213fa05d7196b954e230abad9",
    "semanticModelCachePath": "~/.pi/context-window/models",
    "semanticIndexPath": "~/.pi/context-window/semantic-index",
    "semanticCandidates": 40,
    "semanticModelDimensions": null,
    "semanticModelPooling": null,
    "rerankerEnabled": true,
    "rerankerModel": "Xenova/ms-marco-MiniLM-L-6-v2",
    "rerankerModelRevision": "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
    "rerankerModelCachePath": "~/.pi/context-window/reranker-models",
    "rerankerCandidates": 40,
    "dbPath": "~/.pi/context-window/archive.db",
    "maxArchiveBytes": 1073741824,
    "targetArchiveBytes": 805306368,
    "recentDocumentProtectionDays": 7,
    "minimumTurnsPerSession": 20,
    "preventAutoCompaction": true,
    "statusLabelAccent": true
  }
}
```

The legacy standalone files `~/.pi/agent/context-window.json` and `.pi/context-window.json` remain supported, so existing configuration does not need to be moved immediately. A missing or non-object `context-window` namespace in shared settings is ignored.

Precedence, from lowest to highest, is: defaults, global legacy, global namespaced, trusted-project legacy, trusted-project namespaced, then valid environment overrides. Project sources always beat global sources. Invalid numeric values fall through to the next valid lower-precedence source. Model profiles merge field by field in the same source order.

Model keys match `provider/model-id`, are case-insensitive, and support `*`. Case-variant redeclarations are the same profile: their fields merge, the later spelling is displayed, and the redeclared profile moves to that later source-order position. An object redeclaration with no valid fields still reorders an existing profile and inherits its valid fields; without an existing profile, it is ignored. The most specific matching pattern wins; equally specific patterns use the later declaration. Profiles can override `rotationContextRatio`, `hardLimitContextRatio`, and `rotationTurns`. The active profile is shown by `/window`.

`activeHintBudgetTokens` is the preferred name for the 640-token active-context allowance. `epochHintBudgetTokens` remains a compatibility alias; when both are present at the same precedence, the preferred name wins.

`rotationTokens` and `hardLimitTokens` are optional explicit safety caps on ratio-derived limits. `/window settings` writes or removes the global `rotationTokens` cap; selecting `adaptive` removes that global key. Adaptive ratios use the model context window after subtracting Pi's root `compaction.reserveTokens` setting. If that setting is absent, the selected model's `maxTokens` is reserved instead. When Pi does not provide a valid model context window, the fallback limits are 96K and 128K respectively.

`archiveBackend` defaults to `rocksdb` only when no SQLite archive exists. An existing `dbPath` selects SQLite unless `archiveBackend` or `CONTEXT_WINDOW_BACKEND` explicitly selects RocksDB after offline verification. Every packaged adapter consults the singleton authority record through the configured RocksDB daemon before serving archive operations. SQLite startup persists a source-bound claim before opening SQLite. Fresh RocksDB startup persists permanent authority immediately, while a verified cutover remains rollback-eligible until its first canonical write atomically seals authority. SQLite startup therefore creates or contacts `rocksdbPath` even when remaining on SQLite; RocksDB startup always checks the configured `dbPath`. Concurrent or stale backend selections fail closed instead of opening divergent writable histories. Packaged adapters reject a fresh, incomplete, blocked, wrong-source, or post-authority rollback configuration. `maxArchiveBytes`, `targetArchiveBytes`, and SQLite reclamation settings apply only to SQLite. RocksDB uses `rocksdbPath`, derives a short Unix socket path automatically when `socketPath` is omitted, and has no routine archive-size cap. Raw tool payloads expire after 14 days by default, conversation sources after 90 days, and source-linked derived evidence after 30 days. Automatic prompt insertion is stricter: tool, conversation, and derived candidates become ineligible after 7, 30, and 30 days respectively. Manual or durable archives are never inserted automatically and do not expire automatically. Set a retention day value to `0` to disable automatic expiry for that storage class.

Environment variables use the same values:

```text
CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO
CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO
CONTEXT_WINDOW_ROTATION_TOKENS
CONTEXT_WINDOW_ROTATION_TURNS
CONTEXT_WINDOW_HARD_LIMIT_TOKENS
CONTEXT_WINDOW_PI_COMPACTION_RESERVE_TOKENS
CONTEXT_WINDOW_RETAIN_TURNS
CONTEXT_WINDOW_MAX_TOOL_RESULT_TOKENS
CONTEXT_WINDOW_DEDUP_TOOL_RESULTS
CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS
CONTEXT_WINDOW_SEARCH_RESULTS
CONTEXT_WINDOW_SEARCH_RESULT_TOKENS
CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL
CONTEXT_WINDOW_SEMANTIC_RETRIEVAL
CONTEXT_WINDOW_SEMANTIC_MODEL
CONTEXT_WINDOW_SEMANTIC_MODEL_REVISION
CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE
CONTEXT_WINDOW_SEMANTIC_INDEX
CONTEXT_WINDOW_SEMANTIC_MODEL_DIMENSIONS
CONTEXT_WINDOW_SEMANTIC_MODEL_POOLING
CONTEXT_WINDOW_SEMANTIC_CANDIDATES
CONTEXT_WINDOW_HINT_BUDGET_TOKENS
CONTEXT_WINDOW_ACTIVE_HINT_BUDGET_TOKENS
CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS
CONTEXT_WINDOW_HINT_SOURCE_COOLDOWN_HOURS
CONTEXT_WINDOW_EPHEMERAL_AUTO_RETRIEVAL_DAYS
CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS
CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS
CONTEXT_WINDOW_EPHEMERAL_RETENTION_DAYS
CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS
CONTEXT_WINDOW_DERIVED_RETENTION_DAYS
CONTEXT_WINDOW_BACKEND
CONTEXT_WINDOW_ROCKSDB
CONTEXT_WINDOW_SOCKET
CONTEXT_WINDOW_NODE
CONTEXT_WINDOW_IDLE_SHUTDOWN_MS
CONTEXT_WINDOW_MAX_ARCHIVE_BYTES
CONTEXT_WINDOW_TARGET_ARCHIVE_BYTES
CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS
CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION
CONTEXT_WINDOW_PREVENT_AUTO_COMPACTION
CONTEXT_WINDOW_STATUS_LABEL_ACCENT
CONTEXT_WINDOW_DB
```

The daemon is always launched with Node, even when the adapter host uses another runtime. `CONTEXT_WINDOW_NODE` can select an explicit Node 22.19–22.x or 24+ executable; otherwise a Node host reuses its current executable and a non-Node host resolves `node` from `PATH`.

The default Unix socket is placed in a per-user `0700` directory under the operating-system temporary directory. A custom socket must likewise have a real, current-user-owned parent directory with no group or other access, and its ancestor chain cannot be controlled by another user; paths directly under a shared `/tmp` are rejected before any client connects or store opens. The RocksDB directory is created or tightened to `0700` before storage opens so archive contents remain inside a current-user-only trust boundary.

The daemon runs bounded maintenance once per minute. `CONTEXT_WINDOW_IDLE_SHUTDOWN_MS` changes the default 300,000 ms last-client grace. Operators can tune its host-wide policy with `CONTEXT_WINDOW_MAINTENANCE_INTERVAL_MS`, `CONTEXT_WINDOW_RETENTION_BATCH_SIZE`, `CONTEXT_WINDOW_RETENTION_WAVES`, `CONTEXT_WINDOW_COMPACTION_DELETED_KEYS`, `CONTEXT_WINDOW_COMPACTION_RECLAIMABLE_BYTES`, `CONTEXT_WINDOW_CRITICAL_FREE_BYTES`, and `CONTEXT_WINDOW_ADMISSION_RESERVE_BYTES`. The default critical free-space threshold is 2 GiB; set it to `0` to disable the admission guard.

## Portable MCP archive

Run:

```bash
node /path/to/context-window/bin/context-window-mcp.js
```

It exposes:

- `context_window_archive`
- `context_window_gather`
- `context_window_search`
- `context_recall`
- `context_window_status`

Optional environment:

```text
CONTEXT_WINDOW_PROJECT=/absolute/project/path
CONTEXT_WINDOW_SESSION=session-id
CONTEXT_WINDOW_ROCKSDB=~/.pi/context-window/archive.rocks
CONTEXT_WINDOW_SOCKET=/optional/custom/context-windowd.sock
```

Point any MCP-capable client at that command. This provides shared archival and retrieval, not transparent transcript rotation on hosts without a pre-request message-transform API.

## Daemon and migration operations

The Pi and MCP adapters start `context-windowd` on demand. Each daemon advertises the fingerprint and capabilities of the production code it actually loaded. A runtime fingerprint mismatch alone is tolerated when the daemon still satisfies the client's required protocol capabilities; this prevents old and reloaded Pi tabs from repeatedly replacing one another's healthy shared process. A missing required capability is the only automatic upgrade path: the client signals the verified store owner and reconnects through the existing lock/socket arbitration. Operators decide when to load an otherwise compatible new runtime with `/window daemon restart --force`; manual PID lookup and `pkill` are neither required nor recommended. Automatic capability upgrades are recorded as `daemon-upgrade-requested` in the bounded daemon launch log.

Daemon diagnostics are strictly size-bounded per physical store. The event log, launch log, and optional stall sample each retain one active file and one previous generation, with every file capped at 4 MiB (24 MiB maximum across all six files). Rotation occurs before a write can cross the cap; oversized JSON records are replaced by bounded metadata, concurrent lifecycle writers coordinate rotation, and external sample output is capped after collection. Files stay mode `0600`, symlinks are rejected, and daemon child stdio is never attached to an unbounded file.

The daemon can also be managed explicitly:

```bash
context-windowd --store ~/.pi/context-window/archive.rocks --socket ~/.cache/context-window/run/context-windowd-migration.sock --allow-shutdown
context-window-migrate start --socket ~/.cache/context-window/run/context-windowd-migration.sock --source ~/.pi/context-window/archive.db --offline
context-window-migrate verify --socket ~/.cache/context-window/run/context-windowd-migration.sock --source ~/.pi/context-window/archive.db --artifact ./migration-verification.json
context-window-migrate status --socket ~/.cache/context-window/run/context-windowd-migration.sock
```

This is an offline migration. Stop every SQLite writer before passing `--offline`, and keep writers stopped until verification reports `passed` and status reports `offline-ready`. The flag asserts that quiescence; the CLI cannot stop other processes. Migration reads a coherent private SQLite DB/WAL snapshot, checkpoints idempotent batches, revalidates the completed prefix, and never modifies the source. RocksDB admissions are blocked during copy and verification.

After `offline-ready`, explicitly select RocksDB and restart the adapter. At startup the adapter checks the destination's migration status and exact source path before it can accept a write. A fresh or otherwise unverified destination fails closed while the configured SQLite source exists. Selecting SQLite before the first new RocksDB write persists a rollback claim; returning to RocksDB then requires rerunning offline migration start and verification, which is the only path that clears that claim. The first new RocksDB canonical write atomically changes status to `rocksdb-authority`, persists permanent global RocksDB authority, and makes every later SQLite startup fail before SQLite opens. Logical retention is paused throughout copy, verification, blocked, and verified pre-authority states, then resumes after authority. There is no supported automated rollback after that boundary. Imported records receive a fresh, checkpointed retention horizon at migration start: 14 days for raw tool payloads, 90 days for conversation sources, and 30 days for derived evidence by default. Migration provenance follows canonical document retention, resolved failures are removed after a successful retry, and RocksDB comparison detail is kept in a bounded audit window. See `docs/rocksdb-archive/migration-operations.md` for the complete procedure.

## Cache rationale

A strict sliding window removes the oldest prefix every turn, repeatedly invalidating provider prompt caches. Epoch rotation leaves the prompt append-only for tens of turns and pays one cache reset at rotation. Large tool output is externalized on first exposure so it never becomes part of the provider-cached transcript. Within an epoch, the cumulative tool-result budget tightens the externalization gate forward-only — only for tool results appended after the budget is reached — so it lowers aggregate tool-result pressure without rewriting the provider-cached prefix. At rotation, the prefix already changes, so retained tool results are rebalanced once and the carry-over cutoff is persisted for deterministic resume.

Resuming a Pi session preserves its session ID and deterministically rebuilds the filtered message prefix, but the first resumed request still rotates when either configured threshold is already met. The footer can therefore show fewer than `rotationTurns` while an explicit legacy `rotationTokens` cap triggers a cache-breaking rotation. Remove an obsolete absolute cap to use the model-relative ratio. A miss can also remain unavoidable after the provider's cache TTL expires (Pi treats five minutes as the diagnostic idle threshold) or when the model, system prompt, tool schemas, or epoch boundary changes.

## Safety and limitations

- Interaction groups are cut only at user-message boundaries, keeping assistant tool calls and results together. The epoch layer never splits a turn; a single oversized current turn is archived exactly and represented by a bounded preview before archive-first custom compaction.
- The legacy configuration keys use `Turns`; they count user-role messages and remain named that way for backward compatibility.
- A single enormous current turn may still reach threshold or overflow handling because no safe complete-turn epoch boundary exists. Any Pi threshold, overflow, or manual compaction request requires an exact checkpoint and bounded custom catalog; checkpoint failure cancels the operation. Rotation admission failures abort provider dispatch rather than weakening this fallback. After successful compaction, the extension persists a reset entry so reload cannot resurrect a stale epoch boundary or table of archived turns.
- Fork lineage follows `parentSession` paths from the current Pi session file (including resumed sessions), with the fork event's previous file as a startup fallback. Missing, malformed, oversized, non-session, unsupported-version, or ID-less parent headers contribute no path-derived identity and stop traversal; path cycles and chains beyond 64 ancestors also stop without failing session start. Session-scoped archive queries additionally require the active project when one is available.
- Images and non-text tool-result blocks are retained when text is externalized. Deterministic archive serialization records bounded image metadata (MIME type, decoded byte length, and a short SHA-256 digest) rather than base64 payloads, and token estimation uses Pi's provider-neutral 4,800-character proxy per image. Actual provider usage remains authoritative. Pre-multimodal persisted boundary keys remain restorable. New tool-result archives report their tool call ID/name and the stable key of their one original source message, but remain tool-result documents rather than archived turns.
- Existing SQLite databases require an explicit offline, non-destructive migration before RocksDB can contain their history. Online dual writes and post-authority rollback are not supported. Legacy documents with no real source keys retain documented absence; synthetic migration identities are never reported as original message provenance.
- RocksDB, SQLite rollback data, and the daemon socket are local. No archive content is sent to another service except when retrieved into an agent request.
- Recall applies lexical and byte limits while selecting canonical source. The final model-visible JSON record uses conservative deterministic token accounting for punctuation, JSON escapes, CJK, and opaque identifiers, so embedded text cannot escape either the evidence boundary or the configured presentation budget.
- Archive size is governed by retention rather than a fixed byte cap. One canonical document is limited to 8 MiB of UTF-8 source text and 1 MiB of metadata; split larger payloads into multiple documents. Source-message references are capped at 256 and 1 MiB of identifier text. Structural annotations are capped at 4,096 entries, 1 MiB of identifiers, and 1 MiB of message text. Derived indexing has independent bounded-work limits and records a durable `partial` or `skipped` status when a document exceeds them; the canonical document remains directly recallable.
- Structural relation scores are intentionally small English-oriented heuristics. Low-confidence role fallback and uncertain lineage/legacy ordering are labeled ambiguous rather than treated as verified semantic classification.
- BM25 is lexical. Search exact file names, symbols, errors, and decision terms.
- The preserved initial routing eval did not capture response bytes directly; its line-oriented raw responses are explicitly marked as reconstructions. Model eval scores are evidence for those prompts, models, settings, and exposure state—not a guarantee of production behavior.

## Development

```bash
cd /path/to/context-window
npm test
npm run check
```
