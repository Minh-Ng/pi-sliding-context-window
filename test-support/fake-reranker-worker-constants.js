// Shared between test-support/fake-reranker-worker.js (a worker-thread entry,
// unsafe to import from the main thread since it touches worker_threads'
// parentPort at module scope) and test/reranker.test.js (main thread).
export const FAKE_RERANKER_MISSING_MODEL = "fake-reranker-missing-model";
