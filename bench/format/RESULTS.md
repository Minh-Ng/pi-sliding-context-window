# Recall packet format experiment — fenced-v2 vs json-v1

Decision (2026-07-20): **keep `json-v1` as the default recall packet format.**
`fenced-v2` stays implemented and opt-in via `CONTEXT_WINDOW_RECALL_FORMAT=fenced-v2`
(daemon env) pending stronger accuracy evidence. Do not enable it by default on
token savings alone.

## What fenced-v2 is

One untrusted-data marker line + one compact metadata JSON line + the raw body
inside a collision-proof `~~~~~` fence (`src/retrieval/render.js`). Removes the
double-JSON encoding of the v1 envelope.

## Token evidence (packet-format-bench.js, real tokenizers)

- Aggregate savings vs json-v1: **21.9% (cl100k), 22.2% (o200k)**
- Decision notes: ~41% less; code packets: 23–31% less; prose: 11–21% less

## Correctness / injection evidence

- `test/render-fenced.test.js` (10 tests): fence grows past hostile tilde runs,
  injected marker/metadata/fence lines stay inside the fence, truncation and
  focus fallbacks keep the envelope, budgets below the fenced minimum degrade
  to json-v1 instead of throwing.
- `test/render-fenced-integration.test.js`: real store → admit → signed
  locator → `recallArchive` renders fenced-v2 only when `options.renderFormat`
  is set; unknown values degrade to json-v1.

## Accuracy evidence (LongMemEval-S subset, why the default stays json-v1)

3 repetitions × 10 stratified cases per arm, Pi + openai-codex/gpt-5.4-mini,
judge gpt-5.4-mini with official prompts (artifacts/agent-memory/format-ab-*):

| rep | control (json-v1) | fenced-v2 |
|---|---|---|
| 1 | 8/10 | 7/10 |
| 2 | 9/10 | 7/10 |
| 3 | 5/10 | 6/10 |
| **total** | **22/30** | **19/30** |

Interpretation:
- Within-arm variance is huge (control spans 5–9/10 across identical runs);
  the 3-case gap is not statistically separable (two-proportion p ≈ 0.4).
- Per-case: most flips occur in both arms (pure run variance), one fenced miss
  had zero retrieval calls (format never rendered), one was judge noise
  (semantically identical answers judged differently across arms).
- One suspicious case: `09ba9854` (multi-session price arithmetic) passed 3/3
  under control and 1/3 under fenced. Hypothesis worth testing before any
  default flip: fenced-v2's compact metadata drops the per-record staleness
  sentence and `sourceMessages.totalKeys`, which may matter for multi-session
  reconciliation.

## To revisit

1. Variant that keeps fenced body but restores full v1 metadata fields.
2. ≥30 cases × ≥3 reps per arm for separable statistics.
3. Judge with a fixed non-LLM-noisy rubric or majority-of-3 judgments.
