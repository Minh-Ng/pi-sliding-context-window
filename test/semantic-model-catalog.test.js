import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  resolveSemanticModelArgument,
  SEMANTIC_MODEL_PROFILES,
  SEMANTIC_TIER_ALIASES,
  semanticModelProfile,
} from "../src/semantic/model-catalog.js";
import { semanticLaunchArguments } from "../src/daemon-client/semantic-launch-arguments.js";
import { rerankerLaunchArguments } from "../src/daemon-client/reranker-launch-arguments.js";

const installerExecutable = new URL("../bin/context-window-semantic.js", import.meta.url).pathname;

test("semantic model catalog resolves tier aliases to their pinned model and revision", () => {
  const resolved = resolveSemanticModelArgument("quality");
  assert.equal(resolved.model, SEMANTIC_TIER_ALIASES.quality);
  assert.equal(resolved.profile, semanticModelProfile(SEMANTIC_TIER_ALIASES.quality));
  assert.equal(resolved.revision, resolved.profile.revision);
});

test("semantic model catalog passes through a literal model id and honors an explicit revision override", () => {
  const resolved = resolveSemanticModelArgument("some-org/custom-model", "v2");
  assert.equal(resolved.model, "some-org/custom-model");
  assert.equal(resolved.revision, "v2");
  assert.equal(resolved.profile, undefined);
});

test("semantic model catalog returns undefined for an empty argument so callers fall back to their own default", () => {
  assert.equal(resolveSemanticModelArgument(undefined), undefined);
  assert.equal(resolveSemanticModelArgument(""), undefined);
});

test("semantic model catalog dimensions and pooling differ per tier, so a naive shared literal would be wrong for at least one", () => {
  const defaultProfile = semanticModelProfile(SEMANTIC_TIER_ALIASES.default);
  const smallProfile = semanticModelProfile(SEMANTIC_TIER_ALIASES.small);
  const qualityProfile = semanticModelProfile(SEMANTIC_TIER_ALIASES.quality);
  assert.equal(defaultProfile.dimensions, 384);
  assert.equal(defaultProfile.pooling, "mean");
  assert.equal(smallProfile.dimensions, 768);
  assert.equal(smallProfile.pooling, "mean");
  assert.equal(qualityProfile.dimensions, 1024);
  assert.equal(qualityProfile.pooling, "last_token");
  assert.notEqual(defaultProfile.dimensions, qualityProfile.dimensions);
});

test("every catalog entry declares a model id, pinned revision, dimensions, pooling, and tier", () => {
  for (const [model, profile] of Object.entries(SEMANTIC_MODEL_PROFILES)) {
    assert.equal(typeof model, "string");
    assert.ok(Number.isSafeInteger(profile.dimensions) && profile.dimensions > 0, `${model} dimensions`);
    assert.ok(typeof profile.pooling === "string" && profile.pooling.length > 0, `${model} pooling`);
    assert.ok(typeof profile.revision === "string" && profile.revision.length > 0, `${model} revision`);
    assert.ok(typeof profile.tier === "string" && profile.tier.length > 0, `${model} tier`);
  }
});

test("semantic launch arguments omit dimensions/pooling flags when unset, so the daemon derives them from the model", () => {
  const args = semanticLaunchArguments({
    enabled: true,
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "rev",
    cachePath: "/models",
    indexPath: "/index",
    candidates: 40,
  });
  assert.deepEqual(args, [
    "--semantic",
    "--semantic-model", "Xenova/all-MiniLM-L6-v2",
    "--semantic-revision", "rev",
    "--semantic-cache", "/models",
    "--semantic-index", "/index",
    "--semantic-candidates", "40",
  ]);
});

test("semantic launch arguments include an explicit dimensions/pooling override", () => {
  const args = semanticLaunchArguments({
    enabled: true,
    model: "onnx-community/embeddinggemma-300m-ONNX",
    revision: "main",
    cachePath: "/models",
    indexPath: "/index",
    candidates: 40,
    dimensions: 768,
    pooling: "mean",
  });
  assert.ok(args.includes("--semantic-dimensions"));
  assert.equal(args[args.indexOf("--semantic-dimensions") + 1], "768");
  assert.ok(args.includes("--semantic-pooling"));
  assert.equal(args[args.indexOf("--semantic-pooling") + 1], "mean");
});

test("semantic launch arguments are empty when semantic retrieval is disabled", () => {
  assert.deepEqual(semanticLaunchArguments({ enabled: false, model: "x" }), []);
  assert.deepEqual(semanticLaunchArguments(undefined), []);
});

test("reranker launch arguments include every --reranker-* flag when enabled", () => {
  const args = rerankerLaunchArguments({
    enabled: true,
    model: "Xenova/ms-marco-MiniLM-L-6-v2",
    revision: "rev",
    cachePath: "/reranker-models",
    candidateWindow: 40,
  });
  assert.deepEqual(args, [
    "--reranker",
    "--reranker-model", "Xenova/ms-marco-MiniLM-L-6-v2",
    "--reranker-revision", "rev",
    "--reranker-cache", "/reranker-models",
    "--reranker-candidates", "40",
  ]);
});

test("reranker launch arguments are empty when the reranker is disabled", () => {
  assert.deepEqual(rerankerLaunchArguments({ enabled: false, model: "x" }), []);
  assert.deepEqual(rerankerLaunchArguments(undefined), []);
});

test("installer CLI rejects a flag-like [model]/[revision] argument instead of attempting to download it", () => {
  // A stray --help after `install` (e.g. from muscle-memory `<cmd> install --help`)
  // must not be parsed as a literal model id and sent to the network.
  for (const args of [["install", "--help"], ["install", "-x"], ["install", "some/model", "--bad"]]) {
    const result = spawnSync(process.execPath, [installerExecutable, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1, `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /^Usage: context-window-semantic install/u);
  }
});

test("installer CLI --help exits cleanly without touching the network", () => {
  const result = spawnSync(process.execPath, [installerExecutable, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: context-window-semantic install/u);
  assert.match(result.stdout, /install-reranker/u);
});

test("installer CLI rejects an install-reranker call with stray arguments instead of attempting to download it", () => {
  // Only one reranker model is currently supported (pinned revision); the
  // subcommand takes no positional arguments at all.
  const result = spawnSync(
    process.execPath,
    [installerExecutable, "install-reranker", "some/model"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: context-window-semantic install/u);
});

test("installer CLI rejects an unknown command instead of silently doing nothing", () => {
  const result = spawnSync(process.execPath, [installerExecutable, "bogus"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: context-window-semantic install/u);
});
