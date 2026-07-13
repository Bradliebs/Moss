import type { TaskEvidence, TaskSpec, TokenUsage } from "./types";
import type { VerificationCheck } from "./verification";

export type EvalProfile = "coding" | "personal" | "platform";
export type EvalDifficulty = "smoke" | "standard" | "hard";
export type EvalAdmission = "attempted" | "abstained" | "blocked" | "approved" | "failed" | "recovered" | "verified";

export interface EvalFixture {
  /** Optional directory copied into an isolated workspace before execution. */
  workspaceTemplate?: string;
  /** Profile-specific state supplied to the executor, such as a browser fixture. */
  state?: Record<string, unknown>;
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
}

export interface EvalExecutionObservation {
  caseId: string;
  runId: string;
  provider: string;
  model: string;
  outcome: "completed" | "failed" | "blocked" | "cancelled";
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