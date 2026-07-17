import { randomUUID } from "node:crypto";

import type { EvalAdmission, EvalCase, EvalExecutionObservation, HarnessVariant } from "../../../../common/evals";
import type { AgentMessage, MossEvent, TokenUsage } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider } from "../providers/types";
import type { Tool } from "../tools";
import type { EvalExecutionResult, EvalExecutor } from "./eval-runner";
import { HarnessTraceCollector } from "./trace-collector";

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
  variant?: HarnessVariant;
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
    const traceCollector = new HarnessTraceCollector();
    const controller = new AbortController();
    const budget = options.variant?.budget ?? testCase.benchmark?.budget ?? testCase.task.budget;
    let budgetReason: string | undefined;
    let failureReason: string | undefined;
    let actionCount = 0;
    let outcome: EvalExecutionObservation["outcome"] = "failed";
    const startedAtDate = now();
    const startedAt = startedAtDate.toISOString();

    const exhaustBudget = (reason: string): void => {
      if (budgetReason) return;
      budgetReason = reason;
      admissions.push("budget-exhausted");
      controller.abort();
    };

    const onEvent = (event: MossEvent): void => {
      traceCollector.onEvent(event);
      if (event.type === "token-usage") {
        usage.inputTokens = (usage.inputTokens ?? 0) + (event.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (budget?.maxTokens && tokens > budget.maxTokens) {
          exhaustBudget(`token budget of ${budget.maxTokens} exceeded`);
        }
        const cost = options.estimateCostUsd?.(usage) ?? 0;
        if (budget?.maxCostUsd && cost > budget.maxCostUsd) {
          exhaustBudget(`cost budget of $${budget.maxCostUsd} exceeded`);
        }
      } else if (event.type === "tool-call") {
        admissions.push("attempted");
        actionCount++;
        if (budget?.maxActions && actionCount > budget.maxActions) {
          exhaustBudget(`action budget of ${budget.maxActions} exceeded`);
        }
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
        if (!budgetReason) outcome = "completed";
      } else if (event.type === "turn-aborted") {
        outcome = budgetReason ? "budget-exhausted" : "cancelled";
      } else if (event.type === "turn-error") {
        failureReason = event.message;
      }
    };

    const durationTimer = budget?.maxDurationMs
      ? setTimeout(() => exhaustBudget(`runtime budget of ${budget.maxDurationMs}ms exceeded`), budget.maxDurationMs)
      : undefined;
    try {
      await runTurn({
        provider: options.provider,
        model: options.model,
        messages,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        toolRegistry,
        workspaceRoot,
        signal: controller.signal,
        onEvent,
        requestApproval: options.requestApproval ?? (async () => false),
        autoApprove: options.variant?.autoApprove ?? options.autoApprove,
        injectionMode: options.variant?.injectionMode,
        contextLimit: options.variant?.contextLimit,
        maxRounds: options.variant?.maxRounds,
        toolTimeoutMs: options.variant?.toolTimeoutMs,
        verify: options.variant?.verify,
        now: () => startedAtDate,
      });
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
    }

    if (budgetReason) outcome = "budget-exhausted";
    const trace = traceCollector.snapshot();
    if (budgetReason) trace.terminalState = "budget-exhausted";

    return {
      workspaceRoot,
      trace,
      observation: {
        caseId: testCase.id,
        runId: `${testCase.id}-${repetition}-${randomUUID()}`,
        provider: options.provider.kind,
        model: options.model,
        outcome,
        ...(failureReason || budgetReason ? { failureReason: failureReason ?? budgetReason } : {}),
        startedAt,
        completedAt: now().toISOString(),
        usage,
        estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
        admissions,
      },
    };
  };
}