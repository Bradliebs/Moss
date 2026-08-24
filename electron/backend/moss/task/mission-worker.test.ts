import { describe, expect, it, vi } from "vitest";

import type { TaskMissionPlan } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import type { Tool } from "../tools";
import type { MissionWorkOrder } from "./mission-controller";
import { RunTurnMissionWorker } from "./mission-worker";

function tool(name: string, execute = vi.fn(async () => ({ ok: true, content: `${name} ok` }))): Tool {
  return { name, description: name, parameters: { type: "object", properties: {} }, execute };
}

function scripted(rounds: ProviderStreamEvent[][], requests: ChatRequest[]): ChatProvider {
  let index = 0;
  return {
    kind: "fixture",
    async *streamChat(request) {
      requests.push(structuredClone(request));
      const events = rounds[Math.min(index++, rounds.length - 1)];
      for (const event of events) yield event;
    },
    async listModels() { return ["fixture"]; },
  };
}

function order(capabilities = ["read_file"], maxActions = 2): MissionWorkOrder {
  const plan: TaskMissionPlan = {
    schemaVersion: 1,
    revision: 1,
    steps: [{
      id: "inspect",
      description: "Inspect",
      state: "running",
      dependsOn: [],
      requiredCapabilities: capabilities,
      mission: {
        kind: "research",
        workerRole: "researcher",
        executionLane: capabilities.includes("edit_file") ? "exclusive" : "readonly-parallel",
        acceptanceCriterionIds: [],
        budget: { maxActions, maxTokens: 100 },
        expectedArtifacts: ["findings"],
      },
    }],
  };
  return {
    schemaVersion: 1,
    taskId: "task-1",
    planRevision: plan.revision,
    attemptId: "attempt-1",
    objective: "Inspect",
    constraints: [],
    assumptions: [],
    step: plan.steps[0],
    acceptanceCriteria: [],
    dependencyArtifacts: [],
    remainingTaskBudget: { maxActions: 2, maxTokens: 100 },
  };
}

describe("RunTurnMissionWorker", () => {
  it("advertises only assigned capabilities and derives usage from host events", async () => {
    const requests: ChatRequest[] = [];
    const read = tool("read_file");
    const edit = tool("edit_file");
    const worker = new RunTurnMissionWorker({
      provider: scripted([
        [
          { type: "tool-call", toolCall: { id: "read-1", name: "read_file", arguments: "{}" } },
          { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
        ],
        [{ type: "text-delta", text: "inspected" }],
      ], requests),
      model: "fixture",
      tools: [read, edit],
      workspaceRoot: "H:\\Moss",
      requestApproval: async () => ({ approved: true }),
    });

    const execution = await worker.execute(order(), new AbortController().signal);

    expect(requests[0].tools?.map((definition) => definition.name)).toEqual(["read_file"]);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(edit.execute).not.toHaveBeenCalled();
    expect(execution).toMatchObject({
      result: { status: "succeeded", artifacts: [{ name: "findings", content: "inspected" }] },
      usage: { actions: 1, usage: { inputTokens: 3, outputTokens: 2 } },
    });
    expect(requests.every((request) => request.maxTokens === 100)).toBe(true);
  });

  it("denies an unassigned hallucinated tool before execution", async () => {
    const write = tool("write_file");
    const worker = new RunTurnMissionWorker({
      provider: scripted([
        [{ type: "tool-call", toolCall: { id: "write-1", name: "write_file", arguments: "{}" } }],
        [{ type: "text-delta", text: "done" }],
      ], []),
      model: "fixture",
      tools: [write],
      workspaceRoot: "H:\\Moss",
      requestApproval: async () => ({ approved: true }),
      maxRounds: 1,
    });

    const execution = await worker.execute(order(), new AbortController().signal);

    expect(write.execute).not.toHaveBeenCalled();
    expect(execution).toMatchObject({ result: { status: "failed" }, usage: { actions: 0 } });
  });

  it("prevents calls beyond the step action budget", async () => {
    const read = tool("read_file");
    const worker = new RunTurnMissionWorker({
      provider: scripted([
        [
          { type: "tool-call", toolCall: { id: "read-1", name: "read_file", arguments: "{}" } },
          { type: "tool-call", toolCall: { id: "read-2", name: "read_file", arguments: "{}" } },
        ],
        [{ type: "text-delta", text: "done" }],
      ], []),
      model: "fixture",
      tools: [read],
      workspaceRoot: "H:\\Moss",
      requestApproval: async () => ({ approved: true }),
      maxRounds: 1,
    });

    const execution = await worker.execute(order(["read_file"], 1), new AbortController().signal);

    expect(read.execute).toHaveBeenCalledOnce();
    expect(execution).toMatchObject({ result: { status: "failed" }, usage: { actions: 1 } });
  });

  it("uses the approval bridge for supervised mutating work", async () => {
    const approvals: string[] = [];
    const edit = tool("edit_file");
    const worker = new RunTurnMissionWorker({
      provider: scripted([
        [{ type: "tool-call", toolCall: { id: "edit-1", name: "edit_file", arguments: "{}" } }],
        [{ type: "text-delta", text: "edited" }],
      ], []),
      model: "fixture",
      tools: [edit],
      workspaceRoot: "H:\\Moss",
      requestApproval: async (callId) => {
        approvals.push(callId);
        return { approved: true };
      },
    });

    const execution = await worker.execute(order(["edit_file"]), new AbortController().signal);

    expect(approvals).toEqual(["edit-1"]);
    expect(edit.execute).toHaveBeenCalledOnce();
    expect(execution.result.status).toBe("succeeded");
  });
});