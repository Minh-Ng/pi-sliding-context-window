#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const OFFICIAL_EVALUATOR_COMMIT = "9e0b455f4ef0e2ab8f2e582289761153549043fc";
const OFFICIAL_JUDGE_MODEL = "gpt-4o-2024-08-06";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

export function getAnswerCheckPrompt(task, question, answer, response, { abstention = false } = {}) {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (["single-session-user", "single-session-assistant", "multi-session"].includes(task)) {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "temporal-reasoning") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  throw new Error(`Unsupported LongMemEval question type: ${task}`);
}

export function parseJudgeLabel(response) {
  return requiredString(response, "judge response").toLowerCase().includes("yes");
}

function textContent(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function parseArguments(argv) {
  const args = {
    model: "openai-codex/gpt-5.4-mini",
    thinking: "low",
    concurrency: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") args.input = argv[++index];
    else if (argument === "--output") args.output = argv[++index];
    else if (argument === "--model") args.model = argv[++index];
    else if (argument === "--thinking") args.thinking = argv[++index];
    else if (argument === "--concurrency") args.concurrency = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  requiredString(args.input, "--input");
  requiredString(args.output, "--output");
  if (!Number.isSafeInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 20) {
    throw new Error("--concurrency must be an integer from 1 to 20");
  }
  const [provider, ...modelParts] = args.model.split("/");
  if (!provider || modelParts.length === 0) throw new Error("--model must be provider/model");
  return { ...args, provider, modelId: modelParts.join("/") };
}

async function judgeCase(evaluationCase, options) {
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    model: options.model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: options.thinking,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });
  const session = created.session;
  const prompt = getAnswerCheckPrompt(
    evaluationCase.questionType,
    evaluationCase.question,
    evaluationCase.expectedAnswer,
    evaluationCase.finalAnswer,
    { abstention: evaluationCase.questionId.includes("_abs") },
  );
  const startedAt = Date.now();
  try {
    await session.prompt(prompt);
    const assistantMessages = session.messages.filter(({ role }) => role === "assistant");
    const rawResponse = textContent(assistantMessages.at(-1));
    return {
      questionId: evaluationCase.questionId,
      questionType: evaluationCase.questionType,
      label: parseJudgeLabel(rawResponse),
      rawResponse,
      promptSha256: sha256(prompt),
      durationMs: Date.now() - startedAt,
      usage: {
        input: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.input ?? 0), 0),
        output: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.output ?? 0), 0),
        cacheRead: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cacheRead ?? 0), 0),
        cacheWrite: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cacheWrite ?? 0), 0),
        cost: assistantMessages.reduce((sum, message) => sum + Number(message.usage?.cost?.total ?? 0), 0),
      },
    };
  } finally {
    session.dispose();
  }
}

function summarize(cases, judgments) {
  const byType = {};
  for (const type of [...new Set(cases.map(({ questionType }) => questionType))].sort()) {
    const labels = judgments.filter(({ questionType }) => questionType === type).map(({ label }) => label);
    byType[type] = { correct: labels.filter(Boolean).length, total: labels.length, accuracy: labels.filter(Boolean).length / labels.length };
  }
  const correct = judgments.filter(({ label }) => label).length;
  const abstention = judgments.filter(({ questionId }) => questionId.includes("_abs"));
  return {
    correct,
    total: judgments.length,
    overallAccuracy: correct / judgments.length,
    taskAveragedAccuracy: Object.values(byType).reduce((sum, entry) => sum + entry.accuracy, 0) / Object.keys(byType).length,
    abstention: {
      correct: abstention.filter(({ label }) => label).length,
      total: abstention.length,
      accuracy: abstention.length > 0 ? abstention.filter(({ label }) => label).length / abstention.length : null,
    },
    byType,
    judgeUsage: judgments.reduce((usage, judgment) => {
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"]) usage[field] += Number(judgment.usage?.[field] ?? 0);
      return usage;
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const inputBytes = readFileSync(resolve(args.input));
  const input = JSON.parse(inputBytes);
  if (!Array.isArray(input.cases) || input.cases.length === 0) throw new Error("input must contain cases");
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(args.provider, args.modelId);
  if (!model) throw new Error(`Model not found: ${args.model}`);
  const available = await modelRuntime.getAvailable();
  if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
    throw new Error(`Model is not authenticated: ${args.model}`);
  }
  const outputPath = resolve(args.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const judgments = new Array(input.cases.length);
  let cursor = 0;
  const writeCheckpoint = () => {
    const completed = judgments.filter(Boolean);
    const artifact = {
      format: "context-window.longmemeval-answer-judge.v1",
      generatedAt: new Date().toISOString(),
      input: { path: resolve(args.input), sha256: sha256(inputBytes) },
      provenance: {
        promptImplementation: `xiaowu0162/LongMemEval@${OFFICIAL_EVALUATOR_COMMIT}:src/evaluation/evaluate_qa.py`,
        officialJudgeModel: OFFICIAL_JUDGE_MODEL,
        executedJudgeModel: `${model.provider}/${model.id}`,
        exactOfficialPromptTemplates: true,
        executionHarness: "Pi agent session with its default system policy and no tools, extensions, skills, prompt templates, themes, or context files",
        leaderboardComparable: false,
        limitation: "The official gpt-4o API judge was unavailable. Labels use the exact official user-prompt templates with a different authenticated model inside a Pi session, so they are surrogate, non-leaderboard scores.",
      },
      completed: completed.length,
      summary: completed.length === input.cases.length ? summarize(input.cases, completed) : null,
      judgments: completed,
    };
    writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n");
  };
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= input.cases.length) return;
      const evaluationCase = input.cases[index];
      console.error(`Judging ${evaluationCase.questionId} (${index + 1}/${input.cases.length})...`);
      judgments[index] = await judgeCase(evaluationCase, { model, modelRuntime, thinking: args.thinking });
      writeCheckpoint();
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, input.cases.length) }, () => worker()));
  writeCheckpoint();
  return JSON.parse(readFileSync(outputPath));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((artifact) => {
    console.log(JSON.stringify(artifact.summary, null, 2));
  }).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
