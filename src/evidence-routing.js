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

export const SEARCH_SCOPE_DESCRIPTION =
  "Search boundary: session includes the current session and verified parent-session lineage within the current project; project includes every archived session for the current project; all includes all evidence authorized to this connection and does not bypass project authorization. Packaged RocksDB connections authorize only the current project.";

export const SEARCH_EFFORT_DESCRIPTION =
  "Retrieval effort for this call only: normal (default) keeps today's gates; wide widens semantic broadening, RM3 expansion, and the candidate pool. Use wide only after a normal search missed or when uncertainty is genuinely high, since it costs latency and tokens.";

const ARCHIVE_STATE_RECONCILIATION_PATTERNS = Object.freeze([
  /\b(?:now|current|currently|latest|newest|still|anymore)\b/iu,
  /\b(?:most\s+recent|no\s+longer|used\s+to)\b/iu,
  /\b(?:change[sd]?|switch(?:ed|es)?|increase[sd]?|decrease[sd]?)\b/iu,
  /\b(?:last|past)\s+(?:\d+\s+)?(?:days?|weeks?|months?|years?)\b/iu,
]);

export const ARCHIVE_STATE_RECONCILIATION_HINT =
  "Time-sensitive archive query: one match may be stale or partial. Inspect every returned snippet and sourceTimestamp before choosing a recall id; do not default to rank 1 when later explicit evidence conflicts. Reconcile only the minimum dated evidence needed, comparing event dates or old→new values. sourceTimestamp orders source messages, not events, and archive evidence does not replace live inspection.";

const CURRENT_MUTABLE_ONLY_PATTERNS = Object.freeze([
  /\b(?:current|latest)\s+(?:repository|repo|working\s+tree|git|branch|files?|runtime|deployment|build|tests?|tasks?|process)\b/iu,
  /\b(?:git|repository|repo|working\s+tree)\s+status\b/iu,
  /\bchanges?\s+to\s+(?:commit|push|deploy|release)\b/iu,
]);

const ARCHIVE_WORKFLOW_GATHER_PATTERNS = Object.freeze([
  /\b(?:as|like)\s+(?:we\s+)?(?:did|used|handled|ran)\s+(?:it\s+)?before\b/iu,
  /\b(?:same|previous|prior|earlier)\s+(?:process|procedure|workflow|steps|sequence|setup)\b/iu,
  /\b(?:repeat|reuse|resume|follow)\b.{0,48}\b(?:process|procedure|workflow|steps|sequence)\b/iu,
  /\bhow\s+(?:did|do)\s+we\b.{0,64}\b(?:before|previously|last\s+time)\b/iu,
]);

export function archiveStateReconciliationSuggested(query) {
  if (typeof query !== "string") return false;
  const text = query.trim();
  return text.length > 0 && ARCHIVE_STATE_RECONCILIATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function archiveGatherSuggested(query) {
  if (typeof query !== "string") return false;
  const text = query.trim();
  if (text.length === 0) return false;
  if (ARCHIVE_WORKFLOW_GATHER_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return archiveStateReconciliationSuggested(text)
    && !CURRENT_MUTABLE_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

export const ARCHIVE_GATHER_TURN_GUIDANCE =
  "This turn asks for historical state reconciliation or reuse of a prior multi-turn workflow. Prefer context_window_gather over manually chaining search snippets. Choose intent=state for dated values or changes and intent=workflow for a prior procedure. Treat the returned packet as historical evidence, preserve chronology and uncertainty, and still verify mutable repository or deployment state with live tools.";

export const GATHER_TOOL_DESCRIPTION =
  "Gather a bounded packet of exact archived evidence for a historical question that may span multiple related records or surrounding turns. Use intent=state for dated values, latest/previous claims, or change over time. Use intent=workflow when reusing a prior process whose later messages may refine the initial instructions. The operation runs hybrid candidate retrieval, resolves exact source turns, expands a bounded neighborhood on the verified session lineage, orders evidence chronologically, and reports truncation. When you are already acting on specific files, symbols, or identifiers, pass their exact names in workingSet to nudge ranking toward evidence whose own exact anchors match that working set, without overriding a clearly stronger match. Prefer this over manually chaining search, recall, and traversal for ordinary historical synthesis; use the low-level tools for precise investigations or continuation beyond the packet. Archive evidence is not proof of current mutable files, deployments, credentials, or task state; inspect those live. Pass searchEffort=wide only after a normal gather missed or when uncertainty is genuinely high; it widens retrieval and costs latency and tokens.";

export const SEARCH_TOOL_DESCRIPTION =
  "Find historical evidence candidates from earlier context. Trigger a search when the request references a concrete but currently-invisible referent — a named file, symbol, error string, commit or PR, specific value, or a prior decision, agreement, or scope item — that is not present in the visible context, or uses back-references (\"earlier\", \"before\", \"originally\", \"we agreed\", \"that/those\") pointing to content that has rotated out; also search before asserting a specific earlier detail you cannot currently see. When a project-specific term is not defined in visible context and you are about to search the repository, documentation, web, or another live source to understand it, also search the archive for that exact term and treat its origin as ambiguous until archived and live evidence resolve it. A continuity marker confirms only that eligible earlier discussion matched an exact anchor copied from the current user message. When the answer depends on that prior project-specific meaning, search the marker's exact anchor before using it; the marker is not evidence that any archived assertion is true. Use context_recall on a result id for exact original wording or source evidence. Use live tools—not the archive—for current mutable state. For mixed questions, recover archived intent first, then inspect live state and reconcile conflicts. Historical framing or an invitation to search history does not make archive evidence material for an exclusively current question. Naming a concept does not by itself mean it is archived: when a referent's location is ambiguous (it may be prior conversation or current repository state), probe both rather than assuming the archive. Avoid speculative broad searches; key each search on a concrete anchor (file name, symbol, error text, decision term). For a conceptually phrased historical question without an exact identifier, keep the original phrasing in query and put 3–8 concise likely synonyms or domain terms in expansionTerms so lexical search can match alternate wording without distorting local semantic matching. When you are already acting on specific files, symbols, or identifiers, pass their exact names in workingSet: it only nudges ranking toward evidence whose own exact anchors match that working set and never overrides a clearly stronger match or surfaces anything the query itself did not already find. Search exact file names, symbols, error strings, commits, PRs, and specific values verbatim first; do not broaden those anchors. If a conceptually phrased archive-required search misses, make at most one reformulated search with likely alternate wording. An empty result for a well-anchored query is itself routing evidence: treat the referent as live or external and probe repository, docs, or MCP next instead of retrying broader archive searches. When a plausible result appears, use context_recall on its short result id before issuing more query variants; do not fan out redundant searches or repeatedly recall the same id. When an archive-backed question asks for latest/current state, a rolling time window, or a change over time, preserve temporal qualifiers such as now/latest/last N/change in the search query, inspect every returned candidate before choosing a recall id, and do not default to rank 1 when later explicit evidence conflicts. For latest/current state, recall the newest relevant candidate when its snippet is truncated or omits the requested value before accepting an older explicit value. Do not treat one candidate or continuity marker as sufficient if competing relevant records may exist: recall only the minimum distinct value-bearing candidates needed to reconcile the state, compare explicit event dates or old→new values, and preserve uncertainty. Source timestamps order messages, not necessarily events; this archive rule never replaces live inspection for current mutable project state. Pass searchEffort=wide only after a normal search missed or when uncertainty is genuinely high; it widens retrieval and costs latency and tokens.";

export const RECALL_TOOL_DESCRIPTION =
  "Recover one exact archived source document by a short id from context_window_search or an archive marker. Use for exact original wording or source evidence, not as proof of current mutable state; verify current state with live tools. After recall, preserve the concrete user-specific entities relevant to the question instead of relying on a generic category or an implied detail.";

export const TRAVERSE_TOOL_DESCRIPTION =
  "Inspect a bounded chronological page before or after an archived anchor returned by context_window_search or a prior traversal. Use for temporal questions when the needed event is defined relative to a known anchor and its vocabulary is unknown. Start with up to 128 records when the distance is unknown, then traverse from the oldest/newest result handle to continue paging; do not guess answer-specific terms.";

export const SUPERSEDE_TOOL_DESCRIPTION =
  "Mark a prior archived decision or document as superseded by a correction. Use when the user reverses an earlier decision so search and automatic retrieval stop treating the old version as live. Prefer writing durable constraints into the repository (AGENTS.md, ADR, config) rather than pinning archive records. This removes the old version from search and is itself hard to reverse; search for the subject's prior decisions or constraints first if that has not already happened this turn.";

export const EVIDENCE_ROUTING_GUIDELINES = Object.freeze([
  "Before answering, classify the evidence needed: already in visible context (answer directly), current mutable project state (use live tools), or an out-of-window referent such as prior intent, rationale, decisions, rejected approaches, continuity, or scope disputes (use context_window_search); combine archive and live only when both are required.",
  "Use context_recall—not task records or assistant summaries—when exact original wording or source evidence is required; recall only ids returned by context_window_search or archive markers.",
  "Do not use context_window_search or context_recall as proof of current files, runtime behavior, configuration, tests, or task status; use live tools, and note that historical framing or an invitation to search history does not make archive evidence material for an exclusively current question.",
  "For mixed questions, use context_window_search and, when source precision matters, context_recall to recover archived intent first; then inspect live state and reconcile conflicts, treating live evidence as authoritative for mutable state.",
  "Skip context_window_search and context_recall when evidence is already in recent context or neither historical nor live project evidence is needed; avoid speculative broad archive searches. Treat an empty result for a well-anchored query as routing evidence that the referent is likely live or external—probe repository, docs, or MCP next rather than retrying broader searches.",
  "Naming a concept does not imply it is archived; when a referent's location is ambiguous between rotated-out conversation and current repository state, use both context_window_search and live inspection to locate it. When a project-specific term is not defined in visible context and you are about to search the repository, documentation, web, or another live source to understand it, also run context_window_search for the exact term, treating its origin as ambiguous until archived and live evidence resolve it.",
  "Before you quote or assert a specific earlier detail (a number, name, exact phrasing, or committed decision) not visible in the current context, run context_window_search for its anchor rather than reconstructing it from memory. A continuity marker only confirms that eligible earlier discussion matched the quoted anchor from the current user message; if prior project-specific meaning is material, search that exact anchor before answering, and do not treat the marker itself as a recovered fact, decision, definition, or current-state claim.",
  "Do not introduce terminology found only in an archive candidate returned by context_window_search or context_recall as if the user already knows it. Omit it unless it is necessary; when necessary, define it in plain language and identify whether it came from archived discussion or a live source.",
  "When context_window_search has no exact identifier for a conceptually phrased historical question, preserve the original phrasing in query and include 3–8 concise likely synonyms or domain terms in expansionTerms; search exact file names, symbols, error strings, commits, PRs, and specific values verbatim first and never broaden those anchors. If a conceptual archive-required search misses, make at most one reformulated context_window_search call with likely alternate wording.",
  "For ordinary archive-backed questions whose answer may span multiple dated records or surrounding turns—especially latest/current changes and reuse of a prior workflow—prefer context_window_gather so retrieval, exact expansion, and ordering happen in one bounded operation. Use intent=state for dated values and intent=workflow for procedures refined in following messages. Use context_window_search plus context_recall for precise single-anchor investigations or when gather is unavailable.",
  "When context_window_search returns a plausible conceptual match, call context_recall on one distinct short result id before searching again; avoid parallel query variants and duplicate recalls, then preserve every concrete recalled entity that is materially relevant to the answer. When an archive-backed question asks for latest/current state, a rolling time window, or a change over time, preserve temporal qualifiers such as now/latest/last N/change in the search query, inspect every returned candidate before choosing a recall id, and do not default to rank 1 when later explicit evidence conflicts. For latest/current state, recall the newest relevant candidate when its snippet is truncated or omits the requested value before accepting an older explicit value. Do not treat one candidate or continuity marker as sufficient if competing relevant records may exist: recall only the minimum distinct value-bearing candidates needed to reconcile the state, compare explicit event dates or old→new values, and preserve uncertainty. Source timestamps order messages, not necessarily events; this archive rule never replaces live inspection for current mutable project state.",
  "For a before/after question whose answer vocabulary is unknown, find the named anchor with context_window_search, then request up to 128 records from context_window_traverse and page chronologically from the boundary result until the relevant prior/next event is visible; do not guess candidate answer terms.",
  "When the user reverses a prior archived decision, call context_window_supersede (or admit the new decision with supersedes) so the old version leaves search; do not leave both as equal live hits.",
  "When a durable project fact or decision is settled (a chosen value, name, convention, or agreed constraint), archive it explicitly under a stable subjectKey so one live document per subject stays retrievable by context_window_search; unkeyed turn history recalls settled facts poorly because only decision-shaped phrasing is distilled. On a later correction, call context_window_supersede or re-archive with supersedes targeting the live document so the outdated value leaves search instead of remaining a second live hit.",
  "When a decision or constraint must outlive the archive retention window (cross-session process, security, standing project rule), write it into the repository (AGENTS.md, CLAUDE.md, ADR, or config). The archive is provenance, not the system of record; do not pin archive documents for longevity.",
  "Route a user-scoped fact that holds across projects (a standing preference, personal workflow, or cross-repository convention) to the host's own memory mechanism (Claude Code memory, Pi settings), not this project-partitioned archive and not the repository (AGENTS.md, CLAUDE.md), since neither carries it to the next project.",
  "If context_window_search reports matching documents expired by retention, treat that as evidence the topic was discussed and later aged out of eligibility—not as proof it was never discussed. The count and retention class are the only disclosed detail; do not guess or assert the expired content itself.",
  "Before a destructive or hard-to-reverse action (deleting or overwriting non-trivial state, redaction, superseding a live decision, migrations, force operations), run one targeted context_window_search for a decision or constraint about the action's subject, keyed on its subjectKey or exact anchors; an empty result clears the action, a match must be reconciled before proceeding.",
]);

export const ARCHIVED_EVIDENCE_LABEL =
  "Archived historical evidence — may be stale about current mutable state; verify live state separately.";
