import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  findModelProfile,
  loadConfig,
  resolveModelConfig,
  saveGlobalConfig,
} from "../src/config.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { resolveContextLimits, shouldRotateWindow } from "../src/window.js";

test("trusted project config can disable the footer label accent", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-config-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(
      join(directory, ".pi", "context-window.json"),
      JSON.stringify({ statusLabelAccent: false }),
    );

    const config = loadConfig({ cwd: directory, projectTrusted: true, env: {}, home: directory });
    assert.equal(config.statusLabelAccent, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("global cap settings persist atomically without clobbering shared Pi settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-save-config-"));
  const settingsPath = join(directory, ".pi", "agent", "settings.json");
  try {
    mkdirSync(join(directory, ".pi", "agent"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      compaction: { reserveTokens: 128_000 },
      "context-window": {
        rotationTurns: 20,
        rotationTokens: 96_000,
        automaticRetrieval: false,
      },
    }));

    saveGlobalConfig({ rotationTurns: 30, rotationTokens: 128_000 }, { home: directory });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      theme: "dark",
      compaction: { reserveTokens: 128_000 },
      "context-window": {
        rotationTurns: 30,
        rotationTokens: 128_000,
        automaticRetrieval: false,
      },
    });
    assert.equal(statSync(settingsPath).mode & 0o077, 0);
    let config = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(config.rotationTurns, 30);
    assert.equal(config.rotationTokens, 128_000);
    assert.equal(config.rotationTokensExplicit, true);
    assert.equal(config.piCompactionReserveTokens, 128_000);

    saveGlobalConfig({ rotationTokens: undefined }, { home: directory });
    config = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(config.rotationTokens, 96_000);
    assert.equal(config.rotationTokensExplicit, false);
    assert.equal(config.automaticRetrieval, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi compaction reserve follows trusted settings precedence and environment override", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-pi-reserve-"));
  const globalPath = join(directory, ".pi", "agent", "settings.json");
  const projectPath = join(directory, ".pi", "settings.json");
  try {
    mkdirSync(dirname(globalPath), { recursive: true });
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ compaction: { reserveTokens: 128_000 } }));
    writeFileSync(projectPath, JSON.stringify({ compaction: { reserveTokens: 64_000 } }));

    assert.equal(loadConfig({
      cwd: directory,
      projectTrusted: false,
      env: {},
      home: directory,
    }).piCompactionReserveTokens, 128_000);
    assert.equal(loadConfig({
      cwd: directory,
      projectTrusted: true,
      env: {},
      home: directory,
    }).piCompactionReserveTokens, 64_000);
    assert.equal(loadConfig({
      cwd: directory,
      projectTrusted: true,
      env: { CONTEXT_WINDOW_PI_COMPACTION_RESERVE_TOKENS: "0" },
      home: directory,
    }).piCompactionReserveTokens, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh installs use RocksDB while existing SQLite archives require an explicit cutover", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-rocks-config-"));
  try {
    const defaults = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(defaults.archiveBackend, "rocksdb");
    assert.equal(defaults.rocksdbPath, join(directory, ".pi", "context-window", "archive.rocks"));
    assert.equal(defaults.dbPath, join(directory, ".pi", "context-window", "archive.db"));
    assert.equal(defaults.rocksdbMigrationSourcePath, defaults.dbPath);
    assert.equal(defaults.socketPath, defaultSocketPath(defaults.rocksdbPath));
    assert.equal(defaults.automaticRetrieval, true);
    assert.equal(defaults.hintBudgetTokens, 160);
    assert.equal(defaults.activeHintBudgetTokens, 640);
    assert.equal(defaults.epochHintBudgetTokens, 640);
    assert.equal(defaults.hintSourceCooldownHours, 24);
    assert.equal(defaults.maxInlineUserTokens, 16_000);
    assert.equal(defaults.toolResultBudgetRatio, 0.3);
    assert.equal(defaults.toolResultBudgetFloorTokens, 1_000);
    assert.equal(defaults.ephemeralAutoRetrievalDays, 7);
    assert.equal(defaults.conversationAutoRetrievalDays, 30);
    assert.equal(defaults.derivedAutoRetrievalDays, 30);
    assert.equal(defaults.ephemeralRetentionDays, 14);
    assert.equal(defaults.conversationRetentionDays, 90);
    assert.equal(defaults.derivedRetentionDays, 30);
    assert.equal(defaults.semanticRetrieval, true);
    assert.equal(defaults.semanticModel, "Xenova/all-MiniLM-L6-v2");
    assert.equal(defaults.semanticModelRevision, "751bff37182d3f1213fa05d7196b954e230abad9");
    assert.equal(defaults.semanticModelCachePath, join(directory, ".pi", "context-window", "models"));
    assert.equal(defaults.semanticIndexPath, join(directory, ".pi", "context-window", "semantic-index"));

    mkdirSync(join(directory, ".pi", "context-window"), { recursive: true });
    writeFileSync(defaults.dbPath, "legacy SQLite placeholder");
    assert.equal(loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory })
      .archiveBackend, "sqlite");
    const explicitCutover = loadConfig({
      cwd: directory,
      projectTrusted: false,
      env: { CONTEXT_WINDOW_BACKEND: "rocksdb" },
      home: directory,
    });
    assert.equal(explicitCutover.archiveBackend, "rocksdb");
    assert.equal(explicitCutover.rocksdbMigrationSourcePath, defaults.dbPath);

    const overridden = loadConfig({
      cwd: directory,
      projectTrusted: false,
      home: directory,
      env: {
        CONTEXT_WINDOW_BACKEND: "sqlite",
        CONTEXT_WINDOW_ROCKSDB: "~/rocks/custom",
        CONTEXT_WINDOW_SOCKET: "~/run/context-window.sock",
        CONTEXT_WINDOW_AUTOMATIC_RETRIEVAL: "false",
        CONTEXT_WINDOW_HINT_BUDGET_TOKENS: "80",
        CONTEXT_WINDOW_ACTIVE_HINT_BUDGET_TOKENS: "300",
        CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS: "320",
        CONTEXT_WINDOW_HINT_SOURCE_COOLDOWN_HOURS: "12",
        CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS: "8000",
        CONTEXT_WINDOW_EPHEMERAL_AUTO_RETRIEVAL_DAYS: "3",
        CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS: "21",
        CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS: "0",
        CONTEXT_WINDOW_EPHEMERAL_RETENTION_DAYS: "2",
        CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS: "30",
        CONTEXT_WINDOW_DERIVED_RETENTION_DAYS: "0",
        CONTEXT_WINDOW_SEMANTIC_RETRIEVAL: "true",
        CONTEXT_WINDOW_SEMANTIC_MODEL: "local/test-model",
        CONTEXT_WINDOW_SEMANTIC_MODEL_REVISION: "revision-1",
        CONTEXT_WINDOW_SEMANTIC_MODEL_CACHE: "~/models/local",
        CONTEXT_WINDOW_SEMANTIC_INDEX: "~/indexes/local",
        CONTEXT_WINDOW_SEMANTIC_CANDIDATES: "24",
      },
    });
    assert.equal(overridden.archiveBackend, "sqlite");
    assert.equal(overridden.rocksdbPath, join(directory, "rocks", "custom"));
    assert.equal(overridden.socketPath, join(directory, "run", "context-window.sock"));
    assert.equal(overridden.automaticRetrieval, false);
    assert.equal(overridden.hintBudgetTokens, 80);
    assert.equal(overridden.activeHintBudgetTokens, 300);
    assert.equal(overridden.epochHintBudgetTokens, 300);
    assert.equal(overridden.semanticRetrieval, true);
    assert.equal(overridden.semanticModel, "local/test-model");
    assert.equal(overridden.semanticModelRevision, "revision-1");
    assert.equal(overridden.semanticModelCachePath, join(directory, "models", "local"));
    assert.equal(overridden.semanticIndexPath, join(directory, "indexes", "local"));
    assert.equal(overridden.semanticCandidates, 24);
    assert.equal(overridden.hintSourceCooldownHours, 12);
    assert.equal(overridden.maxInlineUserTokens, 8_000);
    assert.equal(overridden.ephemeralAutoRetrievalDays, 3);
    assert.equal(overridden.conversationAutoRetrievalDays, 21);
    assert.equal(overridden.derivedAutoRetrievalDays, 0);
    assert.equal(overridden.ephemeralRetentionDays, 2);
    assert.equal(overridden.conversationRetentionDays, 30);
    assert.equal(overridden.derivedRetentionDays, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tool-result budget knobs resolve from env, settings, and defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-tool-budget-"));
  try {
    const fromEnv = loadConfig({
      cwd: directory,
      projectTrusted: false,
      env: {
        CONTEXT_WINDOW_TOOL_RESULT_BUDGET_RATIO: "0.5",
        CONTEXT_WINDOW_TOOL_RESULT_BUDGET_FLOOR_TOKENS: "750",
      },
      home: directory,
    });
    assert.equal(fromEnv.toolResultBudgetRatio, 0.5);
    assert.equal(fromEnv.toolResultBudgetFloorTokens, 750);

    mkdirSync(join(directory, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(directory, ".pi", "agent", "context-window.json"),
      JSON.stringify({ toolResultBudgetRatio: 0.15, toolResultBudgetFloorTokens: 2_000 }),
    );
    const fromSettings = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(fromSettings.toolResultBudgetRatio, 0.15);
    assert.equal(fromSettings.toolResultBudgetFloorTokens, 2_000);

    // Invalid values fall back to the shipped defaults (ratio must be in (0, 1];
    // floor must be a positive integer).
    const invalid = loadConfig({
      cwd: directory,
      projectTrusted: false,
      env: {
        CONTEXT_WINDOW_TOOL_RESULT_BUDGET_RATIO: "2",
        CONTEXT_WINDOW_TOOL_RESULT_BUDGET_FLOOR_TOKENS: "-5",
      },
      home: directory,
    });
    assert.equal(invalid.toolResultBudgetRatio, 0.15);
    assert.equal(invalid.toolResultBudgetFloorTokens, 2_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active hint budget resolves its legacy alias by normal config precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-hint-budget-alias-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      activeHintBudgetTokens: 500,
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { epochHintBudgetTokens: 320 },
    }));

    const projectLegacy = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.equal(projectLegacy.activeHintBudgetTokens, 320);
    assert.equal(projectLegacy.epochHintBudgetTokens, 320);

    const environmentLegacy = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: { CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS: "240" },
      home,
    });
    assert.equal(environmentLegacy.activeHintBudgetTokens, 240);
    assert.equal(environmentLegacy.epochHintBudgetTokens, 240);

    const environmentPrimary = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_ACTIVE_HINT_BUDGET_TOKENS: "180",
        CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS: "200",
      },
      home,
    });
    assert.equal(environmentPrimary.activeHintBudgetTokens, 180);
    assert.equal(environmentPrimary.epochHintBudgetTokens, 180);

    const invalidEnvironment = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_ACTIVE_HINT_BUDGET_TOKENS: "invalid",
        CONTEXT_WINDOW_EPOCH_HINT_BUDGET_TOKENS: "invalid",
      },
      home,
    });
    assert.equal(invalidEnvironment.activeHintBudgetTokens, 320);
    assert.equal(invalidEnvironment.epochHintBudgetTokens, 320);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new archive policy settings honor scope and environment precedence with invalid fallthrough", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-policy-layers-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const projectSettings = join(project, ".pi", "settings.json");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      maxInlineUserTokens: 20_000,
      hintSourceCooldownHours: 20,
      ephemeralAutoRetrievalDays: 6,
      conversationAutoRetrievalDays: 26,
      derivedAutoRetrievalDays: 16,
      ephemeralRetentionDays: 13,
      conversationRetentionDays: 83,
      derivedRetentionDays: 23,
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      maxInlineUserTokens: 18_000,
      hintSourceCooldownHours: 18,
      ephemeralAutoRetrievalDays: 5,
      conversationAutoRetrievalDays: 25,
      derivedAutoRetrievalDays: 15,
      ephemeralRetentionDays: 12,
      conversationRetentionDays: 82,
      derivedRetentionDays: 22,
    }));
    writeFileSync(projectSettings, JSON.stringify({
      "context-window": {
        maxInlineUserTokens: 17_000,
        hintSourceCooldownHours: 17,
        ephemeralAutoRetrievalDays: 4,
        conversationAutoRetrievalDays: 24,
        derivedAutoRetrievalDays: 0,
        ephemeralRetentionDays: 11,
        conversationRetentionDays: 81,
        derivedRetentionDays: 0,
      },
    }));

    const projectPolicy = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.deepEqual({
      maxInlineUserTokens: projectPolicy.maxInlineUserTokens,
      hintSourceCooldownHours: projectPolicy.hintSourceCooldownHours,
      ephemeralAutoRetrievalDays: projectPolicy.ephemeralAutoRetrievalDays,
      conversationAutoRetrievalDays: projectPolicy.conversationAutoRetrievalDays,
      derivedAutoRetrievalDays: projectPolicy.derivedAutoRetrievalDays,
      ephemeralRetentionDays: projectPolicy.ephemeralRetentionDays,
      conversationRetentionDays: projectPolicy.conversationRetentionDays,
      derivedRetentionDays: projectPolicy.derivedRetentionDays,
    }, {
      maxInlineUserTokens: 17_000,
      hintSourceCooldownHours: 17,
      ephemeralAutoRetrievalDays: 4,
      conversationAutoRetrievalDays: 24,
      derivedAutoRetrievalDays: 0,
      ephemeralRetentionDays: 11,
      conversationRetentionDays: 81,
      derivedRetentionDays: 0,
    });

    const environmentPolicy = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS: "15000",
        CONTEXT_WINDOW_HINT_SOURCE_COOLDOWN_HOURS: "12",
        CONTEXT_WINDOW_EPHEMERAL_AUTO_RETRIEVAL_DAYS: "3",
        CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS: "21",
        CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS: "9",
        CONTEXT_WINDOW_EPHEMERAL_RETENTION_DAYS: "10",
        CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS: "70",
        CONTEXT_WINDOW_DERIVED_RETENTION_DAYS: "20",
      },
      home,
    });
    assert.deepEqual({
      maxInlineUserTokens: environmentPolicy.maxInlineUserTokens,
      hintSourceCooldownHours: environmentPolicy.hintSourceCooldownHours,
      ephemeralAutoRetrievalDays: environmentPolicy.ephemeralAutoRetrievalDays,
      conversationAutoRetrievalDays: environmentPolicy.conversationAutoRetrievalDays,
      derivedAutoRetrievalDays: environmentPolicy.derivedAutoRetrievalDays,
      ephemeralRetentionDays: environmentPolicy.ephemeralRetentionDays,
      conversationRetentionDays: environmentPolicy.conversationRetentionDays,
      derivedRetentionDays: environmentPolicy.derivedRetentionDays,
    }, {
      maxInlineUserTokens: 15_000,
      hintSourceCooldownHours: 12,
      ephemeralAutoRetrievalDays: 3,
      conversationAutoRetrievalDays: 21,
      derivedAutoRetrievalDays: 9,
      ephemeralRetentionDays: 10,
      conversationRetentionDays: 70,
      derivedRetentionDays: 20,
    });

    writeFileSync(projectSettings, JSON.stringify({
      "context-window": {
        maxInlineUserTokens: null,
        hintSourceCooldownHours: false,
        ephemeralAutoRetrievalDays: "",
        conversationAutoRetrievalDays: " ",
        derivedAutoRetrievalDays: "invalid",
        ephemeralRetentionDays: null,
        conversationRetentionDays: false,
        derivedRetentionDays: "",
      },
    }));
    const invalidPolicy = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_MAX_INLINE_USER_TOKENS: "",
        CONTEXT_WINDOW_HINT_SOURCE_COOLDOWN_HOURS: " ",
        CONTEXT_WINDOW_EPHEMERAL_AUTO_RETRIEVAL_DAYS: "",
        CONTEXT_WINDOW_CONVERSATION_AUTO_RETRIEVAL_DAYS: " ",
        CONTEXT_WINDOW_DERIVED_AUTO_RETRIEVAL_DAYS: "invalid",
        CONTEXT_WINDOW_EPHEMERAL_RETENTION_DAYS: "",
        CONTEXT_WINDOW_CONVERSATION_RETENTION_DAYS: " ",
        CONTEXT_WINDOW_DERIVED_RETENTION_DAYS: "invalid",
      },
      home,
    });
    assert.deepEqual({
      maxInlineUserTokens: invalidPolicy.maxInlineUserTokens,
      hintSourceCooldownHours: invalidPolicy.hintSourceCooldownHours,
      ephemeralAutoRetrievalDays: invalidPolicy.ephemeralAutoRetrievalDays,
      conversationAutoRetrievalDays: invalidPolicy.conversationAutoRetrievalDays,
      derivedAutoRetrievalDays: invalidPolicy.derivedAutoRetrievalDays,
      ephemeralRetentionDays: invalidPolicy.ephemeralRetentionDays,
      conversationRetentionDays: invalidPolicy.conversationRetentionDays,
      derivedRetentionDays: invalidPolicy.derivedRetentionDays,
    }, {
      maxInlineUserTokens: 18_000,
      hintSourceCooldownHours: 18,
      ephemeralAutoRetrievalDays: 5,
      conversationAutoRetrievalDays: 25,
      derivedAutoRetrievalDays: 15,
      ephemeralRetentionDays: 12,
      conversationRetentionDays: 82,
      derivedRetentionDays: 22,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ratio defaults scale with model metadata and retain absolute fallbacks", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-defaults-"));
  try {
    const config = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(config.rotationTokensExplicit, false);
    assert.equal(config.hardLimitTokensExplicit, false);
    assert.deepEqual(resolveContextLimits(config, { contextWindow: 100_000 }), {
      rotationTokens: 65_000,
      hardLimitTokens: 80_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
    assert.deepEqual(resolveContextLimits(config, { contextWindow: 1_000_000 }), {
      rotationTokens: 650_000,
      hardLimitTokens: 800_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
    assert.equal(shouldRotateWindow({
      ...resolveContextLimits(config, { contextWindow: 1_000_000 }),
      tokens: 200_000,
      turns: 16,
    }), false);
    assert.deepEqual(resolveContextLimits(config, undefined), {
      rotationTokens: 96_000,
      hardLimitTokens: 128_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model profiles use the most specific wildcard match", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-models-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(join(directory, ".pi", "context-window.json"), JSON.stringify({
      rotationContextRatio: 0.6,
      hardLimitContextRatio: 0.8,
      models: {
        "anthropic/*": { rotationContextRatio: 0.7, rotationTurns: 22 },
        "anthropic/claude-*": { rotationContextRatio: 0.75, rotationTurns: 24 },
        invalid: { rotationContextRatio: 0.9 },
        "openai/gpt-*": { rotationContextRatio: 2, rotationTurns: 0 },
        "empty/model": {},
      },
    }));

    const config = loadConfig({ cwd: directory, projectTrusted: true, env: {}, home: directory });
    const claude = { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 };
    assert.deepEqual(findModelProfile(config.models, claude), {
      pattern: "anthropic/claude-*",
      rotationContextRatio: 0.75,
      rotationTurns: 24,
    });
    assert.deepEqual(resolveModelConfig(config, claude), {
      rotationContextRatio: 0.75,
      hardLimitContextRatio: 0.8,
      rotationTurns: 24,
      pattern: "anthropic/claude-*",
    });
    assert.deepEqual(resolveContextLimits(config, claude), {
      rotationTokens: 150_000,
      hardLimitTokens: 160_000,
      rotationTurns: 24,
      modelPattern: "anthropic/claude-*",
    });
    assert.equal(config.models.invalid, undefined);
    assert.equal(config.models["openai/gpt-*"], undefined);
    assert.equal(config.models["empty/model"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model profile wildcards treat every character except star literally", () => {
  const models = {
    "openai/gpt?4": { rotationTurns: 12 },
    "?/model": { rotationTurns: 14 },
    "provider/model[preview]": { rotationTurns: 16 },
  };

  assert.equal(findModelProfile(models, { provider: "openai", id: "gpt?4" }).rotationTurns, 12);
  assert.equal(findModelProfile(models, { provider: "openai", id: "gpta4" }), undefined);
  assert.equal(findModelProfile(models, { provider: "?", id: "model" }).rotationTurns, 14);
  assert.equal(findModelProfile(models, { provider: "provider", id: "model[preview]" }).rotationTurns, 16);
});

test("model profile wildcard matching remains linear on dense near misses", () => {
  const pattern = `*${"a".repeat(2_048)}b/model`;
  const provider = "a".repeat(32_768);
  const startedAt = performance.now();
  assert.equal(findModelProfile({
    [pattern]: { rotationTurns: 12 },
  }, { provider, id: "model" }), undefined);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 250, `model profile matching took ${elapsedMs.toFixed(1)} ms`);
});

test("model profile matching preserves Unicode simple case folding", () => {
  for (const [patternProvider, modelProvider] of [
    ["s", "ſ"],
    ["ſ", "s"],
    ["Σ", "ς"],
    ["σ", "ς"],
    ["ς", "Σ"],
    ["k", "K"],
    ["ß", "ẞ"],
    ["μ", "µ"],
  ]) {
    assert.equal(findModelProfile({
      [`${patternProvider}*/model`]: { rotationTurns: 12 },
    }, { provider: modelProvider, id: "model" }).rotationTurns, 12);
  }
  assert.equal(findModelProfile({
    "i*/model": { rotationTurns: 12 },
  }, { provider: "İ", id: "model" }), undefined);
  assert.equal(findModelProfile({
    "i*/model": { rotationTurns: 12 },
  }, { provider: "ı", id: "model" }), undefined);
});

test("model profile wildcard matching agrees with a dynamic-programming reference", () => {
  const strings = (alphabet, maxLength) => {
    const values = [""];
    let frontier = [""];
    for (let length = 1; length <= maxLength; length += 1) {
      frontier = frontier.flatMap((prefix) => alphabet.map((character) => prefix + character));
      values.push(...frontier);
    }
    return values;
  };
  const reference = (pattern, value) => {
    const table = Array.from(
      { length: pattern.length + 1 },
      () => new Uint8Array(value.length + 1),
    );
    table[0][0] = 1;
    for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex += 1) {
      if (pattern[patternIndex - 1] === "*") {
        table[patternIndex][0] = table[patternIndex - 1][0];
      }
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex += 1) {
        table[patternIndex][valueIndex] = pattern[patternIndex - 1] === "*"
          ? Number(table[patternIndex - 1][valueIndex] || table[patternIndex][valueIndex - 1])
          : Number(table[patternIndex - 1][valueIndex - 1]
            && pattern[patternIndex - 1] === value[valueIndex - 1]);
      }
    }
    return table[pattern.length][value.length] === 1;
  };
  const patternParts = strings(["a", "b", "*", "?"], 2);
  const valueParts = strings(["a", "b", "?"], 2).filter(Boolean);
  for (const leftPattern of patternParts) {
    for (const rightPattern of patternParts) {
      const pattern = `${leftPattern}/${rightPattern}`;
      for (const provider of valueParts) {
        for (const id of valueParts) {
          const value = `${provider}/${id}`;
          assert.equal(
            findModelProfile({ [pattern]: { rotationTurns: 12 } }, { provider, id }) !== undefined,
            reference(pattern, value),
            `${JSON.stringify(pattern)} against ${JSON.stringify(value)}`,
          );
        }
      }
    }
  }
});

test("project profiles merge over global profiles field by field", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-profile-layers-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: {
        "anthropic/claude-*": { rotationContextRatio: 0.7, hardLimitContextRatio: 0.85, rotationTurns: 22 },
      },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      models: {
        "anthropic/claude-*": { rotationTurns: 24 },
      },
    }));

    const config = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.deepEqual(resolveModelConfig(config, { provider: "anthropic", id: "claude-opus" }), {
      rotationContextRatio: 0.7,
      hardLimitContextRatio: 0.85,
      rotationTurns: 24,
      pattern: "anthropic/claude-*",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("equally specific model patterns use declaration order", () => {
  const match = findModelProfile({
    "a*/model": { rotationTurns: 12 },
    "*a/model": { rotationTurns: 14 },
  }, { provider: "aa", id: "model" });
  assert.equal(match.rotationTurns, 14);
});

test("equally specific model declarations remain ordered across formats", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-profile-order-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: { "a*/model": { rotationTurns: 12 } },
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": { models: { "*a/model": { rotationTurns: 14 } } },
    }));

    const config = loadConfig({ cwd: root, projectTrusted: false, env: {}, home });
    assert.equal(findModelProfile(config.models, { provider: "aa", id: "model" }).rotationTurns, 14);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("higher-precedence redeclarations move to their later source-order position", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-profile-redeclaration-order-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: {
        "a*/model": { rotationContextRatio: 0.6, rotationTurns: 12 },
        "*a/model": { rotationTurns: 14 },
      },
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": { models: { "a*/model": { rotationTurns: 16 } } },
    }));

    const config = loadConfig({ cwd: root, projectTrusted: false, env: {}, home });
    assert.deepEqual(findModelProfile(config.models, { provider: "aa", id: "model" }), {
      pattern: "a*/model",
      rotationContextRatio: 0.6,
      rotationTurns: 16,
    });
    assert.deepEqual(Object.keys(config.models), ["*a/model", "a*/model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid and empty case-variant redeclarations retain identity and move later", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-profile-empty-redeclarations-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: {
        "A*/MODEL": { rotationContextRatio: 0.6, hardLimitContextRatio: 0.8, rotationTurns: 12 },
        "*a/model": { rotationTurns: 14 },
      },
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": {
        models: {
          "a*/Model": { rotationContextRatio: 0, hardLimitContextRatio: "invalid", rotationTurns: -1 },
        },
      },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      models: { "*a/model": { rotationTurns: 16 } },
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { models: { "A*/model": {} } },
    }));

    const model = { provider: "aa", id: "model" };
    const globalConfig = loadConfig({ cwd: project, projectTrusted: false, env: {}, home });
    assert.deepEqual(Object.keys(globalConfig.models), ["*a/model", "a*/Model"]);
    assert.deepEqual(findModelProfile(globalConfig.models, model), {
      pattern: "a*/Model",
      rotationContextRatio: 0.6,
      hardLimitContextRatio: 0.8,
      rotationTurns: 12,
    });

    const projectConfig = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.deepEqual(Object.keys(projectConfig.models), ["*a/model", "A*/model"]);
    assert.deepEqual(findModelProfile(projectConfig.models, model), {
      pattern: "A*/model",
      rotationContextRatio: 0.6,
      hardLimitContextRatio: 0.8,
      rotationTurns: 12,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("case-variant model redeclarations merge across every config layer", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-profile-case-layers-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: { "Anthropic/CLAUDE-*": { rotationContextRatio: 0.6, rotationTurns: 18 } },
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": {
        models: {
          "anthropic/claude-*": { rotationContextRatio: 0.65 },
          "a*thropic/claude-*": { rotationTurns: 20 },
        },
      },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      models: { "ANTHROPIC/claude-*": { hardLimitContextRatio: 0.85 } },
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { models: { "anthropic/Claude-*": { rotationTurns: 24 } } },
    }));

    const config = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.deepEqual(Object.keys(config.models), ["a*thropic/claude-*", "anthropic/Claude-*"]);
    const model = { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 };
    assert.deepEqual(findModelProfile(config.models, model), {
      pattern: "anthropic/Claude-*",
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.85,
      rotationTurns: 24,
    });
    assert.deepEqual(resolveContextLimits(config, model), {
      rotationTokens: 130_000,
      hardLimitTokens: 170_000,
      rotationTurns: 24,
      modelPattern: "anthropic/Claude-*",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment policy overrides matching model profiles", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-model-env-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(join(directory, ".pi", "context-window.json"), JSON.stringify({
      models: {
        "anthropic/claude-*": { rotationContextRatio: 0.75, hardLimitContextRatio: 0.9, rotationTurns: 24 },
      },
    }));
    const config = loadConfig({
      cwd: directory,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO: "0.5",
        CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO: "0.7",
        CONTEXT_WINDOW_ROTATION_TURNS: "12",
      },
      home: directory,
    });

    assert.deepEqual(resolveModelConfig(config, { provider: "anthropic", id: "claude-sonnet" }), {
      rotationContextRatio: 0.5,
      hardLimitContextRatio: 0.7,
      rotationTurns: 12,
      pattern: "anthropic/claude-*",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid environment values do not suppress valid profiles or create caps", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-invalid-env-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(join(directory, ".pi", "context-window.json"), JSON.stringify({
      models: {
        "anthropic/claude-*": { rotationContextRatio: 0.75, hardLimitContextRatio: 0.9, rotationTurns: 24 },
      },
    }));
    const config = loadConfig({
      cwd: directory,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO: "not-a-ratio",
        CONTEXT_WINDOW_HARD_LIMIT_CONTEXT_RATIO: "2",
        CONTEXT_WINDOW_ROTATION_TURNS: "0",
        CONTEXT_WINDOW_ROTATION_TOKENS: "invalid",
        CONTEXT_WINDOW_HARD_LIMIT_TOKENS: "-1",
      },
      home: directory,
    });

    assert.equal(config.rotationTokensExplicit, false);
    assert.equal(config.hardLimitTokensExplicit, false);
    assert.deepEqual(resolveModelConfig(config, { provider: "anthropic", id: "claude-sonnet" }), {
      rotationContextRatio: 0.75,
      hardLimitContextRatio: 0.9,
      rotationTurns: 24,
      pattern: "anthropic/claude-*",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("valid environment token limits remain explicit caps and fallbacks", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-env-caps-"));
  try {
    const config = loadConfig({
      cwd: directory,
      projectTrusted: false,
      env: {
        CONTEXT_WINDOW_ROTATION_TOKENS: "70000",
        CONTEXT_WINDOW_HARD_LIMIT_TOKENS: "90000",
      },
      home: directory,
    });
    assert.deepEqual(resolveContextLimits(config, { contextWindow: 200_000 }), {
      rotationTokens: 70_000,
      hardLimitTokens: 90_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
    assert.deepEqual(resolveContextLimits(config, undefined), {
      rotationTokens: 70_000,
      hardLimitTokens: 90_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit absolute token settings remain model-safe caps", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-legacy-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(join(directory, ".pi", "context-window.json"), JSON.stringify({
      rotationTokens: 96_000,
      hardLimitTokens: 128_000,
      rotationContextRatio: 0.7,
      hardLimitContextRatio: 0.8,
    }));
    const config = loadConfig({ cwd: directory, projectTrusted: true, env: {}, home: directory });

    assert.deepEqual(resolveContextLimits(config, { contextWindow: 372_000 }), {
      rotationTokens: 96_000,
      hardLimitTokens: 128_000,
      rotationTurns: 20,
      modelPattern: undefined,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("untrusted project config cannot change footer styling", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-config-"));
  try {
    mkdirSync(join(directory, ".pi"));
    writeFileSync(
      join(directory, ".pi", "context-window.json"),
      JSON.stringify({ statusLabelAccent: false }),
    );

    const config = loadConfig({ cwd: directory, projectTrusted: false, env: {}, home: directory });
    assert.equal(config.statusLabelAccent, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared settings follow cross-format and scope precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-layers-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({ rotationTurns: 11 }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      unrelated: true,
      "context-window": { rotationTurns: 12 },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({ rotationTurns: 13 }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { rotationTurns: 14, dbPath: "~/namespaced/archive.db" },
    }));

    const trusted = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.equal(trusted.rotationTurns, 14);
    assert.equal(trusted.dbPath, join(home, "namespaced", "archive.db"));
    assert.equal(loadConfig({ cwd: project, projectTrusted: false, env: {}, home }).rotationTurns, 12);
    assert.equal(loadConfig({
      cwd: project,
      projectTrusted: true,
      env: { CONTEXT_WINDOW_ROTATION_TURNS: "15" },
      home,
    }).rotationTurns, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model profiles merge field by field across legacy and namespaced layers", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-profiles-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const pattern = "anthropic/claude-*";
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      models: { [pattern]: { rotationContextRatio: 0.6, hardLimitContextRatio: 0.8, rotationTurns: 18 } },
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": { models: { [pattern]: { rotationContextRatio: 0.65 } } },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      models: { [pattern]: { hardLimitContextRatio: 0.85 } },
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { models: { [pattern]: { rotationTurns: 24 } } },
    }));

    assert.deepEqual(loadConfig({ cwd: project, projectTrusted: true, env: {}, home }).models[pattern], {
      rotationContextRatio: 0.65,
      hardLimitContextRatio: 0.85,
      rotationTurns: 24,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid numeric settings fall through every format layer", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-invalid-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      rotationContextRatio: 0.55,
      retainTurns: 7,
      rotationTokens: 70_000,
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": { rotationContextRatio: 2, retainTurns: 0, rotationTokens: -1 },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({
      rotationContextRatio: 0,
      retainTurns: "invalid",
      rotationTokens: "invalid",
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { rotationContextRatio: -1, retainTurns: -2, rotationTokens: 0 },
    }));

    const config = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_ROTATION_CONTEXT_RATIO: "invalid",
        CONTEXT_WINDOW_RETAIN_TURNS: "0",
        CONTEXT_WINDOW_ROTATION_TOKENS: "invalid",
      },
      home,
    });
    assert.equal(config.rotationContextRatio, 0.55);
    assert.equal(config.retainTurns, 7);
    assert.equal(config.rotationTokens, 70_000);
    assert.equal(config.rotationTokensExplicit, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive retention settings follow precedence and normalize the cleanup target", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-retention-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": {
        maxArchiveBytes: 10_000,
        targetArchiveBytes: 8_000,
        recentDocumentProtectionDays: 9,
        minimumTurnsPerSession: 11,
      },
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { targetArchiveBytes: 7_000 },
    }));

    const configured = loadConfig({ cwd: project, projectTrusted: true, env: {}, home });
    assert.equal(configured.maxArchiveBytes, 10_000);
    assert.equal(configured.targetArchiveBytes, 7_000);
    assert.equal(configured.recentDocumentProtectionDays, 9);
    assert.equal(configured.minimumTurnsPerSession, 11);

    const environment = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_MAX_ARCHIVE_BYTES: "6000",
        CONTEXT_WINDOW_TARGET_ARCHIVE_BYTES: "9000",
        CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS: "3",
        CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION: "4",
      },
      home,
    });
    assert.equal(environment.maxArchiveBytes, 6_000);
    assert.equal(environment.targetArchiveBytes, 4_500);
    assert.equal(environment.recentDocumentProtectionDays, 3);
    assert.equal(environment.minimumTurnsPerSession, 4);

    const disabledProtection = loadConfig({
      cwd: project,
      projectTrusted: true,
      env: {
        CONTEXT_WINDOW_RECENT_DOCUMENT_PROTECTION_DAYS: "0",
        CONTEXT_WINDOW_MINIMUM_TURNS_PER_SESSION: "0",
      },
      home,
    });
    assert.equal(disabledProtection.recentDocumentProtectionDays, 0);
    assert.equal(disabledProtection.minimumTurnsPerSession, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed shared settings report the exact path", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-malformed-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const globalSettings = join(home, ".pi", "agent", "settings.json");
  const projectSettings = join(project, ".pi", "settings.json");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(globalSettings, "{");
    assert.throws(
      () => loadConfig({ cwd: project, projectTrusted: true, env: {}, home }),
      (error) => error instanceof Error && error.message.startsWith(`Invalid context-window config ${globalSettings}:`),
    );

    writeFileSync(globalSettings, JSON.stringify({ "context-window": null }));
    writeFileSync(projectSettings, "{");
    assert.throws(
      () => loadConfig({ cwd: project, projectTrusted: true, env: {}, home }),
      (error) => error instanceof Error && error.message.startsWith(`Invalid context-window config ${projectSettings}:`),
    );
    assert.doesNotThrow(() => loadConfig({ cwd: project, projectTrusted: false, env: {}, home }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or non-object namespaces are ignored and legacy-only config remains compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-legacy-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "context-window.json"), JSON.stringify({
      searchResults: 8,
      dbPath: "~/custom/archive.db",
    }));
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": ["not", "a", "config"],
    }));

    const config = loadConfig({ cwd: root, projectTrusted: false, env: {}, home });
    assert.equal(config.searchResults, 8);
    assert.equal(config.dbPath, join(home, "custom", "archive.db"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrusted projects load neither legacy nor shared project settings", () => {
  const root = mkdtempSync(join(tmpdir(), "context-window-settings-untrusted-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      "context-window": { searchResults: 4 },
    }));
    writeFileSync(join(project, ".pi", "context-window.json"), JSON.stringify({ searchResults: 7 }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      "context-window": { searchResults: 9 },
    }));

    assert.equal(loadConfig({ cwd: project, projectTrusted: false, env: {}, home }).searchResults, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
