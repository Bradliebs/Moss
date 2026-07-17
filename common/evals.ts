import type {
  InjectionMode,
  ProviderKind,
  TaskBudget,
  TaskEvidence,
  TaskSpec,
  TokenUsage,
  ToolRisk,
  VerifyConfig,
} from "./types";
import type { VerificationCheck } from "./verification";

export type EvalProfile = "coding" | "personal" | "platform";
export type EvalDifficulty = "smoke" | "standard" | "hard";
export type EvalAdmission = "attempted" | "abstained" | "blocked" | "approved" | "failed" | "recovered" | "verified" | "budget-exhausted";

export interface EvalFixture {
  /** Optional directory copied into an isolated workspace before execution. */
  workspaceTemplate?: string;
  /** Profile-specific state supplied to the executor, such as a browser fixture. */
  state?: Record<string, unknown>;
}

/** Provider-neutral execution settings varied independently from the model. */
export interface HarnessVariant {
  schemaVersion: 1;
  id: string;
  description: string;
  autoApprove?: boolean;
  injectionMode?: InjectionMode;
  contextLimit?: number;
  maxRounds?: number;
  toolTimeoutMs?: number;
  verify?: VerifyConfig;
  budget?: TaskBudget;
}

/** Model identity is separate so every target can run under every variant. */
export interface EvalModelTarget {
  schemaVersion: 1;
  id: string;
  providerId: string;
  providerKind: ProviderKind;
  model: string;
}

export interface EvalSecurityPolicy {
  maxToolRisk?: ToolRisk;
  requireApprovalFor?: string[];
  protectedPaths?: string[];
}

/** Optional deterministic expectations used by harness-regression scoring. */
export interface EvalBenchmarkControls {
  expectedCapabilities?: string[];
  forbiddenCapabilities?: string[];
  security?: EvalSecurityPolicy;
  budget?: TaskBudget;
}

export type HarnessTraceTerminalState = "completed" | "aborted" | "error" | "budget-exhausted";

export interface HarnessTraceToolCall {
  callId: string;
  name: string;
  argumentHash?: string;
  risk?: ToolRisk;
  approvalRequested: boolean;
  autoApproved?: boolean;
  ok?: boolean;
  durationMs?: number;
  recoveredFromCallId?: string;
}

/** Sanitized execution metadata. Raw arguments, output, and model text are excluded. */
export interface HarnessExecutionTrace {
  toolCalls: HarnessTraceToolCall[];
  usage: TokenUsage;
  terminalState?: HarnessTraceTerminalState;
}

export interface HarnessProcessScores {
  robustness: number;
  toolUse: number;
  consistency: number;
}

export interface HarnessRunScore {
  completion: number;
  mandatoryCompletion: boolean;
  securityPassed: boolean;
  securityViolations: string[];
  process: HarnessProcessScores;
  /** Paper-inspired diagnostic only; not a deployment-safety guarantee. */
  diagnosticComposite: number;
}

/** Versioned, provider-neutral description of one evaluation task. */
export interface EvalCase {
  schemaVersion: 1;
  id: string;
  profile: EvalProfile;
  difficulty: EvalDifficulty;
  task: TaskSpec;
  fixture?: EvalFixture;
  allowedCapabilities: string[];
  /** Independent end-state checks; these run after the agent stops. */
  checks: VerificationCheck[];
  repetitions?: number;
  tags?: string[];
  benchmark?: EvalBenchmarkControls;
}

export interface EvalExecutionObservation {
  caseId: string;
  runId: string;
  provider: string;
  model: string;
  outcome: "completed" | "failed" | "blocked" | "cancelled" | "budget-exhausted";
  failureReason?: string;
  startedAt: string;
  completedAt: string;
  evidence: TaskEvidence[];
  usage: TokenUsage;
  estimatedCostUsd: number;
  admissions: EvalAdmission[];
}

export interface EvalCriterionResult {
  criterionId: string;
  mandatory: boolean;
  passed: boolean;
  summary: string;
}

export interface EvalRunResult {
  observation: EvalExecutionObservation;
  criteria: EvalCriterionResult[];
  success: boolean;
  score: number;
  durationMs: number;
}

export interface HarnessMatrixCellResult {
  caseId: string;
  targetId: string;
  variantId: string;
  repetition: number;
  result: EvalRunResult;
  trace?: HarnessExecutionTrace;
  harnessScore?: HarnessRunScore;
  protectedInputHashesBefore: Record<string, string>;
  protectedInputHashesAfter: Record<string, string>;
  protectedInputsIntact: boolean;
}

export interface HarnessMatrixManifest {
  evaluatorVersion: string;
  caseIds: string[];
  targetIds: string[];
  variantIds: string[];
  caseSetHash: string;
  targetSetHash: string;
  variantSetHash: string;
}

export interface HarnessAggregateMetrics {
  runs: number;
  scoredRuns: number;
  completions: number;
  completionRate: number;
  securityPasses: number;
  securityPassRate: number;
  protectedInputsIntact: number;
  averageRobustness: number;
  averageToolUse: number;
  averageConsistency: number;
  averageDiagnosticComposite: number;
  averageTokens: number;
  averageCostUsd: number;
  averageDurationMs: number;
  averageActions: number;
}

export interface HarnessMatrixSummary {
  overall: HarnessAggregateMetrics;
  byTargetVariant: Record<string, HarnessAggregateMetrics>;
  byProfile: Partial<Record<EvalProfile, HarnessAggregateMetrics>>;
  byDifficulty: Partial<Record<EvalDifficulty, HarnessAggregateMetrics>>;
  byTag: Record<string, HarnessAggregateMetrics>;
}

export interface HarnessMatrixReport {
  schemaVersion: 1;
  generatedAt: string;
  manifest: HarnessMatrixManifest;
  cells: HarnessMatrixCellResult[];
  summary: HarnessMatrixSummary;
}

export interface HarnessCellDiff {
  caseId: string;
  targetId: string;
  variantId: string;
  repetition: number;
  completionChanged: boolean;
  securityChanged: boolean;
  robustnessDelta: number;
  toolUseDelta: number;
  consistencyDelta: number;
  tokensDelta: number;
  costDeltaUsd: number;
  durationDeltaMs: number;
  actionsDelta: number;
}

export interface HarnessReportDiff {
  schemaVersion: 1;
  baselineGeneratedAt: string;
  candidateGeneratedAt: string;
  passed: boolean;
  cells: HarnessCellDiff[];
  regressions: string[];
}

export interface EvalMetrics {
  runs: number;
  successes: number;
  successRate: number;
  averageScore: number;
  averageDurationMs: number;
  averageCostUsd: number;
  averageTokens: number;
  admissions: Record<EvalAdmission, number>;
}

export interface EvalReport {
  schemaVersion: 1;
  generatedAt: string;
  results: EvalRunResult[];
  overall: EvalMetrics;
  byProfile: Partial<Record<EvalProfile, EvalMetrics>>;
}