#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { env, pipeline } from "@huggingface/transformers";
import { loadConfig } from "../src/config.js";

function usage() {
  return [
    "Usage: context-window-semantic install",
    "Downloads the pinned embedding model into context-window's local cache.",
    "Runtime retrieval uses that cache with network access disabled.",
  ].join("\n");
}

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (command !== "install" || process.argv.length !== 3) {
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}

const config = loadConfig({ cwd: process.cwd(), projectTrusted: false });
await mkdir(config.semanticModelCachePath, { recursive: true, mode: 0o700 });
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = config.semanticModelCachePath;

try {
  const extractor = await pipeline("feature-extraction", config.semanticModel, {
    revision: config.semanticModelRevision,
    cache_dir: config.semanticModelCachePath,
    dtype: "q8",
    device: "cpu",
  });
  const output = await extractor("local semantic retrieval readiness probe", {
    pooling: "mean",
    normalize: true,
  });
  await extractor.dispose?.();
  process.stdout.write(`${JSON.stringify({
    status: "installed",
    model: config.semanticModel,
    revision: config.semanticModelRevision,
    dimensions: output.dims.at(-1),
    cachePath: config.semanticModelCachePath,
    runtimeNetworkAccess: false,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
