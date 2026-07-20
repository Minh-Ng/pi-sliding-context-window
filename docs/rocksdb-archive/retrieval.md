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
| Cross-encoder rerank | Reorders the already-fused lexical/semantic tier | Local cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, pinned revision); default-on refinement for explicit `context_window_search` and `context_window_gather` once installed (`context-window-semantic install-reranker`), opted out via the `rerankerEnabled` config/env setting; never consulted by automatic preflight |

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

A relevance band travels alongside the presented score in rendered search and gather output (`>=0.8` high, `0.5–0.8` moderate, `0.2–0.5` some, `<0.2` low), computed from that same per-mode calibrated score. It is a stopping-criterion contract: an agent reading `low` on every remaining result knows to stop recalling rather than parsing the raw float. Chronological before/after gather neighbors carry no score or band — they are context, not a ranked hit.

Cross-mode fusion keeps a hard priority tier (exact above structural above lexical/semantic); ordering *within* the lexical/semantic tier uses Reciprocal Rank Fusion over each mode's own rank order rather than comparing BM25's squashed score against embedding cosine similarity directly — the two curves are not calibrated against each other. A candidate found by more than one mode in that tier accumulates rank credit from each. The RRF component blends with the candidate's own normalized score, weighted 75% toward the rank fusion near the head of each mode's ranking (top 3), 60% in the next stretch (4–10), and 40% beyond — trusting rank order most where it is most reliable. This never changes the presented `score`, and it never moves a candidate across the exact/structural/lexical priority boundary.

RRF's cross-mode credit is most useful when semantic search actually runs alongside lexical rather than only rescuing a weak lexical miss. Explicit `context_window_search`'s default `semanticPolicy` stays `auto` (rescue-only) rather than switching to hybrid-always: that default is an already-documented, tested behavior (this file's semantic-mode row; `test/semantic.test.js`), and flipping it changes result composition and latency for every explicit search, which wants its own evaluation evidence rather than riding in on a fusion-ordering change. `context_window_gather` already runs `semanticPolicy: "always"` unconditionally, so gather's fused evidence already benefits from this tier today.

A local cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`, pinned revision, `q8`/CPU — the exact configuration an offline eval measured against a rank-sensitive hard-case corpus, `eval/retrieval/reranker-verdict.json`) re-scores the fused lexical/semantic tier for explicit `context_window_search` and `context_window_gather` only, after the importance prior and before near-duplicate collapsing. It sends the fused top 40 lexical/semantic candidates (matching the eval's own candidate window), each truncated to roughly 256 model-visible tokens centered on its own match-centered snippet, and reorders that tier by the model's (query, candidate) relevance score. It never crosses the exact/structural priority boundary — an exact or structural result keeps its position regardless of how the reranker scores anything — and it never changes the presented `score`, only the order. A reordered result carries `reranked: true` (and, in gather's anchor evidence, the same field) so `/window search`-style explanations can say a result was reranked, mirroring the RM3 `expandedTerms` provenance pattern. Automatic preflight never sets the internal `reranker` option, so it can never reach this path regardless of how weak its evidence looks; and like the embedding semantic mode, the reranker degrades silently to the pre-rerank fused order whenever the pinned model is not installed or the worker fails for any reason — reranking is a ranking refinement, never a source of search failure. Opt out with the `rerankerEnabled` config/env setting; `rerankerModel`/`rerankerModelRevision`/`rerankerModelCachePath`/`rerankerCandidates` override the pinned model, its cache location, and the reranked candidate-window size. Install the pinned model once with `context-window-semantic install-reranker` — the only path permitted to download it.

**Candidate generation**

1. Preserve exact anchors and tokenize remaining prose.
2. Search newest eligible buckets first.
3. Retrieve the least-common posting lists first and intersect or merge within a bounded work budget.
4. Aggregate term evidence at logical-window level.
5. Deduplicate aliases that point to the same canonical chunks.
6. Exclude source keys already present in the live epoch.
7. Return distinct source locations rather than repeated hits from one document.

BM25 postings store term frequency and positions. Segment metadata stores document count, document lengths, and term document frequencies needed for deterministic scoring. Term frequency and document length are BM25F-weighted at index time: user text outweighs assistant prose, which outweighs tool output, and question/request/correction/answer-scored spans plus whole decision-candidate documents get a boosted title-like weight; a document with no resolvable message-role structure scores exactly as the unweighted formula would. Field weighting is deterministic and index-time only, derived solely from each document's own `structuralMessages` and kind.

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
- Document importance prior (explicit search only).
- Cross-encoder rerank of the lexical/semantic tier (explicit search/gather only).

No hidden model call participates in automatic preflight ranking; the embedding semantic mode and the cross-encoder reranker above are explicit, disclosed opt-out fallbacks limited to explicit search/gather, never hidden calls, and never reachable from automatic preflight.

The document importance prior is a query-independent multiplier derived per document by the `importance-v1` index handler and stored in the versioned `importance` namespace. Three of its four signals are intrinsic to canonical, immutable state and so replay deterministically from canonical records alone: decision-candidate presence, admission pin, and a referenced-by count combining provenance breadth (source message count) with explicit supersession-chain depth (walked through `manifest.supersedes` lineage). The fourth, a recalled-after-search tally sourced from the local relevance-feedback log, is a deliberate exception: a document is indexed exactly once, at admission, before any recall of it could have happened, so the value the index handler stores for this signal is always 0. Ranking never reads that stale stored value — at query time it re-reads the durable per-document recall counter live instead, so the signal reflects local search usage as of the moment of the query rather than as of admission. That live read is computationally deterministic (no randomness or model calls) but not a pure function of the document's manifest alone. It multiplies the normalized relevance score, capped at 1.15x, so it can reorder near-ties but never overrule a strong relevance gap. It is applied to explicit search and gather ranking only; the automatic preflight path does not apply it, keeping frozen-hint decisions byte-identical.

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
| RM3/Bo1 expansion gating (weak-evidence-only, exact/strong-lexical/policy suppression, never on preflight) and expanded-term provenance | `test/retrieval-search.test.js` |
| RRF tier fusion (rank-order preservation, cross-mode rank credit, priority-tier boundary) | `test/retrieval-search.test.js` |
| Cross-encoder rerank (lexical/semantic tier reorder, candidate-window cap, silent degrade when unavailable, exact/structural precedence preserved, never reachable from automatic preflight) | `test/reranker.test.js`; `test/retrieval-search.test.js`; `test/relevance-feedback.test.js` |
| Relevance-band thresholds and their rendering in search/gather output | `test/presentation.test.js` |
| Anchor-only relevance score/mode propagation through gather | `test/retrieval-gather.test.js`; `test/daemon-archive.test.js` |
| Locator scope, exact materialization, expiry, and supersession status | `test/retrieval-recall.test.js` |
