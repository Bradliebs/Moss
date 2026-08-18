import { describe, expect, it } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import { exportPortableDataset, importPortableDataset } from "./portable-dataset";

const testCase: EvalCase = {
  schemaVersion: 1,
  id: "portable-case",
  profile: "coding",
  difficulty: "smoke",
  suite: "regression",
  split: "holdout",
  task: {
    objective: "Write result.txt",
    acceptanceCriteria: [{ id: "result", description: "Result exists", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  fixture: { workspaceTemplate: "private-fixture", referenceSolution: "hidden-answer" },
  allowedCapabilities: ["write_file"],
  checks: [{ id: "result-check", criterionId: "result", kind: "file-exists", path: "result.txt" }],
  tags: ["portable"],
};

describe("portable eval dataset", () => {
  it("round-trips executable cases without local or hidden fixture paths", () => {
    const portable = exportPortableDataset([testCase]);
    const imported = importPortableDataset(portable);

    expect(imported[0]).toMatchObject({
      id: testCase.id,
      task: testCase.task,
      allowedCapabilities: ["write_file"],
      checks: testCase.checks,
    });
    expect(portable.cases[0]).not.toHaveProperty("fixture");
    expect(portable.cases[0]).not.toHaveProperty("suite");
    expect(JSON.stringify(portable)).not.toContain("hidden-answer");
  });

  it("rejects invalid imported cases through the native validator", () => {
    const portable = exportPortableDataset([testCase]);
    portable.cases[0].task.acceptanceCriteria = [];

    expect(() => importPortableDataset(portable)).toThrow("acceptance criterion");
  });
});
