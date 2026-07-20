import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalReranker, truncateCenteredTokens } from "../src/semantic/reranker.js";
import { RerankerWorkerClient, RerankerTimeoutError } from "../src/semantic/reranker-client.js";
import { DEFAULT_RERANKER_MODEL, DEFAULT_RERANKER_MODEL_REVISION } from "../src/semantic/reranker-model.js";
import { defaultRerankerCacheDir } from "../eval/retrieval/reranker-model.js";
import { FAKE_RERANKER_MISSING_MODEL } from "../test-support/fake-reranker-worker-constants.js";

const FAKE_WORKER_URL = new URL("../test-support/fake-reranker-worker.js", import.meta.url);
// The pinned reranker model, downloaded once into this fixed local cache for
// offline eval and reused read-only by these tests (see repo task notes and
// eval/retrieval/reranker-model.js). Tests that need it present skip instead
// of failing when the cache has not been populated in this environment.
const REAL_RERANKER_CACHE_DIR = defaultRerankerCacheDir();
const REAL_RERANKER_MODEL_INSTALLED = existsSync(
  join(REAL_RERANKER_CACHE_DIR, DEFAULT_RERANKER_MODEL, DEFAULT_RERANKER_MODEL_REVISION, "config.json"),
);

function candidate({ documentId, version = 1, retrievalMode, snippet = "text", normalizedScore = 0.5 }) {
  return {
    documentId,
    version,
    retrievalMode,
    snippet,
    normalizedScore,
    source: { sessionId: "session-1" },
  };
}

function fakeClient(scoreFn) {
  const calls = [];
  return {
    calls,
    metadata: Object.freeze({ id: "fake", revision: "test" }),
    async score(query, passages) {
      calls.push({ query, passages });
      return scoreFn(query, passages);
    },
    async close() {},
  };
}

test("truncateCenteredTokens returns the input unchanged when already within budget", () => {
  assert.equal(truncateCenteredTokens("short text", 256), "short text");
  assert.equal(truncateCenteredTokens(undefined, 256), "");
});

test("truncateCenteredTokens trims from the center outward, preserving the middle of a long text", () => {
  const long = `${"a".repeat(200)}MIDDLE${"b".repeat(200)}`;
  const trimmed = truncateCenteredTokens(long, 10);
  assert.ok(trimmed.length < long.length, "must actually shrink an over-budget text");
  assert.ok(trimmed.includes("MIDDLE") || trimmed.length === 0, "keeps content nearest the center");
});

test("LocalReranker is a no-op when disabled, returning the identical candidate array", async () => {
  const reranker = new LocalReranker({ enabled: false });
  const candidates = [candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" })];
  const result = await reranker.rerank("query", candidates);
  assert.equal(result, candidates, "disabled reranker must return the same array reference");
});

test("LocalReranker never constructs a worker client until the first rerank() call (no daemon-start blocking)", async () => {
  const reranker = new LocalReranker({ enabled: true, model: "m", revision: "r", cachePath: "/tmp/x" });
  assert.equal(reranker.client, undefined, "constructing LocalReranker must not create a worker");
  await reranker.close();
  assert.equal(reranker.client, undefined, "close() before any rerank() must not create a worker either");
});

test("LocalReranker reorders only the lexical/semantic tier, leaving exact/structural candidates' positions untouched", async () => {
  const client = fakeClient((query, passages) => passages.map((passage) => passage.length));
  const reranker = new LocalReranker({ enabled: true, client });
  const candidates = [
    candidate({ documentId: "exact-1", retrievalMode: "exact" }),
    candidate({ documentId: "structural-1", retrievalMode: "structural" }),
    // Fixture: BM25's top-ranked lexical candidate is the shortest text (weak
    // cross-encoder relevance); a longer, initially-lower-ranked candidate
    // should be promoted above it after rerank -- lexical top-3 misses here.
    candidate({ documentId: "lexical-short", retrievalMode: "lexical", snippet: "x" }),
    candidate({ documentId: "lexical-long", retrievalMode: "lexical", snippet: "xxxxxxxxxx" }),
    candidate({ documentId: "semantic-1", retrievalMode: "semantic", snippet: "xxxxx" }),
  ];
  const result = await reranker.rerank("some query", candidates);
  assert.equal(result[0].documentId, "exact-1", "exact keeps absolute tier precedence");
  assert.equal(result[1].documentId, "structural-1", "structural keeps its tier position");
  // Within the tier-one slot (positions 2..4), the longest-snippet candidate
  // (highest fake score) must now lead.
  const tierOne = result.slice(2).map((entry) => entry.documentId);
  assert.equal(tierOne[0], "lexical-long", "rerank promotes the higher-scored candidate above the BM25 top result");
  assert.deepEqual(new Set(tierOne), new Set(["lexical-short", "lexical-long", "semantic-1"]));
  for (const entry of result.slice(2)) {
    assert.equal(entry.reranked, true, "every tier-one candidate in the window carries rerank provenance");
    assert.equal(typeof entry.rerankScore, "number");
  }
  assert.equal(result[0].reranked, undefined, "exact candidate is never marked reranked");
  assert.equal(result[1].reranked, undefined, "structural candidate is never marked reranked");
});

test("LocalReranker preserves fused input order on tied (or NaN) cross-encoder scores instead of tie-breaking alphabetically", async () => {
  // Constant-score client: q8 saturation and near-duplicate snippets (dedup
  // deliberately runs after rerank) both realistically produce identical
  // scores. The degrade contract promises "the current fused ranking" on a
  // tie, not documentId order -- documentIds are deliberately alphabetically
  // reversed relative to fused (input) order, so an alphabetical tie-break
  // would visibly flip the presented order.
  const client = fakeClient((query, passages) => passages.map(() => 1));
  const reranker = new LocalReranker({ enabled: true, client });
  const candidates = [
    candidate({ documentId: "distractor-12", retrievalMode: "lexical" }),
    candidate({ documentId: "distractor-11", retrievalMode: "lexical" }),
    candidate({ documentId: "distractor-10", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(
    result.map((entry) => entry.documentId),
    ["distractor-12", "distractor-11", "distractor-10"],
    "tied scores must preserve fused input order (stable sort), not fall back to alphabetical documentId order",
  );
  assert.equal(result.every((entry) => entry.reranked === true), true);
});

test("LocalReranker preserves fused input order when the client returns NaN scores", async () => {
  const client = fakeClient((query, passages) => passages.map(() => Number.NaN));
  const reranker = new LocalReranker({ enabled: true, client });
  const candidates = [
    candidate({ documentId: "z-doc", retrievalMode: "lexical" }),
    candidate({ documentId: "a-doc", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(
    result.map((entry) => entry.documentId),
    ["z-doc", "a-doc"],
    "a non-finite score delta must never reorder candidates away from fused input order",
  );
});

test("LocalReranker caps the cross-encoder call at candidateWindow tier-one candidates", async () => {
  const client = fakeClient((query, passages) => passages.map(() => 0));
  const reranker = new LocalReranker({ enabled: true, client, candidateWindow: 2 });
  const candidates = [
    candidate({ documentId: "l1", retrievalMode: "lexical" }),
    candidate({ documentId: "l2", retrievalMode: "lexical" }),
    candidate({ documentId: "l3", retrievalMode: "lexical" }),
  ];
  await reranker.rerank("query", candidates);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].passages.length, 2, "only the first candidateWindow tier-one candidates are scored");
});

test("LocalReranker degrades silently (identical order, no error) when the client throws", async () => {
  const client = fakeClient(() => {
    throw new Error("model not installed");
  });
  const recorded = [];
  const reranker = new LocalReranker({ enabled: true, client, recordError: (error) => recorded.push(error) });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(result.map((entry) => entry.documentId), ["a", "b"], "falls back to the pre-rerank fused order");
  assert.equal(result.every((entry) => entry.reranked === undefined), true);
  assert.equal(recorded.length, 1);
  assert.equal(reranker.status().available, false);
  // A second call must not retry the now-known-unavailable client.
  const second = await reranker.rerank("query", candidates);
  assert.equal(second, candidates);
  assert.equal(client.calls.length, 1, "an unavailable reranker never calls the client again");
});

test("LocalReranker degrades silently when the client returns a mismatched score count", async () => {
  const client = fakeClient(() => [1]); // fewer scores than passages
  const reranker = new LocalReranker({ enabled: true, client });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(result.map((entry) => entry.documentId), ["a", "b"]);
  assert.equal(reranker.status().available, false);
});

test("LocalReranker treats a single score() timeout as transient and does not latch unavailable", async () => {
  const recorded = [];
  const client = fakeClient(() => {
    throw new RerankerTimeoutError("Local reranker request timed out.");
  });
  const reranker = new LocalReranker({ enabled: true, client, recordError: (error) => recorded.push(error) });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(result.map((entry) => entry.documentId), ["a", "b"], "falls back to fused order on a timeout too");
  assert.equal(reranker.status().available, true, "a lone timeout -- likely mid lazy-load -- must not latch the reranker unavailable");
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0] instanceof RerankerTimeoutError);
});

test("LocalReranker latches unavailable only once maxConsecutiveTimeouts consecutive score() calls all time out", async () => {
  const client = fakeClient(() => {
    throw new RerankerTimeoutError("Local reranker request timed out.");
  });
  const reranker = new LocalReranker({ enabled: true, client, maxConsecutiveTimeouts: 3 });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  await reranker.rerank("query", candidates);
  assert.equal(reranker.status().available, true, "1st consecutive timeout must not latch");
  await reranker.rerank("query", candidates);
  assert.equal(reranker.status().available, true, "2nd consecutive timeout must not latch");
  await reranker.rerank("query", candidates);
  assert.equal(reranker.status().available, false, "3rd consecutive timeout (the configured max) latches");
  assert.equal(client.calls.length, 3);
  await reranker.rerank("query", candidates);
  assert.equal(client.calls.length, 3, "a latched reranker never retries, timeout or not");
});

test("LocalReranker resets its consecutive-timeout count on a successful score(), so an isolated timeout never accumulates toward the latch", async () => {
  let callCount = 0;
  const client = fakeClient((query, passages) => {
    callCount += 1;
    if (callCount === 2) return passages.map(() => 1); // one success in between two timeouts
    throw new RerankerTimeoutError("Local reranker request timed out.");
  });
  const reranker = new LocalReranker({ enabled: true, client, maxConsecutiveTimeouts: 2 });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  await reranker.rerank("query", candidates); // timeout #1
  await reranker.rerank("query", candidates); // success -- resets the count
  await reranker.rerank("query", candidates); // timeout #1 again, not #2
  assert.equal(reranker.status().available, true, "the intervening success must reset the consecutive-timeout count");
});

test("LocalReranker never closes a caller-injected client on latch -- only a worker it constructed itself is its own to terminate", async () => {
  let closeCalls = 0;
  const client = fakeClient(() => {
    throw new Error("model not installed");
  });
  client.close = async () => { closeCalls += 1; };
  const reranker = new LocalReranker({ enabled: true, client });
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  await reranker.rerank("query", candidates);
  assert.equal(reranker.status().available, false);
  assert.equal(closeCalls, 0, "an injected test-seam client is not this instance's to close");
});

test("LocalReranker terminates its own worker once a non-timeout failure latches it unavailable", async (t) => {
  const reranker = new LocalReranker({
    enabled: true,
    // The sentinel model id makes the fake worker simulate the pinned model
    // never having been installed, exactly like production would.
    model: FAKE_RERANKER_MISSING_MODEL,
    revision: "fake-revision",
    cachePath: "/tmp/does-not-matter",
    workerUrl: FAKE_WORKER_URL,
  });
  t.after(() => reranker.close());
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  await reranker.rerank("query", candidates);
  assert.equal(reranker.status().available, false);
  assert.equal(
    reranker.client?.terminated,
    true,
    "a load failure must terminate the now-useless worker instead of leaving it running unused until daemon restart",
  );
});

test("LocalReranker.isOperational is false when disabled", () => {
  const reranker = new LocalReranker({ enabled: false });
  assert.equal(reranker.isOperational(), false);
});

test("LocalReranker.isOperational treats a caller-injected client as operational whenever enabled and not latched unavailable", () => {
  const client = fakeClient(() => []);
  const reranker = new LocalReranker({ enabled: true, client });
  assert.equal(reranker.isOperational(), true);
  reranker.unavailable = true;
  assert.equal(reranker.isOperational(), false, "a latched-unavailable reranker is never operational, injected client or not");
});

test("LocalReranker.isOperational is false for a self-constructed worker whose pinned model is not installed on disk, without loading anything", () => {
  const missingCacheDir = mkdtempSync(join(tmpdir(), "context-window-reranker-missing-"));
  try {
    const reranker = new LocalReranker({
      enabled: true,
      model: "some-org/never-installed-model",
      revision: "v1",
      cachePath: missingCacheDir,
    });
    assert.equal(reranker.isOperational(), false);
    assert.equal(reranker.client, undefined, "probing operational status must never construct (let alone load) a worker client");
  } finally {
    rmSync(missingCacheDir, { recursive: true, force: true });
  }
});

test(
  "LocalReranker.isOperational is true for a self-constructed worker whose pinned model files exist on disk",
  { skip: !REAL_RERANKER_MODEL_INSTALLED && "pinned reranker model is not installed in this environment's cache" },
  () => {
    const reranker = new LocalReranker({
      enabled: true,
      model: DEFAULT_RERANKER_MODEL,
      revision: DEFAULT_RERANKER_MODEL_REVISION,
      cachePath: REAL_RERANKER_CACHE_DIR,
    });
    assert.equal(reranker.isOperational(), true);
    assert.equal(reranker.client, undefined, "the operational probe itself must never construct a worker client");
  },
);

test("LocalReranker skips rerank for an empty query or fewer than two tier-one candidates", async () => {
  const client = fakeClient(() => {
    throw new Error("must not be called");
  });
  const reranker = new LocalReranker({ enabled: true, client });
  const single = [candidate({ documentId: "a", retrievalMode: "lexical" })];
  assert.equal(await reranker.rerank("query", single), single);
  const pair = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  assert.equal(await reranker.rerank("", pair), pair);
  assert.equal(await reranker.rerank("   ", pair), pair);
});

test("RerankerWorkerClient round-trips a real worker thread (start, score, shutdown)", async (t) => {
  const client = new RerankerWorkerClient({
    model: "fake-model",
    revision: "fake-revision",
    cachePath: "/tmp/does-not-matter",
    workerUrl: FAKE_WORKER_URL,
  });
  t.after(() => client.close());
  const scores = await client.score("query", ["short", "a much longer passage than the other one"]);
  assert.deepEqual(scores, ["short".length, "a much longer passage than the other one".length]);
  assert.equal(client.metadata.id, "fake-model");
  await client.close();
});

test("RerankerWorkerClient surfaces a worker-side failure (simulated missing model) as a rejected score()", async (t) => {
  const client = new RerankerWorkerClient({
    model: FAKE_RERANKER_MISSING_MODEL,
    revision: "fake-revision",
    cachePath: "/tmp/does-not-matter",
    workerUrl: FAKE_WORKER_URL,
  });
  t.after(() => client.close());
  await assert.rejects(() => client.score("query", ["a", "b"]), /model files not found/);
});

test("LocalReranker wired to a real (fake-worker-backed) client degrades gracefully when the model is absent", async (t) => {
  const reranker = new LocalReranker({
    enabled: true,
    // The sentinel model id makes the fake worker simulate the pinned model
    // never having been installed, exactly like production would.
    model: FAKE_RERANKER_MISSING_MODEL,
    revision: "fake-revision",
    cachePath: "/tmp/does-not-matter",
    workerUrl: FAKE_WORKER_URL,
  });
  t.after(() => reranker.close());
  const candidates = [
    candidate({ documentId: "a", retrievalMode: "lexical" }),
    candidate({ documentId: "b", retrievalMode: "lexical" }),
  ];
  const result = await reranker.rerank("query", candidates);
  assert.deepEqual(result.map((entry) => entry.documentId), ["a", "b"]);
});
