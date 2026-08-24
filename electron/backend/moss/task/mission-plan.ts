import type { TaskBudget, TaskMissionPlan, TaskSpec, ToolRisk } from "../../../../common/types";

export interface MissionCapability {
  id: string;
  risk: ToolRisk;
}

const BUDGET_FIELDS = ["maxDurationMs", "maxTokens", "maxActions", "maxCostUsd"] as const;
const STEP_KINDS = new Set(["research", "implement", "verify", "review", "decision"]);
const WORKER_ROLES = new Set(["researcher", "implementer", "verifier", "reviewer"]);
const EXECUTION_LANES = new Set(["readonly-parallel", "exclusive"]);
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateMissionPlan(
  spec: TaskSpec,
  candidate: unknown,
  capabilities: readonly MissionCapability[],
): asserts candidate is TaskMissionPlan {
  assertMissionPlanShape(candidate);
  const plan = candidate;
  if (plan.schemaVersion !== 1) throw new Error(`Unsupported mission plan schema version '${plan.schemaVersion}'`);
  if (!Number.isInteger(plan.revision) || plan.revision < 1) {
    throw new Error("Mission plan revision must be a positive integer");
  }
  if (plan.supersedesRevision !== undefined && plan.supersedesRevision >= plan.revision) {
    throw new Error("A mission plan can only supersede an earlier revision");
  }
  if (plan.steps.length === 0) throw new Error("A mission plan requires at least one step");

  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const criterionIds = new Set(spec.acceptanceCriteria.map((criterion) => criterion.id));
  const stepIds = new Set<string>();
  const coveredCriteria = new Set<string>();

  for (const step of plan.steps) {
    if (!SAFE_ID_PATTERN.test(step.id) || stepIds.has(step.id)) {
      throw new Error(`Duplicate or empty mission step id '${step.id}'`);
    }
    stepIds.add(step.id);
    if (!step.mission) throw new Error(`Mission step '${step.id}' is missing its execution contract`);
    if (!STEP_KINDS.has(step.mission.kind)) throw new Error(`Mission step '${step.id}' has unknown kind '${step.mission.kind}'`);
    if (!WORKER_ROLES.has(step.mission.workerRole)) {
      throw new Error(`Mission step '${step.id}' has unknown worker role '${step.mission.workerRole}'`);
    }
    if (!EXECUTION_LANES.has(step.mission.executionLane)) {
      throw new Error(`Mission step '${step.id}' has unknown execution lane '${step.mission.executionLane}'`);
    }
    if (step.state !== "pending") throw new Error(`New mission step '${step.id}' must be pending`);

    assertUniqueNonEmpty(step.dependsOn, `Mission step '${step.id}' dependencies`);
    assertUniqueNonEmpty(step.requiredCapabilities, `Mission step '${step.id}' capabilities`);
    assertUniqueNonEmpty(step.mission.acceptanceCriterionIds, `Mission step '${step.id}' acceptance criteria`);
    assertUniqueNonEmpty(step.mission.expectedArtifacts, `Mission step '${step.id}' expected artifacts`);
    if (step.mission.acceptanceCriterionIds.length === 0 && step.mission.expectedArtifacts.length === 0) {
      throw new Error(`Mission step '${step.id}' must produce an artifact or acceptance evidence`);
    }

    for (const criterionId of step.mission.acceptanceCriterionIds) {
      if (!criterionIds.has(criterionId)) {
        throw new Error(`Mission step '${step.id}' references unknown acceptance criterion '${criterionId}'`);
      }
      coveredCriteria.add(criterionId);
    }

    for (const capabilityId of step.requiredCapabilities) {
      const capability = capabilityById.get(capabilityId);
      if (!capability) throw new Error(`Mission step '${step.id}' requires unknown capability '${capabilityId}'`);
      if (spec.executionGrant && !spec.executionGrant.allowedCapabilities.includes(capabilityId)) {
        throw new Error(`Mission step '${step.id}' requires capability '${capabilityId}' outside the execution grant`);
      }
      if (step.mission.executionLane === "readonly-parallel" && capability.risk !== "readonly") {
        throw new Error(`Mission step '${step.id}' cannot use ${capability.risk} capability '${capabilityId}' in the readonly-parallel lane`);
      }
    }
    validateBudget(step.mission.budget, `Mission step '${step.id}' budget`);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) throw new Error(`Mission step '${step.id}' has unknown dependency '${dependency}'`);
      if (dependency === step.id) throw new Error(`Mission step '${step.id}' cannot depend on itself`);
    }
  }
  assertAcyclic(plan);

  const uncovered = spec.acceptanceCriteria
    .filter((criterion) => criterion.mandatory && !coveredCriteria.has(criterion.id))
    .map((criterion) => criterion.id);
  if (uncovered.length > 0) {
    throw new Error(`Mission plan does not cover mandatory acceptance criteria: ${uncovered.join(", ")}`);
  }

  validateBudget(spec.budget ?? {}, "Task budget");
  assertStepBudgetsFitTask(spec, plan);
}

function assertMissionPlanShape(candidate: unknown): asserts candidate is TaskMissionPlan {
  if (!isRecord(candidate)) throw new Error("Mission plan must be an object");
  if (!Array.isArray(candidate.steps)) throw new Error("Mission plan steps must be an array");
  for (const [index, step] of candidate.steps.entries()) {
    if (!isRecord(step)) throw new Error(`Mission plan step ${index} must be an object`);
    if (typeof step.id !== "string" || typeof step.description !== "string" || typeof step.state !== "string") {
      throw new Error(`Mission plan step ${index} has invalid identity fields`);
    }
    if (!isStringArray(step.dependsOn) || !isStringArray(step.requiredCapabilities)) {
      throw new Error(`Mission step '${step.id}' has invalid dependency or capability lists`);
    }
    if (!isRecord(step.mission)) throw new Error(`Mission step '${step.id}' is missing its execution contract`);
    if (typeof step.mission.kind !== "string"
      || typeof step.mission.workerRole !== "string"
      || typeof step.mission.executionLane !== "string"
      || !isStringArray(step.mission.acceptanceCriterionIds)
      || !isStringArray(step.mission.expectedArtifacts)
      || !isRecord(step.mission.budget)) {
      throw new Error(`Mission step '${step.id}' has an invalid execution contract`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertAcyclic(plan: TaskMissionPlan): void {
  const dependencies = new Map(plan.steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error(`Mission plan contains a dependency cycle at '${stepId}'`);
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const step of plan.steps) visit(step.id);
}

function assertStepBudgetsFitTask(spec: TaskSpec, plan: TaskMissionPlan): void {
  for (const field of BUDGET_FIELDS) {
    const taskLimit = spec.budget?.[field];
    if (taskLimit === undefined || taskLimit === 0) continue;
    const stepLimits = plan.steps.map((step) => step.mission?.budget[field]);
    if (stepLimits.some((limit) => limit === undefined || limit === 0)) {
      throw new Error(`Every mission step must bound ${field} when the task bounds it`);
    }
    const total = stepLimits.reduce<number>((sum, limit) => sum + (limit ?? 0), 0);
    if (total > taskLimit) {
      throw new Error(`Mission step ${field} total ${total} exceeds task limit ${taskLimit}`);
    }
  }
}

function validateBudget(budget: TaskBudget, label: string): void {
  for (const field of BUDGET_FIELDS) {
    const value = budget[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${label} ${field} must be a non-negative finite number`);
    }
  }
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} must not contain empty values`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
}