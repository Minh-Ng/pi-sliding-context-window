// Cross-encoder reranker for explicit search/gather (deferred task #2). Only
// one model is currently supported (unlike the multi-tier embedding catalog in
// model-catalog.js), so its architecture-intrinsic properties -- dtype,
// device, and the tokenizer's max sequence length -- are fixed constants
// here rather than per-deployment config: they are exactly what the offline
// eval (eval/retrieval/reranker-eval.js, eval/retrieval/reranker-verdict.json)
// measured, and changing them would invalidate that verdict without a new
// eval run. Model id/revision remain configurable (see config.js
// rerankerModel/rerankerModelRevision) so a deployment can point at a
// self-hosted mirror while keeping this file's pinned default as the
// eval-validated fallback.
export const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const DEFAULT_RERANKER_MODEL_REVISION = "a09144355adeed5f58c8ed011d209bf8ee5a1fec";

// q8/cpu is the exact quantization/device the eval measured; not exposed as a
// setting because a different dtype or device was never validated against
// the recorded Recall@3/MRR/latency numbers.
export const RERANKER_DTYPE = "q8";
export const RERANKER_DEVICE = "cpu";
export const RERANKER_MAX_LENGTH = 512;

// The fused top-N candidates sent to the cross-encoder per query, matching the
// eval's own candidate window (eval/retrieval/reranker-eval.js
// RERANKER_DECISION_RULE.candidateWindow) so production latency tracks the
// measured p50/p95 rather than an unvalidated larger batch.
export const DEFAULT_RERANKER_CANDIDATE_WINDOW = 40;

// Per-candidate text budget sent to the cross-encoder, independent of the
// tokenizer's own max_length truncation: this keeps each passage close to the
// eval's per-passage cost even when a widened presentation snippet
// (options.expandSnippetsToBudget) would otherwise hand the model a much
// longer passage than it was measured against.
export const DEFAULT_RERANKER_TEXT_TOKEN_BUDGET = 256;
