import { createHash, randomUUID } from "node:crypto";

import type { EvalAdmission, EvalCase, EvalExecutionObservation, HarnessDiagnosticReview, HarnessVariant } from "../../../../common/evals";
import type { AgentMessage, MossEvent, TokenUsage, ToolApprovalResponse } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { ChatProvider } from "../providers/types";
import { buildSystemMessage } from "../system-prompt";
import type { Tool } from "../tools";
import type { EvalExecutionResult, EvalExecutor } from "./eval-runner";
import { HarnessTraceCollector } from "./trace-collector";

export interface TurnEvalExecutorOptions {
  provider: ChatProvider;
  model: string;
  toolRegistry: Map<string, Tool>;
  workspaceRoot: (testCase: EvalCase, repetition: number) => Promise<string> | string;
  messages?: (testCase: EvalCase, repetition: number) => Promise<AgentMessage[]> | AgentMessage[];
  requestApproval?: (callId: string) => Promise<ToolApprovalResponse>;
  autoApprove?: boolean;
  estimateCostUsd?: (usage: TokenUsage) => number;
  now?: () => Date;
  promptNow?: () => Date;
  variant?: HarnessVariant;
  signal?: AbortSignal;
}

const DEFAULT_PROMPT_PROFILE = "deterministic-production-v1";

/** Adapt the production agent loop to the provider-neutral evaluation runner. */
export function createTurnEvalExecutor(options: TurnEvalExecutorOptions): EvalExecutor {
  const now = options.now ?? (() => new Date());
  return async (testCase, repetition): Promise<EvalExecutionResult> => {
    const workspaceRoot = await options.workspaceRoot(testCase, repetition);
    const startedAtDate = now();
    const promptDate = options.promptNow?.() ?? startedAtDate;
    const messages: AgentMessage[] = options.messages
      ? await options.messages(testCase, repetition)
      : [
        buildSystemMessage({
          includeSkills: false,
          includeMemory: false,
          query: testCase.task.objective,
          now: () => promptDate,
        }),
        { role: "user", content: testCase.task.objective },
      ];
    const promptProvenance = {
      profile: options.variant?.promptProfile ?? (options.messages ? "custom" : DEFAULT_PROMPT_PROFILE),
      seededMessagesHash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    };
    const allowed = new Set(testCase.allowedCapabilities);
    const tools = [...options.toolRegistry.values()].filter((tool) => allowed.has(tool.name));
    const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));
    const admissions: EvalAdmission[] = [];
    const usage: TokenUsage = {};
    const approvalRequests = new Set<string>();
    const failedTools = new Set<string>();
    const traceCollector = new HarnessTraceCollector();
    const controller = new AbortController();
    const cancelFromParent = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", cancelFromParent, { once: true });
    const budget = options.variant?.budget ?? testCase.benchmark?.budget ?? testCase.task.budget;
    let budgetReason: string | undefined;
    let failureReason: string | undefined;
    let failureSource: EvalExecutionResult["failureSource"];
    let actionCount = 0;
    let responseText = "";
    let outcome: EvalExecutionObservation["outcome"] = "failed";
    const startedAt = startedAtDate.toISOString();

    const exhaustBudget = (reason: string): void => {
      if (budgetReason) return;
      budgetReason = reason;
      admissions.push("budget-exhausted");
      controller.abort();
    };

    const onEvent = (event: MossEvent): void => {
      traceCollector.onEvent(event);
      if (event.type === "text-delta") {
        responseText += event.text;
      } else if (event.type === "token-usage") {
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
        failureSource = event.source;
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
        requestApproval: options.requestApproval ?? (async () => ({ approved: false })),
        autoApprove: options.variant?.autoApprove ?? options.autoApprove,
        injectionMode: options.variant?.injectionMode,
        contextLimit: options.variant?.runtime?.contextStrategy === "full" ? 0 : options.variant?.contextLimit,
        maxRounds: options.variant?.maxRounds,
        toolTimeoutMs: options.variant?.toolTimeoutMs,
        verify: options.variant?.runtime?.verificationCadence === "terminal"
          ? { enabled: false, commands: [] }
          : options.variant?.verify,
        planningPolicy: options.variant?.runtime?.planningPolicy,
        recoveryMode: options.variant?.runtime?.recoveryPolicy,
        now: () => promptDate,
      });
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
      options.signal?.removeEventListener("abort", cancelFromParent);
    }

    if (budgetReason) outcome = "budget-exhausted";
    if (budgetReason) traceCollector.markBudgetExhausted();
    const trace = traceCollector.snapshot();
    const diagnosticReview = options.variant?.runtime?.reviewerPass === "diagnostic"
      ? await runDiagnosticReview(options, testCase, responseText, controller.signal)
      : undefined;

    return {
      workspaceRoot,
      trace,
      ...(diagnosticReview ? { diagnosticReview } : {}),
      promptProvenance,
      rubricInput: { responseText },
      ...(failureSource ? { failureSource } : {}),
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

async function runDiagnosticReview(
  options: TurnEvalExecutorOptions,
  testCase: EvalCase,
  responseText: string,
  signal: AbortSignal,
): Promise<HarnessDiagnosticReview> {
  const startedAt = Date.now();
  const usage: TokenUsage = {};
  let text = "";
  try {
    const stream = options.provider.streamChat({
      model: options.model,
      messages: [
        {
          role: "system",
          content: "You are a diagnostic reviewer. Do not propose actions. Return only JSON: {\"label\":\"pass|fail|unknown\",\"reasonCode\":\"kebab-case\"}.",
        },
        {
          role: "user",
          content: JSON.stringify({
            objective: testCase.task.objective,
            acceptanceCriteria: testCase.task.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
            assistantResponse: responseText,
          }),
        },
      ],
      tools: [],
    }, signal);
    for await (const event of stream) {
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "usage") Object.assign(usage, event.usage);
    }
    const parsed = JSON.parse(text) as { label?: unknown; reasonCode?: unknown };
    const label = parsed.label === "pass" || parsed.label === "fail" || parsed.label === "unknown"
      ? parsed.label
      : "unknown";
    const reasonCode = typeof parsed.reasonCode === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.reasonCode)
      ? parsed.reasonCode.slice(0, 80)
      : "invalid-review-output";
    return {
      diagnostic: true,
      label,
      reasonCode,
      usage,
      estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      diagnostic: true,
      label: "unknown",
      reasonCode: "reviewer-error",
      usage,
      estimatedCostUsd: options.estimateCostUsd?.(usage) ?? 0,
      durationMs: Date.now() - startedAt,
    };
  }
}