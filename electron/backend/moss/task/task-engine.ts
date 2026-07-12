// electron/backend/moss/task/task-engine.ts
//
// Durable task lifecycle and invariants. Provider/tool execution remains in the
// agent runner; this service decides whether work may continue or complete.

import { randomUUID } from "node:crypto";

import type {
  TaskAttempt,
  TaskBlocker,
  TaskEvidence,
  TaskSnapshot,
  TaskSpec,
  TaskState,
  TaskStep,
  TokenUsage,
} from "../../../../common/types";
import { TaskStore, taskStore } from "./task-store";

const ACTIVE_STATES = new Set<TaskState>([
  "planning",
  "executing",
  "verifying",
  "reflecting",
  "waiting_for_approval",
]);

export interface AttemptUsage {
  usage?: TokenUsage;
  estimatedCostUsd?: number;
  actions?: number;
}

export interface TaskEngineOptions {
  now?: () => Date;
}

export class TaskEngine {
  private readonly now: () => Date;

  constructor(
    private readonly store: TaskStore,
    options: TaskEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(spec: TaskSpec, id?: string): Promise<TaskSnapshot> {
    if (!spec.objective.trim()) throw new Error("A task objective is required");
    if (!spec.acceptanceCriteria.some((criterion) => criterion.mandatory)) {
      throw new Error("At least one mandatory acceptance criterion is required");
    }
    return this.store.create(spec, id);
  }

  async setPlan(id: string, steps: TaskStep[]): Promise<TaskSnapshot> {
    validatePlan(steps);
    const current = await this.requireTask(id);
    if (current.state === "intake") await this.store.transition(id, "planning");
    else if (current.state !== "planning") throw new Error(`Cannot set a plan while task is ${current.state}`);
    return this.store.update(id, (task) => ({ ...task, steps: structuredClone(steps) }));
  }

  async start(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state === "paused" || task.state === "blocked" || task.state === "waiting_for_approval") {
      return this.store.transition(id, task.steps.length > 0 ? "executing" : "planning", { clearBlocker: true });
    }
    if (task.state === "planning") {
      if (task.steps.length === 0) throw new Error("A task cannot execute without a plan");
      return this.store.transition(id, "executing", { clearBlocker: true });
    }
    if (task.state === "executing") return task;
    throw new Error(`Cannot start a task while it is ${task.state}`);
  }

  async beginAttempt(id: string, stepId?: string): Promise<{ task: TaskSnapshot; attempt: TaskAttempt }> {
    let task = await this.start(id);
    const budgetBlocker = budgetExceeded(task, this.now());
    if (budgetBlocker) {
      task = await this.store.transition(id, "paused", { blocker: budgetBlocker });
      throw new Error(budgetBlocker.summary);
    }
    if (stepId && !task.steps.some((step) => step.id === stepId)) {
      throw new Error(`Unknown task step '${stepId}'`);
    }
    const attempt: TaskAttempt = {
      id: randomUUID(),
      ...(stepId ? { stepId } : {}),
      startedAt: this.now().toISOString(),
      actionCount: 0,
      usage: {},
      estimatedCostUsd: 0,
    };
    task = await this.store.update(id, (current) => ({
      ...current,
      attempts: [...current.attempts, attempt],
      steps: stepId
        ? current.steps.map((step) =>
            step.id === stepId ? { ...step, state: "running", startedAt: attempt.startedAt } : step,
          )
        : current.steps,
    }));
    return { task, attempt: structuredClone(attempt) };
  }

  async recordUsage(id: string, attemptId: string, delta: AttemptUsage): Promise<TaskSnapshot> {
    let task = await this.store.update(id, (current) => {
      if (!current.attempts.some((attempt) => attempt.id === attemptId)) {
        throw new Error(`Unknown task attempt '${attemptId}'`);
      }
      return {
        ...current,
        attempts: current.attempts.map((attempt) => attempt.id !== attemptId ? attempt : {
          ...attempt,
          actionCount: attempt.actionCount + (delta.actions ?? 0),
          usage: {
            inputTokens: (attempt.usage.inputTokens ?? 0) + (delta.usage?.inputTokens ?? 0),
            outputTokens: (attempt.usage.outputTokens ?? 0) + (delta.usage?.outputTokens ?? 0),
          },
          estimatedCostUsd: attempt.estimatedCostUsd + (delta.estimatedCostUsd ?? 0),
        }),
      };
    });
    const blocker = budgetExceeded(task, this.now());
    if (blocker && task.state === "executing") {
      task = await this.store.transition(id, "paused", { blocker });
    }
    return task;
  }

  async finishAttempt(
    id: string,
    attemptId: string,
    outcome: "succeeded" | "failed" | "interrupted",
    error?: string,
  ): Promise<TaskSnapshot> {
    const completedAt = this.now().toISOString();
    return this.store.update(id, (current) => {
      const attempt = current.attempts.find((candidate) => candidate.id === attemptId);
      if (!attempt) throw new Error(`Unknown task attempt '${attemptId}'`);
      return {
        ...current,
        attempts: current.attempts.map((candidate) => candidate.id !== attemptId
          ? candidate
          : { ...candidate, outcome, completedAt, ...(error ? { error } : {}) }),
        steps: current.steps.map((step) => {
        if (!attempt?.stepId || step.id !== attempt.stepId) return step;
        return {
          ...step,
          state: outcome === "succeeded" ? "completed" : "failed",
          completedAt,
          ...(error ? { error } : {}),
        };
        }),
      };
    });
  }

  async beginVerification(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (task.state !== "executing") throw new Error(`Cannot verify a task while it is ${task.state}`);
    return this.store.transition(id, "verifying");
  }

  async recordEvidence(id: string, evidence: TaskEvidence): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (!task.spec.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)) {
      throw new Error(`Unknown acceptance criterion '${evidence.criterionId}'`);
    }
    return this.store.update(id, (current) => ({
      ...current,
      evidence: [...current.evidence.filter((item) => item.id !== evidence.id), structuredClone(evidence)],
    }));
  }

  async complete(id: string): Promise<TaskSnapshot> {
    let task = await this.requireTask(id);
    if (task.state !== "verifying" && task.state !== "reflecting") {
      throw new Error(`Cannot complete a task while it is ${task.state}`);
    }
    const missing = missingPassingCriteria(task);
    if (missing.length > 0) {
      throw new Error(`Task cannot complete without passing evidence for: ${missing.join(", ")}`);
    }
    if (task.state === "verifying") task = await this.store.transition(id, "reflecting");
    return this.store.transition(id, "completed");
  }

  async pause(id: string, summary: string): Promise<TaskSnapshot> {
    const blocker: TaskBlocker = {
      kind: "external",
      summary,
      resumable: true,
      createdAt: this.now().toISOString(),
    };
    return this.store.transition(id, "paused", { blocker });
  }

  async block(id: string, blocker: TaskBlocker): Promise<TaskSnapshot> {
    return this.store.transition(id, "blocked", { blocker });
  }

  async cancel(id: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(id);
    if (["completed", "failed", "cancelled"].includes(task.state)) return task;
    return this.store.transition(id, "cancelled");
  }

  /** Convert work that was active during shutdown into an explicit resumable
   *  pause. No side effect is replayed until a caller deliberately resumes it. */
  async recoverInterruptedTasks(): Promise<TaskSnapshot[]> {
    const tasks = await this.store.list();
    const recovered: TaskSnapshot[] = [];
    for (const task of tasks) {
      if (!ACTIVE_STATES.has(task.state)) continue;
      const blocker: TaskBlocker = {
        kind: "external",
        summary: "Execution was interrupted by application shutdown; inspect the last action before resuming.",
        resumable: true,
        createdAt: this.now().toISOString(),
      };
      recovered.push(await this.store.transition(task.id, "paused", { blocker }));
    }
    return recovered;
  }

  private async requireTask(id: string): Promise<TaskSnapshot> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`Task '${id}' does not exist`);
    return task;
  }
}

function validatePlan(steps: TaskStep[]): void {
  if (steps.length === 0) throw new Error("A task plan requires at least one step");
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim() || ids.has(step.id)) throw new Error(`Duplicate or empty task step id '${step.id}'`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task step '${step.id}' has unknown dependency '${dependency}'`);
      if (dependency === step.id) throw new Error(`Task step '${step.id}' cannot depend on itself`);
    }
  }
}

function budgetExceeded(task: TaskSnapshot, now: Date): TaskBlocker | null {
  const budget = task.spec.budget;
  if (!budget) return null;
  const actions = task.attempts.reduce((total, attempt) => total + attempt.actionCount, 0);
  const tokens = task.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  );
  const cost = task.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0);
  const duration = now.getTime() - new Date(task.createdAt).getTime();
  const reason =
    budget.maxActions && actions >= budget.maxActions
      ? `action budget of ${budget.maxActions} reached`
      : budget.maxTokens && tokens >= budget.maxTokens
        ? `token budget of ${budget.maxTokens} reached`
        : budget.maxCostUsd && cost >= budget.maxCostUsd
          ? `cost budget of $${budget.maxCostUsd} reached`
          : budget.maxDurationMs && duration >= budget.maxDurationMs
            ? `runtime budget of ${budget.maxDurationMs}ms reached`
            : null;
  return reason
    ? { kind: "budget", summary: `Task paused: ${reason}`, resumable: true, createdAt: now.toISOString() }
    : null;
}

function missingPassingCriteria(task: TaskSnapshot): string[] {
  return task.spec.acceptanceCriteria
    .filter((criterion) => criterion.mandatory)
    .filter((criterion) => {
      const evidence = task.evidence
        .filter((item) => item.criterionId === criterion.id)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
      return evidence.length === 0 || !evidence[0].passed;
    })
    .map((criterion) => criterion.description);
}

export const taskEngine = new TaskEngine(taskStore);