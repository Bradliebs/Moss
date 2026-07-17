import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalCase, EvalModelTarget, HarnessVariant } from "../../../../common/evals";
import type { EvalExecutor } from "./eval-runner";
import { HarnessMatrixRunner } from "./matrix-runner";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TEST_CASE: EvalCase = {
  schemaVersion: 1,
  id: "isolated-artifact",
  profile: "coding",
  difficulty: "smoke",
  task: {
    objective: "Update the artifact",
    acceptanceCriteria: [{ id: "artifact", description: "Artifact exists", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  fixture: {},
  allowedCapabilities: ["write_file"],
  checks: [{ id: "artifact-check", criterionId: "artifact", kind: "file-exists", path: "artifact.txt" }],
  benchmark: { security: { protectedPaths: ["protected.txt"] } },
};

const TARGET: EvalModelTarget = {
  schemaVersion: 1,
  id: "deterministic-model",
  providerId: "fixture-provider",
  providerKind: "deterministic",
  model: "fixture-model",
};

const VARIANTS: HarnessVariant[] = [
  { schemaVersion: 1, id: "baseline", description: "Baseline controls" },
  { schemaVersion: 1, id: "guarded", description: "Guarded controls", autoApprove: false },
];

describe("HarnessMatrixRunner", () => {
  it("expands every matrix cell into an isolated fixture workspace", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "moss-matrix-fixture-"));
    temporaryDirectories.push(fixtureRoot);
    writeFileSync(join(fixtureRoot, "protected.txt"), "original", "utf8");
    const workspaceRoots: string[] = [];
    const createExecutor = (_target: EvalModelTarget, variant: HarnessVariant, workspaceRoot: string): EvalExecutor => {
      workspaceRoots.push(workspaceRoot);
      return async (testCase) => {
        writeFileSync(join(workspaceRoot, "artifact.txt"), variant.id, "utf8");
        writeFileSync(join(workspaceRoot, "protected.txt"), variant.id, "utf8");
        return {
          workspaceRoot,
          trace: {
            toolCalls: [{
              callId: `${variant.id}-write`,
              name: "write_file",
              approvalRequested: false,
              autoApproved: true,
              ok: true,
            }],
            usage: {},
            terminalState: "completed",
          },
          observation: {
            caseId: testCase.id,
            runId: `${testCase.id}-${variant.id}`,
            provider: "deterministic",
            model: "fixture-model",
            outcome: "completed",
            startedAt: "2026-07-17T08:00:00.000Z",
            completedAt: "2026-07-17T08:00:01.000Z",
            usage: {},
            estimatedCostUsd: 0,
            admissions: ["attempted"],
          },
        };
      };
    };
    const runner = new HarnessMatrixRunner(createExecutor, {
      temporaryRoot: tmpdir(),
      now: () => new Date("2026-07-17T08:01:00.000Z"),
    });

    const report = await runner.run(
      [{ ...TEST_CASE, fixture: { workspaceTemplate: fixtureRoot } }],
      [TARGET],
      VARIANTS,
    );

    expect(report.cells).toHaveLength(2);
    expect(report.cells.map((cell) => cell.variantId)).toEqual(["baseline", "guarded"]);
    expect(new Set(workspaceRoots).size).toBe(2);
    expect(workspaceRoots.every((workspaceRoot) => !existsSync(workspaceRoot))).toBe(true);
    expect(readFileSync(join(fixtureRoot, "protected.txt"), "utf8")).toBe("original");
    expect(report.cells.every((cell) => !cell.protectedInputsIntact)).toBe(true);
    expect(report.cells.every((cell) => cell.protectedInputHashesBefore["protected.txt"]
      !== cell.protectedInputHashesAfter["protected.txt"])).toBe(true);
    expect(report.cells.every((cell) => cell.harnessScore?.securityPassed === false)).toBe(true);
    expect(report.cells.every((cell) => cell.harnessScore?.securityViolations.includes("protected-input-modified"))).toBe(true);
  });

  it("rejects comparisons that vary the execution budget", async () => {
    const runner = new HarnessMatrixRunner(() => async () => {
      throw new Error("should not execute");
    });

    await expect(runner.run([TEST_CASE], [TARGET], [
      { ...VARIANTS[0], budget: { maxActions: 2 } },
      { ...VARIANTS[1], budget: { maxActions: 3 } },
    ])).rejects.toThrow("same execution budget");
  });
});