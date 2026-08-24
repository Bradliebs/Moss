import type { TaskBudget, TaskSpec } from "../../../../common/types";

const BUDGET_FIELDS = ["maxDurationMs", "maxTokens", "maxActions", "maxCostUsd"] as const;

export function validateExecutionGrant(spec: TaskSpec): void {
  const grant = spec.executionGrant;
  if (!grant) return;
  if (grant.schemaVersion !== 1) throw new Error(`Unsupported execution grant schema version '${grant.schemaVersion}'`);
  if (grant.authority !== "supervised" && grant.authority !== "policy-scoped") {
    throw new Error(`Unknown execution grant authority '${String(grant.authority)}'`);
  }
  if (grant.maxAutoApprovedRisk !== "readonly" && grant.maxAutoApprovedRisk !== "mutating") {
    throw new Error("Execution grants cannot auto-approve destructive actions");
  }
  const capabilities = new Set<string>();
  for (const capability of grant.allowedCapabilities) {
    const normalized = capability.trim();
    if (!normalized) throw new Error("Execution grant capabilities must be non-empty");
    if (capabilities.has(normalized)) throw new Error(`Duplicate execution grant capability '${normalized}'`);
    capabilities.add(normalized);
  }
  validateBudget(grant.budget, "Execution grant budget");
  assertBudgetWithinTask(spec.budget ?? {}, grant.budget);
  validateScope(grant.scopes.workspaceRoot, "workspaceRoot");
  for (const [name, values] of [
    ["browserDomains", grant.scopes.browserDomains],
    ["desktopProcesses", grant.scopes.desktopProcesses],
    ["desktopWindows", grant.scopes.desktopWindows],
  ] as const) {
    if (values?.some((value) => !value.trim())) throw new Error(`Execution grant ${name} entries must be non-empty`);
  }
}

function assertBudgetWithinTask(taskBudget: TaskBudget, grantBudget: TaskBudget): void {
  for (const field of BUDGET_FIELDS) {
    const taskLimit = taskBudget[field];
    const grantLimit = grantBudget[field];
    if (taskLimit !== undefined && taskLimit > 0 && (grantLimit === undefined || grantLimit === 0 || grantLimit > taskLimit)) {
      throw new Error(`Execution grant ${field} must be bounded by task limit ${taskLimit}`);
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

function validateScope(value: string | undefined, label: string): void {
  if (value !== undefined && !value.trim()) throw new Error(`Execution grant ${label} must be non-empty`);
}