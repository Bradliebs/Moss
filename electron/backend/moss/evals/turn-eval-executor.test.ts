import { describe, expect, it } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import type { Tool } from "../tools";
import { EvalRunner } from "./eval-runner";
import { createTurnEvalExecutor } from "./turn-eval-executor";

const TEST_CASE: EvalCase = {
  schemaVersion: 1,
  id: "platform-turn-loop",
  profile: "platform",
  difficulty: "smoke",
  task: {
    objective: "Return a completed response",
    acceptanceCriteria: [{ id: "completed", description: "Turn completed", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  allowedCapabilities: [],
  checks: [{ id: "completion-receipt", criterionId: "completed", kind: "receipt", asserted: true }],
};

class DeterministicProvider implements ChatProvider {
  readonly kind = "deterministic";

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", text: "done" };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class ToolCallingProvider implements ChatProvider {
  readonly kind = "deterministic";
  private round = 0;

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    if (this.round++ === 0) {
      yield { type: "tool-call", toolCall: { id: "call-1", name: "read_file", arguments: "{}" } };
      return;
    }
    yield { type: "text-delta", text: "inspection complete" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

describe("createTurnEvalExecutor", () => {
  it("runs the production turn loop and grades its end state independently", async () => {
    const times = [new Date("2026-07-13T10:00:00.000Z"), new Date("2026-07-13T10:00:01.000Z")];
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      estimateCostUsd: (usage) => ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 1_000,
      now: () => times.shift()!,
    });
    const runner = new EvalRunner(execute, { now: () => new Date("2026-07-13T10:00:02.000Z") });

    const report = await runner.run([TEST_CASE]);

    expect(report.overall).toMatchObject({
      runs: 1,
      successes: 1,
      successRate: 1,
      averageTokens: 15,
      averageCostUsd: 0.015,
      averageDurationMs: 1_000,
    });
    expect(report.results[0].observation).toMatchObject({
      provider: "deterministic",
      model: "fixture-model",
      outcome: "completed",
      admissions: ["verified"],
    });
  });

  it("separates tool attempts from approval-gated execution", async () => {
    const tool: Tool = {
      name: "read_file",
      description: "Inspect the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "fixture inspected" }),
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
    });
    const report = await new EvalRunner(execute).run([{
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
    }]);

    expect(report.results[0].observation.admissions).toEqual(["attempted", "verified"]);
    expect(report.overall.admissions).toMatchObject({ attempted: 1, approved: 0, verified: 1 });
  });
});