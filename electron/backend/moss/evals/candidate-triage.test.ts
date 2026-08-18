import { describe, expect, it } from "vitest";

import type { TerminalRunRecord } from "../learning/run-journal";
import { approveEvalCandidate, createEvalCandidatePackages } from "./candidate-triage";

function run(overrides: Partial<TerminalRunRecord> = {}): TerminalRunRecord {
  return {
    schemaVersion: 2,
    taskId: "task-1",
    recordedAt: "2026-07-12T00:00:00.000Z",
    objectiveClass: "code-repair",
    capabilityIds: ["shell"],
    attempts: [],
    failures: [{ category: "tool", summary: "timed out", signature: "timeout-signature" }],
    failureSignatures: ["timeout-signature"],
    taskFamilyCandidate: { id: "code-repair-family", source: "objective-class" },
    recoveryChoices: [],
    criteria: [{ criterionId: "tests", passed: false, summary: "failed" }],
    outcome: "failed",
    durationMs: 100,
    costUsd: 0,
    userSignals: [],
    verificationOutcomes: [{ criterionId: "tests", passed: false, signature: "check-signature" }],
    retention: "sanitized",
    ...overrides,
  };
}

describe("eval candidate triage", () => {
  it("clusters by task family and mechanism and ranks repeated user-impacting failures", () => {
    const candidates = createEvalCandidatePackages([
      run(),
      run({ taskId: "task-2", userSignals: [{ kind: "correction", source: "retry", signalCode: "retry-requested" }] }),
      run({ taskId: "task-3", failureSignatures: ["other-signature"], outcome: "completed" }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      status: "draft",
      familyCandidate: "code-repair-family",
      failureSignature: "timeout-signature",
      occurrences: 2,
      affectedTasks: ["task-1", "task-2"],
      userSignalCount: 1,
      proposed: { split: "development", provenance: { source: "production" } },
    });
    expect(candidates[0].rankScore).toBeGreaterThan(candidates[1].rankScore);
  });

  it("requires all five human checks before approval", () => {
    const candidate = createEvalCandidatePackages([run()])[0];
    expect(() => approveEvalCandidate(candidate, "reviewer")).toThrow("All eval candidate review checks");

    candidate.review = {
      objectiveApproved: true,
      fixtureMinimized: true,
      expectedBehaviorApproved: true,
      splitApproved: true,
      hiddenGraderApproved: true,
    };
    const approved = approveEvalCandidate(candidate, "reviewer", new Date("2026-07-13T00:00:00.000Z"));
    expect(approved).toMatchObject({
      status: "approved",
      review: { reviewer: "reviewer", reviewedAt: "2026-07-13T00:00:00.000Z" },
    });
  });
});
