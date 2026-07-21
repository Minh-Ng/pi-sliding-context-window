import { isArchiveEchoDocument } from "./echo.js";
import { manifestKeys } from "../manifests.js";
import { documentRecallCount } from "../../retrieval/relevance-feedback.js";

// Unlike BM25_INDEX_VERSION, which is encoded in each posting's key (so old-
// and new-version postings coexist under distinct keys until reindexed), this
// version lives only in the stored record's payload at a version-independent
// key ([IMPORTANCE_KEYSPACE, documentId, version]) and there is no reindex
// path that revisits already-admitted documents. That makes a version bump
// here a strictly one-way, fail-safe degrade rather than a staged rollout:
// documentImportancePrior's version check (below) makes every previously
// indexed document permanently fall back to the neutral multiplier the
// instant this constant changes, with no way to backfill them short of
// re-admitting every document. Acceptable today because the feature is a
// bounded reordering tiebreaker, not a correctness-critical path, but a
// deliberate limitation to keep in mind before bumping this.
export const IMPORTANCE_INDEX_VERSION = 1;
export const IMPORTANCE_KEYSPACE = "importance";

// The prior only reorders near-ties; it must never overrule a strong relevance
// gap. Capping the multiplier at 1.15 means a lower result must be within ~13%
// of the normalized relevance score above it to overtake, which a large gap
// (for example 0.50 vs 0.70) always survives.
export const IMPORTANCE_PRIOR_MAX_MULTIPLIER = 1.15;
const MAX_BOOST = IMPORTANCE_PRIOR_MAX_MULTIPLIER - 1;

const SIGNAL_WEIGHTS = Object.freeze({
  decision: 0.06,
  pinned: 0.06,
  referencedBy: 0.05,
  recall: 0.05,
});
// Counts saturate logarithmically so a runaway reference/recall total cannot
// dominate the bounded boost; 32 is the count that reaches full weight.
const COUNT_SATURATION = 32;

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function countScale(count) {
  const clamped = Math.min(nonNegativeCount(count), COUNT_SATURATION);
  return Math.log2(1 + clamped) / Math.log2(1 + COUNT_SATURATION);
}

/**
 * Extract the query-independent importance signals available intrinsically on
 * a document's own immutable manifest (no store access). Reading only the
 * manifest keeps this half of the signal set a pure function of the canonical
 * record: reprocessing the same manifest always yields the same result, with
 * no dependence on indexing order or on other documents admitted later.
 *
 * referencedByCount here is provenance breadth (distinct source messages this
 * document aggregates); the supersession-chain and recall contributions are
 * store-backed and added by importanceSignalsFor below.
 */
export function importanceSignals(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new TypeError("importanceSignals requires a document manifest.");
  }
  const sourceMessageKeys = Array.isArray(manifest.sourceMessageKeys)
    ? manifest.sourceMessageKeys
    : [];
  return Object.freeze({
    isDecision: manifest.kind === "decision-candidate",
    isPinned: manifest.protectedAtAdmission === true,
    referencedByCount: sourceMessageKeys.length,
    recallCount: 0,
  });
}

/**
 * Count the explicit supersession lineage leading to this document: each hop
 * walks manifest.supersedes back through its predecessor's own manifest. A
 * document that took several revisions to settle is referenced-by that whole
 * chain, so this folds into referencedByCount alongside provenance breadth.
 * Canonical manifests are immutable, so this walk is itself deterministic and
 * replayable; it is bounded the same way count signals saturate below.
 */
async function supersessionChainDepth(view, manifest) {
  let depth = 0;
  let cursor = manifest;
  while (depth < COUNT_SATURATION && cursor?.supersedes !== undefined) {
    const target = cursor.supersedes;
    if (typeof target?.documentId !== "string" || !Number.isSafeInteger(target?.version)) break;
    cursor = await view.get(manifestKeys.document(target.documentId, target.version));
    depth += 1;
  }
  return depth;
}

/**
 * Full importance signal set for one document, including the two store-backed
 * contributions the intrinsic-only importanceSignals above cannot see: the
 * supersession chain depth (KEYSPACE.SUPERSESSION, via manifest.supersedes
 * lineage) and the recalled-after-search tally (FEEDBACK keyspace). Both reads
 * are local, bounded, and involve no model or network calls.
 *
 * A document is indexed exactly once, at admission, before any search or
 * recall of it could possibly have happened, so the recallCount captured
 * here is always 0 and is stored for observability only — it is never the
 * value ranking reads. documentImportancePrior below re-reads the durable
 * recall counter live at query time instead, which is the only way a
 * signal defined as "recalled after search" can ever be non-zero without a
 * reindex path.
 */
export async function importanceSignalsFor(view, manifest) {
  const intrinsic = importanceSignals(manifest);
  const chainDepth = await supersessionChainDepth(view, manifest);
  const recallCount = await documentRecallCount(view, {
    project: manifest.project,
    documentId: manifest.documentId,
    version: manifest.version,
  });
  return Object.freeze({
    ...intrinsic,
    referencedByCount: intrinsic.referencedByCount + chainDepth,
    recallCount,
  });
}

/**
 * Map importance signals to a bounded, query-independent ranking multiplier in
 * [1, IMPORTANCE_PRIOR_MAX_MULTIPLIER]. Pure and deterministic.
 *
 * documentImportancePrior recomputes this from the stored signals rather than
 * trusting the stored `prior` field, so tuning SIGNAL_WEIGHTS/COUNT_SATURATION
 * takes effect for already-indexed documents without a reindex. That only
 * covers within-version tuning: a change to what a signal *means* (for
 * example redefining referencedByCount) is a posting-format change like any
 * other derived index and still needs an IMPORTANCE_INDEX_VERSION bump, the
 * same way BM25_INDEX_VERSION governs postings changes for bm25.js.
 */
export function importancePriorMultiplier(signals = {}) {
  let boost = 0;
  if (signals.isDecision === true) boost += SIGNAL_WEIGHTS.decision;
  if (signals.isPinned === true) boost += SIGNAL_WEIGHTS.pinned;
  boost += SIGNAL_WEIGHTS.referencedBy * countScale(signals.referencedByCount);
  boost += SIGNAL_WEIGHTS.recall * countScale(signals.recallCount);
  const bounded = Math.min(MAX_BOOST, boost);
  return Number((1 + bounded).toFixed(6));
}

/**
 * IndexWorker handler that stores one derived importance record per document.
 * Runs as a batch job on the index worker like the other derived namespaces,
 * versioned via IMPORTANCE_INDEX_VERSION.
 */
export function createImportanceIndexHandler() {
  return Object.freeze({
    id: "importance-v1",
    operations: ["index"],
    async prepare(context) {
      if (isArchiveEchoDocument(context?.manifest)) {
        return { mutations: [], metadata: { skipped: "archive-echo" } };
      }
      const { manifest, view } = context;
      const signals = await importanceSignalsFor(view, manifest);
      const payload = Object.freeze({
        importanceIndexVersion: IMPORTANCE_INDEX_VERSION,
        documentId: manifest.documentId,
        documentVersion: manifest.version,
        project: manifest.project,
        sessionId: manifest.sessionId,
        generation: context.generation,
        outboxSequence: context.outboxSequence,
        ...signals,
        // Stored for observability/metrics; query-time ranking recomputes the
        // multiplier from the signals so a formula change takes effect without
        // reindexing.
        prior: importancePriorMultiplier(signals),
      });
      return {
        mutations: [Object.freeze({
          type: "put",
          key: [IMPORTANCE_KEYSPACE, manifest.documentId, manifest.version],
          kind: "document-importance",
          immutable: false,
          payload,
        })],
        metadata: Object.freeze({ ...signals, prior: payload.prior }),
      };
    },
  });
}

/**
 * Read the stored importance signals for one document version and return its
 * bounded ranking multiplier. Returns the neutral multiplier 1 when no record
 * exists (older documents, or the prior is disabled for this generation).
 *
 * recallCount is intentionally never trusted from the stored record: a
 * document is indexed exactly once, at admission, before any recall of it
 * could possibly have happened, so the stored value is permanently 0 and
 * there is no reindex path that would ever refresh it. That would make the
 * recall signal permanently dead. Instead, when a project boundary is
 * supplied, this reads the durable per-document recall counter
 * (documentRecallCount) live and recomputes the multiplier from it, the same
 * way the stored intrinsic signals are recomputed rather than trusted
 * (see importancePriorMultiplier above). Without a project (legacy callers),
 * this falls back to the stored (typically stale) recallCount.
 */
export async function documentImportancePrior(view, { documentId, version, project } = {}) {
  if (!view || typeof view.get !== "function") {
    throw new TypeError("documentImportancePrior requires a store or snapshot view.");
  }
  identifier(documentId, "documentId");
  positiveInteger(version, "version");
  const record = await view.get([IMPORTANCE_KEYSPACE, documentId, version]);
  if (record === undefined || record.importanceIndexVersion !== IMPORTANCE_INDEX_VERSION) {
    return 1;
  }
  const recallCount = typeof project === "string" && project.length > 0
    ? await documentRecallCount(view, { project, documentId, version })
    : record.recallCount;
  return importancePriorMultiplier({ ...record, recallCount });
}
