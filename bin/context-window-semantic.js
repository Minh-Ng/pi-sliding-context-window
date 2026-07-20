#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { env, pipeline } from "@huggingface/transformers";
import { loadConfig } from "../src/config.js";
import {
  resolveSemanticModelArgument,
  semanticModelProfile,
  SEMANTIC_TIER_ALIASES,
} from "../src/semantic/model-catalog.js";

function usage() {
  return [
    "Usage: context-window-semantic install [model] [revision]",
    "",
    "With no arguments, downloads the configured semanticModel into",
    "context-window's local cache. Runtime retrieval uses that cache with",
    "network access disabled.",
    "",
    "[model] may be a catalog tier alias or a literal Hugging Face model id:",
    `  ${Object.entries(SEMANTIC_TIER_ALIASES).map(([alias, model]) => `${alias} -> ${model}`).join("\n  ")}`,
    "",
    "Installing a model does not activate it: set semanticModel (and",
    "semanticModelRevision, if given) in config to switch the daemon to it,",
    "then restart the shared daemon.",
  ].join("\n");
}

const args = process.argv.slice(2);
const command = args[0];
if (command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
// Reject flag-like [model]/[revision] arguments (e.g. a stray `--help` after
// `install`) instead of treating them as a literal model id to download.
if (command !== "install" || args.length > 3 || args.slice(1).some((arg) => arg.startsWith("-"))) {
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}

const config = loadConfig({ cwd: process.cwd(), projectTrusted: false });
const requested = resolveSemanticModelArgument(args[1], args[2]);
const model = requested?.model ?? config.semanticModel;
const revision = requested?.revision ?? config.semanticModelRevision;
// The catalog's expected dimensions/pooling are unverified for anything but
// the shipped default (see model-catalog.js) — treat them as a prediction to
// confirm against this run's actual output, not a fact to assume.
const profile = requested?.profile ?? semanticModelProfile(model);

await mkdir(config.semanticModelCachePath, { recursive: true, mode: 0o700 });
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = config.semanticModelCachePath;

try {
  const extractor = await pipeline("feature-extraction", model, {
    revision,
    cache_dir: config.semanticModelCachePath,
    dtype: "q8",
    device: "cpu",
  });
  const output = await extractor("local semantic retrieval readiness probe", {
    pooling: profile?.pooling ?? "mean",
    normalize: true,
  });
  await extractor.dispose?.();
  const dimensions = output.dims.at(-1);
  const dimensionsMismatch = profile !== undefined && profile.dimensions !== dimensions;
  process.stdout.write(`${JSON.stringify({
    status: "installed",
    model,
    revision,
    dimensions,
    pooling: profile?.pooling ?? "mean",
    ...(dimensionsMismatch
      ? { warning: `Catalog expected ${profile.dimensions} dimensions for ${model}; the installed model returned ${dimensions}. Update src/semantic/model-catalog.js.` }
      : {}),
    cachePath: config.semanticModelCachePath,
    runtimeNetworkAccess: false,
    activated: model === config.semanticModel && revision === config.semanticModelRevision,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
