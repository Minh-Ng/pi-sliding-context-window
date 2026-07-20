// Builds the --semantic-* CLI arguments passed to a spawned context-windowd
// process. Pulled out of worker.js (which only loads inside a worker thread,
// where top-level `workerData` access makes it unimportable from a plain
// test process) so this plumbing has a directly testable, side-effect-free
// home.
export function semanticLaunchArguments(semantic) {
  if (!semantic?.enabled) return [];
  const args = [
    "--semantic",
    "--semantic-model", semantic.model,
    "--semantic-revision", semantic.revision,
    "--semantic-cache", semantic.cachePath,
    "--semantic-index", semantic.indexPath,
    "--semantic-candidates", String(semantic.candidates),
  ];
  // Omitted unless explicitly set, so the daemon derives dimensions/pooling
  // from --semantic-model via the catalog instead of a stale literal.
  if (semantic.dimensions !== undefined) args.push("--semantic-dimensions", String(semantic.dimensions));
  if (semantic.pooling !== undefined) args.push("--semantic-pooling", semantic.pooling);
  return args;
}
