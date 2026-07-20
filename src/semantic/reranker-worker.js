import { parentPort, workerData } from "node:worker_threads";
import { env, AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { RERANKER_DEVICE, RERANKER_DTYPE, RERANKER_MAX_LENGTH } from "./reranker-model.js";

env.allowLocalModels = true;
// Runtime inference never downloads: the installer (bin/context-window-semantic.js)
// is the only authorized path that sets allowRemoteModels for this model, and it
// runs in the main process, never in this worker.
env.allowRemoteModels = false;
env.cacheDir = workerData.cachePath;

let pipelinePromise;
function pipelineComponents() {
  pipelinePromise ??= (async () => {
    const shared = {
      revision: workerData.revision,
      cache_dir: workerData.cachePath,
      local_files_only: true,
    };
    const tokenizer = await AutoTokenizer.from_pretrained(workerData.model, shared);
    const model = await AutoModelForSequenceClassification.from_pretrained(workerData.model, {
      ...shared,
      dtype: RERANKER_DTYPE,
      device: RERANKER_DEVICE,
    });
    return { tokenizer, model };
  })();
  return pipelinePromise;
}

parentPort.on("message", async ({ id, query, passages }) => {
  try {
    if (!Array.isArray(passages) || passages.length === 0) {
      parentPort.postMessage({ id, ok: true, scores: [] });
      return;
    }
    const { tokenizer, model } = await pipelineComponents();
    const inputs = tokenizer(new Array(passages.length).fill(String(query)), {
      text_pair: passages.map((passage) => String(passage)),
      padding: true,
      truncation: true,
      max_length: RERANKER_MAX_LENGTH,
    });
    const output = await model(inputs);
    const rows = output.logits.tolist();
    // ms-marco cross-encoders emit a single relevance logit per pair (shape
    // [n, 1]); guard the two-logit relevance-classifier layout by taking the
    // last column, which is the positive/relevant class in both conventions
    // (mirrors eval/retrieval/reranker-model.js's scoring, the reference
    // implementation this worker reproduces for production).
    const scores = rows.map((row) => (Array.isArray(row) ? row[row.length - 1] : row));
    parentPort.postMessage({ id, ok: true, scores });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
