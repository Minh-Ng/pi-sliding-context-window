import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findModelProfile, loadConfig, resolveModelConfig } from "../src/config.js";
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
