import { describe, expect, it } from "vitest";

import type { EvalRubricAssessment } from "../../../../common/evals";
import { measureRubricAgreement, runRubricGrader } from "./rubric-grading";

const provenance = { provider: "fixture", model: "grader-v1", promptHash: "a".repeat(64) };

function assessment(labels: Record<string, "pass" | "fail" | "unknown">): EvalRubricAssessment {
  return {
    diagnostic: true,
    provenance,
    judgments: Object.entries(labels).map(([dimensionId, label]) => ({ dimensionId, label })),
  };
}

describe("rubric grading", () => {
  it("grades independent dimensions with pinned provenance", async () => {
    const result = await runRubricGrader({
      dimensions: [
        { id: "instruction-following", description: "Follows the request" },
        { id: "communication", description: "Communicates clearly" },
      ],
      provenance,
      grade: async ({ dimension }) => dimension.id === "instruction-following"
        ? { dimensionId: dimension.id, label: "pass", reasonCode: "requirements-met" }
        : { dimensionId: dimension.id, label: "unknown", reasonCode: "insufficient-evidence" },
    }, { caseId: "case", objective: "Do the work", responseText: "Done" });

    expect(result).toEqual({
      diagnostic: true,
      provenance,
      judgments: [
        { dimensionId: "instruction-following", label: "pass", reasonCode: "requirements-met" },
        { dimensionId: "communication", label: "unknown", reasonCode: "insufficient-evidence" },
      ],
    });
  });

  it("rejects unpinned provenance and incomplete dimension results", async () => {
    await expect(runRubricGrader({
      dimensions: [{ id: "quality", description: "Quality" }],
      provenance: { ...provenance, promptHash: "mutable" },
      grade: async () => ({ dimensionId: "quality", label: "pass" }),
    }, { caseId: "case", objective: "Do the work", responseText: "Done" })).rejects.toThrow("pinned");

    const partialFailure = await runRubricGrader({
      dimensions: [
        { id: "quality", description: "Quality" },
        { id: "communication", description: "Communication" },
      ],
      provenance,
      grade: async ({ dimension }) => {
        if (dimension.id === "communication") throw new Error("grader unavailable");
        return { dimensionId: dimension.id, label: "pass" };
      },
    }, { caseId: "case", objective: "Do the work", responseText: "Done" });
    expect(partialFailure.judgments).toEqual([
      { dimensionId: "quality", label: "pass" },
      { dimensionId: "communication", label: "unknown", reasonCode: "rubric-grader-error" },
    ]);
  });

  it("reports unknown-aware human agreement and requires every dimension to calibrate", () => {
    const samples = [
      { sampleId: "1", assessment: assessment({ quality: "pass", communication: "unknown" }), humanLabels: { quality: "pass" as const, communication: "pass" as const } },
      { sampleId: "2", assessment: assessment({ quality: "fail", communication: "pass" }), humanLabels: { quality: "fail" as const, communication: "pass" as const } },
    ];

    const report = measureRubricAgreement(samples, {
      minimumLabelsPerDimension: 2,
      minimumCoverage: 1,
      minimumAgreement: 1,
    });

    expect(report.byDimension.quality).toMatchObject({ labeled: 2, coverage: 1, agreementRate: 1, calibrated: true });
    expect(report.byDimension.communication).toMatchObject({ labeled: 2, unknown: 1, coverage: 0.5, calibrated: false });
    expect(report.calibrated).toBe(false);
    expect(report.overall.calibrated).toBe(false);
  });

  it("rejects invalid human labels from external calibration data", () => {
    expect(() => measureRubricAgreement([{
      sampleId: "external",
      assessment: assessment({ quality: "pass" }),
      humanLabels: { quality: "maybe" as "pass" },
    }])).toThrow("Invalid human rubric label");
  });
});