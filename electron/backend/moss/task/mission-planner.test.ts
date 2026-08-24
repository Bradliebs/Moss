import { describe, expect, it } from "vitest";

import type { TaskMissionPlan, TaskSpec } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { MissionPlanner } from "./mission-planner";

const SPEC: TaskSpec = {
  objective: "Inspect and verify",
  acceptanceCriteria: [{ id: "verified", description: "Inspection verified", mandatory: true }],
  constraints: [],
  assumptions: [],
  budget: { maxActions: 2 },
};

function validPlan(): TaskMissionPlan {
  return {
    schemaVersion: 1,
    revision: 1,
    steps: [{
      id: "inspect",
      description: "Inspect the workspace",
      state: "pending",
      dependsOn: [],
      requiredCapabilities: ["read_file"],
      mission: {
        kind: "verify",
        workerRole: "verifier",
        executionLane: "readonly-parallel",
        acceptanceCriterionIds: ["verified"],
        budget: { maxActions: 2 },
        expectedArtifacts: ["report"],
      },
    }],
  };
}

function scripted(responses: Array<Array<{ name: string; arguments: string }>>, requests: ChatRequest[]): ChatProvider {
  return {
    kind: "fixture",
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      for (const toolCall of responses.shift() ?? []) {
        yield { type: "tool-call", toolCall: { id: crypto.randomUUID(), ...toolCall } };
      }
    },
    async listModels() { return ["fixture"]; },
  };
}

describe("MissionPlanner", () => {
  it("admits exactly one valid synthetic plan submission without workspace tools", async () => {
    const requests: ChatRequest[] = [];
    const planner = new MissionPlanner({
      provider: scripted([[{ name: "submit_mission_plan", arguments: JSON.stringify({ plan: validPlan() }) }]], requests),
      model: "fixture",
      capabilities: [{ id: "read_file", risk: "readonly" }],
    });

    const result = await planner.plan(SPEC, new AbortController().signal);

    expect(result).toMatchObject({ kind: "planned", attempts: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(["submit_mission_plan"]);
  });

  it("uses one repair attempt for an invalid plan and no more", async () => {
    const requests: ChatRequest[] = [];
    const repaired = validPlan();
    const planner = new MissionPlanner({
      provider: scripted([
        [{ name: "submit_mission_plan", arguments: JSON.stringify({ plan: { schemaVersion: 1, revision: 1 } }) }],
        [{ name: "submit_mission_plan", arguments: JSON.stringify({ plan: repaired }) }],
      ], requests),
      model: "fixture",
      capabilities: [{ id: "read_file", risk: "readonly" }],
    });

    await expect(planner.plan(SPEC, new AbortController().signal)).resolves.toMatchObject({ kind: "planned", attempts: 2 });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content).toContain("Previous submission rejected");
  });

  it("returns a typed user-decision blocker", async () => {
    const planner = new MissionPlanner({
      provider: scripted([[{
        name: "submit_mission_plan",
        arguments: JSON.stringify({ userDecision: { summary: "Choose the target environment" } }),
      }]], []),
      model: "fixture",
      capabilities: [{ id: "read_file", risk: "readonly" }],
      now: () => new Date("2026-08-23T12:00:00.000Z"),
    });

    await expect(planner.plan(SPEC, new AbortController().signal)).resolves.toMatchObject({
      kind: "blocked",
      attempts: 1,
      blocker: { kind: "user-decision", summary: "Choose the target environment" },
    });
  });

  it("replans with completed work, failures, blocker, evidence, artifacts, and remaining budget", async () => {
    const requests: ChatRequest[] = [];
    const replacement = validPlan();
    replacement.revision = 2;
    replacement.supersedesRevision = 1;
    replacement.revisionReason = "inspection failed";
    const planner = new MissionPlanner({
      provider: scripted([[{ name: "submit_mission_plan", arguments: JSON.stringify({ plan: replacement }) }]], requests),
      model: "fixture",
      capabilities: [{ id: "read_file", risk: "readonly" }],
    });

    await expect(planner.replan(SPEC, {
      currentPlan: validPlan(),
      completedSteps: [],
      evidence: [{
        id: "evidence-1",
        criterionId: "verified",
        kind: "command",
        passed: false,
        summary: "check failed",
        capturedAt: "2026-08-23T12:00:00.000Z",
      }],
      artifacts: [],
      failures: [{ stepId: "inspect", error: "inspection failed" }],
      blocker: {
        kind: "verification",
        summary: "inspection failed",
        resumable: true,
        createdAt: "2026-08-23T12:00:00.000Z",
      },
      remainingBudget: { maxActions: 1 },
    }, new AbortController().signal)).resolves.toMatchObject({ kind: "planned", plan: { revision: 2, supersedesRevision: 1 } });

    const context = JSON.parse(requests[0].messages[1].content.split("\n")[1]);
    expect(context).toMatchObject({
      requestedRevision: 2,
      supersedesRevision: 1,
      failures: [{ stepId: "inspect", error: "inspection failed" }],
      blocker: { kind: "verification" },
      remainingBudget: { maxActions: 1 },
    });
    expect(context).toHaveProperty("completedStepsMustRemainStructurallyIdentical");
    expect(context).toHaveProperty("acceptedEvidence");
    expect(context).toHaveProperty("acceptedArtifacts");
  });

  it("rejects a second invalid submission after the bounded repair", async () => {
    const invalid = { name: "submit_mission_plan", arguments: "{}" };
    const planner = new MissionPlanner({
      provider: scripted([[invalid], [invalid]], []),
      model: "fixture",
      capabilities: [{ id: "read_file", risk: "readonly" }],
    });

    await expect(planner.plan(SPEC, new AbortController().signal)).rejects.toThrow("either plan or userDecision");
  });
});