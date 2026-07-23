const {
  createOfflinePilotCases,
  getOfflinePilotEvaluatorArtifacts,
} = require("../dist-electron/electron/backend/moss/evals/pilot-cases.js");
const { createTurnEvalExecutor } = require("../dist-electron/electron/backend/moss/evals/turn-eval-executor.js");
const { OpenAiCompatibleProvider } = require("../dist-electron/electron/backend/moss/providers/openai-compatible.js");
const { TOOL_REGISTRY } = require("../dist-electron/electron/backend/moss/tools/index.js");

const baseUrl = process.env.MOSS_EVAL_BASE_URL || "http://localhost:11434/v1";
const model = process.env.MOSS_EVAL_MODEL || "qwen3:8b";
const apiKey = process.env.MOSS_EVAL_API_KEY;
const repetitions = Number(process.env.MOSS_EVAL_REPETITIONS || "1");

if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("MOSS_EVAL_REPETITIONS must be a positive integer");
}

module.exports = {
  evaluatorVersion: "moss-harness-v1",
  evaluatorArtifacts: getOfflinePilotEvaluatorArtifacts(process.cwd()),
  cases: createOfflinePilotCases(process.cwd()).map((testCase) => ({ ...testCase, repetitions })),
  targets: [{
    schemaVersion: 1,
    id: "local-openai-compatible",
    providerId: baseUrl,
    providerKind: "openai-compatible",
    model,
  }],
  variants: [
    {
      schemaVersion: 1,
      id: "auto-approved",
      description: "Automatically approve mutating tools",
      promptProfile: "deterministic-production-v1",
      autoApprove: true,
      injectionMode: "flag",
      maxRounds: 8,
    },
    {
      schemaVersion: 1,
      id: "approval-gated",
      description: "Request approval before mutating tools",
      promptProfile: "deterministic-production-v1",
      autoApprove: false,
      injectionMode: "flag",
      maxRounds: 8,
    },
  ],
  createExecutor(target, variant, workspaceRoot) {
    return createTurnEvalExecutor({
      provider: new OpenAiCompatibleProvider(baseUrl, apiKey),
      model: target.model,
      toolRegistry: TOOL_REGISTRY,
      workspaceRoot: () => workspaceRoot,
      requestApproval: async () => true,
      promptNow: () => new Date(2026, 6, 23, 12),
      variant,
    });
  },
};