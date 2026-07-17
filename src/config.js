import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultSocketPath } from "./daemon/paths.js";

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
  maxInlineUserTokens: 16_000,
  searchResults: 3,
  searchResultTokens: 1_500,
  automaticRetrieval: true,
  hintBudgetTokens: 160,
  activeHintBudgetTokens: 640,
  // Compatibility alias. loadConfig resolves both names to one value.
  epochHintBudgetTokens: 640,
  hintSourceCooldownHours: 24,
  ephemeralAutoRetrievalDays: 7,
  conversationAutoRetrievalDays: 30,
  derivedAutoRetrievalDays: 30,
  ephemeralRetentionDays: 14,
  conversationRetentionDays: 90,
  derivedRetentionDays: 30,
  maxArchiveBytes: 1_073_741_824,
  targetArchiveBytes: 805_306_368,
  recentDocumentProtectionDays: 7,
  minimumTurnsPerSession: 20,
  preventAutoCompaction: true,
  statusLabelAccent: true,
  archiveBackend: "rocksdb",
  rocksdbPath: join(homedir(), ".pi", "context-window", "archive.rocks"),
  socketPath: undefined,
  // Existing archives remain here until an explicit offline cutover.
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

function parseNonNegativeInteger(value) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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

function parseArchiveBackend(value) {
  return value === "rocksdb" || value === "sqlite" ? value : undefined;
}

function resolvedPath(value, home) {
  return resolve(String(value).replace(/^~(?=$|\/)/, home));
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
    rocksdbPath: join(home, ".pi", "context-window", "archive.rocks"),
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
  const aliasedNumeric = (primaryKey, legacyKey, parser, primaryEnvironmentValue, legacyEnvironmentValue) => {
    const environmentValue = firstValid(
      parser,
      primaryEnvironmentValue,
      legacyEnvironmentValue,
    );
    if (environmentValue !== undefined) return environmentValue;
    for (const layer of [...layers].reverse()) {
      const layerValue = firstValid(parser, layer[primaryKey], layer[legacyKey]);
      if (layerValue !== undefined) return layerValue;
    }
    return defaultConfig[primaryKey];
  };
  let models = {};
  for (const layer of layers) {
    models = mergeModelProfiles(models, normalizeModelProfiles(layer.models));
  }

  const environmentRotationRatio = parsePositiveRatio(env.CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO);
  const environmentHardRatio = parsePositiveRatio(env.CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO);
  const environmentRotationTurns = parsePositiveInteger(env.CONTEXT_WINDOW_ROTATION_TURNS);
  const explicitRotationTokens = explicitNumeric("rotationTokens", env.CONTEXT_WINDOW_ROTATION_TOKENS);
  const explicitHardLimitTokens = explicitNumeric("hardLimitTokens", env.CONTEXT_WINDOW_HARD_LIMIT_TOKENS);
  const configuredArchiveBackend = firstValid(
    parseArchiveBackend,
    env.CONTEXT_WINDOW_BACKEND,
    ...values("archiveBackend"),
  );
  const dbPath = resolvedPath(env.CONTEXT_WINDOW_DB ?? merged.dbPath, home);
  const rocksdbPath = resolvedPath(env.CONTEXT_WINDOW_ROCKSDB ?? merged.rocksdbPath, home);
  const sqliteSourceExists = existsSync(dbPath);
  const archiveBackend = configuredArchiveBackend
    ?? (sqliteSourceExists ? "sqlite" : DEFAULT_CONFIG.archiveBackend);
  const environmentOverrides = {
    rotationContextRatio: environmentRotationRatio !== undefined,
    hardLimitContextRatio: environmentHardRatio !== undefined,
    rotationTurns: environmentRotationTurns !== undefined,
  };
  const activeHintBudgetTokens = aliasedNumeric(
    "activeHintBudgetTokens",
    "epochHintBudgetTokens",
    parseNonNegativeInteger,
    env.CONTEXT_WINDOW_ACTIVE_HINT_BUDGET_TOKENS,
    env.CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS,
  );

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
    maxInlineUserTokens: numeric("maxInlineUserTokens", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS),
    searchResults: numeric("searchResults", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULTS),
    searchResultTokens: numeric("searchResultTokens", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULT_TOKENS),
    automaticRetrieval: booleanValue(
      env.CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL ?? merged.automaticRetrieval,
      DEFAULT_CONFIG.automaticRetrieval,
    ),
    hintBudgetTokens: numeric(
      "hintBudgetTokens",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_HINT_BUDGET_TOKENS,
    ),
    activeHintBudgetTokens,
    epochHintBudgetTokens: activeHintBudgetTokens,
    hintSourceCooldownHours: numeric(
      "hintSourceCooldownHours",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_HINT_SOURCE_COOLDOWN_HOURS,
    ),
    ephemeralAutoRetrievalDays: numeric(
      "ephemeralAutoRetrievalDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_EPHEMERAL_AUTO_RETRIEVAL_DAYS,
    ),
    conversationAutoRetrievalDays: numeric(
      "conversationAutoRetrievalDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS,
    ),
    derivedAutoRetrievalDays: numeric(
      "derivedAutoRetrievalDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS,
    ),
    ephemeralRetentionDays: numeric(
      "ephemeralRetentionDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_EPHEMERAL_RETENTION_DAYS,
    ),
    conversationRetentionDays: numeric(
      "conversationRetentionDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS,
    ),
    derivedRetentionDays: numeric(
      "derivedRetentionDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_DERIVED_RETENTION_DAYS,
    ),
    maxArchiveBytes: numeric("maxArchiveBytes", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_ARCHIVE_BYTES),
    targetArchiveBytes: numeric("targetArchiveBytes", parsePositiveInteger, env.CONTEXT_WINDOW_TARGET_ARCHIVE_BYTES),
    recentDocumentProtectionDays: numeric(
      "recentDocumentProtectionDays",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS,
    ),
    minimumTurnsPerSession: numeric(
      "minimumTurnsPerSession",
      parseNonNegativeInteger,
      env.CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION,
    ),
    preventAutoCompaction: booleanValue(env.CONTEXT_WINDOW_PREVENT_AUTO_COMPACTION ?? merged.preventAutoCompaction, DEFAULT_CONFIG.preventAutoCompaction),
    statusLabelAccent: booleanValue(env.CONTEXT_WINDOW_STATUS_LABEL_ACCENT ?? merged.statusLabelAccent, DEFAULT_CONFIG.statusLabelAccent),
    // Existing SQLite users stay on SQLite until they explicitly complete the
    // offline migration and opt into RocksDB. Fresh installations use RocksDB.
    archiveBackend,
    rocksdbPath,
    dbPath,
    // Packaged RocksDB adapters always pass the configured SQLite path to the
    // daemon authority gate. The daemon decides atomically whether that path
    // is absent (fresh RocksDB) or requires a verified migration.
    ...(archiveBackend === "rocksdb"
      ? { rocksdbMigrationSourcePath: dbPath }
      : {}),
    models,
    environmentOverrides,
  };
  config.socketPath = resolvedPath(
    env.CONTEXT_WINDOW_SOCKET ?? merged.socketPath ?? defaultSocketPath(config.rocksdbPath),
    home,
  );

  if (config.hardLimitTokens < config.rotationTokens) {
    if (config.rotationTokensExplicit) config.hardLimitTokens = config.rotationTokens;
    else config.rotationTokens = config.hardLimitTokens;
  }
  if (config.rotationTurns <= config.retainTurns) {
    config.rotationTurns = config.retainTurns + 1;
  }
  if (config.targetArchiveBytes >= config.maxArchiveBytes) {
    config.targetArchiveBytes = Math.max(1, Math.floor(config.maxArchiveBytes * 0.75));
  }
  return config;
}
