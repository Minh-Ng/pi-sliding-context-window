import { Worker } from "node:worker_threads";

export class LocalEmbedder {
  constructor({ model, revision, cachePath, pooling = "mean", timeoutMs = 60_000 }) {
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL("./embedder-worker.js", import.meta.url), {
      workerData: { model, revision, cachePath, pooling },
      execArgv: [],
    });
    this.worker.on("message", (message) => this.#settle(message));
    this.worker.on("error", (error) => this.#fail(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.#fail(new Error(`Local embedding worker exited with code ${code}.`));
    });
  }

  #settle(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) pending.reject(new Error(message.error));
    else pending.resolve({ dimensions: message.dimensions, vectors: message.vectors });
  }

  #fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== "string")) {
      throw new TypeError("embed requires a non-empty string array.");
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Local embedding request timed out."));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, texts });
    });
  }

  async close() {
    this.#fail(new Error("Local embedder closed."));
    await this.worker.terminate();
  }
}
