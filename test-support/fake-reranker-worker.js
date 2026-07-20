import { parentPort, workerData } from "node:worker_threads";
import { FAKE_RERANKER_MISSING_MODEL } from "./fake-reranker-worker-constants.js";

// Deterministic stand-in for src/semantic/reranker-worker.js: no model load,
// no @huggingface/transformers dependency. Scores each passage by its own
// length (longer passage -> higher score) so a real worker-thread
// round-trip (postMessage/terminate lifecycle) is exercised without a model
// download. Requesting the sentinel model id below simulates the pinned
// model being absent from the local cache (every request fails, mirroring
// local_files_only rejecting a missing model) without adding a test-only
// constructor option to the real RerankerWorkerClient.
parentPort.on("message", ({ id, passages }) => {
  if (workerData.model === FAKE_RERANKER_MISSING_MODEL) {
    parentPort.postMessage({ id, ok: false, error: "model files not found (fake)" });
    return;
  }
  const scores = passages.map((passage) => String(passage).length);
  parentPort.postMessage({ id, ok: true, scores });
});
