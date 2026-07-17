import { createHash } from "node:crypto";
import {
  ARCHIVED_EVIDENCE_LABEL,
  EVIDENCE_ROUTES,
  EVIDENCE_ROUTING_GUIDELINES,
  RECALL_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
} from "../../src/evidence-routing.js";

/**
 * Canonical snapshot of model-visible production guidance. Policy-only
 * constants are intentionally excluded because neither adapter injects them.
 */
export function canonicalEffectiveProductionGuidance({
  searchToolDescription = SEARCH_TOOL_DESCRIPTION,
  recallToolDescription = RECALL_TOOL_DESCRIPTION,
  evidenceRoutingGuidelines = EVIDENCE_ROUTING_GUIDELINES,
  archivedEvidenceLabel = ARCHIVED_EVIDENCE_LABEL,
} = {}) {
  return Object.freeze({
    searchToolDescription,
    recallToolDescription,
    evidenceRoutingGuidelines,
    archivedEvidenceLabel,
  });
}

export const EFFECTIVE_PRODUCTION_GUIDANCE = canonicalEffectiveProductionGuidance();
export const EFFECTIVE_PRODUCTION_GUIDANCE_VERSION = "8";

export function hashEffectiveProductionGuidance(guidance = EFFECTIVE_PRODUCTION_GUIDANCE) {
  const canonicalGuidance = canonicalEffectiveProductionGuidance(guidance);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalGuidance)).digest("hex")}`;
}

export const EFFECTIVE_PRODUCTION_GUIDANCE_HASH = hashEffectiveProductionGuidance();

export const HELD_OUT_EVALUATION_INSTRUCTIONS = "Held-out evidence-routing evaluation. Return exactly 20 lines `heldout-NNN: route`; route must be archive/live/both/neither. Do not inspect repository files. Do not explain.\nPolicy: archive for older intent/rationale/wording/decisions; live for current mutable files/runtime/config/tests/tasks; historical framing alone does not make archive material for an exclusively current question; both when older intent and current inspection are both required; neither when evidence is already in this prompt/recent context or neither project source is needed. Avoid speculative archive search.";



export const REFERENCE_EVALUATION_INSTRUCTIONS = "Reference-detection evidence-routing evaluation. Return exactly 20 lines `reference-NNN: route`; route must be archive/live/both/neither. Do not inspect repository files. Do not explain.\nPolicy: a request names a concept whose location may be unknown. Route archive when the referent is out-of-window prior wording/intent/decisions/rejected approaches; live when the question is whether a named concept currently exists or behaves in the checkout (files/symbols/config/runtime); both when the referent's location is genuinely ambiguous (could be prior conversation or the repository) or requires reconciling past intent with current state — probe both to locate rather than assuming; neither when the named concept is already visible in this prompt/recent context or is general knowledge. Naming a concept never by itself implies it is archived; do not assume archive for something that may be current repository state.";

export const JARGON_EVALUATION_INSTRUCTIONS = "Continuity-marker evidence-routing evaluation. Return exactly 20 lines `jargon-NNN: route`; route must be archive/live/both/neither. Do not inspect repository files. Do not explain.\nPolicy: a continuity marker confirms only that eligible earlier discussion matched the quoted exact anchor from the current user message; it does not recover a definition, decision, assertion, or current fact. When prior project-specific meaning is material, route archive and search that exact anchor before using it. Questions exclusively about current repository or runtime state remain live, mixed historical-and-current questions remain both, and self-contained or general-knowledge questions remain neither. Without a marker, route both when a project term's location is genuinely ambiguous between rotated-out conversation and the repository. Archive-only terminology must not be treated as already-shared vocabulary.";

export const INTERNALIZED_EVALUATION_INSTRUCTIONS = "Internalized evidence-routing evaluation. Return exactly 20 lines `internalized-NNN: route`; route must be archive/live/both/neither. Do not inspect repository files. Do not explain. No routing policy is provided: apply your own judgment about which evidence source each case requires.";

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function hashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function benchmarkCase(id, prompt, expectedRoute, annotation) {
  return Object.freeze({ id, prompt, expectedRoute, annotation });
}

function continuityMarker(anchor) {
  return `[Continuity marker: eligible earlier discussion matched exact current-message anchor ${JSON.stringify(anchor)}; no archived assertion was recovered.] `;
}

/**
 * The original tuned cases. These are regression checks only: all twenty were
 * used while refining the anti-framing policy and cannot provide independent
 * evidence of generalization. Ordering is fixed, interleaved, and non-cyclic.
 */
export const EVIDENCE_ROUTING_REGRESSION_SUITE = Object.freeze([
  benchmarkCase("regression-001", "What exact acceptance criteria did I give when I first described this feature?", EVIDENCE_ROUTES.ARCHIVE, "The requested wording predates the recent context and must come from the historical record."),
  benchmarkCase("regression-002", "Look through our old discussion if useful, then tell me which Node version this package requires today.", EVIDENCE_ROUTES.LIVE, "The request is about the current package declaration; the invitation to search history does not make history material."),
  benchmarkCase("regression-003", "Does the implementation currently match the behavior we agreed on before the context rotated?", EVIDENCE_ROUTES.BOTH, "Recover the earlier agreement first, then inspect current implementation and reconcile any difference."),
  benchmarkCase("regression-004", "Turn the acceptance criteria quoted two messages above into a checklist without looking elsewhere.", EVIDENCE_ROUTES.NEITHER, "The requested evidence is explicitly available in recent active context, so retrieval would be redundant."),
  benchmarkCase("regression-005", "Was the empty-input edge case part of my original request, and is it covered in the tests now?", EVIDENCE_ROUTES.BOTH, "Recover historical scope first, then inspect current test coverage; neither source answers both parts."),
  benchmarkCase("regression-006", "The task card says documentation was optional, but I think I required it. Settle that from my original message.", EVIDENCE_ROUTES.ARCHIVE, "Resolving the scope discrepancy requires the original user message, not a derived task summary."),
  benchmarkCase("regression-007", "The immediately preceding assistant message selected the label both. Repeat that label only.", EVIDENCE_ROUTES.NEITHER, "The answer is supplied in recent active context and requires no archive or live project inspection."),
  benchmarkCase("regression-008", "Which files are modified in the working tree at this moment?", EVIDENCE_ROUTES.LIVE, "Working-tree changes are mutable repository state and require live inspection."),
  benchmarkCase("regression-009", "When we chose a queue over callbacks, what concern made that trade-off worthwhile?", EVIDENCE_ROUTES.ARCHIVE, "The answer is rationale from an earlier design decision and has no mutable-state component."),
  benchmarkCase("regression-010", "Are we still running the backend selected in the design discussion, or has the deployment drifted?", EVIDENCE_ROUTES.BOTH, "Recover the selected backend from historical rationale, then inspect current runtime or deployment state."),
  benchmarkCase("regression-011", "Would the tests pass in the checkout I have open now?", EVIDENCE_ROUTES.LIVE, "Only a live test run can establish test status for the current checkout."),
  benchmarkCase("regression-012", "What does BM25 stand for?", EVIDENCE_ROUTES.NEITHER, "This is general knowledge and needs neither project history nor current project state."),
  benchmarkCase("regression-013", "I remember the server using port 3000. Which port would it bind to under the current configuration?", EVIDENCE_ROUTES.LIVE, "The remembered value is not evidence for current configuration; inspect the live configuration instead."),
  benchmarkCase("regression-014", "Compare the timeout I originally approved with the value in the repository today.", EVIDENCE_ROUTES.BOTH, "Recover the approved historical value first, inspect the current repository value second, then compare."),
  benchmarkCase("regression-015", "Search every old conversation in case something interesting might help later.", EVIDENCE_ROUTES.NEITHER, "There is no material evidence question, so a broad archive search would be speculative."),
  benchmarkCase("regression-016", "Before the context summary was written, which fallback did I explicitly rule out?", EVIDENCE_ROUTES.ARCHIVE, "An explicit rejected approach from before summarization requires archived conversational evidence."),
  benchmarkCase("regression-017", "Which of my initial constraints remain unmet in the current working tree?", EVIDENCE_ROUTES.BOTH, "The initial constraints require archive evidence and their present implementation status requires live inspection."),
  benchmarkCase("regression-018", "Based on everything we have said over time, report which tracked task is in progress right now.", EVIDENCE_ROUTES.LIVE, "Despite the historical framing, current task status is mutable and must come from the live task tracker."),
  benchmarkCase("regression-019", "Did I approve changing the public API, or was that introduced later as an implementation assumption?", EVIDENCE_ROUTES.ARCHIVE, "Approval and original scope are historical facts; current code cannot establish what the user approved."),
  benchmarkCase("regression-020", "Given the JSON {\"enabled\": false} in this message, is enabled true or false?", EVIDENCE_ROUTES.NEITHER, "The complete evidence is supplied in the current message; neither historical retrieval nor live inspection is needed."),
]);

/**
 * Untouched cases reserved for held-out evaluation. Do not use these prompts or
 * annotations to tune routing guidance before recording the evaluation.
 * Ordering is fixed, interleaved, and non-cyclic.
 */
export const EVIDENCE_ROUTING_HELD_OUT_SUITE = Object.freeze([
  benchmarkCase("heldout-001", "In this prompt, the release codename is Juniper. Return the codename without consulting project history or files.", EVIDENCE_ROUTES.NEITHER, "The requested value is fully supplied in the current prompt, so retrieval or inspection would add no evidence."),
  benchmarkCase("heldout-002", "Which audit fields did I ask us to preserve early in the project, and which of them does the logger emit in the checkout now?", EVIDENCE_ROUTES.BOTH, "Recover the historical field requirements, inspect current logger behavior, and reconcile omissions or additions."),
  benchmarkCase("heldout-003", "What exact version of the parser library is resolved by the lockfile in this checkout?", EVIDENCE_ROUTES.LIVE, "The resolved dependency version is mutable checkout state and must be read from the current lockfile."),
  benchmarkCase("heldout-004", "During the planning conversation, why did we postpone browser support rather than include it in the first release?", EVIDENCE_ROUTES.ARCHIVE, "The requested rationale belongs to an earlier planning decision and does not depend on current repository state."),
  benchmarkCase("heldout-005", "An old note calls the generated directory tracked. Is that directory ignored by the repository as it stands now?", EVIDENCE_ROUTES.LIVE, "The old note is framing only; the question is exclusively about the current ignore and working-tree state."),
  benchmarkCase("heldout-006", "For the array [4, 1, 4], how many distinct numbers are present?", EVIDENCE_ROUTES.NEITHER, "This self-contained computation needs neither historical conversation nor current project inspection."),
  benchmarkCase("heldout-007", "What caveat did I attach when I authorized the data migration? Quote it rather than inferring it from the implementation.", EVIDENCE_ROUTES.ARCHIVE, "The exact authorization caveat is historical wording and cannot be established from current implementation artifacts."),
  benchmarkCase("heldout-008", "Did the migration retain the rollback guarantee agreed during review, and does its current implementation actually provide it?", EVIDENCE_ROUTES.BOTH, "Recover the historical rollback guarantee, inspect the current migration, and compare the two sources."),
  benchmarkCase("heldout-009", "A function receives the string `owl`, appends `!`, and returns it. What string does it return?", EVIDENCE_ROUTES.NEITHER, "All facts needed for this hypothetical are in the prompt; no project evidence is material."),
  benchmarkCase("heldout-010", "Which diagnostics does the compiler report for the source tree currently on disk?", EVIDENCE_ROUTES.LIVE, "Compiler diagnostics describe mutable source and tool state, so they require a live compiler or diagnostic run."),
  benchmarkCase("heldout-011", "We previously promised consumers a particular import style. Does the package's current export map still honor that promise?", EVIDENCE_ROUTES.BOTH, "Recover the promised import style, inspect the current package exports, and explicitly reconcile any mismatch."),
  benchmarkCase("heldout-012", "Before implementation began, which naming option did the maintainer reject as likely to confuse users?", EVIDENCE_ROUTES.ARCHIVE, "The rejected naming option and its rationale are historical discussion evidence, not mutable code state."),
  benchmarkCase("heldout-013", "Compare the feature-flag default selected in the design review with the value active in the present deployment.", EVIDENCE_ROUTES.BOTH, "Recover the selected historical default, inspect the live deployment value, and distinguish intent from current state."),
  benchmarkCase("heldout-014", "Did my original delivery deadline include producing a migration script, or was that added afterward?", EVIDENCE_ROUTES.ARCHIVE, "Original scope and later additions must be resolved from historical messages rather than current files."),
  benchmarkCase("heldout-015", "What value does NODE_ENV have in the shell running this evaluation?", EVIDENCE_ROUTES.LIVE, "A current process environment value is mutable live state and cannot be proven from archived discussion."),
  benchmarkCase("heldout-016", "Rewrite the sentence `Retries stop after three attempts` in the passive voice using only the text here.", EVIDENCE_ROUTES.NEITHER, "The transformation is self-contained in the prompt and requires no historical or live project evidence."),
  benchmarkCase("heldout-017", "Which assumption about tenant identifiers did I correct before the conversation was summarized?", EVIDENCE_ROUTES.ARCHIVE, "The corrected assumption predates the active summary and requires historical conversational evidence."),
  benchmarkCase("heldout-018", "Is the latency ceiling approved in our earlier discussion satisfied by a benchmark run against the code now checked out?", EVIDENCE_ROUTES.BOTH, "Recover the approved ceiling first, run or inspect a current benchmark second, then compare the measurements."),
  benchmarkCase("heldout-019", "Without checking this repository, explain whether a JavaScript Set keeps duplicate primitive values.", EVIDENCE_ROUTES.NEITHER, "This is general language knowledge and the prompt explicitly makes project inspection immaterial."),
  benchmarkCase("heldout-020", "What response does the service running from this checkout return for its health endpoint right now?", EVIDENCE_ROUTES.LIVE, "The current service response is mutable runtime behavior and requires live inspection."),
]);

/**
 * Reference-detection held-out suite. Independent from the original held-out
 * suite and untouched at creation. Cases stress out-of-context reference
 * resolution: a concept is named but its location (rotated-out conversation vs
 * current repository) is often ambiguous. Ambiguous-location cases route to
 * `both`; hard negatives name a concept already visible in context (`neither`)
 * or a live code artifact (`live`). Ordering is fixed and non-cyclic.
 */
export const EVIDENCE_ROUTING_REFERENCE_SUITE = Object.freeze([
  benchmarkCase("reference-001", "You named a cache-miss fallback strategy earlier that has since scrolled out of view; what exactly did you call it?", EVIDENCE_ROUTES.ARCHIVE, "The requested name is out-of-window prior wording from earlier conversation and is not derivable from current repository state."),
  benchmarkCase("reference-002", "Whatever we may have said about it, what does the function parseRuntimeLimits actually do in the code right now?", EVIDENCE_ROUTES.LIVE, "The question asks for current behavior of a synthetic code symbol in the checkout, so it must be answered by live inspection, not history."),
  benchmarkCase("reference-003", "You referenced something called rollback policy, but I cannot tell whether that was only our discussion or something defined in the repo.", EVIDENCE_ROUTES.BOTH, "Recover where the generic concept was discussed historically and inspect the current repository to locate it, then reconcile the two sources."),
  benchmarkCase("reference-004", "Two messages ago you used the phrase anchor-based triggering; restate what you meant using only what is already on screen.", EVIDENCE_ROUTES.NEITHER, "The referenced phrase is already visible in the recent context, so neither archived history nor live inspection adds any evidence."),
  benchmarkCase("reference-005", "Before we wrote any code, you and I agreed on a term for the batch-once-per-cycle behavior; what was that agreed name?", EVIDENCE_ROUTES.ARCHIVE, "The agreed synthetic term predates implementation and is historical conversational wording rather than current code or repository state."),
  benchmarkCase("reference-006", "The retry count we settled on earlier in the conversation, is it the same as the value the code uses today?", EVIDENCE_ROUTES.BOTH, "Recover the historically agreed retry count and inspect the current code value, then reconcile whether the two still match."),
  benchmarkCase("reference-007", "Is a configuration key named maxBufferRatio defined anywhere in the repository as it currently stands?", EVIDENCE_ROUTES.LIVE, "Whether a synthetic named key currently exists in the checkout is mutable repository state resolved only by live inspection of the files."),
  benchmarkCase("reference-008", "Right here I define a cold miss as a cache reset that reprocesses the prefix; given only that, is a warm read a cold miss?", EVIDENCE_ROUTES.NEITHER, "The definition needed is supplied in this prompt, so the answer requires neither archived history nor live project inspection."),
  benchmarkCase("reference-009", "You named a warning threshold earlier, something like eighty percent; does the status-panel code actually use that number now?", EVIDENCE_ROUTES.BOTH, "Recover the generic threshold named historically and inspect the current status-panel code, then reconcile the named value against the code."),
  benchmarkCase("reference-010", "What reason did I give for rejecting the sliding-window approach during our discussion before it left the context?", EVIDENCE_ROUTES.ARCHIVE, "A rejected approach and its stated rationale are historical discussion evidence that current repository files do not contain."),
  benchmarkCase("reference-011", "Using only the four routes you listed in this message, archive live both and neither, how many routes are there?", EVIDENCE_ROUTES.NEITHER, "The count is fully determined by content already present in this prompt and needs no historical or live project evidence."),
  benchmarkCase("reference-012", "We may have mentioned a validation matrix; does one actually exist in the checks directory in the checkout today?", EVIDENCE_ROUTES.LIVE, "The present existence of a generic validation artifact is current repository state and must be verified by live inspection rather than memory."),
  benchmarkCase("reference-013", "Restate the exact acceptance wording I used for the lookup feature earlier; it predates the current session summary.", EVIDENCE_ROUTES.ARCHIVE, "The exact earlier acceptance wording is historical text that predates the active summary and is not present in current files."),
  benchmarkCase("reference-014", "I just named the branch feature/refresh-cache-state in this sentence; spell that branch name back to me.", EVIDENCE_ROUTES.NEITHER, "The fictional branch name is explicitly supplied in this prompt, so echoing it requires neither archived history nor live inspection."),
  benchmarkCase("reference-015", "We discussed a naming convention for test groups; does the new group follow it, or does it even exist in the repo yet?", EVIDENCE_ROUTES.BOTH, "Recover the historically discussed naming convention and inspect the current repository for the generic group's existence and conformance."),
  benchmarkCase("reference-016", "What value is retentionCount set to in the configuration on disk right now?", EVIDENCE_ROUTES.LIVE, "A current synthetic configuration value is mutable checkout state that can only be established by reading the live configuration file."),
  benchmarkCase("reference-017", "In general software terms, not referring to anything in this project, what does idempotent mean?", EVIDENCE_ROUTES.NEITHER, "This is general knowledge and the prompt explicitly excludes project sources, so neither archived nor live project evidence is needed."),
  benchmarkCase("reference-018", "When we first scoped this project, which two edge cases did I say were out of scope? Those turns are gone from view.", EVIDENCE_ROUTES.ARCHIVE, "Original out-of-scope items come from earlier messages no longer visible and are historical rather than current repository state."),
  benchmarkCase("reference-019", "Does the storage module currently export a function named lookup in the code on disk?", EVIDENCE_ROUTES.LIVE, "Whether a generic module currently exports a synthetic named function is present repository state resolved by live inspection of the code."),
  benchmarkCase("reference-020", "You used the term buffer threshold; confirm both what we said it should be and what the config sets it to now.", EVIDENCE_ROUTES.BOTH, "Recover the historically stated generic threshold and inspect the current configuration value, then reconcile the two sources."),
]);

/**
 * Continuity-marker regression suite of paired cases. Each pair holds the
 * complete user text constant and varies only the prepended marker. Marker
 * positives route from an ambiguous location (`both`) to exact-anchor history
 * (`archive`); current-only, mixed, self-contained, and general cases do not
 * change route merely because a marker exists. The original retained jargon
 * artifact remains an immutable record of the earlier fixture generation.
 */
export const EVIDENCE_ROUTING_JARGON_SUITE = Object.freeze([
  benchmarkCase("jargon-001", "What does flushGuard mean in this project? Nothing visible defines it.", EVIDENCE_ROUTES.BOTH, "Recover possible historical meaning with archive evidence and inspect current code because the unmarked project term may live in either source."),
  benchmarkCase("jargon-002", `${continuityMarker("drip migration")}Quote what I originally said drip migration meant before it left the visible context.`, EVIDENCE_ROUTES.ARCHIVE, "Exact original wording is historical evidence; the marker locates an anchor but does not itself contain the requested wording."),
  benchmarkCase("jargon-003", "Does the current repository define quorum stitching anywhere?", EVIDENCE_ROUTES.LIVE, "The question is exclusively about current repository contents, which only live inspection can establish."),
  benchmarkCase("jargon-004", "In general distributed-systems terms, what could shadow reindex mean? Do not use project-specific history or files.", EVIDENCE_ROUTES.NEITHER, "The question explicitly requests general knowledge and excludes project history and files."),
  benchmarkCase("jargon-005", "What does sentinel rebase mean in this project? Nothing visible defines it.", EVIDENCE_ROUTES.BOTH, "Recover possible historical meaning with archive evidence and inspect current code because the unmarked project term may live in either source."),
  benchmarkCase("jargon-006", "This message defines soft eviction as dropping cache entries without invalidating readers; given only that definition, is deleting an entry and its readers a soft eviction?", EVIDENCE_ROUTES.NEITHER, "The prompt supplies the complete definition, making archive and live evidence immaterial."),
  benchmarkCase("jargon-007", `${continuityMarker("flushGuard")}What does flushGuard mean in this project? Nothing visible defines it.`, EVIDENCE_ROUTES.ARCHIVE, "The marker resolves the term to prior discussion, but its meaning must still be recovered by an exact-anchor archive search."),
  benchmarkCase("jargon-008", `${continuityMarker("epochGate")}Does an export named epochGate exist anywhere in the code on disk right now?`, EVIDENCE_ROUTES.LIVE, "A continuity marker does not prove current repository state; the exclusively current question remains live."),
  benchmarkCase("jargon-009", `${continuityMarker("shadow reindex")}In general distributed-systems terms, what could shadow reindex mean? Do not use project-specific history or files.`, EVIDENCE_ROUTES.NEITHER, "Prior project usage is immaterial because the question explicitly requests general knowledge only."),
  benchmarkCase("jargon-010", `${continuityMarker("sentinel rebase")}What does sentinel rebase mean in this project? Nothing visible defines it.`, EVIDENCE_ROUTES.ARCHIVE, "The marker proves only a prior match, so an exact-anchor archive search is required to recover the term's meaning."),
  benchmarkCase("jargon-011", "What does carry-forward set mean in this project? Nothing visible defines it.", EVIDENCE_ROUTES.BOTH, "Recover possible historical meaning with archive evidence and inspect current repository state because the unmarked term's location is ambiguous."),
  benchmarkCase("jargon-012", `${continuityMarker("lease fencing")}Here lease fencing means pinning a task to one owner; using only that definition, does assigning two owners break lease fencing?`, EVIDENCE_ROUTES.NEITHER, "The visible definition is sufficient, so the marker must not trigger an immaterial archive search."),
  benchmarkCase("jargon-013", "Quote what I originally said drip migration meant before it left the visible context.", EVIDENCE_ROUTES.ARCHIVE, "The explicit request for exact prior wording requires archive evidence with or without a marker."),
  benchmarkCase("jargon-014", `${continuityMarker("quorum stitching")}Does the current repository define quorum stitching anywhere?`, EVIDENCE_ROUTES.LIVE, "The marker is not current-state evidence, so repository inspection remains authoritative."),
  benchmarkCase("jargon-015", `${continuityMarker("soft eviction")}This message defines soft eviction as dropping cache entries without invalidating readers; given only that definition, is deleting an entry and its readers a soft eviction?`, EVIDENCE_ROUTES.NEITHER, "The prompt contains all material evidence despite the marker."),
  benchmarkCase("jargon-016", "Does the current implementation still match the backfill contract we agreed on?", EVIDENCE_ROUTES.BOTH, "The agreement requires archive evidence and the current implementation requires live inspection."),
  benchmarkCase("jargon-017", "Does an export named epochGate exist anywhere in the code on disk right now?", EVIDENCE_ROUTES.LIVE, "The current export set is mutable repository state."),
  benchmarkCase("jargon-018", "Here lease fencing means pinning a task to one owner; using only that definition, does assigning two owners break lease fencing?", EVIDENCE_ROUTES.NEITHER, "The definition in the prompt supplies all required evidence."),
  benchmarkCase("jargon-019", `${continuityMarker("carry-forward set")}What does carry-forward set mean in this project? Nothing visible defines it.`, EVIDENCE_ROUTES.ARCHIVE, "The marker locates prior discussion but does not recover meaning; search its exact anchor before answering."),
  benchmarkCase("jargon-020", `${continuityMarker("backfill contract")}Does the current implementation still match the backfill contract we agreed on?`, EVIDENCE_ROUTES.BOTH, "The marker cannot replace either historical recovery or live inspection for this mixed question."),
]);

/**
 * Pair map for the jargon suite. `withMarker` is byte-for-byte `markerText`
 * followed by `withoutMarker`; candidate-only terms model neighboring archive
 * vocabulary that must not leak into an answer as familiar terminology.
 */
export const EVIDENCE_ROUTING_JARGON_PAIRS = Object.freeze([
  Object.freeze({ pairId: "pair-flush-guard", term: "flushGuard", archiveOnlyTerm: "writeQueue", markerText: continuityMarker("flushGuard"), withoutMarkerId: "jargon-001", withMarkerId: "jargon-007" }),
  Object.freeze({ pairId: "pair-sentinel-rebase", term: "sentinel rebase", archiveOnlyTerm: "cutover window", markerText: continuityMarker("sentinel rebase"), withoutMarkerId: "jargon-005", withMarkerId: "jargon-010" }),
  Object.freeze({ pairId: "pair-quorum-stitching", term: "quorum stitching", archiveOnlyTerm: "voting braid", markerText: continuityMarker("quorum stitching"), withoutMarkerId: "jargon-003", withMarkerId: "jargon-014" }),
  Object.freeze({ pairId: "pair-shadow-reindex", term: "shadow reindex", archiveOnlyTerm: "mirror sweep", markerText: continuityMarker("shadow reindex"), withoutMarkerId: "jargon-004", withMarkerId: "jargon-009" }),
  Object.freeze({ pairId: "pair-epoch-gate", term: "epochGate", archiveOnlyTerm: "rotation latch", markerText: continuityMarker("epochGate"), withoutMarkerId: "jargon-017", withMarkerId: "jargon-008" }),
  Object.freeze({ pairId: "pair-backfill-contract", term: "backfill contract", archiveOnlyTerm: "repair ledger", markerText: continuityMarker("backfill contract"), withoutMarkerId: "jargon-016", withMarkerId: "jargon-020" }),
  Object.freeze({ pairId: "pair-soft-eviction", term: "soft eviction", archiveOnlyTerm: "reader tombstone", markerText: continuityMarker("soft eviction"), withoutMarkerId: "jargon-006", withMarkerId: "jargon-015" }),
  Object.freeze({ pairId: "pair-carry-forward-set", term: "carry-forward set", archiveOnlyTerm: "retry ledger", markerText: continuityMarker("carry-forward set"), withoutMarkerId: "jargon-011", withMarkerId: "jargon-019" }),
  Object.freeze({ pairId: "pair-drip-migration", term: "drip migration", archiveOnlyTerm: "cohort gates", markerText: continuityMarker("drip migration"), withoutMarkerId: "jargon-013", withMarkerId: "jargon-002" }),
  Object.freeze({ pairId: "pair-lease-fencing", term: "lease fencing", archiveOnlyTerm: "owner epoch", markerText: continuityMarker("lease fencing"), withoutMarkerId: "jargon-018", withMarkerId: "jargon-012" }),
]);

/**
 * Policy-free held-out suite. Unlike the other suites, the instructions state
 * only the output format — no routing policy — so scores measure internalized
 * judgment rather than instructed classification. Cases are built around
 * distractor traps: marker-listing bait on current-state questions, index
 * omission as evidence, surface forms that lie about location, explicit
 * historical disavowal, and in-prompt stipulation that must suppress
 * retrieval. Composition: archive 6, live 6, both 4, neither 4. Untouched at
 * creation; degrades to regression exposure after first inspection.
 */
export const EVIDENCE_ROUTING_INTERNALIZED_SUITE = Object.freeze([
  benchmarkCase("internalized-001", "You listed hydration ledger in the context index earlier, but what I need is the exact sentence I used when I first defined it.", EVIDENCE_ROUTES.ARCHIVE, "Exact original wording is historical conversational evidence; the index entry only locates the archived turn that must be recalled verbatim."),
  benchmarkCase("internalized-002", "The context index lists writeAmp guard under turn-8c2e; given that, does the repository currently contain any code implementing a writeAmp guard?", EVIDENCE_ROUTES.LIVE, "The index listing does not answer the question, which is exclusively about current repository contents and requires live inspection of the checkout."),
  benchmarkCase("internalized-003", "The index lists twin-write window under turn-4d1a, and I want to know both what we agreed it means and whether the migration code honors it today.", EVIDENCE_ROUTES.BOTH, "Recover the historical agreement from the archived turn and inspect the current migration code, then reconcile the intent with today's behavior."),
  benchmarkCase("internalized-004", "A teammate mentioned splice fencing, but they are not in this conversation and we never discussed it; what would splice fencing mean in distributed systems generally?", EVIDENCE_ROUTES.NEITHER, "The prompt rules out project history and asks for general domain knowledge, so neither archived conversation nor live repository inspection is material."),
  benchmarkCase("internalized-005", "The visible context index omits amber path entirely and nothing on screen defines it; conclude where its definition must live and go get it.", EVIDENCE_ROUTES.LIVE, "A visible archive index omitting the term is evidence against an archived origin, so the definition should be sought by live inspection of the repository or external sources."),
  benchmarkCase("internalized-006", "Given the index line - turn-5e7b \"tune the cache\" — warm set, eviction lag: which of those two terms did we spend more turns debating?", EVIDENCE_ROUTES.ARCHIVE, "The index line only names the terms; how long each was debated is content of the archived turns themselves and requires historical recall."),
  benchmarkCase("internalized-007", "cursorLag shows up in test names in this repo, I think, but it may also have come from our chat; I need to know where it originated before renaming anything.", EVIDENCE_ROUTES.BOTH, "Recover any historical coinage from the archive and inspect current test names, since the identifier's origin is ambiguous between conversation and code."),
  benchmarkCase("internalized-008", "The context index does not mention compaction debt anywhere, and nothing on screen defines it; where should I look to find what compaction debt is here?", EVIDENCE_ROUTES.LIVE, "The index omission is evidence the term is not archived conversation, so the referent should be located by live inspection of the repository or its documentation."),
  benchmarkCase("internalized-009", "In this sentence I stipulate that a ghost read means reading a deleted row; under that stipulation only, is reading a live row a ghost read?", EVIDENCE_ROUTES.NEITHER, "The stipulated definition inside the prompt supplies all needed evidence, so both archived history and live inspection are immaterial to the answer."),
  benchmarkCase("internalized-010", "Did we ever settle whether checkpoint stitching was in scope? I remember arguing about it before those turns rotated away.", EVIDENCE_ROUTES.ARCHIVE, "Whether a disputed scope question was settled, and how, is historical conversational evidence from turns that have rotated out of view."),
  benchmarkCase("internalized-011", "The file docs/soft-launch-checklist.md is open in my editor right now; per that file alone, what is the first unchecked item?", EVIDENCE_ROUTES.LIVE, "Reading the current contents of a named file is mutable checkout state that only live inspection can establish, despite the prose-like vocabulary."),
  benchmarkCase("internalized-012", "I vaguely recall we chose between fan-out replay and something else; which alternative did we reject, and does the winner exist in the code now?", EVIDENCE_ROUTES.BOTH, "Recover the rejected alternative from historical discussion and inspect the current code for the chosen approach, then reconcile the two."),
  benchmarkCase("internalized-013", "Before rotation, I gave a numeric latency budget in milliseconds; state that number exactly as I wrote it.", EVIDENCE_ROUTES.ARCHIVE, "An exact earlier number must be recalled from archived wording rather than reconstructed from memory, since it predates the visible window."),
  benchmarkCase("internalized-014", "You defined quiesce fence two replies up in text that is still on screen; using only that visible definition, restate it.", EVIDENCE_ROUTES.NEITHER, "The definition is present in visible recent context, so restating it requires neither archive retrieval nor live repository inspection."),
  benchmarkCase("internalized-015", "Ignore whatever we said before: right now, does the CI configuration on disk define a job named smoke-replay?", EVIDENCE_ROUTES.LIVE, "The user explicitly disavows history and asks about current configuration contents, which only live inspection of the checkout can answer."),
  benchmarkCase("internalized-016", "Earlier than anything visible here, I renamed one of the milestones; restate the new name I gave it.", EVIDENCE_ROUTES.ARCHIVE, "The renamed milestone is prior wording from rotated-out turns; without a term anchor it still requires searching archived conversation, not current files."),
  benchmarkCase("internalized-017", "We floated two names for the recovery phase and I cannot see either anymore; which name won, and is it what the CLI prints from this checkout?", EVIDENCE_ROUTES.BOTH, "Recover the winning name from historical discussion and inspect the current CLI output or code, then reconcile naming intent with shipped behavior."),
  benchmarkCase("internalized-018", "Quote the definition of retry horizon that appears verbatim in this sentence: a retry horizon is the deadline after which retries stop.", EVIDENCE_ROUTES.NEITHER, "The requested definition is embedded verbatim in the prompt itself, so no archived or live project evidence could add anything material."),
  benchmarkCase("internalized-019", "Something called drainCredits is failing in the test run I just started; what is its current value at runtime?", EVIDENCE_ROUTES.LIVE, "A value in a test run the user just started is current runtime state; recency places it outside the archive and inside live inspection."),
  benchmarkCase("internalized-020", "The index lists backpressure valve under turn-99aa; I only need its meaning as we used it, nothing about the current code.", EVIDENCE_ROUTES.ARCHIVE, "The user explicitly scopes the question to historical usage, so the archived turn is the sole material source and live inspection is excluded."),
]);

/**
 * Per-suite evaluation specs for suites runnable through the record pipeline.
 */
const SUITE_EVALUATION_SPECS = Object.freeze({
  heldout: Object.freeze({ instructions: HELD_OUT_EVALUATION_INSTRUCTIONS, idPrefix: "heldout-" }),
  reference: Object.freeze({ instructions: REFERENCE_EVALUATION_INSTRUCTIONS, idPrefix: "reference-" }),
  jargon: Object.freeze({ instructions: JARGON_EVALUATION_INSTRUCTIONS, idPrefix: "jargon-" }),
  internalized: Object.freeze({ instructions: INTERNALIZED_EVALUATION_INSTRUCTIONS, idPrefix: "internalized-" }),
});

/** Suites whose records embed the recall/precision split score. */
const SPLIT_SCORE_SUITES = new Set(["jargon", "internalized"]);

export const EVIDENCE_ROUTING_SUITES = Object.freeze({
  regression: EVIDENCE_ROUTING_REGRESSION_SUITE,
  heldout: EVIDENCE_ROUTING_HELD_OUT_SUITE,
  reference: EVIDENCE_ROUTING_REFERENCE_SUITE,
  jargon: EVIDENCE_ROUTING_JARGON_SUITE,
  internalized: EVIDENCE_ROUTING_INTERNALIZED_SUITE,
});

/** Return only route-neutral ids and prompts suitable for sending to a model. */
export function evidenceRoutingModelInputs(suiteName) {
  const suite = EVIDENCE_ROUTING_SUITES[suiteName];
  if (!suite) throw new TypeError(`unknown evidence-routing suite: ${String(suiteName)}`);
  return Object.freeze(suite.map(({ id, prompt }) => Object.freeze({ id, prompt })));
}

const EXPOSURES = new Set(["untouched", "regression"]);
const RAW_RESPONSE_PROVENANCE = new Set(["byte-exact", "reconstructed-from-ordered-lines"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * Render the exact held-out tool-call prompt. Conceptual ids remain
 * `heldout-NNN` in orderedModelInputs and responses, but case lines display
 * only `NNN`, matching the presentation used for the retained run.
 */
export function renderEvidenceRoutingEvaluationPrompt(
  orderedModelInputs,
  { instructions = HELD_OUT_EVALUATION_INSTRUCTIONS, idPrefix = "heldout-" } = {},
) {
  if (!Array.isArray(orderedModelInputs) || orderedModelInputs.length !== 20) {
    throw new TypeError("orderedModelInputs must contain exactly 20 inputs");
  }
  const caseLines = orderedModelInputs.map(({ id, prompt }, index) => {
    const expectedId = `${idPrefix}${String(index + 1).padStart(3, "0")}`;
    if (id !== expectedId || typeof prompt !== "string" || prompt === "" || prompt.includes("\n")) {
      throw new TypeError(`orderedModelInputs must use ordered ${idPrefix}NNN ids and single-line prompts`);
    }
    return `${id.slice(idPrefix.length)} ${prompt}`;
  });
  return [instructions, ...caseLines].join("\n");
}

/** Reconstruct the line-oriented response format used by the original runs. */
export function reconstructEvidenceRoutingRawResponse(orderedModelInputs, parsedOrderedLabels) {
  if (!Array.isArray(orderedModelInputs) || !Array.isArray(parsedOrderedLabels)) {
    throw new TypeError("orderedModelInputs and parsedOrderedLabels must be arrays");
  }
  if (orderedModelInputs.length !== parsedOrderedLabels.length) {
    throw new TypeError("orderedModelInputs and parsedOrderedLabels must have equal lengths");
  }
  return orderedModelInputs
    .map(({ id }, index) => `${id}: ${parsedOrderedLabels[index]}`)
    .join("\n");
}

/** Build a self-contained, JSON-serializable eval record. */
export function createEvidenceRoutingEvalRecord({
  timestamp,
  modelIdentifier,
  suite,
  exposure,
  evaluationInstructions,
  orderedModelInputs,
  renderedPrompt,
  rawResponseText,
  rawResponseProvenance,
  parsedOrderedLabels,
  harnessIdentifier,
  harnessRevision,
  harnessSettings,
}) {
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof timestamp !== "string" || !isoTimestamp.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("timestamp must be an ISO-8601 timestamp with a timezone");
  }
  requireNonEmptyString(modelIdentifier, "modelIdentifier");
  requireNonEmptyString(evaluationInstructions, "evaluationInstructions");
  requireNonEmptyString(renderedPrompt, "renderedPrompt");
  requireNonEmptyString(rawResponseText, "rawResponseText");
  requireNonEmptyString(harnessIdentifier, "harnessIdentifier");
  requireNonEmptyString(harnessRevision, "harnessRevision");
  if (!EXPOSURES.has(exposure)) throw new TypeError("exposure must be explicitly set to untouched or regression");
  if (!RAW_RESPONSE_PROVENANCE.has(rawResponseProvenance)) {
    throw new TypeError("rawResponseProvenance must be byte-exact or reconstructed-from-ordered-lines");
  }
  const fixtures = EVIDENCE_ROUTING_SUITES[suite];
  if (!fixtures) throw new TypeError(`unknown evidence-routing suite: ${String(suite)}`);
  const expectedInputs = evidenceRoutingModelInputs(suite);
  if (!Array.isArray(orderedModelInputs) || JSON.stringify(orderedModelInputs) !== JSON.stringify(expectedInputs)) {
    throw new TypeError("orderedModelInputs must exactly match the suite's ordered model-safe inputs");
  }
  const evaluationSpec = SUITE_EVALUATION_SPECS[suite];
  if (!evaluationSpec) {
    throw new TypeError("only the heldout, reference, jargon, and internalized suites are runnable through the eval record pipeline");
  }
  if (evaluationInstructions !== evaluationSpec.instructions) {
    throw new TypeError("evaluationInstructions must exactly match the suite's retained tool call");
  }
  if (renderedPrompt !== renderEvidenceRoutingEvaluationPrompt(orderedModelInputs, evaluationSpec)) {
    throw new TypeError("renderedPrompt must exactly match deterministic reconstruction");
  }
  if (!Array.isArray(parsedOrderedLabels) || !parsedOrderedLabels.every((label) => label === null || typeof label === "string")) {
    throw new TypeError("parsedOrderedLabels must contain only strings or null");
  }
  if (!harnessSettings || typeof harnessSettings !== "object" || Array.isArray(harnessSettings)) {
    throw new TypeError("harnessSettings must be an object");
  }
  if (
    rawResponseProvenance === "reconstructed-from-ordered-lines"
    && rawResponseText !== reconstructEvidenceRoutingRawResponse(orderedModelInputs, parsedOrderedLabels)
  ) {
    throw new TypeError("rawResponseText does not match its ordered-line reconstruction");
  }

  return deepFreeze({
    timestamp,
    modelIdentifier,
    suite,
    exposure,
    evaluationInstructions,
    orderedModelInputs: structuredClone(orderedModelInputs),
    evaluationPayloadHash: hashJson({ evaluationInstructions, orderedModelInputs }),
    renderedPrompt,
    renderedPromptHash: hashText(renderedPrompt),
    rawResponseText,
    rawResponseProvenance,
    parsedOrderedLabels: [...parsedOrderedLabels],
    harness: {
      identifier: harnessIdentifier,
      revision: harnessRevision,
      settings: structuredClone(harnessSettings),
    },
    effectiveProductionGuidanceVersion: EFFECTIVE_PRODUCTION_GUIDANCE_VERSION,
    effectiveProductionGuidanceHash: EFFECTIVE_PRODUCTION_GUIDANCE_HASH,
    score: scoreEvidenceRouting(fixtures.map(({ expectedRoute }) => expectedRoute), parsedOrderedLabels),
    // The split scores are additional fields on newer suites only, so
    // persisted records from older suites still reproduce byte-exactly.
    ...(SPLIT_SCORE_SUITES.has(suite)
      ? {
          archiveRoutingScore: scoreArchiveRequiredRouting(
            fixtures.map(({ expectedRoute }) => expectedRoute),
            parsedOrderedLabels,
          ),
        }
      : {}),
    ...(suite === "jargon" ? { markerPairScore: scoreJargonMarkerPairs(parsedOrderedLabels) } : {}),
  });
}

/** Validate persisted provenance against current fixtures and production guidance. */
export function validateEvidenceRoutingEvalRecord(record, {
  effectiveProductionGuidance = EFFECTIVE_PRODUCTION_GUIDANCE,
  effectiveProductionGuidanceVersion = EFFECTIVE_PRODUCTION_GUIDANCE_VERSION,
} = {}) {
  if (!record || typeof record !== "object") throw new TypeError("record must be an object");
  const expectedHash = hashEffectiveProductionGuidance(effectiveProductionGuidance);
  if (record.effectiveProductionGuidanceVersion !== effectiveProductionGuidanceVersion) {
    throw new Error("effective production guidance version mismatch");
  }
  if (record.effectiveProductionGuidanceHash !== expectedHash) {
    throw new Error("effective production guidance hash mismatch");
  }
  if (record.evaluationPayloadHash !== hashJson({
    evaluationInstructions: record.evaluationInstructions,
    orderedModelInputs: record.orderedModelInputs,
  })) {
    throw new Error("evaluation instructions or ordered inputs hash mismatch");
  }
  if (record.renderedPromptHash !== hashText(record.renderedPrompt)) {
    throw new Error("rendered prompt hash mismatch");
  }
  const reproduced = createEvidenceRoutingEvalRecord({
    timestamp: record.timestamp,
    modelIdentifier: record.modelIdentifier,
    suite: record.suite,
    exposure: record.exposure,
    evaluationInstructions: record.evaluationInstructions,
    orderedModelInputs: record.orderedModelInputs,
    renderedPrompt: record.renderedPrompt,
    rawResponseText: record.rawResponseText,
    rawResponseProvenance: record.rawResponseProvenance,
    parsedOrderedLabels: record.parsedOrderedLabels,
    harnessIdentifier: record.harness?.identifier,
    harnessRevision: record.harness?.revision,
    harnessSettings: record.harness?.settings,
  });
  const reproducedForRecordedGuidance = {
    ...reproduced,
    effectiveProductionGuidanceVersion: record.effectiveProductionGuidanceVersion,
    effectiveProductionGuidanceHash: record.effectiveProductionGuidanceHash,
  };
  if (JSON.stringify(reproducedForRecordedGuidance) !== JSON.stringify(record)) {
    throw new Error("eval record does not reproduce deterministically");
  }
  return true;
}

export function validateEvidenceRoutingArtifact(artifact, options) {
  if (!artifact || !Array.isArray(artifact.records) || artifact.records.length === 0) {
    throw new TypeError("artifact.records must be a non-empty array");
  }
  const validationOptions = options ?? (
    artifact.effectiveProductionGuidance && artifact.effectiveProductionGuidanceVersion
      ? {
          effectiveProductionGuidance: artifact.effectiveProductionGuidance,
          effectiveProductionGuidanceVersion: artifact.effectiveProductionGuidanceVersion,
        }
      : undefined
  );
  for (const record of artifact.records) {
    validateEvidenceRoutingEvalRecord(record, validationOptions);
  }
  return true;
}

/**
 * Score ordered model route labels against ordered expected labels. Missing
 * and invalid outputs in expected positions are incorrect. Extra outputs do
 * not change the expected-case denominator. This helper performs no calls.
 */
export function scoreEvidenceRouting(labels, results) {
  if (!Array.isArray(labels) || !Array.isArray(results)) {
    throw new TypeError("labels and results must be arrays");
  }

  const routes = new Set(Object.values(EVIDENCE_ROUTES));
  for (const label of labels) {
    if (!routes.has(label)) throw new TypeError(`invalid expected route label: ${String(label)}`);
  }

  let correct = 0;
  let missing = 0;
  let invalid = 0;
  const extra = Math.max(0, results.length - labels.length);
  let falseArchiveSearches = 0;

  for (let index = 0; index < labels.length; index += 1) {
    const expected = labels[index];
    const actual = results[index];
    if (actual === undefined || actual === null) {
      missing += 1;
      continue;
    }
    if (!routes.has(actual)) {
      invalid += 1;
      continue;
    }
    if (actual === expected) correct += 1;
    if (
      (actual === EVIDENCE_ROUTES.ARCHIVE || actual === EVIDENCE_ROUTES.BOTH)
      && (expected === EVIDENCE_ROUTES.LIVE || expected === EVIDENCE_ROUTES.NEITHER)
    ) {
      falseArchiveSearches += 1;
    }
  }

  const total = labels.length;
  return Object.freeze({
    total,
    correct,
    incorrect: total - correct,
    accuracy: total === 0 ? 0 : correct / total,
    missing,
    invalid,
    extra,
    falseArchiveSearches,
  });
}

/**
 * Recall/precision split for archive-required routing. Recall (over cases
 * whose expected route requires archive evidence: archive or both) and
 * precision (over the model's archive-implicating answers) are reported
 * separately and deliberately never aggregated into one number: the error
 * costs are asymmetric — a missed archive search is a silent correctness
 * failure, a spurious one is a bounded token cost — and a combined score
 * would let precision gains mask recall regressions.
 */
export function scoreArchiveRequiredRouting(labels, results) {
  if (!Array.isArray(labels) || !Array.isArray(results)) {
    throw new TypeError("labels and results must be arrays");
  }
  const routes = new Set(Object.values(EVIDENCE_ROUTES));
  for (const label of labels) {
    if (!routes.has(label)) throw new TypeError(`invalid expected route label: ${String(label)}`);
  }
  const archiveRequired = (route) => route === EVIDENCE_ROUTES.ARCHIVE || route === EVIDENCE_ROUTES.BOTH;

  let requiredTotal = 0;
  let requiredRouted = 0;
  let searchesTotal = 0;
  let searchesMaterial = 0;
  for (let index = 0; index < labels.length; index += 1) {
    const expected = labels[index];
    const actual = results[index];
    const actualSearches = routes.has(actual) && archiveRequired(actual);
    if (archiveRequired(expected)) {
      requiredTotal += 1;
      if (actualSearches) requiredRouted += 1;
    }
    if (actualSearches) {
      searchesTotal += 1;
      if (archiveRequired(expected)) searchesMaterial += 1;
    }
  }
  return Object.freeze({
    archiveRequiredTotal: requiredTotal,
    archiveRequiredRouted: requiredRouted,
    archiveSearchRecall: requiredTotal === 0 ? 0 : requiredRouted / requiredTotal,
    archiveSearchesTotal: searchesTotal,
    archiveSearchesMaterial: searchesMaterial,
    archiveSearchPrecision: searchesTotal === 0 ? 0 : searchesMaterial / searchesTotal,
  });
}

/**
 * Within-pair marker effect for the jargon suite. Each pair holds all user
 * text constant and varies only continuity-marker visibility, so per-pair
 * correctness deltas isolate the marker's contribution from case difficulty.
 */
export function scoreJargonMarkerPairs(parsedOrderedLabels) {
  if (!Array.isArray(parsedOrderedLabels)) {
    throw new TypeError("parsedOrderedLabels must be an array");
  }
  const indexById = new Map(EVIDENCE_ROUTING_JARGON_SUITE.map((fixture, index) => [fixture.id, index]));
  const pairs = EVIDENCE_ROUTING_JARGON_PAIRS.map(({ pairId, term, withoutMarkerId, withMarkerId }) => {
    const withoutIndex = indexById.get(withoutMarkerId);
    const withIndex = indexById.get(withMarkerId);
    return Object.freeze({
      pairId,
      term,
      withoutMarkerCorrect:
        parsedOrderedLabels[withoutIndex] === EVIDENCE_ROUTING_JARGON_SUITE[withoutIndex].expectedRoute,
      withMarkerCorrect:
        parsedOrderedLabels[withIndex] === EVIDENCE_ROUTING_JARGON_SUITE[withIndex].expectedRoute,
    });
  });
  let bothCorrect = 0;
  let markerVariantOnlyCorrect = 0;
  let baselineVariantOnlyCorrect = 0;
  let bothWrong = 0;
  for (const pair of pairs) {
    if (pair.withoutMarkerCorrect && pair.withMarkerCorrect) bothCorrect += 1;
    else if (pair.withMarkerCorrect) markerVariantOnlyCorrect += 1;
    else if (pair.withoutMarkerCorrect) baselineVariantOnlyCorrect += 1;
    else bothWrong += 1;
  }
  return Object.freeze({
    pairs: Object.freeze(pairs),
    bothCorrect,
    markerVariantOnlyCorrect,
    baselineVariantOnlyCorrect,
    bothWrong,
  });
}

/**
 * Deterministic safety check for terminology visible only in an archive
 * candidate. Omission passes. If a response uses such a term, the sentence
 * introducing it must both define it and identify an archived or live source.
 * This is deliberately a narrow evaluation grammar rather than a general
 * natural-language classifier.
 */
export function assessArchiveOnlyTerminology(responseText, archiveOnlyTerms) {
  if (typeof responseText !== "string") {
    throw new TypeError("responseText must be a string");
  }
  if (
    !Array.isArray(archiveOnlyTerms)
    || !archiveOnlyTerms.every((term) => typeof term === "string" && term.trim() !== "")
  ) {
    throw new TypeError("archiveOnlyTerms must contain non-empty strings");
  }

  const sentences = responseText
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const mentionedTerms = [];
  const violations = [];
  const provenancePattern = /\b(?:(?:archived|earlier|historical) (?:conversation|discussion|evidence|source|turn)|(?:current|live) (?:file|repository|runtime|source))\b/iu;

  for (const term of archiveOnlyTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const termPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
    const definitionPattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])\\s+(?:means|refers to|is (?:a|an|the)\\b)`,
      "iu",
    );
    const termSentences = sentences.filter((sentence) => termPattern.test(sentence));
    if (termSentences.length === 0) continue;
    mentionedTerms.push(term);

    const hasDefinedProvenance = termSentences.some(
      (sentence) => definitionPattern.test(sentence) && provenancePattern.test(sentence),
    );
    if (!hasDefinedProvenance) {
      violations.push(Object.freeze({
        term,
        reason: "archive-only-term-requires-inline-definition-and-provenance",
      }));
    }
  }

  return Object.freeze({
    pass: violations.length === 0,
    mentionedTerms: Object.freeze(mentionedTerms),
    violations: Object.freeze(violations),
  });
}
