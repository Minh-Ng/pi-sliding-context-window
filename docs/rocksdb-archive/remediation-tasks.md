**Purpose**

This backlog closes the remaining oversized-input, compaction, stale-retrieval,
false-retrieval, and prompt-budget gaps. Every half owns at most five writable
files. Semantic guides are read-only inputs and do not expand write ownership.

**Corrected automatic-retrieval rule**

Every user message still receives a cheap retrieval preflight. The user does
not need to say "recall," "earlier," or another historical cue.

Automatic retrieval has three outcomes:

- `historical-snippet`: an explicit request for prior wording, rationale, or a
  decision receives one bounded archived excerpt.
- `continuity-marker`: a strong match to a previously discussed concept
  receives fixed guidance plus verbatim anchors copied from the current user
  message. It contains no candidate excerpt, archive-only term, document ID, or
  locator. The agent searches that anchor when prior meaning affects its answer.
- `suppress`: weak, stale, current-state-only, general-knowledge, ambiguous
  snippet, or budget-exceeding evidence adds no model-visible text.

This lets an implicit continuation such as "could tablets help here?" recover a
prior tablet discussion without injecting adjacent archive jargon that the user
did not use. Explicit historical questions can still receive exact evidence.

**Agent contract**

- Modify only the listed writable files. Stop and hand off before touching an
  unlisted file.
- Read the listed semantic guides before coding. Do not edit them unless the
  packet explicitly owns them.
- Preserve unrelated worktree changes. Do not normalize or reformat adjacent
  code.
- Report changed files, contract changes, verifier commands and results,
  artifacts, known limitations, and downstream notes.
- A different agent reviews each half against its listed files and acceptance
  conditions. The reviewer is read-only and returns `PASS` or findings with an
  exact file, line, and triggering sequence.

**Semantic guides**

- Retrieval behavior: `docs/rocksdb-archive/retrieval.md`
- Logical expiry and physical compaction: `docs/rocksdb-archive/retention.md`
- Evaluation and sanitized evidence: `docs/rocksdb-archive/evaluation.md`
- Storage and daemon boundaries: `docs/rocksdb-archive/architecture.md`
- Pi rotation behavior: `docs/emergency-rotation.md` (5A owns the normative
  archive-first update before session or Pi integration begins)

**Dependency waves**

| Wave | Parallel halves | Required handoff |
|---|---|---|
| 1 | 1A, 2A, 4A, 5A | None |
| 2 | 1B, 2B | 1A and 2A as applicable |
| 3 | 3A, 7A | 1B and 2B; 7A follows the 1B contract owner |
| 4 | 3B, 7B | 3A and 7A; 7B follows the 2B search owner |
| 5 | 5B | 3B and 5A; same `src/epoch-window.js` owner |
| 6 | 6A | 5B |
| 7 | 6B, 4B | 6A; 4B also requires 3B and 7B |
| 8 | 8A | All behavior is passing |
| 9 | 8B | 6B, 4B, and 8A |

Shared files are deliberately serialized: `src/store-contract.js` is owned in
order by 1B then 7A; `src/retrieval/search.js` by 2B then 7B; and
`src/epoch-window.js` by 3B then 5B. Those halves must not run concurrently.

**Task 1 — Policy and protocol**

**1A — Defaults and configuration**

Writable files (5):

- `src/config.js`
- `src/daemon/retention-policy.js`
- `test/config.test.js`
- `test/daemon-maintenance.test.js`
- `test/migration.test.js`

Mechanical work:

- Set storage defaults to 14 days for tool payloads, 90 days for conversation
  sources, and 30 days for derived evidence. Durable manual evidence remains
  unexpired.
- Add automatic-eligibility defaults of 7 days for tool payloads and 30 days
  for conversation and derived evidence. Durable manual evidence is never
  automatic.
- Add `maxInlineUserTokens: 16000`, `activeHintBudgetTokens: 640`, and a
  24-hour source-exposure cooldown, with environment and settings precedence.
- Keep the legacy epoch-budget setting as a documented compatibility alias;
  one resolved active budget must win deterministically.

Acceptance:

- Defaults, global/project/env precedence, zero-day behavior, invalid values,
  and the compatibility alias are exact-value tests.
- Migration expiry expectations use the new storage defaults; migration bytes
  and identities do not change.

Verifier:

```text
node --test test/config.test.js test/daemon-maintenance.test.js test/migration.test.js
npx tsc --noEmit
```

**1B — Search and preflight wire contract**

Writable files (4):

- `src/store-contract.js`
- `src/daemon-archive.js`
- `test/store-contract.test.js`
- `test/daemon-archive.test.js`

Mechanical work:

- Carry typed `createdAt`, retrieval mode, raw score, calibrated score, score
  margin, matched anchors or terms, term coverage, and maximum normalized IDF.
- Add the preflight limits required by 1A and a bounded list of active user
  message keys used for total-context accounting.
- Add disclosure type `historical-snippet | continuity-marker` to visible
  hints. Keep locators out of automatic hints.
- Reject unknown fields, oversized active-key lists, negative durations, and
  malformed evidence before daemon work begins.

Acceptance:

- Request and response round trips preserve every field exactly.
- Direct callers and daemon clients reject the same malformed payloads.

Verifier:

```text
node --test test/store-contract.test.js test/daemon-archive.test.js
```

**Task 2 — Retrieval evidence and continuity decision**

**2A — Index evidence**

Writable files (4):

- `src/rocksdb/index/exact.js`
- `src/rocksdb/index/bm25.js`
- `test/rocksdb-exact.test.js`
- `test/rocksdb-bm25.test.js`

Mechanical work:

- Expose source creation time and exact matched anchors from exact results.
- Expose raw BM25 score, matched terms, query-term coverage, per-term IDF, and
  maximum normalized IDF from lexical results.
- Do not change posting order, storage keys, or current explicit-search rank in
  this half.

Acceptance:

- Evidence recomputes from the stored score explanation.
- Single common-word, two distinctive-term, exact case-sensitive, and folded
  exact cases have fixed expected evidence.

Verifier:

```text
node --test test/rocksdb-exact.test.js test/rocksdb-bm25.test.js
```

**2B — Fixed calibration and pure continuity policy**

Writable files (4):

- `src/retrieval/search.js`
- `src/retrieval/continuity-policy.js` (new)
- `test/retrieval-search.test.js`
- `test/retrieval-continuity-policy.test.js` (new)

Mechanical work:

- Stop normalizing the top lexical result to `1.0`. Use a fixed deterministic
  calibration whose value does not change when weaker candidates are added.
- Preserve raw score, coverage, margin, age, and match evidence through fusion.
- Implement `historical-snippet`, `continuity-marker`, and `suppress` with
  stable reason codes.
- Permit implicit continuity for an eligible conversation source with either a
  verbatim exact anchor from the current message, or at least two lexical terms
  in one window with coverage at least `0.60` and maximum normalized IDF at
  least `0.60`.
- A continuity marker may survive candidate ambiguity because it asserts only
  that shared history exists. A historical snippet may not.
- Enforce the marker invariant: every dynamic marker substring is an exact span
  of the current user message. Candidate text, neighboring terms, IDs, paths,
  and locators are forbidden.

Acceptance:

- A weak top lexical hit does not become strong merely by ranking first.
- A recurring concept without historical wording returns a marker.
- `coldNeighborTerm` present only in the candidate is absent from the marker.
- Current-state-only and general-knowledge messages suppress automatic history.

Verifier:

```text
node --test test/retrieval-search.test.js test/retrieval-continuity-policy.test.js
```

**Task 3 — Preflight state and one prompt budget**

**3A — Selection, exposure ledger, and hard budget**

Writable files (3):

- `src/retrieval/preflight.js`
- `src/retrieval/hints.js`
- `test/retrieval-hints.test.js`

Mechanical work:

- Run the 2B policy on every new user message; explicit historical wording is a
  positive signal, not a prerequisite.
- Apply kind-specific automatic age limits before rendering anything.
- Render snippets with a compact source date. Render markers only from fixed
  text and current-message anchors.
- Replace per-epoch accounting with a hard sum of frozen hints belonging to all
  active user message keys. Existing frozen bytes remain stable.
- Persist source exposure independently from hint records for 24 hours, so turn
  rotation or hint deletion cannot immediately resurface the same source.
- Release candidate leases after the decision and add no model-visible text on
  failure.

Acceptance:

- Implicit concept continuation reveals one marker without "recall."
- Old, weak, current-only, general, duplicate-source, and over-budget cases
  reveal zero bytes.
- Frozen output is byte-identical on reconstruction, and the same source stays
  suppressed after its original turn rotates out.
- Retained frozen hints count against the active budget after epoch rotation.

Verifier:

```text
node --test test/retrieval-hints.test.js
```

**3B — Active-context integration**

Writable files (2):

- `src/epoch-window.js`
- `test/epoch-window.test.js`

Mechanical work:

- Send all active user message keys and resolved policy values to preflight.
- Preserve frozen marker and snippet bytes at the same user-message position.
- Keep the total hint budget hard across ordinary processing, epoch rotation,
  reload, fork lineage, and compaction reset.
- Never preflight a source already visible in the provider context.

Acceptance:

- Rotation cannot create a second budget allowance.
- Reload and fork reconstruct the same bytes.
- Preflight failure leaves every live message untouched and freezes an empty
  decision for the already-used prefix.

Verifier:

```text
node --test test/epoch-window.test.js
```

**Task 4 — Agent behavior and adversarial evaluation**

**4A — Continuity-marker behavior**

Writable files (3):

- `src/evidence-routing.js`
- `eval/evidence-routing/evidence-routing-eval.js`
- `test/evidence-routing.test.js`

Mechanical work:

- Require an exact-anchor archive search when a continuity marker is present
  and prior meaning is material to the answer.
- Treat a marker as evidence of prior discussion, not evidence that a specific
  archived assertion remains true.
- Require archive-only terminology to be omitted or introduced with a plain
  definition and provenance. It must never be used as already-shared jargon.
- Preserve live-tool authority for mutable current state.

Acceptance:

- Paired cases differ only by marker presence and route as annotated.
- A response cannot pass if it uses an archive-only test term as familiar
  vocabulary without definition and provenance.
- Historical recorded evaluation JSON is not modified.

Verifier:

```text
node --test test/evidence-routing.test.js
```

**4B — Retrieval hard-negative gate**

Writable files (4):

- `eval/retrieval/fixtures.js`
- `eval/retrieval/schema.js`
- `eval/retrieval/scoring.js`
- `test/retrieval-eval.test.js`

Mechanical work:

- Add implicit-continuity positives plus stale-source, weak-BM25, common-word,
  incidental-exact, correction, ambiguous-snippet, cross-rotation budget, and
  repeated-source negatives.
- Add metrics for continuity-marker recall, stale reveal count, active-budget
  violations, and candidate-only term leakage.
- Freeze the reviewed fixture fingerprint only after annotations are approved.

Acceptance:

- Continuity-marker recall is at least `0.90`.
- Candidate-only term leakage, stale reveals, active-budget violations, and
  unsafe archived-tool hints are all zero.
- Existing exact, lexical, structural, chunk, and frozen-byte gates do not
  regress.

Verifier:

```text
node --test test/retrieval-eval.test.js
npm run eval:hints
```

**Task 5 — Oversized user admission**

**5A — Archive-first policy, exact archive, and bounded catalog primitive**

Writable files (3):

- `docs/emergency-rotation.md`
- `src/archive-checkpoint.js` (new)
- `test/archive-checkpoint.test.js` (new)

Mechanical work:

- Replace the guide's native-only oversized-turn fallback and manual/overflow
  non-goals with the archive-first custom-compaction contract. Preserve its
  complete-turn rotation, measurement, cache, and provenance invariants, and
  update its test matrix before integration work consumes the guide.
- Implement content-addressed, idempotent exact archival with UTF-8-safe parts
  no larger than the store contract's per-document byte limit.
- Write every part before a bounded root manifest becomes usable.
- Produce a deterministic head/tail user preview and a deterministic
  compaction catalog no larger than 1,000 tokens. Catalog entries contain root
  IDs, topic, salient terms, byte count, and hash, but no raw middle content.
- Archive `preparation.previousSummary` as a separate source when no trusted
  extension catalog already covers it.
- Return no success root or catalog if any archive write throws or returns a
  falsy result.

Acceptance:

- The guide explicitly requires checkpoint-before-compaction and fail-closed
  cancellation, and no remaining section requires native summarization of raw
  oversized content.
- Multibyte content reassembles byte-for-byte and hash-for-hash after restart.
- Retry returns the same IDs and creates no duplicate logical document.
- An injected middle sentinel is absent from preview and catalog.
- Injected failure produces no usable root manifest.

Verifier:

```text
node --test test/archive-checkpoint.test.js
```

**5B — Session admission and compaction checkpoint**

Writable files (2):

- `src/epoch-window.js`
- `test/epoch-window.test.js`

Mechanical work:

- Before rotation accounting, archive a user message over
  `maxInlineUserTokens` from the original message and replace only the provider
  copy with the 5A preview. Preserve non-text blocks and source message keys.
- Protect every root and part ID, keep processing idempotent, and skip automatic
  retrieval for that still-visible source.
- Reuse the chunk-safe primitive when that turn rotates later.
- Add `checkpointCompaction` for Pi's summarized span, split-turn prefix, prior
  extension catalog, and uncovered previous summary. Archive exact sources
  before returning a bounded catalog and versioned details namespace.

Acceptance:

- The input message object and Pi transcript remain exact and unchanged.
- Provider context stays below the inline cap and omits the middle sentinel.
- Exact recall reconstructs the source; repeated `process()` adds no IDs.
- Checkpoint failure returns no compaction result.

Verifier:

```text
node --test test/epoch-window.test.js
```

**Task 6 — Archive-first Pi compaction**

**6A — Pi lifecycle and fail-closed behavior**

Writable files (2):

- `extensions/pi.ts`
- `test/extension.test.js`

Mechanical work:

- Abort the turn and return no raw provider context when oversized-input
  archival fails. Surface a bounded status message.
- Keep the existing safe threshold cancellation path. For unsafe threshold,
  overflow, and manual compaction, call 5B and return Pi's custom compaction
  result instead of invoking the native summarizer on raw archived content.
- Store only trusted versioned details at
  `details.contextWindowArchive = { version: 1, entries: [...] }`; never parse
  prior summary prose as metadata.
- Cancel compaction when checkpointing fails. Preserve the successful
  `session_compact` reset.

Acceptance:

- Safe threshold performs no archive writes.
- Unsafe threshold, overflow, and manual events return a bounded custom result
  with exact Pi boundary fields.
- Failure cancels; no captured provider or summarizer payload contains the
  middle sentinel.

Verifier:

```text
node --test test/extension.test.js
npx tsc --noEmit
```

**6B — Real daemon and restart regression**

Writable files (1):

- `test/oversized-compaction.test.js` (new)

Mechanical work:

- Exercise oversized user and tool content, split-turn compaction, daemon
  shutdown/reopen, exact part reconstruction, replay, and injected archive
  failure against real RocksDB.

Acceptance:

- Provider context and compaction summaries contain no middle sentinel.
- Catalogs stay within 1,000 tokens.
- Exact UTF-8 bytes and hashes reconstruct after reopen.
- IDs remain stable on replay, and failure never returns custom compaction.

Verifier:

```text
node --test test/oversized-compaction.test.js
```

**Task 7 — Explicit semantic invalidation**

**7A — Supersession admission**

Writable files (5):

- `src/store-contract.js`
- `src/rocksdb/manifests.js`
- `src/daemon-archive.js`
- `test/store-contract.test.js`
- `test/rocksdb-chunks.test.js`

Mechanical work:

- Add optional stable `subjectKey` and explicit
  `supersedes: { documentId, version }` admission fields.
- Validate same project, older live target, non-self target, and acyclic links.
- Atomically commit the replacement and semantic supersession marker.
- Never infer a subject or supersession link from lexical similarity.

Acceptance:

- Valid correction hides its exact target at the admission commit boundary.
- Cross-project, missing, self, forward, and cyclic targets fail atomically.
- Ordinary documents without explicit metadata behave exactly as before.

Verifier:

```text
node --test test/store-contract.test.js test/rocksdb-chunks.test.js
```

**7B — Search and recall enforcement**

Writable files (4):

- `src/retrieval/search.js`
- `src/retrieval/recall.js`
- `test/retrieval-search.test.js`
- `test/retrieval-recall.test.js`

Mechanical work:

- Exclude explicitly superseded targets from exact, lexical, structural, and
  automatic retrieval immediately.
- Make old locators return typed `superseded` status with no substitution of
  replacement bytes.
- Keep the replacement searchable and preserve the old source for audit until
  its normal storage retention expires.

Acceptance:

- A correction fixture returns only the replacement in search.
- A pre-correction locator returns `superseded`, never the new text.
- Close lexical neighbors without an explicit link remain independent.

Verifier:

```text
node --test test/retrieval-search.test.js test/retrieval-recall.test.js
```

**Task 8 — Documentation, clean launch, and sanitized evidence**

**8A — Semantic guides**

Writable files (4):

- `docs/rocksdb-archive/retrieval.md`
- `docs/rocksdb-archive/retention.md`
- `docs/rocksdb-archive/evaluation.md`
- `README.md`

Mechanical work:

- Document storage retention separately from automatic eligibility.
- Document marker versus snippet disclosure, exact thresholds, source dates,
  one active budget, exposure cooldown, and explicit supersession.
- Document oversized-input admission and archive-first custom compaction.
- Remove claims not demonstrated by tests or release evidence.

Acceptance:

- Every behavioral claim points to a verifier or artifact field.
- Configuration names and defaults match 1A exactly.

Verifier:

```text
npm run check
```

**8B — Pi startup and redacted release evidence**

Writable files (4):

- `test/pi-launch.test.js` (new)
- `eval/release/verifiers.js`
- `test/release-evidence.test.js`
- `docs/rocksdb-archive/evaluation-results.md`

Mechanical work:

- Spawn the repository's `node_modules/.bin/pi` in offline RPC mode with a
  temporary home, explicit local extension, no saved session, and no model
  request. Require a successful `get_state` response and clean shutdown.
- Add a release-evidence redaction verifier. Persist only versions, hashes,
  aggregate counts, durations, byte totals, exit status, and gate results.
- Reject evidence containing prompts, recalled text, environment values,
  credentials, home-directory usernames, absolute source paths, session IDs,
  or raw database keys.

Acceptance:

- Pi launches the local extension without stderr warnings or startup errors.
- The complete evidence document passes the redaction verifier.
- No verifier needs network access or a provider credential.

Verifier:

```text
node --test test/pi-launch.test.js test/release-evidence.test.js
npm run check
```

**Final review gate**

1. Each half has an independent read-only `PASS` review against its own write
   scope and acceptance conditions.
2. Run `npm run check` from a clean Pi subprocess environment.
3. Run `npm run eval:retrieval` and the real oversized-compaction regression.
4. Validate the release-evidence redaction gate before retaining any artifact.
5. Record exact command, exit status, test counts, artifact hashes, and aggregate
   storage metrics only. Do not record prompts, recalled content, credentials,
   user paths, session identifiers, or raw keys.
