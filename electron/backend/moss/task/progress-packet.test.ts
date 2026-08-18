import { describe, expect, it } from "vitest";

import type { TaskSnapshot } from "../../../../common/types";
import { buildTaskProgressPacket, renderTaskProgressPacket, selectDependencyReadyStep } from "./progress-packet";

function task(): TaskSnapshot {
  return {
    id: "task-1",
    revision: 1,
    state: "executing",
    spec: {
      objective: "Complete the durable task",
      acceptanceCriteria: [{ id: "tests", description: "Tests pass", mandatory: true }],
      constraints: [],
      assumptions: [],
    },
    steps: [
      { id: "inspect", description: "Inspect state", state: "completed", dependsOn: [], requiredCapabilities: [] },
      { id: "edit", description: "Make the change", state: "pending", dependsOn: ["inspect"], requiredCapabilities: [] },
      { id: "verify", description: "Verify the change", state: "pending", dependsOn: ["edit"], requiredCapabilities: [] },
    ],
    evidence: [
      { id: "old", criterionId: "tests", kind: "command", passed: false, summary: "old failure", capturedAt: "2026-01-01T00:00:00.000Z" },
      { id: "new", criterionId: "tests", kind: "command", passed: true, summary: "focused tests passed", capturedAt: "2026-01-01T01:00:00.000Z" },
    ],
    attempts: [{ id: "attempt-1", stepId: "inspect", turnId: "turn-1", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:10:00.000Z", outcome: "succeeded", actionCount: 1, usage: {}, estimatedCostUsd: 0 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
  };
}

describe("task progress packet", () => {
  it("selects only the first dependency-ready step", () => {
    expect(selectDependencyReadyStep(task())?.id).toBe("edit");
  });

  it("renders bounded runtime-owned progress from durable evidence", () => {
    const packet = buildTaskProgressPacket(task(), {
      changedFiles: ["src/z.ts", "src/a.ts", "src/a.ts"],
      baseline: { passed: true, checks: 1 },
    });

    expect(packet).toMatchObject({
      currentStep: { id: "edit" },
      verifiedFeatures: ["focused tests passed"],
      unresolvedFailures: [],
      recentChangedFiles: ["src/a.ts", "src/z.ts"],
      lastKnownGoodCheckpoint: "turn-1",
      baseline: { passed: true, checks: 1 },
    });
    expect(renderTaskProgressPacket(packet)).toContain("Trusted durable progress packet (runtime-owned)");
  });
});
