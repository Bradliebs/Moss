import { describe, expect, it, vi } from "vitest";

import type { EvalCase } from "../../../../common/evals";
import type { EvalSandboxBackend } from "./sandbox-backend";
import { createSandboxEvalExecutor } from "./sandbox-eval-executor";

const testCase: EvalCase = {
  schemaVersion: 1,
  id: "sandbox-case",
  profile: "coding",
  difficulty: "smoke",
  task: {
    objective: "Run the external benchmark",
    acceptanceCriteria: [{ id: "receipt", description: "Command completed", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  allowedCapabilities: [],
  checks: [{ id: "receipt-check", criterionId: "receipt", kind: "receipt", asserted: true }],
};

function backend(exitCode: number | null, timedOut = false): EvalSandboxBackend {
  return {
    kind: "docker",
    run: vi.fn(async () => ({ exitCode, timedOut, stdout: "sensitive output", stderr: "sensitive error" })),
  };
}

describe("createSandboxEvalExecutor", () => {
  it("maps a successful container command to completed without retaining output", async () => {
    const execute = createSandboxEvalExecutor({
      backend: backend(0),
      workspaceRoot: "C:\\fixture",
      command: () => "npm test",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });

    const result = await execute(testCase, 0);

    expect(result.observation.outcome).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("reports command failure separately from sandbox startup exceptions", async () => {
    const execute = createSandboxEvalExecutor({
      backend: backend(2),
      workspaceRoot: "C:\\fixture",
      command: () => "npm test",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });

    const result = await execute(testCase, 0);

    expect(result.observation).toMatchObject({
      outcome: "failed",
      failureReason: "Sandbox command exited with code 2",
    });
  });
});
