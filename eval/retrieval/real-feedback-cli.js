#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StoreClient } from "../../src/store/store-client.js";

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force-project-scope") {
      options.forceProjectScope = true;
      continue;
    }
    if (!["--socket", "--project", "--output"].includes(argument)) {
      throw new Error(`Unknown argument ${argument}.`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
  }
  if (!options.socket || !options.project || !options.output) {
    throw new Error("Usage: real-feedback-cli.js --socket PATH --project PATH --output PATH [--force-project-scope]");
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rankOf(results, target) {
  const index = results.findIndex((result) =>
    result.documentId === target.documentId && result.version === target.version);
  return index < 0 ? null : index + 1;
}

function round(value, places = 6) {
  return Number(Number(value).toFixed(places));
}

function metrics(observations) {
  const denominator = observations.length;
  const score = (field, rank) => denominator === 0
    ? 0
    : observations.filter((entry) => entry[field] !== null && entry[field] <= rank).length / denominator;
  const mrr = (field) => denominator === 0
    ? 0
    : observations.reduce((sum, entry) => sum + (entry[field] === null ? 0 : 1 / entry[field]), 0) / denominator;
  const baselineMrr = mrr("baselineRank");
  const rerankedMrr = mrr("rerankedRank");
  return {
    labels: denominator,
    candidateCoverage: denominator === 0
      ? 0
      : observations.filter((entry) => entry.baselineRank !== null).length / denominator,
    baseline: {
      recallAt1: round(score("baselineRank", 1)),
      recallAt3: round(score("baselineRank", 3)),
      recallAt5: round(score("baselineRank", 5)),
      recallAt10: round(score("baselineRank", 10)),
      mrr: round(baselineMrr),
    },
    reranked: {
      recallAt1: round(score("rerankedRank", 1)),
      recallAt3: round(score("rerankedRank", 3)),
      recallAt5: round(score("rerankedRank", 5)),
      recallAt10: round(score("rerankedRank", 10)),
      mrr: round(rerankedMrr),
    },
    delta: {
      recallAt1: round(score("rerankedRank", 1) - score("baselineRank", 1)),
      recallAt3: round(score("rerankedRank", 3) - score("baselineRank", 3)),
      recallAt5: round(score("rerankedRank", 5) - score("baselineRank", 5)),
      recallAt10: round(score("rerankedRank", 10) - score("baselineRank", 10)),
      mrr: round(rerankedMrr - baselineMrr),
    },
    movement: {
      improved: observations.filter((entry) => entry.baselineRank !== null
        && entry.rerankedRank !== null && entry.rerankedRank < entry.baselineRank).length,
      unchanged: observations.filter((entry) => entry.baselineRank !== null
        && entry.rerankedRank !== null && entry.baselineRank === entry.rerankedRank).length,
      regressed: observations.filter((entry) => entry.baselineRank !== null
        && entry.rerankedRank !== null && entry.rerankedRank > entry.baselineRank).length,
      unavailable: observations.filter((entry) => entry.baselineRank === null
        || entry.rerankedRank === null).length,
    },
  };
}

function uniqueObservations(observations) {
  const seen = new Set();
  return observations.filter((entry) => {
    const key = [
      entry.query.trim().replace(/\s+/gu, " ").toLocaleLowerCase(),
      entry.target.documentId,
      entry.target.version,
      entry.scope,
      ...entry.sessionIds,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const options = parse(process.argv.slice(2));
const client = new StoreClient({ socketPath: options.socket, project: options.project });
try {
  const status = await client.request("daemon.status", {});
  if (status.reranker?.available !== true) {
    throw new Error("The daemon reranker must be operational for real-feedback replay.");
  }
  const exported = await client.request("feedback.events", { limit: 2_000 });
  const labels = [];
  for (const event of exported.events) {
    for (const recall of event.recalls ?? []) {
      if (recall.status !== "resolved") continue;
      const shown = (event.shown ?? []).find(
        (entry) => entry.locatorFingerprint === recall.locatorFingerprint,
      );
      if (!shown) continue;
      labels.push({
        event,
        target: { documentId: shown.documentId, version: shown.version },
        originalRank: shown.rank + 1,
        originalMode: shown.retrievalMode,
      });
    }
  }

  const observations = [];
  const baselineLatencies = [];
  const rerankedLatencies = [];
  for (const [index, label] of labels.entries()) {
    const { event, target } = label;
    const direct = await client.request("store.get", {
      documentId: target.documentId,
      version: target.version,
      view: "bounded",
    });
    const targetAvailable = direct.status === "resolved";
    const sessionIds = Array.isArray(event.sessionIds) ? event.sessionIds : [];
    const scope = options.forceProjectScope || sessionIds.length === 0 ? "project" : "session";
    const request = {
      query: event.query,
      relation: null,
      scope,
      sessionIds,
      project: options.project,
      limit: 40,
      excludeVisibleSourceKeys: [],
      hintBudgetTokens: 160,
      dedupe: false,
      searchEffort: "normal",
      recordFeedback: false,
    };
    const baselineStartedAt = performance.now();
    const baseline = await client.request("store.search", { ...request, rerank: false });
    baselineLatencies.push(performance.now() - baselineStartedAt);
    const rerankedStartedAt = performance.now();
    const reranked = await client.request("store.search", { ...request, rerank: true });
    rerankedLatencies.push(performance.now() - rerankedStartedAt);
    observations.push({
      seq: event.seq,
      createdAt: event.createdAt,
      query: event.query,
      scope,
      sessionIds,
      target,
      targetAvailable,
      originalRank: label.originalRank,
      originalMode: label.originalMode,
      baselineRank: targetAvailable ? rankOf(baseline.results, target) : null,
      rerankedRank: targetAvailable ? rankOf(reranked.results, target) : null,
      rerankerScored: reranked.results.some((result) => result.reranked === true),
      baselineResultCount: baseline.results.length,
      rerankedResultCount: reranked.results.length,
    });
    process.stderr.write(`\rreplayed ${index + 1}/${labels.length}`);
  }
  process.stderr.write("\n");

  const available = observations.filter((entry) => entry.targetAvailable);
  const unique = uniqueObservations(available);
  const added = rerankedLatencies.map((value, index) => value - baselineLatencies[index]);
  const artifact = {
    kind: "real-session-reranker-current-corpus-replay",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: options.project,
    forcedProjectScope: options.forceProjectScope === true,
    feedback: {
      exportedEvents: exported.events.length,
      truncated: exported.truncated,
      resolvedRecallLabels: labels.length,
      availableTargetLabels: available.length,
      unavailableTargetLabels: observations.length - available.length,
      uniqueQueryTargetLabels: unique.length,
    },
    metrics: {
      eventWeighted: metrics(available),
      uniqueQueryTarget: metrics(unique),
    },
    latency: {
      samples: observations.length,
      baselineP50Ms: round(percentile(baselineLatencies, 0.5), 3),
      baselineP95Ms: round(percentile(baselineLatencies, 0.95), 3),
      rerankedP50Ms: round(percentile(rerankedLatencies, 0.5), 3),
      rerankedP95Ms: round(percentile(rerankedLatencies, 0.95), 3),
      addedP50Ms: round(percentile(added, 0.5), 3),
      addedP95Ms: round(percentile(added, 0.95), 3),
    },
    observations,
    caveats: [
      "Positive labels are later resolved recalls of exact shown locators; non-recalled results are not treated as negatives.",
      "This replays real labels against the current corpus/index, not the historical candidate pool at event.createdAt.",
      "Retention, supersession, new documents, recency and index changes can alter current ranks; unavailable targets are excluded from rank metrics and counted separately.",
      "Repeated searches can overweight one query; uniqueQueryTarget metrics deduplicate normalized query + target + scope/session set.",
      "The event ring is project-scoped and bounded to the latest 2,000 events; this artifact covers only the authenticated project.",
      ...(options.forceProjectScope
        ? ["Sensitivity run forces project scope and is not rank-comparable to originally session-scoped searches."]
        : []),
    ],
  };
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, ...artifact.feedback, metrics: artifact.metrics, latency: artifact.latency }, null, 2)}\n`);
} finally {
  client.close();
}
