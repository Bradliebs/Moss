const { createOfflinePilotCases } = require("../dist-electron/electron/backend/moss/evals/pilot-cases.js");
const { createTurnEvalExecutor } = require("../dist-electron/electron/backend/moss/evals/turn-eval-executor.js");
const { OpenAiCompatibleProvider } = require("../dist-electron/electron/backend/moss/providers/openai-compatible.js");
const { TOOL_REGISTRY } = require("../dist-electron/electron/backend/moss/tools/index.js");

const baseUrl = process.env.MOSS_EVAL_BASE_URL || "http://localhost:11434/v1";
const model = process.env.MOSS_EVAL_MODEL || "qwen3:8b";
const apiKey = process.env.MOSS_EVAL_API_KEY;

module.exports = {
  evaluatorVersion: "moss-harness-v1",
  cases: createOfflinePilotCases(process.cwd()),
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
      autoApprove: true,
      injectionMode: "flag",
      maxRounds: 8,
    },
    {
      schemaVersion: 1,
      id: "approval-gated",
      description: "Request approval before mutating tools",
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
      variant,
    });
  },
};