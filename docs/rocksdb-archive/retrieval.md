**Contract**

Retrieval and recall are distinct operations:

```text
retrieval = find and score source locations
recall    = materialize exact source around one location
```

Every new user message receives a cheap preflight retrieval. Full recall remains explicit. Model-visible hints are selective, bounded, and persisted. Excerpts are labeled as historical evidence; continuity markers explicitly say they are search prompts rather than evidence.

**Retrieval modes**

| Mode | Trigger | Source |
|---|---|---|
| Exact | Paths, symbols, commits, errors, quoted strings, specific values | Exact postings |
| Lexical | Multi-term historical concept | BM25 postings |
| Structural | Latest question, request, correction, answer, or decision | Reverse relation index |
| Concept continuity | Implicit reuse of a concept from earlier discussion | Exact/BM25 candidate, but only current-message phrases may enter the marker |
| Embedding semantic | Conceptual miss after lexical retrieval | Local, non-LLM embedding index; default-on fallback for explicit `context_window_search` and `context_window_gather`, opted out via the `semanticRetrieval` config/env setting (the internal `store.search` API also accepts a per-call `semanticPolicy` override, not exposed on either tool); never consulted by automatic preflight |

Exact lookup runs before BM25. Exact-looking input must not be decomposed into broad OR terms before the exact lookup has failed.

**Search request**

```json
{
  "query": "REAP_DRAIN",
  "relation": null,
  "scope": "session",
  "limit": 3,
  "excludeVisibleSourceKeys": ["user:..."],
  "hintBudgetTokens": 160
}
```

`relation` and `query` may be combined. Session scope includes verified ancestor lineage and the current project boundary.

**Search result**

```json
{
  "documentId": "tool-abc",
  "version": 1,
  "kind": "tool-result",
  "score": 0.91,
  "matchType": "exact-symbol",
  "margin": 0.28,
  "snippet": "REAP_DRAIN prevents accepting new work...",
  "historical": true,
  "superseded": false,
  "locator": "opaque-signed-or-mac-protected-value",
  "source": {
    "sessionId": "session-123",
    "turnId": "turn-88",
    "messageKey": "toolResult:..."
  }
}
```

The normalized score is meaningful only within a retrieval mode until calibration proves cross-mode comparability. `matchType`, score margin, source scope, and supersession state remain visible to the gate.

**Candidate generation**

1. Preserve exact anchors and tokenize remaining prose.
2. Search newest eligible buckets first.
3. Retrieve the least-common posting lists first and intersect or merge within a bounded work budget.
4. Aggregate term evidence at logical-window level.
5. Deduplicate aliases that point to the same canonical chunks.
6. Exclude source keys already present in the live epoch.
7. Return distinct source locations rather than repeated hits from one document.

BM25 postings store term frequency and positions. Segment metadata stores document count, document lengths, and term document frequencies needed for deterministic scoring.

**Index completeness**

Canonical admission and derived publication have separate success boundaries. A document that exceeds a handler's bounded-work budget remains committed and directly addressable by document ID. The index generation records each handler outcome and is labeled `partial` when a handler omits bounded lower-priority exact matches or another handler is skipped. Exact pressure retains higher-specificity errors, paths, symbols, and quoted values first. BM25 and structural limit failures emit no misleading postings. Automatic preflight treats absent derived evidence as no candidate, so it adds no model-visible context; explicit direct recall remains available.

**Ranking inputs**

- BM25 or structural confidence.
- Exact-anchor bonus.
- Current-session and lineage depth.
- Top-result margin.
- Modest recency preference.
- Already-visible and recently-surfaced suppression.
- Supersession exclusion.
- Evidence-kind policy.

No hidden model call participates in automatic preflight ranking; the embedding semantic mode above is an explicit, disclosed opt-out fallback, not a hidden call.

**Automatic preflight gate**

| Outcome | Model-visible material |
|---|---|
| No useful candidate | Nothing |
| Explicit historical intent with one strong candidate | One short, source-dated JSON-quoted excerpt |
| Implicit recurring concept with strong lexical evidence | One continuity marker containing exact phrases copied from the current message |
| Ambiguous historical match with usable current-message anchors | The same current-message-only marker; no arbitrary archive excerpt |
| Current-only, general knowledge, weak, stale, repeated, or ineligible source | Nothing; candidate text and score remain internal |

Historical cue words route the request; users do not need to say `recall`. A conceptually phrased message can still receive continuity assistance when its current text supplies either a verbatim exact candidate anchor or at least two matched lexical terms with term coverage of 0.60 or greater and maximum normalized IDF of 0.60 or greater. The top-result ambiguity margin is 0.05. These are repository-calibrated thresholds, not copied from another product's scores.

The marker never copies archived candidate text. It repeats only exact spans already present in the current user message and tells the agent to search those phrases before assuming shared meaning. This prevents a merely related archive hit from introducing cold names or jargon that the user did not mention. A full archived excerpt is reserved for explicit historical intent with strong, unambiguous evidence.

**Cache invariant**

A revealed hint is frozen for the user message that caused it:

1. Run preflight once for a stable user-message key.
2. Persist the exact selected hint, query hash, and index generation.
3. Reinsert the same bytes immediately after that user message on every context reconstruction.
4. Include the separating bytes in the persisted hint and its per-message and active-context token counts.
5. Drop the hint when its containing turn rotates out.

Re-running retrieval against a newer index must never change an older provider prefix. A no-result decision may be persisted internally without a model-visible message.
If the first preflight attempt fails, the empty model-visible outcome is frozen locally for that message; a later recovery may not insert new bytes into an already-used prefix.
Automatic hints never expose expiring recall locators. Their search leases are released immediately. Explicit search remains the path for obtaining a locator and performing full recall.

Compaction reset preserves decisions for messages that Pi actually keeps; the next concrete context removes hint records only for user-message keys that left the active path. A crashed session retains its frozen bytes while activity continues; after 30 days without hint activity it is treated as abandoned and reclaimed by bounded maintenance.

**Hint limits**

- At most one automatic candidate per user message.
- Snippet hints target 100 to 200 tokens.
- The defaults allow 160 tokens for one message and 640 tokens across all user-message keys currently active. Rotation removes retired hint bytes and recomputes the same active-context budget; it does not grant a second allowance to messages that remain visible.
- A revealed source is suppressed for 24 hours by default. This exposure record is separate from the active hint record, so rotating the triggering message out does not bypass the cooldown. Verified fork lineage participates in the same suppression check. After the cooldown, bounded maintenance tombstones the exposure record.
- Automatic source-age limits are 7 days for tool payloads and 30 days for conversation or derived evidence. Manual and durable archives are never inserted automatically. Older eligible storage remains available to explicit search until semantic retention removes it.
- Live-context suppression accepts at most 1,000 source identifiers and 1 MiB of identifier text per request; protocol and direct-call paths reject larger inputs before building exclusion sets.
- Without a configured model tokenizer, model-visible accounting uses a deterministic conservative estimator. It upper-bounds the repository lexical tokenizer, charges punctuation and JSON escapes individually, charges CJK and non-ASCII symbols by UTF-8 bytes, and charges opaque identifiers by byte. Per-message, recall, and epoch limits are hard bounds under that estimator rather than UTF-8-bytes-divided-by-four approximations.
- A historical snippet always labels its source as archived historical evidence.
- A historical snippet includes the source date and a current-state verification warning.
- A continuity marker is explicitly labeled as a search prompt, not historical evidence.
- Tool-output text is quoted as data and never presented as instructions.

**Recall request**

```json
{
  "locator": "opaque-versioned-locator",
  "neighbors": 1,
  "maxTokens": 3000,
  "sessionIds": ["current-session", "verified-parent-session"]
}
```

Locators bind document ID, version, logical window, match range, index generation, lease identity, project, session, and the scope used to create them. Agents do not construct offsets manually. A signed project-scoped locator is a capability for clients already authenticated to that project. A signed session-scoped locator also requires the caller's verified session lineage to contain its source session.

**Recall materialization**

| Hit kind | Returned context |
|---|---|
| Turn | Complete containing user and assistant exchange when it fits |
| Tool result | Matching logical window, bounded neighbors, and parent-turn header |
| Structural message | Exact message and containing turn |
| Decision excerpt | Verbatim excerpt and source-turn locator |
| Direct document ID | Full source when small; otherwise a chunk table of contents |

Direct document reads reconstruct source only when it is at most 1 MiB and the
complete serialized result is at most 8 MiB. Larger results return manifest
coordinates for at most 256 physical occurrences and 16 source-message keys;
the daemon does not fetch physical chunk payloads for that response. Internal
version and idempotency decisions use a fixed-size identity digest derived from
the immutable manifest, so they do not require a full-source round trip.

Recall returns continuation locators when adjacent evidence does not fit. It never substitutes a newer version for an expired locator.

Locator recall, exact snippets, BM25 snippets, and coordinate-bearing
structural results read only physical chunks intersecting the selected byte
range. Complete-turn expansion is allowed only for manifests no larger than 64
KiB. Structural postings persist source byte coordinates; legacy postings
without coordinates may use a full-source compatibility lookup only below the
same 64 KiB cap, while larger legacy postings are skipped until derived indexes
are replayed.

New structural preparation resolves relevant annotations in their declared order during one bounded source pass. If any relevant annotation is absent, the handler publishes a durable skipped status and no relation posting, preventing a successful low-level lookup that cannot be materialized by search.

**Recall statuses**

```text
resolved
expired
superseded
missing
locator-invalid
lease-expired
```

Every resolved response includes archive kind, session, creation time, ordered source keys or their documented absence, chunk coordinates, and the historical-staleness label.

**Explicit supersession**

An explicit correction removes the superseded version from exact, lexical, structural, and automatic candidate generation immediately. Existing locators for the old version return `superseded` and never substitute replacement bytes. The replacement remains independently searchable, while the old canonical source stays available for audit until normal storage retention removes it. Similar lexical neighbors without an explicit supersession link remain independent records.

A project may hold at most one live document per explicitly assigned `subjectKey` (`meta/subject-live/...`). Admitting another document with that key requires `supersedes` targeting the current live holder. Epoch rotation does not infer decision identity from shared file names or symbols; use `/window supersede` or `context_window_supersede` when a prior decision is actually reversed.

**Safety boundaries**

- Archived evidence is not proof of current files or runtime state.
- Untrusted archived text is delimited and treated as quoted data.
- Search snippets never contain hidden instructions generated by the retriever.
- Recall always enforces the authenticated project. Session-scoped locators additionally enforce verified lineage; project-scoped locators deliberately authorize recall across sessions within that project.
- Result leases prevent expiry races but do not grant broader scope.

**Verification map**

| Behavior | Executable evidence |
|---|---|
| Marker/snippet classification and exact anchor thresholds | `test/retrieval-continuity-policy.test.js` |
| Active-context budget, 24-hour exposure suppression, source-age limits, frozen bytes | `test/retrieval-hints.test.js` |
| Historical/marker recall and every zero-violation gate | `test/retrieval-eval.test.js`; retrieval artifact `results.hints.scored.metrics` |
| Exact/lexical/structural candidate behavior and visible-key exclusion | `test/retrieval-search.test.js` |
| Locator scope, exact materialization, expiry, and supersession status | `test/retrieval-recall.test.js` |
