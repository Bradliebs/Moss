import { randomUUID } from "node:crypto";

import type { EvalCase } from "../../../../common/evals";
import type { EvalExecutor } from "./eval-runner";
import type { EvalSandboxBackend } from "./sandbox-backend";

export interface SandboxEvalExecutorOptions {
  backend: EvalSandboxBackend;
  workspaceRoot: string;
  command: (testCase: EvalCase) => string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export function createSandboxEvalExecutor(options: SandboxEvalExecutorOptions): EvalExecutor {
  const now = options.now ?? (() => new Date());
  return async (testCase) => {
    const startedAt = now().toISOString();
    const controller = new AbortController();
    const result = await options.backend.run({
      workspaceRoot: options.workspaceRoot,
      command: options.command(testCase),
      signal: controller.signal,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const completed = result.exitCode === 0 && !result.timedOut;
    return {
      workspaceRoot: options.workspaceRoot,
      observation: {
        caseId: testCase.id,
        runId: `${testCase.id}-${randomUUID()}`,
        provider: options.provider ?? options.backend.kind,
        model: options.model ?? "external-terminal",
        outcome: completed ? "completed" : "failed",
        ...(!completed ? {
          failureReason: result.timedOut
            ? "Sandbox command exceeded its time budget"
            : `Sandbox command exited with code ${result.exitCode}`,
        } : {}),
        startedAt,
        completedAt: now().toISOString(),
        usage: {},
        estimatedCostUsd: 0,
        admissions: [],
      },
    };
  };
}
