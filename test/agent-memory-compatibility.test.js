import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArchiveAgentMemoryAdapter,
  BENCHMARK_COMPATIBILITY,
  ingestLongMemEvalCase,
  ingestLongMemEvalV2Trajectory,
  queryLongMemEvalV2,
  runLongMemEvalRetrieval,
} from "../eval/agent-memory/compatibility.js";
import { Archive } from "../src/archive.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-agent-memory-fit-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 64 * 1024 * 1024,
      targetBytes: 48 * 1024 * 1024,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  t.after(() => {
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return archive;
}

function imageFixture(t, relativePath) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-agent-memory-images-"));
  const imagePath = join(directory, relativePath);
  mkdirSync(join(imagePath, ".."), { recursive: true });
  writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, imagePath };
}

test("LongMemEval-V1 session records round-trip through ranked retrieval and scoring", (t) => {
  const archive = fixture(t);
  const adapter = new ArchiveAgentMemoryAdapter(archive, {
    sessionId: "longmemeval:q-canary",
    topK: 5,
  });
  const entry = {
    question_id: "q-canary",
    question: "What color is used for canary deploys?",
    haystack_session_ids: ["noans_1", "answer_1", "answer_2"],
    haystack_dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
    haystack_sessions: [
      [
        { role: "user", content: "The herb garden needs more basil." },
        { role: "assistant", content: "I will remember the gardening note." },
      ],
      [
        { role: "user", content: "Remember that cobalt is the canary deploy color.", has_answer: true },
        { role: "assistant", content: "Cobalt is recorded for canary deploys." },
      ],
      [
        { role: "user", content: "The deployment handbook also assigns cobalt to canary deploys.", has_answer: true },
        { role: "assistant", content: "That corroborates the cobalt deployment convention." },
      ],
    ],
    answer_session_ids: ["answer_1", "answer_2"],
  };

  assert.equal(ingestLongMemEvalCase(adapter, entry).length, 3);
  const output = runLongMemEvalRetrieval(adapter, entry);

  assert.match(output.retrieval_results.ranked_items[0].corpus_id, /^answer_/);
  assert.equal(output.retrieval_results.metrics.session["recall_any@1"], 1);
  assert.equal(output.retrieval_results.metrics.session["recall_all@1"], 0);
  assert.equal(output.retrieval_results.metrics.session["recall_all@5"], 1);
  assert.equal(output.retrieval_results.metrics.session["ndcg_any@5"], 1);
});

test("LongMemEval-V2 text-only trajectories return bounded text context", (t) => {
  const archive = fixture(t);
  const adapter = new ArchiveAgentMemoryAdapter(archive, {
    sessionId: "longmemeval-v2:q-text",
    topK: 1,
    memoryContextMaxTokens: 240,
  });
  const diagnostic = ingestLongMemEvalV2Trajectory(adapter, {
    id: "trajectory-text",
    goal: "Locate the quarterly billing export control",
    states: [{ accessibility_tree: "Billing page with an Export quarterly report button." }],
  });

  const context = queryLongMemEvalV2(adapter, "Where is the quarterly billing export control?");

  assert.equal(diagnostic.compatibility, "text-complete");
  assert.equal(diagnostic.screenshotReferences, 0);
  assert.deepEqual(context.map(({ type }) => type), ["text"]);
  assert.match(context[0].value, /Observation: \[Billing\] page with an \[Export\]/i);
  assert.match(context[0].value, /ARCHIVED HISTORICAL EVIDENCE/);
});

test("LongMemEval-V2 image-only trajectories return validated image context", (t) => {
  const archive = fixture(t);
  const { directory, imagePath } = imageFixture(t, "screenshots/trajectory-image/0.png");
  const adapter = new ArchiveAgentMemoryAdapter(archive, {
    sessionId: "longmemeval-v2:q-image",
    topK: 1,
    memoryContextMaxTokens: 256,
  });
  const diagnostic = ingestLongMemEvalV2Trajectory(adapter, {
    id: "trajectory-image",
    states: [{ screenshot: "screenshots/trajectory-image/0.png" }],
  }, { dataRoot: directory });

  const context = queryLongMemEvalV2(adapter, "trajectory-image");

  assert.equal(diagnostic.compatibility, "image-complete");
  assert.equal(diagnostic.textEvidence, false);
  assert.deepEqual(context, [{ type: "image", value: imagePath }]);
});

test("LongMemEval-V2 mixed trajectories reserve budget for ordered text and image evidence", (t) => {
  const archive = fixture(t);
  const { directory, imagePath } = imageFixture(t, "screenshots/trajectory-export/0.png");
  const adapter = new ArchiveAgentMemoryAdapter(archive, {
    sessionId: "longmemeval-v2:q-export",
    topK: 1,
    memoryContextMaxTokens: 400,
  });
  const diagnostic = ingestLongMemEvalV2Trajectory(adapter, {
    id: "trajectory-export",
    goal: "Export the quarterly billing report",
    states: [{
      action: "click Billing",
      accessibility_tree: "Billing page with an Export quarterly report button.",
      screenshot: "screenshots/trajectory-export/0.png",
    }],
  }, { dataRoot: directory });

  const context = queryLongMemEvalV2(adapter, "Where is the quarterly billing export control?");

  assert.equal(diagnostic.compatibility, "multimodal-complete");
  assert.deepEqual(context.map(({ type }) => type), ["text", "image"]);
  assert.equal(context[1].value, imagePath);
  assert.match(context[0].value, /ARCHIVED HISTORICAL EVIDENCE/);
});

test("LongMemEval-V2 rejects missing screenshots before archive ingestion", (t) => {
  const archive = fixture(t);
  const adapter = new ArchiveAgentMemoryAdapter(archive, { sessionId: "longmemeval-v2:invalid" });
  assert.throws(
    () => ingestLongMemEvalV2Trajectory(adapter, {
      id: "trajectory-missing-image",
      states: [{ screenshot: "screenshots/missing.png" }],
    }),
    /must reference an existing file/,
  );
  assert.equal(archive.count({ sessionId: "longmemeval-v2:invalid" }), 0);
});

test("MemoryArena add and prompt-wrap lifecycle is expressible without a model call", (t) => {
  const archive = fixture(t);
  const adapter = new ArchiveAgentMemoryAdapter(archive, {
    sessionId: "memoryarena:shopping-group-7",
    topK: 1,
  });
  adapter.addChunk("action: selected the cobalt travel mug\nobservation: it is dishwasher safe");
  adapter.addChunk("action: compared wool scarves\nobservation: the green scarf was unavailable");

  const prompt = adapter.wrapUserPrompt("Which selected mug is dishwasher safe?");

  assert.match(prompt, /^<memory_context>/);
  assert.match(prompt, /cobalt travel mug/i);
  assert.match(prompt, /<\/memory_context>\nUser: Which selected mug is dishwasher safe\?$/);
  assert.doesNotMatch(prompt, /green scarf/i);
});

test("benchmark memories remain isolated by harness run", (t) => {
  const archive = fixture(t);
  const left = new ArchiveAgentMemoryAdapter(archive, { sessionId: "run:left" });
  const right = new ArchiveAgentMemoryAdapter(archive, { sessionId: "run:right" });
  left.addChunk("The private launch phrase is amber kestrel.");
  right.addChunk("The unrelated launch note concerns a weather balloon.");

  assert.match(left.wrapUserPrompt("What is the private launch phrase?"), /amber kestrel/i);
  assert.doesNotMatch(right.wrapUserPrompt("What is the private launch phrase?"), /amber kestrel/i);
});

test("compatibility declaration distinguishes storage fit, agent fit, and multimodal support", () => {
  assert.equal(BENCHMARK_COMPATIBILITY.longMemEvalV1.status, "storage-contract-only");
  assert.match(BENCHMARK_COMPATIBILITY.longMemEvalV1.limitation, /bypasses agent-side query expansion/i);
  assert.equal(BENCHMARK_COMPATIBILITY.longMemEvalV2.status, "compatible");
  assert.match(BENCHMARK_COMPATIBILITY.longMemEvalV2.lifecycle, /text\/image context items/i);
  assert.equal(BENCHMARK_COMPATIBILITY.memoryArena.status, "compatible-via-http-wrapper");
});

test("malformed benchmark records fail before partial ingestion", (t) => {
  const archive = fixture(t);
  const adapter = new ArchiveAgentMemoryAdapter(archive, { sessionId: "invalid" });
  assert.throws(
    () => ingestLongMemEvalCase(adapter, {
      question_id: "bad",
      haystack_session_ids: ["one"],
      haystack_sessions: [],
      haystack_dates: ["2026-07-01"],
    }),
    /equal lengths/,
  );
  assert.equal(archive.count({ sessionId: "invalid" }), 0);
});
