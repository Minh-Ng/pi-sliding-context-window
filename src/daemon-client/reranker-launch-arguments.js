// Builds the --reranker-* CLI arguments passed to a spawned context-windowd
// process. Mirrors semantic-launch-arguments.js (see that file for why this
// is pulled out of worker.js into a directly testable, side-effect-free
// module).
export function rerankerLaunchArguments(reranker) {
  if (!reranker?.enabled) return [];
  return [
    "--reranker",
    "--reranker-model", reranker.model,
    "--reranker-revision", reranker.revision,
    "--reranker-cache", reranker.cachePath,
    "--reranker-candidates", String(reranker.candidateWindow),
  ];
}
