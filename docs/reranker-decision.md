# Reranker deployment decision

**Status: disabled. Do not restore or auto-load it in normal sessions.**

The local deployment sets `context-window.rerankerEnabled` to `false` in
`~/.pi/agent/settings.json`. The installed model cache was moved out of the
configured path to:

```text
~/.pi/context-window/reranker-models.disabled
```

This second guard makes a stale daemon launcher fail closed even if it still
passes `--reranker`.

## Why it is disabled

A 2026-07-25 evaluation used 142 real feedback events and 19 positive labels
(results that were shown and later explicitly recalled). Historical
session-scoped candidate pools could not be reconstructed: none of the 16
still-existing selected versions re-entered the current session-scoped top 40.
A broader, non-historical project-scope sensitivity recovered 11 targets and
showed:

- 0 improved ranks
- 10 unchanged ranks
- 1 regression (rank 2 to rank 12)
- Recall@3: 0.250 to 0.1875
- MRR: 0.242345 to 0.216303

This does not prove general harm, but it provides no real-session evidence of
benefit. Reranking also increased replay latency from 57.5 ms to 152.9 ms at
p95 (paired p95 increase 117.7 ms) and its active isolated model process used
about 488 MB RSS until idle eviction.

The private evaluation artifacts are stored outside the repository:

```text
~/.pi/context-window/evals/real-session-reranker-2026-07-25.json
~/.pi/context-window/evals/real-session-reranker-project-scope-2026-07-25.json
```

## Conditions for reconsideration

Do not move the disabled cache back, set `rerankerEnabled: true`, or change the
package default for normal use unless a controlled forward evaluation has met
a predeclared quality/latency rule. Any experiment must:

1. use deterministic request-level baseline/reranked assignment or equivalent
   exact counterfactual logging;
2. measure organic original-scope outcomes, including recall rate and
   reformulation/miss proxies—not only selected-result rank;
3. account for results removed from view by reranking (survivorship bias);
4. keep automatic preflight excluded;
5. restore the disabled state after the experiment unless the predeclared rule
   passes.

The process-isolation and idle-eviction implementation may remain in the code;
that makes controlled experiments safe, but is not evidence that reranking is
useful.
