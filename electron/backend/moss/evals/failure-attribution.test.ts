import { describe, expect, it } from "vitest";

import type { EvalFailureCategory, EvalRunResult, HarnessExecutionTrace } from "../../../../common/evals";
import { attributeEvalFailure } from "./failure-attribution";

function failedResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    observation: {
      caseId: "case",
      runId: "run",
      provider: "test",
      model: "fixture",
      outcome: "failed",
      startedAt: "2026-08-18T10:00:00.000Z",
      completedAt: "2026-08-18T10:00:01.000Z",
      evidence: [],
      usage: {},
      estimatedCostUsd: 0,
      admissions: [],
    },
    criteria: [],
    success: false,
    score: 0,
    durationMs: 1_000,
    ...overrides,
  };
}

function traceWithFailedTool(): HarnessExecutionTrace {
  return {
    schemaVersion: 1,
    events: [],
    toolCalls: [{ callId: "failed", name: "read_file", approvalRequested: false, ok: false }],
    usage: {},
    terminalState: "error",
  };
}

describe("attributeEvalFailure", () => {
  it.each([
    ["provider-model", "provider-model"],
    ["tool", "tool"],
    ["harness-orchestration", "harness-orchestration"],
    ["environment", "environment"],
  ] as const)("uses explicit %s execution provenance", (source, category) => {
    expect(attributeEvalFailure({ result: failedResult(), executionFailureSource: source })?.category).toBe(category);
  });

  it("attributes a valid mandatory-check failure to agent behavior", () => {
    const result = failedResult({
      observation: { ...failedResult().observation, outcome: "completed" },
      criteria: [{
        criterionId: "required",
        mandatory: true,
        passed: false,
        summary: "Expected state absent",
        checks: [{ checkId: "check", kind: "file-contains", passed: false, summary: "Expected state absent", failureKind: "assertion" }],
      }],
    });

    expect(attributeEvalFailure({ result })).toMatchObject({ category: "agent-behavior", diagnostic: true });
  });

  it("gives grader errors precedence over executor and agent signals", () => {
    const result = failedResult({
      criteria: [{
        criterionId: "required",
        mandatory: true,
        passed: false,
        summary: "Checker failed",
        checks: [{ checkId: "check", kind: "custom", passed: false, summary: "Checker failed", failureKind: "grader" }],
      }],
    });

    expect(attributeEvalFailure({ result, executionFailureSource: "provider-model" })?.category).toBe("grader");
  });

  it("attributes an unrecovered failed tool when no stronger provenance exists", () => {
    expect(attributeEvalFailure({ result: failedResult(), trace: traceWithFailedTool() })?.category).toBe("tool");
  });

  it("does not blame a recovered tool failure", () => {
    const trace = traceWithFailedTool();
    trace.toolCalls.push({
      callId: "recovered",
      name: "read_file",
      approvalRequested: false,
      ok: true,
      recoveredFromCallId: "failed",
    });

    expect(attributeEvalFailure({ result: failedResult(), trace })?.category).toBe("unknown");
  });

  it("covers every category and omits attribution for success", () => {
    const categories = new Set<EvalFailureCategory>([
      "agent-behavior",
      "provider-model",
      "tool",
      "harness-orchestration",
      "grader",
      "environment",
      "unknown",
    ]);
    expect(categories.size).toBe(7);
    expect(attributeEvalFailure({ result: failedResult({ success: true }) })).toBeUndefined();
  });
});