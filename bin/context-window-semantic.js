#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { env, pipeline, AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { loadConfig } from "../src/config.js";
import {
  resolveSemanticModelArgument,
  semanticModelProfile,
  SEMANTIC_TIER_ALIASES,
} from "../src/semantic/model-catalog.js";
import {
  RERANKER_DEVICE,
  RERANKER_DTYPE,
  RERANKER_MAX_LENGTH,
} from "../src/semantic/reranker-model.js";

function usage() {
  return [
    "Usage: context-window-semantic install [model] [revision]",
    "       context-window-semantic install-reranker",
    "",
    "install: with no arguments, downloads the configured semanticModel into",
    "context-window's local cache. Runtime retrieval uses that cache with",
    "network access disabled.",
    "",
    "[model] may be a catalog tier alias or a literal Hugging Face model id:",
    `  ${Object.entries(SEMANTIC_TIER_ALIASES).map(([alias, model]) => `${alias} -> ${model}`).join("\n  ")}`,
    "",
    "Installing a model does not activate it: set semanticModel (and",
    "semanticModelRevision, if given) in config to switch the daemon to it,",
    "then restart the shared daemon.",
    "",
    "install-reranker: downloads the configured cross-encoder rerank model",
    "(rerankerModel/rerankerModelRevision) into its own local cache for",
    "explicit search/gather rerank. This is the only path permitted to",
    "download it; runtime inference uses the cache with network access",
    "disabled and degrades silently to the pre-rerank fused order when the",
    "model is not installed. Takes no arguments: only one reranker model is",
    "currently supported, pinned to the revision the offline eval measured",
    "(eval/retrieval/reranker-verdict.json).",
  ].join("\n");
}

async function installSemantic(args) {
  if (args.length > 2 || args.some((arg) => arg.startsWith("-"))) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig({ cwd: process.cwd(), projectTrusted: false });
  const requested = resolveSemanticModelArgument(args[0], args[1]);
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
}

async function installReranker(args) {
  if (args.length > 0) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig({ cwd: process.cwd(), projectTrusted: false });
  const { rerankerModel: model, rerankerModelRevision: revision, rerankerModelCachePath: cachePath } = config;

  await mkdir(cachePath, { recursive: true, mode: 0o700 });
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.cacheDir = cachePath;

  try {
    const shared = { revision, cache_dir: cachePath, local_files_only: false };
    const tokenizer = await AutoTokenizer.from_pretrained(model, shared);
    const rerankerModel = await AutoModelForSequenceClassification.from_pretrained(model, {
      ...shared,
      dtype: RERANKER_DTYPE,
      device: RERANKER_DEVICE,
    });
    const inputs = tokenizer(["local reranker readiness probe"], {
      text_pair: ["warmup passage"],
      padding: true,
      truncation: true,
      max_length: RERANKER_MAX_LENGTH,
    });
    await rerankerModel(inputs);
    await rerankerModel.dispose?.();
    process.stdout.write(`${JSON.stringify({
      status: "installed",
      model,
      revision,
      dtype: RERANKER_DTYPE,
      device: RERANKER_DEVICE,
      cachePath,
      runtimeNetworkAccess: false,
      activated: config.rerankerEnabled === true,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const command = args[0];
if (command === "--help" || command === "-h") {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (command === "install") {
  await installSemantic(args.slice(1));
} else if (command === "install-reranker") {
  await installReranker(args.slice(1));
} else {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
