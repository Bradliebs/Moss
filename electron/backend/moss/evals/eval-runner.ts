import type {
  EvalAdmission,
  EvalCase,
  EvalCriterionResult,
  EvalExecutionObservation,
  EvalMetrics,
  EvalProfile,
  EvalReport,
  EvalRunResult,
  HarnessExecutionTrace,
} from "../../../../common/evals";
import type { TaskBudget, TaskEvidence } from "../../../../common/types";
import type { VerificationCheck } from "../../../../common/verification";
import { VerificationRegistry } from "../verify/verification-registry";

const ADMISSIONS: EvalAdmission[] = [
  "attempted",
  "abstained",
  "blocked",
  "approved",
  "failed",
  "recovered",
  "verified",
  "budget-exhausted",
];

export interface EvalExecutionResult {
  observation: Omit<EvalExecutionObservation, "evidence"> & {
    /** Untrusted agent/executor claims retained only for diagnostics. */
    claimedEvidence?: TaskEvidence[];
  };
  workspaceRoot: string;
  trace?: HarnessExecutionTrace;
}

export type EvalExecutor = (testCase: EvalCase, repetition: number) => Promise<EvalExecutionResult>;

export interface EvalRunnerOptions {
  now?: () => Date;
  registry?: VerificationRegistry;
}

export interface EvalEvidenceOptions {
  registry?: VerificationRegistry;
}

/** Runs provider-neutral eval cases through an injected production or test executor. */
export class EvalRunner {
  private readonly now: () => Date;
  private readonly registry: VerificationRegistry;

  constructor(
    private readonly execute: EvalExecutor,
    options: EvalRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? new VerificationRegistry();
  }

  async run(cases: readonly EvalCase[]): Promise<EvalReport> {
    const results: EvalRunResult[] = [];
    const caseIds = new Set<string>();
    for (const testCase of cases) {
      validateCase(testCase);
      if (caseIds.has(testCase.id)) throw new Error(`Duplicate eval case id '${testCase.id}'`);
      caseIds.add(testCase.id);
      const repetitions = testCase.repetitions ?? 1;
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const execution = await this.execute(structuredClone(testCase), repetition);
        const evidence = await collectEvalEvidence(
          testCase,
          execution.workspaceRoot,
          new AbortController().signal,
          { registry: this.registry },
        );
        const { claimedEvidence: _claimedEvidence, ...facts } = execution.observation;
        const mandatoryIds = new Set(
          testCase.task.acceptanceCriteria.filter((criterion) => criterion.mandatory).map((criterion) => criterion.id),
        );
        const verified = evidence.filter((item) => mandatoryIds.has(item.criterionId)).every((item) => item.passed);
        const admissions: EvalAdmission[] = facts.admissions.filter((admission) => admission !== "verified");
        if (verified) admissions.push("verified");
        const observation: EvalExecutionObservation = { ...facts, admissions, evidence };
        results.push(scoreRun(testCase, observation));
      }
    }

    const byProfile: Partial<Record<EvalProfile, EvalMetrics>> = {};
    for (const profile of ["coding", "personal", "platform"] as const) {
      const profileResults = results.filter((result) => {
        const testCase = cases.find((candidate) => candidate.id === result.observation.caseId);
        return testCase?.profile === profile;
      });
      if (profileResults.length > 0) byProfile[profile] = aggregateMetrics(profileResults);
    }

    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      results,
      overall: aggregateMetrics(results),
      byProfile,
    };
  }
}

export function validateCase(testCase: EvalCase): void {
  if (testCase.schemaVersion !== 1) throw new Error(`Unsupported eval schema version '${testCase.schemaVersion}'`);
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(testCase.id)) throw new Error("Eval case id must be a safe identifier");
  if (!testCase.task.objective.trim()) throw new Error(`Eval case '${testCase.id}' requires a task objective`);
  if (!testCase.task.acceptanceCriteria.some((criterion) => criterion.mandatory)) {
    throw new Error(`Eval case '${testCase.id}' requires a mandatory acceptance criterion`);
  }
  const criterionIds = new Set<string>();
  for (const criterion of testCase.task.acceptanceCriteria) {
    if (!criterion.id.trim() || criterionIds.has(criterion.id)) {
      throw new Error(`Eval case '${testCase.id}' has a duplicate or empty criterion id`);
    }
    criterionIds.add(criterion.id);
  }
  const checkIds = new Set<string>();
  for (const check of testCase.checks) {
    if (!check.id.trim() || checkIds.has(check.id)) {
      throw new Error(`Eval case '${testCase.id}' has a duplicate or empty check id`);
    }
    if (!criterionIds.has(check.criterionId)) {
      throw new Error(`Eval case '${testCase.id}' check '${check.id}' references an unknown criterion`);
    }
    checkIds.add(check.id);
  }
  for (const criterion of testCase.task.acceptanceCriteria.filter((candidate) => candidate.mandatory)) {
    if (!testCase.checks.some((check) => check.criterionId === criterion.id)) {
      throw new Error(`Eval case '${testCase.id}' mandatory criterion '${criterion.id}' has no independent check`);
    }
  }
  if (testCase.repetitions !== undefined && (!Number.isInteger(testCase.repetitions) || testCase.repetitions < 1)) {
    throw new Error(`Eval case '${testCase.id}' repetitions must be a positive integer`);
  }
  validateBenchmarkControls(testCase);
}

function validateBenchmarkControls(testCase: EvalCase): void {
  const controls = testCase.benchmark;
  if (!controls) return;

  const expected = validateCapabilityList(testCase, "expectedCapabilities", controls.expectedCapabilities);
  const forbidden = validateCapabilityList(testCase, "forbiddenCapabilities", controls.forbiddenCapabilities);
  for (const capability of expected) {
    if (forbidden.has(capability)) {
      throw new Error(`Eval case '${testCase.id}' cannot both expect and forbid capability '${capability}'`);
    }
    if (!testCase.allowedCapabilities.includes(capability)) {
      throw new Error(`Eval case '${testCase.id}' expects capability '${capability}' but does not allow it`);
    }
  }

  const requiredApprovals = validateCapabilityList(
    testCase,
    "security.requireApprovalFor",
    controls.security?.requireApprovalFor,
  );
  for (const capability of requiredApprovals) {
    if (forbidden.has(capability)) {
      throw new Error(`Eval case '${testCase.id}' cannot require approval for forbidden capability '${capability}'`);
    }
    if (!testCase.allowedCapabilities.includes(capability)) {
      throw new Error(`Eval case '${testCase.id}' requires approval for capability '${capability}' but does not allow it`);
    }
  }

  validatePathList(testCase, controls.security?.protectedPaths);
  validateBudget(testCase, controls.budget);
}

function validateCapabilityList(testCase: EvalCase, label: string, values?: string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value) || result.has(value)) {
      throw new Error(`Eval case '${testCase.id}' ${label} must contain unique safe capability ids`);
    }
    result.add(value);
  }
  return result;
}

function validatePathList(testCase: EvalCase, values?: string[]): void {
  const paths = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`Eval case '${testCase.id}' protectedPaths must be relative workspace paths`);
    }
    if (paths.has(normalized)) throw new Error(`Eval case '${testCase.id}' protectedPaths must be unique`);
    paths.add(normalized);
  }
}

function validateBudget(testCase: EvalCase, budget?: TaskBudget): void {
  if (!budget) return;
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Eval case '${testCase.id}' budget '${name}' must be non-negative`);
    }
  }
}

export function scoreRun(testCase: EvalCase, observation: EvalExecutionObservation): EvalRunResult {
  if (observation.caseId !== testCase.id) {
    throw new Error(`Executor returned case '${observation.caseId}' for '${testCase.id}'`);
  }
  if (!Number.isFinite(observation.estimatedCostUsd) || observation.estimatedCostUsd < 0) {
    throw new Error(`Eval observation '${observation.runId}' has invalid cost`);
  }
  const startedAt = Date.parse(observation.startedAt);
  const completedAt = Date.parse(observation.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`Eval observation '${observation.runId}' has invalid timestamps`);
  }

  const criteria = testCase.task.acceptanceCriteria.map((criterion): EvalCriterionResult => {
    const evidence = latestEvidence(observation.evidence, criterion.id);
    return {
      criterionId: criterion.id,
      mandatory: criterion.mandatory,
      passed: evidence?.passed ?? false,
      summary: evidence?.summary ?? "No evidence captured",
    };
  });
  const passed = criteria.filter((criterion) => criterion.passed).length;
  const mandatoryPassed = criteria.filter((criterion) => criterion.mandatory).every((criterion) => criterion.passed);

  return {
    observation: structuredClone(observation),
    criteria,
    success: observation.outcome === "completed" && mandatoryPassed,
    score: criteria.length === 0 ? 0 : passed / criteria.length,
    durationMs: completedAt - startedAt,
  };
}

export function aggregateMetrics(results: readonly EvalRunResult[]): EvalMetrics {
  const admissions = Object.fromEntries(ADMISSIONS.map((admission) => [admission, 0])) as Record<EvalAdmission, number>;
  for (const result of results) {
    for (const admission of result.observation.admissions) admissions[admission]++;
  }
  const runs = results.length;
  const total = (select: (result: EvalRunResult) => number): number => results.reduce((sum, result) => sum + select(result), 0);
  return {
    runs,
    successes: results.filter((result) => result.success).length,
    successRate: runs === 0 ? 0 : results.filter((result) => result.success).length / runs,
    averageScore: runs === 0 ? 0 : total((result) => result.score) / runs,
    averageDurationMs: runs === 0 ? 0 : total((result) => result.durationMs) / runs,
    averageCostUsd: runs === 0 ? 0 : total((result) => result.observation.estimatedCostUsd) / runs,
    averageTokens: runs === 0 ? 0 : total((result) =>
      (result.observation.usage.inputTokens ?? 0) + (result.observation.usage.outputTokens ?? 0)) / runs,
    admissions,
  };
}

function latestEvidence(evidence: readonly TaskEvidence[], criterionId: string): TaskEvidence | undefined {
  return evidence
    .filter((item) => item.criterionId === criterionId)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
}

/** Run a case's independent checks and fold multiple checks into one evidence item per criterion. */
export async function collectEvalEvidence(
  testCase: EvalCase,
  workspaceRoot: string,
  signal: AbortSignal,
  options: EvalEvidenceOptions = {},
): Promise<TaskEvidence[]> {
  validateCase(testCase);
  const registry = options.registry ?? new VerificationRegistry();
  const checkEvidence = await registry.runChecks(structuredClone(testCase.checks), workspaceRoot, signal);
  const capturedAt = new Date().toISOString();
  return testCase.task.acceptanceCriteria.map((criterion): TaskEvidence => {
    const items = checkEvidence.filter((item) => item.criterionId === criterion.id);
    const passed = items.length > 0 && items.every((item) => item.ok);
    return {
      id: `eval-${safeEvidenceId(testCase.id)}-${safeEvidenceId(criterion.id)}`,
      criterionId: criterion.id,
      kind: evidenceKind(testCase.checks.filter((check) => check.criterionId === criterion.id)),
      passed,
      summary: items.length === 0
        ? "No independent checks ran"
        : items.map((item) => item.summary).join("; "),
      capturedAt,
    };
  });
}

function evidenceKind(checks: readonly VerificationCheck[]): TaskEvidence["kind"] {
  if (checks.every((check) => check.kind === "command")) return "command";
  if (checks.every((check) => check.kind === "file-exists" || check.kind === "file-contains")) return "file";
  if (checks.every((check) => check.kind === "process-running")) return "process";
  if (checks.every((check) => check.kind === "http")) return "http";
  return "external";
}

function safeEvidenceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "evidence";
}