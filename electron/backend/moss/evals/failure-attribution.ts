import type {
  EvalExecutionFailureSource,
  EvalFailureAttribution,
  EvalFailureCategory,
  EvalRunResult,
  HarnessExecutionTrace,
} from "../../../../common/evals";

const FAILURE_CATEGORIES: EvalFailureCategory[] = [
  "agent-behavior",
  "provider-model",
  "tool",
  "harness-orchestration",
  "grader",
  "environment",
  "unknown",
];

export interface FailureAttributionInput {
  result: EvalRunResult;
  trace?: HarnessExecutionTrace;
  executionFailureSource?: EvalExecutionFailureSource;
}

/** Diagnostic ownership only. Release success remains determined by outcome and independent checks. */
export function attributeEvalFailure(input: FailureAttributionInput): EvalFailureAttribution | undefined {
  const { result, trace, executionFailureSource } = input;
  if (result.success) return undefined;

  const failedChecks = result.criteria.flatMap((criterion) => criterion.checks).filter((check) => !check.passed);
  if (failedChecks.some((check) => check.failureKind === "grader")) {
    return attribution("grader", "grader-check-error");
  }
  if (failedChecks.some((check) => check.failureKind === "environment")) {
    return attribution("environment", "verification-environment-error");
  }
  if (failedChecks.some((check) => check.failureKind === "orchestration")) {
    return attribution("harness-orchestration", "verification-aborted");
  }
  if (executionFailureSource) {
    return attribution(executionFailureSource, `executor-${executionFailureSource}`);
  }
  if (result.observation.outcome === "budget-exhausted") {
    return attribution("harness-orchestration", "budget-exhausted");
  }
  if (result.observation.outcome === "cancelled") {
    return attribution("harness-orchestration", "execution-cancelled");
  }
  if (hasUnrecoveredToolFailure(trace)) {
    return attribution("tool", "unrecovered-tool-failure");
  }
  if (result.observation.outcome === "completed") {
    return attribution("agent-behavior", "mandatory-criterion-failed");
  }
  if (result.observation.outcome === "blocked") {
    return attribution("agent-behavior", "required-action-blocked");
  }
  return attribution("unknown", "insufficient-failure-provenance");
}

function hasUnrecoveredToolFailure(trace?: HarnessExecutionTrace): boolean {
  if (!trace) return false;
  const recoveredCallIds = new Set(
    trace.toolCalls.flatMap((call) => call.recoveredFromCallId ? [call.recoveredFromCallId] : []),
  );
  return trace.toolCalls.some((call) => call.ok === false && !recoveredCallIds.has(call.callId));
}

function attribution(
  category: EvalFailureAttribution["category"],
  reasonCode: string,
): EvalFailureAttribution {
  return { category, reasonCode, diagnostic: true };
}

export function countFailureAttributions(
  results: readonly Pick<EvalRunResult, "failureAttribution">[],
): Record<EvalFailureCategory, number> {
  const counts = Object.fromEntries(FAILURE_CATEGORIES.map((category) => [category, 0])) as Record<
    EvalFailureCategory,
    number
  >;
  for (const result of results) {
    if (result.failureAttribution) counts[result.failureAttribution.category]++;
  }
  return counts;
}