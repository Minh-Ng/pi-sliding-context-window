// Embedding dimensions and pooling strategy are properties of a model's
// architecture, not free configuration — a mean-pooled 384-dim encoder and a
// last-token-pooled 1024-dim decoder-derived encoder cannot share one guess.
// This catalog is the single place that maps a model id to those intrinsic
// properties so the usearch index dimensions/metric and the embedding worker's
// pooling call always match the configured model instead of a hardcoded
// literal sized for only the shipped default.
//
// Dimensions/pooling below are sourced from each model's published card. The
// EmbeddingGemma "small" candidate was later installed and compared with the
// default in local retrieval evaluations: it showed no meaningful improvement
// while adding about 210MB to the published quantized model footprint (300MB
// versus 90MB), and no retained artifact supports an independent benchmark
// claim. The Qwen3/Jina "quality" candidates remain unrun in this environment.
// Verify a candidate revision with `context-window-semantic install <model>`;
// the installer reports the dimensions the model actually returns.
export const SEMANTIC_MODEL_PROFILES = Object.freeze({
  "Xenova/all-MiniLM-L6-v2": Object.freeze({
    dimensions: 384,
    pooling: "mean",
    tier: "default",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  }),
  // Google EmbeddingGemma-300M, mean-pooled, native 768-dim (also supports
  // Matryoshka truncation to 512/256/128, not used here). ~300MB quantized.
  "onnx-community/embeddinggemma-300m-ONNX": Object.freeze({
    dimensions: 768,
    pooling: "mean",
    tier: "small",
    revision: "main",
  }),
  // Qwen3-Embedding-0.6B, decoder-derived, last-token pooled, native 1024-dim.
  // Quality-tier candidate; Apache-2.0. Query-side instruction prefixes
  // ("Instruct: ...\nQuery:{query}") improve retrieval quality by ~1-5% per
  // the model card but are not implemented here — spans and queries are
  // embedded identically. Track as a follow-up before relying on this tier.
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": Object.freeze({
    dimensions: 1024,
    pooling: "last_token",
    tier: "quality",
    revision: "main",
  }),
  // Jina embeddings v5 text-small, built on Qwen3-0.6B-Base, last-token
  // pooled, native 1024-dim. Quality-tier candidate. License is CC-BY-NC-4.0
  // (non-commercial) — confirm that fits before adopting it as a default.
  "jinaai/jina-embeddings-v5-text-small": Object.freeze({
    dimensions: 1024,
    pooling: "last_token",
    tier: "quality",
    revision: "main",
  }),
});

// Short names accepted by the installer CLI and config in place of a full
// Hugging Face model id.
export const SEMANTIC_TIER_ALIASES = Object.freeze({
  default: "Xenova/all-MiniLM-L6-v2",
  small: "onnx-community/embeddinggemma-300m-ONNX",
  quality: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
});

export function semanticModelProfile(model) {
  return SEMANTIC_MODEL_PROFILES[model];
}

// Resolves a raw model argument (a tier alias or a literal model id) and an
// optional revision override into the pair a caller should use, falling back
// to the catalog's pinned revision when the model is known and no revision
// was supplied. Returns undefined for an empty/missing argument so callers
// can fall back to their own configured default.
export function resolveSemanticModelArgument(rawModel, rawRevision) {
  if (typeof rawModel !== "string" || rawModel.trim().length === 0) return undefined;
  const model = SEMANTIC_TIER_ALIASES[rawModel] ?? rawModel;
  const profile = semanticModelProfile(model);
  const revision = typeof rawRevision === "string" && rawRevision.trim().length > 0
    ? rawRevision
    : profile?.revision;
  return { model, revision, profile };
}
