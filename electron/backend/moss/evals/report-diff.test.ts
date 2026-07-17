import { describe, expect, it } from "vitest";

import type { HarnessMatrixReport } from "../../../../common/evals";
import { diffHarnessReports } from "./report-diff";

function report(overrides: Partial<HarnessMatrixReport> = {}): HarnessMatrixReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-17T09:00:00.000Z",
    manifest: {
      evaluatorVersion: "moss-harness-v1",
      caseIds: ["case-a"],
      targetIds: ["model-a"],
      variantIds: ["variant-a"],
      caseSetHash: "cases",
      targetSetHash: "targets",
      variantSetHash: "variants",
    },
    cells: [{
      caseId: "case-a",
      targetId: "model-a",
      variantId: "variant-a",
      repetition: 0,
      result: {
        observation: {
          caseId: "case-a",
          runId: "run-a",
          provider: "deterministic",
          model: "fixture-model",
          outcome: "completed",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          evidence: [],
          usage: { inputTokens: 8, outputTokens: 2 },
          estimatedCostUsd: 0.01,
          admissions: ["attempted"],
        },
        criteria: [],
        success: true,
        score: 1,
        durationMs: 1_000,
      },
      trace: {
        toolCalls: [{ callId: "call-1", name: "read_file", approvalRequested: false, ok: true }],
        usage: { inputTokens: 8, outputTokens: 2 },
        terminalState: "completed",
      },
      harnessScore: {
        completion: 1,
        mandatoryCompletion: true,
        securityPassed: true,
        securityViolations: [],
        process: { robustness: 1, toolUse: 1, consistency: 1 },
        diagnosticComposite: 1,
      },
      protectedInputHashesBefore: {},
      protectedInputHashesAfter: {},
      protectedInputsIntact: true,
    }],
    ...overrides,
  };
}

describe("diffHarnessReports", () => {
  it("rejects reports produced from different benchmark inputs", () => {
    const candidate = report({
      manifest: { ...report().manifest, caseSetHash: "changed-cases" },
    });

    expect(() => diffHarnessReports(report(), candidate)).toThrow("case set");
  });

  it("flags regressions by signal instead of hiding them in the composite", () => {
    const candidate = report();
    candidate.cells[0].result.success = false;
    candidate.cells[0].result.observation.usage = { inputTokens: 18, outputTokens: 2 };
    candidate.cells[0].result.observation.estimatedCostUsd = 0.03;
    candidate.cells[0].result.durationMs = 1_500;
    candidate.cells[0].trace!.toolCalls.push({
      callId: "call-2",
      name: "read_file",
      approvalRequested: false,
      ok: true,
    });
    candidate.cells[0].harnessScore = {
      ...candidate.cells[0].harnessScore!,
      securityPassed: false,
      process: { robustness: 0.5, toolUse: 1, consistency: 1 },
      diagnosticComposite: 0,
    };

    const diff = diffHarnessReports(report(), candidate);

    expect(diff.passed).toBe(false);
    expect(diff.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining("completion"),
      expect.stringContaining("security"),
      expect.stringContaining("robustness"),
      expect.stringContaining("tokens"),
      expect.stringContaining("cost"),
      expect.stringContaining("duration"),
      expect.stringContaining("actions"),
    ]));
  });
});