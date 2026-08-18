const {
  createOfflinePilotCases,
  getOfflinePilotEvaluatorArtifacts,
} = require("../dist-electron/electron/backend/moss/evals/pilot-cases.js");
const {
  REPRESENTATIVE_CORPUS_POLICY,
  createRepresentativeCorpus,
  getRepresentativeEvaluatorArtifacts,
} = require("../dist-electron/electron/backend/moss/evals/representative-corpus.js");
const { createRepresentativeGraderHealthProbes } = require("../dist-electron/electron/backend/moss/evals/grader-health.js");
const { createTurnEvalExecutor } = require("../dist-electron/electron/backend/moss/evals/turn-eval-executor.js");
const { OpenAiCompatibleProvider } = require("../dist-electron/electron/backend/moss/providers/openai-compatible.js");
const { TOOL_REGISTRY } = require("../dist-electron/electron/backend/moss/tools/index.js");

const baseUrl = process.env.MOSS_EVAL_BASE_URL || "http://localhost:11434/v1";
const model = process.env.MOSS_EVAL_MODEL || "qwen3:8b";
const apiKey = process.env.MOSS_EVAL_API_KEY;
const repetitions = Number(process.env.MOSS_EVAL_REPETITIONS || "1");
const corpus = process.env.MOSS_EVAL_CORPUS || "pilot";
const experiment = process.env.MOSS_EVAL_EXPERIMENT || "approval";
const concurrency = Number(process.env.MOSS_EVAL_CONCURRENCY || "1");
const providerConcurrency = Number(process.env.MOSS_EVAL_PROVIDER_CONCURRENCY || String(concurrency));
const requestedSuites = (process.env.MOSS_EVAL_SUITES || "").split(",").map((suite) => suite.trim()).filter(Boolean);
const knownSuites = new Set(["regression", "capability", "challenge"]);

if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("MOSS_EVAL_REPETITIONS must be a positive integer");
}
if (corpus !== "pilot" && corpus !== "representative") {
  throw new Error("MOSS_EVAL_CORPUS must be 'pilot' or 'representative'");
}
if (experiment !== "approval" && experiment !== "phase5-runtime") {
  throw new Error("MOSS_EVAL_EXPERIMENT must be 'approval' or 'phase5-runtime'");
}
if (requestedSuites.some((suite) => !knownSuites.has(suite))) {
  throw new Error("MOSS_EVAL_SUITES contains an unknown suite");
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(providerConcurrency) || providerConcurrency < 1) {
  throw new Error("MOSS_EVAL_CONCURRENCY and MOSS_EVAL_PROVIDER_CONCURRENCY must be positive integers");
}

const allCases = corpus === "representative"
  ? createRepresentativeCorpus(process.cwd())
  : createOfflinePilotCases(process.cwd());
const cases = requestedSuites.length > 0
  ? allCases.filter((testCase) => requestedSuites.includes(testCase.suite))
  : allCases;
if (cases.length === 0) throw new Error("Suite selection produced no evaluation cases");
const fullRepresentativeCorpus = corpus === "representative" && requestedSuites.length === 0;

module.exports = {
  evaluatorVersion: "moss-harness-v1",
  evaluatorArtifacts: corpus === "representative"
    ? getRepresentativeEvaluatorArtifacts(process.cwd())
    : getOfflinePilotEvaluatorArtifacts(process.cwd()),
  cases: cases.map((testCase) => ({ ...testCase, repetitions })),
  corpusPolicy: fullRepresentativeCorpus ? REPRESENTATIVE_CORPUS_POLICY : undefined,
  graderHealthProbes: fullRepresentativeCorpus
    ? createRepresentativeGraderHealthProbes(cases, process.cwd())
    : undefined,
  matrix: {
    maxConcurrency: concurrency,
    providerConcurrency: { [baseUrl]: providerConcurrency },
  },
  targets: [{
    schemaVersion: 1,
    id: "local-openai-compatible",
    providerId: baseUrl,
    providerKind: "openai-compatible",
    model,
  }],
  variants: experiment === "phase5-runtime" ? [
    {
      schemaVersion: 1,
      id: "phase5-baseline",
      description: "Production-compatible runtime baseline",
      promptProfile: "deterministic-production-v1",
      autoApprove: true,
      injectionMode: "flag",
      maxRounds: 8,
      runtime: {
        contextStrategy: "full",
        planningPolicy: "free-form",
        verificationCadence: "terminal",
        recoveryPolicy: "standard",
        reviewerPass: "off",
      },
    },
    {
      schemaVersion: 1,
      id: "phase5-candidate",
      description: "Incremental runtime with compact context and signature-aware recovery",
      promptProfile: "deterministic-production-v1",
      autoApprove: true,
      injectionMode: "flag",
      maxRounds: 8,
      runtime: {
        contextStrategy: "compact",
        planningPolicy: "incremental",
        verificationCadence: "after-mutation",
        recoveryPolicy: "signature-aware",
        reviewerPass: "diagnostic",
      },
    },
  ] : [
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
  createExecutor(target, variant, workspaceRoot, context) {
    return createTurnEvalExecutor({
      provider: new OpenAiCompatibleProvider(baseUrl, apiKey),
      model: target.model,
      toolRegistry: TOOL_REGISTRY,
      workspaceRoot: () => workspaceRoot,
      requestApproval: async () => true,
      promptNow: () => new Date(2026, 6, 23, 12),
      variant,
      signal: context?.signal,
    });
  },
};