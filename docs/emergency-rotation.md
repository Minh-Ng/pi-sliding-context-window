# Emergency epoch rotation policy

## Decision

Use a **hybrid policy**:

1. Keep normal epoch rotation at user-message boundaries and retain the configured
   number of recent user turns when that suffix fits the rotation target.
2. Under token pressure (or an explicit `/window rotate`), progressively retain
   fewer complete user turns, down to one, and choose the largest recent suffix
   that fits the target.
3. Never split a turn in the epoch layer. If one complete current turn cannot fit,
   leave the source context unchanged and allow Pi native threshold/overflow
   compaction to perform its supported split-turn summarization.
4. Provider-aware usage remains authoritative for compaction safety. Missing,
   non-finite, or hard-limit usage never permits threshold-compaction
   cancellation.

This addresses the incident where six large turns could not rotate with
`retainTurns: 10`, while avoiding protocol-invalid mid-turn epoch boundaries.

## Trigger precedence

`EpochWindowSession.process()` plans a rotation when any current trigger is true:

1. explicit `forceRotation`;
2. the filtered epoch estimate is at or above `rotationTokens`; or
3. user turns are at or above `rotationTurns`.

The planner receives the already boundary-sliced and large-tool-result-externalized
messages. It does not consume provider telemetry because the `context` event runs
before the next provider response.

The Pi `session_before_compact` gate is separate:

- manual and overflow compaction are never cancelled;
- threshold compaction is cancelled only when both the filtered epoch estimate and
  the maximum finite Pi measurement (`preparation.tokensBefore` and
  `ctx.getContextUsage().tokens`) are below `hardLimitTokens`;
- absent or stale provider-aware usage fails closed by allowing native compaction;
- observed usage at or above the hard limit is never deferred to a future epoch
  rotation.

## Boundary algorithm

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
  return native-compaction-fallback(no-user-boundary)

for candidate in candidates from oldest to newest:
  retainedTurns = number of user turns at/after candidate
  suffixTokens = estimate(active[candidate..]) + TOC_TOKEN_BUDGET
  if retainedTurns <= retainTurns and suffixTokens <= rotationTokens:
    mode = retainedTurns == min(retainTurns, totalTurns)
      ? normal
      : emergency-retention
    return earliest such candidate  // maximize retained recent context

return native-compaction-fallback(oversized-latest-turn)
```

The planner may additionally report the newest legal candidate and its estimated
size for diagnostics, but `process()` must not apply a boundary that exceeds the
rotation target. `hardLimitTokens` is diagnostic/fallback context, not permission
for an immediate over-target provider request.

## Minimum retained context and tool integrity

- Retain at least one complete user turn.
- Epoch boundaries are **only** user-message boundaries.
- Assistant tool calls and all following tool results remain in the same retained
  or archived user group.
- A leading sequence of `bashExecution`, `compactionSummary`, or `branchSummary`
  messages remains a preamble and is archived with the removed prefix.
- The epoch layer never cuts at assistant or tool-result messages.
- A single oversized current turn delegates to Pi native compaction; Pi's summary
  is the semantic bridge for its own supported split-turn cut.

## Archive, TOC, and persistence semantics

Emergency rotation uses the existing exact-source archival path:

- archive documents remain `turn` or `preamble`;
- ordered full source message keys, first/last keys, and counts are unchanged;
- decision candidates continue to point at their source turn;
- TOC entries and marker text use the same deterministic format and limits;
- the persisted boundary remains the first retained source message key.

Rotation state gains additive diagnostic fields:

- `reason`: `forced`, `tokens`, or `turns`;
- `mode`: `normal` or `emergency-retention`;
- `configuredRetainTurns`;
- `effectiveRetainTurns`.

Older state without these fields restores normally. Restore must sanitize optional
fields and must never use them to grant lineage access.

## Cache behavior

Normal and emergency rotation each cause one deliberate prefix-cache break.
Choosing the earliest fitting candidate maximizes retained recent context and
therefore avoids a more aggressive cache reset than necessary. Between rotations,
the persisted boundary and TOC marker remain byte-stable. Native compaction is a
separate unavoidable cache break when no complete-turn epoch suffix fits.

## Fallback behavior

Return a fallback without changing archive or persisted state when:

- there is no user boundary after the active start;
- only one user turn exists;
- even the newest complete user turn plus marker reserve exceeds
  `rotationTokens`; or
- candidate planning encounters malformed input and cannot prove a legal cut.

The adapter must then allow native threshold/overflow compaction. It must not
cancel, retry, or claim an epoch rotation occurred. `/window rotate` may clear its
one-shot force flag after a proven fallback; the normal token trigger will be
re-evaluated on each request.

## Configuration compatibility

- `retainTurns` remains the normal retention target, not an unconditional safety
  floor.
- Emergency reduction is automatic only after a rotation trigger.
- No new required configuration key is introduced.
- Status/details should expose emergency mode and effective retained turns when it
  occurs, so reducing below configuration is auditable.
- Existing absolute/model-relative token limits retain their current precedence.

## Explicit non-goals

- No epoch-layer mid-turn summarization.
- No provider-specific image or tokenizer implementation.
- No replacement of Pi manual or overflow compaction.
- No guarantee that character estimates include fixed provider overhead; the
  provider-aware compaction gate remains the backstop.
- No transactional redesign of SQLite archive writes and Pi custom-state appends
  in this change.

## Test matrix

| Scenario | Expected plan/result |
| --- | --- |
| Below every trigger | no-op |
| More than `retainTurns`, configured suffix fits | normal boundary retaining exactly configured turns |
| Fewer than `retainTurns`, latest 3/2/1 turns fit | emergency boundary retaining the largest fitting suffix |
| Configured suffix too large but fewer turns fit | emergency boundary, earliest fitting candidate |
| One user turn | native fallback, no boundary/state/archive mutation |
| Latest complete turn exceeds target | native fallback |
| Leading synthetic preamble plus several turns | preamble archived; retained boundary is a user |
| Assistant tool call and tool results around candidate | entire group stays on one side of user boundary |
| Exact target equality including marker reserve | candidate fits |
| One token above target | try next candidate or fallback |
| Forced rotation below configured floor | emergency complete-turn boundary if one fits |
| Missing/non-finite provider usage | native threshold compaction allowed |
| Provider usage at/above hard limit with low epoch estimate | native compaction allowed |
| Reload/fork/tree after emergency rotation | same boundary, marker, provenance, and effective-retention diagnostics |
| Reprocessing identical messages | no duplicate rotation/archive writes |
