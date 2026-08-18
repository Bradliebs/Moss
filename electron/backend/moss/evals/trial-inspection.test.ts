import { describe, expect, it } from "vitest";

import type { HarnessMatrixReport } from "../../../../common/evals";
import { inspectHarnessTrial, renderTrialInspectionHtml } from "./trial-inspection";

function report(cost = 0.25): HarnessMatrixReport {
  const cell = {
    caseId: "case<script>",
    targetId: "model",
    variantId: "guarded",
    repetition: 0,
    result: {
      observation: {
        caseId: "case<script>",
        runId: "run-1",
        provider: "fixture",
        model: "model",
        outcome: "completed" as const,
        startedAt: "2026-08-18T10:00:00.000Z",
        completedAt: "2026-08-18T10:00:01.000Z",
        evidence: [],
        usage: { inputTokens: 10, outputTokens: 3 },
        estimatedCostUsd: cost,
        admissions: [],
      },
      criteria: [{
        criterionId: "required",
        mandatory: true,
        passed: false,
        summary: "Expected state absent",
        checks: [{ checkId: "check", kind: "receipt", passed: false, summary: "Not asserted" }],
      }],
      success: false,
      score: 0,
      durationMs: 1_000,
      failureAttribution: { category: "agent-behavior" as const, reasonCode: "mandatory-criterion-failed", diagnostic: true as const },
      rubricAssessment: {
        diagnostic: true as const,
        provenance: { provider: "fixture", model: "grader-v1", promptHash: "a".repeat(64) },
        judgments: [{ dimensionId: "communication", label: "pass" as const }],
      },
    },
    trace: {
      schemaVersion: 1 as const,
      events: [{ type: "round-start" as const, round: 0, toolsEnabled: true, sequence: 1, timestamp: "2026-08-18T10:00:00.000Z" }],
      toolCalls: [{ callId: "call", name: "read_file", approvalRequested: false, ok: true }],
      usage: { inputTokens: 10, outputTokens: 3 },
      terminalState: "completed" as const,
    },
    protectedInputHashesBefore: { "protected.txt": "before" },
    protectedInputHashesAfter: { "protected.txt": "after" },
    protectedInputsIntact: false,
  };
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-18T10:01:00.000Z",
    manifest: {
      evaluatorVersion: "v1",
      caseIds: [cell.caseId],
      targetIds: [cell.targetId],
      variantIds: [cell.variantId],
      caseSetHash: "cases",
      targetSetHash: "targets",
      variantSetHash: "variants",
    },
    cells: [cell],
    summary: {} as HarnessMatrixReport["summary"],
  };
}

describe("trial inspection", () => {
  it("projects timeline, evidence, protected inputs, resources, attribution, and baseline delta", () => {
    const inspection = inspectHarnessTrial(report(0.25), {}, report(0.1));

    expect(inspection.timeline).toHaveLength(1);
    expect(inspection.criteria[0]).toMatchObject({ criterionId: "required", passed: false });
    expect(inspection.protectedInputs).toEqual({ intact: false, checkedPaths: ["protected.txt"], changedPaths: ["protected.txt"] });
    expect(inspection.resources).toMatchObject({ inputTokens: 10, outputTokens: 3, actions: 1, estimatedCostUsd: 0.25 });
    expect(inspection.outcome.failureAttribution?.category).toBe("agent-behavior");
    expect(inspection.rubricAssessment?.judgments).toEqual([{ dimensionId: "communication", label: "pass" }]);
    expect(inspection.baselineDelta?.costDeltaUsd).toBeCloseTo(0.15);
  });

  it("refuses ambiguous or missing selectors", () => {
    const ambiguous = report();
    ambiguous.cells.push({ ...ambiguous.cells[0], repetition: 1 });

    expect(() => inspectHarnessTrial(ambiguous)).toThrow("ambiguous");
    expect(() => inspectHarnessTrial(ambiguous, { repetition: 9 })).toThrow("No harness trial");
  });

  it("escapes report-controlled strings in standalone HTML", () => {
    const html = renderTrialInspectionHtml(inspectHarnessTrial(report()));

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("case&lt;script&gt;");
    expect(html).not.toContain("case<script>");
  });
});