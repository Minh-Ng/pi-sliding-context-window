import { Worker } from "node:worker_threads";

const DEFAULT_WORKER_URL = new URL("./reranker-worker.js", import.meta.url);

/**
 * Worker-thread cross-encoder client. Mirrors LocalEmbedder
 * (embedder-client.js): the model loads lazily inside the worker on its
 * first message, never blocking construction or daemon start, and every
 * request/response round-trips by sequence id so out-of-order settlement is
 * impossible. `score(query, passages)` matches the interface
 * eval/retrieval/reranker-model.js's createCrossEncoderReranker returns, so
 * this client can also be injected directly into the offline eval harness
 * (eval/retrieval/reranker-eval.js) to revalidate its verdict against the
 * exact production wiring.
 */
export class RerankerWorkerClient {
  constructor({
    model,
    revision,
    cachePath,
    timeoutMs = 60_000,
    workerUrl = DEFAULT_WORKER_URL,
  }) {
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.metadata = Object.freeze({ id: model, revision });
    this.worker = new Worker(workerUrl, {
      workerData: { model, revision, cachePath },
      execArgv: [],
    });
    this.worker.on("message", (message) => this.#settle(message));
    this.worker.on("error", (error) => this.#fail(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.#fail(new Error(`Local reranker worker exited with code ${code}.`));
    });
  }

  #settle(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) pending.reject(new Error(message.error));
    else pending.resolve(message.scores);
  }

  #fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  score(query, passages) {
    if (!Array.isArray(passages) || passages.length === 0) return Promise.resolve([]);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Local reranker request timed out."));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, query: String(query), passages });
    });
  }

  async close() {
    this.#fail(new Error("Local reranker closed."));
    await this.worker.terminate();
  }
}
