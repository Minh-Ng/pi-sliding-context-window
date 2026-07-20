**Purpose**

This directory freezes retrieval inputs and scores normalized backend observations. The runner and scorer do not import storage internals; the production adapter is the narrow boundary that invokes RocksDB admission, indexing, search, recall, and preflight. The legacy SQLite adapter establishes the lexical baseline through the same evaluation API.

**Backend API**

An adapter exports `createEvaluationBackend()` and returns:

- `metadata`: `id`, `version`, API version, and supported suite names.
- `prepare(fixture)`: load the canonical fixture documents once.
- `search(request)`: return an array or `{ results }` with document IDs, scores, optional message keys, and opaque locators.
- `recall(request)`: for the `chunks` capability, return canonical text with UTF-8 source byte coordinates.
- `preflight(request)`: for the `hints` capability, return `{ hints, modelVisibleText }` and freeze results by message key.
- `close()`: release temporary resources.

The runner records only normalized, JSON-safe observations. The scorer recomputes metrics from those observations when validating an artifact.

Chunk gates derive token use and evidence visibility from the exact rendered model-visible text; backend-reported token counts cannot satisfy the gate. Canonical source bytes are checked independently against the frozen fixture coordinates. Hint gates likewise account for the complete `modelVisibleText`, including labels and separators, and count a relevant hint as useful only when its rendered text is actually visible.

**Commands**

```text
node eval/retrieval/cli.js --validate-only
node eval/retrieval/cli.js --backend sqlite --suite exact,lexical,structural
node eval/retrieval/cli.js --backend eval/retrieval/rocksdb-backend.js --baseline-artifact ./sqlite.json
node eval/retrieval/cli.js --validate-artifact ./result.json
```

JSON is written to standard output; a concise summary is written to standard error. `--output` also persists the artifact. `--require-all` makes unsupported or otherwise unevaluated selected gates fatal.

`npm run eval:retrieval` is the release-gate entrypoint. It first regenerates and validates `artifacts/retrieval/sqlite-baseline.json`, then evaluates the production RocksDB retrieval path against that artifact and writes `artifacts/retrieval/rocksdb-evaluation.json`. The full run includes automatic hints. Optional CLI suite arguments are forwarded and write suite-scoped artifacts, so focused verification cannot replace the full release artifact or its paired baseline. `npm run eval:hints` provides a focused hint-only verifier.

**Held-out handling**

Held-out annotations are not stored in the regression fixture. An untouched fixture may be evaluated only by an explicit one-run authorization. As soon as its inputs, labels, or outcomes are inspected for tuning, it becomes a regression fixture and must be replaced before another independent release evaluation.

**Performance scaffolding**

`performance.js` provides deterministic streaming corpora at 10 thousand, 100 thousand, and 1 million logical windows, latency sampling, percentile calculation, and artifact validation. Benchmark owners supply the backend operations; the corpus plan and environment schema stay shared.

**Reranker decision eval (deferred task #2)**

`reranker-corpus.js`, `reranker-eval.js`, `reranker-model.js`, and `reranker-cli.js` are a self-contained offline suite that decides whether to build a cross-encoder reranker. The corpus is rank-sensitive by construction: every case is a hard lexical-distractor scene (repeated query terms, near-identical tool outputs, negated near-duplicates, decisions buried in long logs) where the answering document lands inside the BM25 top-50 but outside the fused top-3 at baseline. That hardness is asserted empirically at run time — `collectRerankerBaseline` measures each target's real BM25 rank and full-fused rank (exact tier + RRF + recency decay + importance prior, matching the daemon's explicit `store.search` options) and refuses to assume it.

The eval compares that baseline against baseline+rerank of the fused top-40, scoring Recall@3 and MRR and measuring per-query rerank latency (p50/p95) for a full 40-candidate window on CPU. `decideReranker` applies one frozen rule mechanically: BUILD if rerank improves MRR by at least 10% relative OR Recall@3 by at least 5 points absolute, AND p50 rerank latency is at most 1.5s; otherwise PARK. The verdict, per-case ranks, metrics, latency, and rule are written to the artifact.

```text
node eval/retrieval/reranker-cli.js --download          # one-time pinned-revision model fetch into the local cache
node eval/retrieval/reranker-cli.js --output ./reranker-verdict.json
```

The model is the Xenova ONNX mirror of `cross-encoder/ms-marco-MiniLM-L-6-v2`, pinned to an immutable revision, quantized (q8) on CPU, cached read-only outside the repository (no credentials). If the weights are not cached the runner emits a self-describing `verdict: "blocked"` artifact plus the exact `--download` command to finish the measurement. `reranker-verdict.json` records the recorded run. `node --test test/reranker-eval.test.js` drives the whole harness with deterministic stub rerankers, so it never touches the network. Caveat: this measures reranker capability on constructed hard cases; how often real sessions hit such cases is a separate question the live relevance-feedback log answers.
