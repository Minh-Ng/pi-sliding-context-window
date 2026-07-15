export const EVIDENCE_ROUTES = Object.freeze({
  ARCHIVE: "archive",
  LIVE: "live",
  BOTH: "both",
  NEITHER: "neither",
});

export const EVIDENCE_ROUTING_POLICY = Object.freeze({
  archive: "Use archived history for prior intent, rationale, exact wording, decisions, rejected approaches, continuity, and scope disputes.",
  live: "Use live tools for current files, runtime behavior, configuration, test results, and task status. Mentioning old discussion or inviting history lookup does not make archive evidence material when the answer is exclusively current mutable state.",
  both: "For mixed questions, recover archived intent first, inspect live state second, and explicitly reconcile conflicts. Live inspection is authoritative for mutable current state.",
  neither: "Do not retrieve when the needed evidence is already in recent context or the question needs neither historical nor live project evidence. Avoid speculative broad archive searches.",
});

export const SEARCH_TOOL_DESCRIPTION =
  "Find historical evidence candidates from earlier context. Trigger a search when the request references a concrete but currently-invisible referent — a named file, symbol, error string, commit or PR, specific value, or a prior decision, agreement, or scope item — that is not present in the visible context, or uses back-references (\"earlier\", \"before\", \"originally\", \"we agreed\", \"that/those\") pointing to content that has rotated out; also search before asserting a specific earlier detail you cannot currently see. Use context_recall on a result id for exact original wording or source evidence. Use live tools—not the archive—for current mutable state. For mixed questions, recover archived intent first, then inspect live state and reconcile conflicts. Historical framing or an invitation to search history does not make archive evidence material for an exclusively current question. Naming a concept does not by itself mean it is archived: when a referent's location is ambiguous (it may be prior conversation or current repository state), probe both rather than assuming the archive. Avoid speculative broad searches; key each search on a concrete anchor (file name, symbol, error text, decision term). For a conceptually phrased historical question without an exact identifier, put 3–8 concise likely synonyms or domain terms in one query so lexical search can match alternate wording. Search exact file names, symbols, error strings, commits, PRs, and specific values verbatim first; do not broaden those anchors. If a conceptually phrased archive-required search misses, make at most one reformulated search with likely alternate wording. An empty result for a well-anchored query is itself routing evidence: treat the referent as live or external and probe repository, docs, or MCP next instead of retrying broader archive searches.";

export const RECALL_TOOL_DESCRIPTION =
  "Recover one exact archived source document by an id from context_window_search or an archive marker. Use for exact original wording or source evidence, not as proof of current mutable state; verify current state with live tools.";

export const EVIDENCE_ROUTING_GUIDELINES = Object.freeze([
  "Use context_window_search to find historical candidates for prior intent, rationale, decisions, rejected approaches, continuity, scope disputes, message history, or original-task evidence not fully visible in recent turns.",
  "Use context_recall—not task records or assistant summaries—when exact original wording or source evidence is required; recall only ids returned by context_window_search or archive markers.",
  "Do not use context_window_search or context_recall as proof of current files, runtime behavior, configuration, tests, or task status; use live tools, and note that historical framing or an invitation to search history does not make archive evidence material for an exclusively current question.",
  "For mixed questions, use context_window_search and, when source precision matters, context_recall to recover archived intent first; then inspect live state and reconcile conflicts, treating live evidence as authoritative for mutable state.",
  "Skip context_window_search and context_recall when evidence is already in recent context or neither historical nor live project evidence is needed; avoid speculative broad archive searches.",
  "Before answering a history-flavored question, classify the needed evidence once: already in the visible context (answer directly), current mutable project state (use live tools), or an out-of-window referent such as prior wording, intent, decision, or rejected approach (use context_window_search); combine archive and live only when both an out-of-window referent and current state are required.",
  "Naming or referencing a concept does not imply it is archived; when you cannot tell whether a named referent lives in rotated-out conversation or in current repository state, treat the location as ambiguous and use both a context_window_search and live inspection to locate it rather than defaulting to an archive-only search, keying the context_window_search on a concrete anchor.",
  "If you are about to quote, cite, or assert a specific earlier detail (a number, name, exact phrasing, or committed decision) that is not visible in the current context, run context_window_search for its anchor before asserting rather than reconstructing it from memory.",
  "When using context_window_search for a conceptually phrased historical question without an exact identifier, include 3–8 concise likely synonyms or domain terms in one query. Search exact file names, symbols, error strings, commits, PRs, and specific values verbatim first; never broaden those anchors. If a conceptual archive-required search misses, make at most one reformulated context_window_search call with likely alternate wording.",
  "Treat an empty context_window_search result for a well-anchored query as routing evidence, not a dead end: the referent is likely live or external, so probe repository, docs, or MCP next instead of retrying broader archive searches.",
]);

export const ARCHIVED_EVIDENCE_LABEL =
  "Archived historical evidence — may be stale about current mutable state; verify live state separately.";
