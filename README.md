# Context Epoch Window

A cache-aware context window for coding agents. It keeps conversation history append-only during a large **epoch**, rotates only at a token threshold, archives removed turns in local SQLite FTS5, and exposes BM25 search/recall tools.

The Pi adapter provides the complete implementation because Pi exposes a pre-request `context` hook. The included MCP server makes the archive portable to Claude Code, Codex, OpenCode, and other MCP clients, but those clients cannot transparently remove old transcript messages unless their plugin API exposes a message-transform hook.

## Architecture

The implementation separates portable policy from host wiring:

- `src/epoch-window.js` — the host-independent session state machine. Storage and rotation persistence are injected through `archive` and `onRotation`.
- `src/window.js` — pure message grouping, filtering, token estimation, and epoch-boundary functions.
- `src/archive.js` — the default SQLite FTS5 archive; an adapter can supply another implementation with the same small `put/search/get/count/close` interface.
- `src/presentation.js` — shared output truncation and status/search formatting.
- `src/evidence-routing.js` — production archive-vs-live policy, tool descriptions, agent guidelines, and stale-evidence label. Benchmark fixtures and helpers are isolated under `eval/evidence-routing/` and are not imported by production modules.
- `src/session-id.js` — stable session identity and bounded, failure-tolerant Pi session-header lineage discovery.
- `extensions/pi.ts` — a thin Pi lifecycle, tool, command, and UI adapter. `createContextEpochWindow()` accepts custom `configLoader` and `archiveFactory` dependencies.
- `bin/context-window-mcp.js` — the portable MCP adapter over the same archive and presentation modules.

This keeps provider policy testable without Pi and gives alternate hosts or storage backends explicit extension points.

## SQLite dependency

The packaged Pi extension and MCP server use SQLite by default. `src/archive.js` imports Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), and BM25 retrieval requires that Node's SQLite build includes FTS5. There is no native SQLite npm dependency to compile or install.

The package requires Node **22.13+**, the first Node 22 release where `node:sqlite` is available without `--experimental-sqlite`. The test environment uses Node 24 and verifies FTS5 by creating and querying the archive. Unusual custom Node builds can omit FTS5; archive startup then fails with a direct compatibility error.

Programmatic Pi integrations can avoid SQLite by calling `createContextEpochWindow({ archiveFactory })`. The factory must provide `put`, `search`, `get`, `count`, and `close`; when supplied, the Pi adapter does not load `src/archive.js`. The included MCP executable currently always uses the SQLite archive.

## Pi compatibility

No local or unreleased Pi patch is required. The adapter uses documented public extension APIs only: the `context`, `session_start`, `session_tree`, `session_before_compact`, `session_compact`, `agent_settled`, `model_select`, and `session_shutdown` events; `appendEntry`; `registerTool`; `registerCommand`; and `ctx.ui.setStatus`.

The package declares `@earendil-works/pi-coding-agent >=0.80.6`, the released version this integration is tested against. Transparent rotation specifically requires the host's pre-provider `context` message-transform hook, and threshold-compaction suppression requires cancellable `session_before_compact`; hosts without equivalents can use the MCP archive but not the full window policy.

## Behavior

Default policy:

- Keep appending until the active epoch reaches approximately **65% of the selected model's context window or 20 user-role messages**.
- Rotate once at a user-message boundary, normally retaining the configured number of latest interaction groups (each user-role message plus its following assistant/tool traffic). If that suffix does not fit the rotation target, retain progressively fewer complete groups, down to one. The footer reports `emergency retention N/M` when this safety policy goes below the configured target.
- Archive removed interaction groups in `~/.pi/context-window/archive.db`.
- Record each archived turn/preamble's ordered stable source message keys, explicit first/last keys, source count, session, project, archive kind, and creation time. Keys hash the complete deterministic message serialization. Exact recall shows this provenance in Pi and MCP; Pi also returns it as structured tool-result details for host/UI consumers.
- Externalize individual tool results above **4K estimated tokens before the provider sees them**, recording the one original source message key while keeping the resulting document distinct from an archived turn.
- Session-scoped search in a fork includes that session's verified parent archive lineage immediately, even if no ancestor has rotated. Ancestor identities come only from structurally valid Pi JSONL session headers; persisted rotation entries retain lineage only as informational state and cannot grant search access. Stable path identity is reserved for the current session when Pi does not provide its ID.
- Keep exact source session entries unchanged. Archived text is deterministic source-derived message serialization, not stored raw message objects. Pi's `bashExecution`, `compactionSummary`, and `branchSummary` roles are serialized from their native payload fields so token estimates, stable keys, and archived preambles include their actual command/output or summary text.
- BM25 retrieval is tool-driven, avoiding dynamic automatic injections that would damage prefix-cache reuse.
- Cancel threshold-based Pi compaction only while both the filtered epoch estimate and Pi's provider-aware pre-compaction measurement are below the model-relative hard limit (80% by default). If those measurements disagree, the larger provider-aware value wins; threshold and overflow compaction remain available as safety mechanisms.

Token estimates use `characters / 4` and exclude fixed request overhead such as the system prompt, tool schemas, and provider framing. Provider usage remains authoritative for compaction safety.

## Install in Pi

From this repository:

```bash
pi install /path/to/context-window
```

Restart Pi, then inspect it:

```text
/window
/window search refresh token
/window rotate
```

Agent tools:

- `context_window_search` — BM25 search over archived turns and tool output
- `context_recall` — recover an archived document by ID

`context_recall` replaces the former `context_window_recall` name. No compatibility alias is registered, so clients should refresh tool discovery after upgrading.

Use archive tools for prior intent, rationale, exact wording, decisions, rejected approaches, continuity, and scope disputes. Use live inspection for current files, runtime, configuration, tests, and task status. Mentioning old discussion or inviting history lookup does not make archive evidence material when the answer is exclusively current mutable state. For mixed questions, recover archived intent first, inspect live state second, and reconcile conflicts; archived evidence is never proof of current mutable state. Avoid speculative broad archive searches.

For a conceptually phrased historical question without an exact identifier, the agent expands the lexical query with 3–8 concise likely synonyms or domain terms. Exact file names, symbols, errors, commits, PRs, and specific values are searched verbatim and are never broadened. A missed conceptual archive search permits at most one reformulation; a missed well-anchored search routes the agent to live or external evidence instead.

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

`retainTurns` is the normal retention target rather than an unconditional safety floor. Under token pressure, the extension chooses the largest complete-turn suffix that fits the rotation target and may retain fewer groups. If even the newest complete turn cannot fit, the footer reports `native compaction needed` and Pi's threshold/overflow compaction remains enabled. Pi's native percentage/window footer remains authoritative for provider context usage.

## Configuration

Use the `context-window` namespace in Pi's shared settings files:

- Global: `~/.pi/agent/settings.json`
- Project-local: `.pi/settings.json` (loaded only for trusted projects)

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
    "searchResults": 3,
    "searchResultTokens": 1500,
    "preventAutoCompaction": true,
    "statusLabelAccent": true,
    "dbPath": "~/.pi/context-window/archive.db"
  }
}
```

The legacy standalone files `~/.pi/agent/context-window.json` and `.pi/context-window.json` remain supported, so existing configuration does not need to be moved immediately. A missing or non-object `context-window` namespace in shared settings is ignored.

Precedence, from lowest to highest, is: defaults, global legacy, global namespaced, trusted-project legacy, trusted-project namespaced, then valid environment overrides. Project sources always beat global sources. Invalid numeric values fall through to the next valid lower-precedence source. Model profiles merge field by field in the same source order.

Model keys match `provider/model-id`, are case-insensitive, and support `*`. Case-variant redeclarations are the same profile: their fields merge, the later spelling is displayed, and the redeclared profile moves to that later source-order position. An object redeclaration with no valid fields still reorders an existing profile and inherits its valid fields; without an existing profile, it is ignored. The most specific matching pattern wins; equally specific patterns use the later declaration. Profiles can override `rotationContextRatio`, `hardLimitContextRatio`, and `rotationTurns`. The active profile is shown by `/window`.

Legacy `rotationTokens` and `hardLimitTokens` remain supported as explicit safety caps on ratio-derived limits. When Pi does not provide a valid model context window, they fall back to 96K and 128K respectively.

Environment variables use the same values:

```text
CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO
CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO
CONTEXT_WINDOW_ROTATION_TOKENS
CONTEXT_WINDOW_ROTATION_TURNS
CONTEXT_WINDOW_HARD_LIMIT_TOKENS
CONTEXT_WINDOW_RETAIN_TURNS
CONTEXT_WINDOW_MAX_TOOL_RESULT_TOKENS
CONTEXT_WINDOW_SEARCH_RESULTS
CONTEXT_WINDOW_SEARCH_RESULT_TOKENS
CONTEXT_WINDOW_PREVENT_AUTO_COMPACTION
CONTEXT_WINDOW_STATUS_LABEL_ACCENT
CONTEXT_WINDOW_DB
```

## Portable MCP archive

Run:

```bash
node /path/to/context-window/bin/context-window-mcp.js
```

It exposes:

- `context_window_archive`
- `context_window_search`
- `context_recall`
- `context_window_status`

Optional environment:

```text
CONTEXT_WINDOW_PROJECT=/absolute/project/path
CONTEXT_WINDOW_SESSION=session-id
CONTEXT_WINDOW_DB=~/.pi/context-window/archive.db
```

Point any MCP-capable client at that command. This provides shared archival and retrieval, not transparent transcript rotation on hosts without a pre-request message-transform API.

## Cache rationale

A strict sliding window removes the oldest prefix every turn, repeatedly invalidating provider prompt caches. Epoch rotation leaves the prompt append-only for tens of turns and pays one cache reset at rotation. Large tool output is externalized on first exposure so it never becomes part of the provider-cached transcript.

Resuming a Pi session preserves its session ID and deterministically rebuilds the filtered message prefix, but the first resumed request still rotates when either configured threshold is already met. The footer can therefore show fewer than `rotationTurns` while an explicit legacy `rotationTokens` cap triggers a cache-breaking rotation. Remove an obsolete absolute cap to use the model-relative ratio. A miss can also remain unavoidable after the provider's cache TTL expires (Pi treats five minutes as the diagnostic idle threshold) or when the model, system prompt, tool schemas, or epoch boundary changes.

## Safety and limitations

- Interaction groups are cut only at user-message boundaries, keeping assistant tool calls and results together. The epoch layer never splits a turn; a single oversized current turn delegates to Pi's native split-turn compaction.
- The legacy configuration keys use `Turns`; they count user-role messages and remain named that way for backward compatibility.
- A single enormous current turn may still reach native threshold or overflow handling because no safe complete-turn epoch boundary exists. Missing provider usage and measurements at or above the hard limit fail closed by allowing native compaction. After compaction, the extension persists a reset entry so reload cannot resurrect a stale epoch boundary or TOC.
- Fork lineage follows `parentSession` paths from the current Pi session file (including resumed sessions), with the fork event's previous file as a startup fallback. Missing, malformed, oversized, non-session, unsupported-version, or ID-less parent headers contribute no path-derived identity and stop traversal; path cycles and chains beyond 64 ancestors also stop without failing session start. Session-scoped archive queries additionally require the active project when one is available.
- Images and non-text tool-result blocks are retained when text is externalized. Deterministic archive serialization records bounded image metadata (MIME type, decoded byte length, and a short SHA-256 digest) rather than base64 payloads, and token estimation uses Pi's provider-neutral 4,800-character proxy per image. Actual provider usage remains authoritative. Pre-multimodal persisted boundary keys remain restorable. New tool-result archives report their tool call ID/name and the stable key of their one original source message, but remain tool-result documents rather than archived turns.
- Existing databases require no migration. Recall marks genuinely absent older source-key fields as `legacy-unavailable`, while partial, inconsistent, malformed, or non-object metadata receives a distinct provenance status. Archived text remains readable and searchable even when legacy metadata cannot be parsed. Search and recall limits are strict whole-output caps of `max(1, token limit) * 4` characters, including the archived-evidence label, headings, provenance, and truncation marker. Recall renders a concise archive/source summary before deterministic archived text, then adds ordered source keys and extra metadata only from the remaining budget; unusually long provenance therefore truncates before recalled evidence. Pi's structured recall details retain complete provenance regardless of the text cap.
- SQLite and the MCP process are local. No archive content is sent to another service except when retrieved into an agent request.
- BM25 is lexical. Search exact file names, symbols, errors, and decision terms.
- The preserved initial routing eval did not capture response bytes directly; its line-oriented raw responses are explicitly marked as reconstructions. Model eval scores are evidence for those prompts, models, settings, and exposure state—not a guarantee of production behavior.

## Development

```bash
cd /path/to/context-window
npm test
npm run check
```
