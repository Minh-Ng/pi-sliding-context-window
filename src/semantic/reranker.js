import { estimateModelVisibleTokens } from "../session/model-token-budget.js";
import { RerankerWorkerClient } from "./reranker-client.js";
import {
  DEFAULT_RERANKER_CANDIDATE_WINDOW,
  DEFAULT_RERANKER_TEXT_TOKEN_BUDGET,
} from "./reranker-model.js";

// The cross-encoder reorders only the shared lexical/semantic tier (RRF fusion
// tier one in src/retrieval/search.js); exact and structural candidates keep
// their absolute priority-tier precedence and are never passed here.
const RERANKED_MODES = Object.freeze(new Set(["lexical", "semantic"]));

/**
 * Trim `text` to a model-visible token budget centered on its own midpoint,
 * not its start. The upstream snippet a reranked candidate carries is already
 * centered on its best-matching evidence: a BM25 result's snippet is built
 * around the matched term span (src/rocksdb/index/bm25-search.js's
 * snippetForCandidate), and a semantic result's snippet is already one
 * bounded ~160-token span around its embedded chunk (src/semantic/spans.js).
 * Trimming further from that snippet's own center therefore keeps whatever
 * match-centering the upstream snippet already did, without needing to
 * re-locate byte offsets here -- and, unlike trimming from the start, never
 * risks cutting off the matched span entirely on a long candidate.
 */
export function truncateCenteredTokens(text, maxTokens) {
  const value = String(text ?? "");
  if (estimateModelVisibleTokens(value) <= maxTokens) return value;
  const codePoints = Array.from(value);
  const center = Math.floor(codePoints.length / 2);
  let low = 0;
  let high = Math.max(center, codePoints.length - center);
  let best = "";
  while (low <= high) {
    const radius = Math.floor((low + high) / 2);
    const candidate = codePoints
      .slice(Math.max(0, center - radius), Math.min(codePoints.length, center + radius))
      .join("");
    if (estimateModelVisibleTokens(candidate) <= maxTokens) {
      best = candidate;
      low = radius + 1;
    } else {
      high = radius - 1;
    }
  }
  return best;
}

/**
 * Local cross-encoder reranker for explicit search/gather. Mirrors
 * LocalSemanticIndex's degrade contract: the worker loads lazily on first
 * use (never blocking daemon start), and any failure -- model not installed,
 * worker crash, malformed output -- marks the reranker unavailable and falls
 * back silently to the caller's pre-rerank order. Reranking is a ranking
 * refinement only; it must never turn a working search into a failed one.
 */
export class LocalReranker {
  constructor({
    enabled = false,
    model,
    revision,
    cachePath,
    candidateWindow = DEFAULT_RERANKER_CANDIDATE_WINDOW,
    textTokenBudget = DEFAULT_RERANKER_TEXT_TOKEN_BUDGET,
    client,
    // Test-only seam: overrides the worker script RerankerWorkerClient loads,
    // so worker-thread start/message/shutdown lifecycle is exercisable
    // without the pinned model (see test/reranker.test.js and
    // test-support/fake-reranker-worker.js). Production callers never set this.
    workerUrl,
    recordError = () => {},
  } = {}) {
    this.enabled = enabled === true;
    this.model = model;
    this.revision = revision;
    this.cachePath = cachePath;
    this.workerUrl = workerUrl;
    this.candidateWindow = Number.isSafeInteger(candidateWindow) && candidateWindow > 0
      ? candidateWindow
      : DEFAULT_RERANKER_CANDIDATE_WINDOW;
    this.textTokenBudget = Number.isSafeInteger(textTokenBudget) && textTokenBudget > 0
      ? textTokenBudget
      : DEFAULT_RERANKER_TEXT_TOKEN_BUDGET;
    this.client = client;
    this.ownsClient = client === undefined;
    this.recordError = recordError;
    this.unavailable = false;
    this.closed = false;
  }

  #getClient() {
    this.client ??= new RerankerWorkerClient({
      model: this.model,
      revision: this.revision,
      cachePath: this.cachePath,
      ...(this.workerUrl === undefined ? {} : { workerUrl: this.workerUrl }),
    });
    return this.client;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.enabled && !this.unavailable,
      model: this.model,
      revision: this.revision,
      candidateWindow: this.candidateWindow,
    };
  }

  /**
   * Reorder the tier-one (lexical/semantic) candidates in `candidates` by
   * cross-encoder relevance to `query`. Exact/structural candidates, and any
   * tier-one candidate past `candidateWindow`, keep their input position
   * unchanged. Returns the same array reference whenever there is nothing to
   * rerank, so callers can cheaply detect a no-op.
   */
  async rerank(query, candidates) {
    if (!this.enabled || this.closed || this.unavailable) return candidates;
    if (typeof query !== "string" || query.trim().length === 0) return candidates;
    const tierOneIndexes = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (RERANKED_MODES.has(candidates[index].retrievalMode)) tierOneIndexes.push(index);
    }
    if (tierOneIndexes.length <= 1) return candidates;
    const windowIndexes = tierOneIndexes.slice(0, this.candidateWindow);
    const passages = windowIndexes.map((index) => (
      truncateCenteredTokens(candidates[index].snippet, this.textTokenBudget)
    ));
    let scores;
    try {
      scores = await this.#getClient().score(query, passages);
    } catch (error) {
      this.unavailable = true;
      this.recordError(error);
      return candidates;
    }
    if (!Array.isArray(scores) || scores.length !== windowIndexes.length) {
      this.unavailable = true;
      this.recordError(new Error("Local reranker returned a mismatched score count."));
      return candidates;
    }
    const scoreByIndex = new Map(windowIndexes.map((index, position) => [index, scores[position]]));
    // Array.prototype.sort is stable, so returning 0 on a tie (including when
    // either score is non-finite, e.g. NaN) preserves the candidates' input
    // order -- which is exactly the fused ranking the degrade contract
    // promises. Tie-breaking by documentId would instead impose an arbitrary
    // alphabetical order on ties (realistic with near-duplicate snippets,
    // since dedup runs after rerank, and with q8 score saturation).
    const reordered = [...windowIndexes].sort((left, right) => {
      const delta = scoreByIndex.get(right) - scoreByIndex.get(left);
      return Number.isFinite(delta) ? delta : 0;
    });
    const next = candidates.slice();
    reordered.forEach((sourceIndex, position) => {
      const targetIndex = windowIndexes[position];
      const source = candidates[sourceIndex];
      next[targetIndex] = {
        ...source,
        reranked: true,
        rerankScore: scoreByIndex.get(sourceIndex),
      };
    });
    return next;
  }

  async close() {
    this.closed = true;
    if (this.ownsClient) await this.client?.close();
  }
}
