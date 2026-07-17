**Emergency epoch rotation policy**

**Decision**

Use a **hybrid policy**:

1. Keep normal epoch rotation at user-message boundaries and retain the configured
   number of recent user turns when that suffix fits the rotation target.
2. Under token pressure (or an explicit `/window rotate`), progressively retain
   fewer complete user turns, down to one, and choose the largest recent suffix
   that fits the target.
3. Never split a turn at an epoch boundary. A user message above
   `maxInlineUserTokens` is checkpointed before provider dispatch and only its
   provider-facing copy becomes a bounded head/tail preview. When a complete
   turn exceeds the rotation target for another reason, the epoch planner leaves
   it unchanged and marks a compaction fallback; if Pi invokes compaction, that
   hook checkpoints the exact span and returns a bounded custom catalog.
4. Provider-aware usage remains authoritative for compaction safety. Missing,
   non-finite, or hard-limit usage never permits threshold-compaction
   cancellation.

This addresses the incident where six large turns could not rotate with
`retainTurns: 10`, while avoiding protocol-invalid mid-turn epoch boundaries.

**Trigger precedence**

`EpochWindowSession.process()` plans a rotation when any current trigger is true:

1. explicit `forceRotation`;
2. the filtered epoch estimate is at or above `rotationTokens`; or
3. user turns are at or above `rotationTurns`.

The planner receives the already boundary-sliced and large-tool-result-externalized
messages. It does not consume provider telemetry because the `context` event runs
before the next provider response.

The Pi `session_before_compact` gate is separate:

- before threshold, overflow, or manual compaction proceeds, archive every exact
  source in `preparation.messagesToSummarize`, any split-turn prefix, and any
  previous summary not already covered by a trusted extension catalog;
- preflight the bounded preview, all-root catalog, roots, and publication
  manifest before writing; write every content-addressed part for every source,
  then every staged root, and publish one complete all-root marker last;
- cancel compaction when any part, root, or all-root publication write fails or
  returns an ambiguous result; an uncheckpointed source must not reach Pi's
  native summarizer;
- threshold compaction is cancelled only when both Pi measurements
  (`preparation.tokensBefore` and `ctx.getContextUsage().tokens`) are present,
  finite, and non-negative, the filtered epoch estimate is below
  `hardLimitTokens`, and the larger Pi measurement is below `rotationTokens`;
- absent or stale provider-aware usage fails closed by advancing to the mandatory
  archive-first checkpoint instead of cancelling compaction as unnecessary;
- observed usage at or above the hard limit is never deferred to a future epoch
  rotation.

**Boundary algorithm**

Inputs:

- active source messages after the current persisted boundary;
- `retainTurns`;
- `rotationTokens` and `hardLimitTokens`;
- trigger reason (`forced`, `tokens`, or `turns`);
- a conservative marker reserve of `TOC_TOKEN_BUDGET`.

Legal candidates are starts of existing `role: "user"` turns with an index greater
than zero. A candidate always archives the exact prefix before that user and keeps
that user plus every following assistant/tool message unchanged.

Pseudocode:

```text
if no trigger:
  return no-op

turns = complete user turns in active messages
candidates = starts of turns after index 0
if candidates is empty:
  return archive-first-compaction-fallback(no-user-boundary)

for candidate in candidates from oldest to newest:
  retainedTurns = number of user turns at/after candidate
  suffixTokens = estimate(active[candidate..]) + TOC_TOKEN_BUDGET
  if retainedTurns <= retainTurns and suffixTokens <= rotationTokens:
    mode = retainedTurns == min(retainTurns, totalTurns)
      ? normal
      : emergency-retention
    return earliest such candidate  // maximize retained recent context

return archive-first-compaction-fallback(oversized-latest-turn)
```

The planner may additionally report the newest legal candidate and its estimated
size for diagnostics, but `process()` must not apply a boundary that exceeds the
rotation target. `hardLimitTokens` is diagnostic/fallback context, not permission
for an immediate over-target provider request.

**Minimum retained context and tool integrity**

- Retain at least one complete user turn.
- Epoch boundaries are **only** user-message boundaries.
- Assistant tool calls and all following tool results remain in the same retained
  or archived user group.
- A leading sequence of `bashExecution`, `compactionSummary`, or `branchSummary`
  messages remains a preamble and is archived with the removed prefix.
- The epoch layer never cuts at assistant or tool-result messages.
- A current user message above `maxInlineUserTokens` is represented to the
  provider by a bounded deterministic preview after its exact source root is
  published.
- A complete turn that exceeds the rotation target while its user input remains
  below the inline limit stays unchanged in `process()`. The planner records a
  compaction fallback without mutating the epoch; the later Pi compaction hook
  checkpoints the exact summarized span before returning a custom catalog.

**Archive, TOC, and persistence semantics**

Emergency rotation uses the existing exact-source archival path:

- archive documents remain `turn` or `preamble`;
- ordered full source message keys, first/last keys, and counts are unchanged;
- decision candidates continue to point at their source turn;
- TOC entries and marker text use the same deterministic format and limits;
- the persisted boundary remains the first retained source message key.

Oversized admission and compaction checkpoints add a fail-closed publication
layer:

- exact UTF-8 source is split only at scalar boundaries into content-addressed
  parts no larger than the store's per-document limit;
- bounded preview and catalog rendering is proven before the first write, all
  parts across the checkpoint are written idempotently before any staged root,
  and one content-addressed all-root publication marker is written last;
- retrying the same scoped source produces the same part and root IDs without a
  second logical document, even when the retry observes a different wall-clock
  timestamp;
- the root records ordered part IDs, byte ranges, the complete byte count, and
  the complete SHA-256 hash, so exact recall can verify reassembly after restart;
- provider previews contain at most 800 tokens of deterministic head and tail
  excerpts only; catalogs contain root IDs, topics, salient terms, byte counts,
  and hashes only, and topic/term text must come from the exact source ranges
  visible at that caller's effective preview budget; lowering the preview budget
  cannot disclose a newly excluded term through the catalog;
- a compaction catalog is at most 1,000 model-visible tokens and never includes
  raw middle content.

The complete all-root marker is the usability boundary. Orphaned parts and staged
roots from an interrupted attempt are harmless and may be reused by a retry;
exact reconstruction rejects a root whose complete publication marker is absent.
No caller may report checkpoint success, return a preview, or proceed with
compaction until that final marker write is confirmed.

Rotation state gains additive diagnostic fields:

- `reason`: `forced`, `tokens`, or `turns`;
- `mode`: `normal` or `emergency-retention`;
- `configuredRetainTurns`;
- `effectiveRetainTurns`.

Older state without these fields restores normally. Restore must sanitize optional
fields and must never use them to grant lineage access.

**Cache behavior**

Normal and emergency rotation each cause one deliberate prefix-cache break.
Choosing the earliest fitting candidate maximizes retained recent context and
therefore avoids a more aggressive cache reset than necessary. Between rotations,
the persisted boundary and TOC marker remain byte-stable. Archive-first custom
compaction is a separate unavoidable cache break when no complete-turn epoch
suffix fits.

**Fallback behavior**

Return a fallback without changing epoch boundary or persisted rotation state when:

- there is no user boundary after the active start;
- only one user turn exists;
- even the newest complete user turn plus marker reserve exceeds
  `rotationTokens`; or
- candidate planning encounters malformed input and cannot prove a legal cut.

For a token- or turn-triggered fallback, the epoch adapter records the fallback
but does not itself start compaction or change the provider copy. It must not
claim an epoch rotation occurred. A forced `/window rotate` with no legal
boundary instead clears the one-shot force flag and fallback reason without
publishing fallback status; it also leaves the provider copy unchanged. If Pi
later emits a threshold, overflow, or manual compaction event, the compaction
hook must checkpoint the exact summarized span before returning a bounded custom
result, and must cancel that compaction if checkpointing fails. Separately, an
oversized user-admission checkpoint failure aborts the turn before raw source can
reach a provider. The normal token trigger is re-evaluated on each request.

**Configuration compatibility**

- `retainTurns` remains the normal retention target, not an unconditional safety
  floor.
- Emergency reduction is automatic only after a rotation trigger.
- No new required configuration key is introduced.
- Status/details should expose emergency mode and effective retained turns when it
  occurs, so reducing below configuration is auditable.
- Existing absolute/model-relative token limits retain their current precedence.

**Explicit non-goals**

- No lossy epoch-layer summary; previews and catalogs remain pointers to exact
  archived sources.
- No provider-specific image or tokenizer implementation.
- No native Pi summarization over uncheckpointed raw source, including manual or
  overflow compaction.
- No guarantee that character estimates include fixed provider overhead; the
  provider-aware compaction gate remains the backstop.
- No cross-store transaction between archive publication and Pi custom-state
  appends; a durable root is the commit point and retries are content-addressed.

**Test matrix**

| Scenario | Expected plan/result |
| --- | --- |
| Below every trigger | no-op |
| More than `retainTurns`, configured suffix fits | normal boundary retaining exactly configured turns |
| Fewer than `retainTurns`, latest 3/2/1 turns fit | emergency boundary retaining the largest fitting suffix |
| Configured suffix too large but fewer turns fit | emergency boundary, earliest fitting candidate |
| Token/turn trigger with one user turn below inline limit | unchanged provider copy and compaction-fallback status; no epoch/archive mutation |
| Token/turn trigger where latest complete turn exceeds target while user input is below inline limit | unchanged provider copy and compaction-fallback status; later Pi compaction checkpoints exact span |
| Forced rotation with no legal user boundary | unchanged provider copy; force flag and fallback reason cleared; no fallback status |
| User input exceeds inline limit | exact checkpoint before accounting; bounded provider preview; original transcript unchanged |
| Leading synthetic preamble plus several turns | preamble archived; retained boundary is a user |
| Assistant tool call and tool results around candidate | entire group stays on one side of user boundary |
| Exact target equality including marker reserve | candidate fits |
| One token above target | try next candidate or fallback |
| Forced rotation below configured floor | emergency complete-turn boundary if one fits |
| Missing/non-finite provider usage | compaction allowed only after exact checkpoint and bounded custom catalog |
| Provider usage at/above rotation limit with low epoch estimate | compaction allowed only after exact checkpoint and bounded custom catalog |
| Manual or overflow compaction | exact summarized span checkpointed before bounded custom result |
| Previous summary without a trusted extension catalog | previous summary archived as a separate exact source |
| Part, root, or publication failure during Pi compaction | no custom result; compaction cancelled without aborting the current turn |
| Part, root, or publication failure during oversized-user admission | no provider preview; current turn aborted before raw input reaches the provider |
| Later source or publication write failure | earlier staged roots remain unusable without the all-root marker |
| Preview or catalog cannot fit its hard bound | failure before the first archive write |
| Retry after partial part writes | same IDs; existing parts reused; all-root marker published only after every source succeeds |
| Retry at a later wall-clock time | same part, root, and publication IDs; no duplicate logical document |
| Multibyte source crossing a part boundary | exact byte-for-byte, hash-verified reassembly after restart |
| Middle sentinel in oversized source | absent from provider preview and compaction catalog |
| Middle sentinel supplied as topic | ignored unless it also occurs in a preview-visible excerpt |
| Smaller caller preview budget | catalog topic and terms are recomputed from only the smaller visible source ranges |
| Caller requests a larger preview | preview remains capped at 800 model-visible tokens |
| Reload/fork/tree after emergency rotation | same boundary, marker, provenance, and effective-retention diagnostics |
| Reprocessing identical messages | no duplicate rotation/archive writes |
