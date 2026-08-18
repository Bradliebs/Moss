import { describe, expect, it } from "vitest";

import { createRetrospective, updateLessonConfidence } from "./retrospective";
import type { TerminalRunRecord } from "./run-journal";

function run(outcome: TerminalRunRecord["outcome"]): TerminalRunRecord {
  return {
    schemaVersion: 2,
    taskId: `task-${outcome}`,
    recordedAt: "2026-07-12T00:00:00.000Z",
    objectiveClass: "code-repair",
    capabilityIds: ["shell", "shell"],
    attempts: [{ capabilityId: "shell", attempt: 1, result: "failed", summary: "command failed" }],
    failures: [{ category: "verification", summary: "tests failed", signature: "failure-signature" }],
    failureSignatures: ["failure-signature"],
    taskFamilyCandidate: { id: "code-repair-family", source: "objective-class" },
    recoveryChoices: ["changed the implementation"],
    criteria: [{ criterionId: "tests", passed: outcome === "completed", summary: "focused tests pass" }],
    outcome,
    durationMs: 100,
    costUsd: 0,
    userSignals: [{ kind: "override", source: "user-message", signalCode: "change-direction" }],
    verificationOutcomes: [{ criterionId: "tests", passed: outcome === "completed", signature: "verification-signature" }],
    retention: "sanitized",
  };
}

describe("createRetrospective", () => {
  it.each(["completed", "failed", "blocked", "cancelled"] as const)("creates lessons for %s runs", (outcome) => {
    const lessons = createRetrospective(run(outcome));
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]).toMatchObject({
      provenanceTaskId: `task-${outcome}`,
      scope: "code-repair",
      outcome: outcome === "completed" ? "positive" : "negative",
    });
  });

  it("bounds lesson count and text and never copies user overrides or raw output", () => {
    const record = run("failed");
    record.failures = Array.from({ length: 10 }, (_, index) => ({
      category: `failure-${index}`,
      summary: `${"long ".repeat(100)}${index}`,
    }));
    const lessons = createRetrospective(record, 99);
    expect(lessons).toHaveLength(5);
    expect(lessons.every((lesson) => lesson.summary.length <= 240)).toBe(true);
    expect(JSON.stringify(lessons)).not.toContain("untrusted page content");
    expect(JSON.stringify(lessons)).not.toContain("rawToolOutput");
  });
});

describe("updateLessonConfidence", () => {
  it("raises confidence with successes and rolls back after repeated net failures", () => {
    expect(updateLessonConfidence(4, 1)).toEqual({ confidence: 0.7143, rolledBack: false });
    expect(updateLessonConfidence(1, 3)).toEqual({ confidence: 0.3333, rolledBack: true });
    expect(updateLessonConfidence(0, 1)).toEqual({ confidence: 0.3333, rolledBack: false });
  });

  it("rejects invalid counts", () => {
    expect(() => updateLessonConfidence(-1, 0)).toThrow("non-negative integer");
    expect(() => updateLessonConfidence(1.5, 0)).toThrow("non-negative integer");
  });
});