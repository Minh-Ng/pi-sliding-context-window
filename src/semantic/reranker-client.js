import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const DEFAULT_PROCESS_URL = new URL("./reranker-process.js", import.meta.url);

/**
 * Thrown by `score()` when a request times out waiting for the worker to
 * reply. Distinguished from every other rejection (worker crash, malformed
 * output, an explicit model-load failure surfaced by the worker) so callers
 * -- see LocalReranker -- can treat a slow-but-possibly-still-loading model
 * differently from a genuinely broken one: a single timeout is expected
 * during the worker's lazy first-request model load and must not by itself
 * be taken as proof the model is unusable.
 */
export class RerankerTimeoutError extends Error {}

/**
 * Process-isolated cross-encoder client. onnxruntime-node fatally corrupts
 * V8/N-API state when the semantic embedder and reranker run in separate
 * worker threads in one process; production therefore forks the reranker.
 * An explicit workerUrl retains the lightweight worker-thread test seam.
 * The model loads lazily on its first message, never blocking daemon start, and every
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
    workerUrl,
  }) {
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.metadata = Object.freeze({ id: model, revision });
    this.processIsolated = workerUrl === undefined;
    this.worker = this.processIsolated
      ? fork(fileURLToPath(DEFAULT_PROCESS_URL), [model, revision ?? "main", cachePath], {
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        })
      : new Worker(workerUrl, {
          workerData: { model, revision, cachePath },
          execArgv: [],
        });
    this.worker.on("message", (message) => this.#settle(message));
    this.worker.on("error", (error) => this.#fail(error));
    this.worker.on("exit", (code, signal) => {
      if (!this.terminated && (code !== 0 || signal !== null)) {
        this.#fail(new Error(
          `Local reranker ${this.processIsolated ? "process" : "worker"} exited with ${signal ?? `code ${code}`}.`,
        ));
      }
    });
    // Observable, idempotent close: LocalReranker terminates a load-failed
    // worker as soon as it latches unavailable, and a later daemon shutdown
    // calls close() again on the same client -- terminating an
    // already-terminated worker a second time is harmless in Node, but the
    // flag lets callers (and tests) confirm termination actually happened
    // instead of inferring it from a worker that simply stopped replying.
    this.terminated = false;
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
        reject(new RerankerTimeoutError("Local reranker request timed out."));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, query: String(query), passages };
      if (this.processIsolated) {
        this.worker.send(message, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } else {
        this.worker.postMessage(message);
      }
    });
  }

  async close() {
    if (this.terminated) return;
    this.terminated = true;
    this.#fail(new Error("Local reranker closed."));
    if (!this.processIsolated) {
      await this.worker.terminate();
      return;
    }
    if (this.worker.exitCode !== null || this.worker.signalCode !== null) return;
    await new Promise((resolve) => {
      this.worker.once("exit", resolve);
      this.worker.kill();
    });
  }
}
