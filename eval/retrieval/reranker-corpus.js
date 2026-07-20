import { createHash } from "node:crypto";

// Rank-sensitive reranker corpus for the deferred cross-encoder decision
// (task #2). Every case is a hard lexical-distractor scene: the target
// document genuinely answers a natural-language question, while several
// distractors flood the same query vocabulary (repeated terms, near-identical
// tool outputs, decisions buried under boilerplate) so BM25 term-frequency
// dominance and query-time recency decay push the true answer out of the fused
// top-3 even though it stays high in the BM25 ranking. The material is drawn
// from the same archive themes the frozen retrieval fixture exercises
// (content-addressed dedup, provider cache prefixes, tombstone compaction,
// migration checkpoints, near-identical test runs, buried build-log decisions).
//
// The intended hardness is asserted empirically at run time, not assumed:
// reranker-eval.js verifies each target is inside the BM25 top-50 and outside
// the fused top-3 before scoring, and records the observed ranks in the
// artifact. Text here is tuned against that observation, never hand-waved.

const DAY_MS = 24 * 60 * 60 * 1_000;

// A fixed evaluation clock so recency decay and admission ages are
// reproducible across machines and re-runs.
export const RERANKER_EVALUATION_NOW = Date.UTC(2026, 6, 18, 12, 0, 0);

const PROJECT = "/fixture/reranker";
const SESSION = "session-main";

// Distractors are minutes old (recency decay barely touches them); targets are
// weeks old but comfortably inside the 90-day conversation-source retention
// lifetime, so decay demotes the true answer in fusion without expiring it.
function recentAt(index) {
  return RERANKER_EVALUATION_NOW - ((index + 1) * 5 * 60 * 1_000);
}

function agedAt(days) {
  return RERANKER_EVALUATION_NOW - (days * DAY_MS);
}

// Each case: a query, one answering target (aged), and lexical distractors
// (recent, dense in query terms, non-answering). targetAgeDays defaults to a
// value that keeps the target inside retention while giving decay room to work.
const CASES = [
  {
    id: "rank-dedup",
    query: "Why does storing the same large tool result in two different turns not double its bytes on disk?",
    targetAgeDays: 30,
    target:
      "Decision: the archive stores each tool result as content-addressed immutable chunks keyed by their content hash, so when two different turn manifests reference the identical large tool result they both point at the same stored chunk and the payload bytes are written to disk exactly once.",
    distractors: [
      "The tool result viewer paginates large tool result output so a single turn never renders more than a few kilobytes of tool result bytes into the visible transcript at one time.",
      "When a tool result is larger than the chunk target size the indexer splits the tool result into several chunks and writes one turn manifest entry per tool result chunk.",
      "Disk usage for tool result chunks is reported per turn so an operator can see which turns wrote the most tool result bytes to disk during a session.",
      "A duplicated tool result stored in two different turns still appears twice in tool result search results because each turn keeps its own manifest entry on disk.",
      "Large tool result bytes are compressed before the chunks are written to disk, so the stored tool result is smaller on disk than the tool result bytes the turn produced.",
    ],
  },
  {
    id: "rank-cache-prefix",
    query: "What keeps the provider prompt cache prefix valid after we reconstruct earlier context?",
    targetAgeDays: 26,
    target:
      "Decision: a reconstructed historical hint is re-emitted byte-for-byte in the exact position it originally occupied, because the provider prompt cache prefix is keyed on an exact byte match and any reordering or rewording of the reconstructed prefix would invalidate the cached prefix and force a full recompute.",
    distractors: [
      "The provider prompt cache prefix length is logged on every request so we can chart how much of each reconstructed context prefix was served from the provider cache.",
      "When the reconstructed context prefix exceeds the model window we drop the oldest reconstructed turns first, before touching anything newer in the provider prompt prefix.",
      "The provider prompt cache prefix is warmed by a background request that replays the reconstructed context prefix so the first real user turn hits a warm provider cache.",
      "Reconstructed context prefixes are rendered with the same template as live turns, so a reader cannot tell a reconstructed provider prefix turn from a live one.",
      "Cache prefix metrics separate provider cache hits on the reconstructed prefix from provider cache hits on the live suffix of the prompt.",
    ],
  },
  {
    id: "rank-compaction",
    query: "How is physical disk space actually reclaimed after keys are tombstoned?",
    targetAgeDays: 34,
    target:
      "Decision: tombstoning a key only writes a logical delete marker immediately; the physical disk space is reclaimed later by RocksDB background compaction, which rewrites the affected SST ranges and drops the tombstoned keys, so there is no synchronous byte cap enforced at delete time.",
    distractors: [
      "Tombstoned keys are counted in a per-session metric so an operator can watch how many tombstones are waiting for background compaction to reclaim their disk space.",
      "A tombstone marker carries the retention class of the key it deletes so background compaction can prioritise reclaiming disk space for shorter-lived retention classes first.",
      "When a range is tombstoned the read path still scans the tombstoned keys until compaction removes them, which is why heavily tombstoned ranges read more slowly before disk is reclaimed.",
      "The compaction scheduler logs how much physical disk space each background compaction reclaimed from tombstoned SST ranges during the last maintenance window.",
      "Manual compaction can be triggered to reclaim tombstoned disk space early, but the routine path leaves reclamation to background compaction on its own schedule.",
    ],
  },
  {
    id: "rank-migration",
    query: "What makes the storage migration checkpoint safe to resume after a crash?",
    targetAgeDays: 28,
    target:
      "Decision: each imported migration batch durably records its own source fingerprint and a monotonic cursor before the checkpoint advances, so a crash mid-migration resumes from the last committed cursor and re-imports no batch twice, which is what makes the migration checkpoint restart-safe.",
    distractors: [
      "The migration checkpoint progress bar is redrawn every imported batch so an operator watching the migration can estimate how long the remaining checkpoint batches will take.",
      "A migration checkpoint writes a summary row per imported batch into a report table so the migration can be audited long after the checkpoint has finished.",
      "The migration checkpoint runs in a dual-write phase where the source database stays readable, so a stalled migration checkpoint never blocks live reads of the source.",
      "Migration checkpoint throughput is throttled when the source database is under load, so the migration batches back off instead of starving live source queries.",
      "The migration checkpoint verifies each imported batch row count against the source before advancing, and logs a mismatch without altering the source database.",
    ],
  },
  {
    id: "rank-flaky-test",
    query: "Which retrieval-search suite run actually hit the intermittent leased-locator recall timeout failure?",
    targetAgeDays: 22,
    target:
      "Tool result: retrieval-search suite run 5 of 8. The leased-locator recall timeout test hit its intermittent failure this run: the retrieval locator lease expired mid recall before the slow recall returned.",
    distractors: [
      "Tool result: retrieval-search suite run 1 of 8. The leased-locator recall timeout test hit no intermittent failure this run: the retrieval locator lease did not expire and the slow recall returned before its recall timeout.",
      "Tool result: retrieval-search suite run 2 of 8. The leased-locator recall timeout test hit no intermittent failure this run: the retrieval locator lease did not expire and the slow recall returned before its recall timeout.",
      "Tool result: retrieval-search suite run 3 of 8. The leased-locator recall timeout test hit no intermittent failure this run: the retrieval locator lease did not expire and the slow recall returned before its recall timeout.",
      "Tool result: retrieval-search suite run 4 of 8. The leased-locator recall timeout test hit no intermittent failure this run: the retrieval locator lease did not expire and the slow recall returned before its recall timeout.",
      "Tool result: retrieval-search suite run 6 of 8. The leased-locator recall timeout test hit no intermittent failure this run: the retrieval locator lease did not expire and the slow recall returned before its recall timeout.",
    ],
  },
  {
    id: "rank-build-log",
    query: "Why is the rocksdb native dependency pinned to an exact version in this repo?",
    targetAgeDays: 24,
    target:
      "Build log line 812 of 1400: DECISION - pin @harperfast/rocksdb-js to 2.4.0 exactly; 2.5.0 ships a prebuilt native binding whose ABI crashes the index worker on this Node release, and the crash only reproduces after a compaction, so the rocksdb dependency is locked until an ABI-compatible rocksdb build is verified.",
    distractors: [
      "Build log line 120 of 1400: resolved @harperfast/rocksdb-js to 2.4.0 from the lockfile and downloaded the prebuilt rocksdb native binding for this platform in 4.2s.",
      "Build log line 340 of 1400: compiled the rocksdb binding smoke test and the rocksdb native addon loaded successfully against the current Node ABI with no warnings.",
      "Build log line 690 of 1400: cached the rocksdb prebuilt native binding so the next build skips the rocksdb download step and reuses the pinned rocksdb artifact.",
      "Build log line 905 of 1400: ran the rocksdb store open and close benchmark; the rocksdb native binding opened the store in 11ms with the pinned rocksdb version.",
      "Build log line 1180 of 1400: the rocksdb dependency audit found no known advisories for the pinned rocksdb native binding version currently installed.",
    ],
  },
  {
    id: "rank-layout",
    query: "Which layout did we finally choose for the recall results panel, left or right?",
    targetAgeDays: 20,
    target:
      "Decision after the layout debate: we are shipping the right-hand recall results panel; the left-hand layout tested worse because it pushed the transcript off screen on narrow terminals, so the right layout is final for the recall results panel.",
    distractors: [
      "One argument in the layout debate was that a left-hand recall results panel matches how most editors put their panels, which some reviewers preferred for the recall panel layout.",
      "The layout debate started because the recall results panel was originally centered, and both a left layout and a right layout were proposed to replace the centered recall panel.",
      "A mockup of the left-hand recall results panel layout and a mockup of the right-hand recall results panel layout were both attached to the layout debate thread.",
      "During the layout debate someone measured that the recall results panel needs at least forty columns whether it is placed on the left or the right of the transcript.",
      "The layout debate was time-boxed to one meeting, and the recall results panel left-versus-right question was the only layout item on that meeting agenda.",
    ],
  },
  {
    id: "rank-lease-ttl",
    query: "What decides how long a retrieval locator lease stays valid before it expires?",
    targetAgeDays: 18,
    target:
      "Decision: a retrieval locator lease is issued with a fixed time-to-live measured from issue time, and recall must present the lease before that TTL elapses; the TTL is set so a normal recall round-trip fits inside it with margin, and an expired locator lease is refused rather than silently renewed.",
    distractors: [
      "Every issued retrieval locator lease is written with its lease id and expiry so an operator can list which locator leases are currently outstanding for a session.",
      "A retrieval locator lease is released as soon as recall finishes, so most locator leases never come close to reaching their expiry time under normal load.",
      "The retrieval locator lease id is embedded in the signed locator, so a tampered locator fails signature verification before the locator lease expiry is even checked.",
      "Retrieval locator lease issuance is rate-limited per session so a burst of searches cannot exhaust the locator lease table before older leases expire.",
      "Metrics count how many retrieval locator leases expired unused versus were presented for recall, to show how often a locator lease TTL is actually reached.",
    ],
  },
];

function documentId(caseId, role, index) {
  return role === "target" ? `${caseId}--target` : `${caseId}--distractor-${index + 1}`;
}

function buildDocuments() {
  const documents = [];
  let recentIndex = 0;
  for (const scene of CASES) {
    documents.push(Object.freeze({
      id: documentId(scene.id, "target"),
      sessionId: SESSION,
      project: PROJECT,
      kind: "turn",
      createdAt: agedAt(scene.targetAgeDays),
      text: scene.target,
      metadata: Object.freeze({ sourceMessageKeys: [`assistant:${scene.id}-target`], caseId: scene.id, role: "target" }),
    }));
    scene.distractors.forEach((text, index) => {
      documents.push(Object.freeze({
        id: documentId(scene.id, "distractor", index),
        sessionId: SESSION,
        project: PROJECT,
        kind: "turn",
        createdAt: recentAt(recentIndex),
        text,
        metadata: Object.freeze({
          sourceMessageKeys: [`assistant:${scene.id}-distractor-${index + 1}`],
          caseId: scene.id,
          role: "distractor",
        }),
      }));
      recentIndex += 1;
    });
  }
  return Object.freeze(documents);
}

function buildCases() {
  return Object.freeze(CASES.map((scene) => Object.freeze({
    id: scene.id,
    query: scene.query,
    targetDocumentId: documentId(scene.id, "target"),
    scope: "session",
    // Retrieve a deep fused list so the reranker window (top-40) and the BM25
    // membership check (top-50) both have room; the target is expected below 3.
    fusedLimit: 40,
    bm25Limit: 50,
    rerankWindow: 40,
  })));
}

// A single chunk per document keeps each candidate's full text inside the
// match-centered snippet, so the reranker scores the whole passage rather than
// a truncated excerpt. Documents here are all well under this bound.
export const RERANKER_CHUNKING = Object.freeze({ targetBytes: 2_048, overlapBytes: 0 });

export const RERANKER_CORPUS = Object.freeze({
  corpusId: "reranker-rank-sensitive-2026-07-18",
  description: "Hard lexical-distractor cases where the answering document is in BM25 top-50 but not the fused top-3 at baseline.",
  project: PROJECT,
  session: SESSION,
  now: RERANKER_EVALUATION_NOW,
  chunking: RERANKER_CHUNKING,
  documents: buildDocuments(),
  cases: buildCases(),
});

// The document-text map the reranker scores against: candidate documentId to
// its canonical corpus text. Reranking full canonical passages (not the
// match-centered snippet) keeps the measurement independent of snippet-budget
// tuning and reproducible.
export function rerankerDocumentText() {
  const map = new Map();
  for (const document of RERANKER_CORPUS.documents) map.set(document.id, document.text);
  return map;
}

export function rerankerCorpusFingerprint() {
  const canonical = JSON.stringify({
    corpusId: RERANKER_CORPUS.corpusId,
    documents: RERANKER_CORPUS.documents.map((document) => ({
      id: document.id,
      createdAt: document.createdAt,
      text: document.text,
    })),
    cases: RERANKER_CORPUS.cases.map((evaluationCase) => ({
      id: evaluationCase.id,
      query: evaluationCase.query,
      targetDocumentId: evaluationCase.targetDocumentId,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
