// electron/backend/moss/task/task-engine.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskEvidence, TaskSpec, TaskStep } from "../../../../common/types";
import { TaskEngine } from "./task-engine";
import { TaskStore } from "./task-store";

const SPEC: TaskSpec = {
  objective: "Implement and verify the change",
  acceptanceCriteria: [{ id: "tests", description: "Tests pass", mandatory: true }],
  constraints: [],
  assumptions: [],
};

const PLAN: TaskStep[] = [
  {
    id: "implement",
    description: "Implement the change",
    state: "pending",
    dependsOn: [],
    requiredCapabilities: ["workspace-edit"],
  },
];

describe("TaskEngine", () => {
  let dir: string;
  let store: TaskStore;
  let engine: TaskEngine;
  let now: Date;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-engine-"));
    store = new TaskStore(dir);
    now = new Date("2026-07-12T10:00:00.000Z");
    engine = new TaskEngine(store, { now: () => now });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires an objective and a mandatory completion criterion", async () => {
    await expect(engine.create({ ...SPEC, objective: " " }, "bad-1")).rejects.toThrow("objective");
    await expect(
      engine.create({ ...SPEC, acceptanceCriteria: [{ id: "optional", description: "Nice", mandatory: false }] }, "bad-2"),
    ).rejects.toThrow("mandatory acceptance criterion");
  });

  it("plans, executes, records an attempt, and completes only after verification", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1", "implement");
    await engine.recordUsage("task-1", attempt.id, { actions: 2, usage: { inputTokens: 5, outputTokens: 3 } });
    await engine.finishAttempt("task-1", attempt.id, "succeeded");
    await engine.beginVerification("task-1");

    await expect(engine.complete("task-1")).rejects.toThrow("Tests pass");
    const evidence: TaskEvidence = {
      id: "evidence-1",
      criterionId: "tests",
      kind: "command",
      passed: true,
      summary: "npm test passed",
      capturedAt: now.toISOString(),
      attemptId: attempt.id,
    };
    await engine.recordEvidence("task-1", evidence);
    const completed = await engine.complete("task-1");

    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.attempts[0]).toMatchObject({ outcome: "succeeded", actionCount: 2 });
    expect(completed.steps[0].state).toBe("completed");
  });

  it("uses only the newest evidence for each mandatory criterion", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.beginVerification("task-1");
    await engine.recordEvidence("task-1", {
      id: "pass",
      criterionId: "tests",
      kind: "command",
      passed: true,
      summary: "passed",
      capturedAt: "2026-07-12T10:00:00.000Z",
    });
    await engine.recordEvidence("task-1", {
      id: "fail",
      criterionId: "tests",
      kind: "command",
      passed: false,
      summary: "regressed",
      capturedAt: "2026-07-12T10:01:00.000Z",
    });

    await expect(engine.complete("task-1")).rejects.toThrow("Tests pass");
  });

  it("pauses when an action budget is reached", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 1 } }, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1");
    const paused = await engine.recordUsage("task-1", attempt.id, { actions: 1 });

    expect(paused.state).toBe("paused");
    expect(paused.blocker).toMatchObject({ kind: "budget", resumable: true });
  });

  it("rejects unknown attempt updates without changing the task revision", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const before = await store.get("task-1");

    await expect(engine.recordUsage("task-1", "missing", { actions: 1 })).rejects.toThrow("Unknown task attempt");
    await expect(engine.finishAttempt("task-1", "missing", "failed")).rejects.toThrow("Unknown task attempt");

    expect((await store.get("task-1"))?.revision).toBe(before?.revision);
  });

  it("rejects plans with missing dependencies", async () => {
    await engine.create(SPEC, "task-1");
    await expect(
      engine.setPlan("task-1", [{ ...PLAN[0], dependsOn: ["missing"] }]),
    ).rejects.toThrow("unknown dependency");
  });

  it("rejects an attempt whose step dependencies are incomplete", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", [
      ...PLAN,
      {
        id: "verify",
        description: "Verify the change",
        state: "pending",
        dependsOn: ["implement"],
        requiredCapabilities: [],
      },
    ]);

    await expect(engine.beginAttempt("task-1", "verify")).rejects.toThrow("incomplete dependencies");
  });

  it("rejects restarting a completed step", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1", "implement");
    await engine.finishAttempt("task-1", attempt.id, "succeeded");

    await expect(engine.beginAttempt("task-1", "implement")).rejects.toThrow("not eligible");
  });

  it("recovers active tasks as paused without replaying work", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");

    const recovered = await engine.recoverInterruptedTasks();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe("paused");
    expect(recovered[0].blocker?.summary).toContain("interrupted");
  });

  it("persists approval waiting and only resumes after the matching decision", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");

    const waiting = await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "write_file",
      arguments: '{"path":"result.txt"}',
      risk: "mutating",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    expect(waiting.state).toBe("waiting_for_approval");
    expect((await new TaskStore(dir).get("task-1"))?.approval).toEqual(waiting.approval);
    await expect(engine.start("task-1")).rejects.toThrow("pending approval");
    await expect(engine.resolveApproval("task-1", "other-call", true)).rejects.toThrow("does not match");

    now = new Date("2026-07-12T10:01:00.000Z");
    const resolved = await engine.resolveApproval("task-1", "call-1", true, "Reviewed");
    expect(resolved).toMatchObject({
      state: "executing",
      approval: {
        callId: "call-1",
        status: "approved",
        comment: "Reviewed",
        respondedAt: now.toISOString(),
      },
    });
  });

  it("interrupts a pending approval on restart without replaying it", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "run_command",
      arguments: '{"command":"npm test"}',
      risk: "mutating",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    now = new Date("2026-07-12T10:02:00.000Z");
    const [recovered] = await engine.recoverInterruptedTasks();

    expect(recovered).toMatchObject({
      state: "paused",
      approval: {
        callId: "call-1",
        status: "interrupted",
        respondedAt: now.toISOString(),
      },
      blocker: { kind: "approval", resumable: true },
    });
    expect(recovered.blocker?.summary).toContain("not executed");
  });

  it("interrupts a matching pending approval when its renderer disappears", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "write_file",
      arguments: "{}",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    await expect(engine.interruptApproval("task-1", "other-call", "Renderer closed")).rejects.toThrow("does not match");
    now = new Date("2026-07-12T10:03:00.000Z");
    const interrupted = await engine.interruptApproval("task-1", "call-1", "Renderer closed");

    expect(interrupted).toMatchObject({
      state: "paused",
      approval: {
        callId: "call-1",
        status: "interrupted",
        comment: "Renderer closed",
        respondedAt: now.toISOString(),
      },
      blocker: { kind: "approval", resumable: true },
    });
  });

  it("cancels non-terminal tasks idempotently", async () => {
    await engine.create(SPEC, "task-1");
    const cancelled = await engine.cancel("task-1");
    expect(cancelled.state).toBe("cancelled");
    expect(await engine.cancel("task-1")).toEqual(cancelled);
  });
});