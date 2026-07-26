import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultSocketPath } from "./daemon/paths.js";
import { parseRecallScope } from "./retrieval/recall-scope.js";
import { SEMANTIC_TIER_ALIASES, semanticModelProfile } from "./semantic/model-catalog.js";

export const DEFAULT_CONFIG = Object.freeze({
  rotationContextRatio: 0.65,
  hardLimitContextRatio: 0.8,
  // Absolute values are fallbacks when model metadata is unavailable. They only
  // cap ratio-derived limits when explicitly set by the user.
  rotationTokens: 96_000,
  rotationTurns: 20,
  hardLimitTokens: 128_000,
  piCompactionReserveTokens: undefined,
  retainTurns: 5,
  maxToolResultTokens: 4_000,
  maxToolArgumentTokens: 4_000,
  // Cumulative tool-result admission budget. Once admitted tool-result tokens
  // in the active epoch reach this fraction of the rotation target, NEW tool
  // results are gated at toolResultBudgetFloorTokens instead of
  // maxToolResultTokens. Set the ratio to 1 to effectively disable adaptive
  // tightening (rotation triggers before results alone can reach the target).
  toolResultBudgetRatio: 0.3,
  toolResultBudgetFloorTokens: 1_000,
  // Forward-only: an exact-duplicate tool result (same tool name, normalized
  // arguments, and content hash as one already admitted this epoch) is
  // externalized regardless of size instead of re-admitted in full. The
  // earlier occurrence is never rewritten.
  dedupToolResults: true,
  maxInlineUserTokens: 16_000,
  searchResults: 3,
  searchResultTokens: 1_500,
  automaticRetrieval: true,
  // Default boundary for explicit recall tools and automatic continuity.
  // `auto` keeps ordinary tool calls session-scoped while following a
  // continuity marker at the marker preflight's project scope.
  recallScope: "auto",
  // Explicit search/gather ranking signal only (ultracode task #32), never
  // consulted by automatic preflight: the Pi adapter's own deterministic
  // conversation-prefix digest (src/session/session-context.js) is computed
  // and forwarded into every store.search/store.gather call this config
  // makes unless set false, in which case the digest is never computed and
  // the request never carries a `sessionContext` field -- byte-identical to
  // every pre-task-#32 request. MCP callers are unaffected by this flag: they
  // pass their own sessionContext per call (or omit it) regardless.
  sessionContextRanking: true,
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
  semanticRetrieval: true,
  semanticModel: "Xenova/all-MiniLM-L6-v2",
  semanticModelRevision: "751bff37182d3f1213fa05d7196b954e230abad9",
  semanticModelCachePath: join(homedir(), ".pi", "context-window", "models"),
  semanticIndexPath: join(homedir(), ".pi", "context-window", "semantic-index"),
  semanticCandidates: 40,
  // Unset by default: dimensions/pooling are derived from `semanticModel`
  // via the catalog in src/semantic/model-catalog.js. These are an escape
  // hatch for a custom or self-hosted model the catalog does not recognize.
  semanticModelDimensions: undefined,
  semanticModelPooling: undefined,
  // Cross-encoder rerank for explicit search/gather, never automatic preflight.
  // Keep it opt-in: the real-session evaluation found no quality improvement
  // and measured additional latency and memory use.
  rerankerEnabled: false,
  rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
  rerankerModelRevision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
  rerankerModelCachePath: join(homedir(), ".pi", "context-window", "reranker-models"),
  rerankerCandidates: 40,
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

export function saveGlobalConfig(updates, { home = homedir() } = {}) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new TypeError("Context-window config updates must be an object.");
  }
  const path = join(home, ".pi", "agent", "settings.json");
  const settings = readJson(path);
  const current = settings["context-window"];
  const next = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const serialized = `${JSON.stringify({ ...settings, "context-window": next }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.settings.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return next;
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

// Mirrors the pooling strategies the pinned @huggingface/transformers
// feature-extraction pipeline accepts; an unrecognized value fails closed at
// config load rather than surfacing as an opaque worker-thread rejection
// later, per-request.
const POOLING_MODES = new Set(["mean", "cls", "first_token", "last_token", "eos", "none"]);
function parsePoolingMode(value) {
  return typeof value === "string" && POOLING_MODES.has(value) ? value : undefined;
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

function literalPosition(candidate, literal, start, end) {
  const table = new Uint32Array(literal.length);
  for (let index = 1, matched = 0; index < literal.length; index += 1) {
    while (matched > 0 && literal[index] !== literal[matched]) matched = table[matched - 1];
    if (literal[index] === literal[matched]) matched += 1;
    table[index] = matched;
  }
  for (let index = start, matched = 0; index < end; index += 1) {
    while (matched > 0 && candidate[index] !== literal[matched]) matched = table[matched - 1];
    if (candidate[index] !== literal[matched]) continue;
    matched += 1;
    if (matched === literal.length) return index - literal.length + 1;
  }
  return -1;
}

const CASE_FOLD_EXCEPTIONS = new Map();

function exceptionalCaseFold(character, candidate) {
  const cached = CASE_FOLD_EXCEPTIONS.get(character);
  if (cached !== undefined) return cached;
  let folded = character.toLowerCase();
  try {
    const codePoint = character.codePointAt(0).toString(16);
    if (new RegExp(`^\\u{${codePoint}}$`, "iu").test(candidate)) folded = candidate;
  } catch { /* preserve the ordinary lowercase form for malformed scalar input */ }
  CASE_FOLD_EXCEPTIONS.set(character, folded);
  return folded;
}

function simpleCaseFold(value) {
  const folded = [];
  for (const character of String(value)) {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    const candidate = [...upper].length === 1 ? upper.toLowerCase() : lower;
    folded.push(candidate === lower ? lower : exceptionalCaseFold(character, candidate));
  }
  return folded;
}

function sameTokens(left, right) {
  return left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function tokensAt(candidate, literal, start) {
  return start >= 0
    && start + literal.length <= candidate.length
    && literal.every((token, index) => token === candidate[start + index]);
}

function globMatches(pattern, value) {
  // Match the former /iu regexp's one-code-point case equivalences without
  // compiling user-controlled wildcard patterns into a backtracking regexp.
  const needle = String(pattern);
  const candidate = simpleCaseFold(value);
  if (!needle.includes("*")) return sameTokens(simpleCaseFold(needle), candidate);
  const anchoredStart = !needle.startsWith("*");
  const anchoredEnd = !needle.endsWith("*");
  const literals = needle.split("*")
    .filter((literal) => literal.length > 0)
    .map(simpleCaseFold);
  if (literals.length === 0) return true;

  let start = 0;
  let end = candidate.length;
  if (anchoredStart) {
    const prefix = literals.shift();
    if (!tokensAt(candidate, prefix, 0)) return false;
    start = prefix.length;
  }
  if (anchoredEnd) {
    const suffix = literals.pop();
    if (!tokensAt(candidate, suffix, candidate.length - suffix.length)
      || candidate.length - suffix.length < start) return false;
    end = candidate.length - suffix.length;
  }
  for (const literal of literals) {
    const position = literalPosition(candidate, literal, start, end);
    if (position < 0) return false;
    start = position + literal.length;
  }
  return start <= end;
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
  const globalSettingsPath = join(globalDirectory, "settings.json");
  const projectSettingsPath = join(projectDirectory, "settings.json");
  // Layers are ordered from lowest to highest precedence. Project files are
  // intentionally not even read until Pi has marked the project as trusted.
  const layers = [
    readJson(join(globalDirectory, "context-window.json")),
    readNamespacedJson(globalSettingsPath),
  ];
  const sharedSettings = [readJson(globalSettingsPath)];
  if (projectTrusted) {
    layers.push(
      readJson(join(projectDirectory, "context-window.json")),
      readNamespacedJson(projectSettingsPath),
    );
    sharedSettings.push(readJson(projectSettingsPath));
  }

  const defaultConfig = {
    ...DEFAULT_CONFIG,
    dbPath: join(home, ".pi", "context-window", "archive.db"),
    rocksdbPath: join(home, ".pi", "context-window", "archive.rocks"),
    semanticModelCachePath: join(home, ".pi", "context-window", "models"),
    semanticIndexPath: join(home, ".pi", "context-window", "semantic-index"),
    rerankerModelCachePath: join(home, ".pi", "context-window", "reranker-models"),
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
  const piCompactionReserveTokens = firstValid(
    parseNonNegativeInteger,
    env.CONTEXT_WINDOW_PI_COMPACTION_RESERVE_TOKENS,
    ...sharedSettings.map((settings) => settings.compaction?.reserveTokens).reverse(),
  );
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
  // The installer accepts the catalog's tier aliases (small/quality/default —
  // see model-catalog.js) as a convenience for `semanticModel`; resolve them
  // here too so setting semanticModel to an alias the installer just printed
  // does not silently miss the catalog and fall back to 384/mean.
  const rawSemanticModel = String(env.CONTEXT_WINDOW_SEMANTIC_MODEL ?? merged.semanticModel);
  const resolvedSemanticModel = SEMANTIC_TIER_ALIASES[rawSemanticModel] ?? rawSemanticModel;
  const explicitSemanticModelRevision = firstValid(
    (value) => (typeof value === "string" && value.trim().length > 0 ? value : undefined),
    env.CONTEXT_WINDOW_SEMANTIC_MODEL_REVISION,
    ...values("semanticModelRevision"),
  );
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
    piCompactionReserveTokens,
    retainTurns: numeric("retainTurns", parsePositiveInteger, env.CONTEXT_WINDOW_RETAIN_TURNS),
    maxToolResultTokens: numeric("maxToolResultTokens", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_TOOL_RESULT_TOKENS),
    maxToolArgumentTokens: numeric("maxToolArgumentTokens", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_TOOL_ARGUMENT_TOKENS),
    toolResultBudgetRatio: numeric("toolResultBudgetRatio", parsePositiveRatio, env.CONTEXT_WINDOW_TOOL_RESULT_BUDGET_RATIO),
    toolResultBudgetFloorTokens: numeric("toolResultBudgetFloorTokens", parsePositiveInteger, env.CONTEXT_WINDOW_TOOL_RESULT_BUDGET_FLOOR_TOKENS),
    dedupToolResults: booleanValue(
      env.CONTEXT_WINDOW_DEDUP_TOOL_RESULTS ?? merged.dedupToolResults,
      DEFAULT_CONFIG.dedupToolResults,
    ),
    maxInlineUserTokens: numeric("maxInlineUserTokens", parsePositiveInteger, env.CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS),
    searchResults: numeric("searchResults", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULTS),
    searchResultTokens: numeric("searchResultTokens", parsePositiveInteger, env.CONTEXT_WINDOW_SEARCH_RESULT_TOKENS),
    automaticRetrieval: booleanValue(
      env.CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL ?? merged.automaticRetrieval,
      DEFAULT_CONFIG.automaticRetrieval,
    ),
    recallScope: firstValid(
      parseRecallScope,
      env.CONTEXT_WINDOW_RECALL_SCOPE,
      ...values("recallScope"),
      DEFAULT_CONFIG.recallScope,
    ),
    // See DEFAULT_CONFIG.sessionContextRanking above for why this defaults on
    // and is scoped to the Pi adapter's own automatic digest only.
    sessionContextRanking: booleanValue(
      env.CONTEXT_WINDOW_SESSION_CONTEXT_RANKING ?? merged.sessionContextRanking,
      DEFAULT_CONFIG.sessionContextRanking,
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
    semanticRetrieval: booleanValue(
      env.CONTEXT_WINDOW_SEMANTIC_RETRIEVAL ?? merged.semanticRetrieval,
      DEFAULT_CONFIG.semanticRetrieval,
    ),
    semanticModel: resolvedSemanticModel,
    // An explicit revision always wins (custom/self-hosted models). Otherwise,
    // when the resolved model has a catalog entry, its pinned revision wins
    // over the settings default so switching semanticModel to a different
    // catalog model doesn't keep the previous model's pinned revision.
    semanticModelRevision: String(
      explicitSemanticModelRevision
        ?? semanticModelProfile(resolvedSemanticModel)?.revision
        ?? merged.semanticModelRevision,
    ),
    semanticModelCachePath: resolvedPath(
      env.CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE
        ?? merged.semanticModelCachePath
        ?? defaultConfig.semanticModelCachePath,
      home,
    ),
    semanticIndexPath: resolvedPath(
      env.CONTEXT_WINDOW_SEMANTIC_INDEX
        ?? merged.semanticIndexPath
        ?? defaultConfig.semanticIndexPath,
      home,
    ),
    semanticCandidates: numeric(
      "semanticCandidates",
      parsePositiveInteger,
      env.CONTEXT_WINDOW_SEMANTIC_CANDIDATES,
    ),
    // Left undefined unless explicitly set: LocalSemanticIndex derives both
    // from `semanticModel` via the catalog when these are absent.
    semanticModelDimensions: explicitNumeric(
      "semanticModelDimensions",
      env.CONTEXT_WINDOW_SEMANTIC_MODEL_DIMENSIONS,
    ),
    semanticModelPooling: firstValid(
      parsePoolingMode,
      env.CONTEXT_WINDOW_SEMANTIC_MODEL_POOLING,
      ...values("semanticModelPooling"),
    ),
    // Cross-encoder rerank for explicit search/gather only. It remains
    // disabled unless configuration or the environment opts in explicitly.
    rerankerEnabled: booleanValue(
      env.CONTEXT_WINDOW_RERANKER_ENABLED ?? merged.rerankerEnabled,
      DEFAULT_CONFIG.rerankerEnabled,
    ),
    rerankerModel: String(env.CONTEXT_WINDOW_RERANKER_MODEL ?? merged.rerankerModel),
    rerankerModelRevision: String(
      env.CONTEXT_WINDOW_RERANKER_MODEL_REVISION ?? merged.rerankerModelRevision,
    ),
    rerankerModelCachePath: resolvedPath(
      env.CONTEXT_WINDOW_RERANKER_MODEL_CACHE
        ?? merged.rerankerModelCachePath
        ?? defaultConfig.rerankerModelCachePath,
      home,
    ),
    rerankerCandidates: numeric(
      "rerankerCandidates",
      parsePositiveInteger,
      env.CONTEXT_WINDOW_RERANKER_CANDIDATES,
    ),
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
