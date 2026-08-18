import { describe, expect, it } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import { createOfflinePilotCases } from "./pilot-cases";
import {
  createInitialLineage,
  findDuplicateWarnings,
  reviseEvalCase,
  validateDatasetLineage,
} from "./dataset-lineage";

function governedCase(id = "case-one"): EvalCase {
  const testCase = structuredClone(createOfflinePilotCases()[0]);
  testCase.id = id;
  testCase.family = `${id}-family`;
  testCase.split = "development";
  testCase.perturbation = { class: "canonical", expectedDecision: "same", canonicalCaseId: id };
  testCase.lineage = createInitialLineage(testCase);
  return testCase;
}

describe("dataset lineage", () => {
  it("creates immutable revisions linked to their parent and source run", () => {
    const first = governedCase();
    const changed = structuredClone(first);
    changed.task.objective = `${changed.task.objective} with an additional constraint`;
    const second = reviseEvalCase(first, changed, { taskId: "task-9", failureSignature: "failure-9" });

    expect(second.lineage).toMatchObject({
      revision: 2,
      parentRevisionId: first.lineage!.revisionId,
      familyRootId: first.lineage!.familyRootId,
      authoredFromRun: { taskId: "task-9", failureSignature: "failure-9" },
    });
    expect(second.lineage!.revisionId).not.toBe(first.lineage!.revisionId);
    expect(first.lineage!.revision).toBe(1);
  });

  it("detects content mutation without revision and family-level holdout contamination", () => {
    const development = governedCase("development-case");
    const holdout = governedCase("holdout-case");
    holdout.lineage = { ...holdout.lineage!, familyRootId: development.lineage!.familyRootId };
    holdout.split = "holdout";
    holdout.lineage.contentHash = createInitialLineage(holdout).contentHash;
    development.task.objective = `${development.task.objective} silently mutated`;

    const health = validateDatasetLineage([development, holdout]);

    expect(health.valid).toBe(false);
    expect(health.errors).toEqual(expect.arrayContaining([
      "Case 'development-case' content changed without a revision",
      `Family '${development.lineage!.familyRootId}' crosses holdout and non-holdout splits`,
    ]));
  });

  it("warns on near-duplicate objectives across nominally different families", () => {
    const left = governedCase("left");
    const right = governedCase("right");
    right.task.objective = `${left.task.objective} please`;
    right.lineage = createInitialLineage(right);

    expect(findDuplicateWarnings([left, right], 0.75)).toEqual([
      expect.objectContaining({ leftCaseId: "left", rightCaseId: "right" }),
    ]);
  });
});
