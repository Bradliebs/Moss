import { describe, expect, it } from "vitest";

import type { TaskMissionPlan, TaskSpec, TaskStep } from "../../../../common/types";
import { validateMissionPlan, type MissionCapability } from "./mission-plan";

const SPEC: TaskSpec = {
  objective: "Implement and verify the mission",
  acceptanceCriteria: [
    { id: "implementation", description: "The change is implemented", mandatory: true },
    { id: "tests", description: "The tests pass", mandatory: true },
  ],
  constraints: [],
  assumptions: [],
  budget: { maxActions: 6, maxTokens: 12_000 },
};

const CAPABILITIES: MissionCapability[] = [
  { id: "read_file", risk: "readonly" },
  { id: "edit_file", risk: "mutating" },
  { id: "run_command", risk: "mutating" },
];

function step(overrides: Partial<TaskStep> & Pick<TaskStep, "id">): TaskStep {
  return {
    description: overrides.id,
    state: "pending",
    dependsOn: [],
    requiredCapabilities: ["read_file"],
    mission: {
      kind: "research",
      workerRole: "researcher",
      executionLane: "readonly-parallel",
      acceptanceCriterionIds: [],
      budget: { maxActions: 1, maxTokens: 2_000 },
      expectedArtifacts: ["findings"],
    },
    ...overrides,
  };
}

function validPlan(): TaskMissionPlan {
  return {
    schemaVersion: 1,
    revision: 1,
    steps: [
      step({ id: "research" }),
      step({
        id: "implement",
        dependsOn: ["research"],
        requiredCapabilities: ["edit_file"],
        mission: {
          kind: "implement",
          workerRole: "implementer",
          executionLane: "exclusive",
          acceptanceCriterionIds: ["implementation"],
          budget: { maxActions: 3, maxTokens: 6_000 },
          expectedArtifacts: ["changed-files"],
        },
      }),
      step({
        id: "verify",
        dependsOn: ["implement"],
        requiredCapabilities: ["run_command"],
        mission: {
          kind: "verify",
          workerRole: "verifier",
          executionLane: "exclusive",
          acceptanceCriterionIds: ["tests"],
          budget: { maxActions: 2, maxTokens: 4_000 },
          expectedArtifacts: ["test-report"],
        },
      }),
    ],
  };
}

describe("validateMissionPlan", () => {
  it("accepts a bounded acyclic plan that covers every mandatory criterion", () => {
    expect(() => validateMissionPlan(SPEC, validPlan(), CAPABILITIES)).not.toThrow();
  });

  it("rejects dependency cycles", () => {
    const plan = validPlan();
    plan.steps[0].dependsOn = ["verify"];

    expect(() => validateMissionPlan(SPEC, plan, CAPABILITIES)).toThrow("dependency cycle");
  });

  it("rejects unknown capabilities and mutating work in a parallel read-only lane", () => {
    const unknown = validPlan();
    unknown.steps[0].requiredCapabilities = ["missing"];
    expect(() => validateMissionPlan(SPEC, unknown, CAPABILITIES)).toThrow("unknown capability 'missing'");

    const unsafe = validPlan();
    unsafe.steps[0].requiredCapabilities = ["edit_file"];
    expect(() => validateMissionPlan(SPEC, unsafe, CAPABILITIES)).toThrow("readonly-parallel lane");
  });

  it("rejects missing criterion coverage and aggregate budget overflow", () => {
    const uncovered = validPlan();
    uncovered.steps[2].mission!.acceptanceCriterionIds = [];
    expect(() => validateMissionPlan(SPEC, uncovered, CAPABILITIES)).toThrow("tests");

    const overBudget = validPlan();
    overBudget.steps[0].mission!.budget.maxActions = 2;
    expect(() => validateMissionPlan(SPEC, overBudget, CAPABILITIES)).toThrow("exceeds task limit");
  });

  it("rejects malformed runtime contracts from structured planner output", () => {
    expect(() => validateMissionPlan(SPEC, { schemaVersion: 1, revision: 1 }, CAPABILITIES)).toThrow("steps must be an array");
    expect(() => validateMissionPlan(SPEC, {
      schemaVersion: 1,
      revision: 1,
      steps: [{ id: "research", description: "Research", state: "pending", dependsOn: "none" }],
    }, CAPABILITIES)).toThrow("dependency or capability lists");

    const unsafeId = validPlan();
    unsafeId.steps[0].id = "../research";
    expect(() => validateMissionPlan(SPEC, unsafeId, CAPABILITIES)).toThrow("mission step id");

    const invalidRole = validPlan();
    invalidRole.steps[0].mission!.workerRole = "administrator" as "researcher";
    expect(() => validateMissionPlan(SPEC, invalidRole, CAPABILITIES)).toThrow("unknown worker role");

    const noOutput = validPlan();
    noOutput.steps[0].mission!.expectedArtifacts = [];
    expect(() => validateMissionPlan(SPEC, noOutput, CAPABILITIES)).toThrow("produce an artifact or acceptance evidence");
  });
});