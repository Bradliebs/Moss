import { createHash, randomUUID } from "node:crypto";

import type { EvalAdmission, EvalCase, EvalExecutionObservation, EvalScenarioDisturbance, HarnessDiagnosticReview, HarnessVariant } from "../../../../common/evals";
import type { AgentMessage, MossEvent, TokenUsage, ToolApprovalResponse } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import { ProviderError, type ChatProvider, type ProviderStreamEvent } from "../providers/types";
import { buildSystemMessage } from "../system-prompt";
import type { Tool } from "../tools";
import type { EvalExecutionResult, EvalExecutor } from "./eval-runner";
import { HarnessTraceCollector } from "./trace-collector";
import type { HarnessDiagnosticCapture } from "./diagnostic-artifact-store";
import { DockerEvalSandboxBackend, type EvalSandboxBackend } from "./sandbox-backend";
import { createSandboxTools, validateTurnEvalCapabilities } from "./sandbox-tools";
import { requiresEvalSandbox } from "./execution-selection";

export interface TurnEvalExecutorOptions {
  provider: ChatProvider;
  model: string;
  maxOutputTokens?: number;
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
  diagnostics?: HarnessDiagnosticCapture;
  sandboxBackend?: EvalSandboxBackend;
}

const DEFAULT_PROMPT_PROFILE = "deterministic-production-v1";

/** Adapt the production agent loop to the provider-neutral evaluation runner. */
export function createTurnEvalExecutor(options: TurnEvalExecutorOptions): EvalExecutor {
  if (options.variant?.runtime?.contextStrategy === "compact"
    && (!Number.isInteger(options.variant.contextLimit) || options.variant.contextLimit! < 1)) {
    throw new Error(`Harness variant '${options.variant.id}' requires a positive context limit for compact context`);
  }
  const now = options.now ?? (() => new Date());
  return async (testCase, repetition): Promise<EvalExecutionResult> => {
    validateTurnEvalCapabilities(testCase.allowedCapabilities);
    const workspaceRoot = await options.workspaceRoot(testCase, repetition);
    const startedAtDate = now();
    const promptDate = options.promptNow?.() ?? startedAtDate;
    const traceCollector = new HarnessTraceCollector();
    const deliveredDisturbances = new Set<string>();
    const deliverDisturbance = (disturbance: EvalScenarioDisturbance): void => {
      if (deliveredDisturbances.has(disturbance.id)) return;
      deliveredDisturbances.add(disturbance.id);
      traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "delivered");
    };
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "planned");
    }
    let messages: AgentMessage[] = options.messages
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
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      if (disturbance.type !== "context-pressure") continue;
      const pressureMessages: AgentMessage[] = Array.from({ length: disturbance.messageCount }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `scenario-context-${disturbance.id}-${index}:${"x".repeat(disturbance.charactersPerMessage)}`,
      }));
      messages = [messages[0], ...pressureMessages, ...messages.slice(1)];
      deliverDisturbance(disturbance);
    }
    const promptProvenance = {
      profile: options.variant?.promptProfile ?? (options.messages ? "custom" : DEFAULT_PROMPT_PROFILE),
      seededMessagesHash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    };
    const allowed = new Set(testCase.allowedCapabilities);
    const requiresSandbox = requiresEvalSandbox(testCase, options.variant);
    const backend = options.sandboxBackend ?? (requiresSandbox
      ? new DockerEvalSandboxBackend({ image: options.variant?.sandbox?.image ?? "" }) : undefined);
    const selectedTools = [...options.toolRegistry.values()].filter((tool) => allowed.has(tool.name));
    const sandbox = backend ? createSandboxTools(selectedTools, backend, workspaceRoot, options.variant?.sandbox?.allowNetwork) : undefined;
    const tools = sandbox?.tools ?? selectedTools;
    const toolInvocations = new Map<string, number>();
    const toolRegistry = new Map(tools.map((tool) => [tool.name, {
      ...tool,
      execute: async (...args: Parameters<Tool["execute"]>) => {
        const invocation = (toolInvocations.get(tool.name) ?? 0) + 1;
        toolInvocations.set(tool.name, invocation);
        const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
          EvalScenarioDisturbance,
          { type: "tool-failure" }
        > =>
          candidate.type === "tool-failure"
          && candidate.capability === tool.name
          && candidate.invocation === invocation);
        if (!disturbance) return tool.execute(...args);
        deliverDisturbance(disturbance);
        return {
          ok: false,
          content: disturbance.failure === "transient"
            ? `Tool temporarily unavailable (scenario ${disturbance.id})`
            : `Tool failed permanently (scenario ${disturbance.id})`,
        };
      },
    }]));
    const admissions: EvalAdmission[] = [];
    const usage: TokenUsage = {};
    const approvalRequests = new Set<string>();
    const failedTools = new Set<string>();
    const approvalCalls = new Map<string, { capability: string; invocation: number }>();
    const approvalInvocations = new Map<string, number>();
    const hasApprovalScenario = testCase.scenario?.disturbances.some((disturbance) =>
      disturbance.type === "approval-response") ?? false;
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

    const exhaustBudget = (
      reason: string,
      boundary: "actions" | "tokens" | "cost" | "duration",
      limit: number,
      observed: number,
    ): void => {
      if (budgetReason) return;
      budgetReason = reason;
      admissions.push("budget-exhausted");
      traceCollector.recordBudgetBoundary(boundary, limit, observed);
      controller.abort();
    };

    const onEvent = (event: MossEvent): void => {
      if (event.type !== "text-delta") options.diagnostics?.append(event.type, event);
      traceCollector.onEvent(event);
      if (event.type === "text-delta") {
        responseText += event.text;
      } else if (event.type === "token-usage") {
        usage.inputTokens = (usage.inputTokens ?? 0) + (event.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (budget?.maxTokens && tokens > budget.maxTokens) {
          exhaustBudget(`token budget of ${budget.maxTokens} exceeded`, "tokens", budget.maxTokens, tokens);
        }
        const cost = options.estimateCostUsd?.(usage) ?? 0;
        if (budget?.maxCostUsd && cost > budget.maxCostUsd) {
          exhaustBudget(`cost budget of $${budget.maxCostUsd} exceeded`, "cost", budget.maxCostUsd, cost);
        }
      } else if (event.type === "tool-call") {
        admissions.push("attempted");
        actionCount++;
        if (budget?.maxActions && actionCount > budget.maxActions) {
          exhaustBudget(`action budget of ${budget.maxActions} exceeded`, "actions", budget.maxActions, actionCount);
        }
      } else if (event.type === "tool-approval-request") {
        admissions.push("blocked");
        approvalRequests.add(event.callId);
        const invocation = (approvalInvocations.get(event.name) ?? 0) + 1;
        approvalInvocations.set(event.name, invocation);
        approvalCalls.set(event.callId, { capability: event.name, invocation });
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

    const durationLimit = budget?.maxDurationMs;
    const durationTimer = durationLimit
      ? setTimeout(() => exhaustBudget(
        `runtime budget of ${durationLimit}ms exceeded`,
        "duration",
        durationLimit,
        durationLimit,
      ), durationLimit)
      : undefined;
    const requestApproval = async (callId: string): Promise<ToolApprovalResponse> => {
      const approvalCall = approvalCalls.get(callId);
      const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
        EvalScenarioDisturbance,
        { type: "approval-response" }
      > =>
        candidate.type === "approval-response"
        && candidate.capability === approvalCall?.capability
        && candidate.invocation === approvalCall.invocation);
      const response = disturbance
        ? { approved: disturbance.approved, ...(disturbance.comment ? { comment: disturbance.comment } : {}) }
        : testCase.scenario?.approvalFallback === "deny" && testCase.scenario.disturbances.some((candidate) =>
          candidate.type === "approval-response" && candidate.capability === approvalCall?.capability)
          ? { approved: false }
          : await (options.requestApproval ?? (async () => ({ approved: false })))(callId);
      if (disturbance) {
        deliverDisturbance(disturbance);
      }
      if (!response || typeof response.approved !== "boolean") {
        throw new Error("Evaluation approval callback must return { approved: boolean }");
      }
      traceCollector.recordApprovalDecision(callId, response.approved, Boolean(response.comment?.trim()));
      options.diagnostics?.append("approval-response", { callId, ...response });
      return response;
    };
    let providerInvocation = 0;
    const provider: ChatProvider = {
      kind: options.provider.kind,
      listModels: () => options.provider.listModels(),
      streamChat: async function* (request, signal): AsyncIterable<ProviderStreamEvent> {
        options.diagnostics?.append("provider-request", request);
        providerInvocation++;
        const disturbance = testCase.scenario?.disturbances.find((candidate): candidate is Extract<
          EvalScenarioDisturbance,
          { type: "provider-interruption" }
        > =>
          candidate.type === "provider-interruption" && candidate.invocation === providerInvocation);
        if (disturbance?.phase === "before-output") {
          deliverDisturbance(disturbance);
          throw new ProviderError(`Provider interrupted before output (scenario ${disturbance.id})`, 503);
        }
        let emitted = false;
        try {
          for await (const event of options.provider.streamChat(request, signal)) {
            yield event;
            if (!emitted && disturbance?.phase === "after-output") {
              emitted = true;
              deliverDisturbance(disturbance);
              throw new ProviderError(`Provider interrupted after output (scenario ${disturbance.id})`, 503);
            }
          }
        } catch (error) {
          options.diagnostics?.append("provider-error", error);
          throw error;
        }
      },
    };
    try {
      await runTurn({
        provider,
        model: options.model,
        messages,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        toolRegistry,
        workspaceRoot,
        signal: controller.signal,
        onEvent,
        requestApproval,
        autoApprove: hasApprovalScenario ? false : options.variant?.autoApprove ?? options.autoApprove,
        injectionMode: options.variant?.injectionMode,
        contextLimit: options.variant?.runtime?.contextStrategy === "full" ? 0 : options.variant?.contextLimit,
        maxRounds: options.variant?.maxRounds,
        maxOutputTokens: options.maxOutputTokens,
        toolTimeoutMs: options.variant?.toolTimeoutMs,
        verify: options.variant?.runtime?.verificationCadence === "terminal"
          ? { enabled: false, commands: [] }
          : options.variant?.verify,
        ...(options.diagnostics ? { onVerification: (result) => options.diagnostics!.append("verification-details", result) } : {}),
        ...(sandbox ? { verificationRunner: sandbox.verify } : {}),
        planningPolicy: options.variant?.runtime?.planningPolicy,
        recoveryMode: options.variant?.runtime?.recoveryPolicy,
        now: () => promptDate,
      });
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
      options.signal?.removeEventListener("abort", cancelFromParent);
      sandbox?.assertHealthy();
    }

    if (budgetReason) outcome = "budget-exhausted";
    if (budgetReason) traceCollector.markBudgetExhausted();
    for (const disturbance of testCase.scenario?.disturbances ?? []) {
      if (!deliveredDisturbances.has(disturbance.id)) {
        traceCollector.recordScenarioDisturbance(disturbance.id, disturbance.type, "undelivered");
        outcome = "failed";
        failureReason ??= `Planned scenario disturbance '${disturbance.id}' was not delivered`;
        failureSource = "harness-orchestration";
        traceCollector.markHarnessError();
      }
    }
    const trace = traceCollector.snapshot();
    options.diagnostics?.append("assistant-response", responseText);
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