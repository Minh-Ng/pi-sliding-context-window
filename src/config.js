import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  rotationContextRatio: 0.65,
  hardLimitContextRatio: 0.8,
  // Absolute values are fallbacks when model metadata is unavailable. They only
  // cap ratio-derived limits when explicitly set by the user.
  rotationTokens: 96_000,
  rotationTurns: 20,
  hardLimitTokens: 128_000,
  retainTurns: 5,
  maxToolResultTokens: 4_000,
  searchResults: 3,
  searchResultTokens: 1_500,
  preventAutoCompaction: true,
  statusLabelAccent: true,
  dbPath: join(homedir(), ".pi", "context-window", "archive.db"),
  models: Object.freeze({}),
});

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    throw new Error(`Invalid context-window config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readNamespacedJson(path) {
  const settings = readJson(path);
  const config = settings["context-window"];
  return config && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value, fallback) {
  return parsePositiveInteger(value) ?? fallback;
}

function parsePositiveRatio(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function positiveRatio(value, fallback) {
  return parsePositiveRatio(value) ?? fallback;
}

function firstValid(parser, ...values) {
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = parser(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function booleanValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function normalizeModelProfiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profiles = {};
  for (const [pattern, candidate] of Object.entries(value)) {
    if (!pattern.includes("/") || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const profile = {};
    if (positiveRatio(candidate.rotationContextRatio, undefined) !== undefined) {
      profile.rotationContextRatio = Number(candidate.rotationContextRatio);
    }
    if (positiveRatio(candidate.hardLimitContextRatio, undefined) !== undefined) {
      profile.hardLimitContextRatio = Number(candidate.hardLimitContextRatio);
    }
    if (positiveInteger(candidate.rotationTurns, undefined) !== undefined) {
      profile.rotationTurns = Number(candidate.rotationTurns);
    }
    // Keep empty normalized redeclarations so merging can still update an
    // existing case-insensitive identity's spelling and source order. The
    // merge omits them when there is no lower profile to inherit.
    profiles[pattern] = profile;
  }
  return profiles;
}

function mergeModelProfiles(lowerProfiles, higherProfiles) {
  const merged = { ...lowerProfiles };
  for (const [pattern, profile] of Object.entries(higherProfiles)) {
    const identity = pattern.toLowerCase();
    const previousPattern = Object.keys(merged).find(
      (candidate) => candidate.toLowerCase() === identity,
    );
    const previousProfile = previousPattern === undefined ? {} : merged[previousPattern];
    // An empty brand-new profile has no policy to contribute, but an empty
    // redeclaration still updates the identity's spelling and source order.
    if (previousPattern === undefined && Object.keys(profile).length === 0) continue;
    // Reinsert every redeclaration so object order continues to represent source
    // order, and retain the highest-precedence spelling for status output.
    if (previousPattern !== undefined) delete merged[previousPattern];
    merged[pattern] = { ...previousProfile, ...profile };
  }
  return merged;
}

function globMatches(pattern, value) {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "iu").test(value);
}

export function findModelProfile(models, model) {
  if (!model?.provider || !model?.id) return undefined;
  const key = `${model.provider}/${model.id}`;
  let best;
  let bestSpecificity = -1;
  for (const [pattern, profile] of Object.entries(models ?? {})) {
    if (!globMatches(pattern, key)) continue;
    const specificity = pattern.replaceAll("*", "").length;
    // Object declaration order breaks equally-specific ties: later wins.
    if (specificity >= bestSpecificity) {
      best = { pattern, ...profile };
      bestSpecificity = specificity;
    }
  }
  return best;
}

export function resolveModelConfig(config, model) {
  const profile = findModelProfile(config.models, model);
  const environment = config.environmentOverrides ?? {};
  const value = (key) => environment[key] ? config[key] : profile?.[key] ?? config[key];
  const retainTurns = positiveInteger(config.retainTurns, DEFAULT_CONFIG.retainTurns);
  const rotationTurns = Math.max(
    retainTurns + 1,
    positiveInteger(value("rotationTurns"), DEFAULT_CONFIG.rotationTurns),
  );
  return {
    rotationContextRatio: positiveRatio(value("rotationContextRatio"), DEFAULT_CONFIG.rotationContextRatio),
    hardLimitContextRatio: positiveRatio(value("hardLimitContextRatio"), DEFAULT_CONFIG.hardLimitContextRatio),
    rotationTurns,
    pattern: profile?.pattern,
  };
}

export function loadConfig({ cwd = process.cwd(), projectTrusted = false, env = process.env, home = homedir() } = {}) {
  const globalDirectory = join(home, ".pi", "agent");
  const projectDirectory = join(cwd, ".pi");
  // Layers are ordered from lowest to highest precedence. Project files are
  // intentionally not even read until Pi has marked the project as trusted.
  const layers = [
    readJson(join(globalDirectory, "context-window.json")),
    readNamespacedJson(join(globalDirectory, "settings.json")),
  ];
  if (projectTrusted) {
    layers.push(
      readJson(join(projectDirectory, "context-window.json")),
      readNamespacedJson(join(projectDirectory, "settings.json")),
    );
  }

  const defaultConfig = {
    ...DEFAULT_CONFIG,
    dbPath: join(home, ".pi", "context-window", "archive.db"),
  };
  const merged = Object.assign({}, defaultConfig, ...layers);
  const values = (key) => layers.map((layer) => layer[key]).reverse();
  const numeric = (key, parser, environmentValue) => firstValid(
    parser,
    environmentValue,
    ...values(key),
    defaultConfig[key],
  );
  const explicitNumeric = (key, environmentValue) => firstValid(
    parsePositiveInteger,
    environmentValue,
    ...values(key),
  );
  let models = {};
  for (const layer of layers) {
    models = mergeModelProfiles(models, normalizeModelProfiles(layer.models));
  }

  const environmentRotationRatio = parsePositiveRatio(env.CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO);
  const environmentHardRatio = parsePositiveRatio(env.CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO);
  const environmentRotationTurns = parsePositiveInteger(env.CONTEXT_WINDOW_ROTATION_TURNS);
  const explicitRotationTokens = explicitNumeric("rotationTokens", env.CONTEXT_WINDOW_ROTATION_TOKENS);
  const explicitHardLimitTokens = explicitNumeric("hardLimitTokens", env.CONTEXT_WINDOW_HARD_LIMIT_TOKENS);
  const environmentOverrides = {
    rotationContextRatio: environmentRotationRatio !== undefined,
    hardLimitContextRatio: environmentHardRatio !== undefined,
    rotationTurns: environmentRotationTurns !== undefined,
  };

  const config = {
    rotationContextRatio: numeric("rotationContextRatio", parsePositiveRatio, env.CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO),
    hardLimitContextRatio: numeric("hardLimitContextRatio", parsePositiveRatio, env.CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO),
    rotationTokens: explicitRotationTokens ?? DEFAULT_CONFIG.rotationTokens,
    rotationTokensExplicit: explicitRotationTokens !== undefined,
    rotationTurns: numeric("rotationTurns", parsePositiveInteger, env.CONTEXT_WINDOW_ROTATION_TURNS),
    hardLimitTokens: explicitHardLimitTokens ?? DEFAULT_CONFIG.hardLimitTokens,
    hardLimitTokensExplicit: explicitHardLimitTokens !== undefined,
    retainTurns: numeric("retainTurns", parsePositiveInteger, env.CONTEXT_WINDOW_RETAIN_TURNS),
    maxToolResultTokens: numeric("maxToolResultTokens", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_TOOL_RESULT_TOKENS),
    searchResults: numeric("searchResults", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULTS),
    searchResultTokens: numeric("searchResultTokens", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULT_TOKENS),
    preventAutoCompaction: booleanValue(env.CONTEXT_WINDOW_PREVENT_AUTO_COMPACTION ?? merged.preventAutoCompaction, DEFAULT_CONFIG.preventAutoCompaction),
    statusLabelAccent: booleanValue(env.CONTEXT_WINDOW_STATUS_LABEL_ACCENT ?? merged.statusLabelAccent, DEFAULT_CONFIG.statusLabelAccent),
    dbPath: resolve(String(env.CONTEXT_WINDOW_DB ?? merged.dbPath).replace(/^~(?=$|\/)/, home)),
    models,
    environmentOverrides,
  };

  if (config.hardLimitTokens < config.rotationTokens) {
    if (config.rotationTokensExplicit) config.hardLimitTokens = config.rotationTokens;
    else config.rotationTokens = config.hardLimitTokens;
  }
  if (config.rotationTurns <= config.retainTurns) {
    config.rotationTurns = config.retainTurns + 1;
  }
  return config;
}
