import type { TaskEvidence, TaskSnapshot, TaskStep } from "../../../../common/types";

const MAX_ITEMS = 8;
const MAX_TEXT = 240;

export interface TaskProgressPacket {
  schemaVersion: 1;
  taskId: string;
  objective: string;
  acceptanceCriteria: Array<{ id: string; description: string; verified: boolean }>;
  currentStep?: { id: string; description: string };
  verifiedFeatures: string[];
  unresolvedFailures: string[];
  recentChangedFiles: string[];
  lastKnownGoodCheckpoint?: string;
  baseline?: { passed: boolean; checks: number };
  nextAction: string;
}

export interface ProgressPacketOptions {
  changedFiles?: readonly string[];
  baseline?: { passed: boolean; checks: number };
}

export function selectDependencyReadyStep(task: TaskSnapshot): TaskStep | undefined {
  const completed = new Set(task.steps.filter((step) => step.state === "completed" || step.state === "skipped").map((step) => step.id));
  const running = task.steps.find((step) => step.state === "running");
  if (running) return structuredClone(running);
  const ready = task.steps.find((step) =>
    (step.state === "pending" || step.state === "failed")
    && step.dependsOn.every((dependency) => completed.has(dependency)),
  );
  return ready ? structuredClone(ready) : undefined;
}

export function selectDependencyReadySteps(task: TaskSnapshot, maxReadonlyConcurrency = 2): TaskStep[] {
  const running = task.steps.filter((step) => step.state === "running");
  if (running.length > 0) return running.map((step) => structuredClone(step));
  const completed = new Set(task.steps
    .filter((step) => step.state === "completed" || step.state === "skipped")
    .map((step) => step.id));
  const ready = task.steps.filter((step) =>
    (step.state === "pending" || step.state === "failed")
    && step.dependsOn.every((dependency) => completed.has(dependency)),
  );
  const first = ready[0];
  if (!first) return [];
  if (first.mission?.executionLane !== "readonly-parallel") return [structuredClone(first)];
  const limit = Math.max(1, Math.min(4, Math.floor(maxReadonlyConcurrency)));
  return ready
    .filter((step) => step.mission?.executionLane === "readonly-parallel")
    .slice(0, limit)
    .map((step) => structuredClone(step));
}

export function buildTaskProgressPacket(task: TaskSnapshot, options: ProgressPacketOptions = {}): TaskProgressPacket {
  const currentStep = selectDependencyReadyStep(task);
  const latestEvidence = latestEvidenceByCriterion(task.evidence);
  const verifiedFeatures = [...latestEvidence.values()]
    .filter((evidence) => evidence.passed)
    .map((evidence) => bounded(evidence.summary))
    .slice(0, MAX_ITEMS);
  const unresolvedFailures = [
    ...[...latestEvidence.values()].filter((evidence) => !evidence.passed).map((evidence) => bounded(evidence.summary)),
    ...task.steps.filter((step) => step.state === "failed").map((step) => bounded(step.error ?? step.description)),
    ...(task.blocker ? [bounded(task.blocker.summary)] : []),
  ].slice(0, MAX_ITEMS);
  const lastKnownGoodCheckpoint = [...task.attempts].reverse().find((attempt) =>
    attempt.outcome === "succeeded" && attempt.turnId,
  )?.turnId;
  return {
    schemaVersion: 1,
    taskId: task.id,
    objective: bounded(task.spec.objective),
    acceptanceCriteria: task.spec.acceptanceCriteria.slice(0, MAX_ITEMS).map((criterion) => ({
      id: criterion.id,
      description: bounded(criterion.description),
      verified: latestEvidence.get(criterion.id)?.passed === true,
    })),
    ...(currentStep ? { currentStep: { id: currentStep.id, description: bounded(currentStep.description) } } : {}),
    verifiedFeatures,
    unresolvedFailures,
    recentChangedFiles: [...new Set(options.changedFiles ?? [])].sort().slice(0, MAX_ITEMS).map(bounded),
    ...(lastKnownGoodCheckpoint ? { lastKnownGoodCheckpoint } : {}),
    ...(options.baseline ? { baseline: options.baseline } : {}),
    nextAction: currentStep
      ? `Complete and verify step '${currentStep.id}' before advancing.`
      : "Resolve blockers or verify all acceptance criteria before completion.",
  };
}

export function renderTaskProgressPacket(packet: TaskProgressPacket): string {
  const criteria = packet.acceptanceCriteria.map((criterion) =>
    `- [${criterion.verified ? "x" : " "}] ${criterion.id}: ${criterion.description}`,
  );
  return [
    "Trusted durable progress packet (runtime-owned):",
    `Task: ${packet.taskId}`,
    `Objective: ${packet.objective}`,
    "Acceptance criteria:",
    ...criteria,
    `Current step: ${packet.currentStep ? `${packet.currentStep.id}: ${packet.currentStep.description}` : "none ready"}`,
    `Verified features: ${packet.verifiedFeatures.join("; ") || "none"}`,
    `Unresolved failures: ${packet.unresolvedFailures.join("; ") || "none"}`,
    `Recent changed files: ${packet.recentChangedFiles.join(", ") || "none"}`,
    `Last known-good checkpoint: ${packet.lastKnownGoodCheckpoint ?? "none"}`,
    `Baseline: ${packet.baseline ? `${packet.baseline.passed ? "pass" : "fail"} (${packet.baseline.checks} checks)` : "not run"}`,
    `Next action: ${packet.nextAction}`,
  ].join("\n");
}

function latestEvidenceByCriterion(evidence: readonly TaskEvidence[]): Map<string, TaskEvidence> {
  const latest = new Map<string, TaskEvidence>();
  for (const item of [...evidence].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))) {
    latest.set(item.criterionId, item);
  }
  return latest;
}

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
