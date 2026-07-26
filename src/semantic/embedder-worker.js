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

// ONNX inference already uses the machine's CPU cores internally. Running
// multiple model calls concurrently only creates contention and lets a long
// background rebuild delay an interactive query. Serialize calls and always
// drain foreground work first; a query then waits for at most the one batch
// already in flight.
const foreground = [];
const background = [];
let running = false;

async function drain() {
  if (running) return;
  running = true;
  try {
    while (foreground.length > 0 || background.length > 0) {
      const { id, texts } = foreground.shift() ?? background.shift();
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
    }
  } finally {
    running = false;
    // A message may arrive after the loop observes both queues empty but
    // before running flips false.
    if (foreground.length > 0 || background.length > 0) void drain();
  }
}

parentPort.on("message", ({ id, texts, priority = "foreground" }) => {
  (priority === "background" ? background : foreground).push({ id, texts });
  void drain();
});
