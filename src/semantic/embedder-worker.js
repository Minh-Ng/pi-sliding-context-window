import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.cacheDir = workerData.cachePath;

let extractorPromise;
function extractor() {
  extractorPromise ??= pipeline("feature-extraction", workerData.model, {
    revision: workerData.revision,
    cache_dir: workerData.cachePath,
    local_files_only: true,
    dtype: "q8",
    device: "cpu",
  });
  return extractorPromise;
}

parentPort.on("message", async ({ id, texts }) => {
  try {
    const model = await extractor();
    // Pooling is a property of the configured model's architecture (mean for
    // encoder models like MiniLM/EmbeddingGemma, last_token for
    // decoder-derived models like Qwen3/Jina v5) — see model-catalog.js.
    const output = await model(texts, { pooling: workerData.pooling ?? "mean", normalize: true });
    const dimensions = output.dims.at(-1);
    const vectors = Float32Array.from(output.data);
    parentPort.postMessage({ id, ok: true, dimensions, vectors }, [vectors.buffer]);
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
