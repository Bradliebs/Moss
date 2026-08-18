import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import { ProviderError, type ChatProvider, type ChatRequest, type ProviderStreamEvent } from "../providers/types";
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
  readonly requests: ChatRequest[] = [];

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
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

  constructor(private readonly toolName = "read_file") {}

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    if (this.round++ === 0) {
      yield { type: "tool-call", toolCall: { id: "call-1", name: this.toolName, arguments: "{}" } };
      return;
    }
    yield { type: "text-delta", text: "inspection complete" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class FailingProvider implements ChatProvider {
  readonly kind = "deterministic";

  async *streamChat(): AsyncIterable<ProviderStreamEvent> {
    throw new ProviderError("fixture provider unavailable", 400);
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

class BlockingProvider implements ChatProvider {
  readonly kind = "deterministic";

  async *streamChat(_request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    await new Promise<void>((resolveWait) => signal.addEventListener("abort", () => resolveWait(), { once: true }));
    yield { type: "text-delta", text: "late" };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

class ReviewingProvider implements ChatProvider {
  readonly kind = "deterministic";
  readonly requests: ChatRequest[] = [];

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      yield { type: "text-delta", text: "done" };
      return;
    }
    yield { type: "text-delta", text: '{"label":"pass","reasonCode":"criteria-addressed"}' };
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
  }

  async listModels(): Promise<string[]> {
    return ["fixture-model"];
  }
}

describe("createTurnEvalExecutor", () => {
  it("seeds a stable production prompt and records only its profile and hash", async () => {
    const provider = new DeterministicProvider();
    const times = [
      new Date("2026-07-13T10:00:00.000Z"),
      new Date("2026-07-13T10:00:01.000Z"),
      new Date("2026-07-14T10:00:00.000Z"),
      new Date("2026-07-14T10:00:01.000Z"),
    ];
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      now: () => times.shift()!,
      promptNow: () => new Date("2026-07-13T12:00:00.000Z"),
    });

    const first = await execute(TEST_CASE, 0);
    const second = await execute(TEST_CASE, 1);

    expect(provider.requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(provider.requests[0].messages[0].content).toContain("You are Moss");
    expect(provider.requests[0].messages[0].content).toContain("The current local date is 2026-07-13");
    expect(provider.requests[1].messages[0].content).toContain("The current local date is 2026-07-13");
    expect(provider.requests[0].messages[1].content).toBe(TEST_CASE.task.objective);
    expect(first.promptProvenance).toEqual({
      profile: "deterministic-production-v1",
      seededMessagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(second.promptProvenance).toEqual(first.promptProvenance);
  });

  it("preserves explicit message overrides and labels them as custom", async () => {
    const provider = new DeterministicProvider();
    const customMessages = [{ role: "user" as const, content: "specialized case" }];
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      messages: () => customMessages,
      now: () => new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await execute(TEST_CASE, 0);

    expect(provider.requests[0].messages.at(-1)).toEqual(customMessages[0]);
    expect(provider.requests[0].messages[0].content).not.toContain("You are Moss");
    expect(result.promptProvenance).toEqual({
      profile: "custom",
      seededMessagesHash: createHash("sha256").update(JSON.stringify(customMessages)).digest("hex"),
    });
  });

  it("runs the production turn loop and grades its end state independently", async () => {
    const times = [
      new Date("2026-07-13T10:00:00.000Z"),
      new Date("2026-07-13T10:00:01.000Z"),
      new Date("2026-07-13T10:00:02.000Z"),
      new Date("2026-07-13T10:00:03.000Z"),
    ];
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
    const rawExecution = await execute(TEST_CASE, 1);
    expect(rawExecution.rubricInput).toEqual({ responseText: "done" });
    expect(JSON.stringify(report)).not.toContain("responseText");
    expect(rawExecution.trace).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 3 },
      terminalState: "completed",
      toolCalls: [],
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
      provider: new ToolCallingProvider(tool.name),
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

  it("applies a harness variant and returns a trace from the production loop", async () => {
    const tool: Tool = {
      name: "write_file",
      description: "Mutate the disposable fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, content: "fixture changed" }),
    };
    const execute = createTurnEvalExecutor({
      provider: new ToolCallingProvider(tool.name),
      model: "fixture-model",
      toolRegistry: new Map([[tool.name, tool]]),
      workspaceRoot: () => "",
      variant: {
        schemaVersion: 1,
        id: "auto-approved",
        description: "Run mutating tools without a prompt",
        autoApprove: true,
      },
    });
    const result = await execute({
      ...TEST_CASE,
      allowedCapabilities: [tool.name],
    }, 0);

    expect(result.trace?.toolCalls).toEqual([expect.objectContaining({
      name: "write_file",
      approvalRequested: false,
      autoApproved: true,
      ok: true,
    })]);
  });

  it("runs the optional reviewer as a non-gating diagnostic with separate overhead", async () => {
    const provider = new ReviewingProvider();
    const execute = createTurnEvalExecutor({
      provider,
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      estimateCostUsd: (usage) => ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 1_000,
      variant: {
        schemaVersion: 1,
        id: "reviewed",
        description: "Diagnostic reviewer",
        runtime: {
          contextStrategy: "compact",
          planningPolicy: "incremental",
          verificationCadence: "after-mutation",
          recoveryPolicy: "signature-aware",
          reviewerPass: "diagnostic",
        },
      },
    });

    const result = await execute(TEST_CASE, 0);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].tools).toEqual([]);
    expect(result.observation.outcome).toBe("completed");
    expect(result.diagnosticReview).toMatchObject({
      diagnostic: true,
      label: "pass",
      reasonCode: "criteria-addressed",
      usage: { inputTokens: 7, outputTokens: 2 },
      estimatedCostUsd: 0.009,
    });
  });

  it("reports budget exhaustion separately from user cancellation", async () => {
    const execute = createTurnEvalExecutor({
      provider: new DeterministicProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      variant: {
        schemaVersion: 1,
        id: "token-limited",
        description: "Stop after ten tokens",
        budget: { maxTokens: 10 },
      },
    });

    const result = await execute(TEST_CASE, 0);

    expect(result.observation.outcome).toBe("budget-exhausted");
    expect(result.observation.failureReason).toBe("token budget of 10 exceeded");
    expect(result.observation.admissions).toContain("budget-exhausted");
      expect(result.trace?.terminalState).toBe("budget-exhausted");
      expect(result.trace?.events.at(-1)).toMatchObject({ type: "terminal", state: "budget-exhausted" });
  });

  it("preserves provider failures in the observation", async () => {
    const execute = createTurnEvalExecutor({
      provider: new FailingProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
    });

    const result = await execute(TEST_CASE, 0);

    expect(result.observation).toMatchObject({
      outcome: "failed",
      failureReason: "fixture provider unavailable",
    });
    expect(result.failureSource).toBe("provider-model");
  });

  it("propagates a parent matrix cancellation into the active turn", async () => {
    const controller = new AbortController();
    const execute = createTurnEvalExecutor({
      provider: new BlockingProvider(),
      model: "fixture-model",
      toolRegistry: new Map(),
      workspaceRoot: () => "",
      signal: controller.signal,
    });

    const execution = execute(TEST_CASE, 0);
    controller.abort();

    await expect(execution).resolves.toMatchObject({ observation: { outcome: "cancelled" } });
  });
});