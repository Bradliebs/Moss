import { randomUUID } from "node:crypto";

import type { EvalAdmission, EvalCase, EvalExecutionObservation } from "../../../../common/evals";
import type { AgentMessage, MossEvent, TokenUsage } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider } from "../providers/types";
import type { Tool } from "../tools";
import type { EvalExecutionResult, EvalExecutor } from "./eval-runner";

export interface TurnEvalExecutorOptions {
  provider: ChatProvider;
  model: string;
  toolRegistry: Map<string, Tool>;
  workspaceRoot: (testCase: EvalCase, repetition: number) => Promise<string> | string;
  messages?: (testCase: EvalCase, repetition: number) => Promise<AgentMessage[]> | AgentMessage[];
  requestApproval?: (callId: string) => Promise<boolean>;
  autoApprove?: boolean;
  estimateCostUsd?: (usage: TokenUsage) => number;
  now?: () => Date;
}

/** Adapt the production agent loop to the provider-neutral evaluation runner. */
export function createTurnEvalExecutor(options: TurnEvalExecutorOptions): EvalExecutor {
  const now = options.now ?? (() => new Date());
  return async (testCase, repetition): Promise<EvalExecutionResult> => {
    const workspaceRoot = await options.workspaceRoot(testCase, repetition);
    const messages: AgentMessage[] = options.messages
      ? await options.messages(testCase, repetition)
      : [{ role: "user", content: testCase.task.objective }];
    const allowed = new Set(testCase.allowedCapabilities);
    const tools = [...options.toolRegistry.values()].filter((tool) => allowed.has(tool.name));
    const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));
    const admissions: EvalAdmission[] = [];
    const usage: TokenUsage = {};
    const approvalRequests = new Set<string>();
    const failedTools = new Set<string>();
    let outcome: EvalExecutionObservation["outcome"] = "failed";
    const startedAtDate = now();
    const startedAt = startedAtDate.toISOString();

    const onEvent = (event: MossEvent): void => {
      if (event.type === "token-usage") {
        usage.inputTokens = (usage.inputTokens ?? 0) + (event.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (event.usage.outputTokens ?? 0);
      } else if (event.type === "tool-call") {
        admissions.push("attempted");
      } else if (event.type === "tool-approval-request") {
        admissions.push("blocked");
        approvalRequests.add(event.callId);
      } else if (event.type === "tool-result") {
        if (!event.ok) {
          admissions.push("failed");
          failedTools.add(event.name);
        } else {
          if (event.autoApproved || approvalRequests.has(event.callId)) admissions.push("approved");
          if (failedTools.has(event.name)) admissions.push("recovered");
        }
      } else if (event.type === "turn-complete") {
        outcome = "completed";
      } else if (event.type === "turn-aborted") {
        outcome = "cancelled";
      }
    };

    await runTurn({
      provider: options.provider,
      model: options.model,
      messages,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      toolRegistry,
      workspaceRoot,
      signal: new AbortController().signal,
      onEvent,
      requestApproval: options.requestApproval ?? (async () => false),
      autoApprove: options.autoApprove,
      now: () => startedAtDate,
    });

    return {
      workspaceRoot,
      observation: {
        caseId: testCase.id,
        runId: `${testCase.id}-${repetition}-${randomUUID()}`,
        provider: options.provider.kind,
        model: options.model,
        outcome,
        startedAt,
        completedAt: now().toISOString(),
        usage,
        estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
        admissions,
      },
    };
  };
}