# Pi agent-memory evaluation

The benchmark system under test is always:

> Pi harness + selected model + Pi system/tool policy + context-window extension/tools + RocksDB daemon

A direct archive or index call is a component test, never an agent-memory evaluation and never a source of benchmark claims.

## Component contract tests

```bash
npm run test:benchmark-fit
```

These no-model tests verify schema mapping, storage isolation, metric compatibility, and Pi evaluation-harness lifecycle behavior. `compatibility.js` exists only to exercise those contracts.

| External harness | Component mapping | Proven scope |
|---|---|---|
| LongMemEval-V1 | timestamped sessions and official session metrics | storage/scorer contract only |
| LongMemEval-V2 | full trajectory insertion and ordered `{type: text|image, value}` context | multimodal contract, screenshot-path validation, and bounded pre-budgeting; the official reader processor owns exact token counting and final prefix truncation |
| MemoryArena | initialize/add/wrap prompt over HTTP | official Python `MemoryClient` transport verified against an isolated archive-backed local server |

The V2 adapter follows the public contract at official repository commit `6f020ac2fc3275e46c706d3406e02c3ed79b7be2`. Relative state screenshot paths are resolved from the ingestion `dataRoot`, and a missing image rejects the trajectory before archive insertion.

## MemoryArena HTTP compatibility

`memoryarena-http-server.js` implements the three endpoints used by MemoryArena's official Python client: `/memory/initialize`, `/memory/add`, and `/memory/wrap_user_prompt`. The verifier imports `memory/client.py` from a pinned MemoryArena checkout and checks bounded context plus user isolation:

```bash
node eval/agent-memory/memoryarena-http-server.js \
  --db /tmp/context-window-memoryarena.db \
  --port 8000

uv run --python 3.12 --with requests python \
  eval/agent-memory/verify-memoryarena-client.py \
  --base-url http://127.0.0.1:8000 \
  --memoryarena-repo /path/to/ZexueHe/MemoryArena \
  --output artifacts/agent-memory/memoryarena-http-verification.json
```

The retained verification used MemoryArena commit `6cd9de14b71915e39ac742a20dc33785e14b6aab`.

## LongMemEval-S through Pi

The runner seeds the benchmark history into a Pi session without model calls, binds the real extension lifecycle, rotates old turns through the production plugin into an isolated RocksDB daemon, asks Pi the benchmark question, and retains model messages plus tool traces:

```bash
node --max-old-space-size=4096 eval/agent-memory/pi-longmemeval-s.js \
  --data /path/to/longmemeval_s_cleaned.json \
  --output artifacts/agent-memory/pi-longmemeval.json \
  --cases 06f04340,0977f2af \
  --repetitions 1 \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium
```

For answer scoring, `score-longmemeval.js` reproduces the official evaluator's question-type-specific user-prompt templates and checkpoints every completed judgment:

```bash
node eval/agent-memory/score-longmemeval.js \
  --input artifacts/agent-memory/pi-longmemeval-stratified-30-combined.json \
  --output artifacts/agent-memory/pi-longmemeval-stratified-30-judged.json \
  --model openai-codex/gpt-5.4 \
  --thinking medium
```

Only a run using the official `gpt-4o-2024-08-06` API evaluator in the official execution environment is leaderboard-comparable. Substitute models or Pi-hosted judging must be reported as surrogate scores.

Artifacts record:

- dataset and extension hashes
- selected Pi provider, model, and thinking level
- exact user prompt and final answer
- active tools and every tool call/result
- token usage and reported cost
- setup, prompt, cleanup, and total wall-clock timing
- bounded lifecycle failures

Artifacts are local and gitignored because traces contain benchmark history and machine metadata.

## Harness invariants

- `createAgentSession()` is followed by explicit `bindExtensions()` before prompting.
- Historical fixture timestamps remain unchanged. Eval-scoped retention is lengthened instead of rewriting dates.
- Temporary daemon socket paths stay below a conservative 100-byte Unix-socket limit, with `/tmp` fallback for long platform temp roots.
- Extension `session_shutdown` runs before SDK disposal; the exact daemon PID is then terminated and awaited.
- Failure diagnostics are bounded, artifacts survive failed cases, and failed temporary workspaces are retained for diagnosis.
- Each benchmark case gets a fresh Pi session, extension instance, archive, daemon, and environment snapshot.
- Direct archive queries are forbidden in the evaluation runner.

## Evaluation policy

A case passes only from Pi's final answer after the complete plugin/tool loop. Search rank, component retrieval metrics, manually inspected evidence, and answers produced while the extension lifecycle is unhealthy cannot substitute for that result.

The currently exposed case IDs are development regression cases, not independent benchmark evidence. Larger samples must be frozen before their first Pi run.
