// Archive-echo exclusion: self-anchoring prevention made structural instead of
// guidance-only.
//
// Tool results and tool arguments produced by the archive's own retrieval
// tools quote archived snippets back into the transcript. When those echo
// documents are indexed for retrieval, every later search competes with the
// output of earlier searches: a rare token can rank a search's own echo above
// the source document that contains it (observed in production, where a
// traversal echo outranked the answer-bearing document on an exact-token
// query). Echo documents therefore stay archived, recallable, and protected
// exactly like other documents — inline previews point at their ids — but
// they never enter the retrieval indexes (exact, BM25, structural,
// near-duplicate, importance, semantic).
//
// Deletion is intentionally not gated: retention must still be able to clean
// up postings for echo documents indexed before this exclusion existed, and
// every handler's delete path already no-ops when a document was never
// indexed.
const ARCHIVE_ECHO_TOOL_NAMES = Object.freeze([
  "context_window_search",
  "context_window_gather",
  "context_window_traverse",
  "context_recall",
  "context_window_archive",
  "context_window_supersede",
]);

const ARCHIVE_ECHO_KINDS = new Set(["tool-result", "tool-argument"]);

/**
 * Whether a tool name denotes one of the archive's own retrieval tools,
 * including client-namespaced spellings (for example
 * `mcp__context-window__context_window_search`).
 */
export function isArchiveEchoToolName(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) return false;
  const normalized = toolName.toLowerCase();
  for (const name of ARCHIVE_ECHO_TOOL_NAMES) {
    if (normalized === name) return true;
    if (normalized.endsWith(`__${name}`)
      || normalized.endsWith(`:${name}`)
      || normalized.endsWith(`.${name}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a document (or its admission manifest) is archive echo: a
 * tool-result or tool-argument document whose producing tool is one of the
 * archive's own retrieval tools.
 */
export function isArchiveEchoDocument(document) {
  if (!ARCHIVE_ECHO_KINDS.has(document?.kind)) return false;
  return isArchiveEchoToolName(document?.metadata?.toolName);
}
