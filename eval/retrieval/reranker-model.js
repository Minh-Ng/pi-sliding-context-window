import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { env, AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";

// Cross-encoder reranker under evaluation for deferred task #2. The Xenova ONNX
// mirror of cross-encoder/ms-marco-MiniLM-L-6-v2 is a 6-layer MiniLM sequence
// classifier that scores a (query, passage) pair with a single relevance
// logit; higher means more relevant. Pinned to one immutable commit so a
// re-run measures the same weights, matching how src/semantic pins its
// embedding models. dtype q8 mirrors the embedder worker's CPU quantization so
// the measured latency reflects the quantization this project already ships.
export const RERANKER_MODEL = Object.freeze({
  id: "Xenova/ms-marco-MiniLM-L-6-v2",
  revision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
  dtype: "q8",
  device: "cpu",
  maxLength: 512,
});

// The download is written here once and reused read-only afterwards. Kept
// outside the repository so the model bytes never enter the eval patch, and
// overridable for CI that provisions its own cache.
export function defaultRerankerCacheDir() {
  const override = process.env.CONTEXT_WINDOW_RERANKER_CACHE;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return join(homedir(), ".cache", "context-window-reranker-eval");
}

// The exact command a blocked run must finish with. Surfaced in the CLI and the
// eval artifact so a machine without the cached weights has one copy-paste step.
export function rerankerDownloadCommand() {
  return "node eval/retrieval/reranker-cli.js --download";
}

function configureEnvironment(cacheDir, allowRemote) {
  env.allowLocalModels = true;
  env.allowRemoteModels = allowRemote === true;
  env.cacheDir = cacheDir;
}

async function loadPipeline({ cacheDir, allowRemote }) {
  configureEnvironment(cacheDir, allowRemote);
  const shared = {
    revision: RERANKER_MODEL.revision,
    cache_dir: cacheDir,
    local_files_only: allowRemote !== true,
  };
  const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL.id, shared);
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL.id, {
    ...shared,
    dtype: RERANKER_MODEL.dtype,
    device: RERANKER_MODEL.device,
  });
  return { tokenizer, model };
}

// One-time authorized download. Fetches the pinned revision into the local
// cache with no credentials, then exercises one scoring pass so a partial
// download surfaces immediately rather than at eval time.
export async function downloadRerankerModel({ cacheDir = defaultRerankerCacheDir() } = {}) {
  const startedAt = performance.now();
  const { tokenizer, model } = await loadPipeline({ cacheDir, allowRemote: true });
  const inputs = tokenizer(["warmup query"], {
    text_pair: ["warmup passage"],
    padding: true,
    truncation: true,
    max_length: RERANKER_MODEL.maxLength,
  });
  await model(inputs);
  await model?.dispose?.();
  return Object.freeze({
    cacheDir,
    model: RERANKER_MODEL.id,
    revision: RERANKER_MODEL.revision,
    elapsedMs: performance.now() - startedAt,
  });
}

// Reports whether the pinned revision is already cached, so callers can decide
// between running the eval and emitting the download command without triggering
// a network fetch.
export async function rerankerModelAvailable({ cacheDir = defaultRerankerCacheDir() } = {}) {
  try {
    const { model } = await loadPipeline({ cacheDir, allowRemote: false });
    await model?.dispose?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the cross-encoder from the local cache (never the network by default)
 * and return a reranker that scores a query against N passages in one batched
 * forward pass. `score` returns one relevance logit per passage in input order.
 */
export async function createCrossEncoderReranker({
  cacheDir = defaultRerankerCacheDir(),
  allowRemote = false,
} = {}) {
  const { tokenizer, model } = await loadPipeline({ cacheDir, allowRemote });
  return {
    metadata: Object.freeze({
      id: RERANKER_MODEL.id,
      revision: RERANKER_MODEL.revision,
      dtype: RERANKER_MODEL.dtype,
      device: RERANKER_MODEL.device,
      maxLength: RERANKER_MODEL.maxLength,
    }),
    async score(query, passages) {
      if (!Array.isArray(passages) || passages.length === 0) return [];
      const inputs = tokenizer(new Array(passages.length).fill(String(query)), {
        text_pair: passages.map((passage) => String(passage)),
        padding: true,
        truncation: true,
        max_length: RERANKER_MODEL.maxLength,
      });
      const output = await model(inputs);
      const rows = output.logits.tolist();
      // ms-marco rerankers emit a single logit per pair (shape [n, 1]); guard
      // the two-logit relevance-classifier layout by taking the last column,
      // which is the positive/relevant class in both conventions used here.
      return rows.map((row) => (Array.isArray(row) ? row[row.length - 1] : row));
    },
    async close() {
      await model?.dispose?.();
    },
  };
}
