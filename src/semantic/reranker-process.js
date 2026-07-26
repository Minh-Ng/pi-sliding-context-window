import { env, AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { RERANKER_DEVICE, RERANKER_DTYPE, RERANKER_MAX_LENGTH } from "./reranker-model.js";

const [modelId, revision, cachePath] = process.argv.slice(2);
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.cacheDir = cachePath;

let pipelinePromise;
function pipelineComponents() {
  pipelinePromise ??= (async () => {
    const shared = {
      revision,
      cache_dir: cachePath,
      local_files_only: true,
    };
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, shared);
    const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
      ...shared,
      dtype: RERANKER_DTYPE,
      device: RERANKER_DEVICE,
    });
    return { tokenizer, model };
  })();
  return pipelinePromise;
}

process.on("message", async ({ id, query, passages }) => {
  try {
    if (!Array.isArray(passages) || passages.length === 0) {
      process.send?.({ id, ok: true, scores: [] });
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
    const scores = rows.map((row) => (Array.isArray(row) ? row[row.length - 1] : row));
    process.send?.({ id, ok: true, scores });
  } catch (error) {
    process.send?.({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
